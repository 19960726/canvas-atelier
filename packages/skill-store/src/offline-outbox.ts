import { createHash } from 'node:crypto';
import type { WritebackPlan } from './writeback-flow';
import { consumeWritebackToken, type WritebackTarget, type WritebackTokenRecord } from './writeback-token';

export type WritebackOutboxJobStatus = 'queued' | 'uploading' | 'retry_wait';

export interface WritebackOutboxJob {
  id: string;
  target: WritebackTarget;
  plan: WritebackPlan;
  historyPath: string;
  approvedSnapshot?: { knowledgeBaseId: string; version: number; contentHash: string };
  status: WritebackOutboxJobStatus;
  attemptCount: number;
  createdAt: string;
  updatedAt: string;
  nextRetryAt?: string;
  lastError?: string;
  requiresReauthorization: boolean;
}

export interface WritebackOutboxState { schemaVersion: 1; jobs: WritebackOutboxJob[]; }
interface TimeDeps { now?: () => number; }
interface RandomDeps { random?: () => number; }
interface WritebackAuthorization { approvalToken: string; tokenRecord?: WritebackTokenRecord; }

type PerformWritebackResult =
  | { ok: true; tokenRecord?: WritebackTokenRecord; writtenFiles?: string[]; preservedFiles?: string[]; blockedFiles?: string[] }
  | { ok: false; retryable?: boolean; reason: string; tokenRecord?: WritebackTokenRecord; error?: string };

export function enqueueWritebackJob(
  state: WritebackOutboxState,
  input: { target: WritebackTarget; plan: WritebackPlan; historyPath: string; approvedSnapshot?: { knowledgeBaseId: string; version: number; contentHash: string } },
  deps: TimeDeps & RandomDeps = {},
): WritebackOutboxState {
  const now = deps.now ?? Date.now;
  const random = deps.random ?? Math.random;
  const createdAt = new Date(now()).toISOString();
  const id = createHash('sha256').update(`${input.target}:${input.plan.diffHash}:${createdAt}:${random()}`).digest('hex').slice(0, 16);
  return {
    schemaVersion: 1,
    jobs: [...state.jobs, {
      id,
      target: input.target,
      plan: clonePlan(input.plan),
      historyPath: input.historyPath,
      approvedSnapshot: input.approvedSnapshot ? { ...input.approvedSnapshot } : undefined,
      status: 'queued',
      attemptCount: 0,
      createdAt,
      updatedAt: createdAt,
      requiresReauthorization: true,
    }],
  };
}

export async function drainWritebackOutbox(
  state: WritebackOutboxState,
  input: {
    now?: () => number;
    random?: () => number;
    authorizationByJobId?: Record<string, WritebackAuthorization | undefined>;
    performWriteback: (input: { job: WritebackOutboxJob; authorization: WritebackAuthorization }) => Promise<PerformWritebackResult>;
  },
): Promise<{ state: WritebackOutboxState; processedJobIds: string[] }> {
  let nextState = cloneState(state);
  const processedJobIds: string[] = [];
  const now = input.now ?? Date.now;
  const random = input.random ?? Math.random;

  for (const job of state.jobs) {
    const current = nextState.jobs.find((candidate) => candidate.id === job.id);
    if (!current) continue;
    if (current.status === 'retry_wait' && current.nextRetryAt && Date.parse(current.nextRetryAt) > now()) continue;
    const authorization = input.authorizationByJobId?.[current.id];
    if (!authorization) continue;

    if (authorization.tokenRecord) {
      const preflight = consumeWritebackToken({
        record: authorization.tokenRecord,
        approvalToken: authorization.approvalToken,
        target: current.target,
        diffHash: current.plan.diffHash,
        now,
      });
      if (!preflight.ok) {
        nextState = updateJob(nextState, current.id, {
          status: 'queued',
          updatedAt: new Date(now()).toISOString(),
          requiresReauthorization: true,
          lastError: preflight.reason,
        });
        continue;
      }
    }

    nextState = updateJob(nextState, current.id, {
      status: 'uploading',
      updatedAt: new Date(now()).toISOString(),
      requiresReauthorization: false,
      lastError: undefined,
    });

    const result = await input.performWriteback({ job: current, authorization });
    if (result.ok) {
      nextState = { schemaVersion: 1, jobs: nextState.jobs.filter((candidate) => candidate.id !== current.id) };
      processedJobIds.push(current.id);
      continue;
    }
    if (result.retryable) {
      nextState = updateJob(nextState, current.id, {
        status: 'retry_wait',
        attemptCount: current.attemptCount + 1,
        updatedAt: new Date(now()).toISOString(),
        nextRetryAt: new Date(now() + computeRetryDelayMs(current.attemptCount, random)).toISOString(),
        requiresReauthorization: true,
        lastError: sanitizeError(result.error ?? result.reason),
      });
      continue;
    }
    nextState = updateJob(nextState, current.id, {
      status: 'queued',
      updatedAt: new Date(now()).toISOString(),
      requiresReauthorization: true,
      lastError: sanitizeError(result.error ?? result.reason),
    });
  }
  return { state: nextState, processedJobIds };
}

export function retryWritebackJob(state: WritebackOutboxState, jobId: string, deps: TimeDeps = {}): WritebackOutboxState {
  const now = deps.now ?? Date.now;
  const job = state.jobs.find((candidate) => candidate.id === jobId);
  if (!job || job.status !== 'retry_wait' || !job.nextRetryAt || Date.parse(job.nextRetryAt) > now()) return cloneState(state);
  return updateJob(state, jobId, {
    status: 'queued', updatedAt: new Date(now()).toISOString(), nextRetryAt: undefined, requiresReauthorization: true,
  });
}

export function serializeWritebackOutboxForTransfer(state: WritebackOutboxState) {
  return {
    schemaVersion: 1 as const,
    jobs: state.jobs.map((job) => ({
      id: job.id,
      target: job.target,
      diffHash: job.plan.diffHash,
      status: job.status,
      attemptCount: job.attemptCount,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      nextRetryAt: job.nextRetryAt,
      lastError: sanitizeError(job.lastError),
      requiresReauthorization: true,
      memoryRelativePaths: job.plan.payload.memory.map((file) => file.relativePath),
      approvedSnapshot: job.approvedSnapshot ? { ...job.approvedSnapshot } : undefined,
      originalImagesIncluded: job.plan.payload.originalImages.length > 0,
    })),
  };
}

function cloneState(state: WritebackOutboxState): WritebackOutboxState {
  return { schemaVersion: 1, jobs: state.jobs.map((job) => ({ ...job, plan: clonePlan(job.plan) })) };
}
function clonePlan(plan: WritebackPlan): WritebackPlan {
  const cloneFile = (file: WritebackPlan['payload']['memory'][number]) => ({ ...file, content: Array.isArray(file.content) ? [...file.content] : file.content });
  return {
    ...plan,
    diff: plan.diff.map((entry) => ({ ...entry })),
    roots: { ...plan.roots },
    targets: {
      source: {
        writeFiles: plan.targets.source.writeFiles.map(cloneFile),
        preservedFiles: plan.targets.source.preservedFiles.map((file) => ({ ...file })),
        blockedFiles: plan.targets.source.blockedFiles.map((file) => ({ ...file })),
      },
      app: {
        writeFiles: plan.targets.app.writeFiles.map(cloneFile),
        preservedFiles: plan.targets.app.preservedFiles.map((file) => ({ ...file })),
        blockedFiles: plan.targets.app.blockedFiles.map((file) => ({ ...file })),
      },
    },
    payload: { memory: plan.payload.memory.map(cloneFile), originalImages: plan.payload.originalImages.map(cloneFile) },
  };
}
function updateJob(state: WritebackOutboxState, jobId: string, patch: Partial<WritebackOutboxJob>): WritebackOutboxState {
  return { schemaVersion: 1, jobs: state.jobs.map((job) => job.id === jobId ? { ...job, ...patch } : job) };
}
function computeRetryDelayMs(attemptCount: number, random: () => number): number {
  const base = 1_000;
  return Math.min(Math.min(base * (2 ** attemptCount), 30_000) + Math.floor(random() * base), 30_000);
}
function sanitizeError(value: string | undefined): string | undefined {
  if (!value) return value;
  return value
    .replace(/Bearer\s+\S+/gi, '[REDACTED_AUTH]')
    .replace(/[A-Za-z]:\\(?:[^\\\s\"]+\\)*[^\\\s\"]+/g, '[REDACTED_PATH]')
    .replace(/\\\\[^\\\s"]+\\(?:[^\\\s"]+\\)*[^\\\s"]+/g, '[REDACTED_PATH]')
    .replace(/(?:^|\s)\/(?:Users|home|var|etc)\/[^\s"]+/g, (match) => `${match.startsWith(' ') ? ' ' : ''}[REDACTED_PATH]`)
    .replace(/(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{16,}={0,2}(?![A-Za-z0-9+/])/g, '[REDACTED_BASE64]');
}
