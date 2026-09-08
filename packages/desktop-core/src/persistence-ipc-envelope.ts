import type { PersistenceErrorCode } from './contracts.js';
import { createPersistenceError } from './persistence-error.js';

const PERSISTENCE_ERROR_CODES = new Set<PersistenceErrorCode>([
  'DISK_FULL',
  'DURABLE_WRITE_FAILED',
  'PERMISSION_DENIED',
  'READ_ONLY_VOLUME',
  'REVISION_CONFLICT',
  'CONCURRENT_WRITER',
  'RECOVERY_REQUIRED',
  'MISSING_ASSET',
  'CORRUPT_SNAPSHOT',
  'CORRUPT_JOURNAL',
  'UNSUPPORTED_PROJECT_VERSION',
  'PACKAGE_VALIDATION_FAILED',
  'INVALID_REQUEST',
  'INVALID_SESSION',
]);

export type PersistenceIpcFailure = {
  readonly ok: false;
  readonly error: {
    readonly code: PersistenceErrorCode;
    readonly retryable: boolean;
  };
};

export type PersistenceIpcEnvelope<T> =
  | { readonly ok: true; readonly value: T }
  | PersistenceIpcFailure;

export async function capturePersistenceIpcResult<T>(
  operation: () => Promise<T>,
): Promise<PersistenceIpcEnvelope<T>> {
  try {
    return { ok: true, value: await operation() };
  } catch (error) {
    return {
      error: {
        code: readPersistenceErrorCode(error),
        retryable: readPersistenceRetryable(error),
      },
      ok: false,
    };
  }
}

export function unwrapPersistenceIpcResult<T>(value: unknown): T {
  const decoded = decodePersistenceIpcResult<T>(value);
  if (!isPersistenceIpcFailure(decoded)) return decoded;
  const { code, retryable } = decoded.error;
  throw createPersistenceError(code, retryable, `Desktop persistence operation failed with ${code}`);
}

export function decodePersistenceIpcResult<T>(value: unknown): T | PersistenceIpcFailure {
  if (isRecord(value) && value.ok === true && 'value' in value) return value.value as T;
  if (isRecord(value) && value.ok === false && isRecord(value.error)) {
    const code = readPersistenceErrorCode(value.error);
    const retryable = typeof value.error.retryable === 'boolean' ? value.error.retryable : false;
    return { error: { code, retryable }, ok: false };
  }
  return { error: { code: 'INVALID_REQUEST', retryable: false }, ok: false };
}

export function isPersistenceIpcFailure(value: unknown): value is PersistenceIpcFailure {
  return isRecord(value)
    && value.ok === false
    && isRecord(value.error)
    && typeof value.error.code === 'string'
    && typeof value.error.retryable === 'boolean';
}

function readPersistenceErrorCode(error: unknown): PersistenceErrorCode {
  if (!isRecord(error) || typeof error.code !== 'string') return 'DURABLE_WRITE_FAILED';
  return PERSISTENCE_ERROR_CODES.has(error.code as PersistenceErrorCode)
    ? error.code as PersistenceErrorCode
    : 'DURABLE_WRITE_FAILED';
}

function readPersistenceRetryable(error: unknown): boolean {
  return isRecord(error) && typeof error.retryable === 'boolean' ? error.retryable : true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
