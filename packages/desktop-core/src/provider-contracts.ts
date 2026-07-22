import { z, type ZodTypeAny } from 'zod';

export const PROVIDER_BRIDGE_CHANNELS = {
  getStatus: 'novus-desktop:provider:get-status',
  checkConnection: 'novus-desktop:provider:check-connection',
  configure: 'novus-desktop:provider:configure',
  unlock: 'novus-desktop:provider:unlock',
  listProfiles: 'novus-desktop:provider:list-profiles',
  submitImageJob: 'novus-desktop:provider:submit-image-job',
  pollImageJob: 'novus-desktop:provider:poll-image-job',
  cancelImageJob: 'novus-desktop:provider:cancel-image-job',
  ackImageJobTerminal: 'novus-desktop:provider:ack-image-job-terminal',
} as const;

export type ProviderBridgeChannel = typeof PROVIDER_BRIDGE_CHANNELS[keyof typeof PROVIDER_BRIDGE_CHANNELS];

const nonEmptyStringSchema = z.string().min(1);
const secretStringSchema = z.string().min(1);
const providerSchema = z.literal('comfly');
const capabilitySchema = z.enum([
  'chat',
  'vision',
  'image_generation',
  'image_edit',
  'responses',
  'gemini_native',
  'async_tasks',
]);
const errorCodeSchema = z.enum([
  'INVALID_REQUEST',
  'CREDENTIALS_LOCKED',
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_INVALID_RESPONSE',
  'PROTECTED_PAYLOAD',
  'PROVIDER_ERROR',
]);
export type ProviderBridgeErrorCode = z.infer<typeof errorCodeSchema>;
export interface ProviderBridgeError {
  code: ProviderBridgeErrorCode;
  message: string;
  retryable: boolean;
}
const terminalStatusSchema = z.enum(['completed', 'failed', 'cancelled']);
const progressSchema = z.number().finite().min(0).max(1);
const finiteNumberSchema = z.number().finite();
const noPayloadSchema = z.union([z.undefined(), z.object({}).strict()]).transform(() => undefined);

export const ProviderBridgeProfileSchema = z.object({
  provider: providerSchema,
  modelRoute: nonEmptyStringSchema,
  displayName: nonEmptyStringSchema,
  modelId: nonEmptyStringSchema.optional(),
  capabilities: z.array(capabilitySchema),
}).strict().superRefine((value, context) => {
  addProtectedPayloadIssues(value, context, 'Provider bridge payload contains protected payload');
});

export const ProviderConfigurationStatusSchema = z.object({
  configured: z.boolean(),
  locked: z.boolean(),
  encryption: z.enum(['safeStorage', 'passphrase', 'unavailable']),
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
  token: secretStringSchema,
  passphrase: secretStringSchema.optional(),
  baseUrl: nonEmptyStringSchema.optional(),
  profiles: z.array(ProviderBridgeProfileSchema).optional(),
}).strict().superRefine((value, context) => {
  addProtectedPayloadIssues({
    baseUrl: value.baseUrl,
    profiles: value.profiles,
  }, context, 'Provider bridge payload contains protected payload');
  if (value.baseUrl !== undefined) {
    addUnsafeBaseUrlIssues(value.baseUrl, context);
  }
});

export const UnlockProviderBridgeRequestSchema = z.object({
  passphrase: secretStringSchema,
}).strict();

export const SubmitImageJobBridgeRequestSchema = z.object({
  jobId: nonEmptyStringSchema,
  provider: providerSchema,
  modelRoute: nonEmptyStringSchema,
  prompt: nonEmptyStringSchema,
  conversationId: nonEmptyStringSchema,
  referenceAssetIds: z.array(nonEmptyStringSchema),
}).strict().superRefine((value, context) => {
  addProtectedPayloadIssues(value, context, 'Provider bridge payload contains protected payload');
});

export const SubmitImageJobBridgeResultSchema = z.object({
  providerTaskId: nonEmptyStringSchema.regex(/^provider-job-[a-f0-9]{32}$/u),
}).strict().superRefine((value, context) => {
  addProtectedPayloadIssues(value, context, 'Provider bridge payload contains protected payload');
});

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
  assetId: nonEmptyStringSchema.regex(/^provider-result-provider-job-[a-f0-9]{32}$/u),
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

export const ProviderBridgeRequestSchemas = {
  getStatus: noPayloadSchema,
  checkConnection: noPayloadSchema,
  configure: ConfigureProviderBridgeRequestSchema,
  unlock: UnlockProviderBridgeRequestSchema,
  listProfiles: noPayloadSchema,
  submitImageJob: SubmitImageJobBridgeRequestSchema,
  pollImageJob: PollImageJobBridgeRequestSchema,
  cancelImageJob: CancelImageJobBridgeRequestSchema,
  ackImageJobTerminal: AckImageJobTerminalBridgeRequestSchema,
} as const satisfies Record<keyof typeof PROVIDER_BRIDGE_CHANNELS, ZodTypeAny>;

export const ProviderBridgeResponseSchemas = {
  getStatus: ProviderConfigurationStatusSchema,
  checkConnection: ProviderConnectionCheckResultSchema,
  configure: ProviderConfigurationStatusSchema,
  unlock: ProviderConfigurationStatusSchema,
  listProfiles: z.array(ProviderBridgeProfileSchema),
  submitImageJob: SubmitImageJobBridgeResultSchema,
  pollImageJob: PollImageJobBridgeResultSchema,
  cancelImageJob: CancelImageJobBridgeResultSchema,
  ackImageJobTerminal: AckImageJobTerminalBridgeResultSchema,
} as const satisfies Record<keyof typeof PROVIDER_BRIDGE_CHANNELS, ZodTypeAny>;

const providerBridgeEnvelopeSchema = z.union([
  z.object({ ok: z.literal(true), value: z.unknown() }).strict(),
  z.object({ ok: z.literal(false), error: ProviderBridgeErrorSchema }).strict(),
]);

const REQUEST_SCHEMA_BY_CHANNEL = new Map<ProviderBridgeChannel, ZodTypeAny>([
  [PROVIDER_BRIDGE_CHANNELS.getStatus, ProviderBridgeRequestSchemas.getStatus],
  [PROVIDER_BRIDGE_CHANNELS.checkConnection, ProviderBridgeRequestSchemas.checkConnection],
  [PROVIDER_BRIDGE_CHANNELS.configure, ProviderBridgeRequestSchemas.configure],
  [PROVIDER_BRIDGE_CHANNELS.unlock, ProviderBridgeRequestSchemas.unlock],
  [PROVIDER_BRIDGE_CHANNELS.listProfiles, ProviderBridgeRequestSchemas.listProfiles],
  [PROVIDER_BRIDGE_CHANNELS.submitImageJob, ProviderBridgeRequestSchemas.submitImageJob],
  [PROVIDER_BRIDGE_CHANNELS.pollImageJob, ProviderBridgeRequestSchemas.pollImageJob],
  [PROVIDER_BRIDGE_CHANNELS.cancelImageJob, ProviderBridgeRequestSchemas.cancelImageJob],
  [PROVIDER_BRIDGE_CHANNELS.ackImageJobTerminal, ProviderBridgeRequestSchemas.ackImageJobTerminal],
]);

const RESPONSE_SCHEMA_BY_CHANNEL = new Map<ProviderBridgeChannel, ZodTypeAny>([
  [PROVIDER_BRIDGE_CHANNELS.getStatus, ProviderBridgeResponseSchemas.getStatus],
  [PROVIDER_BRIDGE_CHANNELS.checkConnection, ProviderBridgeResponseSchemas.checkConnection],
  [PROVIDER_BRIDGE_CHANNELS.configure, ProviderBridgeResponseSchemas.configure],
  [PROVIDER_BRIDGE_CHANNELS.unlock, ProviderBridgeResponseSchemas.unlock],
  [PROVIDER_BRIDGE_CHANNELS.listProfiles, ProviderBridgeResponseSchemas.listProfiles],
  [PROVIDER_BRIDGE_CHANNELS.submitImageJob, ProviderBridgeResponseSchemas.submitImageJob],
  [PROVIDER_BRIDGE_CHANNELS.pollImageJob, ProviderBridgeResponseSchemas.pollImageJob],
  [PROVIDER_BRIDGE_CHANNELS.cancelImageJob, ProviderBridgeResponseSchemas.cancelImageJob],
  [PROVIDER_BRIDGE_CHANNELS.ackImageJobTerminal, ProviderBridgeResponseSchemas.ackImageJobTerminal],
]);

export type ProviderBridgeProvider = z.infer<typeof providerSchema>;
export type ProviderBridgeCapability = z.infer<typeof capabilitySchema>;
export type ProviderBridgeBlockedReason = 'credentials_locked';
export type ProviderImageJobTerminalStatus = z.infer<typeof terminalStatusSchema>;
export type ProviderBridgeProfile = z.infer<typeof ProviderBridgeProfileSchema>;
export type ProviderConfigurationStatus = z.infer<typeof ProviderConfigurationStatusSchema>;
export type ProviderConnectionCheckResult = z.infer<typeof ProviderConnectionCheckResultSchema>;
export type ConfigureProviderBridgeRequest = z.infer<typeof ConfigureProviderBridgeRequestSchema>;
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
export type ProviderBridgeIpcEnvelope<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ProviderBridgeError };

export interface ProviderBridgeException extends Error {
  code: ProviderBridgeErrorCode;
  retryable: boolean;
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
    throw createProviderBridgeError(parsed.error.code, parsed.error.message, parsed.error.retryable);
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
): ProviderBridgeException {
  const error = new Error(sanitizeProviderMessage(message)) as ProviderBridgeException;
  error.code = code;
  error.retryable = retryable;
  return error;
}

export function normalizeProviderBridgeError(error: unknown): ProviderBridgeError {
  if (isProviderBridgeError(error)) {
    return {
      code: isProviderBridgeErrorCode(error.code) ? error.code : 'PROVIDER_ERROR',
      message: sanitizeProviderMessage(error.message),
      retryable: error.retryable,
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

function sanitizeProviderMessage(value: string): string {
  const sanitized = value
    .replace(/authorization\s*:\s*\S+(?:\s+\S+)?/giu, '[redacted]')
    .replace(/\bbearer\s+[a-z0-9._~+/=\-]+/giu, '[redacted]')
    .replace(/\bsk-[a-z0-9_-]{8,}\b/giu, '[redacted]')
    .replace(/\b(?:api[_ -]?key|token|secret|password)\s*[:=]\s*\S{4,}/giu, '[redacted]')
    .replace(/data:image\/[^;]+;base64,[a-z0-9+/=]+/giu, '[redacted]')
    .replace(/[A-Za-z]:[\\/][^\s"'`]+/gu, '[redacted]')
    .replace(/\\\\[^\\\s]+\\[^\s"'`]+/gu, '[redacted]')
    .replace(/(?:^|\s)\/(?:Users|home|var|opt|tmp|private)\/[^\s"'`]+/gu, ' [redacted]')
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
    || /[A-Za-z]:\\/u.test(value)
    || /\\\\[^\\\s]+\\/u.test(value)
    || /(?:^|\s)\/(?:Users|home|var|etc|opt|tmp|private)\//u.test(value);
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
