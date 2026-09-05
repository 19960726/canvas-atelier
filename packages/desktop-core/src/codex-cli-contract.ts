import { z } from 'zod';

export const CODEX_ASTRA_MODEL_ID = 'gpt-6-astra' as const;
export const CODEX_ASTRA_MODEL_ROUTE = `codex/${CODEX_ASTRA_MODEL_ID}` as const;

export const CODEX_CLI_CHANNELS = {
  listProfiles: 'novus-desktop:codex-cli:list-profiles',
  chat: 'novus-desktop:codex-cli:chat',
  cancel: 'novus-desktop:codex-cli:cancel',
} as const;

export type CodexReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface CodexCliProfile {
  readonly provider: 'codex';
  readonly modelRoute: typeof CODEX_ASTRA_MODEL_ROUTE;
  readonly modelId: typeof CODEX_ASTRA_MODEL_ID;
  readonly displayName: 'GPT-6 Astra';
  readonly capabilities: readonly ['responses'];
  readonly capabilityStatus: 'complete';
  readonly transport: 'codex-cli';
  readonly availability: 'installed';
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
  modelRoute: z.literal(CODEX_ASTRA_MODEL_ROUTE),
  sessionId: safeIdSchema,
  requestId: safeIdSchema,
  agentMode: z.literal('codex'),
  reasoningEffort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional().default('medium'),
  messages: z.array(messageSchema).min(1).max(48),
  context: z.object({
    knowledgeBaseIds: z.array(safeIdSchema).max(16),
    projectMemoryIds: z.array(safeIdSchema).max(32),
  }).strict(),
  // The initial local route is deliberately text/MCP-only. A future image
  // implementation must add an audited managed-file adapter before widening
  // either of these arrays.
  referenceAssetIds: z.array(safeAssetIdSchema).max(0).optional(),
  referenceMentions: z.array(z.never()).max(0).optional(),
  visualAnalysis: z.boolean().optional(),
}).strict();

const codexSourceSchema = z.object({
  knowledgeBaseId: safeIdSchema,
  version: z.number().int().positive(),
  displayName: z.string().trim().min(1).max(160).optional(),
}).strict();

export const CodexCliChatResultSchema = z.object({
  message: z.string().trim().min(1).max(16_000),
  modelRoute: z.literal(CODEX_ASTRA_MODEL_ROUTE),
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
    modelRoute: z.literal(CODEX_ASTRA_MODEL_ROUTE),
    modelId: z.literal(CODEX_ASTRA_MODEL_ID),
    displayName: z.literal('GPT-6 Astra'),
    capabilities: z.tuple([z.literal('responses')]),
    capabilityStatus: z.literal('complete'),
    transport: z.literal('codex-cli'),
    availability: z.literal('installed'),
  }).strict();
  return z.array(profileSchema).max(1).parse(value);
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
