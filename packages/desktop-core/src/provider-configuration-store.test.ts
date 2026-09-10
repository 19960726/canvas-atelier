import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createProviderConfigurationStore } from './provider-configuration-store';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('provider configuration roots', () => {
  it('keeps all four provider catalogs independent while preserving the Comfly legacy root', async () => {
    const appDataRoot = await mkdtemp(join(tmpdir(), 'provider-configuration-roots-'));
    temporaryRoots.push(appDataRoot);
    const providers = ['comfly', 'relayme', 'julun', '4dai'] as const;

    const stores = providers.map((provider) => createProviderConfigurationStore({ appDataRoot, provider }));
    await Promise.all(stores.map((store, index) => {
      const provider = providers[index]!;
      return store.write({
        baseUrl: `https://${provider}.example/v1`,
        profiles: [{
          provider,
          modelRoute: `${provider}/image`,
          displayName: `${provider} image`,
          capabilities: ['image_generation'],
        }],
      });
    }));

    await Promise.all(stores.map(async (store, index) => {
      const provider = providers[index]!;
      await expect(store.readPersisted()).resolves.toMatchObject({
        exists: true,
        snapshot: {
          baseUrl: `https://${provider}.example/v1`,
          profiles: [{ provider, modelRoute: `${provider}/image` }],
        },
      });
    }));
    await expect(access(join(appDataRoot, 'provider-configuration.json'))).resolves.toBeUndefined();
    await expect(access(join(appDataRoot, 'providers', 'relayme', 'provider-configuration.json'))).resolves.toBeUndefined();
    await expect(access(join(appDataRoot, 'providers', 'julun', 'provider-configuration.json'))).resolves.toBeUndefined();
    await expect(access(join(appDataRoot, 'providers', '4dai', 'provider-configuration.json'))).resolves.toBeUndefined();
  });

  it('rejects an unregistered provider before deriving a configuration path', () => {
    expect(() => createProviderConfigurationStore({
      appDataRoot: 'configuration-test-root',
      provider: '../unknown' as 'comfly',
    })).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }));
  });

  it('rejects a catalog from a different provider before it can pollute the selected provider root', async () => {
    const appDataRoot = await mkdtemp(join(tmpdir(), 'provider-configuration-owner-'));
    temporaryRoots.push(appDataRoot);
    const store = createProviderConfigurationStore({ appDataRoot, provider: '4dai' });

    await expect(store.write({
      baseUrl: 'https://api.4dai.cc/v1',
      profiles: [{
        provider: 'comfly',
        modelRoute: 'comfly/gpt-image-2',
        displayName: 'GPT Image 2',
        capabilities: ['image_generation'],
      }],
    })).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    await expect(store.readPersisted()).resolves.toEqual({ exists: false });
  });
});
