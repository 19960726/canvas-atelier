import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { installBrokenPipeExceptionCapture, installBrokenPipeGuard } from './broken-pipe-guard';

describe('desktop broken pipe guard', () => {
  it('absorbs EPIPE emitted by inherited output streams', () => {
    const stream = new EventEmitter();
    installBrokenPipeGuard([stream]);

    expect(() => stream.emit('error', Object.assign(new Error('broken pipe'), { code: 'EPIPE' }))).not.toThrow();
  });

  it('does not suppress unrelated stream failures', () => {
    const stream = new EventEmitter();
    installBrokenPipeGuard([stream]);
    const error = Object.assign(new Error('permission denied'), { code: 'EACCES' });

    expect(() => stream.emit('error', error)).toThrow(error);
  });

  it('installs at most one guard per stream', () => {
    const stream = new EventEmitter();
    const on = vi.spyOn(stream, 'on');

    installBrokenPipeGuard([stream]);
    installBrokenPipeGuard([stream]);

    expect(on).toHaveBeenCalledTimes(1);
  });

  it('absorbs an uncaught EPIPE before Electron can show its main-process error dialog', () => {
    let capture: ((error: Error & { code?: string }) => void) | null = null;
    const target = {
      hasUncaughtExceptionCaptureCallback: () => capture !== null,
      setUncaughtExceptionCaptureCallback: (callback: typeof capture) => {
        capture = callback;
      },
    };

    installBrokenPipeExceptionCapture(target);

    expect(capture).not.toBeNull();
    expect(() => capture?.(Object.assign(new Error('broken pipe'), { code: 'EPIPE' }))).not.toThrow();
  });

  it('restores normal uncaught-exception behavior for non-EPIPE failures', () => {
    let capture: ((error: Error & { code?: string }) => void) | null = null;
    const target = {
      hasUncaughtExceptionCaptureCallback: () => capture !== null,
      setUncaughtExceptionCaptureCallback: (callback: typeof capture) => {
        capture = callback;
      },
    };
    const error = Object.assign(new Error('permission denied'), { code: 'EACCES' });

    installBrokenPipeExceptionCapture(target);

    expect(() => capture?.(error)).toThrow(error);
    expect(capture).toBeNull();
  });
});
