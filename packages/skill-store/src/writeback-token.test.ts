import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import * as publicApi from './index';
import { applyWritebackPlan, planWritebackTargets, SkillWritebackService } from './writeback-flow';
import { consumeWritebackToken, createWritebackApprovalRegistry, createWritebackToken } from './writeback-token';

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
    expect(publicApi).not.toHaveProperty('applyWritebackPlan');
    expect(publicApi).not.toHaveProperty('consumeWritebackToken');
    expect(publicApi).not.toHaveProperty('createWritebackToken');
  });
});