import { describe, expect, it } from 'vitest';
import type { WritebackPlan } from './writeback-flow';
import { drainWritebackOutbox, enqueueWritebackJob, retryWritebackJob, serializeWritebackOutboxForTransfer, type WritebackOutboxState } from './offline-outbox';
import { SkillWritebackService } from './writeback-flow';
import { createWritebackToken } from './writeback-token';

const issuedAtMs = Date.parse('2026-07-13T12:00:00.000Z');

describe('offline writeback outbox', () => {
  it('enqueues a serializable job that survives restart and stays blocked until reauthorized', async () => {
    const plan = createPlan();
    const initial = createEmptyState();
    const queued = enqueueWritebackJob(initial, {
      target: 'source',
      plan,
      historyPath: 'C:\\private\\agent\\memory\\writeback-history.log',
    }, { now: () => issuedAtMs, random: () => 0 });

    expect(JSON.parse(JSON.stringify(queued))).toEqual(queued);
    expect(queued.jobs[0]).toMatchObject({
      status: 'queued',
      requiresReauthorization: true,
      target: 'source',
      historyPath: 'C:\\private\\agent\\memory\\writeback-history.log',
    });
    expect(queued.jobs[0]?.plan.roots.sourceRoot).toBe('C:\\managed\\source');
    const transferred = serializeWritebackOutboxForTransfer(queued);
    expect(JSON.stringify(transferred)).not.toContain('C:\\private\\agent');
    expect(JSON.stringify(transferred)).not.toContain('C:\\managed');
    expect(JSON.stringify(transferred)).not.toMatch(/Bearer|QWxhZGRpb/);

    const restarted = JSON.parse(JSON.stringify(queued)) as WritebackOutboxState;
    const drained = await drainWritebackOutbox(restarted, {
      now: () => issuedAtMs + 1,
      performWriteback: async () => {
        throw new Error('should not attempt without authorization');
      },
    });

    expect(drained.state.jobs[0]).toMatchObject({
      status: 'queued',
      requiresReauthorization: true,
      attemptCount: 0,
    });
    expect(drained.processedJobIds).toEqual([]);
  });

  it('removes a job after a successful authorized drain and never persists the raw approval token', async () => {
    const plan = createPlan();
    const queued = enqueueWritebackJob(createEmptyState(), {
      target: 'source',
      plan,
      historyPath: 'C:\\private\\agent\\memory\\writeback-history.log',
    }, { now: () => issuedAtMs, random: () => 0.125 });
    const job = queued.jobs[0]!;
    const token = createWritebackToken(
      { target: 'source', diffHash: plan.diffHash, ttlMs: 30_000 },
      { now: () => issuedAtMs, random: () => 0.25 },
    );

    const drained = await drainWritebackOutbox(queued, {
      now: () => issuedAtMs + 10,
      authorizationByJobId: {
        [job.id]: {
          approvalToken: token.approvalToken,
          tokenRecord: token.record,
        },
      },
      performWriteback: async ({ authorization }) => ({
        ok: true,
        tokenRecord: authorization.tokenRecord,
        writtenFiles: ['memory/main-memory.md'],
        preservedFiles: [],
        blockedFiles: [],
      }),
    });

    expect(drained.state.jobs).toEqual([]);
    expect(JSON.stringify(drained.state)).not.toContain(token.approvalToken);
    expect(drained.processedJobIds).toEqual([job.id]);
  });

  it('moves transient failures into retry_wait with bounded exponential backoff and sanitized errors', async () => {
    const plan = createPlan();
    const queued = enqueueWritebackJob(createEmptyState(), {
      target: 'source',
      plan,
      historyPath: 'C:\\private\\agent\\memory\\writeback-history.log',
    }, { now: () => issuedAtMs, random: () => 0.5 });
    const job = queued.jobs[0]!;
    const token = createWritebackToken(
      { target: 'source', diffHash: plan.diffHash, ttlMs: 30_000 },
      { now: () => issuedAtMs, random: () => 0.75 },
    );

    const firstFailure = await drainWritebackOutbox(queued, {
      now: () => issuedAtMs + 20,
      random: () => 0,
      authorizationByJobId: {
        [job.id]: {
          approvalToken: token.approvalToken,
          tokenRecord: token.record,
        },
      },
      performWriteback: async () => ({
        ok: false,
        retryable: true,
        reason: 'provider offline',
        tokenRecord: token.record,
        error: 'Bearer secret-token C:\\private\\agent\\memory\\main-memory.md QWxhZGRpbjpvcGVuIHNlc2FtZQ==',
      }),
    });

    expect(firstFailure.state.jobs[0]).toMatchObject({
      status: 'retry_wait',
      attemptCount: 1,
      requiresReauthorization: true,
      lastError: '[REDACTED_AUTH] [REDACTED_PATH] [REDACTED_BASE64]',
      nextRetryAt: '2026-07-13T12:00:01.020Z',
    });

    const stillWaiting = retryWritebackJob(firstFailure.state, job.id, { now: () => issuedAtMs + 500 });
    expect(stillWaiting.jobs[0]?.status).toBe('retry_wait');

    const ready = retryWritebackJob(firstFailure.state, job.id, { now: () => issuedAtMs + 1_020 });
    expect(ready.jobs[0]).toMatchObject({
      status: 'queued',
      requiresReauthorization: true,
      attemptCount: 1,
    });

    const reauthorized = createWritebackToken(
      { target: 'source', diffHash: plan.diffHash, ttlMs: 30_000 },
      { now: () => issuedAtMs + 1_000, random: () => 0.9 },
    );
    const secondFailure = await drainWritebackOutbox(ready, {
      now: () => issuedAtMs + 2_000,
      random: () => 0,
      authorizationByJobId: {
        [job.id]: {
          approvalToken: reauthorized.approvalToken,
          tokenRecord: reauthorized.record,
        },
      },
      performWriteback: async () => ({
        ok: false,
        retryable: true,
        reason: 'provider offline',
        tokenRecord: reauthorized.record,
        error: 'Bearer again',
      }),
    });
    expect(secondFailure.state.jobs[0]?.nextRetryAt).toBe('2026-07-13T12:00:04.000Z');
  });

  it('keeps authorization failures queued with no writes until the user supplies a fresh token', async () => {
    const plan = createPlan();
    const queued = enqueueWritebackJob(createEmptyState(), {
      target: 'source',
      plan,
      historyPath: 'C:\\private\\agent\\memory\\writeback-history.log',
    }, { now: () => issuedAtMs, random: () => 0.3 });
    const job = queued.jobs[0]!;
    const expired = createWritebackToken(
      { target: 'source', diffHash: plan.diffHash, ttlMs: 1 },
      { now: () => issuedAtMs, random: () => 0.4 },
    );

    const blocked = await drainWritebackOutbox(queued, {
      now: () => issuedAtMs + 2,
      authorizationByJobId: {
        [job.id]: {
          approvalToken: expired.approvalToken,
          tokenRecord: expired.record,
        },
      },
      performWriteback: async () => {
        throw new Error('should not run when token validation fails');
      },
    });

    expect(blocked.state.jobs[0]).toMatchObject({
      status: 'queued',
      requiresReauthorization: true,
      attemptCount: 0,
      lastError: 'expired',
    });
  });
});

function createEmptyState(): WritebackOutboxState {
  return {
    schemaVersion: 1,
    jobs: [],
  };
}

function createPlan(): WritebackPlan {
  return {
    diffHash: 'diff-1',
    diff: [],
    targets: {
      source: {
        writeFiles: [{ relativePath: 'memory/main-memory.md', content: 'app main' }],
        preservedFiles: [],
        blockedFiles: [],
      },
      app: {
        writeFiles: [],
        preservedFiles: [],
        blockedFiles: [],
      },
    },
    payload: {
      memory: [{ relativePath: 'memory/main-memory.md', content: 'app main' }],
      originalImages: [],
    },
    roots: {
      baseRoot: 'C:\\managed\\base',
      appRoot: 'C:\\managed\\app',
      sourceRoot: 'C:\\managed\\source',
    },
  };
}

it('resumes a persisted local outbox job with fresh authorization and the real writeback executor', async () => {
  const root = await import('node:fs/promises').then(async ({ mkdir, mkdtemp, writeFile }) => {
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const directory = await mkdtemp(join(tmpdir(), 'outbox-restart-'));
    const roots = { baseRoot: join(directory, 'base'), appRoot: join(directory, 'app'), sourceRoot: join(directory, 'source') };
    await Promise.all(Object.values(roots).map((value) => mkdir(join(value, 'memory'), { recursive: true })));
    await writeFile(join(roots.baseRoot, 'memory', 'main-memory.md'), 'base', 'utf8');
    await writeFile(join(roots.appRoot, 'memory', 'main-memory.md'), 'app', 'utf8');
    await writeFile(join(roots.sourceRoot, 'memory', 'main-memory.md'), 'base', 'utf8');
    return { ...roots, join };
  });
  const { planWritebackTargets } = await import('./writeback-flow');
  const plan = await planWritebackTargets(root);
  const queued = enqueueWritebackJob(createEmptyState(), {
    target: 'source',
    plan,
    historyPath: root.join(root.appRoot, 'memory', 'writeback-history.log'),
  }, { now: () => issuedAtMs, random: () => 0.6 });
  const restarted = JSON.parse(JSON.stringify(queued)) as WritebackOutboxState;
  const service = new SkillWritebackService({ now: () => issuedAtMs + 10 });
  service.registerPendingWriteback(plan.diffHash, {
    plan: restarted.jobs[0]!.plan,
    target: 'source',
    historyPath: restarted.jobs[0]!.historyPath,
  });
  const token = service.issueApproval(plan.diffHash, { ttlMs: 30_000, now: () => issuedAtMs, random: () => 0.7 });

  const drained = await drainWritebackOutbox(restarted, {
    now: () => issuedAtMs + 10,
    authorizationByJobId: { [restarted.jobs[0]!.id]: { approvalToken: token.approvalToken } },
    performWriteback: ({ job, authorization }) => service.approveSkillWriteback(job.plan.diffHash, authorization.approvalToken),
  });

  expect(drained.state.jobs).toEqual([]);
  const { readFile } = await import('node:fs/promises');
  await expect(readFile(root.join(root.sourceRoot, 'memory', 'main-memory.md'), 'utf8')).resolves.toBe('app');
});