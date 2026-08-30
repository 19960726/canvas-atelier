import { describe, expect, it, vi } from 'vitest';

import { shutdownDesktopServices } from './desktop-shutdown';

describe('desktop shutdown', () => {
  it('continues to the final quit boundary when a background service never stops', async () => {
    const quit = vi.fn();
    const stopMcpRuntime = vi.fn(() => new Promise<void>(() => undefined));

    await expect(shutdownDesktopServices({
      closeAllProjects: vi.fn(async () => undefined),
      stopMcpRuntime,
      stopApprovedSnapshotDrain: vi.fn(async () => undefined),
      stopApprovedSnapshotPull: vi.fn(async () => undefined),
      stopKnowledgeRefresh: vi.fn(async () => undefined),
      unsubscribeKnowledgeState: vi.fn(),
      quit,
    }, { timeoutMs: 10 })).resolves.toBeUndefined();

    expect(stopMcpRuntime).toHaveBeenCalledOnce();
    expect(quit).toHaveBeenCalledOnce();
  });

  it.each([
    'closeAllProjects',
    'stopApprovedSnapshotDrain',
    'stopApprovedSnapshotPull',
    'stopKnowledgeRefresh',
    'unsubscribeKnowledgeState',
  ] as const)('always quits exactly once when %s rejects or throws', async (failingStep) => {
    const failure = new Error(`injected ${failingStep} failure`);
    const calls: string[] = [];
    const asyncStep = (name: string) => vi.fn(async () => {
      calls.push(name);
      if (failingStep === name) throw failure;
    });
    const unsubscribeKnowledgeState = vi.fn(() => {
      calls.push('unsubscribeKnowledgeState');
      if (failingStep === 'unsubscribeKnowledgeState') throw failure;
    });
    const quit = vi.fn(() => { calls.push('quit'); });

    await expect(shutdownDesktopServices({
      closeAllProjects: asyncStep('closeAllProjects'),
      stopApprovedSnapshotDrain: asyncStep('stopApprovedSnapshotDrain'),
      stopApprovedSnapshotPull: asyncStep('stopApprovedSnapshotPull'),
      stopKnowledgeRefresh: asyncStep('stopKnowledgeRefresh'),
      unsubscribeKnowledgeState,
      quit,
    })).resolves.toBeUndefined();

    expect(calls).toEqual(expect.arrayContaining([
      'closeAllProjects',
      'stopApprovedSnapshotDrain',
      'stopApprovedSnapshotPull',
      'stopKnowledgeRefresh',
      'unsubscribeKnowledgeState',
      'quit',
    ]));
    expect(calls[calls.length - 1]).toBe('quit');
    expect(quit).toHaveBeenCalledOnce();
  });
});
