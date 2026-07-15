import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as publicApi from './index';
import { applyWritebackPlan, planWritebackTargets, SkillKnowledgePromotionService, SkillWritebackService } from './writeback-flow';
import { consumeWritebackToken, createWritebackApprovalRegistry, createWritebackToken } from './writeback-token';
import type { SkillPromotionCandidate } from '@agent-canvas/domain';
import { createKnowledgeSnapshotCandidate } from './knowledge-snapshot';
import { KnowledgeSnapshotRegistry } from './knowledge-registry';

const issuedAt = '2026-07-13T12:00:00.000Z';
const issuedAtMs = Date.parse(issuedAt);

describe('writeback tokens', () => {
  it('consumes a scoped token once and stores only the token hash', () => {
    const token = createWritebackToken(
      { target: 'source', diffHash: 'diff-1', ttlMs: 30_000 },
      { now: () => issuedAtMs, random: () => 0 },
    );

    expect(token.record).toMatchObject({
      target: 'source',
      diffHash: 'diff-1',
      issuedAt,
      expiresAt: '2026-07-13T12:00:30.000Z',
    });
    expect(token.record.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect((token.record as unknown as Record<string, unknown>).approvalToken).toBeUndefined();

    const first = consumeWritebackToken({
      record: token.record,
      approvalToken: token.approvalToken,
      target: 'source',
      diffHash: 'diff-1',
      now: () => issuedAtMs + 1,
    });
    expect(first).toMatchObject({
      ok: true,
      record: { consumedAt: '2026-07-13T12:00:00.001Z' },
    });

    expect(consumeWritebackToken({
      record: first.record,
      approvalToken: token.approvalToken,
      target: 'source',
      diffHash: 'diff-1',
      now: () => issuedAtMs + 2,
    })).toMatchObject({ ok: false, reason: 'already_used' });
  });

  it('rejects expired tokens and wrong target or diff scope', () => {
    const token = createWritebackToken(
      { target: 'source', diffHash: 'diff-1', ttlMs: 30_000 },
      { now: () => issuedAtMs, random: () => 0.25 },
    );

    expect(consumeWritebackToken({
      record: token.record,
      approvalToken: token.approvalToken,
      target: 'app',
      diffHash: 'diff-1',
      now: () => issuedAtMs + 1,
    })).toMatchObject({ ok: false, reason: 'scope_mismatch' });

    expect(consumeWritebackToken({
      record: token.record,
      approvalToken: token.approvalToken,
      target: 'source',
      diffHash: 'diff-2',
      now: () => issuedAtMs + 1,
    })).toMatchObject({ ok: false, reason: 'scope_mismatch' });

    expect(consumeWritebackToken({
      record: token.record,
      approvalToken: token.approvalToken,
      target: 'source',
      diffHash: 'diff-1',
      now: () => issuedAtMs + 30_001,
    })).toMatchObject({ ok: false, reason: 'expired' });
  });
});

describe('writeback flow', () => {
  it('plans base/app/source writes, blocks conflicts, and keeps original images opt-in', async () => {
    const roots = await createSkillRoots();
    const plan = await planWritebackTargets({
      baseRoot: roots.baseRoot,
      appRoot: roots.appRoot,
      sourceRoot: roots.sourceRoot,
    });

    expect(plan.diff.map((entry) => [entry.relativePath, entry.state])).toEqual([
      ['memory/conflict.md', 'conflict'],
      ['memory/latest-project-memory.md', 'source_changed'],
      ['memory/main-memory.md', 'app_changed'],
      ['memory/originals/product.png', 'app_changed'],
    ]);
    expect(plan.targets.source.writeFiles.map((file) => file.relativePath)).toEqual(['memory/main-memory.md']);
    expect(plan.targets.source.blockedFiles.map((file) => file.relativePath)).toEqual(['memory/conflict.md']);
    expect(plan.targets.app.writeFiles.map((file) => file.relativePath)).toEqual(['memory/latest-project-memory.md']);
    expect(plan.payload.memory.map((file) => file.relativePath)).toEqual([
      'memory/conflict.md',
      'memory/latest-project-memory.md',
      'memory/main-memory.md',
    ]);
    expect(plan.payload.originalImages).toEqual([]);

    const withImages = await planWritebackTargets({
      baseRoot: roots.baseRoot,
      appRoot: roots.appRoot,
      sourceRoot: roots.sourceRoot,
      includeOriginalImages: true,
    });
    expect(withImages.payload.originalImages.map((file) => file.relativePath)).toEqual(['memory/originals/product.png']);
  });

  it('writes app changes to source and source changes back to app without touching blocked files', async () => {
    const roots = await createSkillRoots();
    const plan = await planWritebackTargets({
      baseRoot: roots.baseRoot,
      appRoot: roots.appRoot,
      sourceRoot: roots.sourceRoot,
    });
    const sourceToken = createWritebackToken(
      { target: 'source', diffHash: plan.diffHash, ttlMs: 30_000 },
      { now: () => issuedAtMs, random: () => 0.5 },
    );

    const wrongTarget = await applyWritebackPlan({
      plan,
      target: 'source',
      approvalToken: sourceToken.approvalToken,
      tokenRecord: { ...sourceToken.record, target: 'app' },
      historyPath: join(roots.appRoot, 'memory', 'writeback-history.log'),
      clock: { now: () => issuedAtMs + 1 },
    });
    expect(wrongTarget).toMatchObject({ ok: false, reason: 'scope_mismatch' });
    await expect(readFile(join(roots.sourceRoot, 'memory', 'main-memory.md'), 'utf8')).resolves.toBe('base main');

    const sourceResult = await applyWritebackPlan({
      plan,
      target: 'source',
      approvalToken: sourceToken.approvalToken,
      tokenRecord: sourceToken.record,
      historyPath: join(roots.appRoot, 'memory', 'writeback-history.log'),
      clock: { now: () => issuedAtMs + 2 },
    });
    expect(sourceResult).toMatchObject({
      ok: true,
      writtenFiles: ['memory/main-memory.md'],
      preservedFiles: ['memory/latest-project-memory.md'],
      blockedFiles: ['memory/conflict.md'],
    });
    await expect(readFile(join(roots.sourceRoot, 'memory', 'main-memory.md'), 'utf8')).resolves.toBe('app main');
    await expect(readFile(join(roots.sourceRoot, 'memory', 'latest-project-memory.md'), 'utf8')).resolves.toBe('source latest');
    await expect(readFile(join(roots.sourceRoot, 'memory', 'conflict.md'), 'utf8')).resolves.toBe('source conflict');
    await expect(readFile(join(roots.appRoot, 'memory', 'writeback-history.log'), 'utf8')).resolves.toContain('memory/main-memory.md');
    await expect(readFile(join(roots.appRoot, 'memory', 'writeback-history.log'), 'utf8')).resolves.not.toContain(roots.sourceRoot);
    expect((await readdir(join(roots.sourceRoot, 'memory'))).filter((name) => name.includes('.tmp-writeback-'))).toEqual([]);

    const appToken = createWritebackToken(
      { target: 'app', diffHash: plan.diffHash, ttlMs: 30_000 },
      { now: () => issuedAtMs, random: () => 0.75 },
    );
    const appResult = await applyWritebackPlan({
      plan,
      target: 'app',
      approvalToken: appToken.approvalToken,
      tokenRecord: appToken.record,
      historyPath: join(roots.appRoot, 'memory', 'writeback-history.log'),
      clock: { now: () => issuedAtMs + 3 },
    });
    expect(appResult).toMatchObject({
      ok: true,
      writtenFiles: ['memory/latest-project-memory.md'],
      preservedFiles: ['memory/main-memory.md'],
      blockedFiles: ['memory/conflict.md'],
    });
    await expect(readFile(join(roots.appRoot, 'memory', 'latest-project-memory.md'), 'utf8')).resolves.toBe('source latest');
    await expect(readFile(join(roots.appRoot, 'memory', 'main-memory.md'), 'utf8')).resolves.toBe('app main');
  });

  it('rejects traversal in managed or source paths and makes no writes', async () => {
    const roots = await createSkillRoots();
    const plan = await planWritebackTargets({
      baseRoot: roots.baseRoot,
      appRoot: roots.appRoot,
      sourceRoot: roots.sourceRoot,
    });
    const token = createWritebackToken(
      { target: 'source', diffHash: plan.diffHash, ttlMs: 30_000 },
      { now: () => issuedAtMs, random: () => 0.9 },
    );

    const traversal = await applyWritebackPlan({
      plan: {
        ...plan,
        targets: {
          ...plan.targets,
          source: {
            ...plan.targets.source,
            writeFiles: [{ relativePath: '../escape.md', content: 'escape' }],
          },
        },
      },
      target: 'source',
      approvalToken: token.approvalToken,
      tokenRecord: token.record,
      historyPath: join(roots.appRoot, 'memory', 'writeback-history.log'),
      clock: { now: () => issuedAtMs + 1 },
    });

    expect(traversal).toMatchObject({ ok: false, reason: 'invalid_path' });
    await expect(readFile(join(roots.sourceRoot, 'memory', 'main-memory.md'), 'utf8')).resolves.toBe('base main');
  });
});

async function createSkillRoots() {
  const root = await mkdtemp(join(tmpdir(), 'skill-writeback-'));
  const baseRoot = join(root, 'base');
  const appRoot = join(root, 'app');
  const sourceRoot = join(root, 'source');
  await Promise.all([baseRoot, appRoot, sourceRoot].map((directory) => mkdir(join(directory, 'memory', 'originals'), { recursive: true })));

  await writeFile(join(baseRoot, 'memory', 'main-memory.md'), 'base main', 'utf8');
  await writeFile(join(appRoot, 'memory', 'main-memory.md'), 'app main', 'utf8');
  await writeFile(join(sourceRoot, 'memory', 'main-memory.md'), 'base main', 'utf8');

  await writeFile(join(baseRoot, 'memory', 'latest-project-memory.md'), 'base latest', 'utf8');
  await writeFile(join(appRoot, 'memory', 'latest-project-memory.md'), 'base latest', 'utf8');
  await writeFile(join(sourceRoot, 'memory', 'latest-project-memory.md'), 'source latest', 'utf8');

  await writeFile(join(baseRoot, 'memory', 'conflict.md'), 'base conflict', 'utf8');
  await writeFile(join(appRoot, 'memory', 'conflict.md'), 'app conflict', 'utf8');
  await writeFile(join(sourceRoot, 'memory', 'conflict.md'), 'source conflict', 'utf8');

  await writeFile(join(baseRoot, 'memory', 'originals', 'product.png'), 'base image', 'utf8');
  await writeFile(join(appRoot, 'memory', 'originals', 'product.png'), 'app image', 'utf8');
  await writeFile(join(sourceRoot, 'memory', 'originals', 'product.png'), 'base image', 'utf8');

  return { baseRoot, appRoot, sourceRoot };
}

describe('atomic writeback approval integration', () => {
  it('allows only one concurrent claim for the same approval token', async () => {
    const registry = createWritebackApprovalRegistry();
    const token = registry.issue(
      { target: 'source', diffHash: 'diff-concurrent', ttlMs: 30_000 },
      { now: () => issuedAtMs, random: () => 0.11 },
    );

    const claim = () => Promise.resolve().then(() => registry.claim({
      id: token.id,
      approvalToken: token.approvalToken,
      target: 'source',
      diffHash: 'diff-concurrent',
      now: () => issuedAtMs + 1,
    }));
    const results = await Promise.all([claim(), claim()]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      expect.objectContaining({ reason: 'already_used' }),
    ]);
  });

  it('approves a registered diff once through approveSkillWriteback', async () => {
    const roots = await createSkillRoots();
    const plan = await planWritebackTargets({
      baseRoot: roots.baseRoot,
      appRoot: roots.appRoot,
      sourceRoot: roots.sourceRoot,
    });
    const service = new SkillWritebackService({ now: () => issuedAtMs + 10 });
    service.registerPendingWriteback(plan.diffHash, {
      plan,
      target: 'source',
      historyPath: join(roots.appRoot, 'memory', 'writeback-history.log'),
    });
    const token = service.issueApproval(plan.diffHash, { ttlMs: 30_000, now: () => issuedAtMs, random: () => 0.22 });

    const [first, second] = await Promise.all([
      service.approveSkillWriteback(plan.diffHash, token.approvalToken),
      service.approveSkillWriteback(plan.diffHash, token.approvalToken),
    ]);

    expect([first, second].filter((result) => result.ok)).toHaveLength(1);
    expect([first, second].filter((result) => !result.ok)).toEqual([
      expect.objectContaining({ reason: 'already_used' }),
    ]);
    await expect(readFile(join(roots.sourceRoot, 'memory', 'main-memory.md'), 'utf8')).resolves.toBe('app main');
  });

  it('rolls back every promoted file when a batch promotion fails', async () => {
    const roots = await createSkillRoots();
    await writeFile(join(roots.baseRoot, 'memory', 'second.md'), 'base second', 'utf8');
    await writeFile(join(roots.appRoot, 'memory', 'second.md'), 'app second', 'utf8');
    await writeFile(join(roots.sourceRoot, 'memory', 'second.md'), 'base second', 'utf8');
    const plan = await planWritebackTargets({
      baseRoot: roots.baseRoot,
      appRoot: roots.appRoot,
      sourceRoot: roots.sourceRoot,
    });
    const registry = createWritebackApprovalRegistry();
    const token = registry.issue(
      { target: 'source', diffHash: plan.diffHash, ttlMs: 30_000 },
      { now: () => issuedAtMs, random: () => 0.33 },
    );

    const result = await applyWritebackPlan({
      plan,
      target: 'source',
      approvalToken: token.approvalToken,
      approvalId: token.id,
      approvalRegistry: registry,
      historyPath: join(roots.appRoot, 'memory', 'writeback-history.log'),
      clock: { now: () => issuedAtMs + 1 },
      transactionHooks: {
        beforePromote: (_relativePath, index) => {
          if (index === 1) throw new Error('simulated promotion failure');
        },
      },
    });

    expect(result).toMatchObject({ ok: false, reason: 'write_failed' });
    await expect(readFile(join(roots.sourceRoot, 'memory', 'main-memory.md'), 'utf8')).resolves.toBe('base main');
    await expect(readFile(join(roots.sourceRoot, 'memory', 'second.md'), 'utf8')).resolves.toBe('base second');
  });

  it('preserves non-UTF8 original image bytes only when explicitly opted in', async () => {
    const roots = await createSkillRoots();
    const bytes = Uint8Array.from([0, 255, 1, 254, 2, 253]);
    await writeFile(join(roots.appRoot, 'memory', 'originals', 'product.png'), bytes);
    const withoutImages = await planWritebackTargets({
      baseRoot: roots.baseRoot,
      appRoot: roots.appRoot,
      sourceRoot: roots.sourceRoot,
    });
    expect(withoutImages.payload.originalImages).toEqual([]);
    expect(JSON.stringify(withoutImages.payload)).not.toContain('255');

    const withImages = await planWritebackTargets({
      baseRoot: roots.baseRoot,
      appRoot: roots.appRoot,
      sourceRoot: roots.sourceRoot,
      includeOriginalImages: true,
    });
    expect(withImages.payload.originalImages[0]).toMatchObject({
      relativePath: 'memory/originals/product.png',
      encoding: 'binary',
      content: [0, 255, 1, 254, 2, 253],
    });
  });
});
describe('writeback final safety gates', () => {
  it('uses cryptographic randomness when no test generator is injected', () => {
    const mathRandom = vi.spyOn(Math, 'random').mockReturnValue(0);
    const first = createWritebackToken({ target: 'source', diffHash: 'secure', ttlMs: 30_000 }, { now: () => issuedAtMs });
    const second = createWritebackToken({ target: 'source', diffHash: 'secure', ttlMs: 30_000 }, { now: () => issuedAtMs });
    expect(first.approvalToken.split('.')[1]).not.toBe(second.approvalToken.split('.')[1]);
    mathRandom.mockRestore();
  });

  it('restores the original after destination removal when promotion then fails', async () => {
    const roots = await createSkillRoots();
    const plan = await planWritebackTargets({ baseRoot: roots.baseRoot, appRoot: roots.appRoot, sourceRoot: roots.sourceRoot });
    const registry = createWritebackApprovalRegistry();
    const token = registry.issue({ target: 'source', diffHash: plan.diffHash, ttlMs: 30_000 }, { now: () => issuedAtMs, random: () => 0.44 });
    const result = await applyWritebackPlan({
      plan,
      target: 'source',
      approvalToken: token.approvalToken,
      approvalId: token.id,
      approvalRegistry: registry,
      historyPath: join(roots.appRoot, 'memory', 'writeback-history.log'),
      clock: { now: () => issuedAtMs + 1 },
      transactionHooks: { afterRemove: () => { throw new Error('rename failed after destination removal'); } },
    });
    expect(result).toMatchObject({ ok: false, reason: 'write_failed' });
    await expect(readFile(join(roots.sourceRoot, 'memory', 'main-memory.md'), 'utf8')).resolves.toBe('base main');
  });

  it('blocks a stale reviewed plan when source changes before approval', async () => {
    const roots = await createSkillRoots();
    const plan = await planWritebackTargets({ baseRoot: roots.baseRoot, appRoot: roots.appRoot, sourceRoot: roots.sourceRoot });
    await writeFile(join(roots.sourceRoot, 'memory', 'main-memory.md'), 'external source update', 'utf8');
    const service = new SkillWritebackService({ now: () => issuedAtMs + 10 });
    service.registerPendingWriteback(plan.diffHash, { plan, target: 'source', historyPath: join(roots.appRoot, 'memory', 'writeback-history.log') });
    const token = service.issueApproval(plan.diffHash, { ttlMs: 30_000, now: () => issuedAtMs, random: () => 0.55 });
    const result = await service.approveSkillWriteback(plan.diffHash, token.approvalToken);
    expect(result).toMatchObject({ ok: false, reason: 'stale_plan' });
    await expect(readFile(join(roots.sourceRoot, 'memory', 'main-memory.md'), 'utf8')).resolves.toBe('external source update');
  });

  it('exposes only the atomic approval service as the package writeback surface', () => {
    expect(publicApi).toHaveProperty('approveSkillWriteback');
    expect(publicApi).toHaveProperty('SkillWritebackService');
    expect(publicApi).toHaveProperty('SkillKnowledgePromotionService');
    expect(publicApi).not.toHaveProperty('applyWritebackPlan');
    expect(publicApi).not.toHaveProperty('consumeWritebackToken');
    expect(publicApi).not.toHaveProperty('createWritebackToken');
  });
});

describe('SkillKnowledgePromotionService', () => {
  it('prepares an exact diff, consumes one approval once, and marks approved only after publication', async () => {
    const registry = new KnowledgeSnapshotRegistry();
    const current = registry.publish(createKnowledgeSnapshotCandidate({
      knowledgeBaseId: 'scene-skill',
      displayName: 'Scene Skill',
      documents: [{ relativePath: 'memory/main.md', content: '# Scene Skill' }],
    }), { publishedAt: '2026-07-15T10:00:00.000Z', sourceDeviceId: 'device-a' });
    const writeback = new SkillWritebackService({ now: () => issuedAtMs + 10 });
    const service = new SkillKnowledgePromotionService({
      registry,
      writebackService: writeback,
      sourceDeviceId: 'device-a',
      now: () => issuedAtMs + 10,
    });
    const candidate = createCandidate();

    const prepared = service.prepare(candidate, current);
    expect(prepared.candidate.reviewStatus).toBe('pending_review');
    expect(prepared.targetSnapshot.contentHash).not.toBe(current.contentHash);

    const token = writeback.issueApproval(prepared.diffHash, { ttlMs: 30_000, now: () => issuedAtMs, random: () => 0.66 });
    const approved = await service.approve(prepared.preparedId, token.approvalToken);

    expect(approved.candidate).toMatchObject({
      reviewStatus: 'approved',
      reviewedAt: '2026-07-13T12:00:00.010Z',
      publishedKnowledgeVersion: 2,
    });
    expect(registry.getActive('scene-skill')).toMatchObject({ version: 2, contentHash: prepared.targetSnapshot.contentHash });
    await expect(service.approve(prepared.preparedId, token.approvalToken)).resolves.toMatchObject({ ok: false, reason: 'already_used' });
  });

  it('blocks stale approvals, supports rejection, and rolls back approved candidates', async () => {
    const registry = new KnowledgeSnapshotRegistry();
    const current = registry.publish(createKnowledgeSnapshotCandidate({
      knowledgeBaseId: 'scene-skill',
      displayName: 'Scene Skill',
      documents: [{ relativePath: 'memory/main.md', content: '# Scene Skill' }],
    }), { publishedAt: '2026-07-15T10:00:00.000Z', sourceDeviceId: 'device-a' });
    const writeback = new SkillWritebackService({ now: () => issuedAtMs + 20 });
    const service = new SkillKnowledgePromotionService({
      registry,
      writebackService: writeback,
      sourceDeviceId: 'device-a',
      now: () => issuedAtMs + 20,
    });
    const prepared = service.prepare(createCandidate(), current);
    registry.publish(createKnowledgeSnapshotCandidate({
      knowledgeBaseId: 'scene-skill',
      displayName: 'Scene Skill',
      documents: [{ relativePath: 'memory/main.md', content: '# External Update' }],
    }), { publishedAt: '2026-07-15T10:01:00.000Z', sourceDeviceId: 'device-b' });
    const token = writeback.issueApproval(prepared.diffHash, { ttlMs: 30_000, now: () => issuedAtMs, random: () => 0.77 });

    await expect(service.approve(prepared.preparedId, token.approvalToken)).resolves.toMatchObject({ ok: false, reason: 'stale_snapshot' });
    expect(service.reject(prepared.preparedId, '2026-07-15T10:02:00.000Z')).toMatchObject({ reviewStatus: 'rejected' });

    const second = service.prepare(createCandidate('candidate-2'), registry.getActive('scene-skill')!);
    const secondToken = writeback.issueApproval(second.diffHash, { ttlMs: 30_000, now: () => issuedAtMs + 1_000, random: () => 0.88 });
    const approved = await service.approve(second.preparedId, secondToken.approvalToken);
    if (!approved.ok) throw new Error(`expected approval: ${approved.reason}`);

    const summary = await service.rollback('scene-skill', 1, '2026-07-15T10:03:00.000Z');
    expect(summary).toMatchObject({
      status: 'rolled_back',
      activeVersion: 1,
    });
    expect(service.getCandidate(approved.candidate.id)).toMatchObject({ reviewStatus: 'rolled_back', rolledBackAt: '2026-07-15T10:03:00.000Z' });
  });

  it('rolls back only approvals published after the target through the current active version', async () => {
    const registry = new KnowledgeSnapshotRegistry();
    const initial = registry.publish(createKnowledgeSnapshotCandidate({
      knowledgeBaseId: 'scene-skill',
      displayName: 'Scene Skill',
      documents: [{ relativePath: 'memory/main.md', content: '# Scene Skill' }],
    }), { publishedAt: '2026-07-15T10:00:00.000Z', sourceDeviceId: 'device-a' });
    const writeback = new SkillWritebackService({ now: () => issuedAtMs + 30 });
    const service = new SkillKnowledgePromotionService({
      registry,
      writebackService: writeback,
      sourceDeviceId: 'device-a',
      now: () => issuedAtMs + 30,
    });

    const approvedV2 = await approvePrepared(service, writeback, createCandidate('candidate-v2', 'Use v2 heavy liquid.'), initial, 0.12);
    const approvedV3 = await approvePrepared(service, writeback, createCandidate('candidate-v3', 'Use v3 heavy liquid.'), approvedV2.snapshot, 0.13);
    const approvedV4 = await approvePrepared(service, writeback, createCandidate('candidate-v4', 'Use v4 heavy liquid.'), approvedV3.snapshot, 0.14);

    expect(registry.getSummary('scene-skill')).toMatchObject({ status: 'active', activeVersion: 4 });

    const summary = await service.rollback('scene-skill', 3, '2026-07-15T10:04:00.000Z');

    expect(summary).toMatchObject({ status: 'rolled_back', activeVersion: 3 });
    expect(service.getCandidate(approvedV2.candidate.id)).toMatchObject({ reviewStatus: 'approved', publishedKnowledgeVersion: 2 });
    expect(service.getCandidate(approvedV3.candidate.id)).toMatchObject({ reviewStatus: 'approved', publishedKnowledgeVersion: 3 });
    expect(service.getCandidate(approvedV4.candidate.id)).toMatchObject({ reviewStatus: 'rolled_back', publishedKnowledgeVersion: 4 });
  });

  it('rejects rollback targets that are not older than the current active snapshot', async () => {
    const registry = new KnowledgeSnapshotRegistry();
    const current = registry.publish(createKnowledgeSnapshotCandidate({
      knowledgeBaseId: 'scene-skill',
      displayName: 'Scene Skill',
      documents: [{ relativePath: 'memory/main.md', content: '# Scene Skill' }],
    }), { publishedAt: '2026-07-15T10:00:00.000Z', sourceDeviceId: 'device-a' });
    const service = new SkillKnowledgePromotionService({
      registry,
      sourceDeviceId: 'device-a',
      now: () => issuedAtMs + 40,
    });

    await expect(service.rollback('scene-skill', current.version, '2026-07-15T10:05:00.000Z')).rejects.toThrow(/older/i);
    await expect(service.rollback('scene-skill', current.version + 1, '2026-07-15T10:06:00.000Z')).rejects.toThrow(/older/i);
    expect(registry.getSummary('scene-skill')).toMatchObject({
      status: 'active',
      activeVersion: current.version,
      lastRollbackAt: null,
    });
  });
});

async function approvePrepared(
  service: SkillKnowledgePromotionService,
  writeback: SkillWritebackService,
  candidate: SkillPromotionCandidate,
  current: ReturnType<KnowledgeSnapshotRegistry['getActive']>,
  random: number,
) {
  if (!current) throw new Error('expected current snapshot');
  const prepared = service.prepare(candidate, current);
  const token = writeback.issueApproval(prepared.diffHash, { ttlMs: 30_000, now: () => issuedAtMs, random: () => random });
  const approved = await service.approve(prepared.preparedId, token.approvalToken);
  if (!approved.ok) throw new Error(`expected approval: ${approved.reason}`);
  return approved;
}

function createCandidate(id = 'candidate-1', rule = 'Use slower, heavier liquid arcs around the product.'): SkillPromotionCandidate {
  return {
    schemaVersion: 1,
    id,
    sourceProjectId: 'project-1',
    sourceProjectMemoryId: 'feedback-1',
    sourceProjectMemoryIds: ['feedback-1'],
    createdAt: '2026-07-15T09:59:00.000Z',
    title: 'Heavy liquid rule',
    rationale: 'Repeated feedback asks for heavier liquid.',
    rule,
    targetKnowledgeBaseId: 'scene-skill',
    targetKnowledgeSection: 'reverse-prompt/liquid',
    counts: { supportingMemoryCount: 1 },
    confidence: 1,
    affectedCapabilities: ['reverse_prompt'],
    evidence: { keep: ['product identity'], change: ['heavier liquid'], never: [] },
    reviewStatus: 'pending_review',
  };
}
