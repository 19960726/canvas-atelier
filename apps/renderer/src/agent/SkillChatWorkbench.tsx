import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type ClipboardEvent } from 'react';
import { Bot, Diamond, Grid3X3, Plus, RotateCcw, Send, X } from 'lucide-react';
import type { ChatSkillBridgeResult, ProviderBridgeProfile } from '@agent-canvas/desktop-core';
import type { KnowledgeBaseStateSummary } from '@agent-canvas/skill-store';
import type { ImageMentionValue, MentionableImageReference } from './ImageMentionComposer';
import { reduceTransientPopover } from '../app/transient-popover';
import { listAgentChatProfiles, listCodexAgentProfiles } from '../app/provider-profiles';
import { ProviderOperationTimeoutError, withProviderOperationTimeout } from '../settings/provider-operation-timeout';
import { MediaMentionTextarea } from '../mentions/MediaMentionTextarea';
import {
  createAgentConversation,
  deriveAgentConversationTitle,
  readAgentConversationCollection,
  writeAgentConversationCollection,
  type StoredAgentConversation,
} from './skill-chat-session-store';

type SkillMessage = {
  readonly id: string;
  readonly role: 'user' | 'assistant';
  readonly content: string;
  readonly sources?: Readonly<ChatSkillBridgeResult['sources']>;
  readonly request?: SkillRequestSummary;
};

type SkillRequestStatus = 'sending' | 'completed' | 'error';

type SkillChatMentionReference = MentionableImageReference & {
  readonly kind: 'image' | 'video';
  readonly mentionPosition: number;
};

export interface SkillChatRequest {
  readonly provider: ProviderBridgeProfile['provider'];
  readonly modelRoute: string;
  readonly messages: readonly { readonly role: 'user' | 'assistant'; readonly content: string }[];
  readonly context: { readonly knowledgeBaseIds: readonly string[]; readonly projectMemoryIds: readonly string[] };
  readonly referenceAssetIds?: readonly string[];
  readonly referenceMentions?: readonly { readonly assetId: string; readonly label: string; readonly mention: string }[];
  readonly agentMode?: 'chat' | 'original' | 'codex';
  readonly visualAnalysis?: boolean;
}

type SkillRequestSummary = {
  readonly modelDisplayName: string;
  readonly modelRoute: string;
  readonly knowledgeBaseCount: number;
  readonly projectMemoryCount: number;
  readonly references: readonly { readonly assetId: string; readonly label: string }[];
  readonly status: SkillRequestStatus;
  readonly visualAnalysis?: boolean;
};

export interface SkillWorkflowDraftRequest {
  readonly analysis: string;
  readonly references: readonly { readonly assetId: string; readonly label: string; readonly mention: string }[];
  readonly modelRoute?: string;
  readonly modelRouteDisplayName?: string;
}

const IMAGE_MENTION_CAPABILITY_ERROR = '当前模型不支持图片引用，请切换具备视觉能力的聊天模型。';
const MEDIA_CAPABILITY_ERROR = '当前模型不支持图片或视频，请切换视觉模型后再引用';
const MEDIA_CAPABILITY_ERRORS = new Set([IMAGE_MENTION_CAPABILITY_ERROR, MEDIA_CAPABILITY_ERROR]);
const AGENT_REQUEST_TIMEOUT_MS = 30_000;
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
}

export interface SkillChatWorkbenchProps {
  readonly projectId: string;
  readonly profiles: readonly ProviderBridgeProfile[];
  readonly knowledgeBases: readonly KnowledgeBaseStateSummary[];
  readonly projectMemoryIds: readonly string[];
  readonly reverseTimeline: readonly ReverseTimelineEntry[];
  readonly referenceImages?: readonly SkillChatReferenceImage[];
  readonly referenceVideos?: readonly SkillChatReferenceVideo[];
  readonly onImportReferenceImage?: (file?: File) => Promise<SkillChatReferenceImage | null>;
  readonly onImportReferenceVideo?: (file?: File) => Promise<SkillChatReferenceVideo | null>;
  readonly canvasActionTargets?: readonly SkillCanvasActionTarget[];
  readonly executeCanvasAction?: (request: SkillCanvasActionRequest) => Promise<boolean>;
  readonly draftWorkflowFromAnalysis?: (request: SkillWorkflowDraftRequest) => void;
  readonly onClose?: () => void;
  readonly chat: (request: SkillChatRequest) => Promise<ChatSkillBridgeResult>;
}

export function SkillChatWorkbench({
  projectId,
  profiles,
  knowledgeBases,
  projectMemoryIds,
  reverseTimeline,
  referenceImages = [],
  referenceVideos = [],
  onImportReferenceImage,
  onImportReferenceVideo,
  canvasActionTargets = [],
  executeCanvasAction,
  draftWorkflowFromAnalysis,
  onClose,
  chat,
}: SkillChatWorkbenchProps) {
  const chatProfiles = useMemo(
    () => listAgentChatProfiles(profiles),
    [profiles],
  );
  const availableKnowledge = useMemo(
    () => knowledgeBases.filter((knowledgeBase) => knowledgeBase.status === 'active'),
    [knowledgeBases],
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
  const [selectedProjectMemoryIds, setSelectedProjectMemoryIds] = useState<string[]>(() => initialConversation.projectMemoryIds.length > 0 ? [...initialConversation.projectMemoryIds] : [...projectMemoryIds]);
  const [messages, setMessages] = useState<SkillMessage[]>(() => [...initialConversation.messages]);
  const [composer, setComposer] = useState<ImageMentionValue>({ text: '', citations: [] });
  const [importedReferenceImages, setImportedReferenceImages] = useState<SkillChatReferenceImage[]>([]);
  const [importedReferenceVideos, setImportedReferenceVideos] = useState<SkillChatReferenceVideo[]>([]);
  const referenceFileInput = useRef<HTMLInputElement>(null);
  const [referenceImporting, setReferenceImporting] = useState(false);
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
  const [reasoningEffort, setReasoningEffort] = useState<'low' | 'medium' | 'high'>(initialConversation.reasoningEffort);
  const [error, setError] = useState<string | null>(null);
  const [pendingCanvasAction, setPendingCanvasAction] = useState<SkillCanvasActionRequest | null>(null);
  const [canvasActionRunning, setCanvasActionRunning] = useState(false);
  const [expandedReverseIds, setExpandedReverseIds] = useState<string[]>([]);
  const [dismissedWorkflowOfferIds, setDismissedWorkflowOfferIds] = useState<string[]>([]);
  const requestId = useRef(0);
  const selectedProfile = chatProfiles.find((profile) => profile.modelRoute === modelRoute);
  const codexProfiles = useMemo(() => listCodexAgentProfiles(chatProfiles), [chatProfiles]);
  const visibleChatProfiles = agentMode === 'codex' && codexProfiles.length > 0 ? codexProfiles : chatProfiles;
  useEffect(() => {
    if (activePopover === null) return undefined;
    const closeOnPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest([
        '.skill-chat-workbench__sheet',
        '.skill-chat-workbench__mention-menu',
        '[data-testid="knowledge-base-trigger"]',
        '[data-testid="agent-model-trigger"]',
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
  const supportsImageMentions = selectedProfile?.capabilities.includes('vision') === true;
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
    for (const video of [...referenceVideos, ...importedReferenceVideos]) byAssetId.set(video.assetId, video);
    return [...byAssetId.values()];
  }, [importedReferenceVideos, referenceVideos]);
  const allReferenceMedia = useMemo(() => [
    ...allReferenceImages.map((media) => ({ ...media, kind: 'image' as const })),
    ...allReferenceVideos.map((media) => ({ ...media, kind: 'video' as const })),
  ], [allReferenceImages, allReferenceVideos]);
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
    ...allReferenceVideos.map((media, mentionPosition) => ({
      assetId: media.assetId,
      label: media.label,
      displayUrl: media.displayUrl,
      position: allReferenceImages.length + mentionPosition,
      mentionPosition,
      kind: 'video' as const,
      role: 'product_identity' as const,
    })),
  ], [allReferenceImages, allReferenceVideos]);
  const mentionPreviews = useMemo(() => mentionReferences.map((reference) => ({
    token: skillChatMentionToken(reference.kind, reference.mentionPosition),
    label: reference.label,
    displayUrl: reference.displayUrl,
    kind: reference.kind,
  })), [mentionReferences]);
  const toggleImageMention = (reference: SkillChatMentionReference) => {
    if (!supportsImageMentions) {
      setError(IMAGE_MENTION_CAPABILITY_ERROR);
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
      const text = current.text.endsWith('@')
        ? `${current.text.slice(0, -1)}${mentionToken}`
        : current.text.trimEnd().length === 0 ? mentionToken : `${current.text.trimEnd()} ${mentionToken}`;
      return { text, citations: [...current.citations, { assetId: reference.assetId, label: reference.label }] };
    });
  };
  const updateComposerText = (text: string) => {
    const openedMention = didInsertMentionToken(composer.text, text);
    setComposer((current) => ({
      text,
      citations: current.citations.filter((citation) => {
        const reference = mentionReferences.find((candidate) => candidate.assetId === citation.assetId);
        return reference !== undefined && text.includes(skillChatMentionToken(reference.kind, reference.mentionPosition));
      }),
    }));
    if (!openedMention) {
      if (!text.includes('@')) dispatchPopover({ type: 'close-external' });
      return;
    }
    if (!supportsImageMentions) {
      setError(IMAGE_MENTION_CAPABILITY_ERROR);
      return;
    }
    if (mentionReferences.length > 0) {
      setError(null);
      dispatchPopover({ type: 'open', id: 'reference' });
    }
  };
  const attachImportedReference = (imported: SkillChatReferenceImage | SkillChatReferenceVideo, kind: 'image' | 'video') => {
    if (!supportsImageMentions) {
      setError('\u5f53\u524d\u6a21\u578b\u4e0d\u652f\u6301\u56fe\u7247\u6216\u89c6\u9891\uff0c\u8bf7\u5207\u6362\u89c6\u89c9\u6a21\u578b\u540e\u518d\u5f15\u7528');
      return;
    }
    setComposer((current) => {
      if (current.citations.some((citation) => citation.assetId === imported.assetId) || current.citations.length >= 20) return current;
      const sameKindMedia = kind === 'image' ? allReferenceImages : allReferenceVideos;
      const importedPosition = sameKindMedia.findIndex((media) => media.assetId === imported.assetId);
      const mentionToken = skillChatMentionToken(kind, importedPosition >= 0 ? importedPosition : sameKindMedia.length);
      const text = current.text.trimEnd().length === 0 ? mentionToken : `${current.text.trimEnd()} ${mentionToken}`;
      return { text, citations: [...current.citations, { assetId: imported.assetId, label: imported.label }] };
    });
    setError(null);
  };
  const importReferenceFile = async (file?: File) => {
    if (referenceImporting) return;
    const isVideo = file !== undefined && (file.type.startsWith('video/') || /\.(?:mp4|webm|mov)$/iu.test(file.name));
    const importer = isVideo ? onImportReferenceVideo : onImportReferenceImage;
    if (importer === undefined) return;
    setReferenceImporting(true);
    try {
      const imported = await importer(file);
      if (imported === null) return;
      if (isVideo) setImportedReferenceVideos((current) => [...current.filter((video) => video.assetId !== imported.assetId), imported]);
      else setImportedReferenceImages((current) => [...current.filter((image) => image.assetId !== imported.assetId), imported]);
      attachImportedReference(imported, isVideo ? 'video' : 'image');
    } catch {
      setError('\u7d20\u6750\u5bfc\u5165\u5931\u8d25\uff0c\u8bf7\u91cd\u8bd5\u3002');
    } finally {
      setReferenceImporting(false);
    }
  };
  const requestReferenceImport = () => {
    const nativeDesktopPicker = globalThis.window?.novusDesktop !== undefined && globalThis.window.__NOVUS_MANUAL_ACCEPTANCE__ !== true;
    if (nativeDesktopPicker) void importReferenceFile();
    else referenceFileInput.current?.click();
  };
  const handleComposerPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const file = [...event.clipboardData.files].find((candidate) => candidate.type.startsWith('image/') || candidate.type.startsWith('video/'));
    if (file === undefined) return;
    event.preventDefault();
    void importReferenceFile(file);
  };

  useEffect(() => {
    setModelRoute((current) => (
      current && chatProfiles.some((profile) => profile.modelRoute === current)
        ? current
        : chatProfiles.find((profile) => profile.modelRoute === 'chat-default')?.modelRoute ?? chatProfiles[0]?.modelRoute
    ));
  }, [chatProfiles]);

  useEffect(() => {
    const selectableIds = new Set<string>(REQUIRED_AGENT_KNOWLEDGE_CHOICES.map((item) => item.knowledgeBaseId));
    setSelectedKnowledgeBaseIds((current) => {
      const next = current.filter((id) => selectableIds.has(id));
      return sameStringList(current, next) ? current : next;
    });
  }, [projectId]);

  useEffect(() => {
    const availableIds = new Set(projectMemoryIds);
    setSelectedProjectMemoryIds((current) => {
      const next = current.filter((id) => availableIds.has(id));
      return sameStringList(current, next) ? current : next;
    });
  }, [projectMemoryIds]);

  useEffect(() => {
    const receiveGeneratedImage = (event: Event) => {
      const assetId = (event as CustomEvent<{ assetId?: unknown }>).detail?.assetId;
      if (typeof assetId !== 'string') return;
      const reference = mentionReferences.find((candidate) => candidate.assetId === assetId);
      if (reference === undefined) return;
      if (!supportsImageMentions) {
        setError(IMAGE_MENTION_CAPABILITY_ERROR);
        return;
      }
      setComposer((current) => {
        if (current.citations.some((citation) => citation.assetId === reference.assetId)) return current;
        if (current.citations.length >= 20) return current;
        const mentionToken = skillChatMentionToken(reference.kind, reference.mentionPosition);
        return {
          text: current.text.trimEnd().length === 0 ? mentionToken : `${current.text.trimEnd()} ${mentionToken}`,
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
        reasoningEffort,
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
  }, [activeConversationId, agentMode, messages, modelRoute, projectId, reasoningEffort, selectedKnowledgeBaseIds, selectedProjectMemoryIds]);

  const activateConversation = (conversationId: string) => {
    const conversation = conversationCollection.conversations.find((candidate) => candidate.id === conversationId);
    if (conversation === undefined || conversation.id === activeConversationId) return;
    requestId.current += 1;
    setActiveConversationId(conversation.id);
    setModelRoute(conversation.modelRoute ?? chatProfiles.find((profile) => profile.modelRoute === 'chat-default')?.modelRoute ?? chatProfiles[0]?.modelRoute);
    setSelectedKnowledgeBaseIds([...conversation.knowledgeBaseIds]);
    setSelectedProjectMemoryIds([...conversation.projectMemoryIds]);
    setMessages([...conversation.messages]);
    setAgentMode(conversation.mode);
    setReasoningEffort(conversation.reasoningEffort);
    setComposer({ text: '', citations: [] });
    setStatus('idle');
    setPendingCanvasAction(null);
    setCanvasActionRunning(false);
    setError(null);
    dispatchPopover({ type: 'close-external' });
  };

  const createConversation = () => {
    requestId.current += 1;
    let now = Date.now();
    while (conversationCollection.conversations.some((conversation) => conversation.id === `conversation-${now}`)) now += 1;
    const created: StoredAgentConversation = {
      ...createAgentConversation(now),
      ...(chatProfiles[0]?.modelRoute === undefined ? {} : { modelRoute: chatProfiles[0].modelRoute }),
      projectMemoryIds: [...projectMemoryIds],
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
    setReasoningEffort(created.reasoningEffort);
    setComposer({ text: '', citations: [] });
    setStatus('idle');
    setPendingCanvasAction(null);
    setCanvasActionRunning(false);
    setError(null);
    dispatchPopover({ type: 'close-external' });
  };

  const send = async () => {
    const content = composer.text.trim();
    if (!content || !modelRoute || status === 'sending') return;
    const selectedReferences = composer.citations
      .map((citation) => mentionReferences.find((reference) => reference.assetId === citation.assetId && reference.label === citation.label))
      .filter((reference): reference is SkillChatMentionReference => reference !== undefined)
      .slice(0, 20)
      .map(({ assetId, label }, index) => ({ assetId, label, mention: `@图片${index + 1}` }));
    if (selectedReferences.length > 0 && !supportsImageMentions) {
      setError(IMAGE_MENTION_CAPABILITY_ERROR);
      return;
    }
    const actionKind = detectCanvasActionKind(content);
    if (actionKind !== null && executeCanvasAction !== undefined) {
      const target = resolveCanvasActionTarget(canvasActionTargets, actionKind);
      setMessages((current) => [...current, { id: createMessageId(), role: 'user', content }]);
      setComposer({ text: '', citations: [] });
      dispatchPopover({ type: 'close-external' });
      if (target === null) {
        setPendingCanvasAction(null);
        setError(`请先在画布中选择一个${canvasActionLabel(actionKind)}节点。`);
        return;
      }
      setError(null);
      setPendingCanvasAction({ kind: actionKind, nodeId: target.nodeId, prompt: content });
      return;
    }
    const userMessage: SkillMessage = {
      id: createMessageId(),
      role: 'user',
      content,
      request: {
        modelDisplayName: selectedProfile?.displayName ?? modelRoute,
        modelRoute,
        knowledgeBaseCount: selectedKnowledgeBaseIds.length,
        projectMemoryCount: selectedProjectMemoryIds.length,
        references: selectedReferences.map(({ assetId, label }) => ({ assetId, label })),
        status: 'sending',
        visualAnalysis: shouldUseVisualAnalysis(agentMode, content, selectedReferences.length),
      },
    };
    const nextMessages = [...messages, userMessage];
    const retryComposer = composer;
    const activeKnowledgeBaseIds = new Set(availableKnowledge.map((knowledgeBase) => knowledgeBase.knowledgeBaseId));
    const activeRequestId = requestId.current + 1;
    requestId.current = activeRequestId;
    dispatchPopover({ type: 'close-external' });
    setMessages(nextMessages);
    setComposer({ text: '', citations: [] });
    setError(null);
    setStatus('sending');
    try {
      const result = await withProviderOperationTimeout(chat({
        provider: selectedProfile?.provider ?? 'comfly',
        modelRoute,
        messages: nextMessages.map(({ role, content: messageContent }) => ({ role, content: messageContent })),
        context: {
          knowledgeBaseIds: selectedKnowledgeBaseIds.filter((knowledgeBaseId) => activeKnowledgeBaseIds.has(knowledgeBaseId)),
          projectMemoryIds: [...selectedProjectMemoryIds],
        },
        ...(selectedReferences.length > 0 ? { referenceAssetIds: selectedReferences.map((reference) => reference.assetId) } : {}),
        ...(selectedReferences.length > 0 ? { referenceMentions: selectedReferences } : {}),
        agentMode,
        ...(agentMode === 'codex' ? { reasoningEffort } : {}),
        visualAnalysis: shouldUseVisualAnalysis(agentMode, content, selectedReferences.length),
      }), AGENT_REQUEST_TIMEOUT_MS);
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
    }
  };

  const confirmCanvasAction = async () => {
    if (pendingCanvasAction === null || executeCanvasAction === undefined || canvasActionRunning) return;
    const action = pendingCanvasAction;
    setCanvasActionRunning(true);
    setError(null);
    try {
      const started = await executeCanvasAction(action);
      if (!started) {
        setError(`${canvasActionLabel(action.kind)}节点未能启动，请检查模型配置后重试。`);
        return;
      }
      setMessages((current) => [...current, {
        id: createMessageId(),
        role: 'assistant',
        content: `${canvasActionLabel(action.kind)}节点已开始运行。`,
      }]);
      setPendingCanvasAction(null);
    } catch {
      setError(`${canvasActionLabel(action.kind)}节点执行失败，请检查模型配置后重试。`);
    } finally {
      setCanvasActionRunning(false);
    }
  };

  return (
    <section className="skill-chat-workbench" aria-label="Agent 对话工作台">
      <header className="skill-chat-workbench__header skill-chat-workbench__header--codex">
        <div>
          <h2>Codex Agent <small>画布接入</small></h2>
          <p><i aria-hidden="true" />运行就绪</p>
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
                      setModelRoute(profile.modelRoute);
                      dispatchPopover({ type: 'close-external' });
                    }}
                  >
                    <strong>{providerModelLabel(profile, chatProfiles)}</strong>
                    <span>{selected ? '当前选择' : '选择此模型'}</span>
                  </button>
                </div>
              );
            })}
          </div>
        </section>
      )}

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
            {projectMemoryIds.map((memoryId) => {
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
              {projectMemoryIds.length === 0 && <p>没有可选项目记忆。</p>}
              {projectMemoryIds.map((memoryId) => (
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
        {reverseTimeline.length > 0 && (
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
              {chatProfiles.length === 0 ? (
                <>
                  <strong>请先在设置中配置聊天模型</strong>
                  <p>在设置中添加具备聊天能力的模型路线。Agent 只提供建议，不会修改画布。</p>
                </>
              ) : (
                <>
                  <div className="skill-chat-workbench__figma-intro skill-chat-workbench__figma-intro--codex">
                    <i aria-hidden="true"><Bot size={22} strokeWidth={1.6} /></i>
                    <strong>Codex 已接入当前画布</strong>
                    <p>它会读取画布上下文，通过 CanvasForge MCP 完成操作。命令和文件改写会按确认流程执行。</p>
                  </div>
              {chatProfiles.length > 0 && (
                <div className="skill-chat-workbench__suggestions" aria-label="推荐 Skill">
                  <button type="button" aria-label="分析当前画布" onClick={() => setComposer({ text: '分析当前画布并指出下一步可优化的节点。', citations: [] })}>
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
            return (
            <article key={message.id} className={`skill-chat-workbench__message skill-chat-workbench__message--${message.role}`}>
              <span>{message.role === 'user' ? '你的请求' : 'Agent 建议'}</span>
              <p>{message.content}</p>
              {message.request && (
                <section className={`skill-chat-workbench__request-card is-${message.request.status}`} aria-label={`知识库请求: ${message.request.modelDisplayName}`}>
                  <header><strong>知识库请求</strong><span>{message.request.status === 'sending' ? '发送中' : message.request.status === 'completed' ? '已完成' : '失败'}</span></header>
                  <p>{message.request.modelDisplayName}</p>
                  <small>知识库 {message.request.knowledgeBaseCount} · 项目记忆 {message.request.projectMemoryCount}</small>
                  {message.request.references.length > 0 && <div>{message.request.references.map((reference) => <span key={reference.assetId}>@{reference.label}</span>)}</div>}
                </section>
              )}
              {message.sources && message.sources.length > 0 && (
                <section className="skill-chat-workbench__sources" aria-label="来源">
                  {message.sources.map((source) => (
                    <small key={`${source.knowledgeBaseId}@${source.version}`}>来源 · {source.displayName ?? source.knowledgeBaseId} v{source.version}</small>
                  ))}
                </section>
              )}
              {workflowOffer && (
                <section className="skill-chat-workbench__workflow-offer" aria-label={reverseWorkflowOffer ? '反推工作流建议' : 'Codex 工作流建议'}>
                  <strong>{reverseWorkflowOffer ? '是否基于本次反推生成工作流？' : '是否基于本次方案生成工作流？'}</strong>
                  <p>会先生成可预览方案；创建节点、连线和运行仍需你再次确认。</p>
                  <div>
                    <button type="button" onClick={() => {
                      draftWorkflowFromAnalysis?.({
                        analysis: message.content,
                        references: workflowReferences,
                        modelRoute: precedingMessage.request?.modelRoute,
                        modelRouteDisplayName: precedingMessage.request?.modelDisplayName,
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
          {pendingCanvasAction && (
            <article className="skill-chat-workbench__message skill-chat-workbench__message--assistant" aria-label="待确认画布操作">
              <span>等待确认</span>
              <p>将在节点 {pendingCanvasAction.nodeId} 执行{canvasActionLabel(pendingCanvasAction.kind)}。</p>
              <section className="skill-chat-workbench__request-card is-sending">
                <header><strong>画布操作</strong><span>待确认</span></header>
                <div>
                  <button type="button" aria-label={`确认执行${canvasActionLabel(pendingCanvasAction.kind)}`} disabled={canvasActionRunning} onClick={() => void confirmCanvasAction()}>确认执行</button>
                  <button type="button" aria-label="取消画布操作" disabled={canvasActionRunning} onClick={() => setPendingCanvasAction(null)}>取消</button>
                </div>
              </section>
            </article>
          )}
        </section>
        {status === 'sending' && <p className="skill-chat-workbench__status" role="status">正在生成建议…</p>}
        {error && <p className="skill-chat-workbench__error" role="alert">{error}</p>}
      </div>

      <form className="skill-chat-workbench__composer" onSubmit={(event) => { event.preventDefault(); void send(); }}>
        <label>
          <span className="sr-only">向 Agent 发送消息</span>
          <MediaMentionTextarea
            data-testid="agent-composer-input"
            aria-label="向 Agent 发送消息"
            value={composer.text}
            mentions={mentionPreviews}
            rows={3}
            placeholder="告诉 Codex 要在当前画布上完成什么"
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
          <input ref={referenceFileInput} className="sr-only" data-testid="agent-reference-file-input" type="file" accept="image/*,video/mp4,video/webm,video/quicktime" tabIndex={-1} onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void importReferenceFile(file); }} />
          <button type="button" className="skill-chat-workbench__tool" aria-label="添加素材" title="导入项目图片或视频" disabled={(onImportReferenceImage === undefined && onImportReferenceVideo === undefined) || referenceImporting} onClick={requestReferenceImport}><Plus size={14} strokeWidth={1.6} /></button>
          <div className="skill-chat-workbench__mode-tabs" role="tablist" aria-label="Agent 模式">
            {([['chat', '对话'], ['original', '原智能'], ['codex', 'Codex']] as const).map(([mode, label]) => <button key={mode} type="button" role="tab" aria-selected={agentMode === mode} className={agentMode === mode ? 'is-active' : undefined} onClick={() => {
              setAgentMode(mode);
              if (mode === 'codex' && codexProfiles.length > 0 && !codexProfiles.some((profile) => profile.modelRoute === modelRoute)) setModelRoute(codexProfiles[0]?.modelRoute);
            }}>{label}</button>)}
          </div>
          <button type="button" className="skill-chat-workbench__model-pill" data-testid="agent-model-trigger" aria-label="打开聊天模型菜单" data-selected-model={selectedProfile?.displayName ?? '未配置'} onClick={() => dispatchPopover({ type: 'open', id: 'model' })}>{selectedProfile ? providerModelLabel(selectedProfile, chatProfiles) : agentMode === 'codex' ? '未发现 Codex 模型' : '选择模型'}</button>
          {agentMode === 'codex' && <select className="skill-chat-workbench__effort" aria-label="推理强度" value={reasoningEffort} onChange={(event) => setReasoningEffort(event.target.value as typeof reasoningEffort)}><option value="low">快</option><option value="medium">中</option><option value="high">深</option></select>}
          <div className="skill-chat-workbench__composer-actions">
            <button type="button" className="skill-chat-workbench__tool skill-chat-workbench__knowledge-compact" data-testid="knowledge-base-trigger" aria-label="打开知识库" onClick={() => dispatchPopover({ type: 'open', id: 'knowledge' })}><Grid3X3 size={14} strokeWidth={1.6} /></button>
            <button type="button" className="skill-chat-workbench__tool" aria-label="新建对话" onClick={createConversation}><RotateCcw size={14} strokeWidth={1.6} /></button>
            <button type="submit" disabled={!draft.trim() || !modelRoute || status === 'sending'} aria-label="发送"><Send size={16} strokeWidth={1.8} /></button>
          </div>
        </div>
      </form>
    </section>
  );
}

function skillChatMentionToken(kind: 'image' | 'video', position: number): string {
  if (position < 0) return '';
  return `@${kind === 'image' ? '图片' : '视频'}${position + 1}`;
}
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

function resolveCanvasActionTarget(
  targets: readonly SkillCanvasActionTarget[],
  kind: SkillCanvasActionKind,
): SkillCanvasActionTarget | null {
  const matches = targets.filter((target) => target.kind === kind);
  return matches.find((target) => target.selected) ?? (matches.length === 1 ? matches[0]! : null);
}

function canvasActionLabel(kind: SkillCanvasActionKind): string {
  if (kind === 'image_generation') return '生图';
  if (kind === 'video_generation') return '视频生成';
  return '反推';
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

function providerModelLabel(profile: ProviderBridgeProfile, _profiles: readonly ProviderBridgeProfile[]): string {
  const identity = `${profile.modelRoute} ${profile.modelId ?? ''}`.toLocaleLowerCase();
  if (!identity.includes('codex')) return profile.displayName;
  const variant = identity.match(/(?:^|[-_/])(low|medium|high|minimal|max)(?:$|[-_/])/u)?.[1];
  if (!variant || profile.displayName.toLocaleLowerCase().includes(variant)) return profile.displayName;
  return `${profile.displayName} · ${variant}`;
}

function sameStringList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
