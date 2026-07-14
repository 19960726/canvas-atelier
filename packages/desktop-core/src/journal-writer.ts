import { normalize } from 'node:path';

import {
  applyProjectTransaction,
  parseCanvasProject,
  projectTransactionSchema,
  type CanvasProject,
  type ProjectTransaction,
} from '@agent-canvas/domain';

import { canonicalJson, sha256Canonical } from './canonical-json.js';
import {
  JOURNAL_SCHEMA_VERSION,
  type CommitAck,
  type CommitRequest,
  type JournalRecord,
  type JournalTransactionKind,
  type PersistenceError,
  type PersistenceErrorCode,
} from './contracts.js';
import { NodeFileSystem, type FileSystem } from './file-system.js';

export interface JournalReadResult {
  readonly records: JournalRecord[];
  readonly validBytes: number;
  readonly tailStatus: 'complete' | 'partial_final_line';
}

export interface JournalReadOptions {
  readonly baseRevision?: number;
  readonly expectedProjectId?: string;
  readonly fileSystem?: FileSystem;
  readonly firstSequence?: number;
}

export interface JournalSyncGate {
  wait(): Promise<void>;
}

export interface JournalCommitOptions {
  readonly syncGate?: JournalSyncGate;
}

export interface JournalWriterOpenOptions {
  readonly activeJournalPath: string;
  readonly baseRevision: number;
  readonly fileSystem?: FileSystem;
  readonly nextSequence: number;
  readonly now?: () => Date;
  readonly projectId: string;
}

export type JournalWriterSessionOptions = Pick<JournalWriterOpenOptions, 'fileSystem' | 'now'>;

interface IdempotencyEntry {
  readonly ack: CommitAck;
  readonly requestSha256: string;
}

interface ReplayResult {
  readonly project: CanvasProject;
  readonly revision: number;
}

type JournalRecordPayload = Omit<JournalRecord, 'payloadSha256'>;

const JOURNAL_RECORD_KEYS = [
  'schemaVersion',
  'projectId',
  'sequence',
  'revision',
  'transactionId',
  'committedAt',
  'kind',
  'label',
  'operations',
  'payloadSha256',
];

const JOURNAL_PAYLOAD_KEYS = JOURNAL_RECORD_KEYS.filter((key) => key !== 'payloadSha256');

const queues = new Map<string, Promise<void>>();

export class JournalWriter {
  private readonly activeJournalPath: string;
  private readonly fileSystem: FileSystem;
  private readonly idempotencyByTransactionId: Map<string, IdempotencyEntry>;
  private readonly now: () => Date;
  private readonly projectId: string;
  private currentRevision: number;
  private nextSequence: number;

  private constructor(options: {
    readonly activeJournalPath: string;
    readonly currentRevision: number;
    readonly fileSystem: FileSystem;
    readonly idempotencyByTransactionId: Map<string, IdempotencyEntry>;
    readonly nextSequence: number;
    readonly now: () => Date;
    readonly projectId: string;
  }) {
    this.activeJournalPath = options.activeJournalPath;
    this.currentRevision = options.currentRevision;
    this.fileSystem = options.fileSystem;
    this.idempotencyByTransactionId = options.idempotencyByTransactionId;
    this.nextSequence = options.nextSequence;
    this.now = options.now;
    this.projectId = options.projectId;
  }

  static async open(options: JournalWriterOpenOptions): Promise<JournalWriter> {
    const fileSystem = options.fileSystem ?? new NodeFileSystem();
    const journal = await readValidJournal(options.activeJournalPath, {
      baseRevision: options.baseRevision,
      expectedProjectId: options.projectId,
      fileSystem,
      firstSequence: options.nextSequence,
    });
    const idempotencyByTransactionId = new Map<string, IdempotencyEntry>();
    let currentRevision = options.baseRevision;
    let nextSequence = options.nextSequence;

    for (const record of journal.records) {
      currentRevision = record.revision;
      nextSequence = record.sequence + 1;
      idempotencyByTransactionId.set(record.transactionId, {
        ack: ackFromRecord(record),
        requestSha256: requestSha256FromRecord(record),
      });
    }

    return new JournalWriter({
      activeJournalPath: options.activeJournalPath,
      currentRevision,
      fileSystem,
      idempotencyByTransactionId,
      nextSequence,
      now: options.now ?? (() => new Date()),
      projectId: options.projectId,
    });
  }

  commit(request: CommitRequest, options: JournalCommitOptions = {}): Promise<CommitAck> {
    const queueKey = normalize(this.activeJournalPath).toLowerCase();
    const previous = queues.get(queueKey) ?? Promise.resolve();
    const run = previous.then(() => this.commitInsideQueue(request, options));
    queues.set(queueKey, run.then(() => undefined, () => undefined));
    return run;
  }

  private async commitInsideQueue(
    request: CommitRequest,
    options: JournalCommitOptions,
  ): Promise<CommitAck> {
    const normalizedRequest = normalizeCommitRequest(request, this.projectId);
    const transactionId = normalizedRequest.transaction.id;
    const requestSha256 = sha256Canonical(normalizedRequest);
    const existing = this.idempotencyByTransactionId.get(transactionId);

    if (existing !== undefined) {
      if (existing.requestSha256 !== requestSha256) {
        throw createPersistenceError(
          'CORRUPT_JOURNAL',
          false,
          'Transaction id was already committed with different content',
        );
      }

      return existing.ack;
    }

    if (normalizedRequest.baseRevision !== this.currentRevision) {
      throw createPersistenceError('REVISION_CONFLICT', true, 'Base revision is stale');
    }

    const payload: JournalRecordPayload = {
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      projectId: this.projectId,
      sequence: this.nextSequence,
      revision: this.currentRevision + 1,
      transactionId,
      committedAt: this.now().toISOString(),
      kind: normalizedRequest.kind,
      label: normalizedRequest.transaction.label,
      operations: normalizedRequest.transaction.operations,
    };
    const record: JournalRecord = {
      ...payload,
      payloadSha256: sha256Canonical(payload),
    };
    const line = `${canonicalJson(record)}\n`;

    let handle: Awaited<ReturnType<FileSystem['open']>> | null = null;
    try {
      handle = await this.fileSystem.open(this.activeJournalPath, 'a');
      await handle.writeFile(line);
      if (options.syncGate !== undefined) {
        await options.syncGate.wait();
      }
      await handle.sync();
    } finally {
      if (handle !== null) {
        await handle.close();
      }
    }

    const ack = ackFromRecord(record);
    this.currentRevision = record.revision;
    this.nextSequence = record.sequence + 1;
    this.idempotencyByTransactionId.set(transactionId, { ack, requestSha256 });
    return ack;
  }
}

export async function readValidJournal(
  activeJournalPath: string,
  options: JournalReadOptions = {},
): Promise<JournalReadResult> {
  const fileSystem = options.fileSystem ?? new NodeFileSystem();
  const raw = await fileSystem.readFile(activeJournalPath, 'utf8');
  const complete = raw.length === 0 || raw.endsWith('\n');
  const tailStatus = complete ? 'complete' : 'partial_final_line';
  const lastCompleteLineEnd = complete ? raw.length : raw.lastIndexOf('\n') + 1;
  const validText = raw.slice(0, lastCompleteLineEnd);
  const validBytes = Buffer.byteLength(validText, 'utf8');
  const lines = validText.length === 0 ? [] : validText.slice(0, -1).split('\n');
  const records: JournalRecord[] = [];
  const expectedFirstSequence = options.firstSequence ?? 1;
  const baseRevision = options.baseRevision ?? 0;
  let expectedProjectId = options.expectedProjectId ?? null;

  for (const [index, line] of lines.entries()) {
    const record = parseJournalLine(line);
    if (expectedProjectId === null) {
      expectedProjectId = record.projectId;
    }

    if (
      record.projectId !== expectedProjectId ||
      record.sequence !== expectedFirstSequence + index ||
      record.revision !== baseRevision + index + 1
    ) {
      throw corruptJournal('Journal sequence does not match its expected chain');
    }

    records.push(record);
  }

  return { records, tailStatus, validBytes };
}

export function replayJournal(
  snapshot: CanvasProject,
  baseRevision: number,
  records: readonly JournalRecord[],
): ReplayResult {
  let project = parseCanvasProject(snapshot);
  let revision = baseRevision;

  for (const record of records) {
    if (record.projectId !== project.id || record.revision !== revision + 1) {
      throw corruptJournal('Journal record does not match replay base');
    }

    const transaction: ProjectTransaction = {
      id: record.transactionId,
      label: record.label,
      operations: [...record.operations],
    };

    try {
      const nextProject = applyProjectTransaction(project, transaction);
      project = nextProject;
      revision = record.revision;
    } catch (error) {
      throw corruptJournal('Journal transaction cannot be replayed', error);
    }
  }

  return { project, revision };
}

export function createPersistenceError(
  code: PersistenceErrorCode,
  retryable: boolean,
  message: string,
  cause?: unknown,
): PersistenceError {
  const error = new Error(message) as PersistenceError & { cause?: unknown };
  error.name = 'PersistenceError';
  Object.defineProperty(error, 'code', {
    enumerable: true,
    value: code,
  });
  Object.defineProperty(error, 'retryable', {
    enumerable: true,
    value: retryable,
  });
  if (cause !== undefined) {
    error.cause = cause;
  }
  return error;
}

function parseJournalLine(line: string): JournalRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    throw corruptJournal('Journal contains malformed JSON', error);
  }

  if (!isPlainRecord(parsed) || !hasOnlyKeys(parsed, JOURNAL_RECORD_KEYS)) {
    throw corruptJournal('Journal record schema is invalid');
  }

  const payloadSha256 = parsed.payloadSha256;
  const payload = withoutChecksum(parsed);
  if (
    typeof payloadSha256 !== 'string' ||
    !hasOnlyKeys(payload, JOURNAL_PAYLOAD_KEYS) ||
    sha256Canonical(payload) !== payloadSha256
  ) {
    throw corruptJournal('Journal record checksum is invalid');
  }

  return parseJournalPayload(payload, payloadSha256);
}

function parseJournalPayload(
  payload: Record<string, unknown>,
  payloadSha256: string,
): JournalRecord {
  if (
    payload.schemaVersion !== JOURNAL_SCHEMA_VERSION ||
    typeof payload.projectId !== 'string' ||
    !isPositiveInteger(payload.sequence) ||
    !isPositiveInteger(payload.revision) ||
    typeof payload.transactionId !== 'string' ||
    payload.transactionId.length === 0 ||
    typeof payload.committedAt !== 'string' ||
    !isJournalTransactionKind(payload.kind) ||
    typeof payload.label !== 'string' ||
    payload.label.length === 0
  ) {
    throw corruptJournal('Journal record schema is invalid');
  }

  try {
    const transaction = projectTransactionSchema.parse({
      id: payload.transactionId,
      label: payload.label,
      operations: payload.operations,
    });

    return {
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      projectId: payload.projectId,
      sequence: payload.sequence,
      revision: payload.revision,
      transactionId: transaction.id,
      committedAt: payload.committedAt,
      kind: payload.kind,
      label: transaction.label,
      operations: transaction.operations,
      payloadSha256,
    };
  } catch (error) {
    throw corruptJournal('Journal transaction schema is invalid', error);
  }
}

function normalizeCommitRequest(request: CommitRequest, projectId: string): CommitRequest {
  if (
    request.projectId !== projectId ||
    !Number.isInteger(request.baseRevision) ||
    request.baseRevision < 0 ||
    !isJournalTransactionKind(request.kind)
  ) {
    throw corruptJournal('Commit request schema is invalid');
  }

  try {
    return {
      projectId: request.projectId,
      baseRevision: request.baseRevision,
      kind: request.kind,
      transaction: projectTransactionSchema.parse(request.transaction),
    };
  } catch (error) {
    throw corruptJournal('Commit transaction schema is invalid', error);
  }
}

function requestSha256FromRecord(record: JournalRecord): string {
  return sha256Canonical({
    projectId: record.projectId,
    baseRevision: record.revision - 1,
    kind: record.kind,
    transaction: {
      id: record.transactionId,
      label: record.label,
      operations: record.operations,
    },
  });
}

function ackFromRecord(record: JournalRecord): CommitAck {
  return {
    projectId: record.projectId,
    revision: record.revision,
    sequence: record.sequence,
    transactionId: record.transactionId,
    committedAt: record.committedAt,
  };
}

function withoutChecksum(record: Record<string, unknown>): Record<string, unknown> {
  const { payloadSha256: _payloadSha256, ...payload } = record;
  return payload;
}

function corruptJournal(message: string, cause?: unknown): PersistenceError {
  return createPersistenceError('CORRUPT_JOURNAL', false, message, cause);
}

function isJournalTransactionKind(value: unknown): value is JournalTransactionKind {
  return value === 'canvas' || value === 'agent' || value === 'system';
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && typeof value === 'number' && value > 0;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function hasOnlyKeys(value: Record<string, unknown>, expectedKeys: readonly string[]): boolean {
  const keys = Object.keys(value);
  if (keys.length !== expectedKeys.length) {
    return false;
  }

  const expected = new Set(expectedKeys);
  return keys.every((key) => expected.has(key));
}
