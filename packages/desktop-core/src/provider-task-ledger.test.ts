import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createProviderTaskMappingStore } from './provider-task-ledger';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('provider task mapping provider identity', () => {
  it('persists and reloads task ownership for all four providers', async () => {
    const appDataRoot = await mkdtemp(join(tmpdir(), 'provider-task-ledger-'));
    temporaryRoots.push(appDataRoot);
    const secretSupplier = async () => ({ primary: 'fixture-mapping-secret', fallback: [] });
    const store = createProviderTaskMappingStore({ appDataRoot, secretSupplier });
    const providers = ['comfly', 'relayme', 'julun', '4dai'] as const;
    const timestamp = '2026-09-09T08:00:00.000Z';

    await Promise.all(providers.map((provider) => store.set({
      provider,
      publicTaskId: `public-${provider}`,
      rawTaskId: `raw-${provider}`,
      state: 'running',
      createdAt: timestamp,
      updatedAt: timestamp,
    })));

    const reloaded = createProviderTaskMappingStore({ appDataRoot, secretSupplier });
    await Promise.all(providers.map(async (provider) => {
      await expect(reloaded.get(`public-${provider}`)).resolves.toMatchObject({ provider });
    }));
  });
});
