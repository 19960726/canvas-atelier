import type { PersistenceError, PersistenceErrorCode } from './contracts.js';

export function createPersistenceError(
  code: PersistenceErrorCode,
  retryable: boolean,
  message: string,
  cause?: unknown,
): PersistenceError {
  const error = new Error(message) as PersistenceError & { cause?: unknown };
  error.name = 'PersistenceError';
  Object.defineProperty(error, 'code', {
    enumerable: true,
    value: code,
  });
  Object.defineProperty(error, 'retryable', {
    enumerable: true,
    value: retryable,
  });
  if (cause !== undefined) {
    Object.defineProperty(error, 'cause', { enumerable: false, value: cause });
  }
  return error;
}

export function normalizePersistenceError(error: unknown, operation: string): Error {
  if (isPersistenceError(error)) return error;
  const errno = readErrno(error);
  if (errno === 'ENOSPC') {
    return createPersistenceError('DISK_FULL', true, `${operation}: storage is full`);
  }
  if (errno === 'EACCES' || errno === 'EPERM') {
    return createPersistenceError('PERMISSION_DENIED', true, `${operation}: permission was denied`);
  }
  if (errno === 'EROFS') {
    return createPersistenceError('READ_ONLY_VOLUME', false, `${operation}: project storage is read-only`);
  }
  return createPersistenceError(
    'DURABLE_WRITE_FAILED',
    true,
    `${operation}: durable storage operation failed`,
    error,
  );
}

function isPersistenceError(error: unknown): error is PersistenceError {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && 'retryable' in error
    && typeof (error as { code?: unknown }).code === 'string'
    && typeof (error as { retryable?: unknown }).retryable === 'boolean';
}

function readErrno(error: unknown): string | null {
  return typeof error === 'object' && error !== null && 'code' in error
    && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : null;
}
