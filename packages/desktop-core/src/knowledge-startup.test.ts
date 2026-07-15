import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { KnowledgeBaseStateSummary } from '@agent-canvas/skill-store';
import * as publicApi from './index';

describe('startConfiguredKnowledgeRefresh', () => {
  const startup = () => {
    const helper = (publicApi as Record<string, unknown>).startConfiguredKnowledgeRefresh;
    expect(typeof helper).toBe('function');
    return helper as (
      store: { listStates(): Promise<KnowledgeBaseStateSummary[]> },
      refresh: { start(ids: string[]): Promise<void> },
    ) => Promise<string[]>;
  };

  it('starts persisted configured knowledge ids without exposing configuration paths', async () => {
    const states = [knowledgeState('scene-skill'), knowledgeState('ecommerce-detail')];
    const listStates = vi.fn(async () => states);
    const start = vi.fn(async (_ids: string[]) => undefined);

    const ids = await startup()({ listStates }, { start });

    expect(ids).toEqual(['ecommerce-detail', 'scene-skill']);
    expect(start).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledWith(['ecommerce-detail', 'scene-skill']);
    expect(JSON.stringify(ids)).not.toMatch(/rootPath|[A-Za-z]:\\|\\\\/u);
  });

  it('starts cleanly when no knowledge bases are configured', async () => {
    const start = vi.fn(async (_ids: string[]) => undefined);

    await expect(startup()({
      listStates: async () => [],
    }, { start })).resolves.toEqual([]);

    expect(start).toHaveBeenCalledWith([]);
  });

  it('is awaited by both Electron desktop entrypoints before main window creation', async () => {
    for (const mainPath of [
      'apps/desktop-legacy/src/main.ts',
      'apps/desktop-modern/src/main.ts',
    ]) {
      const source = await readFile(join(process.cwd(), ...mainPath.split('/')), 'utf8');
      expect(source).toContain('startConfiguredKnowledgeRefresh');
      expect(source.slice(0, source.indexOf('const runtimeChannel'))).toContain('startConfiguredKnowledgeRefresh');
      expect(source.indexOf('await startConfiguredKnowledgeRefresh(knowledgeStore, knowledgeRefreshService);'))
        .toBeLessThan(source.indexOf('await createMainWindow();'));
    }
  });
});

function knowledgeState(knowledgeBaseId: string): KnowledgeBaseStateSummary {
  return {
    schemaVersion: 1,
    knowledgeBaseId,
    displayName: knowledgeBaseId,
    status: 'empty',
    activeVersion: null,
    activeContentHash: null,
    versionCount: 0,
    versions: [],
    lastFailure: null,
    lastRollbackAt: null,
  };
}