import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const MCP_RUNTIME_PROTOCOL = 'canvasforge.mcp.runtime.v1' as const;
export const MCP_RUNTIME_TTL_MS = 15 * 60 * 1_000;

export interface CanvasMcpRuntimeDescriptor {
  readonly protocol: typeof MCP_RUNTIME_PROTOCOL;
  readonly instanceId: string;
  readonly pipeName: string;
  readonly authToken: string;
  readonly serverVersion: string;
  readonly startedAt: string;
  readonly expiresAt: string;
  readonly processId: number;
}

export interface CreateMcpRuntimeDescriptorOptions {
  readonly instanceId: string;
  readonly processId: number;
  readonly serverVersion: string;
  readonly now?: Date;
  readonly randomHex?: string;
  readonly authToken?: string;
}

export interface ParseMcpRuntimeFileOptions {
  readonly now?: Date;
  readonly isProcessAlive?: (processId: number) => boolean;
}

export function createMcpRuntimeDescriptor(
  options: CreateMcpRuntimeDescriptorOptions,
): CanvasMcpRuntimeDescriptor {
  const now = options.now ?? new Date();
  const randomHex = normalizeOpaqueId(options.randomHex ?? randomBytes(8).toString('hex'));
  const instanceId = normalizeOpaqueId(options.instanceId);
  const authToken = options.authToken ?? randomBytes(32).toString('hex');
  if (!Number.isInteger(options.processId) || options.processId <= 0) throw stableError('MCP_RUNTIME_INVALID_PROCESS');
  if (authToken.length < 12 || authToken.length > 256) throw stableError('MCP_RUNTIME_INVALID_AUTH');
  return Object.freeze({
    protocol: MCP_RUNTIME_PROTOCOL,
    instanceId,
    pipeName: `\\\\.\\pipe\\canvasforge-mcp-${instanceId}-${randomHex}`,
    authToken,
    serverVersion: normalizeText(options.serverVersion, 80),
    startedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + MCP_RUNTIME_TTL_MS).toISOString(),
    processId: options.processId,
  });
}

export function parseMcpRuntimeFile(
  input: unknown,
  options: ParseMcpRuntimeFileOptions = {},
): CanvasMcpRuntimeDescriptor {
  const value = typeof input === 'string' ? parseJson(input) : input;
  if (!isPlainRecord(value) || !hasExactKeys(value, [
    'protocol', 'instanceId', 'pipeName', 'authToken', 'serverVersion', 'startedAt', 'expiresAt', 'processId',
  ])) throw stableError('MCP_RUNTIME_INVALID');
  if (value.protocol !== MCP_RUNTIME_PROTOCOL) throw stableError('MCP_RUNTIME_INVALID_PROTOCOL');
  const descriptor: CanvasMcpRuntimeDescriptor = {
    protocol: MCP_RUNTIME_PROTOCOL,
    instanceId: normalizeOpaqueId(value.instanceId),
    pipeName: normalizePipeName(value.pipeName),
    authToken: normalizeAuthToken(value.authToken),
    serverVersion: normalizeText(value.serverVersion, 80),
    startedAt: normalizeDate(value.startedAt),
    expiresAt: normalizeDate(value.expiresAt),
    processId: normalizeProcessId(value.processId),
  };
  const now = options.now ?? new Date();
  if (Date.parse(descriptor.expiresAt) <= now.getTime()) throw stableError('MCP_RUNTIME_EXPIRED');
  const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  if (!isProcessAlive(descriptor.processId)) throw stableError('MCP_RUNTIME_STALE_PROCESS');
  return Object.freeze(descriptor);
}

export async function writeMcpRuntimeFile(
  runtimeFilePath: string,
  descriptor: CanvasMcpRuntimeDescriptor,
): Promise<void> {
  const parsed = parseMcpRuntimeFile(descriptor, { now: new Date(descriptor.startedAt), isProcessAlive: () => true });
  const temporaryPath = `${runtimeFilePath}.tmp`;
  await mkdir(dirname(runtimeFilePath), { recursive: true });
  await writeFile(temporaryPath, `${JSON.stringify(parsed)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    await chmod(temporaryPath, 0o600);
  } catch {
    // Windows ACLs are inherited from the user profile directory. chmod is best effort.
  }
  await rename(temporaryPath, runtimeFilePath);
}

export async function readMcpRuntimeFile(
  runtimeFilePath: string,
  options: ParseMcpRuntimeFileOptions = {},
): Promise<CanvasMcpRuntimeDescriptor> {
  return parseMcpRuntimeFile(await readFile(runtimeFilePath, 'utf8'), options);
}

export async function deleteMcpRuntimeFile(runtimeFilePath: string): Promise<void> {
  await rm(runtimeFilePath, { force: true });
  await rm(`${runtimeFilePath}.tmp`, { force: true });
}

function parseJson(input: string): unknown {
  try {
    return JSON.parse(input) as unknown;
  } catch {
    throw stableError('MCP_RUNTIME_INVALID_JSON');
  }
}

function normalizeOpaqueId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,160}$/u.test(value)) throw stableError('MCP_RUNTIME_INVALID_ID');
  return value;
}

function normalizePipeName(value: unknown): string {
  if (typeof value !== 'string' || !/^\\\\\.\\pipe\\canvasforge-mcp-[A-Za-z0-9_-]+-[A-Za-z0-9_-]+$/u.test(value)) {
    throw stableError('MCP_RUNTIME_INVALID_PIPE');
  }
  return value;
}

function normalizeAuthToken(value: unknown): string {
  if (typeof value !== 'string' || value.length < 12 || value.length > 256 || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw stableError('MCP_RUNTIME_INVALID_AUTH');
  }
  return value;
}

function normalizeText(value: unknown, maxLength: number): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maxLength) throw stableError('MCP_RUNTIME_INVALID_TEXT');
  return value;
}

function normalizeDate(value: unknown): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw stableError('MCP_RUNTIME_INVALID_DATE');
  return new Date(value).toISOString();
}

function normalizeProcessId(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) throw stableError('MCP_RUNTIME_INVALID_PROCESS');
  return value;
}

function defaultIsProcessAlive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return isNodeError(error, 'EPERM');
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && (error as Error & { code?: unknown }).code === code;
}

function stableError(code: string): Error {
  return new Error(code);
}