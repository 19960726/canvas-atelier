import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { createComflyImageHistoryRecovery } from './comfly-image-history-recovery.js';
import { deriveGenerationHistoryId } from './generation-history-provider-sink.js';
import { createProviderTaskMappingStore } from './provider-task-ledger.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==', 'base64');
const secretSupplier = async () => ({ primary: 'pending-image-mapping-secret', fallback: [] });

describe('Comfly paid image intent recovery', () => {
  it('does not resurrect an ACKed image when stale recovery resumes after cancellation', async () => {
    const appDataRoot = await mkdtemp(join(tmpdir(), 'comfly-intent-race-'));
    roots.push(appDataRoot);
    const mappings = createProviderTaskMappingStore({ appDataRoot, secretSupplier });
    const jobId = 'model-job-v2-intent-cancel-ack-race';
    const historyId = deriveGenerationHistoryId(jobId);
    const publicTaskId = `provider-job-${'a'.repeat(32)}`;
    const now = '2026-09-28T08:00:00.000Z';
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const reachedSet = new Promise<void>((resolve) => { started = resolve; });
    const recovery = createComflyImageHistoryRecovery({ appDataRoot, secretSupplier, nowIso: () => now,
      mappings: { ...mappings, setIfAbsent: async (record) => {
        started(); await gate; return mappings.setIfAbsent(record);
      } },
    });
    const hash = createHash('sha256').update(png).digest('hex');
    await recovery.writeIntent({ version: 1, provider: 'comfly', kind: 'image', historyId, jobId, publicTaskId,
      sessionId: 'original-session', mediaType: 'image/png', hash });
    await recovery.stage(historyId, png);
    await mappings.set({ provider: 'comfly', publicTaskId, rawTaskId: `pending-image-history:${hash}`,
      kind: 'image', sessionId: 'original-session', historyId, state: 'running', createdAt: now, updatedAt: now });
    const staleRecovery = recovery.recoverUnmapped(historyId, undefined, false);
    await reachedSet;
    await mappings.markCancelled(publicTaskId, now);
    await recovery.remove(historyId, publicTaskId);
    await mappings.ackTerminal(publicTaskId, 'cancelled');
    release();
    await expect(staleRecovery).rejects.toMatchObject({ code: 'PROVIDER_INVALID_RESPONSE' });
    await expect(mappings.get(publicTaskId)).resolves.toBeUndefined();
    const restartedLedger = createProviderTaskMappingStore({ appDataRoot, secretSupplier });
    await expect(restartedLedger.setIfAbsent({ provider: 'comfly', publicTaskId,
      rawTaskId: `pending-image-history:${hash}`, kind: 'image', sessionId: 'original-session', historyId,
      state: 'running', createdAt: now, updatedAt: now }))
      .rejects.toMatchObject({ code: 'PROVIDER_INVALID_RESPONSE' });
    await expect(restartedLedger.get(publicTaskId)).resolves.toBeUndefined();
  });

  it('turns an intent with missing paid bytes into an explicit failed terminal', async () => {
    const appDataRoot = await mkdtemp(join(tmpdir(), 'comfly-intent-missing-'));
    roots.push(appDataRoot);
    const mappings = createProviderTaskMappingStore({ appDataRoot, secretSupplier });
    const jobId = 'model-job-v2-intent-missing-bytes';
    const historyId = deriveGenerationHistoryId(jobId);
    const publicTaskId = `provider-job-${'b'.repeat(32)}`;
    const recovery = createComflyImageHistoryRecovery({ appDataRoot, secretSupplier, mappings,
      nowIso: () => '2026-09-28T08:00:00.000Z' });
    await recovery.writeIntent({ version: 1, provider: 'comfly', kind: 'image', historyId, jobId, publicTaskId,
      sessionId: 'original-session', mediaType: 'image/png', hash: createHash('sha256').update(png).digest('hex') });
    await expect(recovery.recoverUnmapped(historyId)).resolves.toEqual({ providerTaskId: publicTaskId });
    await expect(mappings.get(publicTaskId)).resolves.toMatchObject({ state: 'failed' });
  });
});
