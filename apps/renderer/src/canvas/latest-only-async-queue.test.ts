import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLatestOnlyAsyncQueue } from './latest-only-async-queue';

describe('createLatestOnlyAsyncQueue', () => {
  it('starts the first value immediately and coalesces rapid follow-up values', async () => {
    const worker = vi.fn(async (value: string) => value === 'latest');
    const queue = createLatestOnlyAsyncQueue(worker, 5);

    const first = queue.enqueue('first');
    const middle = queue.enqueue('middle');
    const latest = queue.enqueue('latest');

    expect(worker).toHaveBeenCalledWith('first');

    await expect(first).resolves.toBe(false);
    await expect(middle).resolves.toBe(true);
    await expect(latest).resolves.toBe(true);
    expect(worker).toHaveBeenCalledTimes(2);
    expect(worker).toHaveBeenNthCalledWith(2, 'latest');
  });

  it('keeps only the newest pending value while a durable write is in flight', async () => {
    let release!: (value: boolean) => void;
    const worker = vi.fn()
      .mockImplementationOnce(() => new Promise<boolean>((resolve) => { release = resolve; }))
      .mockResolvedValue(true);
    const queue = createLatestOnlyAsyncQueue(worker, 0);

    const first = queue.enqueue('first');
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const middle = queue.enqueue('middle');
    const latest = queue.enqueue('latest');
    release(true);

    await expect(first).resolves.toBe(true);
    await expect(middle).resolves.toBe(true);
    await expect(latest).resolves.toBe(true);
    expect(worker).toHaveBeenCalledTimes(2);
    expect(worker).toHaveBeenNthCalledWith(2, 'latest');
  });
});
