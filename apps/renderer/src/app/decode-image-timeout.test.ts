import { expect, it, vi } from 'vitest';
import { decodeImageWithTimeout } from './decode-image-timeout';
it('releases a stalled image decode and allows the next image to load', async () => {
  vi.useFakeTimers();
  try {
    const stuck = { src: 'stalled', decode: () => new Promise<void>(() => {}) } as HTMLImageElement;
    const checked = expect(decodeImageWithTimeout(stuck)).rejects.toThrow(/超时/);
    await vi.advanceTimersByTimeAsync(30_000); await checked;
    expect(stuck.src).toBe('');
    await expect(decodeImageWithTimeout({ decode: () => Promise.resolve() } as HTMLImageElement)).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});
