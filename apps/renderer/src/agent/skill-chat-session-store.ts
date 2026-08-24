export type AgentConversationMode = 'chat' | 'original' | 'codex';
export type AgentReasoningEffort = 'low' | 'medium' | 'high';
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
}

export interface StoredAgentMessage {
  readonly id: string;
  readonly role: 'user' | 'assistant';
  readonly content: string;
  readonly sources?: readonly StoredAgentMessageSource[];
  readonly request?: StoredAgentRequestSummary;
}

export interface StoredAgentConversation {
  readonly id: string;
  readonly title: string;
  readonly mode: AgentConversationMode;
  readonly reasoningEffort: AgentReasoningEffort;
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
    reasoningEffort: 'medium',
    knowledgeBaseIds: [],
    projectMemoryIds: [],
    messages: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function deriveAgentConversationTitle(content: string): string {
  const normalized = content.trim().replace(/\s+/gu, ' ');
  return Array.from(normalized).slice(0, 18).join('') || '新任务';
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
  if (value.conversations.length < 1 || value.conversations.length > MAX_CONVERSATIONS) return fallback;
  const conversations = value.conversations.map(parseConversation);
  if (conversations.some((conversation) => conversation === null)) return fallback;
  const safeConversations = conversations as StoredAgentConversation[];
  if (new Set(safeConversations.map((conversation) => conversation.id)).size !== safeConversations.length) return fallback;
  const activeConversationId = readSafeText(value.activeConversationId, 160);
  if (activeConversationId === undefined || !safeConversations.some((conversation) => conversation.id === activeConversationId)) return fallback;
  return { version: 2, activeConversationId, conversations: safeConversations };
}

function parseConversation(value: unknown): StoredAgentConversation | null {
  if (!isRecord(value)) return null;
  const id = readSafeText(value.id, 160);
  const title = readSafeText(value.title, 160);
  const mode = parseMode(value.mode);
  const reasoningEffort = parseReasoningEffort(value.reasoningEffort);
  const modelRoute = value.modelRoute === undefined ? undefined : readSafeText(value.modelRoute, 160);
  const knowledgeBaseIds = readSafeTextList(value.knowledgeBaseIds, 16, 160);
  const projectMemoryIds = readSafeTextList(value.projectMemoryIds, 32, 160);
  const messages = parseMessages(value.messages);
  if (!id || !title || mode === null || reasoningEffort === null || (value.modelRoute !== undefined && !modelRoute)
    || knowledgeBaseIds === null || projectMemoryIds === null || messages === null
    || !isSafeTimestamp(value.createdAt) || !isSafeTimestamp(value.updatedAt)) return null;
  return {
    id,
    title,
    mode,
    reasoningEffort,
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
  const messages = parseMessages(value.messages);
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

function parseMessages(value: unknown): StoredAgentMessage[] | null {
  if (!Array.isArray(value) || value.length > MAX_MESSAGES) return null;
  const messages = value.map(parseMessage);
  return messages.some((message) => message === null) ? null : messages as StoredAgentMessage[];
}

function parseMessage(value: unknown): StoredAgentMessage | null {
  if (!isRecord(value) || (value.role !== 'user' && value.role !== 'assistant')) return null;
  const id = readSafeText(value.id, 160);
  const content = readSafeText(value.content, MAX_TEXT_LENGTH);
  if (!id || !content) return null;
  const sources = value.sources === undefined ? undefined : parseSources(value.sources);
  const request = value.request === undefined ? undefined : parseRequest(value.request);
  if (sources === null || request === null) return null;
  return { id, role: value.role, content, ...(sources === undefined ? {} : { sources }), ...(request === undefined ? {} : { request }) };
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
    || (value.visualAnalysis !== undefined && typeof value.visualAnalysis !== 'boolean')) return null;
  return {
    modelDisplayName,
    modelRoute,
    knowledgeBaseCount: value.knowledgeBaseCount as number,
    projectMemoryCount: value.projectMemoryCount as number,
    references: references as Array<{ assetId: string; label: string }>,
    status: value.status,
    ...(value.visualAnalysis === undefined ? {} : { visualAnalysis: value.visualAnalysis }),
  };
}

function parseMode(value: unknown): AgentConversationMode | null {
  return value === 'chat' || value === 'original' || value === 'codex' ? value : null;
}

function parseReasoningEffort(value: unknown): AgentReasoningEffort | null {
  return value === 'low' || value === 'medium' || value === 'high' ? value : null;
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
