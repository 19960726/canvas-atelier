import { describe, expect, it, vi } from 'vitest';

import {
  CLOSE_FLUSH_TIMEOUT_MS,
  createRendererCloseFlushCoordinator,
  parseCloseFlushAck,
  parseCloseFlushRequest,
} from './renderer-close-flush';

describe('renderer close-flush coordinator', () => {
  it('accepts an immediate renderer completion acknowledgement instead of leaving the window close pending', async () => {
    const finalizeClose = vi.fn();
    let coordinator: ReturnType<typeof createRendererCloseFlushCoordinator>;
    coordinator = createRendererCloseFlushCoordinator({
      closeAllProjects: vi.fn(),
      createRequestId: () => 'immediate-close',
      finalizeClose,
      sendCloseFlushRequest: (request) => {
        void coordinator.handleCloseFlushAck({ requestId: request.requestId, phase: 'completed', outcome: 'discarded' });
        return true;
      },
    });

    void coordinator.requestClose({ preventDefault: vi.fn() });
    await Promise.resolve();
    await Promise.resolve();

    expect(finalizeClose).toHaveBeenCalledWith('discarded');
  });

  it('waits for a matching renderer ACK before closing active projects and finalizing close', async () => {
    const harness = createHarness();

    const closing = harness.coordinator.requestClose(harness.closeEvent);

    expect(harness.closeEvent.preventDefault).toHaveBeenCalledOnce();
    expect(harness.sendCloseFlushRequest).toHaveBeenCalledWith({ requestId: 'close-request-1' });
    expect(harness.closeAllProjects).not.toHaveBeenCalled();

    await expect(harness.coordinator.handleCloseFlushAck({ requestId: 'close-request-1', phase: 'save_started' })).resolves.toBe(true);
    expect(harness.scheduledMs).toBe(CLOSE_FLUSH_TIMEOUT_MS);
    await expect(harness.coordinator.handleCloseFlushAck({ requestId: 'close-request-1', phase: 'completed', outcome: 'saved' })).resolves.toBe(true);
    await closing;

    expect(harness.calls).toEqual(['send:close-request-1', 'closeAllProjects', 'finalize:saved']);
  });

  it('starts the timeout as soon as the renderer close request is sent so a missing renderer ACK cannot deadlock the window', async () => {
    const failed = createHarness({ requestIds: ['close-request-failed', 'close-request-retry'] });
    const failedClosing = failed.coordinator.requestClose(failed.closeEvent);
    expect(failed.scheduledMs).toBe(CLOSE_FLUSH_TIMEOUT_MS);
    await failed.coordinator.handleCloseFlushAck({ requestId: 'close-request-failed', phase: 'save_started' });
    await expect(failed.coordinator.handleCloseFlushAck({ requestId: 'close-request-failed', phase: 'completed', outcome: 'failed' })).resolves.toBe(true);
    await failedClosing;
    expect(failed.closeAllProjects).not.toHaveBeenCalled();
    expect(failed.finalizeClose).not.toHaveBeenCalled();

    const retry = failed.coordinator.requestClose({ preventDefault: vi.fn() });
    await failed.coordinator.handleCloseFlushAck({ requestId: 'close-request-retry', phase: 'save_started' });
    await failed.coordinator.handleCloseFlushAck({ requestId: 'close-request-retry', phase: 'completed', outcome: 'saved' });
    await retry;
    expect(failed.calls).toContain('finalize:saved');

    const timeout = createHarness({ requestIds: ['close-request-timeout', 'close-request-timeout-retry'] });
    const timeoutClosing = timeout.coordinator.requestClose(timeout.closeEvent);
    expect(timeout.scheduledMs).toBe(CLOSE_FLUSH_TIMEOUT_MS);
    timeout.flushTimeout();
    await timeoutClosing;
    expect(timeout.closeAllProjects).not.toHaveBeenCalled();
    const timeoutRetry = timeout.coordinator.requestClose({ preventDefault: vi.fn() });
    await timeout.coordinator.handleCloseFlushAck({ requestId: 'close-request-timeout-retry', phase: 'completed', outcome: 'discarded' });
    await timeoutRetry;
    expect(timeout.calls).toContain('finalize:discarded');

    const crashed = createHarness({ requestIds: ['close-request-crash'] });
    const crashClosing = crashed.coordinator.requestClose(crashed.closeEvent);
    await expect(crashed.coordinator.rendererUnavailable()).resolves.toBe(true);
    await crashClosing;
    expect(crashed.closeAllProjects).not.toHaveBeenCalled();
    expect(crashed.finalizeClose).not.toHaveBeenCalled();
  });

  it('allows an explicit discard decision after the renderer reports that saving failed', async () => {
    const finalizeClose = vi.fn();
    const closeAllProjects = vi.fn();
    const onCloseBlocked = vi.fn(async () => 'discard' as const);
    const coordinator = createRendererCloseFlushCoordinator({
      closeAllProjects,
      createRequestId: () => 'close-request-discard-after-failure',
      finalizeClose,
      onCloseBlocked,
      sendCloseFlushRequest: () => true,
    });

    const closing = coordinator.requestClose({ preventDefault: vi.fn() });
    await coordinator.handleCloseFlushAck({
      requestId: 'close-request-discard-after-failure',
      phase: 'completed',
      outcome: 'failed',
    });
    await closing;

    expect(onCloseBlocked).toHaveBeenCalledWith('failed');
    expect(closeAllProjects).toHaveBeenCalledOnce();
    expect(finalizeClose).toHaveBeenCalledWith('discarded');
  });

  it('does not time out while the user is deciding, then cancels and permits a later discard', async () => {
    const harness = createHarness({ requestIds: ['close-request-cancel', 'close-request-after-cancel'] });
    const cancelled = harness.coordinator.requestClose(harness.closeEvent);

    expect(harness.scheduledMs).toBe(CLOSE_FLUSH_TIMEOUT_MS);
    await expect(harness.coordinator.handleCloseFlushAck({
      requestId: 'close-request-cancel',
      phase: 'decision_requested',
    })).resolves.toBe(true);
    harness.flushTimeout();
    expect(harness.closeAllProjects).not.toHaveBeenCalled();

    await expect(harness.coordinator.handleCloseFlushAck({
      requestId: 'close-request-cancel',
      phase: 'completed',
      outcome: 'cancelled',
    })).resolves.toBe(true);
    await cancelled;

    expect(harness.closeAllProjects).not.toHaveBeenCalled();
    expect(harness.finalizeClose).not.toHaveBeenCalled();

    const closing = harness.coordinator.requestClose({ preventDefault: vi.fn() });
    await harness.coordinator.handleCloseFlushAck({ requestId: 'close-request-after-cancel', phase: 'completed', outcome: 'discarded' });
    await closing;
    expect(harness.closeAllProjects).toHaveBeenCalledOnce();
    expect(harness.calls).toContain('finalize:discarded');
  });

  it('coalesces duplicate close attempts into one renderer request', async () => {
    const harness = createHarness();

    const first = harness.coordinator.requestClose(harness.closeEvent);
    const second = harness.coordinator.requestClose({ preventDefault: vi.fn() });

    expect(second).toBe(first);
    expect(harness.sendCloseFlushRequest).toHaveBeenCalledTimes(1);

    await harness.coordinator.handleCloseFlushAck({ requestId: 'close-request-1', phase: 'completed', outcome: 'discarded' });
    await first;

    expect(harness.closeAllProjects).toHaveBeenCalledOnce();
    expect(harness.finalizeClose).toHaveBeenCalledOnce();
  });

  it('ignores malformed, mismatched, and duplicate ACKs without unlocking close', async () => {
    const harness = createHarness();
    const closing = harness.coordinator.requestClose(harness.closeEvent);

    await expect(harness.coordinator.handleCloseFlushAck({ requestId: 'other-request', phase: 'completed', outcome: 'saved' })).resolves.toBe(false);
    await expect(harness.coordinator.handleCloseFlushAck({ requestId: 'close-request-1', phase: 'completed', outcome: 'saved', token: 'secret' })).resolves.toBe(false);
    expect(harness.closeAllProjects).not.toHaveBeenCalled();

    await expect(harness.coordinator.handleCloseFlushAck({ requestId: 'close-request-1', phase: 'save_started' })).resolves.toBe(true);
    await expect(harness.coordinator.handleCloseFlushAck({ requestId: 'close-request-1', phase: 'save_started' })).resolves.toBe(false);
    await expect(harness.coordinator.handleCloseFlushAck({ requestId: 'close-request-1', phase: 'completed', outcome: 'saved' })).resolves.toBe(true);
    await expect(harness.coordinator.handleCloseFlushAck({ requestId: 'close-request-1', phase: 'completed', outcome: 'saved' })).resolves.toBe(false);
    await closing;

    expect(harness.calls).toEqual(['send:close-request-1', 'closeAllProjects', 'finalize:saved']);
  });

  it('strictly validates close-flush payloads without paths or secrets', () => {
    expect(parseCloseFlushRequest({ requestId: 'close-request-123456' })).toEqual({
      requestId: 'close-request-123456',
    });
    expect(parseCloseFlushAck({ requestId: 'close-request-123456', phase: 'save_started' })).toEqual({
      phase: 'save_started',
      requestId: 'close-request-123456',
    });
    expect(parseCloseFlushAck({ requestId: 'close-request-123456', phase: 'completed', outcome: 'cancelled' })).toEqual({
      outcome: 'cancelled',
      phase: 'completed',
      requestId: 'close-request-123456',
    });
    expect(parseCloseFlushRequest({ requestId: 'close-request-123456', path: 'C:\\Users\\Private\\draft.json' })).toBeNull();
    expect(parseCloseFlushAck({ requestId: 'close-request-123456', phase: 'completed', outcome: 'saved', Authorization: 'Bearer secret' })).toBeNull();
    expect(parseCloseFlushAck({ requestId: '../project', phase: 'completed', outcome: 'saved' })).toBeNull();
  });
});

function createHarness(options: {
  canRequestRendererFlush?: () => boolean;
  requestIds?: string[];
} = {}) {
  const requestIds = options.requestIds ?? ['close-request-1'];
  const calls: string[] = [];
  let timeout: (() => void) | null = null;
  let scheduledMs = 0;
  const closeAllProjects = vi.fn(async () => {
    calls.push('closeAllProjects');
  });
  const finalizeClose = vi.fn((reason: string) => {
    calls.push(`finalize:${reason}`);
  });
  const sendCloseFlushRequest = vi.fn((request: { requestId: string }) => {
    calls.push(`send:${request.requestId}`);
    return true;
  });
  const coordinator = createRendererCloseFlushCoordinator({
    canRequestRendererFlush: options.canRequestRendererFlush ?? (() => true),
    clearTimeout: vi.fn(() => {
      timeout = null;
    }),
    closeAllProjects,
    createRequestId: () => requestIds.shift() ?? 'close-request-fallback',
    finalizeClose,
    sendCloseFlushRequest,
    setTimeout: (listener, ms) => {
      timeout = listener;
      scheduledMs = ms;
      return 1;
    },
  });

  return {
    calls,
    closeAllProjects,
    closeEvent: { preventDefault: vi.fn() },
    coordinator,
    finalizeClose,
    flushTimeout() {
      timeout?.();
    },
    get scheduledMs() {
      return scheduledMs;
    },
    sendCloseFlushRequest,
  };
}
