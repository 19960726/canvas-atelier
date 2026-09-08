import type { ComflyClient } from '@agent-canvas/provider-comfly';

import { ManagedKnowledgeStore } from './managed-knowledge-store.js';
import {
  PROVIDER_BRIDGE_CHANNELS,
  createProviderBridgeError,
  parseProviderBridgeRequest,
  parseProviderBridgeResponse,
  type ChatSkillBridgeRequest,
  type ChatSkillBridgeResult,
  ProjectMemoryContextSnapshotSchema,
  type ProjectMemoryContextSnapshot,
  type ProviderBridgeProfile,
} from './provider-contracts.js';
import { buildSkillChatSystemInstructions } from './skill-chat-visual-analysis.js';
import { isMediaOutputModelIdentity } from './provider-model-catalog.js';

const SKILL_CHAT_TIMEOUT_MS = 180_000;
const VISUAL_SKILL_CHAT_TIMEOUT_MS = 300_000;

export interface ProjectMemoryContextResolver {
  resolveSelectedProjectMemory(memoryIds: readonly string[], sessionId?: string): Promise<readonly ProjectMemoryContextSnapshot[]>;
}

export interface ManagedSkillChatImageContent {
  readonly bytes: Uint8Array;
  readonly mediaType: 'image/gif' | 'image/jpeg' | 'image/png' | 'image/webp';
}

export interface ManagedSkillChatImageResolver {
  readManagedSkillChatImages(
    sessionId: string,
    referenceAssetIds: readonly string[],
  ): Promise<readonly ManagedSkillChatImageContent[]>;
}

export async function executeSkillChat<TSnapshot extends { readonly profiles: readonly ProviderBridgeProfile[] }>(options: {
  readonly request: unknown;
  readonly captureRuntimeSnapshot: () => Promise<TSnapshot>;
  readonly createClient: (snapshot: TSnapshot) => Pick<ComflyClient, 'chat' | 'responses'>;
  readonly managedKnowledgeStore: ManagedKnowledgeStore;
  readonly projectMemoryContextResolver?: ProjectMemoryContextResolver;
  readonly managedSkillChatImageResolver?: ManagedSkillChatImageResolver;
}): Promise<ChatSkillBridgeResult> {
  const validated = parseProviderBridgeRequest(PROVIDER_BRIDGE_CHANNELS.chat, options.request) as ChatSkillBridgeRequest;
  const snapshot = await options.captureRuntimeSnapshot();
  const referenceAssetIds = validated.referenceAssetIds ?? [];
  const profile = snapshot.profiles.find((item) => (
    item.provider === validated.provider
    && item.modelRoute === validated.modelRoute
    && (item.capabilities.includes('chat') || item.capabilities.includes('responses'))
    && !item.capabilities.includes('image_generation')
    && !item.capabilities.includes('image_edit')
    && !item.capabilities.includes('video_generation')
    && !isMediaOutputModelIdentity(item.modelRoute, item.modelId, item.displayName)
  ));
  if (profile === undefined) {
    throw createProviderBridgeError('PROVIDER_UNAVAILABLE', 'Requested Skill chat model profile is unavailable');
  }
  if (referenceAssetIds.length > 0 && !supportsManagedSkillChatImages(profile, validated.agentMode)) {
    throw createProviderBridgeError('PROVIDER_UNAVAILABLE', 'Selected Skill chat model does not support managed image references');
  }
  const images = await resolveManagedSkillChatImages(
    validated.sessionId,
    referenceAssetIds,
    options.managedSkillChatImageResolver,
  );

  const knowledge = await Promise.all(validated.context.knowledgeBaseIds.map(async (knowledgeBaseId) => {
    const active = await options.managedKnowledgeStore.readActive(knowledgeBaseId);
    if (active === null) {
      throw createProviderBridgeError('PROVIDER_UNAVAILABLE', 'Selected Skill chat knowledge is unavailable');
    }
    return {
      knowledgeBaseId: active.knowledgeBaseId,
      version: active.version,
      displayName: active.displayName,
      documents: active.documents.map(({ relativePath, content }) => ({ relativePath, content })),
    };
  }));
  const projectMemory = await resolveProjectMemoryContext(
    validated.context.projectMemoryIds,
    options.projectMemoryContextResolver,
    validated.sessionId,
  );
  const messages = [
    {
      role: 'system' as const,
      content: JSON.stringify({
        instructions: buildSkillChatSystemInstructions({
          agentMode: validated.agentMode ?? 'chat',
          reasoningEffort: validated.reasoningEffort,
          visualAnalysis: validated.visualAnalysis === true,
          referenceMentions: validated.referenceMentions ?? [],
        }),
        agentMode: validated.agentMode ?? 'chat',
        knowledge,
        projectMemory,
      }),
    },
    ...attachManagedImagesToLatestUserMessage(validated.messages, images),
  ];
  const client = options.createClient(snapshot);
  const codexReasoningEffort = validated.agentMode === 'codex'
    ? validated.reasoningEffort
    : undefined;
  const requestTimeoutMs = images.length > 0 || validated.visualAnalysis === true
    ? VISUAL_SKILL_CHAT_TIMEOUT_MS
    : SKILL_CHAT_TIMEOUT_MS;
  const chatRequest = {
    model: profile.modelId ?? profile.modelRoute,
    messages,
    ...(codexReasoningEffort === undefined ? {} : { reasoning_effort: codexReasoningEffort }),
  };
  const responsesRequest = {
    model: profile.modelId ?? profile.modelRoute,
    input: toResponsesInput(messages),
    ...(codexReasoningEffort === undefined ? {} : { reasoning: { effort: codexReasoningEffort } }),
  };
  const message = profile.capabilities.includes('chat')
    ? (await client.chat(chatRequest, requestTimeoutMs)).choices[0]?.message?.content
    : extractResponsesText((await client.responses(responsesRequest, requestTimeoutMs)).output);
  if (typeof message !== 'string' || message.trim().length === 0) {
    throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Provider returned an invalid Skill chat response');
  }
  return parseProviderBridgeResponse(PROVIDER_BRIDGE_CHANNELS.chat, {
    message,
    modelRoute: validated.modelRoute,
    sources: knowledge.map(({ knowledgeBaseId, version, displayName }) => ({ knowledgeBaseId, version, displayName })),
  }) as ChatSkillBridgeResult;
}

function supportsManagedSkillChatImages(
  profile: ProviderBridgeProfile,
  _agentMode: ChatSkillBridgeRequest['agentMode'],
): boolean {
  return profile.capabilities.includes('vision');
}

function toResponsesInput(
  messages: readonly { readonly role: 'system' | 'user' | 'assistant'; readonly content: string | readonly unknown[] }[],
): Array<{ readonly role: 'system' | 'user' | 'assistant'; readonly content: readonly unknown[] }> {
  return messages.map((message) => ({
    role: message.role,
    content: typeof message.content === 'string'
      ? [{ type: 'input_text', text: message.content }]
      : message.content.flatMap<unknown>((part) => {
          if (!isRecord(part)) return [];
          if (part.type === 'text' && typeof part.text === 'string') {
            return [{ type: 'input_text', text: part.text }];
          }
          if (part.type === 'image_url'
            && isRecord(part.image_url)
            && typeof part.image_url.url === 'string') {
            return [{ type: 'input_image', image_url: part.image_url.url }];
          }
          return [];
        }),
  }));
}

function extractResponsesText(output: readonly unknown[]): string | undefined {
  const chunks: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      if (value.trim().length > 0) chunks.push(value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!isRecord(value)) return;
    for (const key of ['text', 'output_text', 'content']) {
      if (key in value) visit(value[key]);
    }
  };
  output.forEach(visit);
  return chunks.join('\n').trim() || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function resolveManagedSkillChatImages(
  sessionId: string | undefined,
  referenceAssetIds: readonly string[],
  resolver: ManagedSkillChatImageResolver | undefined,
): Promise<readonly ManagedSkillChatImageContent[]> {
  if (referenceAssetIds.length === 0) return [];
  if (sessionId === undefined || resolver === undefined) {
    throw createProviderBridgeError('PROVIDER_UNAVAILABLE', 'Managed Skill chat image references are unavailable');
  }
  try {
    const images = await resolver.readManagedSkillChatImages(sessionId, referenceAssetIds);
    if (
      !Array.isArray(images)
      || images.length !== referenceAssetIds.length
      || images.some((image) => !isManagedSkillChatImageContent(image))
    ) {
      throw new Error('Managed Skill chat image references are unavailable');
    }
    return images;
  } catch {
    throw createProviderBridgeError('PROVIDER_UNAVAILABLE', 'Managed Skill chat image references are unavailable');
  }
}

function isManagedSkillChatImageContent(value: unknown): value is ManagedSkillChatImageContent {
  return value !== null
    && typeof value === 'object'
    && 'bytes' in value
    && 'mediaType' in value
    && value.bytes instanceof Uint8Array
    && value.bytes.byteLength > 0
    && (value.mediaType === 'image/gif'
      || value.mediaType === 'image/jpeg'
      || value.mediaType === 'image/png'
      || value.mediaType === 'image/webp');
}

function attachManagedImagesToLatestUserMessage(
  messages: ChatSkillBridgeRequest['messages'],
  images: readonly ManagedSkillChatImageContent[],
): Array<{ readonly role: 'user' | 'assistant'; readonly content: string | readonly unknown[] }> {
  if (images.length === 0) return messages.map((message) => ({ ...message }));
  const latestUserMessageIndex = messages.map((message) => message.role).lastIndexOf('user');
  if (latestUserMessageIndex < 0) {
    throw createProviderBridgeError('INVALID_REQUEST', 'Managed Skill chat image references require a user message');
  }
  return messages.map((message, index) => {
    if (index !== latestUserMessageIndex) return { ...message };
    return {
      role: message.role,
      content: [
        { type: 'text', text: message.content },
        ...images.map((image) => ({
          type: 'image_url',
          image_url: { url: `data:${image.mediaType};base64,${Buffer.from(image.bytes).toString('base64')}` },
        })),
      ],
    };
  });
}

async function resolveProjectMemoryContext(
  memoryIds: readonly string[],
  resolver: ProjectMemoryContextResolver | undefined,
  sessionId: string | undefined,
): Promise<readonly ProjectMemoryContextSnapshot[]> {
  if (memoryIds.length === 0) return [];
  if (resolver === undefined) {
    throw createProviderBridgeError('PROVIDER_UNAVAILABLE', 'Selected project memory is unavailable');
  }
  try {
    const resolved = sessionId === undefined
      ? await resolver.resolveSelectedProjectMemory([...memoryIds])
      : await resolver.resolveSelectedProjectMemory([...memoryIds], sessionId);
    if (!Array.isArray(resolved) || resolved.length !== memoryIds.length) {
      throw new Error('Selected project memory is unavailable');
    }
    const snapshots = resolved.map((entry) => ProjectMemoryContextSnapshotSchema.safeParse(entry));
    if (
      snapshots.some((entry) => !entry.success)
      || snapshots.some((entry, index) => entry.success && entry.data.memoryId !== memoryIds[index])
    ) {
      throw new Error('Selected project memory is unavailable');
    }
    return snapshots.map((entry) => (entry as { success: true; data: ProjectMemoryContextSnapshot }).data);
  } catch {
    throw createProviderBridgeError('PROVIDER_UNAVAILABLE', 'Selected project memory is unavailable');
  }
}
