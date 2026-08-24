import { createHash } from 'node:crypto';
import { join, resolve, sep } from 'node:path';

import { parseCanvasProject, type CanvasProject } from '@agent-canvas/domain';

import { canonicalJson, sha256Canonical } from './canonical-json.js';
import {
  PROJECT_FORMAT_VERSION,
  type ProjectManifest,
  type RecoveryAction,
  type RecoveryPlan,
  type SnapshotEnvelope,
} from './contracts.js';
import { type FileSystem, NodeFileSystem, writeAtomic } from './file-system.js';
import { readValidJournal, replayJournal } from './journal-writer.js';
import {
  isValidSnapshotEnvelope,
  readSnapshotEnvelope,
} from './snapshot-scheduler.js';

export interface RecoveryCandidate {
  readonly path: string;
  readonly project: CanvasProject;
  readonly revision: number;
  readonly snapshotId: string;
  readonly tailStatus: 'complete' | 'partial_final_line';
}

export interface RecoveryScanResult extends RecoveryPlan {
  readonly action: RecoveryAction;
  readonly candidates: readonly RecoveryCandidate[];
  readonly recoveredRevision: number | null;
}

export interface OrphanRecoveryCandidate extends RecoveryCandidate {
  readonly createdAt: string;
  readonly projectId: string;
}

export interface RecoveryScannerOptions {
  readonly appDataRoot: string;
  readonly createId?: () => string;
  readonly fileSystem?: FileSystem;
  readonly now?: () => Date;
}

interface SnapshotCandidate {
  readonly envelope: SnapshotEnvelope;
  readonly sourcePath: string;
}

interface JournalSegment {
  readonly final: boolean;
  readonly firstSequence: number | null;
  readonly lastSequence: number | null;
  readonly path: string;
}

class RecoveryMirrorWriteFailure extends Error {}

const ACTIVE_JOURNAL_SEGMENT = 'journal/active.ndjson';
const LOCK_GUARD_SEGMENT = 'recovery/project.lock.guard';
const MANIFEST_PATH = 'project.novus.json';

export class RecoveryScanner {
  private readonly appDataRoot: string;
  private readonly createId: () => string;
  private readonly fileSystem: FileSystem;
  private readonly now: () => Date;

  constructor(options: RecoveryScannerOptions) {
    this.appDataRoot = options.appDataRoot;
    this.createId = options.createId ?? (() => `scan-${Date.now()}`);
    this.fileSystem = options.fileSystem ?? new NodeFileSystem();
    this.now = options.now ?? (() => new Date());
  }

  async discoverLatestOrphanCandidate(): Promise<OrphanRecoveryCandidate | null> {
    const recoveryBase = resolve(this.appDataRoot, 'recovery');
    const candidates: OrphanRecoveryCandidate[] = [];
    for (const projectDirectory of await this.readDirectoryNames(recoveryBase)) {
      if (!projectDirectory.startsWith('project-')) continue;
      const projectRecoveryRoot = confinedJoin(recoveryBase, projectDirectory);
      for (const sessionDirectory of await this.readDirectoryNames(projectRecoveryRoot)) {
        if (!sessionDirectory.startsWith('session-')) continue;
        const sessionRoot = confinedJoin(projectRecoveryRoot, sessionDirectory);
        for (const candidateName of await this.readDirectoryNames(sessionRoot)) {
          if (!candidateName.startsWith('candidate-') || !candidateName.endsWith('.json')) continue;
          const candidatePath = confinedJoin(sessionRoot, candidateName);
          try {
            const record = JSON.parse(await this.fileSystem.readFile(candidatePath, 'utf8')) as unknown;
            const candidate = parseOrphanRecoveryMirror(record, candidatePath);
            const managedRoot = confinedJoin(
              resolve(this.appDataRoot, 'projects'),
              `${candidate.projectId}.novus-project`,
            );
            if (await this.exists(managedRoot)) continue;
            candidates.push(candidate);
          } catch {
            // Malformed, escaped, or incompatible mirrors are ignored without mutating recovery data.
          }
        }
      }
    }
    const latestByProject = new Map<string, OrphanRecoveryCandidate>();
    for (const candidate of candidates) {
      const current = latestByProject.get(candidate.projectId);
      if (
        current === undefined
        || candidate.revision > current.revision
        || (
          candidate.revision === current.revision
          && (
            Date.parse(candidate.createdAt) > Date.parse(current.createdAt)
            || (
              candidate.createdAt === current.createdAt
              && candidate.path.localeCompare(current.path) < 0
            )
          )
        )
      ) {
        latestByProject.set(candidate.projectId, candidate);
      }
    }
    const projectCandidates = [...latestByProject.values()].sort((left, right) => (
      Date.parse(right.createdAt) - Date.parse(left.createdAt)
      || right.revision - left.revision
      || left.projectId.localeCompare(right.projectId)
    ));
    return projectCandidates[0] ?? null;
  }

  async scan(projectRoot: string): Promise<RecoveryScanResult> {
    const manifest = await this.readManifest(projectRoot);
    if (
      manifest.formatVersion > PROJECT_FORMAT_VERSION ||
      manifest.minimumCompatibleWriterVersion > PROJECT_FORMAT_VERSION
    ) {
      return this.emptyResult('unsupported_version', manifest, ['unsupported_version']);
    }

    const issues: string[] = [];
    if (await this.exists(join(projectRoot, ...LOCK_GUARD_SEGMENT.split('/')))) {
      issues.push('abandoned_lock_guard');
    }

    const snapshots = await this.readSnapshots(projectRoot, manifest, issues);
    const journals = await this.listJournalSegments(projectRoot, issues);
    const candidates: RecoveryCandidate[] = [];
    const sessionId = this.createId();

    for (const snapshot of snapshots) {
      let candidate: RecoveryCandidate | null;
      try {
        candidate = await this.tryBuildCandidate(
          projectRoot,
          manifest,
          snapshot,
          journals,
          issues,
          sessionId,
        );
      } catch (error) {
        if (error instanceof RecoveryMirrorWriteFailure) {
          return this.emptyResult('read_only', manifest, [
            ...issues,
            'recovery_mirror_write_failed',
          ]);
        }

        throw error;
      }
      if (candidate !== null) {
        pushCandidate(candidates, candidate);
      }
    }

    const bestRevision = candidates.reduce(
      (revision, candidate) => Math.max(revision, candidate.revision),
      -1,
    );
    const bestCandidates = candidates.filter((candidate) => candidate.revision === bestRevision);
    if (bestCandidates.length > 1) {
      pushUnique(issues, 'multiple_recovery_candidates');
    }

    const action: RecoveryAction = issues.includes('abandoned_lock_guard') ||
      issues.includes('broken_snapshot_chain') ||
      issues.includes('corrupt_snapshot') ||
      issues.includes('corrupt_journal_before_tail') ||
      issues.includes('journal_archive_gap') ||
      issues.includes('journal_archive_overlap') ||
      issues.includes('manifest_snapshot_unavailable') ||
      issues.includes('stray_snapshot') ||
      bestCandidates.length !== 1
      ? 'choose_recovery'
      : 'auto_recover';

    return {
      action,
      candidates,
      issues,
      projectId: manifest.projectId,
      recoveredRevision: bestCandidates[0]?.revision ?? null,
      stableSnapshotId: bestCandidates[0]?.snapshotId ?? null,
      targetRevision: bestCandidates[0]?.revision ?? null,
    };
  }

  private async tryBuildCandidate(
    projectRoot: string,
    manifest: ProjectManifest,
    snapshot: SnapshotCandidate,
    journals: readonly JournalSegment[],
    issues: string[],
    sessionId: string,
  ): Promise<RecoveryCandidate | null> {
    let project: CanvasProject;
    try {
      project = parseCanvasProject(snapshot.envelope.project);
    } catch {
      pushUnique(issues, 'corrupt_snapshot');
      return null;
    }

    let revision = snapshot.envelope.revision;
    let tailStatus: 'complete' | 'partial_final_line' = 'complete';

    for (const journal of journals) {
      if (
        journal.firstSequence !== null &&
        journal.lastSequence !== null &&
        journal.firstSequence <= revision &&
        journal.lastSequence > revision
      ) {
        pushUnique(issues, 'journal_archive_overlap');
        return null;
      }

      if (journal.lastSequence !== null && journal.lastSequence <= revision) {
        continue;
      }

      if (journal.firstSequence !== null && journal.firstSequence !== revision + 1) {
        pushUnique(issues, journal.firstSequence > revision + 1
          ? 'journal_archive_gap'
          : 'journal_archive_overlap');
        return null;
      }

      try {
        const read = await readValidJournal(journal.path, {
          baseRevision: revision,
          committedOnly: journal.final,
          expectedProjectId: manifest.projectId,
          fileSystem: this.fileSystem,
          firstSequence: revision + 1,
        });
        if (read.tailStatus === 'partial_final_line' && !journal.final) {
          pushUnique(issues, 'corrupt_journal_before_tail');
          return null;
        }
        if (read.records.length > 0) {
          const replayed = replayJournal(project, revision, read.records);
          project = replayed.project;
          revision = replayed.revision;
        }
        if (journal.final) {
          tailStatus = read.tailStatus;
        }
      } catch {
        pushUnique(issues, 'corrupt_journal_before_tail');
        break;
      }
    }

    let mirrorPath: string;
    try {
      mirrorPath = await this.writeCandidateMirror(
        manifest.projectId,
        sessionId,
        revision,
        project,
        snapshot.envelope.snapshotId,
      );
    } catch (error) {
      throw new RecoveryMirrorWriteFailure(
        error instanceof Error ? error.message : String(error),
      );
    }
    return {
      path: mirrorPath,
      project,
      revision,
      snapshotId: snapshot.envelope.snapshotId,
      tailStatus,
    };
  }

  private async writeCandidateMirror(
    projectId: string,
    sessionId: string,
    revision: number,
    project: CanvasProject,
    snapshotId: string,
  ): Promise<string> {
    const recoveryBase = resolve(this.appDataRoot, 'recovery');
    const recoveryRoot = confinedJoin(
      recoveryBase,
      safePathComponent('project', projectId),
      safePathComponent('session', sessionId),
    );
    await this.fileSystem.mkdir(recoveryRoot, { recursive: true });
    const candidatePath = confinedJoin(
      recoveryRoot,
      `${safePathComponent(
        'candidate',
        `${revision}-${snapshotId}-${sha256Canonical(project)}`,
      )}.json`,
    );
    await writeAtomic(this.fileSystem, candidatePath, `${canonicalJson({
      createdAt: this.now().toISOString(),
      project,
      projectId,
      revision,
      snapshotId,
    })}\n`);
    return candidatePath;
  }

  private async readSnapshots(
    projectRoot: string,
    manifest: ProjectManifest,
    issues: string[],
  ): Promise<SnapshotCandidate[]> {
    const names = await this.fileSystem.readdir(join(projectRoot, 'snapshots'));
    const snapshots: SnapshotCandidate[] = [];

    for (const name of names) {
      if (!name.endsWith('.json') && !name.endsWith('.json.gz')) {
        continue;
      }

      const sourcePath = join(projectRoot, 'snapshots', name);
      try {
        const envelope = await readSnapshotEnvelope(sourcePath, this.fileSystem);
        if (!isValidSnapshotEnvelope(envelope, manifest.projectId)) {
          pushUnique(issues, 'corrupt_snapshot');
          continue;
        }
        snapshots.push({ envelope, sourcePath });
      } catch {
        pushUnique(issues, 'corrupt_snapshot');
      }
    }

    this.validateSnapshotGraph(snapshots, manifest, issues);
    snapshots.sort((left, right) => right.envelope.revision - left.envelope.revision);
    return snapshots;
  }

  private validateSnapshotGraph(
    snapshots: readonly SnapshotCandidate[],
    manifest: ProjectManifest,
    issues: string[],
  ): void {
    const byId = new Map<string, SnapshotCandidate>();
    for (const snapshot of snapshots) {
      if (byId.has(snapshot.envelope.snapshotId)) {
        pushUnique(issues, 'multiple_recovery_candidates');
      }
      byId.set(snapshot.envelope.snapshotId, snapshot);
    }

    for (const snapshot of snapshots) {
      const previousSnapshotId = snapshot.envelope.previousSnapshotId;
      if (previousSnapshotId !== null && !byId.has(previousSnapshotId)) {
        pushUnique(issues, 'broken_snapshot_chain');
      }
    }

    if (manifest.stableSnapshotId === null) {
      pushUnique(issues, 'manifest_snapshot_unavailable');
      return;
    }

    const manifestSnapshot = byId.get(manifest.stableSnapshotId);
    if (
      manifestSnapshot === undefined ||
      manifestSnapshot.envelope.revision !== manifest.stableSnapshotRevision
    ) {
      pushUnique(issues, 'manifest_snapshot_unavailable');
    }

    const manifestChainIds = new Set<string>();
    let current = manifestSnapshot;
    while (current !== undefined) {
      const snapshotId = current.envelope.snapshotId;
      if (manifestChainIds.has(snapshotId)) {
        pushUnique(issues, 'broken_snapshot_chain');
        break;
      }

      manifestChainIds.add(snapshotId);
      const previousSnapshotId = current.envelope.previousSnapshotId;
      if (previousSnapshotId === null) {
        break;
      }
      current = byId.get(previousSnapshotId);
      if (current === undefined) {
        pushUnique(issues, 'broken_snapshot_chain');
      }
    }

    for (const snapshot of snapshots) {
      if (!manifestChainIds.has(snapshot.envelope.snapshotId)) {
        pushUnique(issues, 'stray_snapshot');
      }
    }
  }

  private async listJournalSegments(projectRoot: string, issues: string[]): Promise<JournalSegment[]> {
    const archiveRoot = join(projectRoot, 'journal', 'archive');
    let archiveNames: string[] = [];
    try {
      archiveNames = await this.fileSystem.readdir(archiveRoot);
    } catch {
      archiveNames = [];
    }

    const archiveSegments = archiveNames
      .filter((name) => name.endsWith('.ndjson'))
      .map((name): JournalSegment => ({
        final: false,
        firstSequence: archiveRangeFromName(name)?.firstSequence ?? null,
        lastSequence: archiveRangeFromName(name)?.lastSequence ?? null,
        path: join(archiveRoot, name),
      }))
      .sort((left, right) => (left.firstSequence ?? Number.MAX_SAFE_INTEGER) - (right.firstSequence ?? Number.MAX_SAFE_INTEGER));

    validateArchiveContinuity(archiveSegments, issues);

    return [
      ...archiveSegments,
      {
        final: true,
        path: join(projectRoot, ...ACTIVE_JOURNAL_SEGMENT.split('/')),
        firstSequence: null,
        lastSequence: null,
      },
    ];
  }

  private async readManifest(root: string): Promise<ProjectManifest> {
    return JSON.parse(await this.fileSystem.readFile(join(root, MANIFEST_PATH), 'utf8')) as ProjectManifest;
  }

  private emptyResult(
    action: RecoveryAction,
    manifest: ProjectManifest,
    issues: readonly string[],
  ): RecoveryScanResult {
    return {
      action,
      candidates: [],
      issues,
      projectId: manifest.projectId,
      recoveredRevision: null,
      stableSnapshotId: null,
      targetRevision: null,
    };
  }

  private async exists(path: string): Promise<boolean> {
    try {
      await this.fileSystem.stat(path);
      return true;
    } catch {
      return false;
    }
  }

  private async readDirectoryNames(path: string): Promise<string[]> {
    try {
      return await this.fileSystem.readdir(path);
    } catch {
      return [];
    }
  }
}

function parseOrphanRecoveryMirror(value: unknown, path: string): OrphanRecoveryCandidate {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Recovery mirror is invalid');
  }
  const record = value as Record<string, unknown>;
  const createdAt = record.createdAt;
  const projectId = record.projectId;
  const revision = record.revision;
  const snapshotId = record.snapshotId;
  if (
    typeof createdAt !== 'string'
    || !Number.isFinite(Date.parse(createdAt))
    || typeof projectId !== 'string'
    || projectId.length === 0
    || /[\\/]/u.test(projectId)
    || typeof revision !== 'number'
    || !Number.isSafeInteger(revision)
    || revision < 0
    || typeof snapshotId !== 'string'
    || snapshotId.length === 0
  ) {
    throw new Error('Recovery mirror metadata is invalid');
  }
  const project = parseCanvasProject(record.project);
  if (project.id !== projectId) throw new Error('Recovery mirror project identity is invalid');
  return {
    createdAt,
    path,
    project,
    projectId,
    revision,
    snapshotId,
    tailStatus: 'complete',
  };
}

function archiveRangeFromName(name: string): { firstSequence: number; lastSequence: number } | null {
  const match = /^j-(\d+)-(\d+)-/.exec(name);
  if (match === null) {
    return null;
  }
  const firstSequence = Number.parseInt(match[1]!, 10);
  const lastSequence = Number.parseInt(match[2]!, 10);
  if (
    !Number.isSafeInteger(firstSequence) ||
    !Number.isSafeInteger(lastSequence) ||
    firstSequence <= 0 ||
    lastSequence < firstSequence
  ) {
    return null;
  }
  return { firstSequence, lastSequence };
}

function validateArchiveContinuity(
  archiveSegments: readonly JournalSegment[],
  issues: string[],
): void {
  let previousLastSequence: number | null = null;

  for (const segment of archiveSegments) {
    if (segment.firstSequence === null || segment.lastSequence === null) {
      pushUnique(issues, 'journal_archive_gap');
      continue;
    }

    if (previousLastSequence !== null) {
      if (segment.firstSequence <= previousLastSequence) {
        pushUnique(issues, 'journal_archive_overlap');
      } else if (segment.firstSequence !== previousLastSequence + 1) {
        pushUnique(issues, 'journal_archive_gap');
      }
    }

    previousLastSequence = Math.max(previousLastSequence ?? 0, segment.lastSequence);
  }
}

function confinedJoin(base: string, ...segments: string[]): string {
  const resolvedBase = resolve(base);
  const target = resolve(resolvedBase, ...segments);
  if (target !== resolvedBase && !target.startsWith(`${resolvedBase}${sep}`)) {
    throw new Error('Recovery path escaped its base directory');
  }
  return target;
}

function safePathComponent(label: string, value: string): string {
  const hash = createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 12);
  const sanitized = value
    .replace(/[^0-9A-Za-z_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32);
  return `${label}-${sanitized.length > 0 ? sanitized : 'value'}-${hash}`;
}

function pushUnique(values: string[], value: string): void {
  if (!values.includes(value)) {
    values.push(value);
  }
}

function pushCandidate(candidates: RecoveryCandidate[], candidate: RecoveryCandidate): void {
  const candidateHash = sha256Canonical(candidate.project);
  const duplicate = candidates.some((existing) => (
    existing.revision === candidate.revision &&
    sha256Canonical(existing.project) === candidateHash
  ));
  if (!duplicate) {
    candidates.push(candidate);
  }
}
