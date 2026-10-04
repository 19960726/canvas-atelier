import { createCipheriv, randomBytes, scryptSync } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createProviderBridgeError } from './provider-contracts';
import { createProviderTaskMappingStore } from './provider-task-ledger';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('provider task mapping provider identity', () => {
  it('updates a running task atomically and preserves cancellation against a stale result', async () => {
    const appDataRoot = await mkdtemp(join(tmpdir(), 'provider-task-ledger-running-cas-'));
    temporaryRoots.push(appDataRoot);
    const store = createProviderTaskMappingStore({ appDataRoot,
      secretSupplier: async () => ({ primary: 'fixture-mapping-secret', fallback: [] }) });
    const now = '2026-09-28T08:00:00.000Z';
    await store.set({ provider: 'comfly', publicTaskId: 'public-cas-task', rawTaskId: 'raw-provider-id',
      kind: 'image', state: 'running', createdAt: now, updatedAt: now });
    await expect(store.updateRunning('public-cas-task', { expectedRawTaskId: 'wrong-provider-id', rawTaskId: 'pending-id' }, now))
      .resolves.toMatchObject({ rawTaskId: 'raw-provider-id' });
    await expect(store.updateRunning('public-cas-task', { expectedRawTaskId: 'raw-provider-id', rawTaskId: 'pending-id' }, now))
      .resolves.toMatchObject({ rawTaskId: 'pending-id', state: 'running' });
    await store.markCancelled('public-cas-task', now);
    await expect(store.updateRunning('public-cas-task', { result: { assetId: '0123456789abcdef' } }, now))
      .resolves.toMatchObject({ rawTaskId: 'pending-id', state: 'cancelled' });
    await expect(store.get('public-cas-task')).resolves.not.toHaveProperty('result');
  });
  it('reloads a failed terminal whose source error is an Error instance', async () => {
    const appDataRoot = await mkdtemp(join(tmpdir(), 'provider-task-ledger-error-'));
    temporaryRoots.push(appDataRoot);
    const secretSupplier = async () => ({ primary: 'fixture-mapping-secret', fallback: [] });
    const store = createProviderTaskMappingStore({ appDataRoot, secretSupplier });
    const timestamp = '2026-09-09T08:00:00.000Z';
    await store.set({
      provider: 'comfly', publicTaskId: 'public-failed-image', rawTaskId: 'raw-failed-image',
      kind: 'image', state: 'running', createdAt: timestamp, updatedAt: timestamp,
    });

    await store.markTerminal('public-failed-image', {
      status: 'failed',
      error: createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Provider returned an invalid image result'),
    }, timestamp);

    const reloaded = createProviderTaskMappingStore({ appDataRoot, secretSupplier });
    await expect(reloaded.get('public-failed-image')).resolves.toMatchObject({
      state: 'failed',
      error: {
        code: 'PROVIDER_INVALID_RESPONSE', message: 'Provider returned an invalid image result', retryable: false,
      },
    });
  });

  it('recovers an already serialized terminal Error without exposing its missing message', async () => {
    const appDataRoot = await mkdtemp(join(tmpdir(), 'provider-task-ledger-legacy-error-'));
    temporaryRoots.push(appDataRoot);
    const secretSupplier = async () => ({ primary: 'fixture-mapping-secret', fallback: [] });
    const store = createProviderTaskMappingStore({ appDataRoot, secretSupplier });
    const timestamp = '2026-09-09T08:00:00.000Z';
    await store.set({
      provider: 'comfly', publicTaskId: 'public-legacy-failed-image', rawTaskId: 'raw-legacy-failed-image',
      kind: 'image', state: 'failed', createdAt: timestamp, updatedAt: timestamp, terminalAt: timestamp,
      error: createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Original Error message is not serialized'),
    });

    const reloaded = createProviderTaskMappingStore({ appDataRoot, secretSupplier });
    await expect(reloaded.get('public-legacy-failed-image')).resolves.toMatchObject({
      state: 'failed',
      error: { code: 'PROVIDER_INVALID_RESPONSE', message: 'Provider task failed', retryable: false },
    });
    await expect(reloaded.get('public-legacy-failed-image')).resolves.toMatchObject({
      error: { message: 'Provider task failed' },
    });
  });

  it('migrates a v4 failed terminal whose serialized Error lost its message', async () => {
    const appDataRoot = await mkdtemp(join(tmpdir(), 'provider-task-ledger-v4-error-'));
    temporaryRoots.push(appDataRoot);
    const secret = 'fixture-mapping-secret';
    const secretSupplier = async () => ({ primary: secret, fallback: [] });
    const timestamp = '2026-09-09T08:00:00.000Z';
    const serializedError = JSON.parse(JSON.stringify(
      createProviderBridgeError('PROVIDER_INVALID_RESPONSE', 'Original Error message is not serialized'),
    )) as unknown;
    const payload = JSON.stringify({
      version: 4,
      mappings: [{
        provider: 'comfly', publicTaskId: 'public-v4-failed-image', rawTaskId: 'raw-v4-failed-image',
        kind: 'image', state: 'failed', createdAt: timestamp, updatedAt: timestamp, terminalAt: timestamp,
        error: serializedError,
      }],
      submissionReservations: [],
    });
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', scryptSync(secret, salt, 32), iv);
    const ciphertext = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
    await writeFile(join(appDataRoot, 'provider-task-mappings.json'), JSON.stringify({
      version: 1, saltHex: salt.toString('hex'), ivHex: iv.toString('hex'),
      authTagHex: cipher.getAuthTag().toString('hex'), ciphertextHex: ciphertext.toString('hex'),
    }));

    const reloaded = createProviderTaskMappingStore({ appDataRoot, secretSupplier });
    await expect(reloaded.get('public-v4-failed-image')).resolves.toMatchObject({
      state: 'failed',
      error: { code: 'PROVIDER_INVALID_RESPONSE', message: 'Provider task failed', retryable: false },
    });
    const rewritten = createProviderTaskMappingStore({ appDataRoot, secretSupplier });
    await expect(rewritten.get('public-v4-failed-image')).resolves.toMatchObject({
      error: { message: 'Provider task failed' },
    });
  });

  it('still rejects a terminal mapping with an explicitly empty error message', async () => {
    const appDataRoot = await mkdtemp(join(tmpdir(), 'provider-task-ledger-empty-error-'));
    temporaryRoots.push(appDataRoot);
    const secretSupplier = async () => ({ primary: 'fixture-mapping-secret', fallback: [] });
    const store = createProviderTaskMappingStore({ appDataRoot, secretSupplier });
    const timestamp = '2026-09-09T08:00:00.000Z';
    await store.set({
      provider: 'comfly', publicTaskId: 'public-invalid-failed-image', rawTaskId: 'raw-invalid-failed-image',
      kind: 'image', state: 'failed', createdAt: timestamp, updatedAt: timestamp, terminalAt: timestamp,
      error: { code: 'PROVIDER_INVALID_RESPONSE', message: '', retryable: false },
    });

    const reloaded = createProviderTaskMappingStore({ appDataRoot, secretSupplier });
    await expect(reloaded.get('public-invalid-failed-image')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

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

  it('persists a bound project identity and rejects a malformed binding on reload', async () => {
    const appDataRoot = await mkdtemp(join(tmpdir(), 'provider-task-ledger-binding-'));
    temporaryRoots.push(appDataRoot);
    const secretSupplier = async () => ({ primary: 'fixture-mapping-secret', fallback: [] });
    const store = createProviderTaskMappingStore({ appDataRoot, secretSupplier });
    const timestamp = '2026-09-09T08:00:00.000Z';
    const binding = { projectId: 'project-bound-a', rootFingerprint: 'a'.repeat(64) };
    await store.set({
      provider: 'comfly', publicTaskId: 'public-bound-image', rawTaskId: 'raw-bound-image',
      kind: 'image', state: 'running', createdAt: timestamp, updatedAt: timestamp,
      projectBinding: binding,
    });
    await expect(createProviderTaskMappingStore({ appDataRoot, secretSupplier }).get('public-bound-image'))
      .resolves.toMatchObject({ projectBinding: binding });

    await expect(store.set({
      provider: 'comfly', publicTaskId: 'public-bound-image', rawTaskId: 'raw-bound-image',
      kind: 'image', state: 'running', createdAt: timestamp, updatedAt: timestamp,
      projectBinding: { ...binding, rootFingerprint: 'not-a-fingerprint' },
    })).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    await expect(createProviderTaskMappingStore({ appDataRoot, secretSupplier }).get('public-bound-image'))
      .resolves.toMatchObject({ projectBinding: binding });
  });
});
