import { randomBytes } from 'node:crypto';
import { readFile as readBinaryFile } from 'node:fs/promises';
import { gzip, gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { join, posix } from 'node:path';

import {
  canonicalJson,
  sha256Canonical,
} from './canonical-json.js';
import {
  PROJECT_FORMAT_VERSION,
  SNAPSHOT_BYTE_LIMIT,
  SNAPSHOT_SCHEMA_VERSION,
  SNAPSHOT_TRANSACTION_LIMIT,
  type JournalTransactionKind,
  type ProjectManifest,
  type SnapshotEnvelope,
} from './contracts.js';
import { type FileSystem, NodeFileSystem, writeAtomic } from './file-system.js';
import {
  createPersistenceError,
  readValidJournal,
  releaseJournalState,
} from './journal-writer.js';
import type { OpenedProjectSession } from './project-repository.js';
import {
  buildSnapshotProject,
  type SnapshotWorkerInput,
  type SnapshotWorkerOutput,
} from './snapshot-worker.js';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

export type SnapshotReason =
  | 'transaction_limit'
  | 'byte_limit'
  | 'agent_transaction'
  | 'stable_point'
  | 'idle'
  | 'close';

export interface SnapshotConsiderEvent {
  readonly activeJournalBytes: number;
  readonly closing?: boolean;
  readonly idleMs?: number;
  readonly lastTransactionKind?: JournalTransactionKind;
  readonly pendingChanges: boolean;
  readonly stablePoint?: boolean;
  readonly transactionCount: number;
}

export interface SnapshotFlushRequest {
  readonly reason: SnapshotReason;
}

export interface SnapshotFlushResult {
  readonly path: string;
  readonly reason: SnapshotReason;
  readonly revision: number;
  readonly snapshotId: string;
}

export interface SnapshotSchedulerOptions {
  readonly fileSystem?: FileSystem;
  readonly now?: () => Date;
  readonly worker?: (input: SnapshotWorkerInput) => Promise<SnapshotWorkerOutput>;
}

type SnapshotScheduleDecision = { readonly reason: SnapshotReason };

interface LoadedSnapshot {
  readonly envelope: SnapshotEnvelope;
  readonly path: string;
}

const ACTIVE_JOURNAL_SEGMENT = 'journal/active.ndjson';
const MANIFEST_PATH = 'project.novus.json';

export class SnapshotScheduler {
  private readonly fileSystem: FileSystem;
  private readonly inFlightByProjectRoot = new Map<string, Promise<SnapshotFlushResult>>();
  private readonly now: () => Date;
  private readonly worker: (input: SnapshotWorkerInput) => Promise<SnapshotWorkerOutput>;

  constructor(options: SnapshotSchedulerOptions = {}) {
    this.fileSystem = options.fileSystem ?? new NodeFileSystem();
    this.now = options.now ?? (() => new Date());
    this.worker = options.worker ?? SnapshotScheduler.defaultWorker;
  }

  static defaultWorker(input: SnapshotWorkerInput): Promise<SnapshotWorkerOutput> {
    return buildSnapshotProject(input);
  }

  consider(
    _project: Pick<OpenedProjectSession, 'root'>,
    event: SnapshotConsiderEvent,
  ): SnapshotScheduleDecision | null {
    if (event.transactionCount >= SNAPSHOT_TRANSACTION_LIMIT) {
      return { reason: 'transaction_limit' };
    }

    if (event.activeJournalBytes >= SNAPSHOT_BYTE_LIMIT) {
      return { reason: 'byte_limit' };
    }

    if (event.lastTransactionKind === 'agent') {
      return { reason: 'agent_transaction' };
    }

    if (event.stablePoint === true) {
      return { reason: 'stable_point' };
    }

    if (event.pendingChanges && (event.idleMs ?? 0) >= 5_000) {
      return { reason: 'idle' };
    }

    if (event.closing === true) {
      return { reason: 'close' };
    }

    return null;
  }

  flush(
    session: OpenedProjectSession,
    request: SnapshotFlushRequest,
  ): Promise<SnapshotFlushResult> {
    const projectKey = normalizeProjectKey(session.root);
    const existing = this.inFlightByProjectRoot.get(projectKey);
    if (existing !== undefined) {
      return existing;
    }

    const running = this.flushExclusive(session, request).finally(() => {
      this.inFlightByProjectRoot.delete(projectKey);
    });
    this.inFlightByProjectRoot.set(projectKey, running);
    return running;
  }

  private async flushExclusive(
    session: OpenedProjectSession,
    request: SnapshotFlushRequest,
  ): Promise<SnapshotFlushResult> {
    if (session.mode !== 'write') {
      throw createPersistenceError(
        'CONCURRENT_WRITER',
        true,
        'Snapshots require a writable project session',
      );
    }

    const manifest = await this.readManifest(session.root);
    const activeJournalPath = join(session.root, ...manifest.activeJournalSegment.split('/'));
    const journal = await readValidJournal(activeJournalPath, {
      baseRevision: manifest.stableSnapshotRevision,
      expectedProjectId: manifest.projectId,
      fileSystem: this.fileSystem,
      firstSequence: manifest.nextSequence,
    });
    const lastRecord = journal.records.length > 0
      ? journal.records[journal.records.length - 1]
      : undefined;
    const targetRevision = lastRecord?.revision ?? manifest.stableSnapshotRevision;
    const targetSequence = lastRecord?.sequence ?? manifest.nextSequence - 1;

    if (targetRevision === manifest.stableSnapshotRevision) {
      return {
        path: manifest.stableSnapshotPath ?? '',
        reason: request.reason,
        revision: manifest.stableSnapshotRevision,
        snapshotId: manifest.stableSnapshotId ?? '',
      };
    }

    const archiveSegment = this.archiveSegment(manifest.nextSequence, targetRevision);
    const archivePath = join(session.root, ...archiveSegment.split('/'));
    await this.fileSystem.rename(activeJournalPath, archivePath);
    await writeAtomic(this.fileSystem, activeJournalPath, '');
    releaseJournalState(activeJournalPath, manifest.projectId);

    const stableSnapshot = await this.loadSnapshot(session.root, manifest);
    const workerOutput = await this.worker({
      snapshot: stableSnapshot.envelope,
      records: journal.records,
      targetRevision,
    });
    const project = JSON.parse(workerOutput.projectJson) as Record<string, unknown>;
    if (
      workerOutput.revision !== targetRevision ||
      workerOutput.projectSha256 !== sha256Canonical(project)
    ) {
      throw createPersistenceError(
        'CORRUPT_SNAPSHOT',
        false,
        'Snapshot worker output failed checksum verification',
      );
    }

    const hash8 = workerOutput.projectSha256.slice(0, 8);
    const snapshotId = `s-${targetRevision}-${hash8}`;
    const snapshotSegment = `snapshots/${snapshotId}.json.gz`;
    const envelope: SnapshotEnvelope = {
      schemaVersion: SNAPSHOT_SCHEMA_VERSION,
      projectId: manifest.projectId,
      snapshotId,
      previousSnapshotId: manifest.stableSnapshotId,
      revision: targetRevision,
      createdAt: this.now().toISOString(),
      project,
      projectSha256: workerOutput.projectSha256,
    };
    const snapshotBytes = await gzipAsync(`${canonicalJson(envelope)}\n`);
    const snapshotPath = join(session.root, ...snapshotSegment.split('/'));
    await writeAtomic(this.fileSystem, snapshotPath, snapshotBytes);
    await this.verifyGzipSnapshot(snapshotPath, envelope);

    const nextManifest: ProjectManifest = {
      ...manifest,
      activeJournalSegment: ACTIVE_JOURNAL_SEGMENT,
      cleanClose: false,
      formatVersion: PROJECT_FORMAT_VERSION,
      nextSequence: targetSequence + 1,
      stableSnapshotId: snapshotId,
      stableSnapshotPath: snapshotSegment,
      stableSnapshotRevision: targetRevision,
    };
    await writeAtomic(
      this.fileSystem,
      join(session.root, MANIFEST_PATH),
      `${canonicalJson(nextManifest)}\n`,
    );

    return {
      path: snapshotSegment,
      reason: request.reason,
      revision: targetRevision,
      snapshotId,
    };
  }

  private archiveSegment(firstSequence: number, targetRevision: number): string {
    const stamp = this.now().toISOString().replace(/[^0-9A-Za-z]/g, '');
    const nonce = randomBytes(4).toString('hex');
    return `journal/archive/j-${firstSequence}-${targetRevision}-${stamp}-${nonce}.ndjson`;
  }

  private async readManifest(root: string): Promise<ProjectManifest> {
    return JSON.parse(await this.fileSystem.readFile(join(root, MANIFEST_PATH), 'utf8')) as ProjectManifest;
  }

  private async loadSnapshot(root: string, manifest: ProjectManifest): Promise<LoadedSnapshot> {
    if (manifest.stableSnapshotPath === null) {
      throw createPersistenceError('CORRUPT_SNAPSHOT', false, 'Manifest has no stable snapshot');
    }

    const snapshotSegment = validateSnapshotSegment(manifest.stableSnapshotPath);
    const snapshotPath = join(root, ...snapshotSegment.split('/'));
    const envelope = await readSnapshotEnvelope(snapshotPath, this.fileSystem);
    if (!isValidSnapshotEnvelope(envelope, manifest.projectId, manifest.stableSnapshotRevision)) {
      throw createPersistenceError('CORRUPT_SNAPSHOT', false, 'Stable snapshot failed validation');
    }

    return { envelope, path: snapshotPath };
  }

  private async verifyGzipSnapshot(path: string, expected: SnapshotEnvelope): Promise<void> {
    const raw = await readBinaryFile(path);
    const unzipped = (await gunzipAsync(raw)).toString('utf8');
    const parsed = JSON.parse(unzipped) as unknown;
    if (
      !isSnapshotEnvelope(parsed) ||
      parsed.projectSha256 !== sha256Canonical(parsed.project) ||
      parsed.projectSha256 !== expected.projectSha256 ||
      parsed.revision !== expected.revision ||
      parsed.snapshotId !== expected.snapshotId
    ) {
      throw createPersistenceError('CORRUPT_SNAPSHOT', false, 'Gzip snapshot verification failed');
    }
  }
}

export async function readSnapshotEnvelope(
  path: string,
  fileSystem: FileSystem = new NodeFileSystem(),
): Promise<SnapshotEnvelope> {
  const text = path.endsWith('.gz')
    ? (await gunzipAsync(await readBinaryFile(path))).toString('utf8')
    : await fileSystem.readFile(path, 'utf8');
  const parsed = JSON.parse(text) as unknown;
  if (!isSnapshotEnvelope(parsed)) {
    throw createPersistenceError('CORRUPT_SNAPSHOT', false, 'Snapshot envelope schema is invalid');
  }
  return parsed;
}

export function isValidSnapshotEnvelope(
  snapshot: SnapshotEnvelope,
  projectId: string,
  revision?: number,
): boolean {
  if (
    snapshot.schemaVersion !== SNAPSHOT_SCHEMA_VERSION ||
    snapshot.projectId !== projectId ||
    typeof snapshot.snapshotId !== 'string' ||
    (snapshot.previousSnapshotId !== null && typeof snapshot.previousSnapshotId !== 'string') ||
    !Number.isInteger(snapshot.revision) ||
    snapshot.revision < 0 ||
    (revision !== undefined && snapshot.revision !== revision) ||
    typeof snapshot.createdAt !== 'string' ||
    !isPlainRecord(snapshot.project) ||
    typeof snapshot.projectSha256 !== 'string'
  ) {
    return false;
  }

  try {
    return snapshot.projectSha256 === sha256Canonical(snapshot.project);
  } catch {
    return false;
  }
}

function validateSnapshotSegment(path: string): string {
  if (path.includes('\\') || path.includes('\0') || path.startsWith('/')) {
    throw createPersistenceError('CORRUPT_SNAPSHOT', false, 'Invalid snapshot path');
  }

  const normalized = posix.normalize(path);
  if (
    normalized !== path ||
    normalized.startsWith('../') ||
    !normalized.startsWith('snapshots/') ||
    normalized === 'snapshots/'
  ) {
    throw createPersistenceError('CORRUPT_SNAPSHOT', false, 'Invalid snapshot path');
  }

  return normalized;
}

function isSnapshotEnvelope(value: unknown): value is SnapshotEnvelope {
  if (!isPlainRecord(value)) {
    return false;
  }

  return (
    value.schemaVersion === SNAPSHOT_SCHEMA_VERSION &&
    typeof value.projectId === 'string' &&
    typeof value.snapshotId === 'string' &&
    (value.previousSnapshotId === null || typeof value.previousSnapshotId === 'string') &&
    Number.isInteger(value.revision) &&
    typeof value.createdAt === 'string' &&
    isPlainRecord(value.project) &&
    typeof value.projectSha256 === 'string'
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function normalizeProjectKey(root: string): string {
  return root.toLowerCase();
}
