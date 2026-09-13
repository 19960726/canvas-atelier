export type AgentConversationMode = 'chat' | 'original' | 'codex';
export type AgentReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';
export type ReverseAnalysisDepth = 'fast' | 'standard' | 'deep';
export type StoredAgentRequestStatus = 'sending' | 'completed' | 'error';

export interface StoredAgentMessageSource {
  readonly knowledgeBaseId: string;
  readonly version: number;
  readonly displayName?: string;
}

export interface StoredAgentRequestSummary {
  readonly modelDisplayName: string;
  readonly modelRoute: string;
  readonly knowledgeBaseCount: number;
  readonly projectMemoryCount: number;
  readonly references: readonly { readonly assetId: string; readonly label: string }[];
  readonly status: StoredAgentRequestStatus;
  readonly visualAnalysis?: boolean;
  readonly generationKind?: 'image' | 'video';
}

export interface StoredAgentMessage {
  readonly id: string;
  readonly role: 'user' | 'assistant';
  readonly content: string;
  readonly mode?: AgentConversationMode;
  readonly canvasNodeLabel?: string;
  readonly sources?: readonly StoredAgentMessageSource[];
  readonly request?: StoredAgentRequestSummary;
}

export interface StoredAgentConversation {
  readonly id: string;
  readonly title: string;
  readonly mode: AgentConversationMode;
  readonly reasoningEfforts: Readonly<Record<AgentConversationMode, AgentReasoningEffort>>;
  readonly reverseAnalysisDepth: ReverseAnalysisDepth;
  readonly modelRoute?: string;
  readonly knowledgeBaseIds: readonly string[];
  readonly projectMemoryIds: readonly string[];
  readonly messages: readonly StoredAgentMessage[];
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface StoredAgentConversationCollection {
  readonly version: 2;
  readonly activeConversationId: string;
  readonly conversations: readonly StoredAgentConversation[];
}

interface LegacyStoredSkillChatSession {
  readonly version: 1;
  readonly modelRoute?: string;
  readonly knowledgeBaseIds?: readonly string[];
  readonly projectMemoryIds?: readonly string[];
  readonly messages: readonly StoredAgentMessage[];
}

const LEGACY_SESSION_PREFIX = 'agent-canvas:skill-chat:';
const COLLECTION_PREFIX = 'agent-canvas:skill-chat:v2:';
const MAX_CONVERSATIONS = 50;
const MAX_MESSAGES = 48;
const MAX_TEXT_LENGTH = 16_000;

export function createAgentConversation(now = Date.now()): StoredAgentConversation {
  return {
    id: `conversation-${now}`,
    title: '新任务',
    mode: 'codex',
    reasoningEfforts: { chat: 'medium', original: 'medium', codex: 'medium' },
    reverseAnalysisDepth: 'standard',
    knowledgeBaseIds: [],
    projectMemoryIds: [],
    messages: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function deriveAgentConversationTitle(content: string): string {
  const normalized = (readSafeMessageContent(content, MAX_TEXT_LENGTH) ?? '').replace(/\s+/gu, ' ');
  return Array.from(normalized).slice(0, 18).join('') || '新任务';
}

export function addAgentConversation(
  collection: StoredAgentConversationCollection,
  created: StoredAgentConversation,
): StoredAgentConversationCollection {
  const existing = collection.conversations.filter((conversation) => conversation.id !== created.id);
  const retainedIds = new Set([...existing]
    .sort((left, right) => right.updatedAt - left.updatedAt || right.createdAt - left.createdAt)
    .slice(0, MAX_CONVERSATIONS - 1)
    .map((conversation) => conversation.id));
  return {
    version: 2,
    activeConversationId: created.id,
    conversations: [...existing.filter((conversation) => retainedIds.has(conversation.id)), created],
  };
}

export function readAgentConversationCollection(
  projectId: string,
  now = Date.now(),
): StoredAgentConversationCollection {
  const empty = createEmptyCollection(now);
  try {
    const stored = window.localStorage.getItem(collectionKey(projectId));
    if (stored !== null) return parseCollection(JSON.parse(stored), empty);
  } catch {
    return empty;
  }

  const migrated = readLegacySession(projectId, now);
  if (migrated === null) return empty;
  writeAgentConversationCollection(projectId, migrated);
  return migrated;
}

export function writeAgentConversationCollection(
  projectId: string,
  collection: StoredAgentConversationCollection,
): void {
  const parsed = parseCollection(collection, createEmptyCollection(Date.now()));
  try {
    window.localStorage.setItem(collectionKey(projectId), JSON.stringify(parsed));
  } catch {
    // Conversation recovery must never make Agent chat unavailable.
  }
}

function readLegacySession(projectId: string, now: number): StoredAgentConversationCollection | null {
  try {
    const stored = window.sessionStorage.getItem(legacySessionKey(projectId));
    if (stored === null) return null;
    const session = parseLegacySession(JSON.parse(stored));
    if (session === null) return null;
    const firstUserMessage = session.messages.find((message) => message.role === 'user');
    const conversation: StoredAgentConversation = {
      ...createAgentConversation(now),
      title: firstUserMessage === undefined ? '新任务' : deriveAgentConversationTitle(firstUserMessage.content),
      ...(session.modelRoute === undefined ? {} : { modelRoute: session.modelRoute }),
      knowledgeBaseIds: session.knowledgeBaseIds ?? [],
      projectMemoryIds: session.projectMemoryIds ?? [],
      messages: session.messages,
    };
    return { version: 2, activeConversationId: conversation.id, conversations: [conversation] };
  } catch {
    return null;
  }
}

function createEmptyCollection(now: number): StoredAgentConversationCollection {
  const conversation = createAgentConversation(now);
  return { version: 2, activeConversationId: conversation.id, conversations: [conversation] };
}

function parseCollection(
  value: unknown,
  fallback: StoredAgentConversationCollection,
): StoredAgentConversationCollection {
  if (!isRecord(value) || value.version !== 2 || !Array.isArray(value.conversations)) return fallback;
  if (value.conversations.length < 1) return fallback;
  const activeConversationId = readSafeText(value.activeConversationId, 160);
  if (activeConversationId === undefined) return fallback;
  const recentConversations = value.conversations.length <= MAX_CONVERSATIONS
    ? value.conversations
    : retainActiveConversation(value.conversations, activeConversationId);
  const conversations = recentConversations.map(parseConversation);
  if (conversations.some((conversation) => conversation === null)) return fallback;
  const safeConversations = conversations as StoredAgentConversation[];
  if (new Set(safeConversations.map((conversation) => conversation.id)).size !== safeConversations.length) return fallback;
  if (!safeConversations.some((conversation) => conversation.id === activeConversationId)) return fallback;
  return { version: 2, activeConversationId, conversations: safeConversations };
}

function retainActiveConversation(value: readonly unknown[], activeConversationId: string): readonly unknown[] {
  const recent = value.slice(-MAX_CONVERSATIONS);
  if (recent.some((conversation) => isRecord(conversation) && conversation.id === activeConversationId)) return recent;
  const active = value.find((conversation) => isRecord(conversation) && conversation.id === activeConversationId);
  return active === undefined ? recent : [active, ...value.slice(-(MAX_CONVERSATIONS - 1))];
}

function parseConversation(value: unknown): StoredAgentConversation | null {
  if (!isRecord(value)) return null;
  const id = readSafeText(value.id, 160);
  const title = readSafeText(value.title, 160);
  const mode = parseMode(value.mode);
  const reasoningEfforts = parseReasoningEfforts(value.reasoningEfforts, value.mode, value.reasoningEffort);
  const reverseAnalysisDepth = parseReverseAnalysisDepth(value.reverseAnalysisDepth) ?? 'standard';
  const modelRoute = value.modelRoute === undefined ? undefined : readSafeText(value.modelRoute, 160);
  const knowledgeBaseIds = readSafeTextList(value.knowledgeBaseIds, 16, 160);
  const projectMemoryIds = readSafeTextList(value.projectMemoryIds, 32, 160);
  const messages = mode === null ? null : parseMessages(value.messages, mode);
  if (!id || !title || mode === null || reasoningEfforts === null || (value.modelRoute !== undefined && !modelRoute)
    || knowledgeBaseIds === null || projectMemoryIds === null || messages === null
    || !isSafeTimestamp(value.createdAt) || !isSafeTimestamp(value.updatedAt)) return null;
  return {
    id,
    title,
    mode,
    reasoningEfforts,
    reverseAnalysisDepth,
    ...(modelRoute === undefined ? {} : { modelRoute }),
    knowledgeBaseIds,
    projectMemoryIds,
    messages,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function parseLegacySession(value: unknown): LegacyStoredSkillChatSession | null {
  if (!isRecord(value) || value.version !== 1) return null;
  const messages = parseMessages(value.messages, 'codex');
  const modelRoute = value.modelRoute === undefined ? undefined : readSafeText(value.modelRoute, 160);
  const knowledgeBaseIds = value.knowledgeBaseIds === undefined ? undefined : readSafeTextList(value.knowledgeBaseIds, 16, 160);
  const projectMemoryIds = value.projectMemoryIds === undefined ? undefined : readSafeTextList(value.projectMemoryIds, 32, 160);
  if (messages === null || knowledgeBaseIds === null || projectMemoryIds === null
    || (value.modelRoute !== undefined && !modelRoute)) return null;
  return {
    version: 1,
    ...(modelRoute === undefined ? {} : { modelRoute }),
    ...(knowledgeBaseIds === undefined ? {} : { knowledgeBaseIds }),
    ...(projectMemoryIds === undefined ? {} : { projectMemoryIds }),
    messages,
  };
}

function parseMessages(value: unknown, fallbackMode: AgentConversationMode): StoredAgentMessage[] | null {
  if (!Array.isArray(value)) return null;
  return selectMessagesForStorage(value)
    .map((message) => parseMessage(message, fallbackMode))
    .filter((message): message is StoredAgentMessage => message !== null);
}

function selectMessagesForStorage(value: readonly unknown[]): unknown[] {
  if (value.length <= MAX_MESSAGES) return [...value];
  const indexed = value.map((message, index) => ({ message, index }));
  const regularMessages = indexed.filter(({ message }) => (
    !isRecord(message) || typeof message.id !== 'string' || !message.id.startsWith('canvas-result:')
  ));
  const guaranteedRegularCount = Math.min(32, regularMessages.length);
  const markerCapacity = MAX_MESSAGES - guaranteedRegularCount;
  const newestResultMarkers: typeof indexed = [];
  const seenMarkerIds = new Set<string>();
  for (let index = indexed.length - 1; index >= 0 && newestResultMarkers.length < markerCapacity; index -= 1) {
    const candidate = indexed[index]!;
    if (!isRecord(candidate.message)) continue;
    const id = candidate.message.id;
    if (typeof id !== 'string' || !id.startsWith('canvas-result:') || seenMarkerIds.has(id)) continue;
    seenMarkerIds.add(id);
    newestResultMarkers.push(candidate);
  }
  const regularSlots = MAX_MESSAGES - newestResultMarkers.length;
  const newestRegularMessages = regularMessages.slice(-regularSlots);
  return [...newestResultMarkers, ...newestRegularMessages]
    .sort((left, right) => left.index - right.index)
    .map(({ message }) => message);
}

function parseMessage(value: unknown, fallbackMode: AgentConversationMode): StoredAgentMessage | null {
  if (!isRecord(value) || (value.role !== 'user' && value.role !== 'assistant')) return null;
  const id = readSafeText(value.id, 160);
  const content = readSafeMessageContent(value.content, MAX_TEXT_LENGTH);
  const mode = value.mode === undefined ? fallbackMode : parseMode(value.mode);
  const canvasNodeLabel = value.canvasNodeLabel === undefined ? undefined : readSafeText(value.canvasNodeLabel, 160);
  if (!id || !content || mode === null || (value.canvasNodeLabel !== undefined && canvasNodeLabel === undefined)) return null;
  const sources = value.sources === undefined ? undefined : parseSources(value.sources);
  const request = value.request === undefined ? undefined : parseRequest(value.request);
  if (sources === null || request === null) return null;
  return { id, role: value.role, content, mode, ...(canvasNodeLabel === undefined ? {} : { canvasNodeLabel }), ...(sources === undefined ? {} : { sources }), ...(request === undefined ? {} : { request }) };
}

function parseSources(value: unknown): StoredAgentMessageSource[] | null {
  if (!Array.isArray(value) || value.length > 16) return null;
  const sources = value.map((entry): StoredAgentMessageSource | null => {
    if (!isRecord(entry) || !Number.isInteger(entry.version) || (entry.version as number) < 1) return null;
    const knowledgeBaseId = readSafeText(entry.knowledgeBaseId, 160);
    const displayName = entry.displayName === undefined ? undefined : readSafeText(entry.displayName, 160);
    if (!knowledgeBaseId || (entry.displayName !== undefined && !displayName)) return null;
    return { knowledgeBaseId, version: entry.version as number, ...(displayName === undefined ? {} : { displayName }) };
  });
  return sources.some((source) => source === null) ? null : sources as StoredAgentMessageSource[];
}

function parseRequest(value: unknown): StoredAgentRequestSummary | null {
  if (!isRecord(value) || !Array.isArray(value.references)) return null;
  const modelDisplayName = readSafeText(value.modelDisplayName, 160);
  const modelRoute = readSafeText(value.modelRoute, 160);
  const references = value.references.map((entry) => {
    if (!isRecord(entry)) return null;
    const assetId = readSafeText(entry.assetId, 160);
    const label = readSafeText(entry.label, 160);
    return assetId && label ? { assetId, label } : null;
  });
  if (!modelDisplayName || !modelRoute || references.some((reference) => reference === null)
    || !isBoundedInteger(value.knowledgeBaseCount, 16) || !isBoundedInteger(value.projectMemoryCount, 32)
    || (value.status !== 'sending' && value.status !== 'completed' && value.status !== 'error')
    || (value.visualAnalysis !== undefined && typeof value.visualAnalysis !== 'boolean')
    || (value.generationKind !== undefined && value.generationKind !== 'image' && value.generationKind !== 'video')) return null;
  return {
    modelDisplayName,
    modelRoute,
    knowledgeBaseCount: value.knowledgeBaseCount as number,
    projectMemoryCount: value.projectMemoryCount as number,
    references: references as Array<{ assetId: string; label: string }>,
    status: value.status,
    ...(value.visualAnalysis === undefined ? {} : { visualAnalysis: value.visualAnalysis }),
    ...(value.generationKind === undefined ? {} : { generationKind: value.generationKind }),
  };
}

function parseMode(value: unknown): AgentConversationMode | null {
  return value === 'chat' || value === 'original' || value === 'codex' ? value : null;
}

function parseReasoningEffort(value: unknown): AgentReasoningEffort | null {
  return value === 'low' || value === 'medium' || value === 'high'
    || value === 'xhigh' || value === 'max' || value === 'ultra'
    ? value
    : null;
}

function parseReasoningEfforts(
  value: unknown,
  modeValue: unknown,
  legacyValue: unknown,
): Readonly<Record<AgentConversationMode, AgentReasoningEffort>> | null {
  const mode = parseMode(modeValue);
  if (isRecord(value)) {
    const chat = parseReasoningEffort(value.chat);
    const original = parseReasoningEffort(value.original);
    const codex = parseReasoningEffort(value.codex);
    return chat === null || original === null || codex === null ? null : { chat, original, codex };
  }
  const legacy = parseReasoningEffort(legacyValue);
  if (mode === null || legacy === null) return null;
  return { chat: 'medium', original: 'medium', codex: 'medium', [mode]: legacy };
}

function parseReverseAnalysisDepth(value: unknown): ReverseAnalysisDepth | null {
  return value === 'fast' || value === 'standard' || value === 'deep' ? value : null;
}

function readSafeTextList(value: unknown, limit: number, maxLength: number): string[] | null {
  if (!Array.isArray(value) || value.length > limit) return null;
  const texts = value.map((entry) => readSafeText(entry, maxLength));
  return texts.every((entry): entry is string => entry !== undefined) ? texts : null;
}

function readSafeText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength || containsProtectedText(trimmed)) return undefined;
  return trimmed;
}

function readSafeMessageContent(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) return undefined;
  const redacted = trimmed
    .replace(/data:[^,\s;]+(?:;[^,\s;]+)*;base64,[a-z0-9+/=]+/giu, '[图片数据已省略]')
    .replace(/(?:https?|file):\/\/[^\s<>"']+/giu, '[链接已省略]')
    .replace(/[A-Za-z]:\\[^\s<>"']+/gu, '[本地路径已省略]')
    .replace(/\\\\[^\\\s]+\\[^\s<>"']*/gu, '[网络路径已省略]')
    .trim();
  return redacted || '[受保护内容已省略]';
}

function containsProtectedText(value: string): boolean {
  return /(?:https?|file):\/\//iu.test(value)
    || /[A-Za-z]:\\/u.test(value)
    || /\\\\[^\\\s]+\\/u.test(value)
    || /data:[^,\s;]+(?:;[^,\s;]+)*;base64,/iu.test(value);
}

function isSafeTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isBoundedInteger(value: unknown, maximum: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= maximum;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function collectionKey(projectId: string): string {
  return `${COLLECTION_PREFIX}${encodeURIComponent(projectId)}`;
}

function legacySessionKey(projectId: string): string {
  return `${LEGACY_SESSION_PREFIX}${encodeURIComponent(projectId)}`;
}
