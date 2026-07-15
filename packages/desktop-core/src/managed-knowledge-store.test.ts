import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, normalize } from 'node:path';

import {
  createKnowledgeSnapshotCandidate,
  type KnowledgeBaseStateSummary,
  type KnowledgeSnapshotCandidate,
  type KnowledgeSnapshot,
} from '@agent-canvas/skill-store';
import { afterEach, describe, expect, it } from 'vitest';

import { type FileHandleLike, type FileSystem, NodeFileSystem } from './file-system';
import { ManagedKnowledgeStore } from './managed-knowledge-store';

describe('ManagedKnowledgeStore', () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
    );
  });

  it('stores roots privately and returns opaque ids', async () => {
    const tempRoot = await createTempRoot(tempRoots);
    const appDataRoot = join(tempRoot, 'app-data');
    const sourceRoot = join(tempRoot, 'workspace', 'scene-skill');
    const store = new ManagedKnowledgeStore({ appDataRoot });

    const configured = await store.configure({
      knowledgeBaseId: 'scene-skill',
      displayName: 'Scene Skill',
      rootPath: sourceRoot,
    });

    expect(configured).toEqual(expect.objectContaining({
      knowledgeBaseId: 'scene-skill',
      displayName: 'Scene Skill',
      knowledgeRootId: expect.any(String),
    }));
    expect(JSON.stringify(configured)).not.toContain(sourceRoot);

    expect(await store.readConfiguration('scene-skill')).toEqual({
      schemaVersion: 1,
      knowledgeBaseId: 'scene-skill',
      displayName: 'Scene Skill',
      knowledgeRootId: configured.knowledgeRootId,
      rootPath: normalize(sourceRoot),
    });
    await expect(store.readConfiguration(configured.knowledgeRootId)).resolves.toBeNull();
    expect(JSON.stringify(await store.listStates())).not.toContain(sourceRoot);
  });

  it('rejects protected configuration metadata before public output', async () => {
    const tempRoot = await createTempRoot(tempRoots);
    const appDataRoot = join(tempRoot, 'app-data');
    const store = new ManagedKnowledgeStore({ appDataRoot });

    await expect(store.configure({
      knowledgeBaseId: 'scene-skill',
      displayName: 'Authorization: Bearer secret',
      rootPath: join(tempRoot, 'workspace', 'scene-skill'),
    })).rejects.toThrow(/protected/i);
    await expect(store.configure({
      knowledgeBaseId: 'C:\\Users\\Private\\skill',
      displayName: 'Scene Skill',
      rootPath: join(tempRoot, 'workspace', 'scene-skill'),
    })).rejects.toThrow(/protected/i);
    await expect(store.configure({
      knowledgeBaseId: 'scene-skill',
      displayName: 'D:\\buildkite\\secret',
      rootPath: join(tempRoot, 'workspace', 'scene-skill'),
    })).rejects.toThrow(/protected/i);
    await expect(store.configure({
      knowledgeBaseId: 'scene-skill',
      displayName: '/opt/secret',
      rootPath: join(tempRoot, 'workspace', 'scene-skill'),
    })).rejects.toThrow(/protected/i);
    await expect(store.configure({
      knowledgeBaseId: 'scene-skill',
      displayName: 'github_pat_secret',
      rootPath: join(tempRoot, 'workspace', 'scene-skill'),
    })).rejects.toThrow(/protected/i);
    await expect(store.listStates()).resolves.toEqual([]);
  });

  it('serializes concurrent configuration writes so knowledge bases are not lost', async () => {
    const tempRoot = await createTempRoot(tempRoots);
    const appDataRoot = join(tempRoot, 'app-data');
    const gate = createPauseGate();
    const slowStore = new ManagedKnowledgeStore({
      appDataRoot,
      fileSystem: new PauseOnConfigFileSystem(gate),
    });
    const fastStore = new ManagedKnowledgeStore({ appDataRoot });

    const configureScene = slowStore.configure({
      knowledgeBaseId: 'scene-skill',
      displayName: 'Scene Skill',
      rootPath: join(tempRoot, 'workspace', 'scene-skill'),
    });
    await gate.entered.promise;
    const configureDetail = fastStore.configure({
      knowledgeBaseId: 'detail-skill',
      displayName: 'Detail Skill',
      rootPath: join(tempRoot, 'workspace', 'detail-skill'),
    });

    gate.release.resolve();
    await configureScene;
    await configureDetail;

    await expect(fastStore.listStates()).resolves.toEqual([
      expect.objectContaining({ knowledgeBaseId: 'detail-skill' }),
      expect.objectContaining({ knowledgeBaseId: 'scene-skill' }),
    ]);
  });

  it('retries configuration lock acquisition when the lock vanishes between lstat and Windows realpath', async () => {
    const tempRoot = await createTempRoot(tempRoots);
    const appDataRoot = join(tempRoot, 'app-data');
    const gate = createPauseGate();
    const slowStore = new ManagedKnowledgeStore({
      appDataRoot,
      fileSystem: new PauseOnConfigFileSystem(gate),
    });
    const configureScene = slowStore.configure({
      knowledgeBaseId: 'scene-skill',
      displayName: 'Scene Skill',
      rootPath: join(tempRoot, 'workspace', 'scene-skill'),
    });
    await gate.entered.promise;

    const raceFileSystem = new LockRealpathRaceFileSystem({
      lockPath: join(appDataRoot, 'knowledge', 'config.lock'),
      releaseHolder: gate.release.resolve,
      vanishBeforeEperm: true,
    });
    const racingStore = new ManagedKnowledgeStore({ appDataRoot, fileSystem: raceFileSystem });
    const configureDetail = racingStore.configure({
      knowledgeBaseId: 'detail-skill',
      displayName: 'Detail Skill',
      rootPath: join(tempRoot, 'workspace', 'detail-skill'),
    });

    await Promise.all([configureScene, configureDetail]);

    expect(raceFileSystem.injectedEpermCount).toBe(1);
    await expect(racingStore.listStates()).resolves.toEqual([
      expect.objectContaining({ knowledgeBaseId: 'detail-skill' }),
      expect.objectContaining({ knowledgeBaseId: 'scene-skill' }),
    ]);
  });

  it('does not treat persistent lock realpath EPERM as a vanished file', async () => {
    const tempRoot = await createTempRoot(tempRoots);
    const appDataRoot = join(tempRoot, 'app-data');
    const knowledgeRoot = join(appDataRoot, 'knowledge');
    const lockPath = join(knowledgeRoot, 'config.lock');
    await mkdir(knowledgeRoot, { recursive: true });
    await writeFile(lockPath, '{"schemaVersion":1}\n', 'utf8');
    const fileSystem = new LockRealpathRaceFileSystem({
      lockPath,
      releaseHolder: () => undefined,
      vanishBeforeEperm: false,
    });
    const store = new ManagedKnowledgeStore({ appDataRoot, fileSystem });

    await expect(store.configure({
      knowledgeBaseId: 'scene-skill',
      displayName: 'Scene Skill',
      rootPath: join(tempRoot, 'workspace', 'scene-skill'),
    })).rejects.toMatchObject({ code: 'EPERM' });
    expect(fileSystem.injectedEpermCount).toBe(1);
    await expect(readFile(lockPath, 'utf8')).resolves.toContain('schemaVersion');
  });
  it('writes snapshot bytes before current metadata', async () => {
    const tempRoot = await createTempRoot(tempRoots);
    const appDataRoot = join(tempRoot, 'app-data');
    const store = new ManagedKnowledgeStore({ appDataRoot });
    const configured = await store.configure({
      knowledgeBaseId: 'scene-skill',
      displayName: 'Scene Skill',
      rootPath: join(tempRoot, 'workspace', 'scene-skill'),
    });
    const initial = createSnapshot('# version 1', 1);
    await store.publish(initial);

    const failingStore = new ManagedKnowledgeStore({
      appDataRoot,
      fileSystem: new FailCurrentMetadataFileSystem(configured.knowledgeRootId),
    });
    const next = createSnapshot('# version 2', 2);

    await expect(failingStore.publish(next)).rejects.toThrow(/current metadata/i);

    const snapshotPath = join(
      appDataRoot,
      'knowledge',
      configured.knowledgeRootId,
      'snapshots',
      `v-${next.version}-${next.contentHash.slice(0, 12)}.json`,
    );
    await expect(readJson<KnowledgeSnapshot>(snapshotPath)).resolves.toEqual(next);
    await expect(store.readActive('scene-skill')).resolves.toEqual(initial);

    const states = await store.listStates();
    expect(states).toEqual([expect.objectContaining({
      knowledgeBaseId: 'scene-skill',
      activeVersion: 1,
      versionCount: 1,
    })]);
    expect(JSON.stringify(states)).not.toContain(appDataRoot);
  });

  it('rolls back to an earlier published version', async () => {
    const tempRoot = await createTempRoot(tempRoots);
    const appDataRoot = join(tempRoot, 'app-data');
    const store = new ManagedKnowledgeStore({ appDataRoot });

    await store.configure({
      knowledgeBaseId: 'scene-skill',
      displayName: 'Scene Skill',
      rootPath: join(tempRoot, 'workspace', 'scene-skill'),
    });

    const first = createSnapshot('# version 1', 1);
    const second = createSnapshot('# version 2', 2);
    await store.publish(first);
    await store.publish(second);

    const summary = await store.rollback('scene-skill', 1);

    expect(summary).toMatchObject({
      knowledgeBaseId: 'scene-skill',
      status: 'rolled_back',
      activeVersion: 1,
      versionCount: 2,
      lastRollbackAt: expect.any(String),
    });
    await expect(store.readActive('scene-skill')).resolves.toEqual(first);
  });

  it('stages an approved snapshot durably without activating until post-ack reconciliation', async () => {
    const tempRoot = await createTempRoot(tempRoots);
    const appDataRoot = join(tempRoot, 'app-data');
    const store = new ManagedKnowledgeStore({ appDataRoot });
    await store.configure({
      knowledgeBaseId: 'scene-skill',
      displayName: 'Scene Skill',
      rootPath: join(tempRoot, 'workspace', 'scene-skill'),
    });
    const first = createSnapshot('# version 1', 1);
    await store.publish(first);

    const candidate = createKnowledgeSnapshotCandidate({
      knowledgeBaseId: 'scene-skill',
      displayName: 'Scene Skill',
      documents: [{ relativePath: 'memory/main.md', content: '# version 2' }],
    });
    const staged = await (store as unknown as {
      stageApprovedSnapshot(
        candidate: KnowledgeSnapshotCandidate,
        metadata: {
          stageId: string;
          projectId: string;
          candidateId: string;
          transactionId: string;
          expectedActiveVersion: number;
          expectedActiveContentHash: string;
          sourceDeviceId: string;
          stagedAt: string;
        },
      ): Promise<{ stageId: string; snapshot: KnowledgeSnapshot }>;
    }).stageApprovedSnapshot(candidate, {
      stageId: 'stage-approve-1',
      projectId: 'project-1',
      candidateId: 'candidate-1',
      transactionId: 'review-skill-candidate-1',
      expectedActiveVersion: first.version,
      expectedActiveContentHash: first.contentHash,
      sourceDeviceId: 'device-a',
      stagedAt: '2026-07-15T10:00:00.000Z',
    });

    expect(staged).toMatchObject({
      stageId: 'stage-approve-1',
      snapshot: { version: 2, contentHash: candidate.contentHash },
    });
    await expect(store.readActive('scene-skill')).resolves.toEqual(first);

    const restarted = new ManagedKnowledgeStore({ appDataRoot });
    const stagedAfterRestart = await (restarted as unknown as {
      listStagedKnowledgeTransitions(): Promise<Array<{ stageId: string; projectId: string; candidateId: string }>>;
    }).listStagedKnowledgeTransitions();
    expect(stagedAfterRestart).toEqual([
      { stageId: 'stage-approve-1', projectId: 'project-1', candidateId: 'candidate-1' },
    ]);

    const activated = await (restarted as unknown as {
      activateStagedTransition(stageId: string): Promise<KnowledgeBaseStateSummary>;
    }).activateStagedTransition('stage-approve-1');

    expect(activated).toMatchObject({
      status: 'active',
      activeVersion: 2,
      activeContentHash: candidate.contentHash,
      versionCount: 2,
    });
    await expect(restarted.readActive('scene-skill')).resolves.toMatchObject({
      version: 2,
      contentHash: candidate.contentHash,
    });
    await expect((restarted as unknown as {
      listStagedKnowledgeTransitions(): Promise<unknown[]>;
    }).listStagedKnowledgeTransitions()).resolves.toEqual([]);
  });

  it('stages rollback durably and leaves active knowledge unchanged until activation', async () => {
    const tempRoot = await createTempRoot(tempRoots);
    const appDataRoot = join(tempRoot, 'app-data');
    const store = new ManagedKnowledgeStore({ appDataRoot });
    await store.configure({
      knowledgeBaseId: 'scene-skill',
      displayName: 'Scene Skill',
      rootPath: join(tempRoot, 'workspace', 'scene-skill'),
    });
    const first = createSnapshot('# version 1', 1);
    const second = createSnapshot('# version 2', 2);
    await store.publish(first);
    await store.publish(second);

    const staged = await (store as unknown as {
      stageRollback(
        input: { knowledgeBaseId: string; targetVersion: number },
        metadata: {
          stageId: string;
          projectId: string;
          candidateId: string;
          transactionId: string;
          expectedActiveVersion: number;
          expectedActiveContentHash: string;
          stagedAt: string;
        },
      ): Promise<{ stageId: string; targetVersion: number }>;
    }).stageRollback({
      knowledgeBaseId: 'scene-skill',
      targetVersion: 1,
    }, {
      stageId: 'stage-rollback-1',
      projectId: 'project-1',
      candidateId: 'candidate-approved',
      transactionId: 'review-skill-candidate-rollback',
      expectedActiveVersion: second.version,
      expectedActiveContentHash: second.contentHash,
      stagedAt: '2026-07-15T10:00:00.000Z',
    });

    expect(staged).toEqual({ stageId: 'stage-rollback-1', targetVersion: 1 });
    await expect(store.readActive('scene-skill')).resolves.toEqual(second);

    const restarted = new ManagedKnowledgeStore({ appDataRoot });
    const activated = await (restarted as unknown as {
      activateStagedTransition(stageId: string): Promise<KnowledgeBaseStateSummary>;
    }).activateStagedTransition('stage-rollback-1');

    expect(activated).toMatchObject({
      status: 'rolled_back',
      activeVersion: 1,
      versionCount: 2,
    });
    await expect(restarted.readActive('scene-skill')).resolves.toEqual(first);
  });

  it('durably records sanitized refresh failure while preserving known-good state and clears it on publish', async () => {
    const tempRoot = await createTempRoot(tempRoots);
    const appDataRoot = join(tempRoot, 'app-data');
    const sourceRoot = join(tempRoot, 'workspace', 'scene-skill');
    const store = new ManagedKnowledgeStore({ appDataRoot });
    const configured = await store.configure({
      knowledgeBaseId: 'scene-skill',
      displayName: 'Scene Skill',
      rootPath: sourceRoot,
    });
    const first = createSnapshot('# version 1', 1);
    await store.publish(first);
    const protectedReason = [
      'Author',
      'ization: Bearer synthetic-value ',
      join(sourceRoot, 'memory', 'main.md'),
      ' data:image/png;base64,',
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
    ].join('');

    const failed = await recordRefreshFailure(
      store,
      'scene-skill',
      protectedReason,
      '2026-07-15T08:05:00.000Z',
    );

    expect(failed).toMatchObject({
      status: 'fallback',
      activeVersion: 1,
      activeContentHash: first.contentHash,
      versionCount: 1,
      lastFailure: {
        failedAt: '2026-07-15T08:05:00.000Z',
        reason: expect.any(String),
      },
    });
    const serialized = JSON.stringify(failed);
    expect(serialized).not.toContain('synthetic-value');
    expect(serialized).not.toContain(sourceRoot);
    expect(serialized).not.toContain('data:image');
    expect(serialized).not.toContain('iVBORw0KGgo');
    await expect(store.readActive('scene-skill')).resolves.toEqual(first);

    const restartedStore = new ManagedKnowledgeStore({ appDataRoot });
    await expect(restartedStore.listStates()).resolves.toEqual([failed]);
    await expect(readJson<KnowledgeBaseStateSummary>(
      managedKnowledgePaths(appDataRoot, configured.knowledgeRootId).currentPath,
    )).resolves.toEqual(failed);

    await restartedStore.publish(createSnapshot('# version 2', 2));
    await expect(new ManagedKnowledgeStore({ appDataRoot }).listStates()).resolves.toEqual([
      expect.objectContaining({
        status: 'active',
        activeVersion: 2,
        versionCount: 2,
        lastFailure: null,
      }),
    ]);

    const failureBeforeRollback = await recordRefreshFailure(
      restartedStore,
      'scene-skill',
      'Source parse failed',
      '2026-07-15T08:06:00.000Z',
    );
    const rolledBack = await restartedStore.rollback('scene-skill', 1);
    expect(rolledBack).toMatchObject({
      status: 'rolled_back',
      activeVersion: 1,
      lastFailure: failureBeforeRollback.lastFailure,
    });
  });
  it('accepts published snapshots whose documents are not already sorted', async () => {
    const tempRoot = await createTempRoot(tempRoots);
    const appDataRoot = join(tempRoot, 'app-data');
    const store = new ManagedKnowledgeStore({ appDataRoot });

    await store.configure({
      knowledgeBaseId: 'scene-skill',
      displayName: 'Scene Skill',
      rootPath: join(tempRoot, 'workspace', 'scene-skill'),
    });

    const snapshot = createSnapshotFromDocuments([
      { relativePath: 'memory/z.md', content: '# z' },
      { relativePath: 'memory/a.md', content: '# a' },
    ], 1);
    await store.publish(snapshot);

    await expect(store.readActive('scene-skill')).resolves.toEqual({
      ...snapshot,
      documents: [...snapshot.documents].sort((left, right) => (
        left.relativePath.localeCompare(right.relativePath)
      )),
    });
  });

  it('rejects protected metadata before it can enter public summaries', async () => {
    const tempRoot = await createTempRoot(tempRoots);
    const appDataRoot = join(tempRoot, 'app-data');
    const store = new ManagedKnowledgeStore({ appDataRoot });

    await store.configure({
      knowledgeBaseId: 'scene-skill',
      displayName: 'Scene Skill',
      rootPath: join(tempRoot, 'workspace', 'scene-skill'),
    });

    await expect(store.publish({
      ...createSnapshot('# version 1', 1),
      sourceDeviceId: 'Authorization: Bearer secret',
    })).rejects.toThrow(/protected/i);
    await expect(store.publish({
      ...createSnapshot('# version 2', 2),
      displayName: 'C:\\Users\\Private\\skill',
    })).rejects.toThrow(/protected/i);
    await expect(store.publish({
      ...createSnapshot('# version 3', 3),
      sourceDeviceId: 'github_pat_secret',
    })).rejects.toThrow(/protected/i);
    await expect(store.publish({
      ...createSnapshot('# version 4', 4),
      displayName: '/opt/private',
    })).rejects.toThrow(/protected/i);
    await expect(store.publish({
      ...createSnapshot('# version 5', 5),
      sourceDeviceId: 'api_key=secret-value',
    })).rejects.toThrow(/protected/i);
    await expect(store.publish({
      ...createSnapshot('# version 6', 6),
      sourceDeviceId: 'gho_secretvalue',
    })).rejects.toThrow(/protected/i);
    await expect(store.publish({
      ...createSnapshot('# version 7', 7),
      sourceDeviceId: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZWNyZXQifQ.signature',
    })).rejects.toThrow(/protected/i);
    await expect(store.publish({
      ...createSnapshot('# version 8', 8),
      sourceDeviceId: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAEElEQVR42mP8z8AARAAA',
    })).rejects.toThrow(/protected/i);
    await expect(store.listStates()).resolves.toEqual([expect.objectContaining({
      activeVersion: null,
      versionCount: 0,
    })]);
  });

  it('serializes concurrent publishes per knowledge base so versions are not lost', async () => {
    const tempRoot = await createTempRoot(tempRoots);
    const appDataRoot = join(tempRoot, 'app-data');
    const sourceRoot = join(tempRoot, 'workspace', 'scene-skill');
    const initialStore = new ManagedKnowledgeStore({ appDataRoot });
    const configured = await initialStore.configure({
      knowledgeBaseId: 'scene-skill',
      displayName: 'Scene Skill',
      rootPath: sourceRoot,
    });
    await initialStore.publish(createSnapshot('# version 1', 1));

    const gate = createPauseGate();
    const slowStore = new ManagedKnowledgeStore({
      appDataRoot,
      fileSystem: new PauseOnCurrentMetadataFileSystem(configured.knowledgeRootId, gate),
    });
    const fastStore = new ManagedKnowledgeStore({ appDataRoot });

    const publishTwo = slowStore.publish(createSnapshot('# version 2', 2));
    await gate.entered.promise;
    const publishThree = fastStore.publish(createSnapshot('# version 3', 3));
    gate.release.resolve();
    await publishTwo;
    await publishThree;

    await expect(initialStore.listStates()).resolves.toEqual([expect.objectContaining({
      knowledgeBaseId: 'scene-skill',
      activeVersion: 3,
      versionCount: 3,
      versions: [
        expect.objectContaining({ version: 1 }),
        expect.objectContaining({ version: 2 }),
        expect.objectContaining({ version: 3 }),
      ],
    })]);
  });

  it('holds a managed write lock file while a publish is in progress', async () => {
    const tempRoot = await createTempRoot(tempRoots);
    const appDataRoot = join(tempRoot, 'app-data');
    const sourceRoot = join(tempRoot, 'workspace', 'scene-skill');
    const initialStore = new ManagedKnowledgeStore({ appDataRoot });
    const configured = await initialStore.configure({
      knowledgeBaseId: 'scene-skill',
      displayName: 'Scene Skill',
      rootPath: sourceRoot,
    });
    await initialStore.publish(createSnapshot('# version 1', 1));

    const gate = createPauseGate();
    const slowStore = new ManagedKnowledgeStore({
      appDataRoot,
      fileSystem: new PauseOnCurrentMetadataFileSystem(configured.knowledgeRootId, gate),
    });

    const publishTwo = slowStore.publish(createSnapshot('# version 2', 2));
    await gate.entered.promise;

    const paths = managedKnowledgePaths(appDataRoot, configured.knowledgeRootId);
    await expect(readFile(join(paths.baseDir, 'write.lock'), 'utf8')).resolves.toContain('"token"');
    await expect(initialStore.listStates()).resolves.toEqual([expect.objectContaining({
      activeVersion: 1,
      versionCount: 1,
    })]);

    gate.release.resolve();
    await publishTwo;
    await expect(readFile(join(paths.baseDir, 'write.lock'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('serializes publish and rollback so the later rollback wins current metadata', async () => {
    const tempRoot = await createTempRoot(tempRoots);
    const appDataRoot = join(tempRoot, 'app-data');
    const sourceRoot = join(tempRoot, 'workspace', 'scene-skill');
    const initialStore = new ManagedKnowledgeStore({ appDataRoot });
    const configured = await initialStore.configure({
      knowledgeBaseId: 'scene-skill',
      displayName: 'Scene Skill',
      rootPath: sourceRoot,
    });
    await initialStore.publish(createSnapshot('# version 1', 1));

    const gate = createPauseGate();
    const slowStore = new ManagedKnowledgeStore({
      appDataRoot,
      fileSystem: new PauseOnCurrentMetadataFileSystem(configured.knowledgeRootId, gate),
    });
    const rollbackStore = new ManagedKnowledgeStore({ appDataRoot });

    const publishTwo = slowStore.publish(createSnapshot('# version 2', 2));
    await gate.entered.promise;
    const rollback = rollbackStore.rollback('scene-skill', 1);
    gate.release.resolve();
    await publishTwo;

    await expect(rollback).resolves.toMatchObject({
      knowledgeBaseId: 'scene-skill',
      status: 'rolled_back',
      activeVersion: 1,
    });
    await expect(initialStore.listStates()).resolves.toEqual([expect.objectContaining({
      knowledgeBaseId: 'scene-skill',
      status: 'rolled_back',
      activeVersion: 1,
      versionCount: 2,
    })]);
  });

  it('serializes configure initialization with first publish so active metadata is not reset', async () => {
    const tempRoot = await createTempRoot(tempRoots);
    const appDataRoot = join(tempRoot, 'app-data');
    const sourceRoot = join(tempRoot, 'workspace', 'scene-skill');
    const initialStore = new ManagedKnowledgeStore({ appDataRoot });
    const configured = await initialStore.configure({
      knowledgeBaseId: 'scene-skill',
      displayName: 'Scene Skill',
      rootPath: sourceRoot,
    });

    const paths = managedKnowledgePaths(appDataRoot, configured.knowledgeRootId);
    await rm(paths.currentPath, { force: true });
    const gate = createPauseGate();
    const slowConfigure = new ManagedKnowledgeStore({
      appDataRoot,
      fileSystem: new PauseOnCurrentMetadataFileSystem(configured.knowledgeRootId, gate),
    });
    const publisher = new ManagedKnowledgeStore({ appDataRoot });

    const configure = slowConfigure.configure({
      knowledgeBaseId: 'scene-skill',
      displayName: 'Scene Skill',
      rootPath: sourceRoot,
    });
    await gate.entered.promise;
    const publish = publisher.publish(createSnapshot('# version 1', 1));
    gate.release.resolve();
    await configure;
    await publish;

    await expect(initialStore.listStates()).resolves.toEqual([expect.objectContaining({
      activeVersion: 1,
      status: 'active',
      versionCount: 1,
    })]);
  });

  it('rejects publish when snapshots directory resolves outside the managed root', async () => {
    const tempRoot = await createTempRoot(tempRoots);
    const appDataRoot = join(tempRoot, 'app-data');
    const outsideRoot = join(tempRoot, 'outside');
    const store = new ManagedKnowledgeStore({ appDataRoot });
    const configured = await store.configure({
      knowledgeBaseId: 'scene-skill',
      displayName: 'Scene Skill',
      rootPath: join(tempRoot, 'workspace', 'scene-skill'),
    });

    const paths = managedKnowledgePaths(appDataRoot, configured.knowledgeRootId);
    await mkdir(join(outsideRoot, 'snapshots'), { recursive: true });
    const redirectedStore = new ManagedKnowledgeStore({
      appDataRoot,
      fileSystem: new RedirectedManagedPathFileSystem({
        redirects: [{
          actualPath: join(outsideRoot, 'snapshots'),
          lexicalPath: paths.snapshotsDir,
        }],
      }),
    });

    await expect(redirectedStore.publish(createSnapshot('# version 1', 1))).rejects.toThrow(/managed knowledge/i);
    expect(await readdir(join(outsideRoot, 'snapshots'))).toEqual([]);
  });

  it('rejects rollback when the knowledge-base directory resolves outside the managed root', async () => {
    const tempRoot = await createTempRoot(tempRoots);
    const appDataRoot = join(tempRoot, 'app-data');
    const outsideRoot = join(tempRoot, 'outside');
    const store = new ManagedKnowledgeStore({ appDataRoot });
    const configured = await store.configure({
      knowledgeBaseId: 'scene-skill',
      displayName: 'Scene Skill',
      rootPath: join(tempRoot, 'workspace', 'scene-skill'),
    });
    await store.publish(createSnapshot('# version 1', 1));
    await store.publish(createSnapshot('# version 2', 2));

    const paths = managedKnowledgePaths(appDataRoot, configured.knowledgeRootId);
    await mkdir(join(outsideRoot, 'snapshots'), { recursive: true });
    await writeFile(
      join(outsideRoot, 'current.json'),
      await readFile(paths.currentPath, 'utf8'),
      'utf8',
    );
    for (const snapshotName of await readdir(paths.snapshotsDir)) {
      await writeFile(
        join(outsideRoot, 'snapshots', snapshotName),
        await readFile(join(paths.snapshotsDir, snapshotName)),
        'utf8',
      );
    }

    const redirectedStore = new ManagedKnowledgeStore({
      appDataRoot,
      fileSystem: new RedirectedManagedPathFileSystem({
        redirects: [{
          actualPath: outsideRoot,
          lexicalPath: paths.baseDir,
        }],
      }),
    });

    await expect(redirectedStore.rollback('scene-skill', 1)).rejects.toThrow(/managed knowledge/i);
    await expect(readJson<KnowledgeBaseStateSummary>(paths.currentPath)).resolves.toMatchObject({
      activeVersion: 2,
      status: 'active',
    });
  });

  it('rejects configuration writes when the knowledge root resolves outside app data', async () => {
    const tempRoot = await createTempRoot(tempRoots);
    const appDataRoot = join(tempRoot, 'app-data');
    const outsideRoot = join(tempRoot, 'outside');
    const paths = managedKnowledgePaths(appDataRoot, 'unused');
    await mkdir(outsideRoot, { recursive: true });
    const redirectedStore = new ManagedKnowledgeStore({
      appDataRoot,
      fileSystem: new RedirectedManagedPathFileSystem({
        redirects: [{
          actualPath: outsideRoot,
          lexicalPath: paths.knowledgeRoot,
        }],
      }),
    });

    await expect(redirectedStore.configure({
      knowledgeBaseId: 'scene-skill',
      displayName: 'Scene Skill',
      rootPath: join(tempRoot, 'workspace', 'scene-skill'),
    })).rejects.toThrow(/managed knowledge/i);
    expect(await readdir(outsideRoot)).toEqual([]);
  });

  it('rejects configuration writes when the missing config file would be redirected outside app data', async () => {
    const tempRoot = await createTempRoot(tempRoots);
    const appDataRoot = join(tempRoot, 'app-data');
    const outsideRoot = join(tempRoot, 'outside');
    const paths = managedKnowledgePaths(appDataRoot, 'unused');
    await mkdir(outsideRoot, { recursive: true });
    const redirectedStore = new ManagedKnowledgeStore({
      appDataRoot,
      fileSystem: new RedirectedManagedPathFileSystem({
        redirects: [{
          actualPath: join(outsideRoot, 'config.json'),
          lexicalPath: join(paths.knowledgeRoot, 'config.json'),
        }],
      }),
    });

    await expect(redirectedStore.configure({
      knowledgeBaseId: 'scene-skill',
      displayName: 'Scene Skill',
      rootPath: join(tempRoot, 'workspace', 'scene-skill'),
    })).rejects.toThrow(/managed knowledge/i);
    expect(await readdir(outsideRoot)).toEqual([]);
  });

  it('rejects publish before creating children inside a redirected knowledge-base directory', async () => {
    const tempRoot = await createTempRoot(tempRoots);
    const appDataRoot = join(tempRoot, 'app-data');
    const outsideRoot = join(tempRoot, 'outside');
    const store = new ManagedKnowledgeStore({ appDataRoot });
    const configured = await store.configure({
      knowledgeBaseId: 'scene-skill',
      displayName: 'Scene Skill',
      rootPath: join(tempRoot, 'workspace', 'scene-skill'),
    });

    const paths = managedKnowledgePaths(appDataRoot, configured.knowledgeRootId);
    await mkdir(outsideRoot, { recursive: true });
    const redirectedStore = new ManagedKnowledgeStore({
      appDataRoot,
      fileSystem: new RedirectedManagedPathFileSystem({
        redirects: [{
          actualPath: outsideRoot,
          lexicalPath: paths.baseDir,
        }],
      }),
    });

    await expect(redirectedStore.publish(createSnapshot('# version 1', 1))).rejects.toThrow(/managed knowledge/i);
    expect(await readdir(outsideRoot)).toEqual([]);
  });

  it('rejects publish when the missing write lock file would be redirected outside app data', async () => {
    const tempRoot = await createTempRoot(tempRoots);
    const appDataRoot = join(tempRoot, 'app-data');
    const outsideRoot = join(tempRoot, 'outside');
    const store = new ManagedKnowledgeStore({ appDataRoot });
    const configured = await store.configure({
      knowledgeBaseId: 'scene-skill',
      displayName: 'Scene Skill',
      rootPath: join(tempRoot, 'workspace', 'scene-skill'),
    });

    const paths = managedKnowledgePaths(appDataRoot, configured.knowledgeRootId);
    await mkdir(outsideRoot, { recursive: true });
    const redirectedStore = new ManagedKnowledgeStore({
      appDataRoot,
      fileSystem: new RedirectedManagedPathFileSystem({
        redirects: [{
          actualPath: join(outsideRoot, 'write.lock'),
          lexicalPath: join(paths.baseDir, 'write.lock'),
        }],
      }),
    });

    await expect(redirectedStore.publish(createSnapshot('# version 1', 1))).rejects.toThrow(/managed knowledge/i);
    expect(await readdir(outsideRoot)).toEqual([]);
  });

  it('rejects publish when the missing current metadata file would be redirected outside app data', async () => {
    const tempRoot = await createTempRoot(tempRoots);
    const appDataRoot = join(tempRoot, 'app-data');
    const outsideRoot = join(tempRoot, 'outside');
    const store = new ManagedKnowledgeStore({ appDataRoot });
    const configured = await store.configure({
      knowledgeBaseId: 'scene-skill',
      displayName: 'Scene Skill',
      rootPath: join(tempRoot, 'workspace', 'scene-skill'),
    });

    const paths = managedKnowledgePaths(appDataRoot, configured.knowledgeRootId);
    await mkdir(outsideRoot, { recursive: true });
    const redirectedStore = new ManagedKnowledgeStore({
      appDataRoot,
      fileSystem: new RedirectedManagedPathFileSystem({
        redirects: [{
          actualPath: join(outsideRoot, 'current.json'),
          lexicalPath: paths.currentPath,
        }],
      }),
    });

    await expect(redirectedStore.publish(createSnapshot('# version 1', 1))).rejects.toThrow(/managed knowledge/i);
    expect(await readdir(outsideRoot)).toEqual([]);
  });

  it('rejects publish when the missing snapshot file would be redirected outside app data', async () => {
    const tempRoot = await createTempRoot(tempRoots);
    const appDataRoot = join(tempRoot, 'app-data');
    const outsideRoot = join(tempRoot, 'outside');
    const store = new ManagedKnowledgeStore({ appDataRoot });
    const configured = await store.configure({
      knowledgeBaseId: 'scene-skill',
      displayName: 'Scene Skill',
      rootPath: join(tempRoot, 'workspace', 'scene-skill'),
    });
    const snapshot = createSnapshot('# version 1', 1);

    await mkdir(outsideRoot, { recursive: true });
    const redirectedStore = new ManagedKnowledgeStore({
      appDataRoot,
      fileSystem: new RedirectedManagedPathFileSystem({
        redirects: [{
          actualPath: join(outsideRoot, 'snapshot.json'),
          lexicalPath: snapshotPath(appDataRoot, configured.knowledgeRootId, snapshot),
        }],
      }),
    });

    await expect(redirectedStore.publish(snapshot)).rejects.toThrow(/managed knowledge/i);
    expect(await readdir(outsideRoot)).toEqual([]);
  });

  it('rejects current metadata file redirects outside the managed root', async () => {
    const tempRoot = await createTempRoot(tempRoots);
    const appDataRoot = join(tempRoot, 'app-data');
    const outsideRoot = join(tempRoot, 'outside');
    const store = new ManagedKnowledgeStore({ appDataRoot });
    const configured = await store.configure({
      knowledgeBaseId: 'scene-skill',
      displayName: 'Scene Skill',
      rootPath: join(tempRoot, 'workspace', 'scene-skill'),
    });
    await store.publish(createSnapshot('# version 1', 1));

    const paths = managedKnowledgePaths(appDataRoot, configured.knowledgeRootId);
    await mkdir(outsideRoot, { recursive: true });
    await writeFile(
      join(outsideRoot, 'current.json'),
      await readFile(paths.currentPath, 'utf8'),
      'utf8',
    );
    const redirectedStore = new ManagedKnowledgeStore({
      appDataRoot,
      fileSystem: new RedirectedManagedPathFileSystem({
        redirects: [{
          actualPath: join(outsideRoot, 'current.json'),
          lexicalPath: paths.currentPath,
        }],
      }),
    });

    await expect(redirectedStore.listStates()).rejects.toThrow(/managed knowledge/i);
  });

  it('rejects snapshot file redirects outside the managed root', async () => {
    const tempRoot = await createTempRoot(tempRoots);
    const appDataRoot = join(tempRoot, 'app-data');
    const outsideRoot = join(tempRoot, 'outside');
    const store = new ManagedKnowledgeStore({ appDataRoot });
    const configured = await store.configure({
      knowledgeBaseId: 'scene-skill',
      displayName: 'Scene Skill',
      rootPath: join(tempRoot, 'workspace', 'scene-skill'),
    });
    const snapshot = createSnapshot('# version 1', 1);
    await store.publish(snapshot);

    const redirectedSnapshot = snapshotPath(appDataRoot, configured.knowledgeRootId, snapshot);
    await mkdir(outsideRoot, { recursive: true });
    await writeFile(
      join(outsideRoot, 'snapshot.json'),
      await readFile(redirectedSnapshot, 'utf8'),
      'utf8',
    );
    const redirectedStore = new ManagedKnowledgeStore({
      appDataRoot,
      fileSystem: new RedirectedManagedPathFileSystem({
        redirects: [{
          actualPath: join(outsideRoot, 'snapshot.json'),
          lexicalPath: redirectedSnapshot,
        }],
      }),
    });

    await expect(redirectedStore.readActive('scene-skill')).rejects.toThrow(/managed knowledge/i);
  });

  it('rejects rollback when the target snapshot file is missing and keeps current known-good', async () => {
    const tempRoot = await createTempRoot(tempRoots);
    const appDataRoot = join(tempRoot, 'app-data');
    const store = new ManagedKnowledgeStore({ appDataRoot });
    const configured = await store.configure({
      knowledgeBaseId: 'scene-skill',
      displayName: 'Scene Skill',
      rootPath: join(tempRoot, 'workspace', 'scene-skill'),
    });
    const first = createSnapshot('# version 1', 1);
    const second = createSnapshot('# version 2', 2);
    await store.publish(first);
    await store.publish(second);

    await rm(snapshotPath(appDataRoot, configured.knowledgeRootId, first), { force: true });

    await expect(store.rollback('scene-skill', 1)).rejects.toThrow(/snapshot/i);
    await expect(readJson<KnowledgeBaseStateSummary>(
      managedKnowledgePaths(appDataRoot, configured.knowledgeRootId).currentPath,
    )).resolves.toMatchObject({
      activeVersion: 2,
      status: 'active',
    });
  });

  it('rejects rollback when the target snapshot bytes do not match the requested version and knowledge base', async () => {
    const tempRoot = await createTempRoot(tempRoots);
    const appDataRoot = join(tempRoot, 'app-data');
    const store = new ManagedKnowledgeStore({ appDataRoot });
    const configured = await store.configure({
      knowledgeBaseId: 'scene-skill',
      displayName: 'Scene Skill',
      rootPath: join(tempRoot, 'workspace', 'scene-skill'),
    });
    const first = createSnapshot('# version 1', 1);
    const second = createSnapshot('# version 2', 2);
    await store.publish(first);
    await store.publish(second);

    const tampered = {
      ...first,
      knowledgeBaseId: 'other-skill',
    };
    await writeFile(
      snapshotPath(appDataRoot, configured.knowledgeRootId, first),
      `${JSON.stringify(tampered)}\n`,
      'utf8',
    );

    await expect(store.rollback('scene-skill', 1)).rejects.toThrow(/snapshot/i);
    await expect(readJson<KnowledgeBaseStateSummary>(
      managedKnowledgePaths(appDataRoot, configured.knowledgeRootId).currentPath,
    )).resolves.toMatchObject({
      activeVersion: 2,
      status: 'active',
    });
  });

  it('rejects rollback when target snapshot publication metadata was tampered', async () => {
    const tempRoot = await createTempRoot(tempRoots);
    const appDataRoot = join(tempRoot, 'app-data');
    const store = new ManagedKnowledgeStore({ appDataRoot });
    const configured = await store.configure({
      knowledgeBaseId: 'scene-skill',
      displayName: 'Scene Skill',
      rootPath: join(tempRoot, 'workspace', 'scene-skill'),
    });
    const first = createSnapshot('# version 1', 1);
    const second = createSnapshot('# version 2', 2);
    await store.publish(first);
    await store.publish(second);

    const tampered = {
      ...first,
      publishedAt: '2026-07-15T09:01:00.000Z',
      sourceDeviceId: 'device-b',
      displayName: 'Tampered Skill',
    };
    await writeFile(
      snapshotPath(appDataRoot, configured.knowledgeRootId, first),
      `${JSON.stringify(tampered)}\n`,
      'utf8',
    );

    await expect(store.rollback('scene-skill', 1)).rejects.toThrow(/snapshot/i);
    await expect(readJson<KnowledgeBaseStateSummary>(
      managedKnowledgePaths(appDataRoot, configured.knowledgeRootId).currentPath,
    )).resolves.toMatchObject({
      activeVersion: 2,
      status: 'active',
    });
  });

  it('rejects rollback when target snapshot schema metadata was tampered', async () => {
    const tempRoot = await createTempRoot(tempRoots);
    const appDataRoot = join(tempRoot, 'app-data');
    const store = new ManagedKnowledgeStore({ appDataRoot });
    const configured = await store.configure({
      knowledgeBaseId: 'scene-skill',
      displayName: 'Scene Skill',
      rootPath: join(tempRoot, 'workspace', 'scene-skill'),
    });
    const first = createSnapshot('# version 1', 1);
    const second = createSnapshot('# version 2', 2);
    await store.publish(first);
    await store.publish(second);

    const tampered = {
      ...first,
      schemaVersion: 99,
    };
    await writeFile(
      snapshotPath(appDataRoot, configured.knowledgeRootId, first),
      `${JSON.stringify(tampered)}\n`,
      'utf8',
    );

    await expect(store.rollback('scene-skill', 1)).rejects.toThrow(/schema/i);
    await expect(readJson<KnowledgeBaseStateSummary>(
      managedKnowledgePaths(appDataRoot, configured.knowledgeRootId).currentPath,
    )).resolves.toMatchObject({
      activeVersion: 2,
      status: 'active',
    });
  });

  it('rejects tampered public configuration metadata on read', async () => {
    const tempRoot = await createTempRoot(tempRoots);
    const appDataRoot = join(tempRoot, 'app-data');
    const store = new ManagedKnowledgeStore({ appDataRoot });
    await store.configure({
      knowledgeBaseId: 'scene-skill',
      displayName: 'Scene Skill',
      rootPath: join(tempRoot, 'workspace', 'scene-skill'),
    });

    const configPath = join(appDataRoot, 'knowledge', 'config.json');
    const config = await readJson<{
      readonly schemaVersion: 1;
      readonly configurations: Array<Record<string, unknown>>;
    }>(configPath);
    await writeFile(
      configPath,
      `${JSON.stringify({
        ...config,
        configurations: [{
          ...config.configurations[0],
          displayName: 'Authorization: Bearer secret',
        }],
      })}\n`,
      'utf8',
    );

    await expect(store.listStates()).rejects.toThrow(/protected/i);
  });

  it('rejects tampered public summary metadata on read', async () => {
    const tempRoot = await createTempRoot(tempRoots);
    const appDataRoot = join(tempRoot, 'app-data');
    const store = new ManagedKnowledgeStore({ appDataRoot });
    const configured = await store.configure({
      knowledgeBaseId: 'scene-skill',
      displayName: 'Scene Skill',
      rootPath: join(tempRoot, 'workspace', 'scene-skill'),
    });
    await store.publish(createSnapshot('# version 1', 1));

    const currentPath = managedKnowledgePaths(appDataRoot, configured.knowledgeRootId).currentPath;
    const summary = await readJson<KnowledgeBaseStateSummary>(currentPath);
    await writeFile(
      currentPath,
      `${JSON.stringify({
        ...summary,
        versions: summary.versions.map((version) => ({
          ...version,
          sourceDeviceId: 'github_pat_secret',
        })),
      })}\n`,
      'utf8',
    );

    await expect(store.listStates()).rejects.toThrow(/protected/i);
  });

  it('rejects tampered public failure reasons on read', async () => {
    const tempRoot = await createTempRoot(tempRoots);
    const appDataRoot = join(tempRoot, 'app-data');
    const store = new ManagedKnowledgeStore({ appDataRoot });
    const configured = await store.configure({
      knowledgeBaseId: 'scene-skill',
      displayName: 'Scene Skill',
      rootPath: join(tempRoot, 'workspace', 'scene-skill'),
    });

    const currentPath = managedKnowledgePaths(appDataRoot, configured.knowledgeRootId).currentPath;
    const summary = await readJson<KnowledgeBaseStateSummary>(currentPath);
    await writeFile(
      currentPath,
      `${JSON.stringify({
        ...summary,
        status: 'fallback',
        lastFailure: {
          failedAt: '2026-07-15T08:05:00.000Z',
          reason: 'Authorization: Bearer secret',
        },
      })}\n`,
      'utf8',
    );

    await expect(store.listStates()).rejects.toThrow(/protected/i);
  });
});

async function recordRefreshFailure(
  store: ManagedKnowledgeStore,
  knowledgeBaseId: string,
  reason: string,
  failedAt: string,
): Promise<KnowledgeBaseStateSummary> {
  const method = (store as unknown as {
    recordRefreshFailure?: (
      knowledgeBaseId: string,
      reason: string,
      failedAt: string,
    ) => Promise<KnowledgeBaseStateSummary>;
  }).recordRefreshFailure;
  expect(typeof method).toBe('function');
  return method!.call(store, knowledgeBaseId, reason, failedAt);
}
function createSnapshot(content: string, version: number): KnowledgeSnapshot {
  return createSnapshotFromDocuments([{ relativePath: 'memory/main.md', content }], version);
}

function createSnapshotFromDocuments(
  documents: Array<{ readonly relativePath: string; readonly content: string }>,
  version: number,
): KnowledgeSnapshot {
  const candidate = createKnowledgeSnapshotCandidate({
    knowledgeBaseId: 'scene-skill',
    displayName: 'Scene Skill',
    documents,
  });

  return {
    ...candidate,
    documents: documents.map((document) => ({
      ...document,
      sha256: candidate.documents.find((candidateDocument) => (
        candidateDocument.relativePath === document.relativePath
      ))!.sha256,
    })),
    version,
    publishedAt: `2026-07-15T08:0${version}:00.000Z`,
    sourceDeviceId: 'device-a',
  };
}

async function createTempRoot(tempRoots: string[]): Promise<string> {
  const tempRoot = await mkdtemp(join(tmpdir(), 'managed-knowledge-store-'));
  tempRoots.push(tempRoot);
  return tempRoot;
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

function managedKnowledgePaths(appDataRoot: string, knowledgeRootId: string) {
  const knowledgeRoot = join(appDataRoot, 'knowledge');
  const baseDir = join(knowledgeRoot, knowledgeRootId);
  return {
    baseDir,
    currentPath: join(baseDir, 'current.json'),
    knowledgeRoot,
    snapshotsDir: join(baseDir, 'snapshots'),
  };
}

function snapshotPath(
  appDataRoot: string,
  knowledgeRootId: string,
  snapshot: KnowledgeSnapshot,
): string {
  return join(
    managedKnowledgePaths(appDataRoot, knowledgeRootId).snapshotsDir,
    `v-${snapshot.version}-${snapshot.contentHash.slice(0, 12)}.json`,
  );
}

class DelegatingFileSystem implements FileSystem {
  protected readonly delegate: FileSystem;

  constructor(delegate: FileSystem = new NodeFileSystem()) {
    this.delegate = delegate;
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    await this.delegate.mkdir(path, options);
  }

  async open(path: string, flags: string): Promise<FileHandleLike> {
    return this.delegate.open(path, flags);
  }

  async readFile(path: string, encoding: BufferEncoding): Promise<string> {
    return this.delegate.readFile(path, encoding);
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    if (!this.delegate.readFileBuffer) {
      throw new Error('readFileBuffer unavailable');
    }
    return this.delegate.readFileBuffer(path);
  }

  async readdir(path: string): Promise<string[]> {
    return this.delegate.readdir(path);
  }

  async rename(source: string, destination: string): Promise<void> {
    await this.delegate.rename(source, destination);
  }

  async rm(path: string, options?: { force?: boolean; recursive?: boolean }): Promise<void> {
    await this.delegate.rm(path, options);
  }

  async stat(path: string) {
    return this.delegate.stat(path);
  }

  async lstat(path: string) {
    if (!this.delegate.lstat) {
      throw new Error('lstat unavailable');
    }
    return this.delegate.lstat(path);
  }

  async realpath(path: string): Promise<string> {
    if (!this.delegate.realpath) {
      throw new Error('realpath unavailable');
    }
    return this.delegate.realpath(path);
  }

  async truncate(path: string, length: number): Promise<void> {
    if (!this.delegate.truncate) {
      throw new Error('truncate unavailable');
    }
    await this.delegate.truncate(path, length);
  }

  async unlink(path: string): Promise<void> {
    await this.delegate.unlink(path);
  }

  async writeFile(path: string, data: string, encoding: BufferEncoding): Promise<void> {
    await this.delegate.writeFile(path, data, encoding);
  }
}

class FailCurrentMetadataFileSystem extends DelegatingFileSystem {
  private readonly knowledgeRootId: string;

  constructor(knowledgeRootId: string) {
    super();
    this.knowledgeRootId = knowledgeRootId;
  }

  override async rename(source: string, destination: string): Promise<void> {
    if (samePath(destination, join('knowledge', this.knowledgeRootId, 'current.json'))) {
      throw new Error('injected current metadata failure');
    }
    await super.rename(source, destination);
  }
}

function samePath(path: string, suffix: string): boolean {
  return normalize(path).toLowerCase().endsWith(normalize(suffix).toLowerCase());
}

interface DeferredVoid {
  readonly promise: Promise<void>;
  resolve(): void;
}

interface PauseGate {
  readonly entered: DeferredVoid;
  readonly release: DeferredVoid;
}

function createPauseGate(): PauseGate {
  return {
    entered: createDeferredVoid(),
    release: createDeferredVoid(),
  };
}

function createDeferredVoid(): DeferredVoid {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

class LockRealpathRaceFileSystem extends DelegatingFileSystem {
  injectedEpermCount = 0;
  private lockWasSeen = false;
  private readonly lockPath: string;
  private readonly releaseHolder: () => void;
  private readonly vanishBeforeEperm: boolean;

  constructor(options: {
    readonly lockPath: string;
    readonly releaseHolder: () => void;
    readonly vanishBeforeEperm: boolean;
  }) {
    super();
    this.lockPath = normalize(options.lockPath);
    this.releaseHolder = options.releaseHolder;
    this.vanishBeforeEperm = options.vanishBeforeEperm;
  }

  override async lstat(path: string) {
    const result = await super.lstat(path);
    if (sameExactPath(path, this.lockPath)) {
      this.lockWasSeen = true;
    }
    return result;
  }

  override async realpath(path: string): Promise<string> {
    if (
      this.injectedEpermCount === 0 &&
      this.lockWasSeen &&
      sameExactPath(path, this.lockPath)
    ) {
      this.injectedEpermCount += 1;
      this.releaseHolder();
      if (this.vanishBeforeEperm) {
        await waitForMissingFile(this.delegate, this.lockPath);
      }
      throw Object.assign(new Error('injected Windows lock realpath race'), { code: 'EPERM' });
    }
    return super.realpath(path);
  }
}

async function waitForMissingFile(fileSystem: FileSystem, path: string): Promise<void> {
  if (!fileSystem.lstat) {
    throw new Error('lstat unavailable');
  }
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await fileSystem.lstat(path);
    } catch (error) {
      if (isFileSystemErrorCode(error, 'ENOENT')) {
        return;
      }
      throw error;
    }
    await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 1));
  }
  throw new Error('Timed out waiting for lock deletion');
}

function isFileSystemErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
class PauseOnCurrentMetadataFileSystem extends DelegatingFileSystem {
  private pauseCount = 0;
  private readonly gate: PauseGate;
  private readonly knowledgeRootId: string;

  constructor(knowledgeRootId: string, gate: PauseGate) {
    super();
    this.gate = gate;
    this.knowledgeRootId = knowledgeRootId;
  }

  override async rename(source: string, destination: string): Promise<void> {
    if (
      this.pauseCount === 0 &&
      samePath(destination, join('knowledge', this.knowledgeRootId, 'current.json'))
    ) {
      this.pauseCount += 1;
      this.gate.entered.resolve();
      await this.gate.release.promise;
    }
    await super.rename(source, destination);
  }
}

class PauseOnConfigFileSystem extends DelegatingFileSystem {
  private pauseCount = 0;
  private readonly gate: PauseGate;

  constructor(gate: PauseGate) {
    super();
    this.gate = gate;
  }

  override async rename(source: string, destination: string): Promise<void> {
    if (
      this.pauseCount === 0 &&
      samePath(destination, join('knowledge', 'config.json'))
    ) {
      this.pauseCount += 1;
      this.gate.entered.resolve();
      await this.gate.release.promise;
    }
    await super.rename(source, destination);
  }
}

interface RedirectedManagedPath {
  readonly actualPath: string;
  readonly lexicalPath: string;
}

class RedirectedManagedPathFileSystem extends DelegatingFileSystem {
  private readonly redirects: readonly RedirectedManagedPath[];

  constructor(options: {
    readonly redirects: readonly RedirectedManagedPath[];
  }) {
    super();
    this.redirects = options.redirects
      .map((redirect) => ({
        actualPath: normalize(redirect.actualPath),
        lexicalPath: normalize(redirect.lexicalPath),
      }))
      .sort((left, right) => right.lexicalPath.length - left.lexicalPath.length);
  }

  override async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    await super.mkdir(this.mapPath(path), options);
  }

  override async open(path: string, flags: string): Promise<FileHandleLike> {
    return super.open(this.mapPath(path), flags);
  }

  override async readFile(path: string, encoding: BufferEncoding): Promise<string> {
    return super.readFile(this.mapPath(path), encoding);
  }

  override async readFileBuffer(path: string): Promise<Uint8Array> {
    return super.readFileBuffer(this.mapPath(path));
  }

  override async readdir(path: string): Promise<string[]> {
    return super.readdir(this.mapPath(path));
  }

  override async rename(source: string, destination: string): Promise<void> {
    await super.rename(this.mapPath(source), this.mapPath(destination));
  }

  override async rm(path: string, options?: { force?: boolean; recursive?: boolean }): Promise<void> {
    await super.rm(this.mapPath(path), options);
  }

  override async stat(path: string) {
    return super.stat(this.mapPath(path));
  }

  override async lstat(path: string) {
    const redirect = this.findRedirect(path);
    if (redirect && sameExactPath(path, redirect.lexicalPath)) {
      const stat = await super.stat(redirect.actualPath);
      return {
        ...stat,
        isSymbolicLink: () => true,
      };
    }
    return super.lstat(this.mapPath(path));
  }

  override async realpath(path: string): Promise<string> {
    const redirect = this.findRedirect(path);
    if (redirect) {
      const suffix = normalize(path).slice(redirect.lexicalPath.length);
      return `${redirect.actualPath}${suffix}`;
    }
    return super.realpath(path);
  }

  override async truncate(path: string, length: number): Promise<void> {
    await super.truncate(this.mapPath(path), length);
  }

  override async unlink(path: string): Promise<void> {
    await super.unlink(this.mapPath(path));
  }

  override async writeFile(path: string, data: string, encoding: BufferEncoding): Promise<void> {
    await super.writeFile(this.mapPath(path), data, encoding);
  }

  private mapPath(path: string): string {
    const redirect = this.findRedirect(path);
    if (!redirect) {
      return path;
    }
    const normalizedPath = normalize(path);
    return `${redirect.actualPath}${normalizedPath.slice(redirect.lexicalPath.length)}`;
  }

  private findRedirect(path: string): RedirectedManagedPath | null {
    const normalizedPath = normalize(path);
    for (const redirect of this.redirects) {
      if (
        sameExactPath(normalizedPath, redirect.lexicalPath) ||
        normalizedPath.startsWith(`${redirect.lexicalPath}\\`) ||
        normalizedPath.startsWith(`${redirect.lexicalPath}/`)
      ) {
        return redirect;
      }
    }
    return null;
  }
}

function sameExactPath(left: string, right: string): boolean {
  return normalize(left).toLowerCase() === normalize(right).toLowerCase();
}
