export class ProviderOperationTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Provider operation timed out after ${timeoutMs}ms`);
    this.name = 'ProviderOperationTimeoutError';
  }
}

export function withProviderOperationTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeoutId = globalThis.setTimeout(() => reject(new ProviderOperationTimeoutError(timeoutMs)), timeoutMs);
    operation.then(
      (value) => {
        globalThis.clearTimeout(timeoutId);
        resolve(value);
      },
      (error) => {
        globalThis.clearTimeout(timeoutId);
        reject(error);
      },
    );
  });
}