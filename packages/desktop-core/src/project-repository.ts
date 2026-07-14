import { basename, dirname, join, normalize, relative, sep } from 'node:path';

import { canonicalJson, sha256Canonical } from './canonical-json.js';
import {
  PROJECT_FORMAT_VERSION,
  PROJECT_LOCK_SCHEMA_VERSION,
  SNAPSHOT_SCHEMA_VERSION,
  STALE_LOCK_MS,
  type PersistenceChannel,
  type ProjectLock,
  type ProjectManifest,
  type SnapshotEnvelope,
} from './contracts.js';
import { type FileSystem, NodeFileSystem, writeAtomic } from './file-system.js';

type ProjectState = Record<string, unknown>;
type ProcessLiveness = boolean | 'unknown';

export const MAX_WIN7_PROJECT_ROOT_PATH_LENGTH = 180;

export interface OpenedProjectSession {
  readonly root: string;
  readonly manifest: ProjectManifest;
  readonly mode: 'write' | 'read_only';
  readonly lock: ProjectLock | null;
}

export interface CreateProjectOptions {
  readonly project: ProjectState;
  readonly projectId?: string;
  readonly projectName?: string;
}

export interface OpenProjectOptions {
  readonly mode: 'write' | 'read_only';
}

export interface ProjectRepositoryOptions {
  readonly channel?: PersistenceChannel;
  readonly createId?: () => string;
  readonly deviceId?: string;
  readonly fileSystem?: FileSystem;
  readonly isLocalProcessAlive?: (processId: number) => ProcessLiveness | Promise<ProcessLiveness>;
  readonly now?: () => Date;
  readonly processId?: number;
}

interface CleanCloseMarker {
  readonly clean: boolean;
  readonly closedAt: string | null;
}

interface LockDecision {
  readonly mode: 'write' | 'read_only';
  readonly lock: ProjectLock | null;
}

const ACTIVE_JOURNAL_SEGMENT = 'journal/active.ndjson';
const CLEAN_CLOSE_PATH = 'recovery/clean-close.json';
const LOCK_PATH = 'recovery/project.lock';
const PROJECT_MANIFEST_PATH = 'project.novus.json';

const PROJECT_DIRECTORIES = [
  'assets',
  'indexes',
  'journal',
  'journal/archive',
  'recovery',
  'recovery/quarantine',
  'snapshots',
];

export class ProjectRepository {
  private readonly channel: PersistenceChannel;
  private readonly createId: () => string;
  private readonly deviceId: string;
  private readonly fileSystem: FileSystem;
  private readonly isLocalProcessAlive: (
    processId: number,
  ) => ProcessLiveness | Promise<ProcessLiveness>;
  private readonly now: () => Date;
  private readonly processId: number;

  constructor(options: ProjectRepositoryOptions = {}) {
    this.channel = options.channel ?? 'modern';
    this.createId = options.createId ?? (() => `id-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    this.deviceId = options.deviceId ?? 'local-device';
    this.fileSystem = options.fileSystem ?? new NodeFileSystem();
    this.isLocalProcessAlive = options.isLocalProcessAlive ?? defaultProcessAlive;
    this.now = options.now ?? (() => new Date());
    this.processId = options.processId ?? process.pid;
  }

  async create(root: string, options: CreateProjectOptions): Promise<OpenedProjectSession> {
    assertSafeWin7ProjectRoot(root);

    const projectId = options.projectId ?? this.createId();
    const projectName = options.projectName ?? basename(root, '.novus-project');
    const snapshotId = this.createId();
    const snapshotPath = normalizeInternalPath(join('snapshots', `revision-0-${snapshotId}.json`));
    const createdAt = this.nowIso();

    await this.fileSystem.mkdir(root, { recursive: false });
    for (const directory of PROJECT_DIRECTORIES) {
      await this.fileSystem.mkdir(join(root, ...directory.split('/')), { recursive: true });
    }

    const snapshot = createSnapshot({
      createdAt,
      project: options.project,
      projectId,
      revision: 0,
      snapshotId,
    });
    await writeJsonAtomic(this.fileSystem, join(root, ...snapshotPath.split('/')), snapshot);
    await this.verifySnapshot(root, snapshotPath, projectId, 0);

    await writeAtomic(this.fileSystem, join(root, ...ACTIVE_JOURNAL_SEGMENT.split('/')), '');
    await writeJsonAtomic(this.fileSystem, join(root, ...CLEAN_CLOSE_PATH.split('/')), {
      clean: false,
      closedAt: null,
    } satisfies CleanCloseMarker);

    const manifest = createManifest({
      cleanClose: false,
      projectId,
      projectName,
      snapshotId,
      snapshotPath,
    });
    await writeJsonAtomic(this.fileSystem, join(root, PROJECT_MANIFEST_PATH), manifest);

    const lock = await this.writeExclusiveLock(root, projectId);
    return {
      lock,
      manifest,
      mode: 'write',
      root,
    };
  }

  async open(root: string, options: OpenProjectOptions): Promise<OpenedProjectSession> {
    const manifest = await this.readManifest(root);

    if (options.mode !== 'write') {
      return { lock: null, manifest, mode: 'read_only', root };
    }

    assertSafeWin7ProjectRoot(root);

    const lockDecision = await this.tryAcquireWriteLock(root, manifest.projectId);
    if (lockDecision.mode !== 'write' || lockDecision.lock === null) {
      return { lock: null, manifest, mode: 'read_only', root };
    }

    const reopenedManifest = {
      ...manifest,
      cleanClose: false,
    };
    await writeJsonAtomic(this.fileSystem, join(root, PROJECT_MANIFEST_PATH), reopenedManifest);
    await writeJsonAtomic(this.fileSystem, join(root, ...CLEAN_CLOSE_PATH.split('/')), {
      clean: false,
      closedAt: null,
    } satisfies CleanCloseMarker);

    return {
      lock: lockDecision.lock,
      manifest: reopenedManifest,
      mode: 'write',
      root,
    };
  }

  async close(session: OpenedProjectSession): Promise<void> {
    if (session.mode !== 'write' || session.lock === null) {
      return;
    }

    const closedAt = this.nowIso();
    const manifest = {
      ...session.manifest,
      cleanClose: true,
    };

    await writeJsonAtomic(this.fileSystem, join(session.root, PROJECT_MANIFEST_PATH), manifest);
    await writeJsonAtomic(this.fileSystem, join(session.root, ...CLEAN_CLOSE_PATH.split('/')), {
      clean: true,
      closedAt,
    } satisfies CleanCloseMarker);

    await this.removeOwnedLock(session.root, session.lock);
  }

  async saveAs(session: OpenedProjectSession, destinationRoot: string): Promise<OpenedProjectSession> {
    assertSafeWin7ProjectRoot(destinationRoot);

    const project = await this.readStableProject(session.root, session.manifest);
    return this.create(destinationRoot, {
      project,
      projectId: this.createId(),
      projectName: basename(destinationRoot, '.novus-project'),
    });
  }

  private async tryAcquireWriteLock(root: string, projectId: string): Promise<LockDecision> {
    const lock = await this.tryWriteNewLock(root, projectId);
    if (lock !== null) {
      return { lock, mode: 'write' };
    }

    const existingLock = await this.readExistingLock(root);
    if (!isValidProjectLock(existingLock, projectId)) {
      return { lock: null, mode: 'read_only' };
    }

    if (!this.isStale(existingLock)) {
      return { lock: null, mode: 'read_only' };
    }

    if (existingLock.deviceId !== this.deviceId) {
      return { lock: null, mode: 'read_only' };
    }

    const localLiveness = await this.isLocalProcessAlive(existingLock.processId);
    if (localLiveness !== false) {
      return { lock: null, mode: 'read_only' };
    }

    await this.fileSystem.unlink(join(root, ...LOCK_PATH.split('/')));

    const reclaimedLock = await this.tryWriteNewLock(root, projectId);
    if (reclaimedLock === null) {
      return { lock: null, mode: 'read_only' };
    }

    return { lock: reclaimedLock, mode: 'write' };
  }

  private async writeExclusiveLock(root: string, projectId: string): Promise<ProjectLock> {
    const lock = await this.tryWriteNewLock(root, projectId);
    if (lock === null) {
      throw new Error('Concurrent writer lock already exists');
    }
    return lock;
  }

  private async tryWriteNewLock(root: string, projectId: string): Promise<ProjectLock | null> {
    const openedAt = this.nowIso();
    const lock: ProjectLock = {
      schemaVersion: PROJECT_LOCK_SCHEMA_VERSION,
      projectId,
      deviceId: this.deviceId,
      processId: this.processId,
      channel: this.channel,
      sessionId: this.createId(),
      openedAt,
      heartbeatAt: openedAt,
    };

    const lockPath = join(root, ...LOCK_PATH.split('/'));
    let handle = null as Awaited<ReturnType<FileSystem['open']>> | null;
    try {
      handle = await this.fileSystem.open(lockPath, 'wx');
      await handle.writeFile(`${canonicalJson(lock)}\n`);
      await handle.sync();
      await handle.close();
      return lock;
    } catch (error) {
      if (handle !== null) {
        try {
          await handle.close();
        } catch {
          // Preserve the lock acquisition failure.
        }
      }

      if (isErrno(error, 'EEXIST')) {
        return null;
      }
      throw error;
    }
  }

  private async readExistingLock(root: string): Promise<unknown> {
    try {
      return JSON.parse(await this.fileSystem.readFile(join(root, ...LOCK_PATH.split('/')), 'utf8'));
    } catch {
      return null;
    }
  }

  private async readManifest(root: string): Promise<ProjectManifest> {
    return JSON.parse(
      await this.fileSystem.readFile(join(root, PROJECT_MANIFEST_PATH), 'utf8'),
    ) as ProjectManifest;
  }

  private async readStableProject(root: string, manifest: ProjectManifest): Promise<ProjectState> {
    if (manifest.stableSnapshotPath === null) {
      return {};
    }

    const snapshot = JSON.parse(
      await this.fileSystem.readFile(join(root, ...manifest.stableSnapshotPath.split('/')), 'utf8'),
    ) as SnapshotEnvelope;

    return snapshot.project;
  }

  private async removeOwnedLock(root: string, lock: ProjectLock): Promise<void> {
    const lockPath = join(root, ...LOCK_PATH.split('/'));
    const existingLock = await this.readExistingLock(root);
    if (isValidProjectLock(existingLock, lock.projectId) && existingLock.sessionId === lock.sessionId) {
      await this.fileSystem.unlink(lockPath);
    }
  }

  private async verifySnapshot(
    root: string,
    snapshotPath: string,
    projectId: string,
    revision: number,
  ): Promise<void> {
    const snapshot = JSON.parse(
      await this.fileSystem.readFile(join(root, ...snapshotPath.split('/')), 'utf8'),
    ) as SnapshotEnvelope;

    if (
      snapshot.schemaVersion !== SNAPSHOT_SCHEMA_VERSION ||
      snapshot.projectId !== projectId ||
      snapshot.revision !== revision ||
      snapshot.projectSha256 !== sha256Canonical(snapshot.project)
    ) {
      throw new Error('Failed to verify revision-0 snapshot');
    }
  }

  private isStale(lock: ProjectLock): boolean {
    const heartbeatMs = Date.parse(lock.heartbeatAt);
    if (!Number.isFinite(heartbeatMs)) {
      return false;
    }

    return this.now().getTime() - heartbeatMs >= STALE_LOCK_MS;
  }

  private nowIso(): string {
    return this.now().toISOString();
  }
}

function createManifest(options: {
  readonly cleanClose: boolean;
  readonly projectId: string;
  readonly projectName: string;
  readonly snapshotId: string;
  readonly snapshotPath: string;
}): ProjectManifest {
  return {
    projectId: options.projectId,
    projectName: options.projectName,
    formatVersion: PROJECT_FORMAT_VERSION,
    stableSnapshotId: options.snapshotId,
    stableSnapshotPath: options.snapshotPath,
    stableSnapshotRevision: 0,
    activeJournalSegment: ACTIVE_JOURNAL_SEGMENT,
    nextSequence: 1,
    assetInventory: {
      assetCount: 0,
      totalBytes: 0,
    },
    cleanClose: options.cleanClose,
    minimumCompatibleWriterVersion: PROJECT_FORMAT_VERSION,
  };
}

function createSnapshot(options: {
  readonly createdAt: string;
  readonly project: ProjectState;
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
    createdAt: options.createdAt,
    project: options.project,
    projectSha256: sha256Canonical(options.project),
  };
}

async function writeJsonAtomic(fileSystem: FileSystem, path: string, value: unknown): Promise<void> {
  await writeAtomic(fileSystem, path, `${canonicalJson(value)}\n`);
}

function normalizeInternalPath(path: string): string {
  return path.split(sep).join('/');
}

function assertSafeWin7ProjectRoot(root: string): void {
  const normalizedRoot = normalize(root);

  // Conservative Windows 7 guard: keep the project root well below MAX_PATH so
  // short internal files can be created without relying on long-path support.
  if (normalizedRoot.length > MAX_WIN7_PROJECT_ROOT_PATH_LENGTH) {
    throw new Error(
      `Project root is too long for Win7 compatibility; limit is ${MAX_WIN7_PROJECT_ROOT_PATH_LENGTH} characters`,
    );
  }

  const relativeFromParent = relative(dirname(normalizedRoot), normalizedRoot);
  if (relativeFromParent.includes('..')) {
    throw new Error('Project root must stay inside its parent directory');
  }
}

function isValidProjectLock(value: unknown, projectId: string): value is ProjectLock {
  if (value === null || typeof value !== 'object') {
    return false;
  }

  const lock = value as Partial<ProjectLock>;
  return (
    lock.schemaVersion === PROJECT_LOCK_SCHEMA_VERSION &&
    lock.projectId === projectId &&
    typeof lock.deviceId === 'string' &&
    typeof lock.processId === 'number' &&
    (lock.channel === 'legacy' || lock.channel === 'modern') &&
    typeof lock.sessionId === 'string' &&
    typeof lock.openedAt === 'string' &&
    typeof lock.heartbeatAt === 'string'
  );
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function defaultProcessAlive(processId: number): ProcessLiveness {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    if (isErrno(error, 'ESRCH')) {
      return false;
    }
    return 'unknown';
  }
}
