import type { EventEmitter } from 'node:events';

const guardedStreams = new WeakSet<EventEmitter>();

export interface UncaughtExceptionCaptureTarget {
  hasUncaughtExceptionCaptureCallback(): boolean;
  setUncaughtExceptionCaptureCallback(
    callback: ((error: Error & { code?: string }) => void) | null,
  ): void;
}

export function installBrokenPipeGuard(streams: readonly EventEmitter[]): void {
  for (const stream of streams) {
    if (guardedStreams.has(stream)) continue;
    guardedStreams.add(stream);
    stream.on('error', (error: Error & { code?: string }) => {
      if (error.code === 'EPIPE') return;
      throw error;
    });
  }
}

export function installBrokenPipeExceptionCapture(target: UncaughtExceptionCaptureTarget): void {
  if (target.hasUncaughtExceptionCaptureCallback()) return;

  target.setUncaughtExceptionCaptureCallback((error) => {
    if (error.code === 'EPIPE') return;
    target.setUncaughtExceptionCaptureCallback(null);
    throw error;
  });
}
