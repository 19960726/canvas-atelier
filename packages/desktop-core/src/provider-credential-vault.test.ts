import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createSecureProviderCredentialStore,
  type SafeStorageAdapter,
} from './provider-credential-vault';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('ProviderCredentialStore.clear', () => {
  it('is part of the credential store API', () => {
    const store = createSecureProviderCredentialStore({ appDataRoot: 'credential-test-root' });

    expect((store as unknown as { clear?: unknown }).clear).toBeTypeOf('function');
  });

  it('deletes configured credentials and clears the unlocked in-memory value', async () => {
    const appDataRoot = await createTemporaryRoot();
    const store = createSecureProviderCredentialStore({ appDataRoot, safeStorage: fakeSafeStorage });
    await store.configure({ token: 'fixture-provider-token' });

    await store.clear();

    await expect(store.getStatus()).resolves.toMatchObject({ configured: false, locked: true });
    await expect(store.getToken()).rejects.toMatchObject({ code: 'CREDENTIALS_LOCKED' });
    await expect(access(join(appDataRoot, 'provider-credentials.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('is idempotent when the credential file does not exist', async () => {
    const appDataRoot = await createTemporaryRoot();
    const store = createSecureProviderCredentialStore({ appDataRoot, safeStorage: fakeSafeStorage });

    await expect(store.clear()).resolves.toBeUndefined();
    await expect(store.clear()).resolves.toBeUndefined();
    await expect(store.getStatus()).resolves.toMatchObject({ configured: false, locked: true });
  });

  it('runs after an earlier configure operation at the existing serialization boundary', async () => {
    const appDataRoot = await createTemporaryRoot();
    const store = createSecureProviderCredentialStore({ appDataRoot, safeStorage: fakeSafeStorage });

    const configure = store.configure({ token: 'fixture-provider-token' });
    const clear = store.clear();
    await Promise.all([configure, clear]);

    await expect(store.getStatus()).resolves.toMatchObject({ configured: false, locked: true });
    await expect(store.getToken()).rejects.toMatchObject({ code: 'CREDENTIALS_LOCKED' });
  });
});

const fakeSafeStorage: SafeStorageAdapter = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(value, 'utf8'),
  decryptString: (value) => Buffer.from(value).toString('utf8'),
};

async function createTemporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'provider-credential-clear-'));
  temporaryRoots.push(root);
  return root;
}
