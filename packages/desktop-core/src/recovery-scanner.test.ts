import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
import { JournalWriter, resetJournalWriterRegistryForTests } from './journal-writer';
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
    expect(result.candidates[0]!.path).toContain(join('recovery', session.manifest.projectId, 'scan-session-auto'));
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

  it('falls back from a damaged newest snapshot when older snapshots and continuous journals verify', async () => {
    const created = await createProject(tempRoots, 'project-damaged-newest');
    await created.writer.commit(makeCreatePromptCommitRequest(created.session.manifest.projectId, 'tx-snapshot-1', 0, 'prompt-snapshot-1'));
    const scheduler = new SnapshotScheduler({ now: () => baseNow });
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
      action: 'auto_recover',
      recoveredRevision: 2,
      targetRevision: 2,
    });
    expect(result.issues).toContain('corrupt_snapshot');
    expect(result.candidates[0]!.project.nodes.map((node) => node.id)).toEqual([
      'prompt-snapshot-1',
      'prompt-after-damaged',
    ]);
  });

  it('requires a recovery choice when multiple verified candidates exist', async () => {
    const { appDataRoot, projectRoot, session, writer } = await createProject(tempRoots, 'project-multiple-candidates');
    await writer.commit(makeCreatePromptCommitRequest(session.manifest.projectId, 'tx-multiple-1', 0, 'prompt-multiple-1'));
    await new SnapshotScheduler({ now: () => baseNow }).flush(session, { reason: 'stable_point' });
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
  readonly revision: number;
  readonly snapshotId: string;
}): SnapshotEnvelope {
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    projectId: options.projectId,
    snapshotId: options.snapshotId,
    previousSnapshotId: null,
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
