import { z, type ZodTypeAny } from 'zod';
import {
  MAX_REVERSE_PROMPT_MP4_BYTES,
  reversePromptResultSchema,
  reversePromptRunSchema,
} from '@agent-canvas/domain';

export const PROVIDER_BRIDGE_CHANNELS = {
  getStatus: 'novus-desktop:provider:get-status',
  revealCredential: 'novus-desktop:provider:reveal-credential',
  checkConnection: 'novus-desktop:provider:check-connection',
  configure: 'novus-desktop:provider:configure',
  updateProfiles: 'novus-desktop:provider:update-profiles',
  unlock: 'novus-desktop:provider:unlock',
  listAvailableModelIds: 'novus-desktop:provider:list-available-model-ids',
  listProfiles: 'novus-desktop:provider:list-profiles',
  listTasks: 'novus-desktop:provider:list-tasks',
  getActiveProvider: 'novus-desktop:provider:get-active-provider',
  setActiveProvider: 'novus-desktop:provider:set-active-provider',
  loginRelayMe: 'novus-desktop:provider:login-relayme',
  loginRelayMeWeb: 'novus-desktop:provider:login-relayme-web',
  logoutRelayMe: 'novus-desktop:provider:logout-relayme',
  submitImageJob: 'novus-desktop:provider:submit-image-job',
  pollImageJob: 'novus-desktop:provider:poll-image-job',
  cancelImageJob: 'novus-desktop:provider:cancel-image-job',
  ackImageJobTerminal: 'novus-desktop:provider:ack-image-job-terminal',
  submitVideoJob: 'novus-desktop:provider:submit-video-job',
  pollVideoJob: 'novus-desktop:provider:poll-video-job',
  cancelVideoJob: 'novus-desktop:provider:cancel-video-job',
  ackVideoJobTerminal: 'novus-desktop:provider:ack-video-job-terminal',
  analyzeReversePrompt: 'novus-desktop:provider:analyze-reverse-prompt',
  chat: 'novus-desktop:provider:chat',
  generateStoryboard: 'novus-desktop:provider:generate-storyboard',
} as const;

export type ProviderBridgeChannel = typeof PROVIDER_BRIDGE_CHANNELS[keyof typeof PROVIDER_BRIDGE_CHANNELS];

const nonEmptyStringSchema = z.string().min(1);
const safeModelIdSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9._:/-]+$/u, 'Model id is invalid');
const secretStringSchema = z.string().min(1);
export const ProviderIdSchema = z.enum(['comfly', 'relayme']);
const providerSchema = ProviderIdSchema;
const capabilitySchema = z.enum([
  'chat',
  'vision',
  'image_generation',
  'image_edit',
  'responses',
  'gemini_native',
  'reverse_prompt',
  'video_understanding',
  'video_generation',
  'async_tasks',
]);
const errorCodeSchema = z.enum([
  'CAPABILITY_UNSUPPORTED',
  'INVALID_REQUEST',
  'CREDENTIALS_LOCKED',
  'PROVIDER_INACTIVE',
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_INVALID_RESPONSE',
  'PROTECTED_PAYLOAD',
  'PROVIDER_ERROR',
  'WEB_LOGIN_CANCELLED',
  'WEB_LOGIN_TIMEOUT',
]);
export type ProviderBridgeErrorCode = z.infer<typeof errorCodeSchema>;
export const ReverseProviderFailureReasonSchema = z.enum([
  'TRUNCATED',
  'NO_TEXT',
  'INVALID_JSON',
  'CORE_SCHEMA_INVALID',
  'IDENTITY_MISMATCH',
  'MEDIA_RESPONSIBILITIES_INVALID',
]);
export type ReverseProviderFailureReason = z.infer<typeof ReverseProviderFailureReasonSchema>;
export interface ProviderBridgeError {
  code: ProviderBridgeErrorCode;
  message: string;
  retryable: boolean;
  reason?: ReverseProviderFailureReason;
}
const terminalStatusSchema = z.enum(['completed', 'failed', 'cancelled']);
const progressSchema = z.number().finite().min(0).max(1);
const finiteNumberSchema = z.number().finite();
const noPayloadSchema = z.union([z.undefined(), z.object({}).strict()]).transform(() => undefined);
export const ProviderSelectionBridgeRequestSchema = z.object({
  provider: ProviderIdSchema.optional(),
}).strict().optional().transform((value) => ({ provider: value?.provider ?? 'comfly' as const }));
const contentAddressedAssetIdSchema = z.string().regex(/^[a-f0-9]{16}$/u, 'Asset id must be a content-addressed id');
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u, 'Asset hash must be a lowercase SHA-256 digest');
const opaqueDesktopSessionIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/u, 'Session id must be opaque');
const imageAspectRatioSchema = z.enum(['1:1', '2:3', '3:2', '4:3', '3:4', '16:9', '9:16']);
const imageResolutionSchema = z.enum(['1K', '2K', '4K']);
const videoResolutionSchema = z.enum(['360p', '480p', '512p', '540p', '720p', '768p', '1080p', '2K', '4K']);
const imageOutputCountSchema = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);
const providerDurationConstraintSchema = z.union([
  z.object({
    mode: z.literal('options'),
    defaultValue: z.number().finite().positive().optional(),
    options: z.array(z.number().finite().positive()).min(1),
  }).strict(),
  z.object({
    mode: z.literal('range'),
    defaultValue: z.number().finite().positive().optional(),
    min: z.number().finite().positive(),
    max: z.number().finite().positive(),
    step: z.number().finite().positive(),
  }).strict(),
]);
const providerParameterConstraintsSchema = z.object({
  image: z.object({
    aspectRatios: z.array(imageAspectRatioSchema).min(1).optional(),
    resolutions: z.array(imageResolutionSchema).min(1).optional(),
    sizes: z.array(z.string().regex(/^\d{3,5}x\d{3,5}$/u)).min(1).optional(),
    outputCounts: z.array(imageOutputCountSchema).min(1).optional(),
  }).strict().optional(),
  video: z.object({
    aspectRatios: z.array(imageAspectRatioSchema).min(1).optional(),
    resolutions: z.array(videoResolutionSchema).min(1).optional(),
    duration: providerDurationConstraintSchema.optional(),
    outputCounts: z.array(imageOutputCountSchema).min(1).optional(),
  }).strict().optional(),
}).strict();

export const ProviderBridgeProfileSchema = z.object({
  provider: providerSchema,
  modelRoute: nonEmptyStringSchema,
  displayName: nonEmptyStringSchema,
  modelId: nonEmptyStringSchema.optional(),
  capabilities: z.array(capabilitySchema),
  capabilityStatus: z.enum(['complete', 'incomplete']).optional(),
  constraints: providerParameterConstraintsSchema.optional(),
}).strict().superRefine((value, context) => {
  addProtectedPayloadIssues(value, context, 'Provider bridge payload contains protected payload');
});

export const ProviderConfigurationStatusSchema = z.object({
  configured: z.boolean(),
  locked: z.boolean(),
  encryption: z.enum(['safeStorage', 'passphrase', 'unavailable']),
}).strict();

export const ProviderActiveStateSchema = z.object({
  activeProvider: ProviderIdSchema.nullable(),
}).strict();

export const ListProviderTasksBridgeRequestSchema = z.object({
  provider: z.literal('relayme'),
  page: z.number().int().positive().max(10_000),
  size: z.number().int().min(1).max(100),
}).strict();

const providerTaskSummarySchema = z.object({
  taskId: nonEmptyStringSchema.max(200),
  type: z.enum(['image', 'video']),
  status: nonEmptyStringSchema.max(60),
  createdAt: z.string().max(100).optional(),
  error: z.string().max(500).optional(),
}).strict().superRefine((value, context) => {
  addProtectedPayloadIssues(value, context, 'Provider task payload contains protected payload');
});

export const ListProviderTasksBridgeResultSchema = z.object({
  tasks: z.array(providerTaskSummarySchema).max(100),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  totalPages: z.number().int().positive(),
}).strict();

export const SetActiveProviderBridgeRequestSchema = ProviderActiveStateSchema;

export const LoginRelayMeBridgeRequestSchema = z.object({
  username: nonEmptyStringSchema.max(320),
  password: nonEmptyStringSchema.max(1_024),
}).strict();

export const RevealProviderCredentialBridgeResultSchema = z.object({
  token: secretStringSchema,
}).strict();

export const ProviderConnectionCheckResultSchema = z.object({
  checkedAt: z.string().datetime({ offset: true }),
  status: z.enum([
    'unconfigured',
    'connected',
    'authentication_failed',
    'network_unavailable',
    'service_limited',
  ]),
}).strict();

export const ConfigureProviderBridgeRequestSchema = z.object({
  provider: ProviderIdSchema.optional(),
  token: secretStringSchema.optional(),
  imageToken: secretStringSchema.optional(),
  languageToken: secretStringSchema.optional(),
  imageTokens: z.array(secretStringSchema).min(1).max(3).optional(),
  reverseTokens: z.array(secretStringSchema).min(1).max(3).optional(),
  passphrase: secretStringSchema.optional(),
  baseUrl: nonEmptyStringSchema.optional(),
  profiles: z.array(ProviderBridgeProfileSchema).optional(),
}).strict().superRefine((value, context) => {
  const hasCredentialUpdate = value.token !== undefined
    || value.imageToken !== undefined
    || value.languageToken !== undefined
    || value.imageTokens !== undefined
    || value.reverseTokens !== undefined;
  if (hasCredentialUpdate && value.token === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Provider credential updates require a primary token', path: ['token'] });
  }
  if (!hasCredentialUpdate && value.baseUrl === undefined && value.profiles === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Provider configuration request is empty' });
  }
  addProtectedPayloadIssues({
    baseUrl: value.baseUrl,
    profiles: value.profiles,
  }, context, 'Provider bridge payload contains protected payload');
  if (value.baseUrl !== undefined) {
    addUnsafeBaseUrlIssues(value.baseUrl, context);
  }
});

export const UpdateProviderProfilesBridgeRequestSchema = z.object({
  provider: ProviderIdSchema.optional(),
  profiles: z.array(ProviderBridgeProfileSchema).max(1_000),
}).strict().superRefine((value, context) => {
  addProtectedPayloadIssues(value, context, 'Provider bridge payload contains protected payload');
});

export const UnlockProviderBridgeRequestSchema = z.object({
  provider: ProviderIdSchema.optional(),
  passphrase: secretStringSchema,
}).strict();

export const SubmitImageJobBridgeRequestSchema = z.object({
  jobId: nonEmptyStringSchema,
  provider: providerSchema,
  modelRoute: nonEmptyStringSchema,
  prompt: nonEmptyStringSchema,
  conversationId: nonEmptyStringSchema,
  sessionId: opaqueDesktopSessionIdSchema.optional(),
  referenceAssetIds: z.array(nonEmptyStringSchema),
  aspectRatio: imageAspectRatioSchema.optional(),
  resolution: imageResolutionSchema.optional(),
  outputCount: imageOutputCountSchema.optional(),
}).strict().superRefine((value, context) => {
  addProtectedPayloadIssues(value, context, 'Provider bridge payload contains protected payload');
});

export const SubmitImageJobBridgeResultSchema = z.object({
  providerTaskId: nonEmptyStringSchema.regex(/^provider-job-[a-f0-9]{32}$/u),
}).strict().superRefine((value, context) => {
  addProtectedPayloadIssues(value, context, 'Provider bridge payload contains protected payload');
});

export const SubmitVideoJobBridgeRequestSchema = z.object({
  jobId: nonEmptyStringSchema,
  provider: providerSchema,
  modelRoute: nonEmptyStringSchema,
  prompt: nonEmptyStringSchema,
  conversationId: nonEmptyStringSchema,
  sessionId: opaqueDesktopSessionIdSchema.optional(),
  referenceAssetIds: z.array(nonEmptyStringSchema).max(20),
  aspectRatio: imageAspectRatioSchema.optional(),
  resolution: videoResolutionSchema.optional(),
  durationSeconds: z.number().int().min(1).max(60).optional(),
  outputCount: imageOutputCountSchema.optional(),
  audioEnabled: z.boolean().optional(),
}).strict().superRefine((value, context) => {
  addProtectedPayloadIssues(value, context, 'Provider bridge payload contains protected payload');
});

export const SubmitVideoJobBridgeResultSchema = SubmitImageJobBridgeResultSchema;

export const PollImageJobBridgeRequestSchema = z.object({
  provider: providerSchema,
  providerTaskId: nonEmptyStringSchema,
}).strict().superRefine((value, context) => {
  addProtectedPayloadIssues(value, context, 'Provider bridge payload contains protected payload');
});

export const CancelImageJobBridgeRequestSchema = PollImageJobBridgeRequestSchema;

export const AckImageJobTerminalBridgeRequestSchema = z.object({
  provider: providerSchema,
  providerTaskId: nonEmptyStringSchema,
  status: terminalStatusSchema,
}).strict().superRefine((value, context) => {
  addProtectedPayloadIssues(value, context, 'Provider bridge payload contains protected payload');
});

export const ProviderBridgeErrorSchema: z.ZodType<ProviderBridgeError> = z.object({
  code: errorCodeSchema,
  message: nonEmptyStringSchema,
  retryable: z.boolean(),
  reason: ReverseProviderFailureReasonSchema.optional(),
}).strict().transform((value, context): ProviderBridgeError => {
  const normalized = normalizeProviderBridgeError(value);
  if (containsRawProviderTaskIdentifier(normalized.message)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Provider returned an invalid image job error',
    });
  }
  return normalized;
});

export const ProviderImageJobResultSchema = z.object({
  assetId: z.union([
    nonEmptyStringSchema.regex(/^provider-result-provider-job-[a-f0-9]{32}$/u),
    nonEmptyStringSchema.regex(/^[a-f0-9]{16}$/u),
  ]),
  assetIds: z.array(z.union([
    nonEmptyStringSchema.regex(/^provider:[a-z0-9_-]+:[a-zA-Z0-9_-]+:\d+$/u),
    nonEmptyStringSchema.regex(/^provider-result-provider-job-[a-f0-9]{32}$/u),
    nonEmptyStringSchema.regex(/^[a-f0-9]{16}$/u),
  ])).min(1).max(4).optional(),
  width: finiteNumberSchema.optional(),
  height: finiteNumberSchema.optional(),
}).strict().superRefine((value, context) => {
  addProtectedPayloadIssues(value, context, 'Provider bridge payload contains protected payload');
});

const pollRunningSchema = z.object({
  status: z.literal('running'),
  progress: progressSchema.optional(),
  blockedReason: z.literal('credentials_locked').optional(),
}).strict();

const pollCompletedSchema = z.object({
  status: z.literal('completed'),
  progress: progressSchema.optional(),
  result: ProviderImageJobResultSchema,
}).strict();

const pollFailedSchema = z.object({
  status: z.literal('failed'),
  error: ProviderBridgeErrorSchema,
}).strict();

const pollCancelledSchema = z.object({
  status: z.literal('cancelled'),
}).strict();

export const PollImageJobBridgeResultSchema = z.union([
  pollRunningSchema,
  pollCompletedSchema,
  pollFailedSchema,
  pollCancelledSchema,
]);

export const CancelImageJobBridgeResultSchema = z.union([
  pollCompletedSchema,
  pollFailedSchema,
  pollCancelledSchema,
]);

export const AckImageJobTerminalBridgeResultSchema = z.object({
  acknowledged: z.literal(true),
}).strict();

export const PollVideoJobBridgeRequestSchema = PollImageJobBridgeRequestSchema;
export const CancelVideoJobBridgeRequestSchema = PollVideoJobBridgeRequestSchema;
export const AckVideoJobTerminalBridgeRequestSchema = AckImageJobTerminalBridgeRequestSchema;

export const ProviderVideoJobResultSchema = z.object({
  assetId: z.union([
    nonEmptyStringSchema.regex(/^provider-result-provider-job-[a-f0-9]{32}$/u),
    nonEmptyStringSchema.regex(/^[a-f0-9]{16}$/u),
  ]),
  posterAssetId: contentAddressedAssetIdSchema.optional(),
  width: finiteNumberSchema.optional(),
  height: finiteNumberSchema.optional(),
  durationSeconds: finiteNumberSchema.positive().optional(),
}).strict().superRefine((value, context) => {
  addProtectedPayloadIssues(value, context, 'Provider bridge payload contains protected payload');
});

const pollVideoCompletedSchema = z.object({
  status: z.literal('completed'),
  progress: progressSchema.optional(),
  result: ProviderVideoJobResultSchema,
}).strict();

export const PollVideoJobBridgeResultSchema = z.union([
  pollRunningSchema,
  pollVideoCompletedSchema,
  pollFailedSchema,
  pollCancelledSchema,
]);
export const CancelVideoJobBridgeResultSchema = z.union([
  pollVideoCompletedSchema,
  pollFailedSchema,
  pollCancelledSchema,
]);
export const AckVideoJobTerminalBridgeResultSchema = AckImageJobTerminalBridgeResultSchema;

const managedReversePromptImageIdentitySchema = z.object({
  kind: z.literal('image'),
  assetId: contentAddressedAssetIdSchema,
  sha256: sha256Schema,
  byteSize: z.number().int().nonnegative(),
  mediaType: z.enum(['image/gif', 'image/jpeg', 'image/png', 'image/webp']),
}).strict().superRefine((value, context) => {
  if (!value.sha256.startsWith(value.assetId)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['assetId'], message: 'Asset id must match the SHA-256 prefix' });
  }
});

const managedReversePromptVideoIdentitySchema = z.object({
  kind: z.literal('video'),
  assetId: contentAddressedAssetIdSchema,
  sha256: sha256Schema,
  byteSize: z.number().int().nonnegative().max(MAX_REVERSE_PROMPT_MP4_BYTES, 'Original MP4 exceeds the 20 MiB direct reverse-analysis payload limit'),
  mediaType: z.literal('video/mp4'),
}).strict().superRefine((value, context) => {
  if (!value.sha256.startsWith(value.assetId)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['assetId'], message: 'Asset id must match the SHA-256 prefix' });
  }
});

export const managedReversePromptMediaIdentitySchema = z.union([
  managedReversePromptImageIdentitySchema,
  managedReversePromptVideoIdentitySchema,
]);

function legacyReverseMediaMatches(
  media: readonly z.infer<typeof managedReversePromptMediaIdentitySchema>[],
  imageAssetIds: readonly string[],
  videoInput: Omit<z.infer<typeof managedReversePromptVideoIdentitySchema>, 'kind'> | undefined,
): boolean {
  const images = media.filter((item) => item.kind === 'image');
  const videos = media.filter((item): item is z.infer<typeof managedReversePromptVideoIdentitySchema> => item.kind === 'video');
  if (images.length !== imageAssetIds.length || images.some((item, index) => item.assetId !== imageAssetIds[index])) return false;
  if (videoInput === undefined) return videos.length === 0;
  const video = videos[0];
  return videos.length === 1
    && video !== undefined
    && video.assetId === videoInput.assetId
    && video.sha256 === videoInput.sha256
    && video.byteSize === videoInput.byteSize
    && video.mediaType === videoInput.mediaType;
}
export const AnalyzeReversePromptBridgeRequestSchema = z.object({
  sessionId: opaqueDesktopSessionIdSchema,
  provider: providerSchema,
  run: reversePromptRunSchema,
  media: z.array(managedReversePromptMediaIdentitySchema).min(1),
}).strict().superRefine((value, context) => {
  addUnsafeReversePromptPayloadIssues(value, context);
  if (value.run.agentConfig === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['run', 'agentConfig'],
      message: 'Reverse analysis requires an applied Agent node configuration',
    });
  }

  const orderedMedia = value.run.orderedMedia;
  const usesLegacyImagePlaceholders = orderedMedia.some((item) => item.kind === 'image' && item.byteSize === 0 && /^0{64}$/u.test(item.sha256));
  const mediaMatches = usesLegacyImagePlaceholders
    ? legacyReverseMediaMatches(value.media, value.run.references.map((reference) => reference.assetId), value.run.videoInput)
    : value.media.length === orderedMedia.length && value.media.every((media, index) => {
      const pinned = orderedMedia[index];
      return pinned !== undefined
        && media.kind === pinned.kind
        && media.assetId === pinned.assetId
        && media.sha256 === pinned.sha256
        && media.byteSize === pinned.byteSize
        && media.mediaType === pinned.mediaType;
    });
  if (!mediaMatches) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['media'],
      message: 'Managed media identities must match the ordered reverse-prompt media exactly',
    });
  }
});

export const AnalyzeReversePromptBridgeResultSchema = reversePromptResultSchema.superRefine((value, context) => {
  addUnsafeReversePromptPayloadIssues(value, context);
});

const skillChatMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: nonEmptyStringSchema.max(8_000),
}).strict();

const skillChatContextSchema = z.object({
  knowledgeBaseIds: z.array(nonEmptyStringSchema.max(160)).max(16),
  projectMemoryIds: z.array(nonEmptyStringSchema.max(160)).max(32),
}).strict();

const skillChatReferenceMentionSchema = z.object({
  assetId: contentAddressedAssetIdSchema,
  label: nonEmptyStringSchema.max(160),
  mention: nonEmptyStringSchema.max(32),
}).strict();

export const ChatSkillBridgeRequestSchema = z.object({
  provider: providerSchema,
  modelRoute: nonEmptyStringSchema.max(160),
  sessionId: opaqueDesktopSessionIdSchema.optional(),
  referenceAssetIds: z.array(contentAddressedAssetIdSchema).max(20).optional(),
  referenceMentions: z.array(skillChatReferenceMentionSchema).max(20).optional(),
  agentMode: z.enum(['chat', 'original', 'codex']).optional(),
  reasoningEffort: z.enum(['low', 'medium', 'high']).optional(),
  visualAnalysis: z.boolean().optional(),
  messages: z.array(skillChatMessageSchema).min(1).max(48),
  context: skillChatContextSchema,
}).strict().superRefine((value, context) => {
  addUnsafeSkillChatPayloadIssues(value, context);
  const referenceAssetIds = value.referenceAssetIds ?? [];
  if (referenceAssetIds.length > 0 && value.sessionId === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['sessionId'],
      message: 'Managed Skill chat image references require an open desktop session',
    });
  }
  if (new Set(referenceAssetIds).size !== referenceAssetIds.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['referenceAssetIds'],
      message: 'Managed Skill chat image references must be unique',
    });
  }
  const referenceMentions = value.referenceMentions ?? [];
  if (referenceMentions.length > 0 && (
    referenceMentions.length !== referenceAssetIds.length
    || referenceMentions.some((reference, index) => (
      reference.assetId !== referenceAssetIds[index]
      || reference.mention !== `@图片${index + 1}`
    ))
  )) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['referenceMentions'],
      message: 'Skill chat reference mentions must match ordered image references exactly',
    });
  }
  if (value.visualAnalysis === true && referenceMentions.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['visualAnalysis'],
      message: 'Visual analysis requires ordered reference mentions',
    });
  }
});

const skillChatSourceSchema = z.object({
  knowledgeBaseId: nonEmptyStringSchema.max(160),
  version: z.number().int().positive(),
  displayName: nonEmptyStringSchema.max(160).optional(),
}).strict();

export const ChatSkillBridgeResultSchema = z.object({
  message: nonEmptyStringSchema.max(16_000),
  modelRoute: nonEmptyStringSchema.max(160),
  sources: z.array(skillChatSourceSchema).max(16),
}).strict().superRefine((value, context) => {
  addUnsafeSkillChatPayloadIssues(value, context);
});

export const GenerateStoryboardBridgeRequestSchema = z.object({
  provider: providerSchema,
  modelRoute: nonEmptyStringSchema.max(160),
  script: nonEmptyStringSchema.max(12_000),
  shotCount: z.number().int().min(1).max(60),
  referenceAssetIds: z.array(contentAddressedAssetIdSchema).max(20),
}).strict().superRefine((value, context) => {
  addUnsafeSkillChatPayloadIssues(value, context);
});

const storyboardShotSchema = z.object({
  id: z.string().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/u),
  order: z.number().int().positive().max(60),
  title: nonEmptyStringSchema.max(160),
  composition: nonEmptyStringSchema.max(2_000),
  durationSeconds: z.number().int().min(1).max(60),
  referenceAssetIds: z.array(contentAddressedAssetIdSchema).max(20),
}).strict();

export const GenerateStoryboardBridgeResultSchema = z.object({
  modelRoute: nonEmptyStringSchema.max(160),
  shots: z.array(storyboardShotSchema).min(1).max(60),
}).strict().superRefine((value, context) => {
  addUnsafeSkillChatPayloadIssues(value, context);
});

export const ProjectMemoryContextSnapshotSchema = z.object({
  memoryId: nonEmptyStringSchema.max(160),
  projectRevision: z.number().int().nonnegative(),
  summary: nonEmptyStringSchema.max(2_000),
}).strict().superRefine((value, context) => {
  addUnsafeSkillChatPayloadIssues(value, context);
});

export const ProviderBridgeRequestSchemas = {
  getStatus: ProviderSelectionBridgeRequestSchema,
  revealCredential: ProviderSelectionBridgeRequestSchema,
  checkConnection: ProviderSelectionBridgeRequestSchema,
  configure: ConfigureProviderBridgeRequestSchema,
  updateProfiles: UpdateProviderProfilesBridgeRequestSchema,
  unlock: UnlockProviderBridgeRequestSchema,
  listAvailableModelIds: ProviderSelectionBridgeRequestSchema,
  listProfiles: ProviderSelectionBridgeRequestSchema,
  listTasks: ListProviderTasksBridgeRequestSchema,
  getActiveProvider: noPayloadSchema,
  setActiveProvider: SetActiveProviderBridgeRequestSchema,
  loginRelayMe: LoginRelayMeBridgeRequestSchema,
  loginRelayMeWeb: noPayloadSchema,
  logoutRelayMe: noPayloadSchema,
  submitImageJob: SubmitImageJobBridgeRequestSchema,
  pollImageJob: PollImageJobBridgeRequestSchema,
  cancelImageJob: CancelImageJobBridgeRequestSchema,
  ackImageJobTerminal: AckImageJobTerminalBridgeRequestSchema,
  submitVideoJob: SubmitVideoJobBridgeRequestSchema,
  pollVideoJob: PollVideoJobBridgeRequestSchema,
  cancelVideoJob: CancelVideoJobBridgeRequestSchema,
  ackVideoJobTerminal: AckVideoJobTerminalBridgeRequestSchema,
  analyzeReversePrompt: AnalyzeReversePromptBridgeRequestSchema,
  chat: ChatSkillBridgeRequestSchema,
  generateStoryboard: GenerateStoryboardBridgeRequestSchema,
} as const satisfies Record<keyof typeof PROVIDER_BRIDGE_CHANNELS, ZodTypeAny>;

export const ProviderBridgeResponseSchemas = {
  getStatus: ProviderConfigurationStatusSchema,
  revealCredential: RevealProviderCredentialBridgeResultSchema,
  checkConnection: ProviderConnectionCheckResultSchema,
  configure: ProviderConfigurationStatusSchema,
  updateProfiles: ProviderConfigurationStatusSchema,
  unlock: ProviderConfigurationStatusSchema,
  listAvailableModelIds: z.array(safeModelIdSchema).max(1_000),
  listProfiles: z.array(ProviderBridgeProfileSchema),
  listTasks: ListProviderTasksBridgeResultSchema,
  getActiveProvider: ProviderActiveStateSchema,
  setActiveProvider: ProviderActiveStateSchema,
  loginRelayMe: ProviderActiveStateSchema,
  loginRelayMeWeb: ProviderActiveStateSchema,
  logoutRelayMe: ProviderActiveStateSchema,
  submitImageJob: SubmitImageJobBridgeResultSchema,
  pollImageJob: PollImageJobBridgeResultSchema,
  cancelImageJob: CancelImageJobBridgeResultSchema,
  ackImageJobTerminal: AckImageJobTerminalBridgeResultSchema,
  submitVideoJob: SubmitVideoJobBridgeResultSchema,
  pollVideoJob: PollVideoJobBridgeResultSchema,
  cancelVideoJob: CancelVideoJobBridgeResultSchema,
  ackVideoJobTerminal: AckVideoJobTerminalBridgeResultSchema,
  analyzeReversePrompt: AnalyzeReversePromptBridgeResultSchema,
  chat: ChatSkillBridgeResultSchema,
  generateStoryboard: GenerateStoryboardBridgeResultSchema,
} as const satisfies Record<keyof typeof PROVIDER_BRIDGE_CHANNELS, ZodTypeAny>;

const providerBridgeEnvelopeSchema = z.union([
  z.object({ ok: z.literal(true), value: z.unknown() }).strict(),
  z.object({ ok: z.literal(false), error: ProviderBridgeErrorSchema }).strict(),
]);

const REQUEST_SCHEMA_BY_CHANNEL = new Map<ProviderBridgeChannel, ZodTypeAny>([
  [PROVIDER_BRIDGE_CHANNELS.getStatus, ProviderBridgeRequestSchemas.getStatus],
  [PROVIDER_BRIDGE_CHANNELS.revealCredential, ProviderBridgeRequestSchemas.revealCredential],
  [PROVIDER_BRIDGE_CHANNELS.checkConnection, ProviderBridgeRequestSchemas.checkConnection],
  [PROVIDER_BRIDGE_CHANNELS.configure, ProviderBridgeRequestSchemas.configure],
  [PROVIDER_BRIDGE_CHANNELS.updateProfiles, ProviderBridgeRequestSchemas.updateProfiles],
  [PROVIDER_BRIDGE_CHANNELS.unlock, ProviderBridgeRequestSchemas.unlock],
  [PROVIDER_BRIDGE_CHANNELS.listAvailableModelIds, ProviderBridgeRequestSchemas.listAvailableModelIds],
  [PROVIDER_BRIDGE_CHANNELS.listProfiles, ProviderBridgeRequestSchemas.listProfiles],
  [PROVIDER_BRIDGE_CHANNELS.listTasks, ProviderBridgeRequestSchemas.listTasks],
  [PROVIDER_BRIDGE_CHANNELS.getActiveProvider, ProviderBridgeRequestSchemas.getActiveProvider],
  [PROVIDER_BRIDGE_CHANNELS.setActiveProvider, ProviderBridgeRequestSchemas.setActiveProvider],
  [PROVIDER_BRIDGE_CHANNELS.loginRelayMe, ProviderBridgeRequestSchemas.loginRelayMe],
  [PROVIDER_BRIDGE_CHANNELS.loginRelayMeWeb, ProviderBridgeRequestSchemas.loginRelayMeWeb],
  [PROVIDER_BRIDGE_CHANNELS.logoutRelayMe, ProviderBridgeRequestSchemas.logoutRelayMe],
  [PROVIDER_BRIDGE_CHANNELS.submitImageJob, ProviderBridgeRequestSchemas.submitImageJob],
  [PROVIDER_BRIDGE_CHANNELS.pollImageJob, ProviderBridgeRequestSchemas.pollImageJob],
  [PROVIDER_BRIDGE_CHANNELS.cancelImageJob, ProviderBridgeRequestSchemas.cancelImageJob],
  [PROVIDER_BRIDGE_CHANNELS.ackImageJobTerminal, ProviderBridgeRequestSchemas.ackImageJobTerminal],
  [PROVIDER_BRIDGE_CHANNELS.submitVideoJob, ProviderBridgeRequestSchemas.submitVideoJob],
  [PROVIDER_BRIDGE_CHANNELS.pollVideoJob, ProviderBridgeRequestSchemas.pollVideoJob],
  [PROVIDER_BRIDGE_CHANNELS.cancelVideoJob, ProviderBridgeRequestSchemas.cancelVideoJob],
  [PROVIDER_BRIDGE_CHANNELS.ackVideoJobTerminal, ProviderBridgeRequestSchemas.ackVideoJobTerminal],
  [PROVIDER_BRIDGE_CHANNELS.analyzeReversePrompt, ProviderBridgeRequestSchemas.analyzeReversePrompt],
  [PROVIDER_BRIDGE_CHANNELS.chat, ProviderBridgeRequestSchemas.chat],
  [PROVIDER_BRIDGE_CHANNELS.generateStoryboard, ProviderBridgeRequestSchemas.generateStoryboard],
]);

const RESPONSE_SCHEMA_BY_CHANNEL = new Map<ProviderBridgeChannel, ZodTypeAny>([
  [PROVIDER_BRIDGE_CHANNELS.getStatus, ProviderBridgeResponseSchemas.getStatus],
  [PROVIDER_BRIDGE_CHANNELS.revealCredential, ProviderBridgeResponseSchemas.revealCredential],
  [PROVIDER_BRIDGE_CHANNELS.checkConnection, ProviderBridgeResponseSchemas.checkConnection],
  [PROVIDER_BRIDGE_CHANNELS.configure, ProviderBridgeResponseSchemas.configure],
  [PROVIDER_BRIDGE_CHANNELS.updateProfiles, ProviderBridgeResponseSchemas.updateProfiles],
  [PROVIDER_BRIDGE_CHANNELS.unlock, ProviderBridgeResponseSchemas.unlock],
  [PROVIDER_BRIDGE_CHANNELS.listAvailableModelIds, ProviderBridgeResponseSchemas.listAvailableModelIds],
  [PROVIDER_BRIDGE_CHANNELS.listProfiles, ProviderBridgeResponseSchemas.listProfiles],
  [PROVIDER_BRIDGE_CHANNELS.listTasks, ProviderBridgeResponseSchemas.listTasks],
  [PROVIDER_BRIDGE_CHANNELS.getActiveProvider, ProviderBridgeResponseSchemas.getActiveProvider],
  [PROVIDER_BRIDGE_CHANNELS.setActiveProvider, ProviderBridgeResponseSchemas.setActiveProvider],
  [PROVIDER_BRIDGE_CHANNELS.loginRelayMe, ProviderBridgeResponseSchemas.loginRelayMe],
  [PROVIDER_BRIDGE_CHANNELS.loginRelayMeWeb, ProviderBridgeResponseSchemas.loginRelayMeWeb],
  [PROVIDER_BRIDGE_CHANNELS.logoutRelayMe, ProviderBridgeResponseSchemas.logoutRelayMe],
  [PROVIDER_BRIDGE_CHANNELS.submitImageJob, ProviderBridgeResponseSchemas.submitImageJob],
  [PROVIDER_BRIDGE_CHANNELS.pollImageJob, ProviderBridgeResponseSchemas.pollImageJob],
  [PROVIDER_BRIDGE_CHANNELS.cancelImageJob, ProviderBridgeResponseSchemas.cancelImageJob],
  [PROVIDER_BRIDGE_CHANNELS.ackImageJobTerminal, ProviderBridgeResponseSchemas.ackImageJobTerminal],
  [PROVIDER_BRIDGE_CHANNELS.submitVideoJob, ProviderBridgeResponseSchemas.submitVideoJob],
  [PROVIDER_BRIDGE_CHANNELS.pollVideoJob, ProviderBridgeResponseSchemas.pollVideoJob],
  [PROVIDER_BRIDGE_CHANNELS.cancelVideoJob, ProviderBridgeResponseSchemas.cancelVideoJob],
  [PROVIDER_BRIDGE_CHANNELS.ackVideoJobTerminal, ProviderBridgeResponseSchemas.ackVideoJobTerminal],
  [PROVIDER_BRIDGE_CHANNELS.analyzeReversePrompt, ProviderBridgeResponseSchemas.analyzeReversePrompt],
  [PROVIDER_BRIDGE_CHANNELS.chat, ProviderBridgeResponseSchemas.chat],
  [PROVIDER_BRIDGE_CHANNELS.generateStoryboard, ProviderBridgeResponseSchemas.generateStoryboard],
]);

export type ProviderBridgeProvider = z.infer<typeof providerSchema>;
export type ProviderSelectionBridgeRequest = z.infer<typeof ProviderSelectionBridgeRequestSchema>;
export type ProviderBridgeCapability = z.infer<typeof capabilitySchema>;
export type ProviderBridgeBlockedReason = 'credentials_locked';
export type ProviderImageJobTerminalStatus = z.infer<typeof terminalStatusSchema>;
export type ProviderBridgeProfile = z.infer<typeof ProviderBridgeProfileSchema>;
export type ProviderConfigurationStatus = z.infer<typeof ProviderConfigurationStatusSchema>;
export type ProviderActiveState = z.infer<typeof ProviderActiveStateSchema>;
export type ListProviderTasksBridgeRequest = z.infer<typeof ListProviderTasksBridgeRequestSchema>;
export type ListProviderTasksBridgeResult = z.infer<typeof ListProviderTasksBridgeResultSchema>;
export type SetActiveProviderBridgeRequest = z.infer<typeof SetActiveProviderBridgeRequestSchema>;
export type LoginRelayMeBridgeRequest = z.infer<typeof LoginRelayMeBridgeRequestSchema>;
export type RevealProviderCredentialBridgeResult = z.infer<typeof RevealProviderCredentialBridgeResultSchema>;
export type ProviderConnectionCheckResult = z.infer<typeof ProviderConnectionCheckResultSchema>;
export type ConfigureProviderBridgeRequest = z.infer<typeof ConfigureProviderBridgeRequestSchema>;
export type UpdateProviderProfilesBridgeRequest = z.infer<typeof UpdateProviderProfilesBridgeRequestSchema>;
export type UnlockProviderBridgeRequest = z.infer<typeof UnlockProviderBridgeRequestSchema>;
export type SubmitImageJobBridgeRequest = z.infer<typeof SubmitImageJobBridgeRequestSchema>;
export type SubmitImageJobBridgeResult = z.infer<typeof SubmitImageJobBridgeResultSchema>;
export type PollImageJobBridgeRequest = z.infer<typeof PollImageJobBridgeRequestSchema>;
export type ProviderImageJobResult = z.infer<typeof ProviderImageJobResultSchema>;
export type PollImageJobBridgeResult = z.infer<typeof PollImageJobBridgeResultSchema>;
export type CancelImageJobBridgeRequest = z.infer<typeof CancelImageJobBridgeRequestSchema>;
export type CancelImageJobBridgeResult = z.infer<typeof CancelImageJobBridgeResultSchema>;
export type AckImageJobTerminalBridgeRequest = z.infer<typeof AckImageJobTerminalBridgeRequestSchema>;
export type AckImageJobTerminalBridgeResult = z.infer<typeof AckImageJobTerminalBridgeResultSchema>;
export type SubmitVideoJobBridgeRequest = z.infer<typeof SubmitVideoJobBridgeRequestSchema>;
export type SubmitVideoJobBridgeResult = z.infer<typeof SubmitVideoJobBridgeResultSchema>;
export type PollVideoJobBridgeRequest = z.infer<typeof PollVideoJobBridgeRequestSchema>;
export type PollVideoJobBridgeResult = z.infer<typeof PollVideoJobBridgeResultSchema>;
export type CancelVideoJobBridgeRequest = z.infer<typeof CancelVideoJobBridgeRequestSchema>;
export type CancelVideoJobBridgeResult = z.infer<typeof CancelVideoJobBridgeResultSchema>;
export type AckVideoJobTerminalBridgeRequest = z.infer<typeof AckVideoJobTerminalBridgeRequestSchema>;
export type AckVideoJobTerminalBridgeResult = z.infer<typeof AckVideoJobTerminalBridgeResultSchema>;
export type ProviderVideoJobResult = z.infer<typeof ProviderVideoJobResultSchema>;
export type ManagedReversePromptMediaIdentity = z.infer<typeof managedReversePromptMediaIdentitySchema>;
export type AnalyzeReversePromptBridgeRequest = z.infer<typeof AnalyzeReversePromptBridgeRequestSchema>;
export type AnalyzeReversePromptBridgeResult = z.infer<typeof AnalyzeReversePromptBridgeResultSchema>;
export type ChatSkillBridgeRequest = z.infer<typeof ChatSkillBridgeRequestSchema>;
export type ChatSkillBridgeResult = z.infer<typeof ChatSkillBridgeResultSchema>;
export type GenerateStoryboardBridgeRequest = z.infer<typeof GenerateStoryboardBridgeRequestSchema>;
export type GenerateStoryboardBridgeResult = z.infer<typeof GenerateStoryboardBridgeResultSchema>;
export type ProjectMemoryContextSnapshot = z.infer<typeof ProjectMemoryContextSnapshotSchema>;
export type ProviderBridgeIpcEnvelope<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ProviderBridgeError };

export interface ProviderBridgeException extends Error {
  code: ProviderBridgeErrorCode;
  retryable: boolean;
  reason?: ReverseProviderFailureReason;
}

export function parseProviderBridgeRequest(channel: string, request: unknown): unknown {
  const schema = REQUEST_SCHEMA_BY_CHANNEL.get(channel as ProviderBridgeChannel);
  if (schema === undefined) {
    throw createProviderBridgeError('INVALID_REQUEST', 'Unknown provider channel');
  }
  return parseWithProviderError(schema, request, 'INVALID_REQUEST', 'Provider request is invalid', 'request');
}

export function parseProviderBridgeResponse(channel: string, response: unknown): unknown {
  const schema = RESPONSE_SCHEMA_BY_CHANNEL.get(channel as ProviderBridgeChannel);
  if (schema === undefined) {
    throw createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Unknown provider channel');
  }
  return parseWithProviderError(schema, response, 'PROVIDER_INVALID_RESPONSE', 'Provider returned an invalid response', 'response');
}

export function createProviderBridgeSuccessEnvelope<T>(
  channel: string,
  value: T,
): ProviderBridgeIpcEnvelope<unknown> {
  return {
    ok: true,
    value: parseProviderBridgeResponse(channel, value),
  };
}

export function createProviderBridgeErrorEnvelope(error: unknown): ProviderBridgeIpcEnvelope<never> {
  const parsed = ProviderBridgeErrorSchema.safeParse(normalizeProviderBridgeError(error));
  return {
    ok: false,
    error: parsed.success
      ? parsed.data
      : normalizeProviderBridgeError(createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Provider returned an invalid response')),
  };
}

export function parseProviderBridgeEnvelope<T>(channel: string, envelope: unknown): T {
  const parsed = parseWithProviderError(
    providerBridgeEnvelopeSchema,
    envelope,
    'PROVIDER_INVALID_RESPONSE',
    'Provider IPC response envelope is invalid',
    'response',
  ) as z.infer<typeof providerBridgeEnvelopeSchema>;
  if (!parsed.ok) {
    throw createProviderBridgeError(parsed.error.code, parsed.error.message, parsed.error.retryable, parsed.error.reason);
  }
  return parseProviderBridgeResponse(channel, parsed.value) as T;
}

export function parseProviderBridgeProfiles(value: unknown): ProviderBridgeProfile[] {
  return parseWithProviderError(
    z.array(ProviderBridgeProfileSchema),
    value,
    'INVALID_REQUEST',
    'Provider profile configuration is invalid',
    'request',
  ) as ProviderBridgeProfile[];
}

export function parseProviderConfigurationSnapshot(value: unknown): {
  readonly baseUrl: string;
  readonly profiles: ProviderBridgeProfile[];
} {
  return parseWithProviderError(
    z.object({
      version: z.literal(1),
      baseUrl: nonEmptyStringSchema,
      profiles: z.array(ProviderBridgeProfileSchema),
    }).strict().superRefine((snapshot, context) => {
      addUnsafeBaseUrlIssues(snapshot.baseUrl, context);
      addProtectedPayloadIssues(snapshot, context, 'Provider configuration contains protected payload');
    }),
    value,
    'PROVIDER_UNAVAILABLE',
    'Provider configuration is invalid',
    'response',
  ) as { readonly version: 1; readonly baseUrl: string; readonly profiles: ProviderBridgeProfile[] };
}

export function createProviderBridgeError(
  code: ProviderBridgeErrorCode,
  message: string,
  retryable = false,
  reason?: ReverseProviderFailureReason,
): ProviderBridgeException {
  const error = new Error(sanitizeProviderMessage(message)) as ProviderBridgeException;
  error.code = code;
  error.retryable = retryable;
  if (reason !== undefined) error.reason = reason;
  return error;
}

export function normalizeProviderBridgeError(error: unknown): ProviderBridgeError {
  if (isProviderBridgeError(error)) {
    return {
      code: isProviderBridgeErrorCode(error.code) ? error.code : 'PROVIDER_ERROR',
      message: sanitizeProviderMessage(error.message),
      retryable: error.retryable,
      ...(ReverseProviderFailureReasonSchema.safeParse(error.reason).success
        ? { reason: error.reason as ReverseProviderFailureReason }
        : {}),
    };
  }
  return {
    code: 'PROVIDER_ERROR',
    message: sanitizeProviderMessage(error instanceof Error ? error.message : String(error ?? 'Provider request failed')),
    retryable: false,
  };
}

export function isProviderBridgeErrorCode(value: unknown): value is ProviderBridgeErrorCode {
  return errorCodeSchema.safeParse(value).success;
}

function parseWithProviderError(
  schema: ZodTypeAny,
  value: unknown,
  code: ProviderBridgeErrorCode,
  fallbackMessage: string,
  boundary: 'request' | 'response',
): unknown {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw createProviderBridgeError(code, zodErrorMessage(result.error, fallbackMessage, boundary));
}

function zodErrorMessage(error: z.ZodError, fallbackMessage: string, boundary: 'request' | 'response'): string {
  const first = error.issues[0];
  if (first?.code === 'unrecognized_keys') {
    return boundary === 'request' ? 'Request contains unknown key' : 'Provider returned a response with unknown key';
  }
  if (first?.code === 'custom' && first.message.length > 0) {
    return first.message;
  }
  return fallbackMessage;
}

function addUnsafeBaseUrlIssues(value: string, context: z.RefinementCtx): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Provider base URL is invalid' });
    return;
  }
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Provider base URL is invalid' });
  }
}

function addProtectedPayloadIssues(value: unknown, context: z.RefinementCtx, message: string): void {
  for (const text of collectStrings(value)) {
    if (containsProtectedProviderText(text)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message,
      });
      return;
    }
  }
}

function addUnsafeReversePromptPayloadIssues(value: unknown, context: z.RefinementCtx): void {
  for (const text of collectStrings(value)) {
    if (
      containsProtectedProviderText(text)
      || /\b(?:https?|file):\/\//iu.test(text)
      || /[A-Za-z]:\\/u.test(text)
      || /\\\\[^\\\s]+\\/u.test(text)
      || /(?:^|\s)\/(?:Users|home|var|etc|opt|tmp|private)\//u.test(text)
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Provider bridge payload contains protected payload' });
      return;
    }
  }
}

function addUnsafeSkillChatPayloadIssues(value: unknown, context: z.RefinementCtx): void {
  for (const text of collectStrings(value)) {
    if (
      containsProtectedProviderText(text)
      || /\b(?:https?|file):\/\//iu.test(text)
      || /[A-Za-z]:\\/u.test(text)
      || /\\\\[^\\\s]+\\/u.test(text)
      || /(?:^|\s)\/(?:Users|home|var|etc|opt|tmp|private)\//u.test(text)
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Provider bridge payload contains protected payload' });
      return;
    }
  }
}

function sanitizeProviderMessage(value: string): string {
  const sanitized = value
    .replace(/authorization\s*:\s*\S+(?:\s+\S+)?/giu, '[redacted]')
    .replace(/\bbearer\s+[a-z0-9._~+/=\-]+/giu, '[redacted]')
    .replace(/\bsk-[a-z0-9_-]{8,}\b/giu, '[redacted]')
    .replace(/\b(?:api[_ -]?key|token|secret|password)\s*[:=]\s*\S{4,}/giu, '[redacted]')
    .replace(/data:image\/[^;]+;base64,[a-z0-9+/=]+/giu, '[redacted]')
    .replace(/\b(?:https?|file):\/\/[^\s"'`]+/giu, '[redacted]')
    .replace(/\bbase64,[a-z0-9+/=]{16,}/giu, '[redacted]')
    .replace(/\biVBORw0KGgo[A-Za-z0-9+/=]{16,}\b/gu, '[redacted]')
    .replace(/(?<![A-Za-z0-9+/=_-])[A-Za-z0-9+/]{64,}={0,2}(?![A-Za-z0-9+/=_-])/gu, '[redacted]')
    .replace(/[A-Za-z]:[\\/][^\s"'`]+/gu, '[redacted]')
    .replace(/\\\\[^\\\s]+\\[^\s"'`]+/gu, '[redacted]')
    .replace(/(?:^|\s)\/(?:[^\s"'`/]+\/)+[^\s"'`]+/gu, ' [redacted]')
    .replace(/(?:^|\s)\/(?:Users|home|var|etc|opt|tmp|private)\/[^\s"'`]+/gu, ' [redacted]')
    .replace(/\s+/gu, ' ')
    .trim();
  return (sanitized || 'Provider request failed').slice(0, 180);
}

function containsProtectedProviderText(value: string): boolean {
  return /authorization\s*:/iu.test(value)
    || /\bbearer\s+[a-z0-9._~+/=\-]{8,}/iu.test(value)
    || /\b(?:api[_ -]?key|token|secret|password)\s*[:=]\s*\S{4,}/iu.test(value)
    || /\bsk-[a-z0-9_-]{8,}\b/iu.test(value)
    || /data:image\/[a-z0-9.+-]+;base64,/iu.test(value)
    || /base64,[a-z0-9+/=]{16,}/iu.test(value)
    || containsRawBinaryBase64(value)
    || /(?:^|[^A-Za-z0-9])[A-Za-z]:[\\/]/u.test(value)
    || /\\\\[^\\\s]+\\/u.test(value)
    || /(?:^|\s)\/(?:Users|home|var|etc|opt|tmp|private|srv)\//u.test(value);
}

function containsRawBinaryBase64(value: string): boolean {
  return /(?:^|[^A-Za-z0-9+/=])(?:iVBORw0KGgo|\/9j\/|R0lGOD|UklGR|JVBERi0|UEsDBA|UEsFBg|UEsHCA|H4sI|Qk0)[A-Za-z0-9+/=]{12,}/u.test(value);
}

function containsRawProviderTaskIdentifier(value: string): boolean {
  return /\braw-[a-z0-9._:-]+\b/iu.test(value)
    || /\/v1\/images\/tasks\//iu.test(value);
}

function collectStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  if (isRecord(value)) return Object.values(value).flatMap(collectStrings);
  return [];
}

function isProviderBridgeError(error: unknown): error is ProviderBridgeException {
  return isRecord(error)
    && typeof error.code === 'string'
    && typeof error.message === 'string'
    && typeof error.retryable === 'boolean';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}
