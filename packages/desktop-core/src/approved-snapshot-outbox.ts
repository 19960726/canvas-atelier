import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { dirname, join, resolve } from 'node:path';
import { URL } from 'node:url';

import {
  drainWritebackOutbox,
  enqueueWritebackJob,
  MemorySyncClient,
  serializeWritebackOutboxForTransfer,
  type KnowledgeSnapshot,
  type MemorySyncFetch,
  type WritebackOutboxState,
  type WritebackPlan,
} from '@agent-canvas/skill-store';

import { canonicalJson } from './canonical-json.js';
import { type FileSystem, NodeFileSystem, writeAtomic } from './file-system.js';

export interface ApprovedSnapshotSyncClient {
  uploadApprovedSnapshot(
    snapshot: KnowledgeSnapshot,
    options: { readonly idempotencyKey: string },
  ): Promise<unknown>;
}

export interface ApprovedSnapshotReadableStore {
  readVersion(knowledgeBaseId: string, version: number): Promise<KnowledgeSnapshot | null>;
}

export interface ApprovedSnapshotOutboxOptions {
  readonly appDataRoot: string;
  readonly client?: ApprovedSnapshotSyncClient;
  readonly fileSystem?: FileSystem;
  readonly now?: () => number;
  readonly random?: () => number;
  readonly store: ApprovedSnapshotReadableStore;
}

export interface ApprovedSnapshotSyncEnvironment {
  readonly NOVUS_KNOWLEDGE_SYNC_TOKEN?: string;
  readonly NOVUS_KNOWLEDGE_SYNC_URL?: string;
  readonly NOVUS_MEMORY_SYNC_TOKEN?: string;
  readonly NOVUS_MEMORY_SYNC_URL?: string;
}

export interface ApprovedSnapshotOutboxDrainHandle {
  drainNow(): Promise<void>;
  stop(): void;
}

export interface ApprovedSnapshotOutboxDrainOptions {
  readonly client: ApprovedSnapshotSyncClient | null;
  readonly clearInterval?: (handle: unknown) => void;
  readonly intervalMs?: number;
  readonly isOnline?: () => boolean;
  readonly outbox: Pick<ApprovedSnapshotOutbox, 'drainApprovedSnapshots'>;
  readonly setInterval?: (listener: () => void, intervalMs: number) => unknown;
}

const DEFAULT_APPROVED_SNAPSHOT_DRAIN_INTERVAL_MS = 30_000;
const MAX_SYNC_RESPONSE_BYTES = 4 * 1024 * 1024;

export class ApprovedSnapshotOutbox {
  private readonly appDataRoot: string;
  private readonly client: ApprovedSnapshotSyncClient | null;
  private readonly fileSystem: FileSystem;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly store: ApprovedSnapshotReadableStore;

  constructor(options: ApprovedSnapshotOutboxOptions) {
    this.appDataRoot = resolve(options.appDataRoot);
    this.client = options.client ?? null;
    this.fileSystem = options.fileSystem ?? new NodeFileSystem();
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.store = options.store;
  }

  async enqueueApprovedSnapshot(snapshot: KnowledgeSnapshot): Promise<void> {
    const state = await this.readState();
    const approvedSnapshot = {
      knowledgeBaseId: snapshot.knowledgeBaseId,
      version: snapshot.version,
      contentHash: snapshot.contentHash,
    };
    const alreadyQueued = state.jobs.some((job) => (
      job.approvedSnapshot?.knowledgeBaseId === approvedSnapshot.knowledgeBaseId &&
      job.approvedSnapshot.version === approvedSnapshot.version &&
      job.approvedSnapshot.contentHash === approvedSnapshot.contentHash
    ));
    if (alreadyQueued) {
      return;
    }

    await this.writeState(enqueueWritebackJob(state, {
      approvedSnapshot,
      historyPath: 'approved-snapshot-sync',
      plan: createApprovedSnapshotPlan(approvedSnapshot),
      target: 'source',
    }, {
      now: this.now,
      random: this.random,
    }));
  }

  async drainApprovedSnapshots(client: ApprovedSnapshotSyncClient | null = this.client): Promise<{
    readonly processedJobIds: string[];
    readonly state: WritebackOutboxState;
  }> {
    const state = await this.readState();
    if (client === null) {
      return {
        processedJobIds: [],
        state,
      };
    }

    const authorizationByJobId = Object.fromEntries(state.jobs.map((job) => [
      job.id,
      { approvalToken: 'approved-snapshot-sync' },
    ]));
    const drained = await drainWritebackOutbox(state, {
      authorizationByJobId,
      now: this.now,
      random: this.random,
      performWriteback: async ({ job }) => {
        const approved = job.approvedSnapshot;
        if (approved === undefined) {
          return { ok: true };
        }
        const snapshot = await this.store.readVersion(approved.knowledgeBaseId, approved.version);
        if (snapshot === null || snapshot.contentHash !== approved.contentHash) {
          return {
            ok: false,
            reason: 'missing_approved_snapshot',
            retryable: true,
          };
        }
        try {
          await client.uploadApprovedSnapshot(snapshot, { idempotencyKey: job.id });
          return { ok: true };
        } catch (error) {
          return {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            reason: 'approved_snapshot_upload_failed',
            retryable: true,
          };
        }
      },
    });
    await this.writeState(drained.state);
    return drained;
  }

  async readPublicState(): Promise<ReturnType<typeof serializeWritebackOutboxForTransfer>> {
    return serializeWritebackOutboxForTransfer(await this.readState());
  }

  private async readState(): Promise<WritebackOutboxState> {
    try {
      const raw = await this.fileSystem.readFile(this.statePath(), 'utf8');
      return normalizeOutboxState(JSON.parse(raw) as unknown);
    } catch (error) {
      if (isMissingFileError(error)) {
        return { schemaVersion: 1, jobs: [] };
      }
      throw error;
    }
  }

  private async writeState(state: WritebackOutboxState): Promise<void> {
    await this.fileSystem.mkdir(dirname(this.statePath()), { recursive: true });
    await writeAtomic(
      this.fileSystem,
      this.statePath(),
      `${canonicalJson(normalizeOutboxState(state))}\n`,
    );
  }

  private statePath(): string {
    return join(this.appDataRoot, 'sync', 'approved-snapshot-outbox.json');
  }
}

export function createApprovedSnapshotSyncClientFromEnv(
  env: ApprovedSnapshotSyncEnvironment,
  fetch: MemorySyncFetch = createNodeMemorySyncFetch(),
): ApprovedSnapshotSyncClient | null {
  const baseUrl = firstConfiguredValue(env.NOVUS_KNOWLEDGE_SYNC_URL, env.NOVUS_MEMORY_SYNC_URL);
  const token = firstConfiguredValue(env.NOVUS_KNOWLEDGE_SYNC_TOKEN, env.NOVUS_MEMORY_SYNC_TOKEN);
  if (baseUrl === null || token === null) {
    return null;
  }
  return new MemorySyncClient({
    baseUrl,
    fetch,
    tokenSupplier: async () => token,
  });
}

export function startApprovedSnapshotOutboxDrain(
  options: ApprovedSnapshotOutboxDrainOptions,
): ApprovedSnapshotOutboxDrainHandle {
  const clearTimer: (handle: unknown) => void = options.clearInterval
    ?? ((handle) => globalThis.clearInterval(handle as ReturnType<typeof globalThis.setInterval>));
  const intervalMs = options.intervalMs ?? DEFAULT_APPROVED_SNAPSHOT_DRAIN_INTERVAL_MS;
  const isOnline = options.isOnline ?? (() => true);
  const setTimer: (listener: () => void, intervalMs: number) => unknown = options.setInterval
    ?? ((listener, ms) => globalThis.setInterval(listener, ms));
  let stopped = false;
  let inFlight: Promise<void> | null = null;

  const drainNow = async (): Promise<void> => {
    if (stopped || options.client === null || !isOnline()) {
      return;
    }
    if (inFlight !== null) {
      return inFlight;
    }
    inFlight = options.outbox
      .drainApprovedSnapshots(options.client)
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };
  const timer = options.client === null
    ? null
    : setTimer(() => {
      void drainNow();
    }, intervalMs);
  void drainNow();

  return {
    drainNow,
    stop() {
      stopped = true;
      if (timer !== null) {
        clearTimer(timer);
      }
    },
  };
}

function firstConfiguredValue(...values: (string | undefined)[]): string | null {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return null;
}

function createNodeMemorySyncFetch(): MemorySyncFetch {
  return async (url, init = {}) => new Promise((resolvePromise, reject) => {
    const parsedUrl = new URL(url);
    const request = parsedUrl.protocol === 'https:'
      ? httpsRequest
      : parsedUrl.protocol === 'http:'
        ? httpRequest
        : null;
    if (request === null) {
      reject(new Error('knowledge sync URL must use http or https'));
      return;
    }

    const outgoing = request(parsedUrl, {
      headers: init.headers,
      method: init.method ?? 'GET',
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        body += chunk;
        if (body.length > MAX_SYNC_RESPONSE_BYTES) {
          outgoing.destroy(new Error('knowledge sync response exceeded the maximum size'));
        }
      });
      response.on('end', () => {
        const status = response.statusCode ?? 0;
        resolvePromise({
          ok: status >= 200 && status < 300,
          status,
          json: async () => (body.length === 0 ? null : JSON.parse(body) as unknown),
        });
      });
    });
    outgoing.on('error', reject);
    if (init.body !== undefined) {
      outgoing.write(init.body);
    }
    outgoing.end();
  });
}

function createApprovedSnapshotPlan(snapshot: {
  readonly knowledgeBaseId: string;
  readonly version: number;
  readonly contentHash: string;
}): WritebackPlan {
  const diffHash = createHash('sha256')
    .update(canonicalJson({ approvedSnapshot: snapshot }), 'utf8')
    .digest('hex');
  return {
    diffHash,
    diff: [],
    targets: {
      source: { writeFiles: [], preservedFiles: [], blockedFiles: [] },
      app: { writeFiles: [], preservedFiles: [], blockedFiles: [] },
    },
    payload: { memory: [], originalImages: [] },
    roots: { baseRoot: '.', appRoot: '.', sourceRoot: '.' },
  };
}

function normalizeOutboxState(value: unknown): WritebackOutboxState {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.jobs)) {
    throw new Error('Approved snapshot outbox state is invalid');
  }
  return value as unknown as WritebackOutboxState;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isMissingFileError(error: unknown): boolean {
  return isRecord(error) && error.code === 'ENOENT';
}
