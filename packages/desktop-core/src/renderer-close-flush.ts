import { randomUUID } from 'node:crypto';
import {
  CLOSE_FLUSH_TIMEOUT_MS,
  parseCloseFlushAbort,
  parseCloseFlushAck,
  parseCloseFlushRequest,
  type CloseFlushAbort,
  type CloseFlushAck,
  type CloseFlushCompletionReason,
  type CloseFlushRequest,
} from './renderer-close-flush-contract.js';

export {
  CLOSE_FLUSH_TIMEOUT_MS,
  parseCloseFlushAbort,
  parseCloseFlushAck,
  parseCloseFlushRequest,
  type CloseFlushAbort,
  type CloseFlushAck,
  type CloseFlushCompletionReason,
  type CloseFlushRequest,
} from './renderer-close-flush-contract.js';

export interface CloseAttemptEvent {
  preventDefault(): void;
}

export interface RendererCloseFlushCoordinator {
  handleCloseFlushAck(payload: unknown): Promise<boolean>;
  hasPendingCloseAttempt(): boolean;
  rendererUnavailable(): Promise<boolean>;
  requestClose(event?: CloseAttemptEvent): Promise<void>;
}

export interface RendererCloseFlushCoordinatorOptions {
  readonly canRequestRendererFlush?: () => boolean;
  readonly clearTimeout?: (handle: unknown) => void;
  readonly closeAllProjects: (reason: Extract<CloseFlushCompletionReason, 'saved' | 'discarded'>) => void | Promise<void>;
  readonly createRequestId?: () => string;
  readonly finalizeClose: (reason: CloseFlushCompletionReason) => void | Promise<void>;
  readonly onCloseAttemptAborted?: () => void;
  readonly onCloseBlocked?: (reason: Exclude<CloseFlushCompletionReason, 'saved' | 'discarded' | 'cancel'>) => 'cancel' | 'discard' | Promise<'cancel' | 'discard'>;
  readonly onCloseFlushAckAccepted?: (ack: CloseFlushAck) => void;
  readonly onCloseFlushAborted?: (event: CloseFlushAbort) => void;
  readonly sendCloseFlushRequest: (request: CloseFlushRequest) => boolean | void;
  readonly setTimeout?: (listener: () => void, delayMs: number) => unknown;
  readonly timeoutMs?: number;
}

export function createCloseFlushRequestId(): string {
  return `close-${randomUUID().replace(/-/gu, '')}`;
}

export type CloseFinalizeTarget = 'window' | 'app';

export function selectCloseFinalizeTarget(
  current: CloseFinalizeTarget,
  requested: CloseFinalizeTarget,
  closeAttemptPending: boolean,
): CloseFinalizeTarget {
  if (!closeAttemptPending) return requested;
  return current === 'app' || requested === 'app' ? 'app' : 'window';
}

export function createRendererCloseFlushCoordinator({
  canRequestRendererFlush = () => true,
  clearTimeout: clearTimeoutFn = (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  closeAllProjects,
  createRequestId = createCloseFlushRequestId,
  finalizeClose,
  onCloseAttemptAborted,
  onCloseBlocked,
  onCloseFlushAckAccepted,
  onCloseFlushAborted,
  sendCloseFlushRequest,
  setTimeout: setTimeoutFn = (listener, delayMs) => setTimeout(listener, delayMs),
  timeoutMs = CLOSE_FLUSH_TIMEOUT_MS,
}: RendererCloseFlushCoordinatorOptions): RendererCloseFlushCoordinator {
  let closePromise: Promise<void> | null = null;
  let sessionCloseAttempted = false;
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

  const notifyAcceptedAck = (ack: CloseFlushAck): void => {
    try {
      onCloseFlushAckAccepted?.(ack);
    } catch {
      // Observing an accepted acknowledgement must not alter close safety.
    }
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

  const finishClose = async (
    reason: Extract<CloseFlushCompletionReason, 'saved' | 'discarded'>,
  ): Promise<boolean> => {
    sessionCloseAttempted = true;
    try {
      await Promise.resolve(closeAllProjects(reason));
      await Promise.resolve(finalizeClose(reason));
      return true;
    } catch {
      // A failed session close keeps the window open so the user can retry
      // without abandoning the durable project boundary.
      return false;
    }
  };

  const runClose = async (): Promise<{
    readonly closeFlushAbort: CloseFlushAbort | null;
    readonly safelyAborted: boolean;
  }> => {
    let reason: CloseFlushCompletionReason = 'unavailable';
    let deliveredRequest: CloseFlushRequest | null = null;
    const abortedEvent = (): CloseFlushAbort | null => (
      !sessionCloseAttempted
      && deliveredRequest !== null
      && reason !== 'saved'
      && reason !== 'discarded'
        ? { requestId: deliveredRequest.requestId, reason }
        : null
    );
    const abortedResult = () => ({
      closeFlushAbort: abortedEvent(),
      safelyAborted: !sessionCloseAttempted,
    });
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
          deliveredRequest = request;
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
      if (await finishClose(reason)) {
        return { closeFlushAbort: null, safelyAborted: false };
      }
      reason = 'failed';
    }
    if (reason === 'cancel' || onCloseBlocked === undefined) return abortedResult();
    try {
      if (await onCloseBlocked(reason) === 'discard') {
        if (await finishClose('discarded')) {
          return { closeFlushAbort: null, safelyAborted: false };
        }
        reason = 'failed';
      }
    } catch {
      // Keeping the window open is the safe outcome if the main-process
      // recovery dialog itself cannot be shown.
    }
    return abortedResult();
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
        notifyAcceptedAck(ack);
        return true;
      }
      if (ack.phase === 'save_started') {
        if (pendingRequest.phase === 'save_started') return false;
        pausePendingTimeout();
        pendingRequest.phase = 'save_started';
        startPendingTimeout();
        notifyAcceptedAck(ack);
        return true;
      }
      const reason: CloseFlushCompletionReason = ack.outcome === 'cancelled'
        ? 'cancel'
        : ack.outcome;
      notifyAcceptedAck(ack);
      return completePending(reason);
    },
    hasPendingCloseAttempt() {
      return closePromise !== null;
    },
    async rendererUnavailable() {
      return completePending('unavailable');
    },
    requestClose(event) {
      event?.preventDefault();
      if (closePromise !== null) return closePromise;
      const running = runClose();
      const requestPromise = running.then((result) => {
        if (closePromise === requestPromise) closePromise = null;
        if (!result.safelyAborted) return;
        try {
          onCloseAttemptAborted?.();
        } catch {
          // State-reset observers cannot turn a safely aborted attempt into a close.
        }
        if (result.closeFlushAbort === null) return;
        try {
          onCloseFlushAborted?.(result.closeFlushAbort);
        } catch {
          // The close attempt is already safely aborted. A renderer that has
          // disappeared cannot be notified and must not turn that into a close.
        }
      }, () => {
        if (closePromise === requestPromise) closePromise = null;
      });
      closePromise = requestPromise;
      return requestPromise;
    },
  };
}
