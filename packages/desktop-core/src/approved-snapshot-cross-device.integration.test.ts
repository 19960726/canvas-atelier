import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createKnowledgeSnapshotCandidate,
  knowledgeSnapshotSyncSchema,
  type KnowledgeSnapshot,
} from '@agent-canvas/skill-store';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ApprovedSnapshotOutbox,
  createApprovedSnapshotSyncClientFromEnv,
} from './approved-snapshot-outbox';
import { ApprovedSnapshotPullCoordinator } from './approved-snapshot-pull';
import { ManagedKnowledgeStore } from './managed-knowledge-store';

describe('approved snapshot cross-device integration', () => {
  const servers: Server[] = [];
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(closeServer));
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
  });

  it('moves approved growth between isolated devices and preserves a rejected stale upload for reconciliation', async () => {
    const service = await startKnowledgeSyncService();
    servers.push(service.server);
    const tempRoot = await mkdtemp(join(tmpdir(), 'approved-snapshot-two-device-'));
    tempRoots.push(tempRoot);

    const deviceA = await createDevice(tempRoot, 'device-a', service.baseUrl);
    const deviceB = await createDevice(tempRoot, 'device-b', service.baseUrl);
    const first = createSnapshot('# Shared growth v1', 1, 'device-a');
    await deviceA.store.publish(first);
    await deviceA.outbox.enqueueApprovedSnapshot(first);

    const firstUpload = await deviceA.outbox.drainApprovedSnapshots();
    expect(firstUpload).toMatchObject({
      processedJobIds: [expect.any(String)],
      state: { jobs: [] },
    });
    const acceptedIdempotencyKey = firstUpload.processedJobIds[0];
    if (acceptedIdempotencyKey === undefined) throw new Error('expected accepted idempotency key');
    await expect(deviceA.client.uploadApprovedSnapshot(first, {
      idempotencyKey: acceptedIdempotencyKey,
    })).resolves.toMatchObject({
      accepted: true,
      duplicate: true,
    });

    const pullB = new ApprovedSnapshotPullCoordinator({
      appDataRoot: deviceB.appDataRoot,
      clearInterval: () => undefined,
      client: deviceB.client,
      setInterval: () => 1,
      store: deviceB.store,
    });
    await pullB.start(['scene-skill']);
    await expect(deviceB.store.readActive('scene-skill')).resolves.toEqual(first);

    const staleLocal = createSnapshot('# Device B offline growth v2', 2, 'device-b');
    await deviceB.store.publish(staleLocal);
    await deviceB.outbox.enqueueApprovedSnapshot(staleLocal);

    const newestRemote = createSnapshot('# Device A approved growth v3', 3, 'device-a');
    await deviceA.store.publish(newestRemote);
    await deviceA.outbox.enqueueApprovedSnapshot(newestRemote);
    await deviceA.outbox.drainApprovedSnapshots();

    await pullB.pullNow();
    await expect(deviceB.store.readActive('scene-skill')).resolves.toEqual(newestRemote);

    const rejected = await deviceB.outbox.drainApprovedSnapshots();
    expect(rejected.processedJobIds).toEqual([]);
    expect(rejected.state.jobs).toEqual([
      expect.objectContaining({
        approvedSnapshot: expect.objectContaining({
          contentHash: staleLocal.contentHash,
          knowledgeBaseId: 'scene-skill',
          version: 2,
        }),
        attemptCount: 1,
        lastError: 'approved_snapshot_not_accepted',
        status: 'retry_wait',
      }),
    ]);

    deviceB.advanceNow(2_000);
    const retriedRejection = await deviceB.outbox.drainApprovedSnapshots();
    expect(retriedRejection.processedJobIds).toEqual([]);
    expect(retriedRejection.state.jobs).toEqual([
      expect.objectContaining({
        attemptCount: 2,
        lastError: 'approved_snapshot_not_accepted',
        status: 'retry_wait',
      }),
    ]);

    expect(service.uploadedVersions).toEqual([1, 3]);
    expect(service.rejectedVersions).toEqual([2, 2]);
    expect(service.requestCursors).toEqual([undefined, 'cursor-1']);
    const cursorState = await readFile(
      join(deviceB.appDataRoot, 'sync', 'approved-snapshot-pull-cursors.json'),
      'utf8',
    );
    expect(JSON.parse(cursorState)).toEqual({
      schemaVersion: 1,
      cursors: { 'scene-skill': 'cursor-2' },
    });
    const persistedOutbox = await readFile(
      join(deviceB.appDataRoot, 'sync', 'approved-snapshot-outbox.json'),
      'utf8',
    );
    expect(persistedOutbox).not.toContain('Device B offline growth');
    expect(persistedOutbox).not.toMatch(/"authorization"\s*:|bearer\s+\S+|data:image|[A-Za-z]:\\\\/iu);
    await pullB.stop();
  });
});

async function createDevice(tempRoot: string, deviceId: string, baseUrl: string) {
  const appDataRoot = join(tempRoot, deviceId, 'app-data');
  const store = new ManagedKnowledgeStore({ appDataRoot });
  await store.configure({
    displayName: 'Scene Skill',
    knowledgeBaseId: 'scene-skill',
    rootPath: join(tempRoot, deviceId, 'source', 'scene-skill'),
  });
  const client = createApprovedSnapshotSyncClientFromEnv({
    NOVUS_KNOWLEDGE_SYNC_TOKEN: 'integration-value',
    NOVUS_KNOWLEDGE_SYNC_URL: baseUrl,
  });
  if (client === null) throw new Error('expected configured sync client');
  let now = Date.parse('2026-07-18T08:00:00.000Z');
  return {
    advanceNow: (milliseconds: number) => {
      now += milliseconds;
    },
    appDataRoot,
    client,
    outbox: new ApprovedSnapshotOutbox({
      appDataRoot,
      client,
      now: () => now,
      random: () => 0.25,
      store,
    }),
    store,
  };
}

function createSnapshot(content: string, version: number, sourceDeviceId: string): KnowledgeSnapshot {
  return {
    ...createKnowledgeSnapshotCandidate({
      displayName: 'Scene Skill',
      documents: [{ content, relativePath: 'memory/main.md' }],
      knowledgeBaseId: 'scene-skill',
    }),
    publishedAt: `2026-07-18T08:0${version}:00.000Z`,
    sourceDeviceId,
    version,
  };
}

async function startKnowledgeSyncService(): Promise<{
  baseUrl: string;
  rejectedVersions: number[];
  requestCursors: Array<string | undefined>;
  server: Server;
  uploadedVersions: number[];
}> {
  const acceptedIdempotencyKeys = new Set<string>();
  const rejectedVersions: number[] = [];
  const requestCursors: Array<string | undefined> = [];
  const snapshots = new Map<string, { cursor: number; snapshot: KnowledgeSnapshot }>();
  const uploadedVersions: number[] = [];
  const server = createServer((request, response) => {
    void handleSyncRequest(request, response, {
      acceptedIdempotencyKeys,
      rejectedVersions,
      requestCursors,
      snapshots,
      uploadedVersions,
    }).catch(() => {
      respondJson(response, 500, { error: 'sync service failure' });
    });
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolvePromise());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected TCP sync service address');
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    rejectedVersions,
    requestCursors,
    server,
    uploadedVersions,
  };
}

async function handleSyncRequest(
  request: IncomingMessage,
  response: ServerResponse,
  state: {
    acceptedIdempotencyKeys: Set<string>;
    rejectedVersions: number[];
    requestCursors: Array<string | undefined>;
    snapshots: Map<string, { cursor: number; snapshot: KnowledgeSnapshot }>;
    uploadedVersions: number[];
  },
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  const match = /^\/v1\/knowledge-bases\/([^/]+)\/approved-snapshot$/u.exec(url.pathname);
  if (match === null) {
    respondJson(response, 404, { error: 'not found' });
    return;
  }
  const knowledgeBaseId = decodeURIComponent(match[1]!);
  if (request.method === 'GET') {
    const cursor = url.searchParams.get('cursor') ?? undefined;
    state.requestCursors.push(cursor);
    const current = state.snapshots.get(knowledgeBaseId);
    const currentCursor = current === undefined ? undefined : `cursor-${current.cursor}`;
    respondJson(response, 200, {
      cursor: currentCursor,
      snapshot: current !== undefined && cursor !== currentCursor ? current.snapshot : null,
    });
    return;
  }
  if (request.method !== 'PUT') {
    respondJson(response, 405, { error: 'method not allowed' });
    return;
  }
  const snapshot = knowledgeSnapshotSyncSchema.parse(JSON.parse(await readRequestBody(request)) as unknown);
  const idempotencyKey = request.headers['idempotency-key'];
  if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) {
    respondJson(response, 400, { error: 'missing idempotency key' });
    return;
  }
  if (state.acceptedIdempotencyKeys.has(idempotencyKey)) {
    respondJson(response, 200, {
      accepted: true,
      duplicate: true,
      snapshotId: `${knowledgeBaseId}@${snapshot.version}`,
    });
    return;
  }
  const current = state.snapshots.get(knowledgeBaseId);
  if (current !== undefined && snapshot.version <= current.snapshot.version) {
    state.rejectedVersions.push(snapshot.version);
    respondJson(response, 200, {
      accepted: false,
      duplicate: false,
      snapshotId: `${knowledgeBaseId}@${snapshot.version}`,
    });
    return;
  }
  const cursor = (current?.cursor ?? 0) + 1;
  state.snapshots.set(knowledgeBaseId, { cursor, snapshot });
  state.acceptedIdempotencyKeys.add(idempotencyKey);
  state.uploadedVersions.push(snapshot.version);
  respondJson(response, 200, {
    accepted: true,
    duplicate: false,
    snapshotId: `${knowledgeBaseId}@${snapshot.version}`,
  });
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of request) {
    body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
  }
  return body;
}

function respondJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.statusCode = statusCode;
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(body));
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolvePromise();
    });
  });
}
