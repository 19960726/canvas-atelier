import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

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
  readonly path: string;
  readonly firstSequence: number | null;
  readonly final: boolean;
}

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
    const journals = await this.listJournalSegments(projectRoot);
    const candidates: RecoveryCandidate[] = [];
    const sessionId = this.createId();

    for (const snapshot of snapshots) {
      const candidate = await this.tryBuildCandidate(
        projectRoot,
        manifest,
        snapshot,
        journals,
        issues,
        sessionId,
      );
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
      issues.includes('corrupt_journal_before_tail') ||
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
      if (journal.firstSequence !== null && journal.firstSequence <= revision) {
        continue;
      }

      try {
        const read = await readValidJournal(journal.path, {
          baseRevision: revision,
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

    const mirrorPath = await this.writeCandidateMirror(
      manifest.projectId,
      sessionId,
      revision,
      project,
      snapshot.envelope.snapshotId,
    );
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
    const recoveryRoot = join(this.appDataRoot, 'recovery', projectId, sessionId);
    await mkdir(recoveryRoot, { recursive: true });
    const candidatePath = join(recoveryRoot, `candidate-${revision}.json`);
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

    snapshots.sort((left, right) => right.envelope.revision - left.envelope.revision);
    return snapshots;
  }

  private async listJournalSegments(projectRoot: string): Promise<JournalSegment[]> {
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
        path: join(archiveRoot, name),
        firstSequence: firstSequenceFromArchiveName(name),
        final: false,
      }))
      .sort((left, right) => (left.firstSequence ?? Number.MAX_SAFE_INTEGER) - (right.firstSequence ?? Number.MAX_SAFE_INTEGER));

    return [
      ...archiveSegments,
      {
        path: join(projectRoot, ...ACTIVE_JOURNAL_SEGMENT.split('/')),
        firstSequence: null,
        final: true,
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
}

function firstSequenceFromArchiveName(name: string): number | null {
  const match = /^j-(\d+)-\d+-/.exec(name);
  if (match === null) {
    return null;
  }
  return Number.parseInt(match[1]!, 10);
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
