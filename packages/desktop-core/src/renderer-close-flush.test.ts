import { describe, expect, it, vi } from 'vitest';

import {
  CLOSE_FLUSH_TIMEOUT_MS,
  createRendererCloseFlushCoordinator,
  parseCloseFlushAck,
  parseCloseFlushRequest,
} from './renderer-close-flush';

describe('renderer close-flush coordinator', () => {
  it('waits for a matching renderer ACK before closing active projects and finalizing close', async () => {
    const harness = createHarness();

    const closing = harness.coordinator.requestClose(harness.closeEvent);

    expect(harness.closeEvent.preventDefault).toHaveBeenCalledOnce();
    expect(harness.sendCloseFlushRequest).toHaveBeenCalledWith({ requestId: 'close-request-1' });
    expect(harness.closeAllProjects).not.toHaveBeenCalled();

    await expect(harness.coordinator.handleCloseFlushAck({ requestId: 'close-request-1', ok: true })).resolves.toBe(true);
    await closing;

    expect(harness.calls).toEqual(['send:close-request-1', 'closeAllProjects', 'finalize:ack']);
  });

  it('falls back to main-process close when renderer ACK is false, times out, or renderer becomes unavailable', async () => {
    const nack = createHarness({ requestIds: ['close-request-nack'] });
    const nackClosing = nack.coordinator.requestClose(nack.closeEvent);
    await expect(nack.coordinator.handleCloseFlushAck({ requestId: 'close-request-nack', ok: false })).resolves.toBe(true);
    await nackClosing;
    expect(nack.calls).toEqual(['send:close-request-nack', 'closeAllProjects', 'finalize:nack']);

    const timeout = createHarness({ requestIds: ['close-request-timeout'] });
    const timeoutClosing = timeout.coordinator.requestClose(timeout.closeEvent);
    expect(timeout.scheduledMs).toBe(CLOSE_FLUSH_TIMEOUT_MS);
    timeout.flushTimeout();
    await timeoutClosing;
    expect(timeout.calls).toEqual(['send:close-request-timeout', 'closeAllProjects', 'finalize:timeout']);

    const crashed = createHarness({ requestIds: ['close-request-crash'] });
    const crashClosing = crashed.coordinator.requestClose(crashed.closeEvent);
    await expect(crashed.coordinator.rendererUnavailable()).resolves.toBe(true);
    await crashClosing;
    expect(crashed.calls).toEqual(['send:close-request-crash', 'closeAllProjects', 'finalize:unavailable']);
  });

  it('coalesces duplicate close attempts into one renderer request', async () => {
    const harness = createHarness();

    const first = harness.coordinator.requestClose(harness.closeEvent);
    const second = harness.coordinator.requestClose({ preventDefault: vi.fn() });

    expect(second).toBe(first);
    expect(harness.sendCloseFlushRequest).toHaveBeenCalledTimes(1);

    await harness.coordinator.handleCloseFlushAck({ requestId: 'close-request-1', ok: true });
    await first;

    expect(harness.closeAllProjects).toHaveBeenCalledOnce();
    expect(harness.finalizeClose).toHaveBeenCalledOnce();
  });

  it('ignores malformed, mismatched, and duplicate ACKs without unlocking close', async () => {
    const harness = createHarness();
    const closing = harness.coordinator.requestClose(harness.closeEvent);

    await expect(harness.coordinator.handleCloseFlushAck({ requestId: 'other-request', ok: true })).resolves.toBe(false);
    await expect(harness.coordinator.handleCloseFlushAck({ requestId: 'close-request-1', ok: true, token: 'secret' })).resolves.toBe(false);
    expect(harness.closeAllProjects).not.toHaveBeenCalled();

    await expect(harness.coordinator.handleCloseFlushAck({ requestId: 'close-request-1', ok: true })).resolves.toBe(true);
    await expect(harness.coordinator.handleCloseFlushAck({ requestId: 'close-request-1', ok: true })).resolves.toBe(false);
    await closing;

    expect(harness.calls).toEqual(['send:close-request-1', 'closeAllProjects', 'finalize:ack']);
  });

  it('strictly validates close-flush payloads without paths or secrets', () => {
    expect(parseCloseFlushRequest({ requestId: 'close-request-123456' })).toEqual({
      requestId: 'close-request-123456',
    });
    expect(parseCloseFlushAck({ requestId: 'close-request-123456', ok: true })).toEqual({
      ok: true,
      requestId: 'close-request-123456',
    });
    expect(parseCloseFlushRequest({ requestId: 'close-request-123456', path: 'C:\\Users\\Private\\draft.json' })).toBeNull();
    expect(parseCloseFlushAck({ requestId: 'close-request-123456', ok: true, Authorization: 'Bearer secret' })).toBeNull();
    expect(parseCloseFlushAck({ requestId: '../project', ok: true })).toBeNull();
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
