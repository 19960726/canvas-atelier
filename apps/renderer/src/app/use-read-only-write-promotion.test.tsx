import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useReadOnlyWritePromotion } from './use-read-only-write-promotion';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useReadOnlyWritePromotion', () => {
  it('retries one read-only reload at a time and stops after promotion', async () => {
    vi.useFakeTimers();
    const reload = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    renderHook(() => useReadOnlyWritePromotion({
      projectId: 'project-read-only',
      readOnly: true,
      reload,
      retryMs: 1_000,
    }));

    expect(reload).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(reload).toHaveBeenCalledOnce();
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(reload).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('cancels polling after unmount or when the project changes', async () => {
    vi.useFakeTimers();
    const reload = vi.fn(async () => false);
    const { rerender, unmount } = renderHook(({ projectId, readOnly }) => useReadOnlyWritePromotion({
      projectId,
      readOnly,
      reload,
      retryMs: 1_000,
    }), {
      initialProps: { projectId: 'project-a', readOnly: true },
    });

    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(reload).toHaveBeenCalledOnce();
    rerender({ projectId: 'project-b', readOnly: false });
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(reload).toHaveBeenCalledOnce();

    rerender({ projectId: 'project-b', readOnly: true });
    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(reload).toHaveBeenCalledOnce();
  });
});
