import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import { createNodeCodexCliProcessRunner, type CodexCliProcessInvocation } from './codex-cli-service';

class FakeChild extends EventEmitter {
  readonly pid = 4242;
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly stdin = new EventEmitter() as EventEmitter & { end: ReturnType<typeof vi.fn> };
  readonly kill = vi.fn(() => true);

  constructor() {
    super();
    this.stdin.end = vi.fn();
  }
}

const invocation = (requestId: string): CodexCliProcessInvocation => ({
  requestId,
  executablePath: 'C:\\Codex\\codex.exe',
  args: ['exec'],
  cwd: 'C:\\safe-temp',
  stdin: '{}',
  timeoutMs: 10_000,
});

describe('Codex CLI process runner', () => {
  it('waits for the entire child process to close before cancellation completes', async () => {
    const child = new FakeChild();
    let releaseTermination: (() => void) | undefined;
    const terminateProcessTree = vi.fn(() => new Promise<void>((resolve) => { releaseTermination = resolve; }));
    const runner = createNodeCodexCliProcessRunner({
      spawnProcess: vi.fn(() => child) as never,
      terminateProcessTree: terminateProcessTree as never,
    });
    const outcome = runner.run(invocation('request-cancel-tree')).catch((error: unknown) => error);
    const cancellation = runner.cancel?.('request-cancel-tree');
    let cancellationSettled = false;
    void cancellation?.finally(() => { cancellationSettled = true; });
    await Promise.resolve();

    expect(terminateProcessTree).toHaveBeenCalledWith(child);
    expect(cancellationSettled).toBe(false);
    releaseTermination?.();
    await Promise.resolve();
    expect(cancellationSettled).toBe(false);
    child.emit('close', 1);

    await expect(cancellation).resolves.toBe(true);
    await expect(outcome).resolves.toMatchObject({ code: 'CODEX_CLI_CANCELLED' });
  });

  it('terminates and rejects oversized output instead of accepting a truncated transcript', async () => {
    const child = new FakeChild();
    const terminateProcessTree = vi.fn(async (target: FakeChild) => { target.emit('close', 1); });
    const runner = createNodeCodexCliProcessRunner({
      maxOutputBytes: 8,
      spawnProcess: vi.fn(() => child) as never,
      terminateProcessTree: terminateProcessTree as never,
    });
    const outcome = runner.run(invocation('request-output-limit')).catch((error: unknown) => error);

    child.stdout.emit('data', Buffer.from('123456789', 'utf8'));

    await expect(outcome).resolves.toMatchObject({ code: 'CODEX_CLI_INVALID_RESPONSE' });
    expect(terminateProcessTree).toHaveBeenCalledOnce();
  });

  it('treats stdin EPIPE as a controlled failure and disposes every active process', async () => {
    const first = new FakeChild();
    const terminateProcessTree = vi.fn(async (target: FakeChild) => { target.emit('close', 1); });
    const runner = createNodeCodexCliProcessRunner({
      spawnProcess: vi.fn(() => first) as never,
      terminateProcessTree: terminateProcessTree as never,
    });
    const outcome = runner.run(invocation('request-epipe')).catch((error: unknown) => error);

    first.stdin.emit('error', Object.assign(new Error('broken pipe'), { code: 'EPIPE' }));

    await expect(outcome).resolves.toMatchObject({ code: 'CODEX_CLI_FAILED' });
    await expect(runner.dispose?.()).resolves.toBeUndefined();
  });

  it('poisons the runner when a terminated process never reports close', async () => {
    const child = new FakeChild();
    const runner = createNodeCodexCliProcessRunner({
      spawnProcess: vi.fn(() => child) as never,
      terminateProcessTree: vi.fn(async () => undefined) as never,
      terminationWaitMs: 5,
    });
    const outcome = runner.run(invocation('request-stuck-close')).catch((error: unknown) => error);

    await expect(runner.cancel?.('request-stuck-close')).resolves.toBe(true);
    await expect(outcome).resolves.toMatchObject({ code: 'CODEX_CLI_UNSAFE_RUNTIME' });
    await expect(runner.run(invocation('request-after-stuck-close')))
      .rejects.toMatchObject({ code: 'CODEX_CLI_UNSAFE_RUNTIME' });
  });

  it('terminates the tree on request timeout and rejects only after close', async () => {
    const child = new FakeChild();
    const terminateProcessTree = vi.fn(async (target: FakeChild) => { target.emit('close', 1); });
    const runner = createNodeCodexCliProcessRunner({
      spawnProcess: vi.fn(() => child) as never,
      terminateProcessTree: terminateProcessTree as never,
    });

    const outcome = runner.run({ ...invocation('request-timeout'), timeoutMs: 5 }).catch((error: unknown) => error);

    await expect(outcome).resolves.toMatchObject({ code: 'CODEX_CLI_TIMEOUT' });
    expect(terminateProcessTree).toHaveBeenCalledWith(child);
  });

  it('disposes all active child trees and waits for their close events', async () => {
    const children = [new FakeChild(), new FakeChild()];
    let spawnIndex = 0;
    const spawnProcess = vi.fn(() => children[spawnIndex++]!) as never;
    const terminateProcessTree = vi.fn(async (target: FakeChild) => { target.emit('close', 1); });
    const runner = createNodeCodexCliProcessRunner({ spawnProcess, terminateProcessTree: terminateProcessTree as never });
    const outcomes = [
      runner.run(invocation('request-dispose-1')).catch((error: unknown) => error),
      runner.run(invocation('request-dispose-2')).catch((error: unknown) => error),
    ];

    await expect(runner.dispose?.()).resolves.toBeUndefined();
    await expect(Promise.all(outcomes)).resolves.toEqual([
      expect.objectContaining({ code: 'CODEX_CLI_CANCELLED' }),
      expect.objectContaining({ code: 'CODEX_CLI_CANCELLED' }),
    ]);
    expect(terminateProcessTree).toHaveBeenCalledTimes(2);
  });
});
