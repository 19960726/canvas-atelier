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
  sendCloseFlushRequest,
  setTimeout: setTimeoutFn = (listener, delayMs) => setTimeout(listener, delayMs),
  timeoutMs = CLOSE_FLUSH_TIMEOUT_MS,
}: RendererCloseFlushCoordinatorOptions): RendererCloseFlushCoordinator {
  let closePromise: Promise<void> | null = null;
  let pendingRequest: {
    readonly requestId: string;
    readonly resolve: (reason: CloseFlushCompletionReason) => void;
    readonly timeoutHandle: unknown;
  } | null = null;

  const completePending = (reason: CloseFlushCompletionReason): boolean => {
    if (pendingRequest === null) return false;
    const pending = pendingRequest;
    pendingRequest = null;
    clearTimeoutFn(pending.timeoutHandle);
    pending.resolve(reason);
    return true;
  };

  const waitForRenderer = (requestId: string): Promise<CloseFlushCompletionReason> => new Promise((resolve) => {
    const timeoutHandle = setTimeoutFn(() => {
      completePending('timeout');
    }, timeoutMs);
    pendingRequest = { requestId, resolve, timeoutHandle };
  });

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
        const sent = sendCloseFlushRequest(request);
        if (sent !== false) {
          reason = await waitForRenderer(request.requestId);
        }
      } catch {
        reason = 'unavailable';
      }
    }
    if (reason === 'cancel') return;
    await finishClose(reason);
  };

  return {
    async handleCloseFlushAck(payload) {
      const ack = parseCloseFlushAck(payload);
      if (ack === null || pendingRequest === null || ack.requestId !== pendingRequest.requestId) {
        return false;
      }
      return completePending(ack.cancelled === true ? 'cancel' : ack.ok ? 'ack' : 'nack');
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
