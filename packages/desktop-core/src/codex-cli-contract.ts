import { z } from 'zod';

export const CODEX_ASTRA_MODEL_ID = 'gpt-6-astra' as const;
export const CODEX_ASTRA_MODEL_ROUTE = `codex/${CODEX_ASTRA_MODEL_ID}` as const;

export const CODEX_CLI_CHANNELS = {
  listProfiles: 'novus-desktop:codex-cli:list-profiles',
  chat: 'novus-desktop:codex-cli:chat',
  cancel: 'novus-desktop:codex-cli:cancel',
} as const;

export const CODEX_REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
export type CodexReasoningEffort = typeof CODEX_REASONING_EFFORTS[number];

const CODEX_MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/u;
const CODEX_MODEL_ROUTE_PATTERN = /^codex\/[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/u;

export function isCodexModelId(value: string): boolean {
  return CODEX_MODEL_ID_PATTERN.test(value);
}

export function isCodexModelRoute(value: string): boolean {
  return CODEX_MODEL_ROUTE_PATTERN.test(value);
}

export interface CodexCliProfile {
  readonly provider: 'codex';
  readonly modelRoute: `codex/${string}`;
  readonly modelId: string;
  readonly displayName: string;
  readonly capabilities: readonly ['responses'];
  readonly capabilityStatus: 'complete';
  readonly transport: 'codex-cli';
  readonly availability: 'installed';
  readonly supportedReasoningEfforts?: readonly CodexReasoningEffort[];
  readonly defaultReasoningEffort?: CodexReasoningEffort;
}

export const CODEX_ASTRA_PROFILE: CodexCliProfile = Object.freeze({
  provider: 'codex',
  modelRoute: CODEX_ASTRA_MODEL_ROUTE,
  modelId: CODEX_ASTRA_MODEL_ID,
  displayName: 'GPT-6 Astra',
  capabilities: ['responses'] as const,
  capabilityStatus: 'complete',
  transport: 'codex-cli',
  availability: 'installed',
});

const safeIdSchema = z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/u);
const safeAssetIdSchema = z.string().regex(/^[a-f0-9]{16}$/u);
const messageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().trim().min(1).max(16_000),
}).strict();

export const CodexCliChatRequestSchema = z.object({
  provider: z.literal('codex'),
  modelRoute: z.string().regex(CODEX_MODEL_ROUTE_PATTERN),
  sessionId: safeIdSchema,
  requestId: safeIdSchema,
  agentMode: z.literal('codex'),
  reasoningEffort: z.enum(CODEX_REASONING_EFFORTS).optional().default('medium'),
  messages: z.array(messageSchema).min(1).max(48),
  context: z.object({
    knowledgeBaseIds: z.array(safeIdSchema).max(16),
    projectMemoryIds: z.array(safeIdSchema).max(32),
  }).strict(),
  // References are opaque project asset ids. The desktop main process resolves
  // them to short-lived files before invoking the CLI; paths never cross IPC.
  referenceAssetIds: z.array(safeAssetIdSchema).max(20).optional(),
  referenceMentions: z.array(z.object({
    assetId: safeAssetIdSchema,
    label: z.string().trim().min(1).max(160),
    mention: z.string().trim().regex(/^@图片[1-9][0-9]{0,2}$/u),
  }).strict()).max(20).optional(),
  visualAnalysis: z.boolean().optional(),
}).strict().superRefine((value, context) => {
  const referenceAssetIds = value.referenceAssetIds ?? [];
  if (new Set(referenceAssetIds).size !== referenceAssetIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['referenceAssetIds'], message: 'Codex image references must be unique' });
  }
  const referenceMentions = value.referenceMentions ?? [];
  if (referenceMentions.length > 0 && (
    referenceMentions.length !== referenceAssetIds.length
    || referenceMentions.some((reference, index) => (
      reference.assetId !== referenceAssetIds[index]
    ))
    || new Set(referenceMentions.map((reference) => reference.mention)).size !== referenceMentions.length
  )) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['referenceMentions'], message: 'Codex image mentions must match ordered references' });
  }
  if (value.visualAnalysis === true && referenceMentions.length === 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['visualAnalysis'], message: 'Visual analysis requires ordered image mentions' });
  }
});

const codexSourceSchema = z.object({
  knowledgeBaseId: safeIdSchema,
  version: z.number().int().positive(),
  displayName: z.string().trim().min(1).max(160).optional(),
}).strict();

export const CodexCliChatResultSchema = z.object({
  message: z.string().trim().min(1).max(16_000),
  modelRoute: z.string().regex(CODEX_MODEL_ROUTE_PATTERN),
  sources: z.array(codexSourceSchema).max(16),
}).strict();

export type CodexCliChatRequest = z.infer<typeof CodexCliChatRequestSchema>;
export type CodexCliChatResult = z.infer<typeof CodexCliChatResultSchema>;

export const CodexCliCancelRequestSchema = z.object({ requestId: safeIdSchema }).strict();
export const CodexCliCancelResultSchema = z.object({ cancelled: z.boolean() }).strict();
export type CodexCliCancelRequest = z.infer<typeof CodexCliCancelRequestSchema>;
export type CodexCliCancelResult = z.infer<typeof CodexCliCancelResultSchema>;

export function parseCodexCliCancelRequest(value: unknown): CodexCliCancelRequest {
  return CodexCliCancelRequestSchema.parse(value);
}

export function parseCodexCliCancelResult(value: unknown): CodexCliCancelResult {
  return CodexCliCancelResultSchema.parse(value);
}

export type CodexCliErrorCode =
  | 'CODEX_CLI_NOT_INSTALLED'
  | 'CODEX_CLI_INVALID_REQUEST'
  | 'CODEX_CLI_AUTH_REQUIRED'
  | 'CODEX_CLI_UPSTREAM_UNAVAILABLE'
  | 'CODEX_CLI_UNSAFE_RUNTIME'
  | 'CODEX_CLI_INVALID_RESPONSE'
  | 'CODEX_CLI_FORBIDDEN_SIDE_EFFECT'
  | 'CODEX_CLI_MCP_FAILED'
  | 'CODEX_CLI_BUSY'
  | 'CODEX_CLI_CANCELLED'
  | 'CODEX_CLI_TIMEOUT'
  | 'CODEX_CLI_FAILED';

export interface CodexCliBridgeError {
  readonly code: CodexCliErrorCode;
  readonly message: string;
  readonly retryable: boolean;
}

export type CodexCliBridgeEnvelope<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: CodexCliBridgeError };

export class CodexCliBridgeException extends Error {
  readonly code: CodexCliErrorCode;
  readonly retryable: boolean;

  constructor(error: CodexCliBridgeError) {
    super(error.message);
    this.name = 'CodexCliBridgeException';
    this.code = error.code;
    this.retryable = error.retryable;
  }
}

export function parseCodexCliProfiles(value: unknown): CodexCliProfile[] {
  const profileSchema = z.object({
    provider: z.literal('codex'),
    modelRoute: z.string().regex(CODEX_MODEL_ROUTE_PATTERN),
    modelId: z.string().regex(CODEX_MODEL_ID_PATTERN),
    displayName: z.string().trim().min(1).max(160),
    capabilities: z.tuple([z.literal('responses')]),
    capabilityStatus: z.literal('complete'),
    transport: z.literal('codex-cli'),
    availability: z.literal('installed'),
    supportedReasoningEfforts: z.array(z.enum(CODEX_REASONING_EFFORTS)).min(1).max(6).optional(),
    defaultReasoningEffort: z.enum(CODEX_REASONING_EFFORTS).optional(),
  }).strict();
  const parsed = z.array(profileSchema).max(32).parse(value);
  return parsed.map((profile) => ({
    ...profile,
    modelRoute: profile.modelRoute as `codex/${string}`,
  }));
}

export function parseCodexCliChatRequest(value: unknown): CodexCliChatRequest {
  return CodexCliChatRequestSchema.parse(value);
}

export function parseCodexCliChatResult(value: unknown): CodexCliChatResult {
  return CodexCliChatResultSchema.parse(value);
}

export function unwrapCodexCliEnvelope<T>(
  value: unknown,
  parseValue: (input: unknown) => T,
): T {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new CodexCliBridgeException({ code: 'CODEX_CLI_INVALID_RESPONSE', message: 'Codex CLI 返回内容无效。', retryable: true });
  }
  const envelope = value as Record<string, unknown>;
  if (envelope.ok === true) return parseValue(envelope.value);
  if (envelope.ok !== false || envelope.error === null || typeof envelope.error !== 'object' || Array.isArray(envelope.error)) {
    throw new CodexCliBridgeException({ code: 'CODEX_CLI_INVALID_RESPONSE', message: 'Codex CLI 返回内容无效。', retryable: true });
  }
  const error = envelope.error as Record<string, unknown>;
  const code = error.code;
  const allowedCodes: readonly CodexCliErrorCode[] = [
    'CODEX_CLI_NOT_INSTALLED', 'CODEX_CLI_INVALID_REQUEST', 'CODEX_CLI_AUTH_REQUIRED',
    'CODEX_CLI_UPSTREAM_UNAVAILABLE', 'CODEX_CLI_UNSAFE_RUNTIME', 'CODEX_CLI_INVALID_RESPONSE', 'CODEX_CLI_FORBIDDEN_SIDE_EFFECT',
    'CODEX_CLI_MCP_FAILED', 'CODEX_CLI_BUSY', 'CODEX_CLI_CANCELLED', 'CODEX_CLI_TIMEOUT', 'CODEX_CLI_FAILED',
  ];
  if (!allowedCodes.includes(code as CodexCliErrorCode) || typeof error.message !== 'string' || typeof error.retryable !== 'boolean') {
    throw new CodexCliBridgeException({ code: 'CODEX_CLI_INVALID_RESPONSE', message: 'Codex CLI 返回内容无效。', retryable: true });
  }
  throw new CodexCliBridgeException({ code: code as CodexCliErrorCode, message: error.message.slice(0, 240), retryable: error.retryable });
}
