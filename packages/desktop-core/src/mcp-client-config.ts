import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

export type McpClientId = 'codex' | 'workbuddy';
const MCP_SERVER_KEY = 'canvas_atelier' as const;
export type McpClientConnectionState = 'unconfigured' | 'configured' | 'connected' | 'connection_failed';

export interface McpClientHealthResult {
  readonly connected: boolean;
  readonly toolCount: 14;
}

export interface McpClientStatus {
  readonly client: McpClientId;
  readonly state: McpClientConnectionState;
  readonly toolCount: 14 | 0;
  readonly lastError: string | null;
}

export interface McpClientConfigManagerOptions {
  readonly clientPaths: Readonly<Record<McpClientId, string>>;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly now?: () => Date;
  readonly healthCheck: (client: McpClientId) => Promise<McpClientHealthResult>;
}

export interface McpClientConfigManager {
  connect(client: McpClientId): Promise<McpClientStatus>;
  disconnect(client: McpClientId): Promise<McpClientStatus>;
  getStatus(client: McpClientId): Promise<McpClientStatus>;
  test(client: McpClientId): Promise<McpClientStatus>;
  copyConfig(client: McpClientId): string;
}

export function createMcpClientConfigManager(options: McpClientConfigManagerOptions): McpClientConfigManager {
  const spec = Object.freeze({ command: options.command, args: [...options.args], env: { ...options.env } });
  const now = options.now ?? (() => new Date());

  async function connect(client: McpClientId): Promise<McpClientStatus> {
    const path = options.clientPaths[client];
    const current = await readOptionalFile(path);
    if (current.exists) await writeBackup(path, current.text, now());
    let merged: string;
    try {
      merged = client === 'codex' ? mergeCodexConfig(current.text, spec) : mergeWorkBuddyConfig(current.text, spec);
    } catch (error) {
      throw normalizeConfigError(error, 'MCP_CONFIG_PARSE_FAILED');
    }
    try {
      await atomicWrite(path, merged);
      const health = await options.healthCheck(client);
      if (!health.connected || health.toolCount !== 14) throw new McpClientConfigError('MCP_CONFIG_HEALTH_CHECK_FAILED');
      return { client, state: 'connected', toolCount: 14, lastError: null };
    } catch (error) {
      await restoreOriginal(path, current);
      if (error instanceof McpClientConfigError) throw error;
      throw new McpClientConfigError('MCP_CONFIG_HEALTH_CHECK_FAILED');
    }
  }

  async function disconnect(client: McpClientId): Promise<McpClientStatus> {
    const path = options.clientPaths[client];
    const current = await readOptionalFile(path);
    if (!current.exists) return { client, state: 'unconfigured', toolCount: 0, lastError: null };
    await writeBackup(path, current.text, now());
    let next: string;
    try {
      next = client === 'codex' ? removeCodexConfig(current.text) : removeWorkBuddyConfig(current.text);
    } catch (error) {
      throw normalizeConfigError(error, 'MCP_CONFIG_PARSE_FAILED');
    }
    await atomicWrite(path, next);
    return { client, state: 'unconfigured', toolCount: 0, lastError: null };
  }

  async function getStatus(client: McpClientId): Promise<McpClientStatus> {
    const current = await readOptionalFile(options.clientPaths[client]);
    if (!current.exists) return { client, state: 'unconfigured', toolCount: 0, lastError: null };
    try {
      const configured = client === 'codex' ? hasCodexConfig(current.text) : hasWorkBuddyConfig(current.text);
      return { client, state: configured ? 'configured' : 'unconfigured', toolCount: 0, lastError: null };
    } catch {
      return { client, state: 'connection_failed', toolCount: 0, lastError: 'MCP_CONFIG_PARSE_FAILED' };
    }
  }

  async function test(client: McpClientId): Promise<McpClientStatus> {
    try {
      const health = await options.healthCheck(client);
      return health.connected && health.toolCount === 14
        ? { client, state: 'connected', toolCount: 14, lastError: null }
        : { client, state: 'connection_failed', toolCount: 0, lastError: 'MCP_CONFIG_HEALTH_CHECK_FAILED' };
    } catch {
      return { client, state: 'connection_failed', toolCount: 0, lastError: 'MCP_CONFIG_HEALTH_CHECK_FAILED' };
    }
  }

  return {
    connect,
    disconnect,
    getStatus,
    test,
    copyConfig(client) {
      return client === 'codex'
        ? `${renderCodexSection(spec)}\n`
        : `${JSON.stringify({ mcpServers: { [MCP_SERVER_KEY]: spec } }, null, 2)}\n`;
    },
  };
}

class McpClientConfigError extends Error {
  constructor(code: string) {
    super(code);
    this.name = 'McpClientConfigError';
  }
}

interface FileSnapshot {
  readonly exists: boolean;
  readonly text: string;
}

type McpLaunchSpec = {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
};

async function readOptionalFile(path: string): Promise<FileSnapshot> {
  try {
    return { exists: true, text: await readFile(path, 'utf8') };
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return { exists: false, text: '' };
    throw error;
  }
}

async function writeBackup(path: string, text: string, date: Date): Promise<void> {
  const backup = join(dirname(path), `${basename(path)}.canvasforge-backup-${formatTimestamp(date)}`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(backup, text, 'utf8');
}

async function atomicWrite(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.canvasforge-tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, text, 'utf8');
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function restoreOriginal(path: string, snapshot: FileSnapshot): Promise<void> {
  if (snapshot.exists) {
    await atomicWrite(path, snapshot.text);
  } else {
    await rm(path, { force: true });
  }
}

function mergeWorkBuddyConfig(text: string, spec: McpLaunchSpec): string {
  const root = parseWorkBuddyRoot(text);
  const servers = isPlainRecord(root.mcpServers) ? { ...root.mcpServers } : {};
  servers[MCP_SERVER_KEY] = cloneSpec(spec);
  return `${JSON.stringify({ ...root, mcpServers: servers }, null, 2)}\n`;
}

function removeWorkBuddyConfig(text: string): string {
  const root = parseWorkBuddyRoot(text);
  if (!isPlainRecord(root.mcpServers)) return `${JSON.stringify(root, null, 2)}\n`;
  const servers = { ...root.mcpServers };
  delete servers[MCP_SERVER_KEY];
  return `${JSON.stringify({ ...root, mcpServers: servers }, null, 2)}\n`;
}

function hasWorkBuddyConfig(text: string): boolean {
  const root = parseWorkBuddyRoot(text);
  return isPlainRecord(root.mcpServers) && isPlainRecord(root.mcpServers[MCP_SERVER_KEY]);
}

function parseWorkBuddyRoot(text: string): Record<string, unknown> {
  if (text.trim().length === 0) return {};
  const value = JSON.parse(text) as unknown;
  if (!isPlainRecord(value)) throw new McpClientConfigError('MCP_CONFIG_PARSE_FAILED');
  return value;
}

function mergeCodexConfig(text: string, spec: McpLaunchSpec): string {
  const sections = findCodexSections(text);
  if (sections.length > 1) throw new McpClientConfigError('MCP_CONFIG_DUPLICATE_SECTION');
  const rendered = renderCodexSection(spec);
  if (sections.length === 0) {
    const separator = text.length === 0 || text.endsWith('\n') ? '' : '\n';
    return `${text}${separator}${rendered}\n`;
  }
  const section = sections[0]!;
  return `${text.slice(0, section.start)}${rendered}\n${text.slice(section.end)}`;
}

function removeCodexConfig(text: string): string {
  const sections = findCodexSections(text);
  if (sections.length > 1) throw new McpClientConfigError('MCP_CONFIG_DUPLICATE_SECTION');
  if (sections.length === 0) return text;
  const section = sections[0]!;
  return `${text.slice(0, section.start)}${text.slice(section.end)}`;
}

function hasCodexConfig(text: string): boolean {
  const sections = findCodexSections(text);
  if (sections.length > 1) throw new McpClientConfigError('MCP_CONFIG_DUPLICATE_SECTION');
  return sections.length === 1;
}

function findCodexSections(text: string): Array<{ start: number; end: number }> {
  const header = /^\[mcp_servers\.canvas_atelier\][ \t]*(?:\r?\n|$)/gmu;
  const matches = [...text.matchAll(header)];
  return matches.map((match) => {
    const start = match.index ?? 0;
    const afterHeader = start + match[0].length;
    const nextHeader = /^\[[^\r\n\]]+\][ \t]*(?:\r?\n|$)/gmu;
    nextHeader.lastIndex = afterHeader;
    const next = nextHeader.exec(text);
    return { start, end: next?.index ?? text.length };
  });
}

function renderCodexSection(spec: McpLaunchSpec): string {
  const args = spec.args.map(tomlString).join(', ');
  const env = Object.entries(spec.env)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key} = ${tomlString(value)}`)
    .join(', ');
  return [
    '[mcp_servers.canvas_atelier]',
    `command = ${tomlString(spec.command)}`,
    `args = [${args}]`,
    `env = { ${env} }`,
  ].join('\n');
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function cloneSpec(spec: McpLaunchSpec): Record<string, unknown> {
  return { command: spec.command, args: [...spec.args], env: { ...spec.env } };
}

function formatTimestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
}

function normalizeConfigError(error: unknown, fallback: string): Error {
  return error instanceof McpClientConfigError ? error : new McpClientConfigError(fallback);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && 'code' in value;
}
