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

export interface ProjectMemoryContextResolver {
  resolveSelectedProjectMemory(memoryIds: readonly string[]): Promise<readonly ProjectMemoryContextSnapshot[]>;
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
  ));
  if (profile === undefined) {
    throw createProviderBridgeError('PROVIDER_UNAVAILABLE', 'Requested Skill chat model profile is unavailable');
  }
  if (referenceAssetIds.length > 0 && !profile.capabilities.includes('vision')) {
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
  const message = profile.capabilities.includes('chat')
    ? (await client.chat({
      model: profile.modelId ?? profile.modelRoute,
      messages,
    })).choices[0]?.message?.content
    : extractResponsesText((await client.responses({
      model: profile.modelId ?? profile.modelRoute,
      input: messages,
    })).output);
  if (typeof message !== 'string' || message.trim().length === 0) {
    throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Provider returned an invalid Skill chat response');
  }
  return parseProviderBridgeResponse(PROVIDER_BRIDGE_CHANNELS.chat, {
    message,
    modelRoute: validated.modelRoute,
    sources: knowledge.map(({ knowledgeBaseId, version, displayName }) => ({ knowledgeBaseId, version, displayName })),
  }) as ChatSkillBridgeResult;
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
): Promise<readonly ProjectMemoryContextSnapshot[]> {
  if (memoryIds.length === 0) return [];
  if (resolver === undefined) {
    throw createProviderBridgeError('PROVIDER_UNAVAILABLE', 'Selected project memory is unavailable');
  }
  try {
    const resolved = await resolver.resolveSelectedProjectMemory([...memoryIds]);
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
