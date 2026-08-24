import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProviderOperationTimeoutError, withProviderOperationTimeout } from './provider-operation-timeout';

afterEach(() => {
  vi.useRealTimers();
});

describe('withProviderOperationTimeout', () => {
  it('returns the provider result when the operation settles in time', async () => {
    await expect(withProviderOperationTimeout(Promise.resolve('ok'), 100)).resolves.toBe('ok');
  });

  it('rejects with a typed timeout error when the provider operation never settles', async () => {
    vi.useFakeTimers();
    const result = withProviderOperationTimeout(new Promise<string>(() => undefined), 1_000);
    const expectation = expect(result).rejects.toBeInstanceOf(ProviderOperationTimeoutError);

    await vi.advanceTimersByTimeAsync(1_000);

    await expectation;
  });
});