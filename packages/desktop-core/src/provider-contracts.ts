export const PROVIDER_BRIDGE_CHANNELS = {
  getStatus: 'novus-desktop:provider:get-status',
  configure: 'novus-desktop:provider:configure',
  unlock: 'novus-desktop:provider:unlock',
  listProfiles: 'novus-desktop:provider:list-profiles',
  submitImageJob: 'novus-desktop:provider:submit-image-job',
  pollImageJob: 'novus-desktop:provider:poll-image-job',
  cancelImageJob: 'novus-desktop:provider:cancel-image-job',
} as const;

export type ProviderBridgeChannel = typeof PROVIDER_BRIDGE_CHANNELS[keyof typeof PROVIDER_BRIDGE_CHANNELS];
export type ProviderBridgeProvider = 'comfly';

export type ProviderBridgeCapability =
  | 'chat'
  | 'vision'
  | 'image_generation'
  | 'image_edit'
  | 'responses'
  | 'gemini_native'
  | 'async_tasks';

export type ProviderBridgeErrorCode =
  | 'INVALID_REQUEST'
  | 'CREDENTIALS_LOCKED'
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_INVALID_RESPONSE'
  | 'PROTECTED_PAYLOAD'
  | 'PROVIDER_ERROR';

export interface ProviderBridgeError {
  readonly code: ProviderBridgeErrorCode;
  readonly message: string;
  readonly retryable: boolean;
}

export interface ProviderBridgeException extends Error {
  code: ProviderBridgeErrorCode;
  retryable: boolean;
}

export interface ProviderBridgeProfile {
  readonly provider: ProviderBridgeProvider;
  readonly modelRoute: string;
  readonly displayName: string;
  readonly modelId?: string;
  readonly capabilities: readonly ProviderBridgeCapability[];
}

export interface ProviderConfigurationStatus {
  readonly configured: boolean;
  readonly locked: boolean;
  readonly encryption: 'safeStorage' | 'passphrase' | 'unavailable';
}

export interface ConfigureProviderBridgeRequest {
  readonly token: string;
  readonly passphrase?: string;
  readonly baseUrl?: string;
  readonly profiles?: readonly ProviderBridgeProfile[];
}

export interface UnlockProviderBridgeRequest {
  readonly passphrase: string;
}

export interface SubmitImageJobBridgeRequest {
  readonly jobId: string;
  readonly provider: ProviderBridgeProvider;
  readonly modelRoute: string;
  readonly prompt: string;
  readonly conversationId: string;
  readonly referenceAssetIds: readonly string[];
}

export interface SubmitImageJobBridgeResult {
  readonly providerTaskId: string;
}

export interface PollImageJobBridgeRequest {
  readonly provider: ProviderBridgeProvider;
  readonly providerTaskId: string;
}

export interface ProviderImageJobResult {
  readonly assetId: string;
  readonly url?: string;
  readonly width?: number;
  readonly height?: number;
}

export type PollImageJobBridgeResult =
  | { readonly status: 'running'; readonly progress?: number }
  | { readonly status: 'completed'; readonly progress?: number; readonly result: ProviderImageJobResult }
  | { readonly status: 'failed'; readonly error: ProviderBridgeError };

export interface CancelImageJobBridgeRequest {
  readonly provider: ProviderBridgeProvider;
  readonly providerTaskId: string;
}

export interface CancelImageJobBridgeResult {
  readonly status: 'local-only';
  readonly remoteCancelled: false;
  readonly reason: 'unsupported';
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
      code: error.code,
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

function isProviderBridgeError(error: unknown): error is ProviderBridgeException {
  return isRecord(error)
    && typeof error.code === 'string'
    && typeof error.message === 'string'
    && typeof error.retryable === 'boolean';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}
