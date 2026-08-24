import { randomBytes } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { gzip, gunzip } from 'node:zlib';
import { promisify } from 'node:util';
import { join, posix, resolve } from 'node:path';

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
  runJournalMaintenance,
  writeJournalCommitBoundary,
  writeInitialJournalCommitBoundary,
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
  /**
   * Worker entry supplied by the host bundle.  Keeping this explicit avoids
   * resolving a source-relative URL that breaks when the host is bundled as CJS.
   */
  readonly workerEntryUrl?: URL;
  readonly workerFactory?: SnapshotWorkerFactory;
}

type SnapshotScheduleDecision = { readonly reason: SnapshotReason };

interface LoadedSnapshot {
  readonly envelope: SnapshotEnvelope;
  readonly path: string;
}

interface RotatedJournal {
  readonly archivePath: string;
  readonly journalRecords: Awaited<ReturnType<typeof readValidJournal>>['records'];
  readonly manifest: ProjectManifest;
  readonly targetRevision: number;
  readonly targetSequence: number;
}

interface SnapshotWorkerLike {
  once(event: 'message', listener: (message: unknown) => void): this;
  once(event: 'error', listener: (error: Error) => void): this;
  once(event: 'exit', listener: (code: number) => void): this;
  postMessage(input: SnapshotWorkerInput): void;
  terminate(): Promise<number> | number;
}

export type SnapshotWorkerFactory = (url: URL) => SnapshotWorkerLike;

const ACTIVE_JOURNAL_SEGMENT = 'journal/active.ndjson';
const MANIFEST_PATH = 'project.novus.json';
const inFlightByProjectRoot = new Map<string, Promise<SnapshotFlushResult>>();

export class SnapshotScheduler {
  private readonly fileSystem: FileSystem;
  private readonly now: () => Date;
  private readonly worker: (input: SnapshotWorkerInput) => Promise<SnapshotWorkerOutput>;

  constructor(options: SnapshotSchedulerOptions = {}) {
    this.fileSystem = options.fileSystem ?? new NodeFileSystem();
    this.now = options.now ?? (() => new Date());
    this.worker = options.worker
      ?? (options.workerEntryUrl
        ? createNodeSnapshotWorkerRunner(options.workerEntryUrl, options.workerFactory)
        : SnapshotScheduler.defaultWorker);
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
    const existing = inFlightByProjectRoot.get(projectKey);
    if (existing !== undefined) {
      return existing;
    }

    const running = this.flushExclusive(session, request).finally(() => {
      if (inFlightByProjectRoot.get(projectKey) === running) {
        inFlightByProjectRoot.delete(projectKey);
      }
    });
    inFlightByProjectRoot.set(projectKey, running);
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
    const rotated = await this.rotateActiveJournal(session.root, manifest);

    if (rotated === null) {
      return {
        path: manifest.stableSnapshotPath ?? '',
        reason: request.reason,
        revision: manifest.stableSnapshotRevision,
        snapshotId: manifest.stableSnapshotId ?? '',
      };
    }

    try {
      return await this.writeSnapshotFromRotation(session.root, rotated, request.reason);
    } catch (error) {
      await this.rollbackRotation(session.root, rotated, error);
      throw error;
    }
  }

  private async rotateActiveJournal(
    root: string,
    manifest: ProjectManifest,
  ): Promise<RotatedJournal | null> {
    const activeJournalPath = join(root, ...manifest.activeJournalSegment.split('/'));

    return runJournalMaintenance({
      activeJournalPath,
      baseRevision: manifest.stableSnapshotRevision,
      fileSystem: this.fileSystem,
      nextSequence: manifest.nextSequence,
      projectId: manifest.projectId,
    }, async (maintenance) => {
      const journal = await readValidJournal(activeJournalPath, {
        baseRevision: manifest.stableSnapshotRevision,
        committedOnly: true,
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
        return null;
      }

      const archiveSegment = this.archiveSegment(manifest.nextSequence, targetRevision);
      const archivePath = join(root, ...archiveSegment.split('/'));
      await this.fileSystem.rename(activeJournalPath, archivePath);
      await writeAtomic(this.fileSystem, activeJournalPath, '');
      await writeInitialJournalCommitBoundary(this.fileSystem, activeJournalPath, {
        baseRevision: targetRevision,
        nextSequence: targetSequence + 1,
        projectId: manifest.projectId,
        updatedAt: this.now().toISOString(),
      });
      maintenance.advanceTo(targetRevision, targetSequence + 1);

      return {
        archivePath,
        journalRecords: journal.records,
        manifest,
        targetRevision,
        targetSequence,
      };
    });
  }

  private async writeSnapshotFromRotation(
    root: string,
    rotated: RotatedJournal,
    reason: SnapshotReason,
  ): Promise<SnapshotFlushResult> {
    const { manifest, targetRevision, targetSequence } = rotated;
    const stableSnapshot = await this.loadSnapshot(root, manifest);
    const workerOutput = await this.worker({
      snapshot: stableSnapshot.envelope,
      records: rotated.journalRecords,
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
    const snapshotPath = join(root, ...snapshotSegment.split('/'));
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
      join(root, MANIFEST_PATH),
      `${canonicalJson(nextManifest)}\n`,
    );

    return {
      path: snapshotSegment,
      reason,
      revision: targetRevision,
      snapshotId,
    };
  }

  private async rollbackRotation(
    root: string,
    rotated: RotatedJournal,
    cause: unknown,
  ): Promise<void> {
    const activeJournalPath = join(root, ...ACTIVE_JOURNAL_SEGMENT.split('/'));

    await runJournalMaintenance({
      activeJournalPath,
      baseRevision: rotated.targetRevision,
      fileSystem: this.fileSystem,
      nextSequence: rotated.targetSequence + 1,
      projectId: rotated.manifest.projectId,
    }, async (maintenance) => {
      try {
        const archiveText = await this.fileSystem.readFile(rotated.archivePath, 'utf8');
        const rawActiveText = await this.fileSystem.readFile(activeJournalPath, 'utf8');
        const activeJournal = await readValidJournal(activeJournalPath, {
          baseRevision: rotated.targetRevision,
          committedOnly: true,
          expectedProjectId: rotated.manifest.projectId,
          fileSystem: this.fileSystem,
          firstSequence: rotated.targetSequence + 1,
        });
        const activeText = Buffer.from(rawActiveText, 'utf8')
          .subarray(0, activeJournal.validBytes)
          .toString('utf8');
        const mergedText = `${archiveText}${activeText}`;
        await writeAtomic(this.fileSystem, activeJournalPath, mergedText);
        const mergedJournal = await readValidJournal(activeJournalPath, {
          baseRevision: rotated.manifest.stableSnapshotRevision,
          expectedProjectId: rotated.manifest.projectId,
          fileSystem: this.fileSystem,
          firstSequence: rotated.manifest.nextSequence,
        });
        const lastRecord = mergedJournal.records[mergedJournal.records.length - 1];
        await writeJournalCommitBoundary(this.fileSystem, activeJournalPath, {
          baseRevision: rotated.manifest.stableSnapshotRevision,
          committedBytes: Buffer.byteLength(mergedText, 'utf8'),
          firstSequence: rotated.manifest.nextSequence,
          lastRevision: lastRecord?.revision ?? rotated.manifest.stableSnapshotRevision,
          nextSequence: (lastRecord?.sequence ?? rotated.manifest.nextSequence - 1) + 1,
          projectId: rotated.manifest.projectId,
          updatedAt: this.now().toISOString(),
        });
        maintenance.advanceTo(
          lastRecord?.revision ?? rotated.manifest.stableSnapshotRevision,
          (lastRecord?.sequence ?? rotated.manifest.nextSequence - 1) + 1,
        );
        await this.fileSystem.rm(rotated.archivePath, { force: true });

        if (activeJournal.tailStatus !== 'complete') {
          throw createPersistenceError(
            'CORRUPT_JOURNAL',
            false,
            'Rollback encountered an incomplete active journal tail',
          );
        }
      } catch (rollbackError) {
        throw maintenance.poison(createPersistenceError(
          'CORRUPT_JOURNAL',
          false,
          'Journal rollback is uncertain after snapshot rotation failure',
          rollbackError ?? cause,
        ));
      }
    });
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
    const raw = await readFileBytes(this.fileSystem, path);
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
    ? (await gunzipAsync(await readFileBytes(fileSystem, path))).toString('utf8')
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

function createNodeSnapshotWorkerRunner(
  workerEntryUrl: URL,
  workerFactory: SnapshotWorkerFactory = (url) => new Worker(url) as SnapshotWorkerLike,
): (input: SnapshotWorkerInput) => Promise<SnapshotWorkerOutput> {
  return (input) => new Promise<SnapshotWorkerOutput>((resolve, reject) => {
    const worker = workerFactory(workerEntryUrl);
    let settled = false;

    const settle = (callback: () => void) => {
      if (settled) {
        return;
      }

      settled = true;
      callback();
      void Promise.resolve(worker.terminate()).catch(() => undefined);
    };

    worker.once('message', (message) => {
      settle(() => {
        if (isWorkerSuccessMessage(message)) {
          resolve(message.output);
          return;
        }

        if (isWorkerFailureMessage(message)) {
          reject(createPersistenceError(
            'CORRUPT_SNAPSHOT',
            false,
            `Snapshot worker failed: ${message.error}`,
          ));
          return;
        }

        reject(createPersistenceError(
          'CORRUPT_SNAPSHOT',
          false,
          'Snapshot worker returned an invalid response',
        ));
      });
    });
    worker.once('error', (error) => {
      settle(() => reject(error));
    });
    worker.once('exit', (code) => {
      if (code !== 0) {
        settle(() => reject(createPersistenceError(
          'CORRUPT_SNAPSHOT',
          false,
          `Snapshot worker exited with code ${code}`,
        )));
      }
    });
    worker.postMessage(input);
  });
}

async function readFileBytes(fileSystem: FileSystem, path: string): Promise<Uint8Array> {
  if (fileSystem.readFileBuffer !== undefined) {
    return fileSystem.readFileBuffer(path);
  }

  return Buffer.from(await fileSystem.readFile(path, 'latin1'), 'latin1');
}

function isWorkerSuccessMessage(message: unknown): message is { readonly ok: true; readonly output: SnapshotWorkerOutput } {
  return isPlainRecord(message) && message.ok === true && isPlainRecord(message.output);
}

function isWorkerFailureMessage(message: unknown): message is { readonly ok: false; readonly error: string } {
  return isPlainRecord(message) && message.ok === false && typeof message.error === 'string';
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
  const resolvedRoot = resolve(root);
  return process.platform === 'win32' ? resolvedRoot.toLowerCase() : resolvedRoot;
}
