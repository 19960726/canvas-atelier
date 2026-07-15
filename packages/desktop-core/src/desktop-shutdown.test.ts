import { describe, expect, it, vi } from 'vitest';

import { shutdownDesktopServices } from './desktop-shutdown';

describe('desktop shutdown', () => {
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