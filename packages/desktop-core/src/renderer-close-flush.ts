import { randomUUID } from 'node:crypto';
import {
  CLOSE_FLUSH_TIMEOUT_MS,
  parseCloseFlushAck,
  parseCloseFlushRequest,
  type CloseFlushCompletionReason,
  type CloseFlushRequest,
} from './renderer-close-flush-contract.js';

export {
  CLOSE_FLUSH_TIMEOUT_MS,
  parseCloseFlushAck,
  parseCloseFlushRequest,
  type CloseFlushAck,
  type CloseFlushCompletionReason,
  type CloseFlushRequest,
} from './renderer-close-flush-contract.js';

export interface CloseAttemptEvent {
  preventDefault(): void;
}

export interface RendererCloseFlushCoordinator {
  handleCloseFlushAck(payload: unknown): Promise<boolean>;
  rendererUnavailable(): Promise<boolean>;
  requestClose(event?: CloseAttemptEvent): Promise<void>;
}

export interface RendererCloseFlushCoordinatorOptions {
  readonly canRequestRendererFlush?: () => boolean;
  readonly clearTimeout?: (handle: unknown) => void;
  readonly closeAllProjects: () => void | Promise<void>;
  readonly createRequestId?: () => string;
  readonly finalizeClose: (reason: CloseFlushCompletionReason) => void | Promise<void>;
  readonly onCloseBlocked?: (reason: Exclude<CloseFlushCompletionReason, 'saved' | 'discarded' | 'cancel'>) => 'cancel' | 'discard' | Promise<'cancel' | 'discard'>;
  readonly sendCloseFlushRequest: (request: CloseFlushRequest) => boolean | void;
  readonly setTimeout?: (listener: () => void, delayMs: number) => unknown;
  readonly timeoutMs?: number;
}

export function createCloseFlushRequestId(): string {
  return `close-${randomUUID().replace(/-/gu, '')}`;
}

export function createRendererCloseFlushCoordinator({
  canRequestRendererFlush = () => true,
  clearTimeout: clearTimeoutFn = (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  closeAllProjects,
  createRequestId = createCloseFlushRequestId,
  finalizeClose,
  onCloseBlocked,
  sendCloseFlushRequest,
  setTimeout: setTimeoutFn = (listener, delayMs) => setTimeout(listener, delayMs),
  timeoutMs = CLOSE_FLUSH_TIMEOUT_MS,
}: RendererCloseFlushCoordinatorOptions): RendererCloseFlushCoordinator {
  let closePromise: Promise<void> | null = null;
  let pendingRequest: {
    readonly requestId: string;
    readonly resolve: (reason: CloseFlushCompletionReason) => void;
    phase: 'delivery' | 'decision_requested' | 'save_started';
    timeoutHandle: unknown | null;
  } | null = null;

  const completePending = (reason: CloseFlushCompletionReason): boolean => {
    if (pendingRequest === null) return false;
    const pending = pendingRequest;
    pendingRequest = null;
    if (pending.timeoutHandle !== null) clearTimeoutFn(pending.timeoutHandle);
    pending.resolve(reason);
    return true;
  };

  const waitForRenderer = (requestId: string): Promise<CloseFlushCompletionReason> => new Promise((resolve) => {
    pendingRequest = { requestId, resolve, phase: 'delivery', timeoutHandle: null };
  });

  const startPendingTimeout = (): boolean => {
    if (pendingRequest === null || pendingRequest.timeoutHandle !== null) return false;
    pendingRequest.timeoutHandle = setTimeoutFn(() => {
      completePending('timeout');
    }, timeoutMs);
    return true;
  };

  const pausePendingTimeout = (): boolean => {
    if (pendingRequest === null || pendingRequest.timeoutHandle === null) return false;
    clearTimeoutFn(pendingRequest.timeoutHandle);
    pendingRequest.timeoutHandle = null;
    return true;
  };

  const finishClose = async (reason: CloseFlushCompletionReason): Promise<void> => {
    try {
      await Promise.resolve(closeAllProjects());
    } catch {
      // Main-process close must continue to the final window/app boundary.
    } finally {
      await Promise.resolve(finalizeClose(reason));
    }
  };

  const runClose = async (): Promise<void> => {
    let reason: CloseFlushCompletionReason = 'unavailable';
    const request = parseCloseFlushRequest({ requestId: createRequestId() });
    if (request !== null && canRequestRendererFlush()) {
      try {
        // Register the pending request before IPC send. Electron can deliver a
        // clean-project ACK in the same turn; registering afterwards drops it
        // and leaves the native close event permanently prevented.
        const rendererCompletion = waitForRenderer(request.requestId);
        // The renderer may fail before it ever acknowledges the request. Start
        // this delivery watchdog before IPC send so a missing ACK cannot leave
        // the native close event prevented forever.
        startPendingTimeout();
        const sent = sendCloseFlushRequest(request);
        if (sent !== false) {
          reason = await rendererCompletion;
        } else {
          completePending('unavailable');
          reason = 'unavailable';
        }
      } catch {
        completePending('unavailable');
        reason = 'unavailable';
      }
    }
    if (reason === 'saved' || reason === 'discarded') {
      await finishClose(reason);
      return;
    }
    if (reason === 'cancel' || onCloseBlocked === undefined) return;
    try {
      if (await onCloseBlocked(reason) === 'discard') {
        await finishClose('discarded');
      }
    } catch {
      // Keeping the window open is the safe outcome if the main-process
      // recovery dialog itself cannot be shown.
    }
  };

  return {
    async handleCloseFlushAck(payload) {
      const ack = parseCloseFlushAck(payload);
      if (ack === null || pendingRequest === null || ack.requestId !== pendingRequest.requestId) {
        return false;
      }
      if (ack.phase === 'decision_requested') {
        if (pendingRequest.phase !== 'delivery') return false;
        pausePendingTimeout();
        pendingRequest.phase = 'decision_requested';
        return true;
      }
      if (ack.phase === 'save_started') {
        if (pendingRequest.phase === 'save_started') return false;
        pendingRequest.phase = 'save_started';
        startPendingTimeout();
        return true;
      }
      const reason: CloseFlushCompletionReason = ack.outcome === 'cancelled'
        ? 'cancel'
        : ack.outcome;
      return completePending(reason);
    },
    async rendererUnavailable() {
      return completePending('unavailable');
    },
    requestClose(event) {
      event?.preventDefault();
      if (closePromise !== null) return closePromise;
      const running = runClose();
      closePromise = running;
      void running.then(() => {
        if (closePromise === running) closePromise = null;
      }, () => {
        if (closePromise === running) closePromise = null;
      });
      return running;
    },
  };
}
