import { memo, useContext, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type ClipboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { ArrowUp, Bot, Copy, Diamond, GripHorizontal, Grid3X3, History, Maximize2, Minus, PanelRight, Plus, RotateCcw, SlidersHorizontal, X } from 'lucide-react';
import type { ChatSkillBridgeResult, CodexCliProfile, CodexReasoningEffort, ProviderBridgeProfile } from '@agent-canvas/desktop-core';
import type { KnowledgeBaseStateSummary } from '@agent-canvas/skill-store';
import type { ImageMentionValue, MentionableImageReference } from './ImageMentionComposer';
import { reduceTransientPopover } from '../app/transient-popover';
import { imageModelFamilyDisplayName, imageResolutionFamilyKey, listImageResolutionTiers, resolveImageResolutionRoute, type ImageResolutionTier } from '../app/image-resolution-routing';
import { listAgentChatProfiles } from '../app/provider-profiles';
import { ProviderOperationTimeoutError, withProviderOperationTimeout } from '../settings/provider-operation-timeout';
import { resolveReverseAnalysisOperationTimeoutMs } from '../app/reverse-analysis-operation-budget';
import { supportsAgentMediaReferences } from './agent-media-capability';
import { readAgentChatClipboard } from './agent-chat-clipboard';
import {
  attachPastedReference,
  createPasteImportState,
  finishPasteImport,
  hasSendablePasteText,
  invalidatePasteImportState,
  isPasteGenerationCurrent as isPasteImportGenerationCurrent,
  isPasteImportBusy,
  pasteMentionToken,
  reducePasteComposer,
  resolveSelectedPasteReferences,
  startPasteImport,
  stripPendingPasteMarkers,
  upsertPasteReferenceByAssetId,
} from './agent-chat-paste-state';
import { MediaMentionTextarea, type MediaMentionSelection } from '../mentions/MediaMentionTextarea';
import {
  addAgentConversation,
  createAgentConversation,
  deriveAgentConversationTitle,
  readAgentConversationCollection,
  writeAgentConversationCollection,
  type ReverseAnalysisDepth,
  type StoredAgentConversation,
} from './skill-chat-session-store';
import { parseReverseAnalysisResponse, type ReverseAnalysisResult } from './reverse-workflow-contract';
import { formatReverseTimelineContext, selectReverseTimelineContext } from './reverse-timeline-context';
import { GenerationPreferencesSheet } from './GenerationPreferencesSheet';
import { CodexReasoningPopover } from './CodexReasoningPopover';
import { generationProfiles, readGenerationPreferences, writeGenerationPreferences, resolveGenerationPreference, type GenerationKind, type GenerationParameters, type GenerationPreferences } from './generation-preferences';
import { assessCreativeGenerationPrompt, constrainCreativePlanKind, creativePlanningInstructions, creativeWorkflowSteps, parseCreativePlan, recoverEmptyCreativePlan, type CreativePlanOption } from './creative-plan';
import { consumeQueuedGeneratedImageForAgent, listQueuedGeneratedImagesForAgent } from './generated-image-agent-transfer';
import { AgentWindowControlsContext } from './FloatingAgentWindow';

type SkillMessage = {
  readonly id: string;
  readonly role: 'user' | 'assistant';
  readonly content: string;
  readonly mode?: 'chat' | 'original' | 'codex';
  readonly canvasNodeLabel?: string;
  readonly sources?: Readonly<ChatSkillBridgeResult['sources']>;
  readonly request?: SkillRequestSummary;
};

type AgentChatProfile = ProviderBridgeProfile | CodexCliProfile;

type SkillRequestStatus = 'sending' | 'completed' | 'error';

type SkillChatMentionReference = MentionableImageReference & {
  readonly kind: 'image' | 'video';
  readonly mentionPosition: number;
};

type ConversationReferenceCatalogEntry = {
  readonly assetId: string;
  readonly mentionPosition: number;
};

export interface SkillChatRequest {
  readonly provider: ProviderBridgeProfile['provider'] | 'codex';
  readonly modelRoute: string;
  readonly requestId?: string;
  readonly messages: readonly { readonly role: 'user' | 'assistant'; readonly content: string }[];
  readonly context: { readonly knowledgeBaseIds: readonly string[]; readonly projectMemoryIds: readonly string[] };
  readonly referenceAssetIds?: readonly string[];
  readonly referenceMentions?: readonly { readonly assetId: string; readonly label: string; readonly mention: string }[];
  readonly agentMode?: 'chat' | 'original' | 'codex';
  readonly reasoningEffort?: CodexReasoningEffort;
  readonly reverseAnalysisDepth?: ReverseAnalysisDepth;
  readonly visualAnalysis?: boolean;
}

type SkillRequestSummary = {
  readonly modelDisplayName: string;
  readonly modelRoute: string;
  readonly knowledgeBaseCount: number;
  readonly knowledgeBaseIds?: readonly string[];
  readonly projectMemoryCount: number;
  readonly references: readonly { readonly assetId: string; readonly label: string }[];
  readonly status: SkillRequestStatus;
  readonly visualAnalysis?: boolean;
  readonly reverseAnalysisDepth?: ReverseAnalysisDepth;
  readonly generationKind?: GenerationKind;
};

export interface SkillWorkflowDraftRequest {
  readonly analysis: string;
  readonly reverseAnalysis?: ReverseAnalysisResult;
  readonly references: readonly { readonly assetId: string; readonly label: string; readonly mention: string }[];
  readonly modelRoute?: string;
  readonly modelRouteDisplayName?: string;
  readonly knowledgeBaseIds?: readonly string[];
  readonly generation?: { kind: 'image' | 'video'; prompt?: string; modelRoute?: string; modelRouteDisplayName?: string; parameters?: GenerationParameters };
}

const IMAGE_MENTION_CAPABILITY_ERROR = '当前模型不支持图片引用，请切换具备视觉能力的聊天模型。';
const MEDIA_CAPABILITY_ERROR = '当前模型不支持图片或视频，请切换视觉模型后再引用';
const VIDEO_MENTION_CAPABILITY_ERROR = '当前对话暂不支持视频引用，请先使用图片，或在画布的 Agent 反推节点中分析视频。';
const CODEX_IMAGE_MENTION_CAPABILITY_ERROR = '当前 Codex 模型暂时无法读取图片引用，请检查 Codex 登录或 API Key 后重试。';
const CODEX_MEDIA_CAPABILITY_ERROR = '当前 Codex 支持图片引用，视频素材请切换到具备视频能力的视觉模型。';
const MEDIA_CAPABILITY_ERRORS = new Set([
  IMAGE_MENTION_CAPABILITY_ERROR,
  MEDIA_CAPABILITY_ERROR,
  VIDEO_MENTION_CAPABILITY_ERROR,
  CODEX_IMAGE_MENTION_CAPABILITY_ERROR,
  CODEX_MEDIA_CAPABILITY_ERROR,
]);
const AGENT_REQUEST_TIMEOUT_MS = 195_000;
const MAX_PROVIDER_SKILL_CHAT_MESSAGES = 48;
const MAX_PROVIDER_SKILL_CHAT_MESSAGE_LENGTH = 8_000;
const MAX_CODEX_SKILL_CHAT_MESSAGE_LENGTH = 16_000;
const CODEX_REQUEST_TIMEOUTS_MS: Readonly<Record<CodexReasoningEffort, number>> = {
  low: 90_000,
  medium: 150_000,
  high: 240_000,
  xhigh: 360_000,
  max: 480_000,
  ultra: 600_000,
};
const REASONING_EFFORT_LABELS: Readonly<Record<CodexReasoningEffort, string>> = {
  low: '轻度', medium: '中', high: '高', xhigh: '极高', max: 'Max', ultra: 'Ultra',
};
const REQUIRED_AGENT_KNOWLEDGE_CHOICES = [
  { knowledgeBaseId: 'scene-skill', displayName: '场景 Skill', description: '产品场景、构图、材质与灯光规则' },
  { knowledgeBaseId: 'ecommerce-detail-knowledge', displayName: '电商详情页知识库', description: '详情页结构、卖点表达与视觉规范' },
] as const;

export function resolveAgentRequestTimeoutMs(
  provider: SkillChatRequest['provider'],
  reasoningEffort: CodexReasoningEffort,
  usesVisualAnalysis: boolean,
  reverseDepth?: ReverseAnalysisDepth,
): number {
  return provider === 'codex'
    ? CODEX_REQUEST_TIMEOUTS_MS[reasoningEffort]
    : usesVisualAnalysis ? resolveReverseAnalysisOperationTimeoutMs(reverseDepth) : AGENT_REQUEST_TIMEOUT_MS;
}

export function codexAnalysisDelayHint(effort: CodexReasoningEffort, elapsedSeconds: number): string | null {
  if ((effort !== 'max' && effort !== 'ultra') || elapsedSeconds < 60) return null;
  return `${REASONING_EFFORT_LABELS[effort]} 深度推理耗时较长；需要更快结果时可停止并切换到“高”或“中”。`;
}

function isSafeProviderSkillChatHistoryText(value: string, maxLength: number): boolean {
  return value.length <= maxLength
    && !/(?:authorization\s*:|\bbearer\s+[a-z0-9._~+/=\-]{8,}|\b(?:api[_ -]?key|token|secret|password)\s*[:=]\s*\S{4,}|\bsk-[a-z0-9_-]{8,}|\b(?:https?|file):\/\/|[A-Za-z]:\\|\\\\[^\\\s]+\\|(?:^|\s)\/(?:Users|home|var|etc|opt|tmp|private)\/)/iu.test(value);
}

function providerSkillChatMessages(
  messages: readonly SkillMessage[],
  planningInstructions: string,
  maxMessageLength = MAX_PROVIDER_SKILL_CHAT_MESSAGE_LENGTH,
): SkillChatRequest['messages'] {
  const latestIndex = messages.length - 1;
  return messages.flatMap(({ role, content }, index) => {
    const nextContent = index === latestIndex && planningInstructions.length > 0
      ? `${content}\n\n${planningInstructions}`
      : content;
    if (index !== latestIndex && !isSafeProviderSkillChatHistoryText(nextContent, maxMessageLength)) return [];
    return [{ role, content: nextContent }];
  }).slice(-MAX_PROVIDER_SKILL_CHAT_MESSAGES);
}

function canvasResultNodeIds(messages: readonly Pick<SkillMessage, 'id'>[]): string[] {
  const prefix = 'canvas-result:';
  return [...new Set(messages.flatMap((message) => {
    if (!message.id.startsWith(prefix)) return [];
    const nodeId = message.id.slice(prefix.length).trim();
    return nodeId.length > 0 ? [nodeId] : [];
  }))];
}

function canvasResultNodeLabels(messages: readonly Pick<SkillMessage, 'id' | 'canvasNodeLabel'>[]): Record<string, string> {
  const prefix = 'canvas-result:';
  return Object.fromEntries(messages.flatMap((message) => {
    if (!message.id.startsWith(prefix) || message.canvasNodeLabel === undefined) return [];
    const nodeId = message.id.slice(prefix.length).trim();
    return nodeId.length > 0 ? [[nodeId, message.canvasNodeLabel] as const] : [];
  }));
}

export interface ReverseTimelineEntry {
  readonly nodeId: string;
  readonly title: string;
  readonly positivePrompt: string;
  readonly completedAt?: string;
}

export interface SkillChatReferenceImage {
  readonly assetId: string;
  readonly label: string;
  readonly displayUrl: string;
}

export interface SkillChatReferenceVideo {
  readonly assetId: string;
  readonly label: string;
  readonly displayUrl: string;
}

export type SkillCanvasActionKind = 'image_generation' | 'video_generation' | 'reverse_agent';

export interface SkillCanvasActionTarget {
  readonly kind: SkillCanvasActionKind;
  readonly nodeId: string;
  readonly label: string;
  readonly selected: boolean;
}

export interface SkillCanvasActionRequest {
  readonly kind: SkillCanvasActionKind;
  readonly nodeId: string;
  readonly prompt: string;
  readonly modelRoute?: string;
  readonly createNode?: boolean;
  readonly createWorkflow?: boolean;
  readonly projectId?: string;
  readonly parameters?: GenerationParameters;
  readonly referenceAssetIds?: readonly string[];
}

export interface SkillCanvasActionResult {
  nodeId: string;
  status: string;
  assetIds: string[];
}

export interface SkillCanvasActionExecutionResult {
  readonly started: boolean;
  readonly generationNodeId: string;
  readonly workflowNodeIds: readonly string[];
}

export interface SkillChatWorkbenchProps {
  readonly projectId: string;
  readonly profiles: readonly ProviderBridgeProfile[];
  readonly codexProfiles?: readonly CodexCliProfile[];
  readonly knowledgeBases: readonly KnowledgeBaseStateSummary[];
  readonly projectMemoryIds: readonly string[];
  readonly reverseTimeline: readonly ReverseTimelineEntry[];
  readonly referenceImages?: readonly SkillChatReferenceImage[];
  readonly referenceVideos?: readonly SkillChatReferenceVideo[];
  readonly onImportReferenceImage?: (file?: File, options?: { readonly fromClipboard: true }) => Promise<SkillChatReferenceImage | null>;
  readonly onImportReferenceVideo?: (file?: File) => Promise<SkillChatReferenceVideo | null>;
  readonly canvasActionTargets?: readonly SkillCanvasActionTarget[];
  readonly canvasHasSelection?: boolean;
  readonly canvasActionResults?: readonly SkillCanvasActionResult[];
  readonly executeCanvasAction?: (request: SkillCanvasActionRequest) => Promise<boolean | SkillCanvasActionExecutionResult>;
  readonly draftWorkflowFromAnalysis?: (request: SkillWorkflowDraftRequest) => void;
  readonly onClose?: () => void;
  readonly chat: (request: SkillChatRequest) => Promise<ChatSkillBridgeResult>;
  readonly cancelChat?: (requestId: string) => Promise<boolean>;
}

const MAX_AGENT_PROJECT_MEMORY_IDS = 32;
const EMPTY_REFERENCE_IMAGES: readonly SkillChatReferenceImage[] = [];
const EMPTY_REFERENCE_VIDEOS: readonly SkillChatReferenceVideo[] = [];

function clampProjectMemoryIds(
  selectedIds: readonly string[],
  availableIds: readonly string[],
): string[] {
  const available = new Set(availableIds.slice(0, MAX_AGENT_PROJECT_MEMORY_IDS));
  return [...new Set(selectedIds)]
    .filter((id) => available.has(id))
    .slice(0, MAX_AGENT_PROJECT_MEMORY_IDS);
}

export const SkillChatWorkbench = memo(function SkillChatWorkbench({
  projectId,
  profiles,
  codexProfiles: localCodexProfiles = [],
  knowledgeBases,
  projectMemoryIds,
  reverseTimeline,
  referenceImages = EMPTY_REFERENCE_IMAGES,
  referenceVideos = EMPTY_REFERENCE_VIDEOS,
  onImportReferenceImage,
  canvasActionTargets = [],
  canvasHasSelection,
  canvasActionResults = [],
  executeCanvasAction,
  draftWorkflowFromAnalysis,
  onClose,
  chat,
  cancelChat,
}: SkillChatWorkbenchProps) {
  const agentWindowControls = useContext(AgentWindowControlsContext);
  const chatProfiles = useMemo(
    () => listAgentChatProfiles(profiles),
    [profiles],
  );
  const availableKnowledge = useMemo(
    () => knowledgeBases.filter((knowledgeBase) => knowledgeBase.status === 'active'),
    [knowledgeBases],
  );
  const availableProjectMemoryIds = useMemo(
    () => [...new Set(projectMemoryIds)].slice(0, MAX_AGENT_PROJECT_MEMORY_IDS),
    [projectMemoryIds],
  );
  const [initialCollection] = useState(() => readAgentConversationCollection(projectId));
  const initialConversation = initialCollection.conversations.find((conversation) => conversation.id === initialCollection.activeConversationId)
    ?? initialCollection.conversations[0]!;
  const [conversationCollection, setConversationCollection] = useState(initialCollection);
  const [activeConversationId, setActiveConversationId] = useState(initialConversation.id);
  const [modelRoute, setModelRoute] = useState<string | undefined>(() => initialConversation.modelRoute ?? chatProfiles.find((profile) => profile.modelRoute === 'chat-default')?.modelRoute ?? chatProfiles[0]?.modelRoute);
  const [selectedKnowledgeBaseIds, setSelectedKnowledgeBaseIds] = useState<string[]>(
    () => [...initialConversation.knowledgeBaseIds],
  );
  const [selectedProjectMemoryIds, setSelectedProjectMemoryIds] = useState<string[]>(() => initialConversation.projectMemoryIds.length > 0
    ? clampProjectMemoryIds(initialConversation.projectMemoryIds, availableProjectMemoryIds)
    : [...availableProjectMemoryIds]);
  const [messages, setMessages] = useState<SkillMessage[]>(() => [...initialConversation.messages]);
  const [showAllQuickTasks, setShowAllQuickTasks] = useState(false);
  const [composer, setComposer] = useState<ImageMentionValue>({ text: '', citations: [] });
  const composerSelectionRef = useRef<MediaMentionSelection | null>(null);
  const pendingComposerCaretRef = useRef<number | null>(null);
  const [importedReferenceImages, setImportedReferenceImages] = useState<SkillChatReferenceImage[]>([]);
  const [initialReferenceCatalog] = useState(
    () => createConversationReferenceCatalog(initialConversation.messages, referenceImages),
  );
  const referenceCatalog = useRef<ConversationReferenceCatalogEntry[]>(initialReferenceCatalog);
  const referenceFileInput = useRef<HTMLInputElement>(null);
  const [, setReferenceImportRevision] = useState(0);
  const draft = composer.text;
  const [contextExpanded, setContextExpanded] = useState(false);
  const [activePopover, dispatchPopover] = useReducer(reduceTransientPopover, null);
  const mentionOpen = activePopover === 'reference';
  const [browseProjectImages, setBrowseProjectImages] = useState(false);
  const [referenceQuery, setReferenceQuery] = useState('');
  const [modelQuery, setModelQuery] = useState('');
  const referenceMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (!mentionOpen) setBrowseProjectImages(false); }, [mentionOpen]);
  const skillLibraryOpen = activePopover === 'knowledge';
  const librarySheetRef = useRef<HTMLElement>(null);
  const composerFormRef = useRef<HTMLFormElement>(null);
  const [libraryQuery, setLibraryQuery] = useState('');
  const [libraryCategory, setLibraryCategory] = useState<'common' | 'favorite' | 'mine'>('common');
  useLayoutEffect(() => {
    if (!skillLibraryOpen) return;
    const sheet = librarySheetRef.current;
    const composerForm = composerFormRef.current;
    const host = sheet?.offsetParent;
    if (!sheet || !composerForm || !(host instanceof HTMLElement)) return;
    const positionSheet = () => {
      const hostBounds = host.getBoundingClientRect();
      const composerBounds = composerForm.getBoundingClientRect();
      sheet.style.setProperty('--library-anchor-bottom', `${Math.max(0, hostBounds.bottom - composerBounds.top + 10)}px`);
      sheet.style.setProperty('--library-available-height', `${Math.max(0, composerBounds.top - hostBounds.top - 64)}px`);
    };
    positionSheet();
    const observer = new ResizeObserver(positionSheet);
    observer.observe(host);
    observer.observe(composerForm);
    globalThis.addEventListener('resize', positionSheet);
    return () => { observer.disconnect(); globalThis.removeEventListener('resize', positionSheet); };
  }, [skillLibraryOpen]);
  const [status, setStatus] = useState<'idle' | 'sending'>('idle');
  const [analysisElapsedSeconds, setAnalysisElapsedSeconds] = useState(0);
  const [agentMode, setAgentMode] = useState<'chat' | 'original' | 'codex'>(initialConversation.mode);
  const activeReverseTimeline = useMemo(
    () => agentMode === 'chat' ? [] : selectReverseTimelineContext(reverseTimeline, canvasActionTargets, canvasHasSelection),
    [agentMode, canvasActionTargets, canvasHasSelection, reverseTimeline],
  );
  const [reasoningEfforts, setReasoningEfforts] = useState(initialConversation.reasoningEfforts);
  const [reverseAnalysisDepth, setReverseAnalysisDepth] = useState<ReverseAnalysisDepth>(initialConversation.reverseAnalysisDepth);
  const reasoningEffort = reasoningEfforts[agentMode];
  const setReasoningEffort = (effort: CodexReasoningEffort) => setReasoningEfforts((current) => ({ ...current, [agentMode]: effort }));
  const [error, setError] = useState<string | null>(null);
  const [sentImageCopyFeedback, setSentImageCopyFeedback] = useState<'success' | 'source-error' | 'error' | null>(null);
  const [pendingCanvasAction, setPendingCanvasAction] = useState<SkillCanvasActionRequest | null>(null);
  const [selectedCreativeOptionKey, setSelectedCreativeOptionKey] = useState<string | null>(null);
  const [pendingCanvasModelRoute, setPendingCanvasModelRoute] = useState<string | undefined>(undefined);
  const [pendingCanvasResolution, setPendingCanvasResolution] = useState('');
  const [generationPreferences, setGenerationPreferences] = useState(() => readGenerationPreferences(projectId));
  const [submittedNodeIds, setSubmittedNodeIds] = useState<string[]>(() => canvasResultNodeIds(initialConversation.messages));
  const [submittedNodeLabels, setSubmittedNodeLabels] = useState<Record<string, string>>(() => canvasResultNodeLabels(initialConversation.messages));
  const deliveredNodeTerminalSignatures = useRef(new Map<string, string>());
  const confirmationCardRef = useRef<HTMLElement>(null);
  const conversationEpoch = useRef(0);
  const actionBusy = useRef(false);
  const changeGenerationPreferences = (value: GenerationPreferences) => {
    setGenerationPreferences(value);
    writeGenerationPreferences(projectId, value);
    setPendingCanvasAction(null);
    setSelectedCreativeOptionKey(null);
  };
  const [canvasActionRunning, setCanvasActionRunning] = useState(false);
  const [expandedReverseIds, setExpandedReverseIds] = useState<string[]>([]);
  const [dismissedWorkflowOfferIds, setDismissedWorkflowOfferIds] = useState<string[]>([]);
  const [activeResultImage, setActiveResultImage] = useState<SkillChatReferenceImage | null>(null);
  const [resultImageZoom, setResultImageZoom] = useState(1);
  const messagesStreamRef = useRef<HTMLDivElement>(null);
  const autoScrolledTerminalSignatures = useRef(new Map<string, string>());
  const resultImagePanelRef = useRef<HTMLDivElement>(null);
  const resultImageCloseRef = useRef<HTMLButtonElement>(null);
  const resultImageOpenerRef = useRef<HTMLButtonElement | null>(null);
  const requestId = useRef(0);
  const activeSendRequestId = useRef<number | null>(null);
  const activeLocalCodexRequestId = useRef<string | null>(null);
  const cancelChatRef = useRef(cancelChat);
  cancelChatRef.current = cancelChat;
  const pasteInsertionSequence = useRef(0);
  const pasteImportQueues = useRef(new Map<number, Promise<void>>([[0, Promise.resolve()] ]));
  const pasteImportState = useRef(createPasteImportState());
  const importTokenSequence = useRef(0);
  const mounted = useRef(true);
  const pendingPasteMarkers = useRef(new Set<string>());
  const codexProfiles = useMemo<AgentChatProfile[]>(() => [...localCodexProfiles], [localCodexProfiles]);
  const visibleChatProfiles = agentMode === 'codex' ? codexProfiles : chatProfiles;
  const filteredVisibleChatProfiles = useMemo(() => {
    const query = modelQuery.trim().toLocaleLowerCase();
    if (!query) return visibleChatProfiles;
    return visibleChatProfiles.filter((profile) => (
      `${profile.displayName} ${profile.modelId ?? ''} ${profile.modelRoute} ${profile.provider}`
        .toLocaleLowerCase()
        .includes(query)
    ));
  }, [modelQuery, visibleChatProfiles]);
  const selectedProfile = visibleChatProfiles.find((profile) => profile.modelRoute === modelRoute);
  const isLocalCodexProfile = selectedProfile?.provider === 'codex';
  const supportsImageMentions = isLocalCodexProfile || supportsAgentMediaReferences(selectedProfile, agentMode);
  const imageMentionCapabilityError = isLocalCodexProfile ? CODEX_IMAGE_MENTION_CAPABILITY_ERROR : IMAGE_MENTION_CAPABILITY_ERROR;
  const mediaCapabilityError = isLocalCodexProfile ? CODEX_MEDIA_CAPABILITY_ERROR : MEDIA_CAPABILITY_ERROR;
  const videoMentionCapabilityError = isLocalCodexProfile ? CODEX_MEDIA_CAPABILITY_ERROR : VIDEO_MENTION_CAPABILITY_ERROR;
  const pasteContext = useRef({ generation: 0, supportsMedia: supportsImageMentions });
  pasteContext.current.supportsMedia = supportsImageMentions;
  const supportedEfforts: readonly CodexReasoningEffort[] = selectedProfile?.provider === 'codex'
    ? selectedProfile.supportedReasoningEfforts ?? []
    : selectedProfile?.reasoning?.efforts ?? [];
  const hasSupportedReasoningEffort = selectedProfile?.provider === 'codex'
    ? supportedEfforts.includes(reasoningEffort)
    : true;
  const supportedEffortKey = supportedEfforts.join(',');
  useEffect(() => {
    if (status !== 'sending') {
      setAnalysisElapsedSeconds(0);
      return undefined;
    }
    const startedAt = Date.now();
    const updateElapsed = () => setAnalysisElapsedSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    updateElapsed();
    const timer = window.setInterval(updateElapsed, 1000);
    return () => window.clearInterval(timer);
  }, [status]);
  useEffect(() => {
    if (!supportedEfforts.includes(reasoningEffort)) {
      const defaultEffort = selectedProfile?.provider === 'codex'
        ? selectedProfile.defaultReasoningEffort
        : selectedProfile?.reasoning?.defaultEffort;
      setReasoningEffort(defaultEffort && supportedEfforts.includes(defaultEffort) ? defaultEffort : supportedEfforts[0] ?? 'medium');
    }
  }, [reasoningEffort, selectedProfile, supportedEffortKey]);
  const referenceImporting = isPasteImportBusy(pasteImportState.current);
  useEffect(() => {
    if (activePopover === null) return undefined;
    const closeOnPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest([
        '.skill-chat-workbench__sheet',
        '.skill-chat-workbench__mention-menu',
        '.agent-history-popover',
        '[data-agent-history-trigger]',
        '.codex-reasoning',
        '[data-testid="knowledge-base-trigger"]',
        '[data-testid="agent-model-trigger"]',
        '[data-testid="agent-generation-preferences"]',
      ].join(','))) return;
      dispatchPopover({ type: 'close-external' });
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopImmediatePropagation();
      dispatchPopover({ type: 'close-external' });
    };
    document.addEventListener('pointerdown', closeOnPointerDown);
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOnPointerDown);
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [activePopover]);
  useEffect(() => {
    if (activePopover !== 'model' && activePopover !== 'reasoning-model') setModelQuery('');
  }, [activePopover]);
  useEffect(() => {
    if (activeResultImage === null) return undefined;
    const opener = resultImageOpenerRef.current;
    resultImageCloseRef.current?.focus();
    const keepModalKeyboardFocus = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setActiveResultImage(null);
        return;
      }
      if (event.key !== 'Tab') return;
      const panel = resultImagePanelRef.current;
      if (panel === null) return;
      const focusable = Array.from(panel.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (first === undefined || last === undefined) return;
      if (!panel.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', keepModalKeyboardFocus, true);
    return () => {
      document.removeEventListener('keydown', keepModalKeyboardFocus, true);
      if (opener?.isConnected) opener.focus();
    };
  }, [activeResultImage]);
  const filteredKnowledge = useMemo(() => {
    const activeById = new Map(availableKnowledge.map((knowledgeBase) => [knowledgeBase.knowledgeBaseId, knowledgeBase]));
    const requiredKnowledgeChoices = REQUIRED_AGENT_KNOWLEDGE_CHOICES.map((item) => ({
      ...item,
      knowledgeBase: activeById.get(item.knowledgeBaseId),
    }));
    const query = libraryQuery.trim().toLocaleLowerCase();
    if (!query) return requiredKnowledgeChoices;
    return requiredKnowledgeChoices.filter((item) => `${item.displayName} ${item.description}`.toLocaleLowerCase().includes(query));
  }, [availableKnowledge, libraryQuery]);
  useEffect(() => {
    if (!supportsImageMentions) return;
    setError((current) => current !== null && MEDIA_CAPABILITY_ERRORS.has(current) ? null : current);
  }, [supportsImageMentions]);
  const allReferenceImages = useMemo(() => {
    const byAssetId = new Map<string, SkillChatReferenceImage>();
    for (const image of [...referenceImages, ...importedReferenceImages]) byAssetId.set(image.assetId, image);
    return [...byAssetId.values()];
  }, [importedReferenceImages, referenceImages]);
  const allReferenceVideos = useMemo(() => {
    const byAssetId = new Map<string, SkillChatReferenceVideo>();
    for (const video of referenceVideos) byAssetId.set(video.assetId, video);
    return [...byAssetId.values()];
  }, [referenceVideos]);
  const allReferenceMedia = useMemo(() => [
    ...allReferenceImages.map((media) => ({ ...media, kind: 'image' as const })),
    ...allReferenceVideos.map((media) => ({ ...media, kind: 'video' as const })),
  ], [allReferenceImages, allReferenceVideos]);
  const canonicalReferences = useRef({ images: allReferenceImages, videos: allReferenceVideos });
  canonicalReferences.current = { images: allReferenceImages, videos: allReferenceVideos };
  const currentReferenceCatalog = referenceCatalog.current;
  const mentionReferences = useMemo(
    () => canonicalMentionReferences({ images: allReferenceImages, videos: allReferenceVideos }, currentReferenceCatalog),
    [allReferenceImages, allReferenceVideos, currentReferenceCatalog],
  );
  const mentionMenuReferences = useMemo(() => {
    if (browseProjectImages) return canonicalMentionReferences({ images: allReferenceImages, videos: allReferenceVideos }, appendConversationReferenceCatalog(currentReferenceCatalog, allReferenceImages.map((image) => image.assetId)));
    const activeIds = new Set([
      ...importedReferenceImages.map((image) => image.assetId),
      ...composer.citations.map((citation) => citation.assetId),
      ...messages.flatMap((message) => message.request?.references.map((reference) => reference.assetId) ?? []),
    ]);
    return mentionReferences.filter((reference) => activeIds.has(reference.assetId));
  }, [browseProjectImages, mentionReferences, importedReferenceImages, composer.citations, messages, allReferenceImages, allReferenceVideos, currentReferenceCatalog]);
  const mentionPreviews = useMemo(() => mentionReferences.map((reference) => ({
    token: skillChatMentionToken(reference.kind, reference.mentionPosition),
    label: reference.label,
    displayUrl: reference.displayUrl,
    kind: reference.kind,
  })), [mentionReferences]);
  const refreshReferenceImportState = () => {
    if (mounted.current) setReferenceImportRevision((current) => current + 1);
  };
  const extendReferenceCatalog = (assetIds: readonly string[]): ConversationReferenceCatalogEntry[] => {
    const next = appendConversationReferenceCatalog(referenceCatalog.current, assetIds);
    if (next !== referenceCatalog.current) {
      referenceCatalog.current = next;
      refreshReferenceImportState();
    }
    return next;
  };
  const beginManualReferenceImport = () => {
    const token = `manual-${importTokenSequence.current++}`;
    const generation = pasteImportState.current.generation;
    const insertionMarker = createPasteInsertionMarker(pasteInsertionSequence.current++);
    const selection = normalizeChatMentionSelection(composerSelectionRef.current, composer.text.length);
    pendingPasteMarkers.current.add(insertionMarker);
    setComposer((current) => reducePasteComposer(
      current,
      insertComposerText(current.text, insertionMarker, selection.start, selection.end),
      mentionReferences,
    ));
    pasteImportState.current = startPasteImport(pasteImportState.current, { token, kind: 'manual' });
    refreshReferenceImportState();
    return { token, generation, insertionMarker };
  };
  const finishManualReferenceImport = (token: string) => {
    pasteImportState.current = finishPasteImport(pasteImportState.current, token);
    refreshReferenceImportState();
  };
  const beginPastedReferenceImport = (generation: number, marker: string) => {
    if (!isPasteImportGenerationCurrent(pasteImportState.current, generation)) return;
    pasteImportState.current = startPasteImport(pasteImportState.current, { token: marker, kind: 'pasted' });
    refreshReferenceImportState();
  };
  const finishPastedReferenceImport = (marker: string) => {
    pasteImportState.current = finishPasteImport(pasteImportState.current, marker);
    refreshReferenceImportState();
  };
  const hasCurrentReferenceImport = () => isPasteImportBusy(pasteImportState.current);
  const isPasteGenerationCurrent = (generation: number): boolean => (
    mounted.current && isPasteImportGenerationCurrent(pasteImportState.current, generation)
  );
  const invalidatePastedReferences = () => {
    pasteImportState.current = invalidatePasteImportState(pasteImportState.current);
    pasteImportQueues.current.clear();
    pasteImportQueues.current.set(pasteImportState.current.generation, Promise.resolve());
    const markers = [...pendingPasteMarkers.current];
    pendingPasteMarkers.current.clear();
    if (markers.length > 0) setComposer((current) => reducePasteComposer(current, stripPendingPasteMarkers(current.text, markers), mentionReferences));
    refreshReferenceImportState();
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      const activeRequestId = activeLocalCodexRequestId.current;
      if (activeRequestId !== null) void cancelChatRef.current?.(activeRequestId).catch(() => false);
      mounted.current = false;
      pasteImportState.current = invalidatePasteImportState(pasteImportState.current);
      pasteImportQueues.current.clear();
      pendingPasteMarkers.current.clear();
    };
  }, []);

  const cancelActiveCodexRequest = async (): Promise<boolean> => {
    const activeRequestId = activeLocalCodexRequestId.current;
    if (activeRequestId === null) return false;
    requestId.current += 1;
    try {
      return await (cancelChatRef.current?.(activeRequestId) ?? Promise.resolve(false));
    } finally {
      if (activeLocalCodexRequestId.current === activeRequestId) activeLocalCodexRequestId.current = null;
    }
  };
  const finishCodexCancellation = (cancellation: Promise<boolean>, updateCancelledMessages?: () => void) => {
    const epoch = conversationEpoch.current;
    const generation = requestId.current;
    void cancellation.catch(() => false).finally(() => {
      if (!mounted.current || conversationEpoch.current !== epoch || requestId.current !== generation) return;
      updateCancelledMessages?.();
      setStatus('idle');
    });
  };
  const toggleImageMention = (reference: SkillChatMentionReference) => {
    if (!supportsImageMentions) {
      setError(imageMentionCapabilityError);
      return;
    }
    setComposer((current) => {
      const exists = current.citations.some((citation) => citation.assetId === reference.assetId);
      if (exists) {
        return {
          text: current.text.replace(skillChatMentionToken(reference.kind, reference.mentionPosition), '').replace(/\s{2,}/gu, ' ').trimStart(),
          citations: current.citations.filter((citation) => citation.assetId !== reference.assetId),
        };
      }
      if (current.citations.length >= 20) return current;
      const mentionToken = skillChatMentionToken(reference.kind, reference.mentionPosition);
      const insertion = replaceChatMentionAtSelection(current.text, mentionToken, mentionReferences, composerSelectionRef.current);
      pendingComposerCaretRef.current = insertion.caretOffset;
      composerSelectionRef.current = { start: insertion.caretOffset, end: insertion.caretOffset };
      return { text: insertion.text, citations: [...current.citations, { assetId: reference.assetId, label: reference.label }] };
    });
  };
  const updateComposerText = (text: string) => {
    const openedMention = didInsertMentionToken(composer.text, text);
    setComposer((current) => reducePasteComposer(current, text, mentionReferences));
    if (!openedMention) {
      if (!text.includes('@')) dispatchPopover({ type: 'close-external' });
      return;
    }
    if (!supportsImageMentions) {
      setError(imageMentionCapabilityError);
      return;
    }
    if (allReferenceImages.length > 0) {
      setError(null);
      setBrowseProjectImages(true);
      setReferenceQuery('');
      dispatchPopover({ type: 'open', id: 'reference' });
    }
  };
  const attachImportedReference = (
    imported: SkillChatReferenceImage,
    mentionPosition: number,
    insertionMarker?: string,
    generation?: number,
  ) => {
    if (generation !== undefined && !isPasteGenerationCurrent(generation)) return;
    if (!pasteContext.current.supportsMedia) {
      setError('\u5f53\u524d\u6a21\u578b\u4e0d\u652f\u6301\u56fe\u7247\u6216\u89c6\u9891\uff0c\u8bf7\u5207\u6362\u89c6\u89c9\u6a21\u578b\u540e\u518d\u5f15\u7528');
      return;
    }
    setComposer((current) => {
      const existingCitation = current.citations.some((citation) => citation.assetId === imported.assetId);
      if (!existingCitation && current.citations.length >= 20) return current;
      if (generation !== undefined && !isPasteGenerationCurrent(generation)) return current;
      const importedReference: SkillChatMentionReference = {
        ...imported,
        kind: 'image',
        position: mentionPosition,
        mentionPosition,
        role: 'product_identity',
      };
      const currentMentionReferences = canonicalMentionReferences(
        canonicalReferences.current,
        referenceCatalog.current,
      );
      const composerAtInsertion = existingCitation && insertionMarker !== undefined
        ? { ...current, text: current.text.replace(insertionMarker, '') }
        : current;
      return attachPastedReference(
        composerAtInsertion,
        importedReference,
        existingCitation ? undefined : insertionMarker,
        upsertPasteReferenceByAssetId(currentMentionReferences, importedReference),
      );
    });
    setError(null);
  };
  const importReferenceFile = async (
    file?: File,
    options?: { readonly fromClipboard?: boolean; readonly insertionMarker?: string; readonly generation?: number },
  ): Promise<boolean> => {
    const isVideo = file !== undefined && (file.type.startsWith('video/') || /\.(?:mp4|webm|mov)$/iu.test(file.name));
    if (isVideo) {
      setError(videoMentionCapabilityError);
      return false;
    }
    if (hasCurrentReferenceImport() && options?.fromClipboard !== true) return false;
    const importer = onImportReferenceImage;
    if (importer === undefined) return false;
    const manualImport = options?.fromClipboard === true ? undefined : beginManualReferenceImport();
    const generation = options?.generation ?? manualImport?.generation;
    try {
      const imported = file === undefined && options?.fromClipboard === true
        ? await importer(undefined, { fromClipboard: true })
        : await importer(file);
      if (imported === null) return false;
      if (generation === undefined || !isPasteGenerationCurrent(generation)) return false;
      if (!pasteContext.current.supportsMedia && agentMode !== 'codex') {
        const visionProfile = chatProfiles.find((profile) => supportsAgentMediaReferences(profile, agentMode));
        if (visionProfile !== undefined) {
          invalidateActivePlan();
          setModelRoute(visionProfile.modelRoute);
          pasteContext.current.supportsMedia = true;
        }
      }
      if (!pasteContext.current.supportsMedia) {
        setError(mediaCapabilityError);
        return false;
      }
      const media = canonicalReferences.current.images;
      canonicalReferences.current = {
        ...canonicalReferences.current,
        images: upsertPasteReferenceByAssetId(media, imported),
      };
      const catalog = extendReferenceCatalog([imported.assetId]);
      const mentionPosition = catalog.find((entry) => entry.assetId === imported.assetId)!.mentionPosition;
      setImportedReferenceImages((current) => upsertPasteReferenceByAssetId(current, imported));
      attachImportedReference(imported, mentionPosition, options?.insertionMarker ?? manualImport?.insertionMarker, generation);
      return true;
    } catch {
      if (generation !== undefined && isPasteGenerationCurrent(generation)) setError('\u7d20\u6750\u5bfc\u5165\u5931\u8d25\uff0c\u8bf7\u91cd\u8bd5\u3002');
      return false;
    } finally {
      if (manualImport !== undefined) {
        pendingPasteMarkers.current.delete(manualImport.insertionMarker);
        if (isPasteGenerationCurrent(manualImport.generation)) {
          setComposer((current) => current.text.includes(manualImport.insertionMarker)
            ? reducePasteComposer(
              current,
              current.text.replace(manualImport.insertionMarker, ''),
              canonicalMentionReferences(canonicalReferences.current, referenceCatalog.current),
            )
            : current);
        }
        finishManualReferenceImport(manualImport.token);
      }
    }
  };
  const importPastedReferencesInOrder = async (
    media: readonly (ReturnType<typeof readAgentChatClipboard>['media'][number] | undefined)[],
    insertionMarker: string,
    generation: number,
  ) => {
    let hadFailure = false;
    let hadUnsupportedVideo = false;
    try {
      for (const item of media) {
        if (!isPasteGenerationCurrent(generation)) return;
        const itemIsVideo = item?.kind === 'video';
        if (itemIsVideo) {
          hadUnsupportedVideo = true;
          continue;
        }
        if (!pasteContext.current.supportsMedia) {
          setError(mediaCapabilityError);
          return;
        }
        const imported = await importReferenceFile(item?.file, {
          fromClipboard: true,
          insertionMarker,
          generation,
        });
        if (!isPasteGenerationCurrent(generation)) return;
        if (!imported) {
          hadFailure = true;
        }
      }
    } finally {
      pendingPasteMarkers.current.delete(insertionMarker);
      if (!isPasteGenerationCurrent(generation)) return;
      setComposer((current) => current.text.includes(insertionMarker)
        ? reducePasteComposer(current, current.text.replace(insertionMarker, ''), canonicalMentionReferences(canonicalReferences.current, referenceCatalog.current))
        : current);
      if (hadUnsupportedVideo) setError(videoMentionCapabilityError);
      else if (hadFailure) setError('\u7d20\u6750\u5bfc\u5165\u5931\u8d25\uff0c\u8bf7\u91cd\u8bd5\u3002');
    }
  };
  const requestReferenceImport = () => {
    const nativeDesktopPicker = globalThis.window?.novusDesktop !== undefined && globalThis.window.__NOVUS_MANUAL_ACCEPTANCE__ !== true;
    if (nativeDesktopPicker) void importReferenceFile();
    else referenceFileInput.current?.click();
  };
  const handleComposerPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const payload = readAgentChatClipboard(event.clipboardData);
    const useNativeClipboard = globalThis.window?.novusDesktop !== undefined
      && onImportReferenceImage !== undefined
      && payload.text.length === 0
      && payload.media.length === 0
      && (event.clipboardData.files?.length ?? 0) === 0
      && !Array.from(event.clipboardData.items ?? []).some((item) => item.kind === 'file' && item.getAsFile() !== null)
      && (Array.from(event.clipboardData.types ?? []).length === 0
        || Array.from(event.clipboardData.types ?? []).some((type) => type === 'Files' || type === 'text/uri-list' || type.startsWith('image/')));
    const fallbackVisionProfile = pasteContext.current.supportsMedia || agentMode === 'codex'
      ? undefined
      : chatProfiles.find((profile) => supportsAgentMediaReferences(profile, agentMode));
    const action = resolveClipboardPasteAction({
      hasPlainText: event.clipboardData.getData('text/plain').length > 0,
      parsedText: payload.text,
      hasMedia: payload.media.length > 0 || useNativeClipboard,
      supportsMedia: pasteContext.current.supportsMedia || fallbackVisionProfile !== undefined,
    });
    if (action === 'native-text' || action === 'ignore') return;
    event.preventDefault();
    event.stopPropagation();
    const composerElement = event.currentTarget;
    const generation = pasteImportState.current.generation;
    const selection = readComposerSelection(composerElement, composer.text.length);
    if (action === 'reject-media') {
      if (payload.text.length > 0) setComposer((current) => reducePasteComposer(
        current,
        insertComposerText(current.text, payload.text, selection.start, selection.end),
        mentionReferences,
      ));
      setError(mediaCapabilityError);
      if (payload.text.length > 0) setTimeout(() => {
        if (isPasteGenerationCurrent(generation)) restoreComposerCaret(composerElement, selection.start + payload.text.length);
      }, 0);
      return;
    }
    if (action === 'controlled-text') {
      setComposer((current) => reducePasteComposer(
        current,
        insertComposerText(current.text, payload.text, selection.start, selection.end),
        mentionReferences,
      ));
      setTimeout(() => {
        if (isPasteGenerationCurrent(generation)) restoreComposerCaret(composerElement, selection.start + payload.text.length);
      }, 0);
      return;
    }
    // A pasted file is already a concrete media reference; keep the mention
    // picker from covering the newly attached thumbnail while the import runs.
    dispatchPopover({ type: 'close-external' });
    if (fallbackVisionProfile !== undefined) {
      invalidateActivePlan();
      setModelRoute(fallbackVisionProfile.modelRoute);
      pasteContext.current.supportsMedia = true;
    }
    const insertionMarker = createPasteInsertionMarker(pasteInsertionSequence.current++);
    pendingPasteMarkers.current.add(insertionMarker);
    setComposer((current) => reducePasteComposer(
      current,
      insertComposerText(current.text, `${payload.text}${insertionMarker}`, selection.start, selection.end),
      mentionReferences,
    ));
    setTimeout(() => {
      if (isPasteGenerationCurrent(generation)) restoreComposerCaret(composerElement, selection.start + payload.text.length);
    }, 0);
    beginPastedReferenceImport(generation, insertionMarker);
    const previousQueue = pasteImportQueues.current.get(generation) ?? Promise.resolve();
    const nextQueue = previousQueue
      .catch(() => undefined)
      .then(() => importPastedReferencesInOrder(useNativeClipboard ? [undefined] : payload.media, insertionMarker, generation))
      .finally(() => finishPastedReferenceImport(insertionMarker));
    pasteImportQueues.current.set(generation, nextQueue);
    void nextQueue.finally(() => {
      if (pasteImportQueues.current.get(generation) === nextQueue) pasteImportQueues.current.delete(generation);
    });
  };

  useEffect(() => {
    const profilesForMode = agentMode === 'codex' ? codexProfiles : chatProfiles;
    // A persisted conversation can outlive a provider refresh (or contain the
    // old numeric route used by the first Agent prototype). Repair the route
    // only when this mode has real profiles; Codex must still explicitly show
    // that no Codex route is configured instead of silently switching modes.
    if (profilesForMode.length === 0) return;
    setModelRoute((current) => (
      current && profilesForMode.some((profile) => profile.modelRoute === current)
        ? current
        : profilesForMode.find((profile) => profile.modelRoute === 'chat-default')?.modelRoute ?? profilesForMode[0]?.modelRoute
    ));
  }, [agentMode, chatProfiles, codexProfiles]);

  useEffect(() => {
    const selectableIds = new Set<string>(REQUIRED_AGENT_KNOWLEDGE_CHOICES.map((item) => item.knowledgeBaseId));
    setSelectedKnowledgeBaseIds((current) => {
      const next = current.filter((id) => selectableIds.has(id));
      return sameStringList(current, next) ? current : next;
    });
  }, [projectId]);

  useEffect(() => {
    setSelectedProjectMemoryIds((current) => {
      const next = clampProjectMemoryIds(current, availableProjectMemoryIds);
      return sameStringList(current, next) ? current : next;
    });
  }, [availableProjectMemoryIds]);

  useEffect(() => {
    const receiveGeneratedImageAsset = (assetId: string): boolean => {
      if (!allReferenceImages.some((candidate) => candidate.assetId === assetId)) return false;
      const catalog = extendReferenceCatalog([assetId]);
      const currentMentionReferences = canonicalMentionReferences(canonicalReferences.current, catalog);
      const reference = currentMentionReferences.find((candidate) => candidate.assetId === assetId);
      if (reference === undefined) return false;
      if (!supportsImageMentions) {
        const visualProfile = visibleChatProfiles.find((profile) => supportsAgentMediaReferences(profile, agentMode))
          ?? chatProfiles.find((profile) => supportsAgentMediaReferences(profile, 'chat'));
        if (visualProfile === undefined) {
          setError(imageMentionCapabilityError);
          return true;
        }
        if (agentMode === 'codex' && visualProfile.provider !== 'codex') setAgentMode('chat');
        setModelRoute(visualProfile.modelRoute);
      }
      setComposer((current) => {
        if (current.citations.some((citation) => citation.assetId === reference.assetId)) return current;
        if (current.citations.length >= 20) return current;
        const mentionToken = skillChatMentionToken(reference.kind, reference.mentionPosition);
        const insertion = replaceChatMentionAtSelection(current.text, mentionToken, currentMentionReferences, composerSelectionRef.current);
        pendingComposerCaretRef.current = insertion.caretOffset;
        composerSelectionRef.current = { start: insertion.caretOffset, end: insertion.caretOffset };
        return {
          text: insertion.text,
          citations: [...current.citations, { assetId: reference.assetId, label: reference.label }],
        };
      });
      setError(null);
      dispatchPopover({ type: 'close-external' });
      return true;
    };
    const receiveGeneratedImage = (event: Event) => {
      const assetId = (event as CustomEvent<{ assetId?: unknown }>).detail?.assetId;
      if (typeof assetId !== 'string') return;
      if (receiveGeneratedImageAsset(assetId)) consumeQueuedGeneratedImageForAgent(assetId);
    };
    globalThis.addEventListener('novus:generated-image-to-agent', receiveGeneratedImage);
    for (const assetId of listQueuedGeneratedImagesForAgent()) {
      if (receiveGeneratedImageAsset(assetId)) consumeQueuedGeneratedImageForAgent(assetId);
    }
    return () => globalThis.removeEventListener('novus:generated-image-to-agent', receiveGeneratedImage);
  }, [agentMode, allReferenceImages, chatProfiles, imageMentionCapabilityError, supportsImageMentions, visibleChatProfiles]);

  useLayoutEffect(() => {
    setConversationCollection((current) => {
      const existing = current.conversations.find((conversation) => conversation.id === activeConversationId);
      if (existing === undefined) return current;
      const firstUserMessage = messages.find((message) => message.role === 'user');
      const updated: StoredAgentConversation = {
        ...existing,
        title: existing.title === '新任务' && firstUserMessage !== undefined
          ? deriveAgentConversationTitle(firstUserMessage.content)
          : existing.title,
        mode: agentMode,
        reasoningEfforts,
        reverseAnalysisDepth,
        ...(modelRoute === undefined ? { modelRoute: undefined } : { modelRoute }),
        knowledgeBaseIds: [...selectedKnowledgeBaseIds],
        projectMemoryIds: [...selectedProjectMemoryIds],
        messages: [...messages],
        updatedAt: Date.now(),
      };
      const next = {
        version: 2 as const,
        activeConversationId,
        conversations: current.conversations.map((conversation) => conversation.id === activeConversationId ? updated : conversation),
      };
      writeAgentConversationCollection(projectId, next);
      return next;
    });
  }, [activeConversationId, agentMode, messages, modelRoute, projectId, reasoningEfforts, reverseAnalysisDepth, selectedKnowledgeBaseIds, selectedProjectMemoryIds]);

  useLayoutEffect(() => {
    const offset = pendingComposerCaretRef.current;
    if (offset === null) return;
    pendingComposerCaretRef.current = null;
    const editor = document.querySelector<HTMLElement>('[data-testid="agent-composer-input"]');
    if (editor === null) return;
    editor.focus();
    restoreComposerCaret(editor as EventTarget & HTMLTextAreaElement, offset);
  }, [composer.text]);

  const invalidateActivePlan = () => {
    requestId.current += 1;
    setPendingCanvasAction(null);
    setSelectedCreativeOptionKey(null);
    setPendingCanvasModelRoute(undefined);
    if (activeLocalCodexRequestId.current === null) setStatus('idle');
  };

  const activateConversation = (conversationId: string) => {
    const conversation = conversationCollection.conversations.find((candidate) => candidate.id === conversationId);
    if (conversation === undefined || conversation.id === activeConversationId) return;
    const cancellingCodex = activeLocalCodexRequestId.current !== null;
    const cancellation = cancellingCodex ? cancelActiveCodexRequest() : null;
    invalidatePastedReferences();
    requestId.current += 1;
    conversationEpoch.current += 1;
    setSubmittedNodeIds(canvasResultNodeIds(conversation.messages));
    setSubmittedNodeLabels(canvasResultNodeLabels(conversation.messages));
    deliveredNodeTerminalSignatures.current.clear();
    setActiveConversationId(conversation.id);
    setModelRoute(conversation.modelRoute ?? chatProfiles.find((profile) => profile.modelRoute === 'chat-default')?.modelRoute ?? chatProfiles[0]?.modelRoute);
    setSelectedKnowledgeBaseIds([...conversation.knowledgeBaseIds]);
    setSelectedProjectMemoryIds(clampProjectMemoryIds(conversation.projectMemoryIds, availableProjectMemoryIds));
    setMessages([...conversation.messages]);
    referenceCatalog.current = createConversationReferenceCatalog(conversation.messages, allReferenceImages);
    setAgentMode(conversation.mode);
    setReasoningEfforts(conversation.reasoningEfforts);
    setReverseAnalysisDepth(conversation.reverseAnalysisDepth);
    setComposer({ text: '', citations: [] });
    setImportedReferenceImages([]);
    setStatus(cancellingCodex ? 'sending' : 'idle');
    setPendingCanvasAction(null);
    setSelectedCreativeOptionKey(null);
    setCanvasActionRunning(false);
    setError(null);
    dispatchPopover({ type: 'close-external' });
    if (cancellation !== null) finishCodexCancellation(cancellation);
  };

  const createConversation = () => {
    const cancellingCodex = activeLocalCodexRequestId.current !== null;
    const cancellation = cancellingCodex ? cancelActiveCodexRequest() : null;
    invalidatePastedReferences();
    requestId.current += 1;
    conversationEpoch.current += 1;
    setSubmittedNodeIds([]);
    setSubmittedNodeLabels({});
    deliveredNodeTerminalSignatures.current.clear();
    let now = Date.now();
    while (conversationCollection.conversations.some((conversation) => conversation.id === `conversation-${now}`)) now += 1;
    const created: StoredAgentConversation = {
      ...createAgentConversation(now),
      ...(chatProfiles[0]?.modelRoute === undefined ? {} : { modelRoute: chatProfiles[0].modelRoute }),
      projectMemoryIds: [...availableProjectMemoryIds],
    };
    const next = addAgentConversation(conversationCollection, created);
    writeAgentConversationCollection(projectId, next);
    setConversationCollection(next);
    setActiveConversationId(created.id);
    setModelRoute(created.modelRoute);
    setSelectedKnowledgeBaseIds([]);
    setSelectedProjectMemoryIds([...created.projectMemoryIds]);
    setMessages([]);
    referenceCatalog.current = [];
    setAgentMode(created.mode);
    setReasoningEfforts(created.reasoningEfforts);
    setReverseAnalysisDepth(created.reverseAnalysisDepth);
    setComposer({ text: '', citations: [] });
    setImportedReferenceImages([]);
    setStatus(cancellingCodex ? 'sending' : 'idle');
    setPendingCanvasAction(null);
    setSelectedCreativeOptionKey(null);
    setCanvasActionRunning(false);
    setError(null);
    dispatchPopover({ type: 'close-external' });
    if (cancellation !== null) finishCodexCancellation(cancellation);
  };

  const send = async () => {
    const cleanComposer = reducePasteComposer(
      composer,
      stripPendingPasteMarkers(composer.text, pendingPasteMarkers.current),
      mentionReferences,
    );
    const content = cleanComposer.text.trim();
    if (!content) {
      if (composer.text !== cleanComposer.text || composer.citations.length !== cleanComposer.citations.length) setComposer(cleanComposer);
      invalidatePastedReferences();
      return;
    }
    if (!modelRoute || selectedProfile === undefined || !hasSupportedReasoningEffort || status === 'sending'
      || activeSendRequestId.current === requestId.current) return;
    invalidatePastedReferences();
    const selectedReferences = resolveSelectedPasteReferences(cleanComposer.citations, mentionReferences);
    if (selectedReferences.length > 0 && !supportsImageMentions) {
      setError(imageMentionCapabilityError);
      return;
    }
    const visualAnalysis = shouldUseVisualAnalysis(agentMode, content, selectedReferences.length);
    const planning = agentMode === 'original';
    const workflowPlanning = agentMode === 'codex' && !isReverseAnalysisIntent(content)
      && isWorkflowCreationIntent(content, selectedReferences.length);
    const planningInstructions = planning ? creativePlanningInstructions(generationPreferences, profiles, selectedReferences.length, reverseAnalysisDepth)
      : workflowPlanning ? '先分析用户需求和本次参考图，再编写可直接用于生成模型的完整提示词。明确主体、构图、材质、光照、保留项、修改项与禁止项；不要逐字复制用户原话，不要包含聊天口吻、画布操作或 @ 图片标记。只返回 JSON：{"summary":"方案说明","generation":{"prompt":"分析后编写的完整执行提示词"}}。无法形成方案时 generation.prompt 留空并在 summary 说明原因。' : '';
    const maxMessageLength = selectedProfile.provider === 'codex'
      ? MAX_CODEX_SKILL_CHAT_MESSAGE_LENGTH
      : MAX_PROVIDER_SKILL_CHAT_MESSAGE_LENGTH;
    const planningMessageLength = content.length + (planningInstructions.length > 0 ? planningInstructions.length + 2 : 0);
    if (planningMessageLength > maxMessageLength) {
      setError('消息过长，请分段发送。');
      return;
    }
    const reverseSeparatorLength = planningInstructions.length > 0 ? 2 : content.length > 0 ? 2 : 0;
    const reverseContextInstructions = formatReverseTimelineContext(
      activeReverseTimeline,
      maxMessageLength - planningMessageLength - reverseSeparatorLength,
    );
    const providerInstructions = [planningInstructions, reverseContextInstructions].filter((item) => item.length > 0).join('\n\n');
    setPendingCanvasAction(null);
    setSelectedCreativeOptionKey(null);
    const requestSummary: SkillRequestSummary = {
      modelDisplayName: selectedProfile?.displayName ?? modelRoute,
      modelRoute,
      knowledgeBaseCount: selectedKnowledgeBaseIds.length,
      knowledgeBaseIds: [...selectedKnowledgeBaseIds],
      projectMemoryCount: selectedProjectMemoryIds.length,
      references: selectedReferences.map(({ assetId, label }) => ({ assetId, label })),
      status: 'sending',
      visualAnalysis,
      ...(visualAnalysis ? { reverseAnalysisDepth } : {}),
      ...(planning ? { generationKind: generationPreferences.kind } : {}),
    };
    const previousMessage = messages[messages.length - 1];
    const replacesFailedRequest = isIdenticalFailedRequest(previousMessage, content, requestSummary);
    const userMessage: SkillMessage = {
      id: replacesFailedRequest ? previousMessage!.id : createMessageId(),
      role: 'user',
      content,
      mode: agentMode,
      request: requestSummary,
    };
    const nextMessages = replacesFailedRequest
      ? [...messages.slice(0, -1), userMessage]
      : [...messages, userMessage];
    const retryComposer = cleanComposer;
    const activeKnowledgeBaseIds = new Set(availableKnowledge.map((knowledgeBase) => knowledgeBase.knowledgeBaseId));
    const activeRequestId = requestId.current + 1;
    requestId.current = activeRequestId;
    activeSendRequestId.current = activeRequestId;
    const localCodexRequestId = selectedProfile.provider === 'codex' ? createMessageId() : undefined;
    if (localCodexRequestId !== undefined) activeLocalCodexRequestId.current = localCodexRequestId;
    dispatchPopover({ type: 'close-external' });
    setMessages(nextMessages);
    setComposer({ text: '', citations: [] });
    setError(null);
    setStatus('sending');
    try {
      const activeModeMessages = nextMessages.filter((message) => (message.mode ?? agentMode) === agentMode && !message.id.startsWith('canvas-result:'));
      const result = await withProviderOperationTimeout(chat({
        provider: selectedProfile?.provider ?? 'comfly',
        modelRoute,
        ...(localCodexRequestId === undefined ? {} : { requestId: localCodexRequestId }),
        messages: providerSkillChatMessages(activeModeMessages, providerInstructions, maxMessageLength),
        context: {
          knowledgeBaseIds: selectedKnowledgeBaseIds.filter((knowledgeBaseId) => activeKnowledgeBaseIds.has(knowledgeBaseId)),
          projectMemoryIds: clampProjectMemoryIds(selectedProjectMemoryIds, availableProjectMemoryIds),
        },
        ...(selectedReferences.length > 0 ? { referenceAssetIds: selectedReferences.map((reference) => reference.assetId) } : {}),
        ...(selectedReferences.length > 0 ? { referenceMentions: selectedReferences } : {}),
        agentMode,
        ...(supportedEfforts.length > 0 ? { reasoningEffort } : {}),
        ...(visualAnalysis ? { reverseAnalysisDepth } : {}),
        visualAnalysis,
      }), resolveAgentRequestTimeoutMs(
        selectedProfile.provider,
        reasoningEffort,
        selectedReferences.length > 0 || visualAnalysis,
        visualAnalysis ? reverseAnalysisDepth : undefined,
      ));
      if (requestId.current !== activeRequestId) return;
      setMessages((current) => [...current.map((message) => message.id === userMessage.id && message.request !== undefined
        ? { ...message, request: { ...message.request, status: 'completed' as const } }
        : message), {
        id: createMessageId(),
        role: 'assistant',
        content: result.message,
        mode: agentMode,
        sources: result.sources,
      }]);
      setStatus('idle');
    } catch (caught) {
      if (caught instanceof ProviderOperationTimeoutError && localCodexRequestId !== undefined) {
        try {
          await cancelChatRef.current?.(localCodexRequestId);
        } catch {
          // The UI still ends the timed-out request even if the process already exited.
        } finally {
          if (requestId.current === activeRequestId && activeLocalCodexRequestId.current === localCodexRequestId) activeLocalCodexRequestId.current = null;
        }
      }
      if (requestId.current !== activeRequestId) return;
      setStatus('idle');
      setComposer((current) => current.text.trim().length === 0 && current.citations.length === 0 ? retryComposer : current);
      setMessages((current) => current.map((message) => message.id === userMessage.id && message.request !== undefined
        ? { ...message, request: { ...message.request, status: 'error' as const } }
        : message));
      setError(skillChatErrorMessage(caught));
    } finally {
      if (activeSendRequestId.current === activeRequestId) activeSendRequestId.current = null;
      if (requestId.current === activeRequestId && localCodexRequestId !== undefined && activeLocalCodexRequestId.current === localCodexRequestId) {
        activeLocalCodexRequestId.current = null;
      }
    }
  };

  const chooseCreativeOption = (messageId: string, option: CreativePlanOption, references: readonly { assetId: string }[], sourceRequest?: string) => {
    try {
      const promptQuality = assessCreativeGenerationPrompt(option.prompt, sourceRequest);
      if (!promptQuality.valid && promptQuality.reason === 'contains-mention') {
        setError('Agent 返回的生图提示词仍包含 @图片 或 @视频标记，请重新分析后再执行。');
        return;
      }
      if (!promptQuality.valid && promptQuality.reason === 'copied') {
        setError('Agent 没有把需求改写成生图提示词，请重新分析后再执行。');
        return;
      }
      if (!promptQuality.valid) {
        setError('Agent 返回的生图提示词过于简略，需补充主体、构图、光线、材质、保留项和禁止项后再执行。');
        return;
      }
      const { profile, parameters } = resolveGenerationPreference(option.kind, generationPreferences, profiles, option.modelRoute, references.length);
      const kind = `${option.kind}_generation` as const;
      setPendingCanvasAction({ kind, nodeId: `agent-${option.kind}-${createMessageId()}`, createNode: true, createWorkflow: true, projectId, prompt: option.prompt, modelRoute: profile.modelRoute, parameters, referenceAssetIds: references.map((item) => item.assetId) });
      setSelectedCreativeOptionKey(`${messageId}:${option.id}`);
      setPendingCanvasModelRoute(profile.modelRoute);
      setPendingCanvasResolution(typeof parameters.resolution === 'string' ? parameters.resolution : '');
      setError(null);
    } catch (error) { setError(error instanceof Error ? error.message : '请检查生成偏好。'); }
  };

  useLayoutEffect(() => {
    if (pendingCanvasAction === null) return;
    const stream = messagesStreamRef.current;
    if (stream !== null) stream.scrollTop = stream.scrollHeight;
  }, [pendingCanvasAction]);

  useEffect(() => {
    for (const nodeId of submittedNodeIds) {
      const result = canvasActionResults.find((item) => item.nodeId === nodeId);
      if (!result) continue;
      if (!['completed', 'failed', 'cancelled'].includes(result.status)) {
        deliveredNodeTerminalSignatures.current.delete(nodeId);
        continue;
      }
      const terminalSignature = `${result.status}:${result.assetIds.join('\u0000')}`;
      if (deliveredNodeTerminalSignatures.current.get(nodeId) === terminalSignature) continue;
      deliveredNodeTerminalSignatures.current.set(nodeId, terminalSignature);
      const content = result.status === 'completed' && result.assetIds.length > 0
        ? `生成已完成，${result.assetIds.length} 个结果已回写画布节点。`
        : result.status === 'cancelled' ? '生成已取消。'
          : result.status === 'failed' ? '生成失败，请查看画布节点中的错误信息。' : '任务结束，但未收到可展示的结果。';
      setMessages((current) => current.map((message) => message.id === `canvas-result:${nodeId}` ? { ...message, content } : message));
    }
  }, [canvasActionResults, submittedNodeIds]);

  useEffect(() => {
    let shouldScroll = false;
    for (const nodeId of submittedNodeIds) {
      const result = canvasActionResults.find((item) => item.nodeId === nodeId);
      if (result === undefined || !['completed', 'failed', 'cancelled'].includes(result.status)) {
        autoScrolledTerminalSignatures.current.delete(nodeId);
        continue;
      }
      const signature = `${result.status}:${result.assetIds.join('\u0000')}`;
      if (autoScrolledTerminalSignatures.current.get(nodeId) === signature) continue;
      autoScrolledTerminalSignatures.current.set(nodeId, signature);
      shouldScroll = true;
    }
    if (!shouldScroll) return;
    window.requestAnimationFrame(() => {
      const stream = messagesStreamRef.current;
      if (stream === null) return;
      if (typeof stream.scrollTo === 'function') stream.scrollTo({ top: stream.scrollHeight, behavior: 'smooth' });
      else stream.scrollTop = stream.scrollHeight;
    });
  }, [canvasActionResults, submittedNodeIds]);

  useEffect(() => {
    const targetLabels = new Map(canvasActionTargets
      .filter((target) => submittedNodeIds.includes(target.nodeId))
      .map((target) => [target.nodeId, target.label] as const));
    if (targetLabels.size === 0) return;
    setSubmittedNodeLabels((current) => {
      const next = { ...current };
      let changed = false;
      for (const [nodeId, label] of targetLabels) {
        if (next[nodeId] === label) continue;
        next[nodeId] = label;
        changed = true;
      }
      return changed ? next : current;
    });
    setMessages((current) => {
      let changed = false;
      const next = current.map((message) => {
        if (!message.id.startsWith('canvas-result:')) return message;
        const nodeId = message.id.slice('canvas-result:'.length);
        const label = targetLabels.get(nodeId);
        if (label === undefined || message.canvasNodeLabel === label) return message;
        changed = true;
        return { ...message, canvasNodeLabel: label };
      });
      return changed ? next : current;
    });
  }, [canvasActionTargets, submittedNodeIds]);

  const confirmCanvasAction = async () => {
    if (pendingCanvasAction === null || executeCanvasAction === undefined || canvasActionRunning || actionBusy.current) return;
    const action = pendingCanvasAction;
    const epoch = conversationEpoch.current;
    actionBusy.current = true;
    setCanvasActionRunning(true);
    setError(null);
    try {
      const kind = action.kind === 'video_generation' ? 'video' : 'image';
      const resolved = resolveGenerationPreference(kind, generationPreferences, profiles, pendingCanvasModelRoute, action.referenceAssetIds?.length ?? 0);
      const parameters: GenerationParameters = { ...resolved.parameters };
      if (pendingCanvasResolution.length > 0) parameters.resolution = pendingCanvasResolution;
      else delete parameters.resolution;
      const routedProfile = kind === 'image' && parameters.resolution
        ? resolveImageResolutionRoute(generationProfiles(profiles, 'image', action.referenceAssetIds?.length ?? 0), resolved.profile, parameters.resolution as ImageResolutionTier)
        : resolved.profile;
      if (!routedProfile) throw new Error('所选清晰度没有可用的模型路由，请重新选择。');
      const execution = await executeCanvasAction({ ...action, modelRoute: routedProfile.modelRoute, parameters });
      if (!mounted.current || epoch !== conversationEpoch.current) return;
      const started = typeof execution === 'boolean' ? execution : execution.started;
      const generationNodeId = typeof execution === 'boolean' ? action.nodeId : execution.generationNodeId;
      if (!started) {
        setError(`${canvasActionLabel(action.kind)}节点未能启动，请检查模型配置后重试。`);
        return;
      }
      const canvasNodeLabel = `${canvasActionLabel(action.kind)} · ${action.prompt.replace(/\s+/gu, ' ').trim().slice(0, 28)}`;
      setMessages((current) => [...current, {
        id: `canvas-result:${generationNodeId}`,
        role: 'assistant',
        mode: agentMode,
        content: `${canvasActionLabel(action.kind)}节点已开始运行。`,
        canvasNodeLabel,
      }]);
      setSubmittedNodeIds((current) => [...new Set([...current, generationNodeId])]);
      setSubmittedNodeLabels((current) => ({ ...current, [generationNodeId]: canvasNodeLabel }));
      setPendingCanvasAction(null);
      setSelectedCreativeOptionKey(null);
      setPendingCanvasModelRoute(undefined);
      setPendingCanvasResolution('');
    } catch (caught) {
      if (mounted.current && epoch === conversationEpoch.current) setError(canvasActionErrorMessage(caught, action.kind));
    } finally {
      actionBusy.current = false;
      if (mounted.current && epoch === conversationEpoch.current) setCanvasActionRunning(false);
    }
  };

  const copySentImage = async (displayUrl: string) => {
    setSentImageCopyFeedback(null);
    let copied = false;
    let failure: 'source-error' | 'error' = 'error';
    try {
      const response = await fetch(displayUrl, { cache: 'no-store' });
      const blob = await response.blob();
      const contentType = (response.headers.get('content-type') ?? blob.type).toLocaleLowerCase();
      if (!response.ok || blob.size === 0 || !contentType.startsWith('image/')) {
        failure = 'source-error';
        throw new Error('Sent image response is unavailable or not an image.');
      }
      const nativeWrite = window.novusDesktop?.projectImages.writeClipboardImage;
      if (nativeWrite !== undefined) {
        try {
          copied = await nativeWrite(new Uint8Array(await blob.arrayBuffer()));
        } catch {
          copied = false;
        }
      }
      if (!copied && blob.type.length > 0 && typeof ClipboardItem !== 'undefined' && typeof globalThis.navigator?.clipboard?.write === 'function') {
        await globalThis.navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
        copied = true;
      }
    } catch {
      copied = false;
    }
    if (mounted.current) setSentImageCopyFeedback(copied ? 'success' : failure);
  };

  const pendingCanvasActionKind = pendingCanvasAction?.kind === 'video_generation' ? 'video' : 'image';
  const pendingCanvasActionNeedsReferences = pendingCanvasAction !== null
    && pendingCanvasAction.kind !== 'reverse_agent'
    && (pendingCanvasAction.referenceAssetIds?.length ?? 0) > 0;
  const pendingCanvasActionProfiles = pendingCanvasAction === null
    ? []
    : pendingCanvasAction.kind === 'reverse_agent'
      ? profiles.filter((profile) => profile.capabilityStatus !== 'incomplete' && profile.capabilities.includes('reverse_prompt'))
      : generationProfiles(profiles, pendingCanvasActionKind, pendingCanvasAction?.referenceAssetIds?.length ?? 0);
  const pendingCanvasVisibleProfiles = pendingCanvasAction?.kind === 'image_generation'
    ? uniqueImageFamilyProfiles(pendingCanvasActionProfiles)
    : pendingCanvasActionProfiles;
  const pendingCanvasPreference = pendingCanvasAction === null || pendingCanvasAction.kind === 'reverse_agent'
    ? undefined
    : generationPreferences[pendingCanvasActionKind];
  const pendingCanvasFixedRouteIsCompatible = pendingCanvasPreference?.mode !== 'fixed'
    || pendingCanvasActionProfiles.some((profile) => profile.modelRoute === pendingCanvasPreference.modelRoute);
  const pendingCanvasModelLocked = pendingCanvasPreference?.mode === 'fixed' && pendingCanvasFixedRouteIsCompatible;
  const pendingCanvasSelectedProfile = pendingCanvasActionProfiles.find((profile) => profile.modelRoute === pendingCanvasModelRoute);
  const pendingCanvasVisibleSelection = pendingCanvasAction?.kind === 'image_generation' && pendingCanvasSelectedProfile
    ? pendingCanvasVisibleProfiles.find((profile) => profile.provider === pendingCanvasSelectedProfile.provider && imageResolutionFamilyKey(profile) === imageResolutionFamilyKey(pendingCanvasSelectedProfile))
    : pendingCanvasSelectedProfile;
  const pendingCanvasResolutionOptions = pendingCanvasAction?.kind === 'video_generation'
    ? pendingCanvasSelectedProfile?.constraints?.video?.resolutions ?? []
    : pendingCanvasAction?.kind === 'image_generation'
      ? listImageResolutionTiers(pendingCanvasActionProfiles, pendingCanvasSelectedProfile)
      : [];

  const messageDetails = useMemo(() => messages.map((message, messageIndex) => {
    const precedingMessage = messageIndex > 0 ? messages[messageIndex - 1] : undefined;
    const messageMode = message.mode ?? agentMode;
    const parsedCreativePlan = message.role === 'assistant' && messageMode === 'original'
      ? parseCreativePlan(message.content)
      : null;
    const requestedGenerationKind = precedingMessage?.role === 'user'
      ? precedingMessage.request?.generationKind
      : undefined;
    const constrainedCreativePlan = parsedCreativePlan !== null && requestedGenerationKind !== undefined
      ? constrainCreativePlanKind(parsedCreativePlan, requestedGenerationKind)
      : null;
    const creativePlan = message.role === 'assistant' && messageMode === 'original'
      ? constrainedCreativePlan?.plan ?? parsedCreativePlan ?? (precedingMessage?.role === 'user'
        ? recoverEmptyCreativePlan(
          message.content,
          precedingMessage.content,
          requestedGenerationKind === undefined ? generationPreferences : { ...generationPreferences, kind: requestedGenerationKind },
          profiles,
          precedingMessage.request?.references.length ?? 0,
        )
        : null)
      : null;
    const reverseWorkflowOffer = precedingMessage?.role === 'user'
      && precedingMessage.request?.visualAnalysis === true
      && isReverseAnalysisIntent(precedingMessage.content);
    const requestedWorkflowOffer = precedingMessage?.role === 'user'
      && messageMode === 'codex'
      && isWorkflowCreationIntent(precedingMessage.content, precedingMessage.request?.references.length ?? 0);
    const workflowReferences = precedingMessage?.request?.references.map((reference, index) => ({
      ...reference,
      mention: `@图片${index + 1}`,
    })) ?? [];
    const reverseAnalysis = reverseWorkflowOffer && message.role === 'assistant'
      ? parseReverseAnalysisResponse(message.content, workflowReferences.map((reference) => ({
        ...reference,
        responsibility: '待模型确认',
        inherit: [],
        replace: [],
        doNotCopy: [],
      })))
      : null;
    const workflowSummary = message.role === 'assistant' && messageMode === 'codex'
      ? parseWorkflowPlanningSummary(message.content)
      : null;
    return {
      message, precedingMessage, messageMode, requestedGenerationKind, creativePlan,
      reverseWorkflowOffer, requestedWorkflowOffer, workflowReferences, reverseAnalysis, workflowSummary,
    };
  }), [messages, agentMode, generationPreferences, profiles]);

  const renderSubmittedResult = (nodeId: string) => {
            const result = canvasActionResults.find((item) => item.nodeId === nodeId);
            const target = canvasActionTargets.find((item) => item.nodeId === nodeId);
            const nodeLabel = target?.label
              ?? submittedNodeLabels[nodeId]
              ?? `节点 ${nodeId.slice(0, 8)}`;
            return <section key={nodeId} aria-label="生成执行进度" data-node-label={nodeLabel} className="creative-plan__progress"><span className="creative-plan__progress-node">{nodeLabel}</span><span>{result?.status === 'completed' && result.assetIds.length > 0 ? '结果已回写' : result?.status === 'completed' ? '结果已生成，但尚未回写画布' : result?.status === 'failed' ? '执行失败' : result?.status === 'cancelled' ? '已取消' : result === undefined && target === undefined ? '节点或结果已不存在' : '生成任务执行中'}</span>
              {result?.assetIds.map((assetId) => {
                const media = allReferenceMedia.find((item) => item.assetId === assetId);
                if (media?.kind === 'video') return <video key={assetId} src={media.displayUrl} controls playsInline aria-label={`${media.label} video`} />;
                if (!media) return null;
                return <div key={assetId} className="creative-plan__result-media">
                  <button type="button" className="creative-plan__result-preview" aria-label={`查看生成结果：${media.label}`} onClick={(event) => { resultImageOpenerRef.current = event.currentTarget; setActiveResultImage(media); setResultImageZoom(1); }}>
                    <img src={media.displayUrl} alt={media.label} />
                  </button>
                  <button type="button" className="creative-plan__result-copy" aria-label={`复制生成图片：${media.label}`} title="复制生成图片" onClick={() => { void copySentImage(media.displayUrl); }}><Copy aria-hidden="true" size={14} /></button>
                </div>;
              })}
            </section>;
          };

  const prepareQuickTask = (text: string) => {
    // Keep explicitly selected images attached when choosing a task template.
    const tokens = composer.citations.flatMap((citation) => {
      const reference = mentionReferences.find((item) => item.assetId === citation.assetId);
      return reference ? [skillChatMentionToken(reference.kind, reference.mentionPosition)] : [];
    });
    setComposer((current) => ({ ...current, text: `${text}${tokens.length ? ` ${tokens.join(' ')}` : ''}` }));
  };
  const filteredMentionReferences = useMemo(() => mentionMenuReferences.filter((reference) => `${reference.label} ${skillChatMentionToken(reference.kind, reference.mentionPosition)}`.toLocaleLowerCase().includes(referenceQuery.trim().toLocaleLowerCase())), [mentionMenuReferences, referenceQuery]);
  const changeAgentMode = (mode: typeof agentMode) => {
    const cancellation = mode !== agentMode && activeLocalCodexRequestId.current !== null
      ? cancelActiveCodexRequest()
      : null;
    if (mode !== agentMode) invalidateActivePlan();
    invalidatePastedReferences();
    if (mode !== agentMode) setError(null);
    setAgentMode(mode);
    dispatchPopover({ type: 'close-external' });
    if (cancellation !== null) finishCodexCancellation(cancellation);
    const profilesForMode = mode === 'codex' ? codexProfiles : chatProfiles;
    if (profilesForMode.length > 0 && !profilesForMode.some((profile) => profile.modelRoute === modelRoute)) {
      setModelRoute(profilesForMode.find((profile) => profile.modelRoute === 'chat-default')?.modelRoute ?? profilesForMode[0]?.modelRoute);
    }
  };

  const showReverseDepth = supportsImageMentions && selectedProfile?.provider !== 'codex' && (composer.citations.length > 0 || status === 'sending');
  const modelPickerPanel = (activePopover === 'model' || activePopover === 'reasoning-model') && (
    <section className="skill-chat-workbench__sheet" data-anchor="reasoning" role="dialog" aria-label="选择聊天模型">
      <header>
        <div><strong>选择聊天模型</strong><p>仅显示已配置的聊天路线。</p></div>
        <button type="button" aria-label="关闭模型选择" onClick={() => dispatchPopover({ type: 'close-external' })}>关闭</button>
      </header>
      <label className="skill-chat-workbench__model-search">
        <span aria-hidden="true">⌕</span>
        <input type="search" aria-label="搜索聊天模型" value={modelQuery} onChange={(event) => setModelQuery(event.target.value)} placeholder="搜索名称或模型 ID" />
      </label>
      <div className="skill-chat-workbench__route-list" role="list">
        {filteredVisibleChatProfiles.map((profile) => {
          const selected = profile.modelRoute === modelRoute;
          return <div key={profile.modelRoute} role="listitem"><button type="button" aria-label={`使用 ${providerModelLabel(profile, chatProfiles)}`} aria-pressed={selected} className={selected ? 'is-selected' : undefined} onClick={() => {
            const cancellation = profile.modelRoute !== modelRoute && activeLocalCodexRequestId.current !== null ? cancelActiveCodexRequest() : null;
            if (profile.modelRoute !== modelRoute) invalidateActivePlan();
            invalidatePastedReferences();
            setModelRoute(profile.modelRoute);
            dispatchPopover({ type: 'close-external' });
            if (cancellation !== null) finishCodexCancellation(cancellation);
          }}><strong>{providerModelLabel(profile, chatProfiles)}</strong><span>{profile.provider === 'codex'
            ? selected ? '当前选择 · 本机 Codex 模型目录' : '本机 Codex · 来自已安装模型目录'
            : selected ? '当前选择' : '选择此模型'}</span></button></div>;
        })}
        {filteredVisibleChatProfiles.length === 0 && <p role="status">{visibleChatProfiles.length === 0
          ? agentMode === 'codex' ? '未发现已配置的 Codex 模型。' : '尚未配置聊天模型。'
          : '没有匹配的模型。'}</p>}
      </div>
    </section>
  );

  return (
    <section
      className="skill-chat-workbench"
      data-transient-popover={activePopover ?? undefined}
      aria-label="Agent 对话工作台"
      onCopy={(event) => event.stopPropagation()}
      onCut={(event) => event.stopPropagation()}
      onPaste={(event) => event.stopPropagation()}
    >
      <header className="skill-chat-workbench__header skill-chat-workbench__header--codex">
        <div>
          <h2>Codex Agent <small>画布接入</small></h2>
          <p><i aria-hidden="true" />{selectedProfile?.provider === 'codex'
            ? '支持 ChatGPT / API Key · 调用时验证'
            : visibleChatProfiles.length > 0 ? '对话就绪' : '等待模型配置'}</p>
        </div>
        <div className="skill-chat-workbench__header-actions">
          {agentWindowControls && <button
            type="button"
            className="skill-chat-workbench__window-drag"
            aria-label="拖动 Agent 窗口"
            title="拖动移动 · 方向键微调位置"
            onPointerDown={agentWindowControls.dragPointerDown}
            onPointerMove={agentWindowControls.dragPointerMove}
            onPointerUp={agentWindowControls.dragPointerEnd}
            onPointerCancel={agentWindowControls.dragPointerEnd}
            onLostPointerCapture={agentWindowControls.dragPointerEnd}
            onKeyDown={agentWindowControls.dragKeyDown}
          ><GripHorizontal size={15} /></button>}
          <select aria-label="Codex 任务" value={activeConversationId} onChange={(event) => activateConversation(event.target.value)}>
            {[...conversationCollection.conversations]
              .sort((left, right) => right.updatedAt - left.updatedAt)
              .map((conversation) => <option key={conversation.id} value={conversation.id}>{conversation.title}</option>)}
          </select>
          <button type="button" aria-label="历史对话" title="历史对话" data-agent-history-trigger aria-expanded={activePopover === 'conversation-history'} onClick={() => dispatchPopover({ type: 'toggle', id: 'conversation-history' })}><History size={15} /></button>
          <button
            className="skill-chat-workbench__new-chat"
            data-testid="agent-new-chat"
            type="button"
            aria-label="新建任务"
            onClick={createConversation}
          ><span aria-hidden="true">+</span><span className="sr-only">新对话</span></button>
          {agentWindowControls && <>
            <button type="button" data-testid="agent-presentation-toggle" aria-label={agentWindowControls.mode === 'docked' ? '切换为浮窗' : '停靠到侧边'} title={agentWindowControls.mode === 'docked' ? '切换为浮窗' : '停靠到侧边'} onClick={agentWindowControls.toggleMode}>{agentWindowControls.mode === 'docked' ? <Maximize2 size={15} /> : <PanelRight size={15} />}</button>
            <button type="button" aria-label={agentWindowControls.minimized ? '展开 Agent' : '最小化 Agent'} title={agentWindowControls.minimized ? '展开' : '最小化'} onClick={agentWindowControls.toggleMinimized}>{agentWindowControls.minimized ? <Maximize2 size={15} /> : <Minus size={15} />}</button>
            <button className="skill-chat-workbench__close" type="button" data-testid="agent-panel-close" aria-label="关闭 Novus Agent" title="关闭" onClick={agentWindowControls.close}><X size={15} /></button>
          </>}
          {!agentWindowControls && onClose && <button className="skill-chat-workbench__close" type="button" aria-label="关闭 Codex Agent" onClick={onClose}><X size={15} /></button>}
        </div>
      </header>

      {activePopover === 'conversation-history' && <section className="agent-history-popover" role="dialog" aria-label="历史对话">
        <header><div className="agent-history-popover__heading"><History size={14} aria-hidden="true" /><strong>历史对话</strong></div><button type="button" aria-label="关闭历史对话" onClick={() => dispatchPopover({ type: 'close-external' })}><X size={14} /></button></header>
        <div className="agent-history-popover__list">
          {[...conversationCollection.conversations].sort((left, right) => right.updatedAt - left.updatedAt).map((conversation) => <button key={conversation.id} type="button" aria-current={conversation.id === activeConversationId ? 'true' : undefined} onClick={() => { activateConversation(conversation.id); dispatchPopover({ type: 'close-external' }); }}><span className="agent-history-popover__item-icon" aria-hidden="true"><History size={13} /></span><span className="agent-history-popover__item-copy"><strong>{conversation.title}</strong><small>{new Date(conversation.updatedAt).toLocaleString()} · {conversation.messages.length} 条消息</small></span><span className="agent-history-popover__item-arrow" aria-hidden="true">↗</span></button>)}
        </div>
      </section>}


      {skillLibraryOpen && (
        <section ref={librarySheetRef} className="skill-chat-workbench__sheet skill-chat-workbench__sheet--library" data-anchor="composer-footer" role="dialog" aria-label="选择知识库">
          <header>
            <div><strong>选择知识库</strong><p>可多选，用于当前任务上下文</p></div>
            <button type="button" aria-label="关闭知识库" onClick={() => dispatchPopover({ type: 'close-external' })}>关闭</button>
          </header>
          <label className="skill-chat-workbench__library-search">
            <span aria-hidden="true">⌕</span>
            <input aria-label="搜索知识库" value={libraryQuery} onChange={(event) => setLibraryQuery(event.target.value)} placeholder="搜索知识库或文件" />
          </label>
          <div className="skill-chat-workbench__library-categories" role="tablist" aria-label="知识库分类">
            {([['common', '常用'], ['favorite', '收藏'], ['mine', '我的']] as const).map(([category, label]) => (
              <button key={category} type="button" role="tab" aria-selected={libraryCategory === category} className={libraryCategory === category ? 'is-active' : undefined} onClick={() => setLibraryCategory(category)}>{label}</button>
            ))}
          </div>
          <span className="skill-chat-workbench__library-count">选择 {selectedKnowledgeBaseIds.length} 个知识库</span>
          <div className="skill-chat-workbench__knowledge-choice-list" data-testid="knowledge-library-toolbar">
            {filteredKnowledge.length === 0 && availableProjectMemoryIds.length === 0 && <p role="status">没有匹配的知识库</p>}
            {filteredKnowledge.map((item) => {
              const available = item.knowledgeBase !== undefined;
              const selected = selectedKnowledgeBaseIds.includes(item.knowledgeBaseId);
              return <button key={item.knowledgeBaseId} type="button" aria-pressed={selected} onClick={() => setSelectedKnowledgeBaseIds((current) => toggleId(current, item.knowledgeBaseId))}>
                <i aria-hidden="true">{selected ? '✓' : ''}</i>
                <span><strong>{item.displayName}</strong><small>{available ? `已同步 · ${item.description}` : `尚未同步 · ${item.description}`}</small></span>
              </button>;
            })}
            {availableProjectMemoryIds.map((memoryId) => {
              const selected = selectedProjectMemoryIds.includes(memoryId);
              return <button key={memoryId} type="button" aria-pressed={selected} onClick={() => setSelectedProjectMemoryIds((current) => toggleId(current, memoryId))}>
                <i aria-hidden="true">{selected ? '✓' : ''}</i><span><strong>项目记忆</strong><small>{memoryId}</small></span>
              </button>;
            })}
          </div>
          <footer>选择后会作为当前任务的上下文。</footer>
        </section>
      )}
      <section className="skill-chat-workbench__context" aria-label="对话上下文" data-node-count={canvasActionTargets.length}>
        <button type="button" aria-expanded={contextExpanded} onClick={() => setContextExpanded((current) => !current)}>
          {contextExpanded ? '收起上下文' : canvasActionTargets.length > 0 ? `展开上下文 · ${canvasActionTargets.length} 个画布节点` : '展开上下文'}
        </button>
        {contextExpanded && (
          <div className="skill-chat-workbench__context-detail">
            <fieldset>
              <legend>知识库</legend>
              {availableKnowledge.length === 0 && <p>没有可选知识库。</p>}
              {availableKnowledge.map((knowledgeBase) => (
                <label key={knowledgeBase.knowledgeBaseId}>
                  <input
                    type="checkbox"
                    checked={selectedKnowledgeBaseIds.includes(knowledgeBase.knowledgeBaseId)}
                    onChange={() => setSelectedKnowledgeBaseIds((current) => toggleId(current, knowledgeBase.knowledgeBaseId))}
                  />
                  <span>{knowledgeBase.knowledgeBaseId}</span>
                </label>
              ))}
            </fieldset>
            <fieldset>
              <legend>项目记忆</legend>
              {availableProjectMemoryIds.length === 0 && <p>没有可选项目记忆。</p>}
              {availableProjectMemoryIds.map((memoryId) => (
                <label key={memoryId}>
                  <input
                    type="checkbox"
                    checked={selectedProjectMemoryIds.includes(memoryId)}
                    onChange={() => setSelectedProjectMemoryIds((current) => toggleId(current, memoryId))}
                  />
                  <span>{memoryId}</span>
                </label>
              ))}
            </fieldset>
            {canvasActionTargets && canvasActionTargets.length > 0 && (
              <fieldset aria-label="画布节点上下文">
                <legend>画布节点</legend>
                {canvasActionTargets.map((target) => (
                  <label key={target.nodeId} className="skill-chat-workbench__node-context">
                    <span><b>{target.label}</b><small>{canvasActionLabel(target.kind)}</small></span>
                    <em>{target.selected ? '当前选择' : '未选择'}</em>
                  </label>
                ))}
              </fieldset>
            )}
          </div>
        )}
      </section>

      <div ref={messagesStreamRef} className="skill-chat-workbench__stream" aria-label="Agent 消息流" tabIndex={0}>
        {activeReverseTimeline.length > 0 && (
          <section className="skill-chat-workbench__reverse-timeline" aria-label="反推上下文事件">
            {activeReverseTimeline.map((entry) => (
              <article key={entry.nodeId} className="skill-chat-workbench__reverse-entry" aria-label={`节点反推结果：${entry.title}`}>
                <span>反推结果已加入上下文</span>
                <div className="skill-chat-workbench__reverse-entry-heading">
                  <strong>{entry.title}</strong>
                  <button
                    type="button"
                    aria-label={expandedReverseIds.includes(entry.nodeId) ? '收起反推内容' : '查看反推内容'}
                    aria-expanded={expandedReverseIds.includes(entry.nodeId)}
                    onClick={() => setExpandedReverseIds((current) => toggleId(current, entry.nodeId))}
                  >
                    {expandedReverseIds.includes(entry.nodeId) ? '收起' : '查看'}
                  </button>
                </div>
                {expandedReverseIds.includes(entry.nodeId) && <p>{entry.positivePrompt}</p>}
              </article>
            ))}
          </section>
        )}
        <section className="skill-chat-workbench__messages" aria-label="对话消息">
          {messages.length === 0 && activeReverseTimeline.length === 0 && (
            <section className="skill-chat-workbench__empty-state" aria-label="Agent conversation empty state">
              {visibleChatProfiles.length === 0 ? (
                <>
                  <strong>请先在设置中配置聊天模型</strong>
                  <p>暂无可用模型。</p>
                </>
              ) : (
                <>
                  <div className="skill-chat-workbench__intro skill-chat-workbench__intro--codex">
                    <span className="canvas-ai-orb skill-chat-workbench__intro-orb" aria-hidden="true"><i /></span>
                    <strong>{agentMode === 'codex' ? 'Codex 画布助手' : agentMode === 'original' ? '创作 Agent' : '开始对话'}</strong>
                  </div>
              {chatProfiles.length > 0 && (
                <div className="skill-chat-workbench__suggestions" aria-label="推荐 Skill" data-expanded={showAllQuickTasks}>
                  <button type="button" aria-label="梳理创作目标" onClick={() => prepareQuickTask('请帮我梳理创作目标、约束条件和下一步方案。')}>
                    <span className="skill-chat-workbench__suggestion-icon">⌁</span>
                    <span><strong>产品分析</strong><small>点击填入任务</small></span>
                  </button>
                  <button type="button" aria-label="生成视觉方向" onClick={() => prepareQuickTask('为当前画布生成一套清晰的视觉方向与构图建议。')}>
                    <span className="skill-chat-workbench__suggestion-icon">✦</span>
                    <span><strong>提示词优化</strong><small>点击填入任务</small></span>
                  </button>
                  <button type="button" aria-label="调用知识库" onClick={() => prepareQuickTask('检查当前项目的知识库上下文，并给出可复用的创作建议。')}>
                    <span className="skill-chat-workbench__suggestion-icon">◌</span>
                    <span><strong>生成方案</strong><small>点击填入任务</small></span>
                  </button>
                  <button type="button" aria-label="反推参考图" onClick={() => prepareQuickTask('根据当前参考图反推一版可编辑的提示词。')}>
                    <span className="skill-chat-workbench__suggestion-icon">◈</span>
                    <span><strong>知识库检索</strong><small>点击填入任务</small></span>
                  </button>
                  <button type="button" aria-label="原创剧本与故事改编" onClick={() => prepareQuickTask('请根据我提供的故事或主题设计原创剧本。先确认受众、时长与人物，再给出可选择的叙事方案；保留我指定的角色与情节。')}><span className="skill-chat-workbench__suggestion-icon">✎</span><span><strong>原创剧本与故事改编</strong></span></button>
                  <button type="button" aria-label="批量优化提示词" onClick={() => prepareQuickTask('请逐条优化我提供的提示词，按原编号返回优化前后对照，统一角色、场景与风格，保留产品结构和明确约束。先给方案，不直接生成。')}><span className="skill-chat-workbench__suggestion-icon">≡</span><span><strong>批量优化提示词</strong></span></button>
                  <button type="button" aria-label="一句话生成分镜" onClick={() => prepareQuickTask('把我的一句话创意扩展为可执行分镜，逐镜列出时长、景别、机位、运镜、主体动作、衔接及生成提示词。先确认总时长和风格，再提供方案供我选择。')}><span className="skill-chat-workbench__suggestion-icon">▤</span><span><strong>一句话生成分镜</strong></span></button>
                  <button
                    type="button"
                    className="skill-chat-workbench__suggestions-more"
                    data-testid="agent-more-suggestions"
                    aria-expanded={showAllQuickTasks}
                    onClick={() => setShowAllQuickTasks((current) => !current)}
                  >{showAllQuickTasks ? '收起模板' : '更多创作模板'}</button>
                </div>
              )}
                </>
              )}
            </section>
          )}
          {messageDetails.map(({
            message, precedingMessage, messageMode, requestedGenerationKind, creativePlan,
            reverseWorkflowOffer, requestedWorkflowOffer, workflowReferences, reverseAnalysis, workflowSummary,
          }) => {
            const workflowOffer = message.role === 'assistant'
              && precedingMessage?.role === 'user'
              && (reverseWorkflowOffer || requestedWorkflowOffer)
              && !dismissedWorkflowOfferIds.includes(message.id);
            const canvasResultNodeId = message.id.startsWith('canvas-result:')
              ? message.id.slice('canvas-result:'.length)
              : null;
            const canvasResultOrphaned = canvasResultNodeId !== null
              && !canvasActionTargets.some((target) => target.nodeId === canvasResultNodeId)
              && !canvasActionResults.some((result) => result.nodeId === canvasResultNodeId);
            return (
            <article key={message.id} className={`skill-chat-workbench__message skill-chat-workbench__message--${message.role}${creativePlan ? ' skill-chat-workbench__message--creative-plan' : ''}`}>
              <span>{message.role === 'user' ? '你的请求' : 'Agent 建议'}</span>
              {message.request?.reverseAnalysisDepth && <small aria-label="本次反推强度">{message.request.reverseAnalysisDepth === 'fast' ? '快速反推' : message.request.reverseAnalysisDepth === 'deep' ? '深度反推' : '标准反推'}</small>}
              <p>{canvasResultOrphaned ? '关联节点或结果已不存在。' : creativePlan?.summary ?? workflowSummary ?? message.content}</p>
              {submittedNodeIds.filter((nodeId) => message.id === `canvas-result:${nodeId}`).map(renderSubmittedResult)}
              {creativePlan && <section className="creative-plan" aria-label="创作方案">
                <section className="creative-plan__requirements" aria-label="需求分析">
                  <header><strong>需求分析</strong><span>已拆解为执行约束</span></header>
                  <dl>
                    <div><dt>目标</dt><dd>{creativePlan.requirements.goal}</dd></div>
                    {creativePlan.requirements.mustKeep.length > 0 && <div><dt>必须保留</dt><dd>{creativePlan.requirements.mustKeep.join('\n')}</dd></div>}
                    {creativePlan.requirements.mustChange.length > 0 && <div><dt>需要修改</dt><dd>{creativePlan.requirements.mustChange.join('\n')}</dd></div>}
                    {creativePlan.requirements.mustAvoid.length > 0 && <div><dt>禁止事项</dt><dd>{creativePlan.requirements.mustAvoid.join('\n')}</dd></div>}
                    {creativePlan.requirements.acceptanceCriteria.length > 0 && <div><dt>验收标准</dt><dd>{creativePlan.requirements.acceptanceCriteria.join('\n')}</dd></div>}
                  </dl>
                </section>
                {([['观察', creativePlan.observations], ['估计', creativePlan.estimates], ['未知', creativePlan.unknowns]] as const).map(([label, items]) => items.length > 0 ? <div key={label}><strong>{label}</strong><p>{items.join('\n')}</p></div> : null)}
                {creativePlan.options.map((option) => {
                  const optionKey = `${message.id}:${option.id}`;
                  const selected = selectedCreativeOptionKey === optionKey;
                  const workflowSteps = creativeWorkflowSteps(option, precedingMessage?.request?.references.length ?? 0);
                  return <div key={option.id} className="creative-plan__option"><span className="creative-plan__kind">{option.kind === 'image' ? '图片工作流' : '视频工作流'}</span><strong>{option.title}</strong><p>{option.reason}</p>
                    <section className="creative-plan__workflow" aria-label={`工作流预览：${option.title}`}><b>工作流预览</b><ol>{workflowSteps.map((step, index) => <li key={`${step.title}-${index}`}><span>{index + 1}</span><div><strong>{step.title}</strong><p>{step.detail}</p></div></li>)}</ol></section>
                    <details><summary>查看完整执行提示词</summary><p>{option.prompt}</p></details>
                    {messageMode !== 'chat' && <button type="button" className={`creative-plan__select${selected ? ' is-selected' : ''}`} aria-label={`选择方案：${option.title}`} aria-pressed={selected} disabled={canvasActionRunning || status === 'sending'} onClick={() => chooseCreativeOption(message.id, option, precedingMessage?.request?.references ?? [], precedingMessage?.content)}>{selected ? '✓ 已选择' : '选择此方案'}</button>}
                  </div>;
                })}
                {creativePlan.options.length === 0 && requestedGenerationKind !== undefined && (
                  <p className="skill-chat-workbench__error" role="alert">本次已选择{requestedGenerationKind === 'image' ? '图片' : '视频'}工作流，但模型没有返回对应方案。请打开生成偏好切换输出类型，或配置支持当前参考素材的{requestedGenerationKind === 'image' ? '图片' : '视频'}模型后重试。</p>
                )}
              </section>}
              {message.role === 'user' && message.request?.references.length ? (
                <section className="skill-chat-workbench__sent-references" aria-label="已发送素材">
                  {message.request.references.map((reference, referenceIndex) => {
                    const media = allReferenceMedia.find((candidate) => candidate.assetId === reference.assetId);
                    const mentionReference = mentionReferences.find((candidate) => candidate.assetId === reference.assetId);
                    const mentionToken = mentionReference === undefined
                      ? `@${media?.kind === 'video' ? '视频' : '图片'}${referenceIndex + 1}`
                      : skillChatMentionToken(mentionReference.kind, mentionReference.mentionPosition);
                    return (
                      <div key={`${reference.assetId}-${referenceIndex}`} className="skill-chat-workbench__sent-reference">
                        {media?.kind === 'video'
                          ? <video src={media.displayUrl} aria-label={`${reference.label} video`} muted playsInline preload="metadata" />
                          : media && <img src={media.displayUrl} alt={reference.label} />}
                        <span><b>{reference.label}</b><small>{mentionToken}</small></span>
                        {media?.kind === 'image' && (
                          <button
                            type="button"
                            className="skill-chat-workbench__sent-reference-copy"
                            aria-label={`复制图片：${reference.label}`}
                            title="复制图片"
                            onClick={() => { void copySentImage(media.displayUrl); }}
                          ><Copy aria-hidden="true" size={13} /></button>
                        )}
                      </div>
                    );
                  })}
                </section>
              ) : null}
              {message.sources && message.sources.length > 0 && (
                <section className="skill-chat-workbench__sources" aria-label="来源">
                  {message.sources.map((source) => (
                    <small key={`${source.knowledgeBaseId}@${source.version}`}>来源 · {source.displayName ?? source.knowledgeBaseId} v{source.version}</small>
                  ))}
                </section>
              )}
              {workflowOffer && !creativePlan && (
                <section className="skill-chat-workbench__workflow-offer" aria-label={reverseWorkflowOffer ? '反推工作流建议' : 'Codex 工作流建议'}>
                  <strong>{reverseWorkflowOffer ? '是否基于本次反推生成工作流？' : '是否基于本次方案生成工作流？'}</strong>
                  <p>会先生成可预览方案；创建节点、连线和运行仍需你再次确认。</p>
                  {reverseAnalysis && (
                    <section className="skill-chat-workbench__reverse-structure" data-testid="reverse-structure-summary" aria-label="结构化反推摘要">
                      <header><strong>结构化反推</strong><span>{reverseAnalysis.runnable ? '可生成提案' : '需要补充'}</span></header>
                      <div className="skill-chat-workbench__reverse-structure-grid">
                        <span>主体</span><b>{reverseAnalysis.visual.subject || '未识别'}</b>
                        <span>构图</span><b>{reverseAnalysis.visual.composition || '未识别'}</b>
                        <span>中文提示词</span><b>{reverseAnalysis.prompts.zh || '未返回'}</b>
                      </div>
                      {!reverseAnalysis.runnable && <small>缺少：{reverseAnalysis.missing.slice(0, 4).join('、')}</small>}
                      {reverseAnalysis.variants.length > 0 && (
                        <div className="skill-chat-workbench__reverse-variant-list" data-testid="reverse-variant-list" aria-label="反推工作流变体">
                          {reverseAnalysis.variants.map((variant) => (
                            <span key={variant.id}><b>{variant.name === 'faithful' ? '忠实' : variant.name === 'balanced' ? '平衡' : '探索'}</b>{variant.change}</span>
                          ))}
                        </div>
                      )}
                    </section>
                  )}
                  <div>
                    <button type="button" onClick={() => {
                      let generation: SkillWorkflowDraftRequest['generation'];
                      try {
                        const kind = generationPreferences.kind;
                        const { profile, parameters } = resolveGenerationPreference(kind, generationPreferences, profiles, undefined, workflowReferences.length);
                        const prompt = reverseWorkflowOffer
                          ? reverseAnalysis?.prompts.zh.trim() ?? ''
                          : parseWorkflowGenerationPrompt(message.content);
                        if (prompt.length === 0 || (reverseWorkflowOffer && reverseAnalysis?.runnable !== true)) {
                          setError(reverseWorkflowOffer ? '本次反推没有返回可执行的生图提示词，请重新反推后再生成工作流。' : '本次方案没有返回可执行的生图提示词，请重新分析后再生成工作流。');
                          return;
                        }
                        const promptQuality = assessCreativeGenerationPrompt(prompt, precedingMessage.content);
                        if (!promptQuality.valid && promptQuality.reason === 'contains-mention') {
                          setError('Agent 返回的生图提示词仍包含 @图片 或 @视频标记，请重新分析后再生成工作流。');
                          return;
                        }
                        if (!promptQuality.valid && promptQuality.reason === 'copied') {
                          setError('Agent 没有把需求改写成生图提示词，请重新分析后再生成工作流。');
                          return;
                        }
                        if (!promptQuality.valid) {
                          setError('Agent 返回的生图提示词过于简略，需补充主体、构图、光线、材质、保留项和禁止项后再生成工作流。');
                          return;
                        }
                        generation = { kind, prompt, modelRoute: profile.modelRoute, modelRouteDisplayName: profile.displayName, parameters };
                      } catch (error) { setError(error instanceof Error ? error.message : '请配置生成模型'); return; }
                      draftWorkflowFromAnalysis?.({
                        generation,
                        analysis: message.content,
                        ...(reverseAnalysis?.runnable ? { reverseAnalysis } : {}),
                        references: workflowReferences,
                        modelRoute: precedingMessage.request?.modelRoute,
                        modelRouteDisplayName: precedingMessage.request?.modelDisplayName,
                        ...(precedingMessage.request?.knowledgeBaseIds && precedingMessage.request.knowledgeBaseIds.length > 0
                          ? { knowledgeBaseIds: precedingMessage.request.knowledgeBaseIds }
                          : {}),
                      });
                      setDismissedWorkflowOfferIds((current) => [...current, message.id]);
                    }}>生成工作流</button>
                    <button type="button" onClick={() => {
                      setComposer({
                        text: '请继续调整本次反推结果：',
                        citations: workflowReferences.map(({ assetId, label }) => ({ assetId, label })),
                      });
                      setDismissedWorkflowOfferIds((current) => [...current, message.id]);
                    }}>继续调整</button>
                    <button type="button" onClick={() => setDismissedWorkflowOfferIds((current) => [...current, message.id])}>暂不生成</button>
                  </div>
                </section>
              )}
            </article>
            );
          })}
          {pendingCanvasAction && agentMode !== 'chat' && (
            <article ref={confirmationCardRef} className="skill-chat-workbench__message skill-chat-workbench__message--assistant skill-chat-workbench__confirmation" aria-label="待确认画布操作">
              <span>等待确认</span>
              <p>{pendingCanvasAction.createWorkflow
                ? `${pendingCanvasAction.referenceAssetIds?.length ? `将使用${pendingCanvasAction.referenceAssetIds.length}个参考素材连接` : '将创建'}1个${canvasActionLabel(pendingCanvasAction.kind)}节点；提示词与结果保留在生成节点内，并执行已确认方案。`
                : pendingCanvasAction.createNode ? `将新建独立节点并执行${canvasActionLabel(pendingCanvasAction.kind)}` : `将在节点 ${pendingCanvasAction.nodeId} 执行${canvasActionLabel(pendingCanvasAction.kind)}`}。</p>
              <details><summary>查看执行提示词与参数</summary><p>{pendingCanvasAction.prompt}</p><p>{Object.entries(pendingCanvasAction.parameters ?? {}).map(([key, value]) => `${key}: ${value}`).join(' · ') || '使用模型默认参数'}</p></details>
              {pendingCanvasActionProfiles.length > 0 && (
                <div className="skill-chat-workbench__action-controls">
                  <label className="skill-chat-workbench__action-model">使用模型
                    <select aria-label={`选择${canvasActionLabel(pendingCanvasAction.kind)}模型`} disabled={pendingCanvasModelLocked} value={pendingCanvasVisibleSelection?.modelRoute ?? pendingCanvasModelRoute ?? ''} onChange={(event) => {
                      const modelRoute = event.target.value;
                      setPendingCanvasModelRoute(modelRoute);
                      const profile = pendingCanvasActionProfiles.find((candidate) => candidate.modelRoute === modelRoute);
                      const resolutions = pendingCanvasAction.kind === 'video_generation'
                        ? profile?.constraints?.video?.resolutions
                        : listImageResolutionTiers(pendingCanvasActionProfiles, profile);
                      setPendingCanvasResolution((current) => resolutions?.includes(current as never) ? current : '');
                    }}>
                      {pendingCanvasVisibleProfiles.map((profile) => <option key={profile.modelRoute} value={profile.modelRoute}>{pendingCanvasAction.kind === 'image_generation' ? imageModelFamilyDisplayName(profile) : profile.displayName}</option>)}
                    </select>
                  </label>
                  {pendingCanvasAction.kind !== 'reverse_agent' && pendingCanvasResolutionOptions.length > 0 && (
                    <label className="skill-chat-workbench__action-model">清晰度
                      <select aria-label={`选择${canvasActionLabel(pendingCanvasAction.kind)}清晰度`} value={pendingCanvasResolution} onChange={(event) => setPendingCanvasResolution(event.target.value)}>
                        <option value="">模型默认</option>
                        {pendingCanvasResolutionOptions.map((resolution) => <option key={resolution} value={resolution}>{resolution}</option>)}
                      </select>
                    </label>
                  )}
                </div>
              )}
              {pendingCanvasActionNeedsReferences && pendingCanvasPreference?.mode === 'fixed' && !pendingCanvasFixedRouteIsCompatible && pendingCanvasActionProfiles.length > 0 && (
                <p className="skill-chat-workbench__status" role="status">固定模型不支持参考素材，已自动切换到兼容路线；你可以在这里选择其他兼容模型。</p>
              )}
              {pendingCanvasActionProfiles.length === 0 && pendingCanvasActionNeedsReferences && (
                <p className="skill-chat-workbench__error" role="alert">当前参考素材没有可用的兼容生成模型，请先在生成偏好中配置兼容模型。</p>
              )}
              <section className="skill-chat-workbench__request-card skill-chat-workbench__confirmation-card is-sending">
                <header><strong>画布操作</strong><span>待确认</span></header>
                <div className="skill-chat-workbench__confirmation-actions">
                  <button type="button" className="is-primary" aria-label={`确认执行${canvasActionLabel(pendingCanvasAction.kind)}`} disabled={canvasActionRunning || pendingCanvasActionProfiles.length === 0} onClick={() => void confirmCanvasAction()}>{canvasActionRunning ? '正在创建…' : pendingCanvasAction.createWorkflow ? '确认并创建工作流' : '确认并新建节点'}</button>
                  <button type="button" className="is-secondary" aria-label="取消画布操作" disabled={canvasActionRunning} onClick={() => { setPendingCanvasAction(null); setSelectedCreativeOptionKey(null); }}>取消</button>
                </div>
              </section>
            </article>
          )}
          {status === 'sending' && (
            <article className="skill-chat-workbench__message skill-chat-workbench__message--assistant skill-chat-workbench__message--thinking" aria-label="Agent 正在分析">
              <span>Agent</span>
              <div className="skill-chat-workbench__status" role="status">
                <i aria-hidden="true" />
                <span>{agentMode === 'codex' && selectedProfile?.provider === 'codex'
                  ? `${selectedProfile.displayName} · ${REASONING_EFFORT_LABELS[reasoningEffort]} 正在分析，已等待 ${analysisElapsedSeconds} 秒`
                  : '正在分析需求…'}</span>
                {agentMode === 'codex' && selectedProfile?.provider === 'codex' && codexAnalysisDelayHint(reasoningEffort, analysisElapsedSeconds) !== null && (
                  <small className="skill-chat-workbench__thinking-hint">{codexAnalysisDelayHint(reasoningEffort, analysisElapsedSeconds)}</small>
                )}
                {agentMode === 'codex' && selectedProfile?.provider === 'codex' && activeLocalCodexRequestId.current !== null && (
                  <button type="button" className="skill-chat-workbench__thinking-stop" aria-label="停止 Codex 分析" onClick={() => {
                    const cancelledMessageIds = new Set(messages.filter((message) => message.mode === 'codex' && message.request?.status === 'sending').map((message) => message.id));
                    finishCodexCancellation(cancelActiveCodexRequest(), () => {
                      setMessages((current) => current.map((message) => cancelledMessageIds.has(message.id) && message.request?.status === 'sending'
                        ? { ...message, request: { ...message.request, status: 'error' as const } }
                        : message));
                    });
                  }}>停止</button>
                )}
              </div>
            </article>
          )}
        </section>
        {sentImageCopyFeedback !== null && (
          <p
            className={sentImageCopyFeedback === 'success' ? 'skill-chat-workbench__status' : 'skill-chat-workbench__error'}
            role={sentImageCopyFeedback === 'success' ? 'status' : 'alert'}
          >{sentImageCopyFeedback === 'success'
            ? '图片已复制'
            : sentImageCopyFeedback === 'source-error'
              ? '图片素材暂时无法读取，请重新打开项目后重试'
              : '无法复制图片，请检查系统剪贴板权限'}</p>
        )}
        {activeResultImage !== null && createPortal(
          <div
            className="skill-chat-workbench__image-lightbox"
            role="dialog"
            aria-modal="true"
            aria-label={`生成结果预览：${activeResultImage.label}`}
            onClick={() => setActiveResultImage(null)}
          >
            <div ref={resultImagePanelRef} className="skill-chat-workbench__image-lightbox-panel" onClick={(event) => event.stopPropagation()}>
              <header>
                <strong>{activeResultImage.label}</strong>
                <button ref={resultImageCloseRef} type="button" aria-label="关闭图片预览" title="关闭图片预览" onClick={() => setActiveResultImage(null)}><X aria-hidden="true" size={16} /></button>
              </header>
              <div className="skill-chat-workbench__image-lightbox-canvas">
                <img src={activeResultImage.displayUrl} alt={activeResultImage.label} style={{ transform: `scale(${resultImageZoom})` }} />
              </div>
              <footer>
                <button type="button" aria-label="缩小预览" disabled={resultImageZoom <= 1} onClick={() => setResultImageZoom((current) => Math.max(1, Number((current - 0.25).toFixed(2))))}>缩小</button>
                <span>{Math.round(resultImageZoom * 100)}%</span>
                <button type="button" aria-label="放大预览" disabled={resultImageZoom >= 3} onClick={() => setResultImageZoom((current) => Math.min(3, Number((current + 0.25).toFixed(2))))}>放大</button>
                <button type="button" aria-label={`复制生成图片：${activeResultImage.label}`} onClick={() => { void copySentImage(activeResultImage.displayUrl); }}><Copy aria-hidden="true" size={14} />复制</button>
              </footer>
            </div>
          </div>, document.body
        )}
        {error && <p className="skill-chat-workbench__error" role="alert">{error}</p>}
      </div>

      <form ref={composerFormRef} className="skill-chat-workbench__composer" onSubmit={(event) => { event.preventDefault(); void send(); }}>
        <label>
          <span className="sr-only">向 Agent 发送消息</span>
          <MediaMentionTextarea
            data-testid="agent-composer-input"
            data-mention-context="agent"
            aria-label="向 Agent 发送消息"
            value={composer.text}
            mentions={mentionPreviews}
            onCanonicalSelectionChange={(selection) => { composerSelectionRef.current = selection; }}
            rows={3}
            placeholder={agentMode === 'codex' ? '告诉 Codex 要在当前画布上完成什么' : '描述你的需求'}
            onChange={(event) => updateComposerText(event.target.value)}
            onPaste={handleComposerPaste}
            onKeyDown={(event) => {
              if (mentionOpen && event.key === 'ArrowDown' && !event.nativeEvent.isComposing) {
                event.preventDefault();
                referenceMenuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
                return;
              }
              if (mentionOpen && event.key === 'Enter') { event.preventDefault(); return; }
              if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
              event.preventDefault();
              void send();
            }}
          />
        </label>
        {composer.citations.length > 0 && (
          <div className="skill-chat-workbench__image-tags" aria-label="Selected image references" data-visual-hidden="true">
            {composer.citations.map((citation, citationIndex) => {
              const media = allReferenceMedia.find((reference) => reference.assetId === citation.assetId);
              const reference = mentionReferences.find((candidate) => candidate.assetId === citation.assetId);
              if (reference === undefined) return null;
              return <button key={citation.assetId} type="button" tabIndex={-1} aria-label={`Remove ${citation.label} media reference`} onClick={() => toggleImageMention(reference)}>
                <small className="skill-chat-workbench__media-slot-index" aria-label={`Media reference slot ${citationIndex + 1}`}>{citationIndex + 1}</small>
                {media?.kind === 'video'
                  ? <video src={media.displayUrl} aria-label={`${citation.label} video thumbnail`} muted playsInline preload="metadata" />
                  : media && <img src={media.displayUrl} alt={citation.label} />}
                <span><b>{citation.label}</b><small>{skillChatMentionToken(reference.kind, reference.mentionPosition)}</small></span>
              </button>;
            })}
          </div>
        )}
        <div className="skill-chat-workbench__composer-footer" data-agent-mode={agentMode}>
          {mentionOpen && (
            <div ref={referenceMenuRef} role="menu" aria-label="Reference images" className="skill-chat-workbench__mention-menu" onKeyDown={(event) => {
              if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
              event.preventDefault();
              const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
              if (!items.length) return;
              const index = items.indexOf(document.activeElement as HTMLButtonElement);
              items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
            }}>
              <header><strong>@ 图片引用</strong><span>{filteredMentionReferences.length}</span></header>
              <input className="agent-reference-search" aria-label="搜索引用图片" placeholder="搜索图片名称或编号" value={referenceQuery} onChange={(event) => setReferenceQuery(event.target.value)} />
              {!browseProjectImages && <button type="button" onClick={() => {
                extendReferenceCatalog(allReferenceImages.map((image) => image.assetId));
                setBrowseProjectImages(true);
              }}>浏览项目图片</button>}
              {mentionMenuReferences.length === 0 && <p>粘贴图片或点击 + 添加本次素材。</p>}
              {referenceQuery && filteredMentionReferences.length === 0 && <p>没有找到匹配的图片。</p>}
              {filteredMentionReferences.map((reference) => (
                <button key={reference.assetId} type="button" role="menuitem" aria-label={`Mention ${reference.label}`} onClick={() => {
                  if (browseProjectImages) extendReferenceCatalog(allReferenceImages.map((image) => image.assetId));
                  toggleImageMention(reference);
                  dispatchPopover({ type: 'close-external' });
                }}>
                  {allReferenceMedia.find((media) => media.assetId === reference.assetId)?.kind === 'video'
                    ? <video src={reference.displayUrl} aria-label={`${reference.label} video thumbnail`} muted playsInline preload="metadata" />
                    : <img src={reference.displayUrl} alt={reference.label} loading="lazy" />}
                  <span><b>{reference.label}</b><small>项目受管素材 · {skillChatMentionToken(reference.kind, reference.mentionPosition)}</small></span>
                </button>
              ))}
            </div>
          )}
          <input ref={referenceFileInput} className="sr-only" data-testid="agent-reference-file-input" type="file" accept="image/*" tabIndex={-1} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void importReferenceFile(file); }} />
          <button type="button" className="skill-chat-workbench__tool" aria-label="添加素材" title="导入项目图片" disabled={onImportReferenceImage === undefined || referenceImporting} onClick={requestReferenceImport}><Plus size={14} strokeWidth={1.6} /></button>
          <label className="skill-chat-workbench__mode-picker">
            <select aria-label="Agent 模式" value={agentMode} onChange={(event) => changeAgentMode(event.currentTarget.value as typeof agentMode)}>
              <option value="chat">对话</option>
              <option value="original">创作</option>
              <option value="codex">Codex</option>
            </select>
          </label>
          <div className="skill-chat-workbench__model-reasoning" role="group" aria-label="模型与思考强度">
            <button type="button" className="skill-chat-workbench__model-pill" data-testid="agent-model-trigger" aria-label="打开聊天模型菜单" data-selected-model={selectedProfile?.displayName ?? '未配置'} onClick={() => dispatchPopover({
              type: 'open',
              id: 'reasoning-model',
            })}>{selectedProfile ? providerModelLabel(selectedProfile, chatProfiles) : agentMode === 'codex' ? '未发现 Codex 模型' : '选择模型'}</button>
            <CodexReasoningPopover
              hideTrigger={!(selectedProfile?.provider === 'codex' || selectedProfile?.reasoning !== undefined || showReverseDepth)}
              modelLabel={selectedProfile?.displayName ?? '未选择模型'} efforts={supportedEfforts} value={reasoningEffort}
              defaultValue={selectedProfile?.provider === 'codex' ? selectedProfile.defaultReasoningEffort : selectedProfile?.reasoning?.defaultEffort}
              disabled={!selectedProfile} open={activePopover === 'reasoning' || activePopover === 'reasoning-model'} onChange={setReasoningEffort}
              onToggle={() => dispatchPopover({ type: 'toggle', id: 'reasoning-model' })}
              onClose={() => dispatchPopover({ type: 'close-external' })}
              onSelectModel={() => dispatchPopover({ type: 'open', id: 'reasoning-model' })}
              modelPicker={activePopover === 'reasoning-model' ? modelPickerPanel : undefined}
              generationKind={generationPreferences.kind}
              onOpenGeneration={() => dispatchPopover({ type: 'open', id: 'generation' })}
              reverseDepth={showReverseDepth ? { value: reverseAnalysisDepth, disabled: status === 'sending', onChange: setReverseAnalysisDepth } : undefined}
            />
          </div>
          <div className="skill-chat-workbench__composer-actions">
            {selectedProfile?.provider !== 'codex' && <button type="button" className="skill-chat-workbench__generation-trigger" data-testid="agent-generation-preferences" aria-label="生成偏好" title={`当前：${generationPreferences.kind === 'image' ? '图片' : '视频'}工作流；点击选择输出类型和生成模型`} onClick={() => dispatchPopover({ type: 'open', id: 'generation' })}><SlidersHorizontal size={15} /><span>{generationPreferences.kind === 'image' ? '图片工作流' : '视频工作流'}</span></button>}
            <button type="button" className="skill-chat-workbench__tool skill-chat-workbench__knowledge-compact" data-testid="knowledge-base-trigger" aria-label="打开知识库" onClick={() => dispatchPopover({ type: 'open', id: 'knowledge' })}><Grid3X3 size={14} strokeWidth={1.6} /></button>
            <button type="button" className="skill-chat-workbench__tool" aria-label="新建对话" onClick={createConversation}><RotateCcw size={14} strokeWidth={1.6} /></button>
            <button type="submit" className="skill-chat-workbench__send" aria-label="发送" title="发送" disabled={!hasSendablePasteText(draft, pendingPasteMarkers.current) || selectedProfile === undefined || !hasSupportedReasoningEffort || status === 'sending'}><ArrowUp size={17} /></button>
          </div>
          {activePopover === 'generation' && <GenerationPreferencesSheet value={generationPreferences} profiles={profiles} onChange={changeGenerationPreferences} onClose={() => dispatchPopover({ type: 'close-external' })} />}
        </div>
      </form>
    </section>
  );
});

export type ClipboardPasteAction = 'native-text' | 'controlled-text' | 'reject-media' | 'import-media' | 'ignore';

export function resolveClipboardPasteAction(input: {
  readonly hasPlainText: boolean;
  readonly parsedText: string;
  readonly hasMedia: boolean;
  readonly supportsMedia: boolean;
}): ClipboardPasteAction {
  if (!input.hasMedia) return input.hasPlainText ? 'native-text' : input.parsedText.length > 0 ? 'controlled-text' : 'ignore';
  return input.supportsMedia ? 'import-media' : 'reject-media';
}

function canonicalMentionReferences(references: {
  readonly images: readonly SkillChatReferenceImage[];
  readonly videos: readonly SkillChatReferenceVideo[];
}, catalog: readonly ConversationReferenceCatalogEntry[]): SkillChatMentionReference[] {
  const imagesByAssetId = new Map(references.images.map((image) => [image.assetId, image]));
  return [...catalog]
    .sort((left, right) => left.mentionPosition - right.mentionPosition)
    .flatMap((entry) => {
      const media = imagesByAssetId.get(entry.assetId);
      if (media === undefined) return [];
      return [{
        ...media,
        position: entry.mentionPosition,
        mentionPosition: entry.mentionPosition,
        kind: 'image' as const,
        role: 'product_identity' as const,
      }];
    });
}

function createConversationReferenceCatalog(
  messages: readonly SkillMessage[],
  referenceImages: readonly SkillChatReferenceImage[],
): ConversationReferenceCatalogEntry[] {
  const catalog: ConversationReferenceCatalogEntry[] = [];
  const usedAssetIds = new Set<string>();
  const usedPositions = new Set<number>();
  const projectPositionByAssetId = new Map(referenceImages.map((image, index) => [image.assetId, index]));
  for (const message of messages) {
    const references = message.request?.references ?? [];
    const mentionedPositions = Array.from(message.content.matchAll(/@图片(\d+)(?!\d)/gu))
      .map((match) => Number(match[1]) - 1)
      .filter((position) => Number.isSafeInteger(position) && position >= 0);
    references.forEach((reference, index) => {
      if (usedAssetIds.has(reference.assetId)) return;
      const fromMessage = mentionedPositions[index];
      const fromProject = projectPositionByAssetId.get(reference.assetId);
      const preferred = fromMessage !== undefined && !usedPositions.has(fromMessage)
        ? fromMessage
        : fromProject !== undefined && !usedPositions.has(fromProject)
          ? fromProject
          : nextConversationReferencePosition(usedPositions);
      catalog.push({ assetId: reference.assetId, mentionPosition: preferred });
      usedAssetIds.add(reference.assetId);
      usedPositions.add(preferred);
    });
  }
  return catalog.sort((left, right) => left.mentionPosition - right.mentionPosition);
}

function appendConversationReferenceCatalog(
  current: readonly ConversationReferenceCatalogEntry[],
  assetIds: readonly string[],
): ConversationReferenceCatalogEntry[] {
  const entries = [...current];
  const usedAssetIds = new Set(entries.map((entry) => entry.assetId));
  const usedPositions = new Set(entries.map((entry) => entry.mentionPosition));
  let changed = false;
  for (const assetId of assetIds) {
    if (!assetId || usedAssetIds.has(assetId)) continue;
    const mentionPosition = nextConversationReferencePosition(usedPositions);
    entries.push({ assetId, mentionPosition });
    usedAssetIds.add(assetId);
    usedPositions.add(mentionPosition);
    changed = true;
  }
  return changed
    ? entries.sort((left, right) => left.mentionPosition - right.mentionPosition)
    : current as ConversationReferenceCatalogEntry[];
}

function nextConversationReferencePosition(usedPositions: ReadonlySet<number>): number {
  let position = 0;
  while (usedPositions.has(position)) position += 1;
  return position;
}

function skillChatMentionToken(kind: 'image' | 'video', position: number): string {
  if (position < 0) return '';
  return pasteMentionToken({ kind, mentionPosition: position });
}

function insertComposerText(text: string, inserted: string, start: number, end: number): string {
  const selectionStart = Math.max(0, Math.min(start, text.length));
  const selectionEnd = Math.max(selectionStart, Math.min(end, text.length));
  return `${text.slice(0, selectionStart)}${inserted}${text.slice(selectionEnd)}`;
}

const CHAT_MENTION_CANDIDATE_PATTERN = /@[^\s@，。！？；：、（）【】《》“”‘’「」『』]*/gu;

function normalizeChatMentionSelection(
  selection: MediaMentionSelection | null,
  textLength: number,
): MediaMentionSelection {
  if (selection === null) return { start: textLength, end: textLength };
  const start = Math.max(0, Math.min(selection.start, textLength));
  const end = Math.max(0, Math.min(selection.end, textLength));
  return start <= end ? { start, end } : { start: end, end: start };
}

function replaceChatMentionAtSelection(
  text: string,
  mentionToken: string,
  references: readonly SkillChatMentionReference[],
  selection: MediaMentionSelection | null,
): { readonly text: string; readonly caretOffset: number } {
  const knownTokens = new Set(references.map((reference) => skillChatMentionToken(reference.kind, reference.mentionPosition)));
  const candidates = Array.from(text.matchAll(CHAT_MENTION_CANDIDATE_PATTERN))
    .filter((match) => ![...knownTokens].some((knownToken) => (match[0] ?? '').startsWith(knownToken)));
  const normalizedSelection = normalizeChatMentionSelection(selection, text.length);
  const selectedMatch = candidates.find((match) => {
    if (match.index === undefined) return false;
    const start = match.index;
    const end = start + (match[0]?.length ?? 0);
    return normalizedSelection.start >= start && normalizedSelection.start <= end
      && normalizedSelection.end >= start && normalizedSelection.end <= end;
  });
  const match = selectedMatch ?? candidates[candidates.length - 1];
  if (match === undefined || match.index === undefined) {
    const trimmed = text.trimEnd();
    const nextText = `${trimmed}${trimmed.length > 0 ? ' ' : ''}${mentionToken}`;
    return { text: nextText, caretOffset: nextText.length };
  }
  const start = match.index;
  const candidateEnd = start + match[0].length;
  const end = selectedMatch === undefined ? candidateEnd : Math.max(start + 1, normalizedSelection.end);
  return {
    text: `${text.slice(0, start)}${mentionToken}${text.slice(end)}`,
    caretOffset: start + mentionToken.length,
  };
}

function createPasteInsertionMarker(sequence: number): string {
  const encoded = sequence.toString(2).replace(/0/gu, '\u200B').replace(/1/gu, '\u200C');
  return `\u2063\u2064${encoded}\u2064\u2063`;
}

function readComposerSelection(editor: EventTarget & HTMLTextAreaElement, fallback: number): { readonly start: number; readonly end: number } {
  if (typeof editor.selectionStart === 'number' && typeof editor.selectionEnd === 'number') {
    return { start: editor.selectionStart, end: editor.selectionEnd };
  }
  if (!(editor instanceof HTMLElement)) return { start: fallback, end: fallback };
  const selection = globalThis.getSelection();
  if (selection === null || selection.rangeCount === 0) {
    return { start: fallback, end: fallback };
  }
  const anchorNode = selection.anchorNode;
  const focusNode = selection.focusNode;
  if (anchorNode === null || focusNode === null || !editor.contains(anchorNode) || !editor.contains(focusNode)) return { start: fallback, end: fallback };
  const start = composerOffsetAt(editor, anchorNode, selection.anchorOffset);
  const end = composerOffsetAt(editor, focusNode, selection.focusOffset);
  return start <= end ? { start, end } : { start: end, end: start };
}

function composerOffsetAt(editor: HTMLElement, node: Node, offset: number): number {
  const range = document.createRange();
  range.selectNodeContents(editor);
  range.setEnd(node, offset);
  const holder = document.createElement('div');
  holder.append(range.cloneContents());
  return serializeComposerNode(holder).length;
}

function serializeComposerNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
  if (node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).dataset.token !== undefined) {
    return (node as HTMLElement).dataset.token ?? '';
  }
  return serializeComposerChildren(node).replace(/\r\n?/gu, '\n');
}

function serializeComposerChildren(parent: Node): string {
  let text = '';
  for (const child of Array.from(parent.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      text += child.textContent ?? '';
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const element = child as HTMLElement;
    if (element.dataset.token !== undefined) {
      text += element.dataset.token;
      continue;
    }
    if (element.tagName === 'BR') {
      text += '\n';
      continue;
    }
    const content = serializeComposerChildren(element);
    if (COMPOSER_BLOCK_TAGS.has(element.tagName) && text.length > 0 && !text.endsWith('\n')) text += '\n';
    text += content;
  }
  return text;
}

function restoreComposerCaret(editor: EventTarget & HTMLTextAreaElement, offset: number): void {
  if (!(editor instanceof HTMLElement)) return;
  const point = composerPointAtOffset(editor, offset);
  const range = document.createRange();
  range.setStart(point.node, point.offset);
  range.collapse(true);
  const selection = globalThis.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function composerPointAtOffset(parent: HTMLElement, requestedOffset: number): { readonly node: Node; readonly offset: number } {
  let offset = 0;
  const children = Array.from(parent.childNodes);
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index]!;
    const text = serializeComposerNode(child);
    if (requestedOffset > offset + text.length) {
      offset += text.length;
      continue;
    }
    if (child.nodeType === Node.TEXT_NODE) return { node: child, offset: Math.max(0, requestedOffset - offset) };
    return { node: parent, offset: requestedOffset <= offset ? index : index + 1 };
  }
  return { node: parent, offset: children.length };
}

const COMPOSER_BLOCK_TAGS = new Set(['ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DIV', 'FOOTER', 'HEADER', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'MAIN', 'NAV', 'P', 'PRE', 'SECTION']);
function toggleId(ids: readonly string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((current) => current !== id) : [...ids, id];
}

function detectCanvasActionKind(value: string): SkillCanvasActionKind | null {
  const normalized = value.trim().toLocaleLowerCase();
  if (/(?:反推|逆向|reverse).*(?:提示词|prompt|图片|图像|视频)?/u.test(normalized)) return 'reverse_agent';
  if (/(?:生成|制作|创建|做).*(?:视频|动画|video)/u.test(normalized)) return 'video_generation';
  if (/(?:生成|制作|创建|画|做).*(?:图片|图像|主图|海报|产品图|效果图|image)/u.test(normalized)) return 'image_generation';
  return null;
}

function shouldUseVisualAnalysis(
  mode: 'chat' | 'original' | 'codex',
  content: string,
  referenceCount: number,
): boolean {
  if (referenceCount === 0) return false;
  if (mode === 'original') return true;
  const visualIntent = /(?:分析|反推|逆向|复刻|提示词|生图|图像|图片|视频|工作流|构图|材质|灯光|景深|镜头|workflow|prompt|image|video|analy[sz]e|reverse)/iu.test(content);
  return mode === 'codex' ? visualIntent : /(?:分析|反推|逆向|复刻|提示词|analy[sz]e|reverse|prompt)/iu.test(content);
}

function isReverseAnalysisIntent(content: string): boolean {
  return /(?:反推|逆向|复刻|提取|还原).*(?:图片|图像|提示词|prompt)?|(?:reverse|reconstruct).*(?:image|prompt)?/iu.test(content);
}

function parseWorkflowPlanningSummary(content: string): string | null {
  try {
    const source = JSON.parse(content.trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '')) as unknown;
    if (!isRecord(source) || !isRecord(source.generation)) return null;
    return typeof source.summary === 'string' && source.summary.trim().length > 0 && source.summary.length <= 2_000
      ? source.summary.trim()
      : null;
  } catch {
    return null;
  }
}

function parseWorkflowGenerationPrompt(content: string): string {
  try {
    const source = JSON.parse(content.trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, ''));
    const prompt = source?.generation?.prompt;
    return typeof prompt === 'string' && prompt.length <= 6000 ? prompt.trim() : '';
  } catch { return ''; }
}

function isWorkflowCreationIntent(content: string, referenceCount = 0): boolean {
  if (/(?:创建|生成|制作|搭建|设计|建立|编排).*(?:工作流|流程|节点|连线)|(?:workflow|pipeline).*(?:create|build|design|generate)?/iu.test(content)) return true;
  return referenceCount > 0
    && /(?:精修|修图|修改|调整|替换|移除|保留|不.*改变|优化|edit|refine|preserve)/iu.test(content)
    && /(?:产品|主体|背景|图片|图像|参考|product|subject|background|image)/iu.test(content);
}

function canvasActionLabel(kind: SkillCanvasActionKind): string {
  if (kind === 'image_generation') return '生图';
  if (kind === 'video_generation') return '视频生成';
  return '反推';
}

function canvasActionErrorMessage(caught: unknown, kind: SkillCanvasActionKind): string {
  const code = isRecord(caught) && typeof caught.code === 'string' ? caught.code : undefined;
  const rawMessage = isRecord(caught) && typeof caught.message === 'string' ? caught.message : '';
  if (code === 'PERMISSION_DENIED') return '本地保存权限不足，生成节点未能保存或启动。请检查项目目录权限后重试。';
  if (code === 'RECOVERY_REQUIRED') return '项目需要先完成恢复，未创建生成节点。请恢复项目后重试。';
  if (code === 'PROJECT_SAVE_CONFLICT' || code === 'PROJECT_CONFIG_SAVE_FAILED') return '项目保存未完成，未创建生成节点。请先解决保存问题后重试。';
  if (kind === 'reverse_agent') {
    const timeout = rawMessage.match(/(?:timed out after|timeout|超时)[^\d]*(\d{1,9})?\s*(?:ms|秒)?/iu);
    if (timeout !== null) return '反推等待超时，请减少素材、切换快速或标准反推，或更换模型后重试。';
    const status = rawMessage.match(/\bstatus\s+(401|403|408|409|422|429|5\d\d)\b/iu);
    if (status !== null) {
      if (status[1] === '401' || status[1] === '403') return `反推模型拒绝了当前凭据（${status[1]}），请检查 API 密钥与模型权限。`;
      if (status[1] === '429') return '反推模型请求过于频繁（429），请稍后重试。';
      return `反推模型上游返回 ${status[1]}，当前路线暂时异常，请稍后重试或切换模型。`;
    }
    if (/所选模型没有明确声明反推能力|反推模型.*不可用|反推素材|可分析的媒体|Reverse analysis is unavailable/iu.test(rawMessage)) {
      return rawMessage.length > 0 && rawMessage.length <= 180 ? rawMessage : '反推配置或素材不可用，请检查模型与已连接素材后重试。';
    }
  }
  return `${canvasActionLabel(kind)}节点执行失败，请检查模型配置后重试。`;
}

function skillChatErrorMessage(caught: unknown): string {
  if (caught instanceof ProviderOperationTimeoutError) return formatAgentProviderTimeout(caught.timeoutMs);
  const code = isRecord(caught) && typeof caught.code === 'string' ? caught.code : undefined;
  const message = isRecord(caught) && typeof caught.message === 'string' ? caught.message : '';
  if (code === 'PROVIDER_UNAVAILABLE' || code === 'PROVIDER_ERROR' || code === 'PROVIDER_TIMEOUT') {
    const timeout = message.match(/\btimed out after\s+(\d{1,9})\s*ms\b/iu);
    if (timeout !== null) return formatAgentProviderTimeout(Number(timeout[1]));
    const status = message.match(/\bstatus\s+(401|403|408|409|422|429|5\d\d)\b/iu);
    if (status !== null) {
      if (status[1] === '401' || status[1] === '403') return `模型服务拒绝了当前凭据（${status[1]}），请在设置中检查 API 密钥与模型权限。`;
      if (status[1] === '429') return '模型服务请求过于频繁（429），请稍后重试。';
      return `模型上游服务返回 ${status[1]}，当前路线暂时异常，请稍后重试或切换模型。`;
    }
  }
  switch (code) {
    case 'CREDENTIALS_LOCKED':
      return '模型密钥不可用，请在设置中重新配置。';
    case 'CAPABILITY_UNSUPPORTED':
      return '当前模型不支持该素材或任务，请切换模型。';
    case 'PROVIDER_INVALID_RESPONSE':
      return '模型返回内容无效，请重试或切换模型。';
    case 'INVALID_REQUEST':
      return '当前请求参数无效，请检查模型与素材后重试。';
    case 'PROVIDER_UNAVAILABLE':
    case 'PROVIDER_ERROR':
      return '模型服务暂时不可用，请检查网络或连接设置。';
    case 'CODEX_CLI_NOT_INSTALLED':
      return '未检测到 Codex 运行时，请先安装或更新本机 Codex。';
    case 'CODEX_CLI_AUTH_REQUIRED':
      return 'Codex 认证已失效，请使用 ChatGPT 登录或重新配置有效的 API Key。';
    case 'CODEX_CLI_UPSTREAM_UNAVAILABLE':
      return '当前 Codex 模型上游通道不可用，请检查 Codex 账号的模型权限后重试。';
    case 'CODEX_CLI_INVALID_REQUEST':
      return '当前 Codex 模型请求不受支持，请检查素材与模型设置。';
    case 'CODEX_CLI_TIMEOUT':
      return '当前 Codex 模型请求超时，请稍后重试。';
    case 'CODEX_CLI_UNSAFE_RUNTIME':
      return '当前 Codex CLI 缺少安全执行能力，请更新 Codex 后重试。';
    case 'CODEX_CLI_MCP_FAILED':
      return 'Canvas Atelier MCP 操作未完成，未采用后续成功文本。';
    case 'CODEX_CLI_BUSY':
      return '已有 Codex 画布请求正在执行，请等待或先切换任务取消。';
    case 'CODEX_CLI_CANCELLED':
      return 'Codex 请求已取消。';
    case 'CODEX_CLI_FORBIDDEN_SIDE_EFFECT':
      return '已阻止非 Canvas Atelier 的工具调用。';
    case 'CODEX_CLI_INVALID_RESPONSE':
      return 'Codex 返回内容异常，请重试；若持续失败请更新 Codex。';
    case 'CODEX_CLI_FAILED':
      return 'Codex 进程调用失败，请重试；若持续失败请检查 ChatGPT 登录或 API Key。';
    default:
      return 'Agent 对话暂时不可用，请稍后重试。';
  }
}

function formatAgentProviderTimeout(timeoutMs: number): string {
  const seconds = Math.max(1, Math.round(timeoutMs / 1_000));
  return `模型分析已等待 ${seconds} 秒仍未返回，请减少图片数量、切换快速或标准反推，或更换模型后重试。`;
}

function didInsertMentionToken(previous: string, next: string): boolean {
  if (next.length <= previous.length) return false;
  let prefixLength = 0;
  while (prefixLength < previous.length && previous[prefixLength] === next[prefixLength]) prefixLength += 1;
  let previousSuffix = previous.length - 1;
  let nextSuffix = next.length - 1;
  while (previousSuffix >= prefixLength && previous[previousSuffix] === next[nextSuffix]) {
    previousSuffix -= 1;
    nextSuffix -= 1;
  }
  return next.slice(prefixLength, nextSuffix + 1).includes('@');
}

function createMessageId(): string {
  return typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function providerModelLabel(profile: AgentChatProfile, _profiles: readonly ProviderBridgeProfile[]): string {
  const identity = `${profile.modelRoute} ${profile.modelId ?? ''}`.toLocaleLowerCase();
  if (!identity.includes('codex')) return profile.displayName;
  const variant = identity.match(/(?:^|[-_/])(low|medium|high|minimal|max)(?:$|[-_/])/u)?.[1];
  if (!variant || profile.displayName.toLocaleLowerCase().includes(variant)) return profile.displayName;
  return `${profile.displayName} · ${variant}`;
}

function uniqueImageFamilyProfiles(profiles: readonly ProviderBridgeProfile[]): ProviderBridgeProfile[] {
  const seen = new Set<string>();
  return profiles.filter((profile) => {
    const key = `${profile.provider}:${imageResolutionFamilyKey(profile)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sameStringList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isIdenticalFailedRequest(
  message: SkillMessage | undefined,
  content: string,
  request: SkillRequestSummary,
): boolean {
  if (
    message?.role !== 'user'
    || message.content !== content
    || message.request?.status !== 'error'
    || message.request.modelDisplayName !== request.modelDisplayName
    || message.request.modelRoute !== request.modelRoute
    || message.request.knowledgeBaseCount !== request.knowledgeBaseCount
    || message.request.projectMemoryCount !== request.projectMemoryCount
    || message.request.visualAnalysis !== request.visualAnalysis
  ) return false;
  if (
    message.request.knowledgeBaseIds !== undefined
    && !sameStringList(message.request.knowledgeBaseIds, request.knowledgeBaseIds ?? [])
  ) return false;
  return message.request.references.length === request.references.length
    && message.request.references.every((reference, index) => {
      const next = request.references[index];
      return next?.assetId === reference.assetId && next.label === reference.label;
    });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
