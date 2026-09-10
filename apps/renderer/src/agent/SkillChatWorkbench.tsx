import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type ClipboardEvent } from 'react';
import { ArrowUp, Bot, Copy, Diamond, Grid3X3, Plus, RotateCcw, SlidersHorizontal, X } from 'lucide-react';
import type { ChatSkillBridgeResult, CodexCliProfile, CodexReasoningEffort, ProviderBridgeProfile } from '@agent-canvas/desktop-core';
import type { KnowledgeBaseStateSummary } from '@agent-canvas/skill-store';
import type { ImageMentionValue, MentionableImageReference } from './ImageMentionComposer';
import { reduceTransientPopover } from '../app/transient-popover';
import { listAgentChatProfiles } from '../app/provider-profiles';
import { ProviderOperationTimeoutError, withProviderOperationTimeout } from '../settings/provider-operation-timeout';
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
  createAgentConversation,
  deriveAgentConversationTitle,
  readAgentConversationCollection,
  writeAgentConversationCollection,
  type ReverseAnalysisDepth,
  type StoredAgentConversation,
} from './skill-chat-session-store';
import { parseReverseAnalysisResponse, type ReverseAnalysisResult } from './reverse-workflow-contract';
import { GenerationPreferencesSheet } from './GenerationPreferencesSheet';
import { CodexReasoningPopover } from './CodexReasoningPopover';
import { generationProfiles, readGenerationPreferences, writeGenerationPreferences, resolveGenerationPreference, type GenerationParameters, type GenerationPreferences } from './generation-preferences';
import { creativePlanningInstructions, parseCreativePlan, type CreativePlanOption } from './creative-plan';

type SkillMessage = {
  readonly id: string;
  readonly role: 'user' | 'assistant';
  readonly content: string;
  readonly sources?: Readonly<ChatSkillBridgeResult['sources']>;
  readonly request?: SkillRequestSummary;
};

type AgentChatProfile = ProviderBridgeProfile | CodexCliProfile;

type SkillRequestStatus = 'sending' | 'completed' | 'error';

type SkillChatMentionReference = MentionableImageReference & {
  readonly kind: 'image' | 'video';
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
};

export interface SkillWorkflowDraftRequest {
  readonly analysis: string;
  readonly reverseAnalysis?: ReverseAnalysisResult;
  readonly references: readonly { readonly assetId: string; readonly label: string; readonly mention: string }[];
  readonly modelRoute?: string;
  readonly modelRouteDisplayName?: string;
  readonly knowledgeBaseIds?: readonly string[];
  readonly generation?: { kind: 'image' | 'video'; modelRoute?: string; modelRouteDisplayName?: string; parameters?: GenerationParameters };
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
const AGENT_VISUAL_REQUEST_TIMEOUT_MS = 315_000;
const REQUIRED_AGENT_KNOWLEDGE_CHOICES = [
  { knowledgeBaseId: 'scene-skill', displayName: '场景 Skill', description: '产品场景、构图、材质与灯光规则' },
  { knowledgeBaseId: 'ecommerce-detail-knowledge', displayName: '电商详情页知识库', description: '详情页结构、卖点表达与视觉规范' },
] as const;

export interface ReverseTimelineEntry {
  readonly nodeId: string;
  readonly title: string;
  readonly positivePrompt: string;
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
  readonly projectId?: string;
  readonly parameters?: GenerationParameters;
  readonly referenceAssetIds?: readonly string[];
}

export interface SkillCanvasActionResult {
  nodeId: string;
  status: string;
  assetIds: string[];
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
  readonly onImportReferenceImage?: (file?: File) => Promise<SkillChatReferenceImage | null>;
  readonly onImportReferenceVideo?: (file?: File) => Promise<SkillChatReferenceVideo | null>;
  readonly canvasActionTargets?: readonly SkillCanvasActionTarget[];
  readonly canvasActionResults?: readonly SkillCanvasActionResult[];
  readonly executeCanvasAction?: (request: SkillCanvasActionRequest) => Promise<boolean>;
  readonly draftWorkflowFromAnalysis?: (request: SkillWorkflowDraftRequest) => void;
  readonly onClose?: () => void;
  readonly chat: (request: SkillChatRequest) => Promise<ChatSkillBridgeResult>;
  readonly cancelChat?: (requestId: string) => Promise<boolean>;
}

const MAX_AGENT_PROJECT_MEMORY_IDS = 32;

function clampProjectMemoryIds(
  selectedIds: readonly string[],
  availableIds: readonly string[],
): string[] {
  const available = new Set(availableIds.slice(0, MAX_AGENT_PROJECT_MEMORY_IDS));
  return [...new Set(selectedIds)]
    .filter((id) => available.has(id))
    .slice(0, MAX_AGENT_PROJECT_MEMORY_IDS);
}

export function SkillChatWorkbench({
  projectId,
  profiles,
  codexProfiles: localCodexProfiles = [],
  knowledgeBases,
  projectMemoryIds,
  reverseTimeline,
  referenceImages = [],
  referenceVideos = [],
  onImportReferenceImage,
  canvasActionResults = [],
  executeCanvasAction,
  draftWorkflowFromAnalysis,
  onClose,
  chat,
  cancelChat,
}: SkillChatWorkbenchProps) {
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
  const initialCollection = useRef(readAgentConversationCollection(projectId)).current;
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
  const [composer, setComposer] = useState<ImageMentionValue>({ text: '', citations: [] });
  const composerSelectionRef = useRef<MediaMentionSelection | null>(null);
  const pendingComposerCaretRef = useRef<number | null>(null);
  const [importedReferenceImages, setImportedReferenceImages] = useState<SkillChatReferenceImage[]>([]);
  const referenceFileInput = useRef<HTMLInputElement>(null);
  const [, setReferenceImportRevision] = useState(0);
  const draft = composer.text;
  const [contextExpanded, setContextExpanded] = useState(false);
  const [activePopover, dispatchPopover] = useReducer(reduceTransientPopover, null);
  const mentionOpen = activePopover === 'reference';
  const routeSheetOpen = activePopover === 'model';
  const skillLibraryOpen = activePopover === 'knowledge';
  const [libraryQuery, setLibraryQuery] = useState('');
  const [libraryCategory, setLibraryCategory] = useState<'common' | 'favorite' | 'mine'>('common');
  const [status, setStatus] = useState<'idle' | 'sending'>('idle');
  const [agentMode, setAgentMode] = useState<'chat' | 'original' | 'codex'>(initialConversation.mode);
  const [reasoningEfforts, setReasoningEfforts] = useState(initialConversation.reasoningEfforts);
  const [reverseAnalysisDepth, setReverseAnalysisDepth] = useState<ReverseAnalysisDepth>(initialConversation.reverseAnalysisDepth);
  const reasoningEffort = reasoningEfforts[agentMode];
  const setReasoningEffort = (effort: CodexReasoningEffort) => setReasoningEfforts((current) => ({ ...current, [agentMode]: effort }));
  const [error, setError] = useState<string | null>(null);
  const [sentImageCopyFeedback, setSentImageCopyFeedback] = useState<'success' | 'source-error' | 'error' | null>(null);
  const [pendingCanvasAction, setPendingCanvasAction] = useState<SkillCanvasActionRequest | null>(null);
  const [selectedCreativeOptionKey, setSelectedCreativeOptionKey] = useState<string | null>(null);
  const [pendingCanvasModelRoute, setPendingCanvasModelRoute] = useState<string | undefined>(undefined);
  const [generationPreferences, setGenerationPreferences] = useState(() => readGenerationPreferences(projectId));
  const [submittedNodeIds, setSubmittedNodeIds] = useState<string[]>([]);
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
  const requestId = useRef(0);
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
  const mentionReferences = useMemo<SkillChatMentionReference[]>(() => [
    ...allReferenceImages.map((media, mentionPosition) => ({
      assetId: media.assetId,
      label: media.label,
      displayUrl: media.displayUrl,
      position: mentionPosition,
      mentionPosition,
      kind: 'image' as const,
      role: 'product_identity' as const,
    })),
  ], [allReferenceImages]);
  const mentionPreviews = useMemo(() => mentionReferences.map((reference) => ({
    token: skillChatMentionToken(reference.kind, reference.mentionPosition),
    label: reference.label,
    displayUrl: reference.displayUrl,
    kind: reference.kind,
  })), [mentionReferences]);
  const refreshReferenceImportState = () => {
    if (mounted.current) setReferenceImportRevision((current) => current + 1);
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
    if (mentionReferences.length > 0) {
      setError(null);
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
      const composerAtInsertion = existingCitation && insertionMarker !== undefined
        ? { ...current, text: current.text.replace(insertionMarker, '') }
        : current;
      return attachPastedReference(
        composerAtInsertion,
        importedReference,
        existingCitation ? undefined : insertionMarker,
        upsertPasteReferenceByAssetId(mentionReferences, importedReference),
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
      const imported = await importer(file);
      if (imported === null) return false;
      if (generation === undefined || !isPasteGenerationCurrent(generation)) return false;
      if (!pasteContext.current.supportsMedia) {
        setError(mediaCapabilityError);
        return false;
      }
      const media = canonicalReferences.current.images;
      const existingPosition = media.findIndex((candidate) => candidate.assetId === imported.assetId);
      const mentionPosition = existingPosition >= 0 ? existingPosition : media.length;
      canonicalReferences.current = {
        ...canonicalReferences.current,
        images: upsertPasteReferenceByAssetId(media, imported),
      };
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
              canonicalMentionReferences(canonicalReferences.current),
            )
            : current);
        }
        finishManualReferenceImport(manualImport.token);
      }
    }
  };
  const importPastedReferencesInOrder = async (
    media: ReturnType<typeof readAgentChatClipboard>['media'],
    insertionMarker: string,
    generation: number,
  ) => {
    let hadFailure = false;
    let hadUnsupportedVideo = false;
    try {
      for (const item of media) {
        if (!isPasteGenerationCurrent(generation)) return;
        const itemIsVideo = item.file.type.startsWith('video/') || /\.(?:mp4|webm|mov)$/iu.test(item.file.name);
        if (itemIsVideo) {
          hadUnsupportedVideo = true;
          continue;
        }
        if (!pasteContext.current.supportsMedia) {
          setError(mediaCapabilityError);
          return;
        }
        const imported = await importReferenceFile(item.file, {
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
        ? reducePasteComposer(current, current.text.replace(insertionMarker, ''), canonicalMentionReferences(canonicalReferences.current))
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
    const fallbackVisionProfile = pasteContext.current.supportsMedia || agentMode === 'codex'
      ? undefined
      : chatProfiles.find((profile) => supportsAgentMediaReferences(profile, agentMode));
    const action = resolveClipboardPasteAction({
      hasPlainText: event.clipboardData.getData('text/plain').length > 0,
      parsedText: payload.text,
      hasMedia: payload.media.length > 0,
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
      .then(() => importPastedReferencesInOrder(payload.media, insertionMarker, generation))
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
    const receiveGeneratedImage = (event: Event) => {
      const assetId = (event as CustomEvent<{ assetId?: unknown }>).detail?.assetId;
      if (typeof assetId !== 'string') return;
      const reference = mentionReferences.find((candidate) => candidate.assetId === assetId);
      if (reference === undefined) return;
      if (!supportsImageMentions) {
        setError(imageMentionCapabilityError);
        return;
      }
      setComposer((current) => {
        if (current.citations.some((citation) => citation.assetId === reference.assetId)) return current;
        if (current.citations.length >= 20) return current;
        const mentionToken = skillChatMentionToken(reference.kind, reference.mentionPosition);
        const insertion = replaceChatMentionAtSelection(current.text, mentionToken, mentionReferences, composerSelectionRef.current);
        pendingComposerCaretRef.current = insertion.caretOffset;
        composerSelectionRef.current = { start: insertion.caretOffset, end: insertion.caretOffset };
        return {
          text: insertion.text,
          citations: [...current.citations, { assetId: reference.assetId, label: reference.label }],
        };
      });
      setError(null);
      dispatchPopover({ type: 'close-external' });
    };
    globalThis.addEventListener('novus:generated-image-to-agent', receiveGeneratedImage);
    return () => globalThis.removeEventListener('novus:generated-image-to-agent', receiveGeneratedImage);
  }, [mentionReferences, supportsImageMentions]);

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
    if (cancellingCodex) void cancelActiveCodexRequest().finally(() => { if (mounted.current) setStatus('idle'); });
    invalidatePastedReferences();
    requestId.current += 1;
    conversationEpoch.current += 1;
    setSubmittedNodeIds([]);
    deliveredNodeTerminalSignatures.current.clear();
    setActiveConversationId(conversation.id);
    setModelRoute(conversation.modelRoute ?? chatProfiles.find((profile) => profile.modelRoute === 'chat-default')?.modelRoute ?? chatProfiles[0]?.modelRoute);
    setSelectedKnowledgeBaseIds([...conversation.knowledgeBaseIds]);
    setSelectedProjectMemoryIds(clampProjectMemoryIds(conversation.projectMemoryIds, availableProjectMemoryIds));
    setMessages([...conversation.messages]);
    setAgentMode(conversation.mode);
    setReasoningEfforts(conversation.reasoningEfforts);
    setReverseAnalysisDepth(conversation.reverseAnalysisDepth);
    setComposer({ text: '', citations: [] });
    setStatus(cancellingCodex ? 'sending' : 'idle');
    setPendingCanvasAction(null);
    setSelectedCreativeOptionKey(null);
    setCanvasActionRunning(false);
    setError(null);
    dispatchPopover({ type: 'close-external' });
  };

  const createConversation = () => {
    const cancellingCodex = activeLocalCodexRequestId.current !== null;
    if (cancellingCodex) void cancelActiveCodexRequest().finally(() => { if (mounted.current) setStatus('idle'); });
    invalidatePastedReferences();
    requestId.current += 1;
    conversationEpoch.current += 1;
    setSubmittedNodeIds([]);
    deliveredNodeTerminalSignatures.current.clear();
    let now = Date.now();
    while (conversationCollection.conversations.some((conversation) => conversation.id === `conversation-${now}`)) now += 1;
    const created: StoredAgentConversation = {
      ...createAgentConversation(now),
      ...(chatProfiles[0]?.modelRoute === undefined ? {} : { modelRoute: chatProfiles[0].modelRoute }),
      projectMemoryIds: [...availableProjectMemoryIds],
    };
    const next = {
      version: 2 as const,
      activeConversationId: created.id,
      conversations: [...conversationCollection.conversations, created],
    };
    writeAgentConversationCollection(projectId, next);
    setConversationCollection(next);
    setActiveConversationId(created.id);
    setModelRoute(created.modelRoute);
    setSelectedKnowledgeBaseIds([]);
    setSelectedProjectMemoryIds([...created.projectMemoryIds]);
    setMessages([]);
    setAgentMode(created.mode);
    setReasoningEfforts(created.reasoningEfforts);
    setReverseAnalysisDepth(created.reverseAnalysisDepth);
    setComposer({ text: '', citations: [] });
    setStatus(cancellingCodex ? 'sending' : 'idle');
    setPendingCanvasAction(null);
    setSelectedCreativeOptionKey(null);
    setCanvasActionRunning(false);
    setError(null);
    dispatchPopover({ type: 'close-external' });
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
    if (!modelRoute || selectedProfile === undefined || !hasSupportedReasoningEffort || status === 'sending') return;
    invalidatePastedReferences();
    const selectedReferences = resolveSelectedPasteReferences(cleanComposer.citations, mentionReferences);
    if (selectedReferences.length > 0 && !supportsImageMentions) {
      setError(imageMentionCapabilityError);
      return;
    }
    const visualAnalysis = shouldUseVisualAnalysis(agentMode, content, selectedReferences.length);
    const planning = agentMode === 'original';
    const planningInstructions = planning ? creativePlanningInstructions(generationPreferences, profiles, selectedReferences.length) : '';
    if (content.length + planningInstructions.length + 2 > 16000) {
      setError('消息过长，请分段发送。');
      return;
    }
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
    };
    const previousMessage = messages[messages.length - 1];
    const replacesFailedRequest = isIdenticalFailedRequest(previousMessage, content, requestSummary);
    const userMessage: SkillMessage = {
      id: replacesFailedRequest ? previousMessage!.id : createMessageId(),
      role: 'user',
      content,
      request: requestSummary,
    };
    const nextMessages = replacesFailedRequest
      ? [...messages.slice(0, -1), userMessage]
      : [...messages, userMessage];
    const retryComposer = cleanComposer;
    const activeKnowledgeBaseIds = new Set(availableKnowledge.map((knowledgeBase) => knowledgeBase.knowledgeBaseId));
    const activeRequestId = requestId.current + 1;
    requestId.current = activeRequestId;
    const localCodexRequestId = selectedProfile.provider === 'codex' ? createMessageId() : undefined;
    if (localCodexRequestId !== undefined) activeLocalCodexRequestId.current = localCodexRequestId;
    dispatchPopover({ type: 'close-external' });
    setMessages(nextMessages);
    setComposer({ text: '', citations: [] });
    setError(null);
    setStatus('sending');
    try {
      const result = await withProviderOperationTimeout(chat({
        provider: selectedProfile?.provider ?? 'comfly',
        modelRoute,
        ...(localCodexRequestId === undefined ? {} : { requestId: localCodexRequestId }),
        messages: nextMessages.map(({ role, content: messageContent }, index) => ({
          role,
          content: planning && index === nextMessages.length - 1
            ? messageContent + '\n\n' + planningInstructions
            : messageContent,
        })),
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
      }), selectedProfile.provider === 'codex'
        ? 10 * 60_000
        : selectedReferences.length > 0 || visualAnalysis
          ? AGENT_VISUAL_REQUEST_TIMEOUT_MS
          : AGENT_REQUEST_TIMEOUT_MS);
      if (requestId.current !== activeRequestId) return;
      setMessages((current) => [...current.map((message) => message.id === userMessage.id && message.request !== undefined
        ? { ...message, request: { ...message.request, status: 'completed' as const } }
        : message), {
        id: createMessageId(),
        role: 'assistant',
        content: result.message,
        sources: result.sources,
      }]);
      setStatus('idle');
    } catch (caught) {
      if (requestId.current !== activeRequestId) return;
      setStatus('idle');
      setComposer((current) => current.text.trim().length === 0 && current.citations.length === 0 ? retryComposer : current);
      setMessages((current) => current.map((message) => message.id === userMessage.id && message.request !== undefined
        ? { ...message, request: { ...message.request, status: 'error' as const } }
        : message));
      setError(skillChatErrorMessage(caught));
    } finally {
      if (localCodexRequestId !== undefined && activeLocalCodexRequestId.current === localCodexRequestId) {
        activeLocalCodexRequestId.current = null;
      }
    }
  };

  const chooseCreativeOption = (messageId: string, option: CreativePlanOption, references: readonly { assetId: string }[]) => {
    try {
      const { profile, parameters } = resolveGenerationPreference(option.kind, generationPreferences, profiles, option.modelRoute, references.length);
      const kind = `${option.kind}_generation` as const;
      setPendingCanvasAction({ kind, nodeId: `agent-${option.kind}-${createMessageId()}`, createNode: true, projectId, prompt: option.prompt, modelRoute: profile.modelRoute, parameters, referenceAssetIds: references.map((item) => item.assetId) });
      setSelectedCreativeOptionKey(`${messageId}:${option.id}`);
      setPendingCanvasModelRoute(profile.modelRoute);
      setError(null);
    } catch (error) { setError(error instanceof Error ? error.message : '请检查生成偏好。'); }
  };

  useEffect(() => {
    if (pendingCanvasAction === null) return;
    confirmationCardRef.current?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
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
      setMessages((current) => [...current, { id: createMessageId(), role: 'assistant', content }]);
    }
  }, [canvasActionResults, submittedNodeIds]);

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
      const started = await executeCanvasAction({ ...action, modelRoute: resolved.profile.modelRoute, parameters: resolved.parameters });
      if (!mounted.current || epoch !== conversationEpoch.current) return;
      if (!started) {
        setError(`${canvasActionLabel(action.kind)}节点未能启动，请检查模型配置后重试。`);
        return;
      }
      setMessages((current) => [...current, {
        id: createMessageId(),
        role: 'assistant',
        content: `${canvasActionLabel(action.kind)}节点已开始运行。`,
      }]);
      setSubmittedNodeIds((current) => [...new Set([...current, action.nodeId])]);
      setPendingCanvasAction(null);
      setSelectedCreativeOptionKey(null);
      setPendingCanvasModelRoute(undefined);
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
  const pendingCanvasPreference = pendingCanvasAction === null || pendingCanvasAction.kind === 'reverse_agent'
    ? undefined
    : generationPreferences[pendingCanvasActionKind];
  const pendingCanvasFixedRouteIsCompatible = pendingCanvasPreference?.mode !== 'fixed'
    || pendingCanvasActionProfiles.some((profile) => profile.modelRoute === pendingCanvasPreference.modelRoute);
  const pendingCanvasModelLocked = pendingCanvasPreference?.mode === 'fixed' && pendingCanvasFixedRouteIsCompatible;

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
          <select aria-label="Codex 任务" value={activeConversationId} onChange={(event) => activateConversation(event.target.value)}>
            {[...conversationCollection.conversations]
              .sort((left, right) => right.updatedAt - left.updatedAt)
              .map((conversation) => <option key={conversation.id} value={conversation.id}>{conversation.title}</option>)}
          </select>
          <button
            className="skill-chat-workbench__new-chat"
            data-testid="agent-new-chat"
            type="button"
            aria-label="新建任务"
            onClick={createConversation}
          ><span aria-hidden="true">+</span><span className="sr-only">新对话</span></button>
          {onClose && <button className="skill-chat-workbench__close" type="button" aria-label="关闭 Codex Agent" onClick={onClose}><X size={15} /></button>}
        </div>
      </header>

      {routeSheetOpen && (
        <section className="skill-chat-workbench__sheet" data-anchor="composer-footer" role="dialog" aria-label="选择聊天模型">
          <header>
            <div>
              <strong>选择聊天模型</strong>
              <p>仅显示已配置的聊天路线。</p>
            </div>
            <button type="button" aria-label="关闭模型选择" onClick={() => dispatchPopover({ type: 'close-external' })}>关闭</button>
          </header>
          <div className="skill-chat-workbench__route-list" role="list">
            {visibleChatProfiles.map((profile) => {
              const selected = profile.modelRoute === modelRoute;
              return (
                <div key={profile.modelRoute} role="listitem">
                  <button
                    type="button"
                    aria-label={`使用 ${providerModelLabel(profile, chatProfiles)}`}
                    aria-pressed={selected}
                    className={selected ? 'is-selected' : undefined}
                    onClick={() => {
                      if (profile.modelRoute !== modelRoute && activeLocalCodexRequestId.current !== null) {
                        void cancelActiveCodexRequest().finally(() => { if (mounted.current) setStatus('idle'); });
                      }
                      if (profile.modelRoute !== modelRoute) invalidateActivePlan();
                      invalidatePastedReferences();
                      setModelRoute(profile.modelRoute);
                      dispatchPopover({ type: 'close-external' });
                    }}
                  >
                    <strong>{providerModelLabel(profile, chatProfiles)}</strong>
                    <span>{profile.provider === 'codex'
                      ? selected ? '当前选择 · ChatGPT / API Key 调用时验证' : '支持 ChatGPT / API Key'
                      : selected ? '当前选择' : '选择此模型'}</span>
                  </button>
                </div>
              );
            })}
            {visibleChatProfiles.length === 0 && <p>未发现已配置的 Codex 模型。</p>}
          </div>
        </section>
      )}

      {activePopover === 'generation' && <GenerationPreferencesSheet value={generationPreferences} profiles={profiles} onChange={changeGenerationPreferences} onClose={() => dispatchPopover({ type: 'close-external' })} />}
      {skillLibraryOpen && (
        <section className="skill-chat-workbench__sheet skill-chat-workbench__sheet--library" data-anchor="composer-footer" role="dialog" aria-label="选择知识库">
          <header>
            <div><strong>选择知识库</strong><p>Knowledge library · 可多选</p></div>
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
      <section className="skill-chat-workbench__context" aria-label="对话上下文">
        <button type="button" aria-expanded={contextExpanded} onClick={() => setContextExpanded((current) => !current)}>
          {contextExpanded ? '收起上下文' : '展开上下文'}
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
          </div>
        )}
      </section>

      <div className="skill-chat-workbench__stream" aria-label="Agent 消息流" tabIndex={0}>
        {agentMode !== 'chat' && reverseTimeline.length > 0 && (
          <section className="skill-chat-workbench__reverse-timeline" aria-label="反推上下文事件">
            {reverseTimeline.map((entry) => (
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
          {messages.length === 0 && reverseTimeline.length === 0 && (
            <section className="skill-chat-workbench__empty-state" aria-label="Agent conversation empty state">
              {visibleChatProfiles.length === 0 ? (
                <>
                  <strong>请先在设置中配置聊天模型</strong>
                  <p>暂无可用模型。</p>
                </>
              ) : (
                <>
                  <div className="skill-chat-workbench__intro skill-chat-workbench__intro--codex">
                    <i aria-hidden="true"><Bot size={22} strokeWidth={1.6} /></i>
                    <strong>{agentMode === 'codex' ? 'Codex 画布助手' : agentMode === 'original' ? '创作 Agent' : '开始对话'}</strong>
                  </div>
              {chatProfiles.length > 0 && (
                <div className="skill-chat-workbench__suggestions" aria-label="推荐 Skill">
                  <button type="button" aria-label="梳理创作目标" onClick={() => setComposer({ text: '请帮我梳理创作目标、约束条件和下一步方案。', citations: [] })}>
                    <span className="skill-chat-workbench__suggestion-icon">⌁</span>
                    <span><strong>产品分析</strong><small>点击填入任务</small></span>
                  </button>
                  <button type="button" aria-label="生成视觉方向" onClick={() => setComposer({ text: '为当前画布生成一套清晰的视觉方向与构图建议。', citations: [] })}>
                    <span className="skill-chat-workbench__suggestion-icon">✦</span>
                    <span><strong>提示词优化</strong><small>点击填入任务</small></span>
                  </button>
                  <button type="button" aria-label="调用知识库" onClick={() => setComposer({ text: '检查当前项目的知识库上下文，并给出可复用的创作建议。', citations: [] })}>
                    <span className="skill-chat-workbench__suggestion-icon">◌</span>
                    <span><strong>生成方案</strong><small>点击填入任务</small></span>
                  </button>
                  <button type="button" aria-label="反推参考图" onClick={() => setComposer({ text: '根据当前参考图反推一版可编辑的提示词。', citations: [] })}>
                    <span className="skill-chat-workbench__suggestion-icon">◈</span>
                    <span><strong>知识库检索</strong><small>点击填入任务</small></span>
                  </button>
                </div>
              )}
                </>
              )}
            </section>
          )}
          {messages.map((message, messageIndex) => {
            const precedingMessage = messageIndex > 0 ? messages[messageIndex - 1] : undefined;
            const creativePlan = message.role === 'assistant' ? parseCreativePlan(message.content) : null;
            const reverseWorkflowOffer = precedingMessage?.role === 'user'
              && precedingMessage.request?.visualAnalysis === true
              && isReverseAnalysisIntent(precedingMessage.content);
            const requestedWorkflowOffer = precedingMessage?.role === 'user'
              && agentMode === 'codex'
              && isWorkflowCreationIntent(precedingMessage.content);
            const workflowOffer = message.role === 'assistant'
              && precedingMessage?.role === 'user'
              && (reverseWorkflowOffer || requestedWorkflowOffer)
              && !dismissedWorkflowOfferIds.includes(message.id);
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
            return (
            <article key={message.id} className={`skill-chat-workbench__message skill-chat-workbench__message--${message.role}${creativePlan ? ' skill-chat-workbench__message--creative-plan' : ''}`}>
              <span>{message.role === 'user' ? '你的请求' : 'Agent 建议'}</span>
              <p>{creativePlan?.summary ?? message.content}</p>
              {creativePlan && <section className="creative-plan" aria-label="创作方案">
                {([['观察', creativePlan.observations], ['估计', creativePlan.estimates], ['未知', creativePlan.unknowns]] as const).map(([label, items]) => items.length > 0 ? <div key={label}><strong>{label}</strong><p>{items.join('\n')}</p></div> : null)}
                {creativePlan.options.map((option) => {
                  const optionKey = `${message.id}:${option.id}`;
                  const selected = selectedCreativeOptionKey === optionKey;
                  return <div key={option.id} className="creative-plan__option"><strong>{option.title}</strong><p>{option.reason}</p><details><summary>查看完整提示词</summary><p>{option.prompt}</p></details>
                    {agentMode !== 'chat' && <button type="button" className={`creative-plan__select${selected ? ' is-selected' : ''}`} aria-label={`选择方案：${option.title}`} aria-pressed={selected} disabled={canvasActionRunning || status === 'sending'} onClick={() => chooseCreativeOption(message.id, option, precedingMessage?.request?.references ?? [])}>{selected ? '✓ 已选择' : '选择此方案'}</button>}
                  </div>;
                })}
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
                        generation = { kind, modelRoute: profile.modelRoute, modelRouteDisplayName: profile.displayName, parameters };
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
              <p>{pendingCanvasAction.createNode ? `将新建独立节点并执行${canvasActionLabel(pendingCanvasAction.kind)}` : `将在节点 ${pendingCanvasAction.nodeId} 执行${canvasActionLabel(pendingCanvasAction.kind)}`}。</p>
              <details><summary>查看执行提示词与参数</summary><p>{pendingCanvasAction.prompt}</p><p>{Object.entries(pendingCanvasAction.parameters ?? {}).map(([key, value]) => `${key}: ${value}`).join(' · ') || '使用模型默认参数'}</p></details>
              {pendingCanvasActionProfiles.length > 0 && (
                <label className="skill-chat-workbench__action-model">使用模型
                  <select aria-label={`选择${canvasActionLabel(pendingCanvasAction.kind)}模型`} disabled={pendingCanvasModelLocked} value={pendingCanvasModelRoute ?? ''} onChange={(event) => setPendingCanvasModelRoute(event.target.value)}>
                    {pendingCanvasActionProfiles.map((profile) => <option key={profile.modelRoute} value={profile.modelRoute}>{profile.displayName}</option>)}
                  </select>
                </label>
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
                  <button type="button" className="is-primary" aria-label={`确认执行${canvasActionLabel(pendingCanvasAction.kind)}`} disabled={canvasActionRunning || pendingCanvasActionProfiles.length === 0} onClick={() => void confirmCanvasAction()}>{canvasActionRunning ? '正在创建…' : '确认并新建节点'}</button>
                  <button type="button" className="is-secondary" aria-label="取消画布操作" disabled={canvasActionRunning} onClick={() => { setPendingCanvasAction(null); setSelectedCreativeOptionKey(null); }}>取消</button>
                </div>
              </section>
            </article>
          )}
          {submittedNodeIds.map((nodeId) => {
            const result = canvasActionResults.find((item) => item.nodeId === nodeId);
            return <section key={nodeId} aria-label="生成执行进度" className="creative-plan__progress"><span>{result?.status === 'completed' && result.assetIds.length > 0 ? '结果已回写' : result?.status === 'completed' ? '结果已生成，但尚未回写画布' : result?.status === 'failed' ? '执行失败' : result?.status === 'cancelled' ? '已取消' : '生成任务执行中'}</span>
              {result?.assetIds.map((assetId) => {
                const media = allReferenceMedia.find((item) => item.assetId === assetId);
                return media?.kind === 'video' ? <video key={assetId} src={media.displayUrl} controls playsInline /> : media ? <img key={assetId} src={media.displayUrl} alt="生成结果" /> : null;
              })}
            </section>;
          })}
          {status === 'sending' && (
            <article className="skill-chat-workbench__message skill-chat-workbench__message--assistant skill-chat-workbench__message--thinking" aria-label="Agent 正在分析">
              <span>Agent</span>
              <p className="skill-chat-workbench__status" role="status"><i aria-hidden="true" />正在分析需求…</p>
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
        {error && <p className="skill-chat-workbench__error" role="alert">{error}</p>}
      </div>

      <form className="skill-chat-workbench__composer" onSubmit={(event) => { event.preventDefault(); void send(); }}>
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
              if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
              event.preventDefault();
              void send();
            }}
          />
        </label>
        {composer.citations.length > 0 && (
          <div className="skill-chat-workbench__image-tags" aria-label="Selected image references">
            {composer.citations.map((citation, citationIndex) => {
              const media = allReferenceMedia.find((reference) => reference.assetId === citation.assetId);
              const reference = mentionReferences.find((candidate) => candidate.assetId === citation.assetId);
              if (reference === undefined) return null;
              return <button key={citation.assetId} type="button" aria-label={`Remove ${citation.label} media reference`} onClick={() => toggleImageMention(reference)}>
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
            <div role="menu" aria-label="Reference images" className="skill-chat-workbench__mention-menu">
              <header><strong>@ 图片引用</strong><span>{mentionReferences.length}</span></header>
              {mentionReferences.map((reference) => (
                <button key={reference.assetId} type="button" role="menuitem" aria-label={`Mention ${reference.label}`} onClick={() => {
                  toggleImageMention(reference);
                  dispatchPopover({ type: 'close-external' });
                }}>
                  {allReferenceMedia.find((media) => media.assetId === reference.assetId)?.kind === 'video'
                    ? <video src={reference.displayUrl} aria-label={`${reference.label} video thumbnail`} muted playsInline preload="metadata" />
                    : <img src={reference.displayUrl} alt={reference.label} />}
                  <span><b>{reference.label}</b><small>项目受管素材 · {skillChatMentionToken(reference.kind, reference.mentionPosition)}</small></span>
                </button>
              ))}
            </div>
          )}
          <input ref={referenceFileInput} className="sr-only" data-testid="agent-reference-file-input" type="file" accept="image/*" tabIndex={-1} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void importReferenceFile(file); }} />
          <button type="button" className="skill-chat-workbench__tool" aria-label="添加素材" title="导入项目图片" disabled={onImportReferenceImage === undefined || referenceImporting} onClick={requestReferenceImport}><Plus size={14} strokeWidth={1.6} /></button>
          <div className="skill-chat-workbench__mode-tabs" role="tablist" aria-label="Agent 模式">
            {([['chat', '对话'], ['original', '创作 Agent'], ['codex', 'Codex']] as const).map(([mode, label]) => <button key={mode} type="button" role="tab" aria-selected={agentMode === mode} className={agentMode === mode ? 'is-active' : undefined} onClick={() => {
              if (mode !== agentMode && activeLocalCodexRequestId.current !== null) {
                void cancelActiveCodexRequest().finally(() => { if (mounted.current) setStatus('idle'); });
              }
              if (mode !== agentMode) invalidateActivePlan();
              invalidatePastedReferences();
              if (mode !== agentMode) setError(null);
              setAgentMode(mode);
              dispatchPopover({ type: 'close-external' });
              const profilesForMode = mode === 'codex' ? codexProfiles : chatProfiles;
              if (profilesForMode.length > 0 && !profilesForMode.some((profile) => profile.modelRoute === modelRoute)) {
                setModelRoute(profilesForMode.find((profile) => profile.modelRoute === 'chat-default')?.modelRoute ?? profilesForMode[0]?.modelRoute);
              }
            }}>{label}</button>)}
          </div>
          <button type="button" className="skill-chat-workbench__model-pill" data-testid="agent-model-trigger" aria-label="打开聊天模型菜单" data-selected-model={selectedProfile?.displayName ?? '未配置'} onClick={() => dispatchPopover({ type: 'open', id: 'model' })}>{selectedProfile ? providerModelLabel(selectedProfile, chatProfiles) : agentMode === 'codex' ? '未发现 Codex 模型' : '选择模型'}</button>
          {(selectedProfile?.provider === 'codex' || selectedProfile?.reasoning !== undefined) && <CodexReasoningPopover
            modelLabel={selectedProfile?.displayName ?? '未选择模型'} efforts={supportedEfforts} value={reasoningEffort}
            defaultValue={selectedProfile?.provider === 'codex' ? selectedProfile.defaultReasoningEffort : selectedProfile?.reasoning?.defaultEffort}
            disabled={!selectedProfile} open={activePopover === 'reasoning'} onChange={setReasoningEffort}
            onToggle={() => dispatchPopover({ type: 'toggle', id: 'reasoning' })}
            onClose={() => dispatchPopover({ type: 'close-external' })}
            onSelectModel={() => dispatchPopover({ type: 'open', id: 'model' })}
          />}
          {supportsImageMentions && <div className="skill-chat-workbench__reverse-depth" role="group" aria-label="反推强度">
            {([['fast', '快速反推'], ['standard', '标准反推'], ['deep', '深度反推']] as const).map(([depth, label]) => <button
              key={depth}
              type="button"
              aria-pressed={reverseAnalysisDepth === depth}
              className={reverseAnalysisDepth === depth ? 'is-active' : undefined}
              onClick={() => setReverseAnalysisDepth(depth)}
            >{label}</button>)}
          </div>}
          <button type="button" className="skill-chat-workbench__generation-trigger" data-testid="agent-generation-preferences" aria-label="生成偏好" title="生成偏好" onClick={() => dispatchPopover({ type: 'open', id: 'generation' })}><SlidersHorizontal size={15} /></button>
          <div className="skill-chat-workbench__composer-actions">
            <button type="button" className="skill-chat-workbench__tool skill-chat-workbench__knowledge-compact" data-testid="knowledge-base-trigger" aria-label="打开知识库" onClick={() => dispatchPopover({ type: 'open', id: 'knowledge' })}><Grid3X3 size={14} strokeWidth={1.6} /></button>
            <button type="button" className="skill-chat-workbench__tool" aria-label="新建对话" onClick={createConversation}><RotateCcw size={14} strokeWidth={1.6} /></button>
            <button type="submit" className="skill-chat-workbench__send" aria-label="发送" title="发送" disabled={!hasSendablePasteText(draft, pendingPasteMarkers.current) || selectedProfile === undefined || !hasSupportedReasoningEffort || status === 'sending'}><ArrowUp size={17} /></button>
          </div>
        </div>
      </form>
    </section>
  );
}

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
}): SkillChatMentionReference[] {
  return [
    ...references.images.map((media, mentionPosition) => ({
      ...media,
      position: mentionPosition,
      mentionPosition,
      kind: 'image' as const,
      role: 'product_identity' as const,
    })),
    ...references.videos.map((media, mentionPosition) => ({
      ...media,
      position: references.images.length + mentionPosition,
      mentionPosition,
      kind: 'video' as const,
      role: 'product_identity' as const,
    })),
  ];
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

function isWorkflowCreationIntent(content: string): boolean {
  return /(?:创建|生成|制作|搭建|设计|建立|编排).*(?:工作流|流程|节点|连线)|(?:workflow|pipeline).*(?:create|build|design|generate)?/iu.test(content);
}

function canvasActionLabel(kind: SkillCanvasActionKind): string {
  if (kind === 'image_generation') return '生图';
  if (kind === 'video_generation') return '视频生成';
  return '反推';
}

function canvasActionErrorMessage(caught: unknown, kind: SkillCanvasActionKind): string {
  const code = isRecord(caught) && typeof caught.code === 'string' ? caught.code : undefined;
  if (code === 'PERMISSION_DENIED') return '本地保存权限不足，生成节点未能保存或启动。请检查项目目录权限后重试。';
  if (code === 'RECOVERY_REQUIRED') return '项目需要先完成恢复，未创建生成节点。请恢复项目后重试。';
  if (code === 'PROJECT_SAVE_CONFLICT' || code === 'PROJECT_CONFIG_SAVE_FAILED') return '项目保存未完成，未创建生成节点。请先解决保存问题后重试。';
  return `${canvasActionLabel(kind)}节点执行失败，请检查模型配置后重试。`;
}

function skillChatErrorMessage(caught: unknown): string {
  if (caught instanceof ProviderOperationTimeoutError) return '请求超时，请检查网络后重试。';
  const code = isRecord(caught) && typeof caught.code === 'string' ? caught.code : undefined;
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
