import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { GenerationHistoryProviderSink } from './generation-history-provider-sink';
import { GenerationHistoryStore } from './generation-history-store';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('GenerationHistoryProviderSink provider identity', () => {
  it.each([
    ['comfly', 'Comfly'],
    ['relayme', 'RelayMe'],
    ['julun', '巨轮 API'],
    ['4dai', '4D AI'],
  ] as const)('records %s jobs under their owning provider display name', async (provider, displayName) => {
    const ownedRoot = await mkdtemp(join(tmpdir(), `generation-history-${provider}-`));
    temporaryRoots.push(ownedRoot);
    const store = new GenerationHistoryStore({
      historyRoot: join(ownedRoot, 'generation-history'),
      ownedRoot,
      now: () => Date.parse('2026-09-09T08:00:00.000Z'),
    });
    const sink = new GenerationHistoryProviderSink({
      store,
      trustedImageDecoder: async () => true,
      now: () => Date.parse('2026-09-09T08:00:00.000Z'),
    });

    const historyId = await sink.queued({
      jobId: `job-${provider}`,
      modelDisplayName: `${provider} model`,
      provider,
    });

    await expect(store.getRecords([historyId])).resolves.toEqual([
      expect.objectContaining({
        provider: expect.objectContaining({ displayName }),
      }),
    ]);
  });
});
