import { createHash } from 'node:crypto';
import { normalize, resolve } from 'node:path';

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
import { NodeFileSystem, type FileSystem, writeAtomic } from './file-system.js';

export interface JournalReadResult {
  readonly records: JournalRecord[];
  readonly validBytes: number;
  readonly tailStatus: 'complete' | 'partial_final_line';
}

export interface JournalReadOptions {
  readonly baseRevision?: number;
  readonly committedOnly?: boolean;
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

export interface JournalMaintenanceOptions extends JournalWriterOpenOptions {}

export interface JournalMaintenanceContext {
  readonly activeJournalPath: string;
  readonly currentRevision: number;
  readonly fileSystem: FileSystem;
  readonly nextSequence: number;
  readonly projectId: string;
  advanceTo(revision: number, nextSequence: number): void;
  poison(error: PersistenceError): PersistenceError;
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

interface JournalCommitBoundary {
  readonly schemaVersion: 1;
  readonly baseRevision: number;
  readonly committedBytes: number;
  readonly firstSequence: number;
  readonly journalSha256: string;
  readonly lastRevision: number;
  readonly nextSequence: number;
  readonly projectId: string;
  readonly updatedAt: string;
}

interface JournalState {
  baseRevision: number;
  firstSequence: number;
  readonly idempotencyByTransactionId: Map<string, IdempotencyEntry>;
  readonly projectId: string;
  currentRevision: number;
  nextSequence: number;
  poisonedError: PersistenceError | null;
}

interface JournalRegistryEntry {
  initialization: Promise<JournalState>;
  queue: Promise<void>;
  generation: number;
  released: PersistenceError | null;
  state: JournalState | null;
}

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

const journalRegistry = new Map<string, JournalRegistryEntry>();

export class JournalWriter {
  private readonly activeJournalPath: string;
  private readonly fileSystem: FileSystem;
  private readonly now: () => Date;
  private readonly projectId: string;
  private readonly registryEntry: JournalRegistryEntry;
  private readonly registryGeneration: number;
  private readonly state: JournalState;

  private constructor(options: {
    readonly activeJournalPath: string;
    readonly fileSystem: FileSystem;
    readonly now: () => Date;
    readonly projectId: string;
    readonly registryEntry: JournalRegistryEntry;
    readonly registryGeneration: number;
    readonly state: JournalState;
  }) {
    this.activeJournalPath = options.activeJournalPath;
    this.fileSystem = options.fileSystem;
    this.now = options.now;
    this.projectId = options.projectId;
    this.registryEntry = options.registryEntry;
    this.registryGeneration = options.registryGeneration;
    this.state = options.state;
  }

  static async open(options: JournalWriterOpenOptions): Promise<JournalWriter> {
    const fileSystem = options.fileSystem ?? new NodeFileSystem();
    const registryKey = canonicalJournalRegistryKey(options.activeJournalPath, options.projectId);
    let registryEntry = journalRegistry.get(registryKey);
    if (registryEntry === undefined || registryEntry.released !== null) {
      registryEntry = createJournalRegistryEntry(options, fileSystem);
      journalRegistry.set(registryKey, registryEntry);
    }
    const registryGeneration = registryEntry.generation;
    const state = await registryEntry.initialization;
    registryEntry.state = state;

    if (registryEntry.released !== null || registryEntry.generation !== registryGeneration) {
      throw registryEntry.released ?? createPersistenceError(
        'CONCURRENT_WRITER',
        false,
        'Journal writer is no longer active',
      );
    }

    if (state.projectId !== options.projectId) {
      throw corruptJournal('Journal registry project does not match open request');
    }

    return new JournalWriter({
      activeJournalPath: options.activeJournalPath,
      fileSystem,
      now: options.now ?? (() => new Date()),
      projectId: options.projectId,
      registryEntry,
      registryGeneration,
      state,
    });
  }

  commit(request: CommitRequest, options: JournalCommitOptions = {}): Promise<CommitAck> {
    const inactiveError = this.getInactiveRegistryEntryError();
    if (inactiveError !== null) {
      return Promise.reject(inactiveError);
    }

    const previous = this.registryEntry.queue;
    const run = previous.then(() => {
      this.ensureRegistryEntryActive();
      return this.commitInsideQueue(this.state, request, options);
    });
    this.registryEntry.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async commitInsideQueue(
    state: JournalState,
    request: CommitRequest,
    options: JournalCommitOptions,
  ): Promise<CommitAck> {
    this.ensureRegistryEntryActive();

    const normalizedRequest = normalizeCommitRequest(request, this.projectId);
    const transactionId = normalizedRequest.transaction.id;
    const requestSha256 = sha256Canonical(normalizedRequest);
    const existing = state.idempotencyByTransactionId.get(transactionId);

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

    if (normalizedRequest.baseRevision !== state.currentRevision) {
      throw createPersistenceError('REVISION_CONFLICT', true, 'Base revision is stale');
    }

    const payload: JournalRecordPayload = {
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      projectId: this.projectId,
      sequence: state.nextSequence,
      revision: state.currentRevision + 1,
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

    const preAppendByteLength = await readJournalByteLength(this.fileSystem, this.activeJournalPath);
    this.ensureRegistryEntryActive();
    let appendAttempted = false;
    let boundaryUpdated = false;
    let handle: Awaited<ReturnType<FileSystem['open']>> | null = null;
    try {
      handle = await this.fileSystem.open(this.activeJournalPath, 'a+');
      this.ensureRegistryEntryActive();
      appendAttempted = true;
      await handle.writeFile(line);
      if (options.syncGate !== undefined) {
        await options.syncGate.wait();
      }
      await handle.sync();
      await writeJournalCommitBoundary(this.fileSystem, this.activeJournalPath, {
        baseRevision: state.baseRevision,
        committedBytes: preAppendByteLength + Buffer.byteLength(line, 'utf8'),
        firstSequence: state.firstSequence,
        lastRevision: record.revision,
        nextSequence: record.sequence + 1,
        projectId: this.projectId,
        updatedAt: record.committedAt,
      });
      boundaryUpdated = true;
    } catch (error) {
      if (handle !== null && appendAttempted && !boundaryUpdated) {
        const rollbackError = await rollbackJournalAppend(
          this.fileSystem,
          this.activeJournalPath,
          handle,
          preAppendByteLength,
        );
        if (rollbackError !== null) {
          state.poisonedError = corruptJournal(
            'Journal durability is uncertain after failed rollback',
            rollbackError,
          );
          throw state.poisonedError;
        }
      }

      throw error;
    } finally {
      if (handle !== null) {
        try {
          await handle.close();
        } catch {
          // Close is cleanup; append durability is decided by sync and rollback.
        }
      }
    }

    const ack = ackFromRecord(record);
    state.currentRevision = record.revision;
    state.nextSequence = record.sequence + 1;
    state.idempotencyByTransactionId.set(transactionId, { ack, requestSha256 });
    return ack;
  }

  private ensureRegistryEntryActive(): void {
    const inactiveError = this.getInactiveRegistryEntryError();
    if (inactiveError !== null) {
      throw inactiveError;
    }
  }

  private getInactiveRegistryEntryError(): PersistenceError | null {
    if (this.state.poisonedError !== null) {
      return this.state.poisonedError;
    }

    if (
      this.registryEntry.released !== null ||
      this.registryEntry.generation !== this.registryGeneration
    ) {
      return this.registryEntry.released ?? createPersistenceError(
        'CONCURRENT_WRITER',
        false,
        'Journal writer is no longer active',
      );
    }

    return null;
  }
}

export function resetJournalWriterRegistryForTests(): void {
  journalRegistry.clear();
}

export function releaseJournalState(activeJournalPath: string, projectId?: string): void {
  const canonicalPath = canonicalJournalPath(activeJournalPath);
  if (projectId !== undefined) {
    const registryKey = canonicalJournalRegistryKey(activeJournalPath, projectId);
    releaseJournalRegistryEntry(journalRegistry.get(registryKey));
    journalRegistry.delete(registryKey);
    return;
  }

  const pathPrefix = `${canonicalPath}\0`;
  for (const [key, entry] of journalRegistry.entries()) {
    if (key.startsWith(pathPrefix)) {
      releaseJournalRegistryEntry(entry);
      journalRegistry.delete(key);
    }
  }
}

export async function runJournalMaintenance<T>(
  options: JournalMaintenanceOptions,
  operation: (context: JournalMaintenanceContext) => Promise<T>,
): Promise<T> {
  const fileSystem = options.fileSystem ?? new NodeFileSystem();
  const registryKey = canonicalJournalRegistryKey(options.activeJournalPath, options.projectId);
  let registryEntry = journalRegistry.get(registryKey);
  if (registryEntry === undefined || registryEntry.released !== null) {
    registryEntry = createJournalRegistryEntry(options, fileSystem);
    journalRegistry.set(registryKey, registryEntry);
  }

  const registryGeneration = registryEntry.generation;
  const state = await registryEntry.initialization;
  registryEntry.state = state;
  const previous = registryEntry.queue;
  const run = previous.then(async () => {
    ensureJournalRegistryEntryActive(registryEntry!, registryGeneration, state);
    const context: JournalMaintenanceContext = {
      activeJournalPath: options.activeJournalPath,
      get currentRevision() {
        return state.currentRevision;
      },
      fileSystem,
      get nextSequence() {
        return state.nextSequence;
      },
      projectId: options.projectId,
      advanceTo(revision: number, nextSequence: number) {
        state.baseRevision = revision;
        state.currentRevision = revision;
        state.firstSequence = nextSequence;
        state.nextSequence = nextSequence;
      },
      poison(error: PersistenceError) {
        state.poisonedError = error;
        return error;
      },
    };
    return operation(context);
  });
  registryEntry.queue = run.then(() => undefined, () => undefined);
  return run;
}

function createJournalRegistryEntry(
  options: JournalWriterOpenOptions,
  fileSystem: FileSystem,
): JournalRegistryEntry {
  return {
    initialization: initializeJournalState(options, fileSystem),
    queue: Promise.resolve(),
    generation: 0,
    released: null,
    state: null,
  };
}

function releaseJournalRegistryEntry(entry: JournalRegistryEntry | undefined): void {
  if (entry === undefined) {
    return;
  }

  const releaseError = entry.released ?? createPersistenceError(
    'CONCURRENT_WRITER',
    false,
    'Journal writer has been released',
  );
  entry.released = releaseError;
  entry.generation += 1;

  if (entry.state !== null && entry.state.poisonedError === null) {
    entry.state.poisonedError = releaseError;
  }
}

function ensureJournalRegistryEntryActive(
  entry: JournalRegistryEntry,
  generation: number,
  state: JournalState,
): void {
  if (state.poisonedError !== null) {
    throw state.poisonedError;
  }

  if (entry.released !== null || entry.generation !== generation) {
    throw entry.released ?? createPersistenceError(
      'CONCURRENT_WRITER',
      false,
      'Journal writer is no longer active',
    );
  }
}

async function initializeJournalState(
  options: JournalWriterOpenOptions,
  fileSystem: FileSystem,
): Promise<JournalState> {
  const journal = await readValidJournal(options.activeJournalPath, {
    baseRevision: options.baseRevision,
    committedOnly: true,
    expectedProjectId: options.projectId,
    fileSystem,
    firstSequence: options.nextSequence,
  });
  await truncateUncommittedJournalTail(fileSystem, options.activeJournalPath, journal.validBytes);
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

  return {
    baseRevision: options.baseRevision,
    currentRevision,
    firstSequence: options.nextSequence,
    idempotencyByTransactionId,
    nextSequence,
    poisonedError: null,
    projectId: options.projectId,
  };
}

function canonicalJournalRegistryKey(activeJournalPath: string, projectId: string): string {
  return `${canonicalJournalPath(activeJournalPath)}\0${projectId}`;
}

function canonicalJournalPath(activeJournalPath: string): string {
  return normalize(resolve(activeJournalPath)).toLowerCase();
}

async function readJournalByteLength(
  fileSystem: FileSystem,
  activeJournalPath: string,
): Promise<number> {
  let stats: Awaited<ReturnType<FileSystem['stat']>>;
  try {
    stats = await fileSystem.stat(activeJournalPath);
  } catch (error) {
    throw createPersistenceError(
      'CORRUPT_JOURNAL',
      false,
      'Journal byte length cannot be confirmed',
      error,
    );
  }

  if (
    typeof stats.size !== 'number' ||
    !Number.isInteger(stats.size) ||
    stats.size < 0
  ) {
    throw createPersistenceError(
      'CORRUPT_JOURNAL',
      false,
      'Journal byte length cannot be confirmed',
    );
  }

  return stats.size;
}

async function truncateUncommittedJournalTail(
  fileSystem: FileSystem,
  activeJournalPath: string,
  committedBytes: number,
): Promise<void> {
  const byteLength = await readJournalByteLength(fileSystem, activeJournalPath);
  if (byteLength === committedBytes) {
    return;
  }
  if (byteLength < committedBytes) {
    throw corruptJournal('Journal is shorter than its durable commit boundary');
  }

  if (fileSystem.truncate === undefined) {
    throw corruptJournal('Journal has an uncommitted tail that cannot be truncated');
  }
  await fileSystem.truncate(activeJournalPath, committedBytes);
}

async function rollbackJournalAppend(
  fileSystem: FileSystem,
  activeJournalPath: string,
  handle: Awaited<ReturnType<FileSystem['open']>>,
  preAppendByteLength: number,
): Promise<unknown | null> {
  try {
    await truncateJournalToByteLength(
      fileSystem,
      activeJournalPath,
      handle,
      preAppendByteLength,
    );
    await handle.sync();

    const rolledBackByteLength = await readJournalByteLength(fileSystem, activeJournalPath);
    if (rolledBackByteLength !== preAppendByteLength) {
      throw createPersistenceError(
        'CORRUPT_JOURNAL',
        false,
        'Journal rollback byte length could not be confirmed',
      );
    }

    return null;
  } catch (error) {
    return error;
  }
}

async function truncateJournalToByteLength(
  fileSystem: FileSystem,
  activeJournalPath: string,
  handle: Awaited<ReturnType<FileSystem['open']>>,
  byteLength: number,
): Promise<void> {
  if (handle.truncate !== undefined) {
    try {
      await handle.truncate(byteLength);
      return;
    } catch {
      // Some Windows append handles cannot truncate; fall back to the path API.
    }
  }

  if (fileSystem.truncate === undefined) {
    throw createPersistenceError(
      'CORRUPT_JOURNAL',
      false,
      'Journal rollback is not supported by this filesystem',
    );
  }

  await fileSystem.truncate(activeJournalPath, byteLength);
}

export async function readValidJournal(
  activeJournalPath: string,
  options: JournalReadOptions = {},
): Promise<JournalReadResult> {
  const fileSystem = options.fileSystem ?? new NodeFileSystem();
  const raw = await fileSystem.readFile(activeJournalPath, 'utf8');
  const boundary = options.committedOnly === true
    ? await readJournalCommitBoundary(fileSystem, activeJournalPath)
    : null;
  const rawBytes = Buffer.byteLength(raw, 'utf8');
  const rawToParse = boundary === null
    ? raw
    : journalTextInsideBoundary(raw, rawBytes, boundary, options);
  const complete = rawToParse.length === 0 || rawToParse.endsWith('\n');
  const tailStatus = complete ? 'complete' : 'partial_final_line';
  const lastCompleteLineEnd = complete ? rawToParse.length : rawToParse.lastIndexOf('\n') + 1;
  const validText = rawToParse.slice(0, lastCompleteLineEnd);
  const boundaryTailStatus = boundary !== null && rawBytes > boundary.committedBytes
    ? 'partial_final_line'
    : tailStatus;
  const validBytes = boundary?.committedBytes ?? Buffer.byteLength(validText, 'utf8');
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

  return { records, tailStatus: boundaryTailStatus, validBytes };
}

export async function writeInitialJournalCommitBoundary(
  fileSystem: FileSystem,
  activeJournalPath: string,
  options: {
    readonly baseRevision: number;
    readonly nextSequence: number;
    readonly projectId: string;
    readonly updatedAt: string;
  },
): Promise<void> {
  await writeJournalCommitBoundary(fileSystem, activeJournalPath, {
    baseRevision: options.baseRevision,
    committedBytes: 0,
    firstSequence: options.nextSequence,
    lastRevision: options.baseRevision,
    nextSequence: options.nextSequence,
    projectId: options.projectId,
    updatedAt: options.updatedAt,
  });
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

async function readJournalCommitBoundary(
  fileSystem: FileSystem,
  activeJournalPath: string,
): Promise<JournalCommitBoundary | null> {
  let raw: string;
  try {
    raw = await fileSystem.readFile(journalCommitBoundaryPath(activeJournalPath), 'utf8');
  } catch {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isJournalCommitBoundary(parsed)) {
      throw new Error('schema');
    }
    return parsed;
  } catch (error) {
    throw corruptJournal('Journal commit boundary is invalid', error);
  }
}

export async function writeJournalCommitBoundary(
  fileSystem: FileSystem,
  activeJournalPath: string,
  boundary: Omit<JournalCommitBoundary, 'journalSha256' | 'schemaVersion'>,
): Promise<void> {
  const bytes = await readFileBytes(fileSystem, activeJournalPath);
  if (boundary.committedBytes > bytes.length) {
    throw corruptJournal('Journal commit boundary exceeds journal length');
  }

  const durableBoundary: JournalCommitBoundary = {
    ...boundary,
    schemaVersion: 1,
    journalSha256: sha256Bytes(bytes.subarray(0, boundary.committedBytes)),
  };
  await writeAtomic(
    fileSystem,
    journalCommitBoundaryPath(activeJournalPath),
    `${canonicalJson(durableBoundary)}\n`,
  );
}

function journalTextInsideBoundary(
  raw: string,
  rawBytes: number,
  boundary: JournalCommitBoundary,
  options: JournalReadOptions,
): string {
  const expectedProjectId = options.expectedProjectId ?? boundary.projectId;
  const expectedBaseRevision = options.baseRevision ?? boundary.baseRevision;
  const expectedFirstSequence = options.firstSequence ?? boundary.firstSequence;

  if (
    boundary.projectId !== expectedProjectId ||
    boundary.baseRevision !== expectedBaseRevision ||
    boundary.firstSequence !== expectedFirstSequence ||
    boundary.committedBytes > rawBytes ||
    boundary.lastRevision < boundary.baseRevision ||
    boundary.nextSequence < boundary.firstSequence
  ) {
    throw corruptJournal('Journal commit boundary does not match expected chain');
  }

  const bytes = Buffer.from(raw, 'utf8');
  const committedBytes = bytes.subarray(0, boundary.committedBytes);
  if (sha256Bytes(committedBytes) !== boundary.journalSha256) {
    throw corruptJournal('Journal commit boundary checksum is invalid');
  }

  const text = committedBytes.toString('utf8');
  if (boundary.committedBytes > 0 && !text.endsWith('\n')) {
    throw corruptJournal('Journal commit boundary does not end on a complete record');
  }
  return text;
}

async function readFileBytes(fileSystem: FileSystem, path: string): Promise<Buffer> {
  if (fileSystem.readFileBuffer !== undefined) {
    return Buffer.from(await fileSystem.readFileBuffer(path));
  }
  return Buffer.from(await fileSystem.readFile(path, 'latin1'), 'latin1');
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function journalCommitBoundaryPath(activeJournalPath: string): string {
  return `${activeJournalPath}.commit.json`;
}

function isJournalCommitBoundary(value: unknown): value is JournalCommitBoundary {
  if (!isPlainRecord(value)) {
    return false;
  }
  return (
    value.schemaVersion === 1 &&
    typeof value.projectId === 'string' &&
    isNonNegativeInteger(value.baseRevision) &&
    value.baseRevision >= 0 &&
    isNonNegativeInteger(value.firstSequence) &&
    value.firstSequence > 0 &&
    isNonNegativeInteger(value.committedBytes) &&
    value.committedBytes >= 0 &&
    isNonNegativeInteger(value.lastRevision) &&
    value.lastRevision >= 0 &&
    isNonNegativeInteger(value.nextSequence) &&
    value.nextSequence > 0 &&
    typeof value.journalSha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(value.journalSha256) &&
    typeof value.updatedAt === 'string'
  );
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
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
