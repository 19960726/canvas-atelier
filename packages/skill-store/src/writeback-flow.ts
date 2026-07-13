import { createHash } from 'node:crypto';
import { appendFile, copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, resolve, sep } from 'node:path';
import { computeMemoryDiff, type MemoryDiffEntry } from './memory-diff';
import { resolveManagedPath } from './import-skill';
import {
  consumeWritebackToken,
  createWritebackApprovalRegistry,
  type WritebackApprovalRegistry,
  type WritebackTarget,
  type WritebackTokenFailureReason,
  type WritebackTokenRecord,
} from './writeback-token';

export interface PlannedWriteFile {
  relativePath: string;
  encoding?: 'utf8' | 'binary';
  content: string | number[];
}

interface PlannedPath { relativePath: string; }
interface WritebackTargetPlan {
  writeFiles: PlannedWriteFile[];
  preservedFiles: PlannedPath[];
  blockedFiles: PlannedPath[];
}

export interface WritebackPlan {
  diffHash: string;
  diff: MemoryDiffEntry[];
  targets: Record<WritebackTarget, WritebackTargetPlan>;
  payload: { memory: PlannedWriteFile[]; originalImages: PlannedWriteFile[] };
  roots: { baseRoot: string; appRoot: string; sourceRoot: string };
}

interface SkillFiles {
  comparisons: Record<string, string>;
  contents: Record<string, PlannedWriteFile>;
}

export async function planWritebackTargets(input: {
  baseRoot: string;
  appRoot: string;
  sourceRoot: string;
  includeOriginalImages?: boolean;
}): Promise<WritebackPlan> {
  const [baseFiles, appFiles, sourceFiles] = await Promise.all([
    readSkillFiles(input.baseRoot),
    readSkillFiles(input.appRoot),
    readSkillFiles(input.sourceRoot),
  ]);
  const diff = computeMemoryDiff(baseFiles.comparisons, appFiles.comparisons, sourceFiles.comparisons)
    .filter((entry) => entry.state !== 'unchanged')
    .filter((entry) => isMemoryFile(entry.relativePath) || isOriginalImagePath(entry.relativePath))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const includeOriginalImages = input.includeOriginalImages ?? false;
  const candidates = diff.filter((entry) => shouldIncludeInWriteback(entry.relativePath, includeOriginalImages));
  const contentFor = (entry: MemoryDiffEntry, side: 'app' | 'source') => {
    const files = side === 'app' ? appFiles : sourceFiles;
    const file = files.contents[entry.relativePath];
    if (!file) throw new Error(`missing ${side} content for ${entry.relativePath}`);
    return clonePlannedFile(file);
  };

  return {
    diffHash: hashDiff(diff),
    diff,
    targets: {
      source: {
        writeFiles: candidates.filter((entry) => entry.state === 'app_changed').map((entry) => contentFor(entry, 'app')),
        preservedFiles: candidates.filter((entry) => entry.state === 'source_changed').map(toPlannedPath),
        blockedFiles: candidates.filter((entry) => entry.state === 'conflict').map(toPlannedPath),
      },
      app: {
        writeFiles: candidates.filter((entry) => entry.state === 'source_changed').map((entry) => contentFor(entry, 'source')),
        preservedFiles: candidates.filter((entry) => entry.state === 'app_changed').map(toPlannedPath),
        blockedFiles: candidates.filter((entry) => entry.state === 'conflict').map(toPlannedPath),
      },
    },
    payload: {
      memory: diff.filter((entry) => isMemoryFile(entry.relativePath)).map((entry) => contentFor(entry, entry.state === 'source_changed' ? 'source' : 'app')),
      originalImages: includeOriginalImages
        ? diff.filter((entry) => isOriginalImagePath(entry.relativePath)).map((entry) => contentFor(entry, entry.state === 'source_changed' ? 'source' : 'app'))
        : [],
    },
    roots: { baseRoot: input.baseRoot, appRoot: input.appRoot, sourceRoot: input.sourceRoot },
  };
}

export type ApplyWritebackFailureReason = WritebackTokenFailureReason | 'invalid_path' | 'write_failed';
export type ApplyWritebackResult =
  | { ok: true; tokenRecord: WritebackTokenRecord; writtenFiles: string[]; preservedFiles: string[]; blockedFiles: string[] }
  | { ok: false; reason: ApplyWritebackFailureReason; tokenRecord: WritebackTokenRecord };

export async function applyWritebackPlan(input: {
  plan: WritebackPlan;
  target: WritebackTarget;
  approvalToken: string;
  approvalId?: string;
  approvalRegistry?: WritebackApprovalRegistry;
  tokenRecord?: WritebackTokenRecord;
  historyPath: string;
  clock?: { now: () => number };
  transactionHooks?: { beforePromote?: (relativePath: string, index: number) => void | Promise<void>; afterRemove?: (relativePath: string, index: number) => void | Promise<void> };
}): Promise<ApplyWritebackResult> {
  const approvalId = input.approvalId ?? input.approvalToken.split('.', 1)[0] ?? '';
  const consumed = input.approvalRegistry
    ? input.approvalRegistry.claim({ id: approvalId, approvalToken: input.approvalToken, target: input.target, diffHash: input.plan.diffHash, now: input.clock?.now })
    : input.tokenRecord
      ? consumeWritebackToken({ record: input.tokenRecord, approvalToken: input.approvalToken, target: input.target, diffHash: input.plan.diffHash, now: input.clock?.now })
      : invalidApprovalRecord(approvalId, input.target, input.plan.diffHash);
  if (!consumed.ok) return { ok: false, reason: consumed.reason, tokenRecord: consumed.record };

  const targetPlan = input.plan.targets[input.target];
  const targetRoot = input.target === 'source' ? input.plan.roots.sourceRoot : input.plan.roots.appRoot;
  let files: PreparedWrite[];
  try {
    files = targetPlan.writeFiles.map((file) => ({
      relativePath: file.relativePath,
      targetPath: resolveWritebackPath(targetRoot, file.relativePath),
      payload: encodeFile(file),
      tempPath: '',
      backupPath: '',
      existed: false,
      promoted: false,
      targetRemoved: false,
    }));
    resolveWritebackPath(input.plan.roots.appRoot, relativeToRoot(input.plan.roots.appRoot, input.historyPath));
  } catch {
    return { ok: false, reason: 'invalid_path', tokenRecord: consumed.record };
  }

  try {
    await prepareBatch(files);
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index]!;
      await input.transactionHooks?.beforePromote?.(file.relativePath, index);
      await rm(file.targetPath, { force: true });
      file.targetRemoved = true;
      await input.transactionHooks?.afterRemove?.(file.relativePath, index);
      await rename(file.tempPath, file.targetPath);
      file.promoted = true;
    }
    await appendSanitizedHistory(input.historyPath, {
      appliedAt: new Date((input.clock?.now ?? Date.now)()).toISOString(),
      target: input.target,
      diffHash: input.plan.diffHash,
      writtenFiles: files.map((file) => file.relativePath),
      preservedFiles: targetPlan.preservedFiles.map((file) => file.relativePath),
      blockedFiles: targetPlan.blockedFiles.map((file) => file.relativePath),
    });
    await cleanupBatch(files);
  } catch {
    await rollbackBatch(files);
    return { ok: false, reason: 'write_failed', tokenRecord: consumed.record };
  }

  return {
    ok: true,
    tokenRecord: consumed.record,
    writtenFiles: files.map((file) => file.relativePath),
    preservedFiles: targetPlan.preservedFiles.map((file) => file.relativePath),
    blockedFiles: targetPlan.blockedFiles.map((file) => file.relativePath),
  };
}

interface PendingWriteback {
  plan: WritebackPlan;
  target: WritebackTarget;
  historyPath: string;
}

export class SkillWritebackService {
  private readonly registry: WritebackApprovalRegistry;
  private readonly pending = new Map<string, PendingWriteback>();
  private readonly now: () => number;

  constructor(options: { registry?: WritebackApprovalRegistry; now?: () => number } = {}) {
    this.registry = options.registry ?? createWritebackApprovalRegistry();
    this.now = options.now ?? Date.now;
  }

  registerPendingWriteback(diffId: string, pending: PendingWriteback): void {
    if (diffId !== pending.plan.diffHash) throw new Error('writeback diff id mismatch');
    this.pending.set(diffId, pending);
  }

  issueApproval(diffId: string, options: { ttlMs: number; now?: () => number; random?: () => number }) {
    const pending = this.pending.get(diffId);
    if (!pending) throw new Error('unknown writeback diff');
    return this.registry.issue(
      { target: pending.target, diffHash: pending.plan.diffHash, ttlMs: options.ttlMs },
      { now: options.now ?? this.now, random: options.random },
    );
  }

  async approveSkillWriteback(diffId: string, approvalToken: string): Promise<ApplyWritebackResult | { ok: false; reason: 'unknown_diff' | 'stale_plan' }> {
    const pending = this.pending.get(diffId);
    if (!pending) return { ok: false, reason: 'unknown_diff' };
    const currentPlan = await planWritebackTargets({
      ...pending.plan.roots,
      includeOriginalImages: pending.plan.payload.originalImages.length > 0,
    });
    if (currentPlan.diffHash !== pending.plan.diffHash) return { ok: false, reason: 'stale_plan' };
    return applyWritebackPlan({
      ...pending,
      approvalToken,
      approvalId: approvalToken.split('.', 1)[0],
      approvalRegistry: this.registry,
      clock: { now: this.now },
    });
  }
}

export function approveSkillWriteback(service: SkillWritebackService, diffId: string, approvalToken: string) {
  return service.approveSkillWriteback(diffId, approvalToken);
}

interface PreparedWrite {
  relativePath: string;
  targetPath: string;
  payload: string | Uint8Array;
  tempPath: string;
  backupPath: string;
  existed: boolean;
  promoted: boolean;
  targetRemoved: boolean;
}

async function prepareBatch(files: PreparedWrite[]): Promise<void> {
  const transactionId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  for (const file of files) {
    await mkdir(dirname(file.targetPath), { recursive: true });
    file.tempPath = resolve(dirname(file.targetPath), `${basename(file.targetPath)}.tmp-writeback-${transactionId}`);
    file.backupPath = resolve(dirname(file.targetPath), `${basename(file.targetPath)}.bak-writeback-${transactionId}`);
    file.existed = await pathExists(file.targetPath);
    if (file.existed) await copyFile(file.targetPath, file.backupPath);
    await writeFile(file.tempPath, file.payload);
  }
}

async function rollbackBatch(files: PreparedWrite[]): Promise<void> {
  for (const file of files) {
    try {
      if (file.targetRemoved) {
        if (file.existed) await copyFile(file.backupPath, file.targetPath);
        else await rm(file.targetPath, { force: true });
      }
      await rm(file.tempPath, { force: true });
      await rm(file.backupPath, { force: true });
    } catch {
      // Best-effort cleanup; original backups are restored before removal.
    }
  }
}

async function cleanupBatch(files: PreparedWrite[]): Promise<void> {
  await Promise.all(files.flatMap((file) => [rm(file.tempPath, { force: true }), rm(file.backupPath, { force: true })]));
}

async function pathExists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch { return false; }
}

async function readSkillFiles(root: string): Promise<SkillFiles> {
  const files = await collectFiles(root);
  const comparisons: Record<string, string> = {};
  const contents: Record<string, PlannedWriteFile> = {};
  for (const relativePath of files) {
    const buffer = await readFile(resolveWritebackPath(root, relativePath));
    if (isOriginalImagePath(relativePath)) {
      const bytes = Array.from(buffer.values());
      comparisons[relativePath] = `binary:${createHash('sha256').update(buffer).digest('hex')}`;
      contents[relativePath] = { relativePath, encoding: 'binary', content: bytes };
    } else {
      const content = buffer.toString('utf8');
      comparisons[relativePath] = content;
      contents[relativePath] = { relativePath, encoding: 'utf8', content };
    }
  }
  return { comparisons, contents };
}

async function collectFiles(root: string, current = ''): Promise<string[]> {
  const directory = current ? resolve(root, current) : root;
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const next = current ? `${current}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await collectFiles(root, next));
    else if (entry.isFile()) files.push(next.replace(/\\/g, '/'));
  }
  return files;
}

function encodeFile(file: PlannedWriteFile): string | Uint8Array {
  if ((file.encoding === 'utf8' || file.encoding === undefined) && typeof file.content === 'string') return file.content;
  if (file.encoding === 'binary' && Array.isArray(file.content)) return Uint8Array.from(file.content);
  throw new Error('writeback file encoding mismatch');
}

function clonePlannedFile(file: PlannedWriteFile): PlannedWriteFile {
  return { ...file, content: Array.isArray(file.content) ? [...file.content] : file.content };
}

function toPlannedPath(entry: MemoryDiffEntry): PlannedPath { return { relativePath: entry.relativePath }; }
function shouldIncludeInWriteback(path: string, includeImages: boolean) { return isMemoryFile(path) || (includeImages && isOriginalImagePath(path)); }
function isMemoryFile(path: string) { return path.startsWith('memory/') && extname(path).toLowerCase() === '.md'; }
function isOriginalImagePath(path: string) { return path.startsWith('memory/originals/') && ['.png', '.jpg', '.jpeg', '.webp'].includes(extname(path).toLowerCase()); }
function hashDiff(diff: MemoryDiffEntry[]) { return createHash('sha256').update(JSON.stringify(diff)).digest('hex'); }
function resolveWritebackPath(root: string, relativePath: string) {
  const base = resolve(root);
  const target = resolveManagedPath(base, relativePath);
  if (target !== base && !target.startsWith(`${base}${sep}`)) throw new Error('path is outside writeback root');
  return target;
}
function relativeToRoot(root: string, target: string) {
  const base = resolve(root);
  const resolvedTarget = resolve(target);
  if (resolvedTarget !== base && !resolvedTarget.startsWith(`${base}${sep}`)) throw new Error('history path is outside app root');
  return resolvedTarget.slice(base.length + 1);
}
function invalidApprovalRecord(id: string, target: WritebackTarget, diffHash: string) {
  const record: WritebackTokenRecord = { id, target, diffHash, tokenHash: '', issuedAt: new Date(0).toISOString(), expiresAt: new Date(0).toISOString() };
  return { ok: false as const, reason: 'invalid' as const, record };
}

async function appendSanitizedHistory(historyPath: string, entry: {
  appliedAt: string; target: WritebackTarget; diffHash: string; writtenFiles: string[]; preservedFiles: string[]; blockedFiles: string[];
}) {
  await mkdir(dirname(historyPath), { recursive: true });
  await appendFile(historyPath, `${JSON.stringify(entry).replace(/[A-Z]:\\\\[^\"]+/g, '[REDACTED_PATH]')}\n`, 'utf8');
}