import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createKnowledgeSnapshotCandidate } from '@agent-canvas/skill-store';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ApprovedSnapshotOutbox,
  createApprovedSnapshotSyncClientFromEnv,
  startApprovedSnapshotOutboxDrain,
} from './approved-snapshot-outbox';
import { ManagedKnowledgeStore } from './managed-knowledge-store';

describe('ApprovedSnapshotOutbox', () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
  });

  it('restores an approved snapshot outbox job after restart and drains through memory sync without serializing documents', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'approved-snapshot-outbox-'));
    tempRoots.push(tempRoot);
    const appDataRoot = join(tempRoot, 'app-data');
    const store = new ManagedKnowledgeStore({ appDataRoot });
    await store.configure({
      knowledgeBaseId: 'scene-skill',
      displayName: 'Scene Skill',
      rootPath: join(tempRoot, 'source', 'scene-skill'),
    });
    const candidate = createKnowledgeSnapshotCandidate({
      knowledgeBaseId: 'scene-skill',
      displayName: 'Scene Skill',
      documents: [{ relativePath: 'memory/main.md', content: '# Scene Skill\n\nUse calmer liquid arcs.' }],
    });
    await store.publish({
      ...candidate,
      version: 1,
      publishedAt: '2026-07-15T10:00:00.000Z',
      sourceDeviceId: 'device-a',
    });
    const snapshot = await store.readVersion('scene-skill', 1);
    if (snapshot === null) throw new Error('expected retained snapshot');

    const outbox = new ApprovedSnapshotOutbox({
      appDataRoot,
      now: () => Date.parse('2026-07-15T10:01:00.000Z'),
      random: () => 0.25,
      store,
    });
    await outbox.enqueueApprovedSnapshot(snapshot);

    const rawOutbox = await readFile(join(appDataRoot, 'sync', 'approved-snapshot-outbox.json'), 'utf8');
    expect(rawOutbox).toContain('"approvedSnapshot"');
    expect(rawOutbox).toContain('"version":1');
    expect(rawOutbox).not.toContain('Use calmer liquid arcs');
    expect(rawOutbox).not.toContain('memory/main.md');
    expect(rawOutbox).not.toMatch(/Authorization|Bearer|data:image|[A-Za-z]:\\\\/u);

    const uploadApprovedSnapshot = vi.fn(async () => ({ accepted: true }));
    const restarted = new ApprovedSnapshotOutbox({
      appDataRoot,
      client: { uploadApprovedSnapshot },
      now: () => Date.parse('2026-07-15T10:02:00.000Z'),
      random: () => 0.5,
      store: new ManagedKnowledgeStore({ appDataRoot }),
    });
    const drained = await restarted.drainApprovedSnapshots();

    expect(drained.processedJobIds).toHaveLength(1);
    expect(uploadApprovedSnapshot).toHaveBeenCalledWith(snapshot, {
      idempotencyKey: drained.processedJobIds[0],
    });
    await expect(restarted.readPublicState()).resolves.toEqual({ schemaVersion: 1, jobs: [] });
  });

  it('creates the existing memory sync client from desktop runtime configuration only when fully configured', async () => {
    const fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ accepted: true, duplicate: false, snapshotId: 'scene-skill@1' }),
    }));
    const snapshot = createKnowledgeSnapshotCandidate({
      knowledgeBaseId: 'scene-skill',
      displayName: 'Scene Skill',
      documents: [{ relativePath: 'memory/main.md', content: '# Scene Skill' }],
    });

    expect(createApprovedSnapshotSyncClientFromEnv({}, fetch)).toBeNull();
    expect(createApprovedSnapshotSyncClientFromEnv({ NOVUS_KNOWLEDGE_SYNC_URL: 'https://knowledge.example.com' }, fetch)).toBeNull();

    const client = createApprovedSnapshotSyncClientFromEnv({
      NOVUS_KNOWLEDGE_SYNC_TOKEN: 'secret-token',
      NOVUS_KNOWLEDGE_SYNC_URL: 'https://knowledge.example.com/',
    }, fetch);

    expect(client).not.toBeNull();
    await expect(client!.uploadApprovedSnapshot({
      ...snapshot,
      version: 1,
      publishedAt: '2026-07-15T10:00:00.000Z',
      sourceDeviceId: 'device-a',
    }, { idempotencyKey: 'idem-1' })).resolves.toEqual({
      accepted: true,
      duplicate: false,
      snapshotId: 'scene-skill@1',
    });
    expect(fetch).toHaveBeenCalledWith('https://knowledge.example.com/v1/knowledge-bases/scene-skill/approved-snapshot', expect.objectContaining({
      headers: expect.objectContaining({
        authorization: 'Bearer secret-token',
        'idempotency-key': 'idem-1',
      }),
      method: 'PUT',
    }));
  });

  it('drains approved snapshot outbox at startup and when the online-gated retry boundary opens', async () => {
    let tick: (() => void) | undefined;
    const clearInterval = vi.fn();
    const drainApprovedSnapshots = vi.fn(async () => ({ processedJobIds: [], state: { schemaVersion: 1 as const, jobs: [] } }));
    const client = { uploadApprovedSnapshot: vi.fn() };
    let online = true;

    const handle = startApprovedSnapshotOutboxDrain({
      client,
      clearInterval,
      intervalMs: 10,
      isOnline: () => online,
      outbox: { drainApprovedSnapshots },
      setInterval: (listener) => {
        tick = listener;
        return 101;
      },
    });

    await handle.drainNow();
    expect(drainApprovedSnapshots).toHaveBeenCalledTimes(1);
    expect(drainApprovedSnapshots).toHaveBeenCalledWith(client);

    online = false;
    tick?.();
    await Promise.resolve();
    expect(drainApprovedSnapshots).toHaveBeenCalledTimes(1);

    online = true;
    tick?.();
    await Promise.resolve();
    expect(drainApprovedSnapshots).toHaveBeenCalledTimes(2);

    handle.stop();
    expect(clearInterval).toHaveBeenCalledWith(101);
  });
});
