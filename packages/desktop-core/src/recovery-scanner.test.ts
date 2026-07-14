import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';

import type { CanvasProject, ProjectTransaction } from '@agent-canvas/domain';
import { afterEach, describe, expect, it } from 'vitest';

import { canonicalJson, sha256Canonical } from './canonical-json';
import {
  PROJECT_FORMAT_VERSION,
  SNAPSHOT_SCHEMA_VERSION,
  type CommitRequest,
  type ProjectManifest,
  type SnapshotEnvelope,
} from './contracts';
import { NodeFileSystem, type FileHandleLike, type FileSystem } from './file-system';
import { JournalWriter, readValidJournal, resetJournalWriterRegistryForTests } from './journal-writer';
import { ProjectRepository } from './project-repository';
import { RecoveryScanner } from './recovery-scanner';
import { SnapshotScheduler } from './snapshot-scheduler';

const gzipAsync = promisify(gzip);
const baseNow = new Date('2026-07-14T12:00:00.000Z');

describe('RecoveryScanner', () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    resetJournalWriterRegistryForTests();
    await Promise.all(
      tempRoots.splice(0).map((tempRoot) => rm(tempRoot, { force: true, recursive: true })),
    );
  });

  it('auto-recovers one valid chain with a partial final line and mirrors the candidate to appData', async () => {
    const { appDataRoot, projectRoot, session, writer } = await createProject(tempRoots, 'project-auto-recover');
    await writer.commit(makeCreatePromptCommitRequest(session.manifest.projectId, 'tx-auto-1', 0, 'prompt-auto-1'));
    await writer.commit(makeCreatePromptCommitRequest(session.manifest.projectId, 'tx-auto-2', 1, 'prompt-auto-2'));
    const activeJournal = join(projectRoot, 'journal', 'active.ndjson');
    const originalActive = `${await readFile(activeJournal, 'utf8')}{"partial":`;
    await writeFile(activeJournal, originalActive, 'utf8');

    const scanner = new RecoveryScanner({ appDataRoot, createId: () => 'scan-session-auto', now: () => baseNow });
    const result = await scanner.scan(projectRoot);

    expect(result).toMatchObject({
      action: 'auto_recover',
      projectId: session.manifest.projectId,
      recoveredRevision: 2,
      targetRevision: 2,
    });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({
      revision: 2,
      tailStatus: 'partial_final_line',
    });
    await expect(stat(result.candidates[0]!.path)).resolves.toMatchObject({ size: expect.any(Number) });
    expect(await readFile(activeJournal, 'utf8')).toBe(originalActive);
    expect(resolve(result.candidates[0]!.path).startsWith(`${resolve(appDataRoot, 'recovery')}${sep}`)).toBe(true);
  });

  it('requires a choice for corruption before the tail and keeps damaged originals untouched', async () => {
    const { appDataRoot, projectRoot, session, writer } = await createProject(tempRoots, 'project-corrupt-middle');
    await writer.commit(makeCreatePromptCommitRequest(session.manifest.projectId, 'tx-corrupt-1', 0, 'prompt-corrupt-1'));
    const activeJournal = join(projectRoot, 'journal', 'active.ndjson');
    const damagedActive = `${await readFile(activeJournal, 'utf8')}not-json\n`;
    await writeFile(activeJournal, damagedActive, 'utf8');

    const result = await new RecoveryScanner({
      appDataRoot,
      createId: () => 'scan-session-corrupt',
      now: () => baseNow,
    }).scan(projectRoot);

    expect(result).toMatchObject({
      action: 'choose_recovery',
      projectId: session.manifest.projectId,
    });
    expect(result.issues).toContain('corrupt_journal_before_tail');
    expect(result.candidates.map((candidate) => candidate.revision)).toContain(0);
    expect(await readFile(activeJournal, 'utf8')).toBe(damagedActive);
  });

  it('requires a recovery choice when the manifest snapshot is damaged even if older snapshots can replay forward', async () => {
    const created = await createProject(tempRoots, 'project-damaged-newest');
    await created.writer.commit(makeCreatePromptCommitRequest(created.session.manifest.projectId, 'tx-snapshot-1', 0, 'prompt-snapshot-1'));
    const scheduler = new SnapshotScheduler({
      now: () => baseNow,
      worker: (input) => SnapshotScheduler.defaultWorker(input),
    });
    await scheduler.flush(created.session, { reason: 'stable_point' });

    const manifest = await readJson<ProjectManifest>(join(created.projectRoot, 'project.novus.json'));
    await writeFile(join(created.projectRoot, ...manifest.stableSnapshotPath!.split('/')), Buffer.from('not gzip'));
    const freshWriter = await JournalWriter.open({
      activeJournalPath: join(created.projectRoot, 'journal', 'active.ndjson'),
      baseRevision: 1,
      nextSequence: 2,
      projectId: created.session.manifest.projectId,
      now: () => baseNow,
    });
    await freshWriter.commit(makeCreatePromptCommitRequest(created.session.manifest.projectId, 'tx-after-damaged-snapshot', 1, 'prompt-after-damaged'));

    const result = await new RecoveryScanner({
      appDataRoot: created.appDataRoot,
      createId: () => 'scan-session-damaged-snapshot',
      now: () => baseNow,
    }).scan(created.projectRoot);

    expect(result).toMatchObject({
      action: 'choose_recovery',
      recoveredRevision: 2,
      targetRevision: 2,
    });
    expect(result.issues).toContain('corrupt_snapshot');
    expect(result.candidates[0]!.project.nodes.map((node) => node.id)).toEqual([
      'prompt-snapshot-1',
      'prompt-after-damaged',
    ]);
  });

  it('requires a recovery choice when a newer snapshot artifact is corrupt even though the manifest chain still validates', async () => {
    const created = await createProject(tempRoots, 'project-corrupt-newer');
    await created.writer.commit(makeCreatePromptCommitRequest(created.session.manifest.projectId, 'tx-corrupt-newer-1', 0, 'prompt-corrupt-newer-1'));
    const scheduler = new SnapshotScheduler({
      now: () => baseNow,
      worker: (input) => SnapshotScheduler.defaultWorker(input),
    });
    await scheduler.flush(created.session, { reason: 'stable_point' });

    await writeFile(
      join(created.projectRoot, 'snapshots', 's-2-corrupt-newer.json.gz'),
      Buffer.from('not a readable snapshot'),
    );

    const result = await new RecoveryScanner({
      appDataRoot: created.appDataRoot,
      createId: () => 'scan-session-corrupt-newer',
      now: () => baseNow,
    }).scan(created.projectRoot);

    expect(result.action).toBe('choose_recovery');
    expect(result.issues).toContain('corrupt_snapshot');
    expect(result.candidates.map((candidate) => candidate.revision)).toEqual([1]);
  });

  it('requires a recovery choice when a valid newest snapshot breaks the previousSnapshotId chain', async () => {
    const { appDataRoot, projectRoot, session } = await createProject(tempRoots, 'project-broken-chain');
    const brokenChainSnapshot = makeSnapshotEnvelope({
      project: {
        ...makeProject(session.manifest.projectId),
        nodes: [makePromptNode('prompt-broken-chain')],
      },
      projectId: session.manifest.projectId,
      revision: 1,
      snapshotId: 'snapshot-broken-chain',
      previousSnapshotId: 'missing-previous-snapshot',
    });
    await writeFile(
      join(projectRoot, 'snapshots', 's-1-broken-chain.json.gz'),
      await gzipAsync(`${canonicalJson(brokenChainSnapshot)}\n`),
    );

    const result = await new RecoveryScanner({
      appDataRoot,
      createId: () => 'scan-session-broken-chain',
      now: () => baseNow,
    }).scan(projectRoot);

    expect(result.action).toBe('choose_recovery');
    expect(result.issues).toContain('broken_snapshot_chain');
    expect(result.candidates.map((candidate) => candidate.revision)).toContain(1);
  });

  it('requires a recovery choice for stray snapshots outside the manifest snapshot chain', async () => {
    const { appDataRoot, projectRoot, session } = await createProject(tempRoots, 'project-stray-snapshot');
    const straySnapshot = makeSnapshotEnvelope({
      project: {
        ...makeProject(session.manifest.projectId),
        nodes: [makePromptNode('prompt-stray')],
      },
      projectId: session.manifest.projectId,
      revision: 1,
      snapshotId: 'snapshot-stray',
      previousSnapshotId: null,
    });
    await writeFile(
      join(projectRoot, 'snapshots', 's-1-stray.json.gz'),
      await gzipAsync(`${canonicalJson(straySnapshot)}\n`),
    );

    const result = await new RecoveryScanner({
      appDataRoot,
      createId: () => 'scan-session-stray',
      now: () => baseNow,
    }).scan(projectRoot);

    expect(result.action).toBe('choose_recovery');
    expect(result.issues).toContain('stray_snapshot');
    expect(result.candidates.map((candidate) => candidate.snapshotId)).toContain('snapshot-stray');
  });

  it('requires a recovery choice when an archive segment overlaps the stable snapshot and extends beyond it', async () => {
    const { appDataRoot, projectRoot, session, writer } = await createProject(tempRoots, 'project-overlap-archive');
    await writer.commit(makeCreatePromptCommitRequest(session.manifest.projectId, 'tx-overlap-1', 0, 'prompt-overlap-1'));
    await writer.commit(makeCreatePromptCommitRequest(session.manifest.projectId, 'tx-overlap-2', 1, 'prompt-overlap-2'));
    await new SnapshotScheduler({
      now: () => baseNow,
      worker: (input) => SnapshotScheduler.defaultWorker(input),
    }).flush(session, { reason: 'stable_point' });
    const archiveRoot = join(projectRoot, 'journal', 'archive');
    const [archiveName] = await readdir(archiveRoot);
    const archivedRecords = (await readValidJournal(join(archiveRoot, archiveName!), {
      baseRevision: 0,
      expectedProjectId: session.manifest.projectId,
      firstSequence: 1,
    })).records;
    const postSnapshotWriter = await JournalWriter.open({
      activeJournalPath: join(projectRoot, 'journal', 'active.ndjson'),
      baseRevision: 2,
      nextSequence: 3,
      projectId: session.manifest.projectId,
      now: () => baseNow,
    });
    await postSnapshotWriter.commit(makeCreatePromptCommitRequest(
      session.manifest.projectId,
      'tx-overlap-3',
      2,
      'prompt-overlap-3',
    ));
    const activeRecords = (await readValidJournal(join(projectRoot, 'journal', 'active.ndjson'), {
      baseRevision: 2,
      expectedProjectId: session.manifest.projectId,
      firstSequence: 3,
    })).records;
    await writeFile(
      join(archiveRoot, 'j-2-3-overlap.ndjson'),
      `${canonicalJson(archivedRecords[1])}\n${canonicalJson(activeRecords[0])}\n`,
      'utf8',
    );

    const result = await new RecoveryScanner({
      appDataRoot,
      createId: () => 'scan-session-overlap',
      now: () => baseNow,
    }).scan(projectRoot);

    expect(result.action).toBe('choose_recovery');
    expect(result.issues).toContain('journal_archive_overlap');
  });

  it('sanitizes and hashes recovery mirror path components while keeping candidate filenames unique', async () => {
    const tempRoot = await createTempRoot(tempRoots);
    const appDataRoot = join(tempRoot, 'app-data');
    const projectRoot = join(tempRoot, 'UnsafeMirrorPath.novus-project');
    const projectId = '../project:unsafe/session';
    const repository = createRepository({ processId: 7101 });
    const session = await repository.create(projectRoot, {
      project: makeProject(projectId),
      projectId,
      projectName: 'UnsafeMirrorPath',
    });

    for (const [snapshotId, nodeId] of [
      ['../snapshot-one', 'prompt-unsafe-one'],
      ['../snapshot-two', 'prompt-unsafe-two'],
    ] as const) {
      const snapshot = makeSnapshotEnvelope({
        project: {
          ...makeProject(projectId),
          nodes: [makePromptNode(nodeId)],
        },
        projectId,
        revision: 1,
        snapshotId,
        previousSnapshotId: session.manifest.stableSnapshotId,
      });
      await writeFile(
        join(projectRoot, 'snapshots', `${nodeId}.json.gz`),
        await gzipAsync(`${canonicalJson(snapshot)}\n`),
      );
    }

    const result = await new RecoveryScanner({
      appDataRoot,
      createId: () => '../scan:unsafe/session',
      now: () => baseNow,
    }).scan(projectRoot);
    const recoveryRoot = `${resolve(appDataRoot, 'recovery')}${sep}`;
    const candidatePaths = result.candidates.map((candidate) => candidate.path);
    const candidateNames = candidatePaths.map((candidatePath) => basename(candidatePath));

    expect(result.action).toBe('choose_recovery');
    expect(candidatePaths.every((candidatePath) => resolve(candidatePath).startsWith(recoveryRoot))).toBe(true);
    expect(candidatePaths.some((candidatePath) => candidatePath.includes('..'))).toBe(false);
    expect(new Set(candidateNames).size).toBe(candidateNames.length);
  });

  it('returns read-only when recovery candidate mirrors cannot be written', async () => {
    const { appDataRoot, projectRoot, session, writer } = await createProject(tempRoots, 'project-mirror-failure');
    await writer.commit(makeCreatePromptCommitRequest(session.manifest.projectId, 'tx-mirror-failure', 0, 'prompt-mirror-failure'));

    const result = await new RecoveryScanner({
      appDataRoot,
      createId: () => 'scan-session-mirror-failure',
      fileSystem: new FailRecoveryMirrorFileSystem(appDataRoot),
      now: () => baseNow,
    }).scan(projectRoot);

    expect(result).toMatchObject({
      action: 'read_only',
      projectId: session.manifest.projectId,
      recoveredRevision: null,
      targetRevision: null,
    });
    expect(result.issues).toContain('recovery_mirror_write_failed');
  });

  it('requires a recovery choice when multiple verified candidates exist', async () => {
    const { appDataRoot, projectRoot, session, writer } = await createProject(tempRoots, 'project-multiple-candidates');
    await writer.commit(makeCreatePromptCommitRequest(session.manifest.projectId, 'tx-multiple-1', 0, 'prompt-multiple-1'));
    await new SnapshotScheduler({
      now: () => baseNow,
      worker: (input) => SnapshotScheduler.defaultWorker(input),
    }).flush(session, { reason: 'stable_point' });
    const manifest = await readJson<ProjectManifest>(join(projectRoot, 'project.novus.json'));
    const alternate = makeSnapshotEnvelope({
      project: {
        ...makeProject(session.manifest.projectId),
        nodes: [makePromptNode('prompt-alternate')],
      },
      projectId: session.manifest.projectId,
      revision: 1,
      snapshotId: 'alternate-snapshot',
    });
    await writeFile(
      join(projectRoot, 'snapshots', 's-1-alternate.json.gz'),
      await gzipAsync(`${canonicalJson(alternate)}\n`),
    );

    const result = await new RecoveryScanner({
      appDataRoot,
      createId: () => 'scan-session-multiple',
      now: () => baseNow,
    }).scan(projectRoot);

    expect(manifest.stableSnapshotRevision).toBe(1);
    expect(result.action).toBe('choose_recovery');
    expect(result.issues).toContain('multiple_recovery_candidates');
    expect(result.candidates.filter((candidate) => candidate.revision === 1)).toHaveLength(2);
  });

  it('returns unsupported_version without writing candidates for future writer formats', async () => {
    const { appDataRoot, projectRoot, session } = await createProject(tempRoots, 'project-unsupported');
    const manifestPath = join(projectRoot, 'project.novus.json');
    const manifest = await readJson<ProjectManifest>(manifestPath);
    await writeFile(manifestPath, `${canonicalJson({
      ...manifest,
      minimumCompatibleWriterVersion: PROJECT_FORMAT_VERSION + 1,
    })}\n`, 'utf8');

    const result = await new RecoveryScanner({
      appDataRoot,
      createId: () => 'scan-session-unsupported',
      now: () => baseNow,
    }).scan(projectRoot);

    expect(result).toMatchObject({
      action: 'unsupported_version',
      projectId: session.manifest.projectId,
      targetRevision: null,
    });
    await expect(stat(join(appDataRoot, 'recovery', session.manifest.projectId))).rejects.toThrow();
  });

  it('fails closed on an abandoned lock guard and leaves it for recovery choice', async () => {
    const { appDataRoot, projectRoot, session, writer } = await createProject(tempRoots, 'project-abandoned-guard');
    await writer.commit(makeCreatePromptCommitRequest(session.manifest.projectId, 'tx-guard-1', 0, 'prompt-guard-1'));
    const guardPath = join(projectRoot, 'recovery', 'project.lock.guard');
    await writeFile(guardPath, `${canonicalJson({
      schemaVersion: 1,
      token: 'abandoned',
      processId: 99999,
      createdAt: baseNow.toISOString(),
    })}\n`, 'utf8');

    const result = await new RecoveryScanner({
      appDataRoot,
      createId: () => 'scan-session-guard',
      now: () => baseNow,
    }).scan(projectRoot);

    expect(result.action).toBe('choose_recovery');
    expect(result.issues).toContain('abandoned_lock_guard');
    await expect(stat(guardPath)).resolves.toMatchObject({ size: expect.any(Number) });
  });
});

async function createProject(tempRoots: string[], projectId: string) {
  const tempRoot = await createTempRoot(tempRoots);
  const appDataRoot = join(tempRoot, 'app-data');
  const projectRoot = join(tempRoot, `${projectId}.novus-project`);
  const repository = createRepository();
  const project = makeProject(projectId);
  const session = await repository.create(projectRoot, {
    project,
    projectId,
    projectName: projectId,
  });
  const writer = await repository.openJournalWriter(session, { now: () => baseNow });

  return { appDataRoot, project, projectRoot, repository, session, writer };
}

function createRepository(overrides: Partial<ConstructorParameters<typeof ProjectRepository>[0]> = {}) {
  let idCounter = 0;

  return new ProjectRepository({
    channel: 'modern',
    createId: () => `generated-${++idCounter}`,
    deviceId: 'device-under-test',
    now: () => baseNow,
    processId: 5101,
    ...overrides,
  });
}

async function createTempRoot(tempRoots: string[]) {
  const tempRoot = await mkdtemp(join(tmpdir(), 'desktop-core-recovery-scanner-'));
  tempRoots.push(tempRoot);
  return tempRoot;
}

function makeProject(projectId: string): CanvasProject {
  return {
    version: 1,
    id: projectId,
    name: projectId,
    nodes: [],
    edges: [],
    projectMemory: [],
    skillPromotionCandidates: [],
  };
}

function makeSnapshotEnvelope(options: {
  readonly project: CanvasProject;
  readonly projectId: string;
  readonly previousSnapshotId?: string | null;
  readonly revision: number;
  readonly snapshotId: string;
}): SnapshotEnvelope {
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    projectId: options.projectId,
    snapshotId: options.snapshotId,
    previousSnapshotId: options.previousSnapshotId ?? null,
    revision: options.revision,
    createdAt: baseNow.toISOString(),
    project: options.project,
    projectSha256: sha256Canonical(options.project),
  };
}

function makeCreatePromptCommitRequest(
  projectId: string,
  transactionId: string,
  baseRevision: number,
  nodeId: string,
): CommitRequest {
  return {
    projectId,
    baseRevision,
    kind: 'canvas',
    transaction: makeCreatePromptTransaction(transactionId, nodeId),
  };
}

function makeCreatePromptTransaction(transactionId: string, nodeId: string): ProjectTransaction {
  return {
    id: transactionId,
    label: `create ${nodeId}`,
    operations: [{ kind: 'canvas', operation: { kind: 'create_node', node: makePromptNode(nodeId) } }],
  };
}

function makePromptNode(id: string) {
  return {
    id,
    type: 'prompt' as const,
    position: { x: 0, y: 0 },
    data: { prompt: `Prompt ${id}`, requirementIds: [] },
  };
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

class FailRecoveryMirrorFileSystem implements FileSystem {
  private readonly appDataRoot: string;
  private readonly delegate = new NodeFileSystem();

  constructor(appDataRoot: string) {
    this.appDataRoot = resolve(appDataRoot);
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    await this.delegate.mkdir(path, options);
  }

  async open(path: string, flags: string): Promise<FileHandleLike> {
    if (resolve(path).startsWith(`${this.appDataRoot}${sep}`) && flags === 'wx') {
      throw new Error('injected recovery mirror write failure');
    }
    return this.delegate.open(path, flags);
  }

  async readFile(path: string, encoding: BufferEncoding): Promise<string> {
    return this.delegate.readFile(path, encoding);
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
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

  async stat(path: string): Promise<{ isDirectory(): boolean; isFile(): boolean; readonly size?: number }> {
    return this.delegate.stat(path);
  }

  async truncate(path: string, length: number): Promise<void> {
    await this.delegate.truncate(path, length);
  }

  async unlink(path: string): Promise<void> {
    await this.delegate.unlink(path);
  }

  async writeFile(path: string, data: string, encoding: BufferEncoding): Promise<void> {
    await this.delegate.writeFile(path, data, encoding);
  }
}
