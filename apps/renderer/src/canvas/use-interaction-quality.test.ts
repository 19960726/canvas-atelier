import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getRuntimeProfile } from '@agent-canvas/domain';
import { INTERACTION_IDLE_RESTORE_MS, useInteractionQuality } from './use-interaction-quality';

describe('useInteractionQuality', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('lowers expensive canvas quality while active and restores it after the idle window', () => {
    const profile = getRuntimeProfile('modern');
    const { result } = renderHook(() => useInteractionQuality(profile));

    expect(result.current.isInteracting).toBe(false);
    expect(result.current.thumbnailEdge).toBe(profile.thumbnailEdge);

    act(() => result.current.markInteraction());

    expect(result.current.isInteracting).toBe(true);
    expect(result.current.disableExpensiveShadows).toBe(true);
    expect(result.current.thumbnailEdge).toBeLessThan(profile.thumbnailEdge);

    act(() => vi.advanceTimersByTime(INTERACTION_IDLE_RESTORE_MS - 1));
    expect(result.current.isInteracting).toBe(true);

    act(() => vi.advanceTimersByTime(1));
    expect(result.current.isInteracting).toBe(false);
    expect(result.current.thumbnailEdge).toBe(profile.thumbnailEdge);
  });

  it('resets the idle restore timer on repeated interaction and cleans it up on unmount', () => {
    const profile = getRuntimeProfile('modern');
    const { result, unmount } = renderHook(() => useInteractionQuality(profile));

    act(() => result.current.markInteraction());
    act(() => vi.advanceTimersByTime(90));
    act(() => result.current.markInteraction());
    act(() => vi.advanceTimersByTime(119));

    expect(result.current.isInteracting).toBe(true);

    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not rerender the canvas for every pointer or wheel event within one interaction burst', () => {
    const profile = getRuntimeProfile('modern');
    let renderCount = 0;
    const { result } = renderHook(() => {
      renderCount += 1;
      return useInteractionQuality(profile);
    });

    act(() => result.current.markInteraction());
    const activeRenderCount = renderCount;
    act(() => vi.advanceTimersByTime(24));
    act(() => result.current.markInteraction());
    act(() => vi.advanceTimersByTime(24));
    act(() => result.current.markInteraction());

    expect(renderCount).toBe(activeRenderCount);
    expect(result.current.isInteracting).toBe(true);
  });

  it('keeps one interaction burst active across a 350ms wheel-event gap', () => {
    const profile = getRuntimeProfile('modern');
    let renderCount = 0;
    const { result } = renderHook(() => {
      renderCount += 1;
      return useInteractionQuality(profile);
    });

    act(() => result.current.markInteraction());
    const activeRenderCount = renderCount;
    act(() => vi.advanceTimersByTime(350));
    act(() => result.current.markInteraction());

    expect(result.current.isInteracting).toBe(true);
    expect(renderCount).toBe(activeRenderCount);
  });

  it('keeps the legacy Win7 target at its 30 FPS profile floor while active', () => {
    const profile = getRuntimeProfile('legacy-win7');
    const { result } = renderHook(() => useInteractionQuality(profile));

    act(() => result.current.markInteraction());

    expect(result.current.targetFps).toBe(30);
    expect(result.current.targetFps).toBe(profile.targetFps);
    expect(result.current.thumbnailEdge).toBeLessThan(profile.thumbnailEdge);
  });

  it('keeps expensive shadows disabled after interaction on large canvases', () => {
    const profile = getRuntimeProfile('modern');
    let renderCount = 0;
    const { result } = renderHook(() => {
      renderCount += 1;
      return useInteractionQuality(profile, true);
    });

    act(() => result.current.markInteraction());
    const activeRenderCount = renderCount;
    act(() => vi.advanceTimersByTime(INTERACTION_IDLE_RESTORE_MS));

    expect(result.current.isInteracting).toBe(false);
    expect(result.current.disableExpensiveShadows).toBe(true);
    expect(result.current.thumbnailEdge).toBeLessThan(profile.thumbnailEdge);
    expect(renderCount).toBe(activeRenderCount);
  });
});
