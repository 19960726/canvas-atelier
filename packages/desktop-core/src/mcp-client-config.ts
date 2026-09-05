import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

export type McpClientId = 'codex' | 'workbuddy';
const MCP_SERVER_KEY = 'canvas_atelier' as const;
const configMutationTails = new Map<string, Promise<void>>();
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

  function connect(client: McpClientId): Promise<McpClientStatus> {
    return withConfigMutationLock(options.clientPaths[client], () => connectUnlocked(client));
  }

  async function connectUnlocked(client: McpClientId): Promise<McpClientStatus> {
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

  function disconnect(client: McpClientId): Promise<McpClientStatus> {
    return withConfigMutationLock(options.clientPaths[client], () => disconnectUnlocked(client));
  }

  async function disconnectUnlocked(client: McpClientId): Promise<McpClientStatus> {
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
      const configuration = client === 'codex'
        ? classifyCodexConfig(current.text, spec)
        : classifyWorkBuddyConfig(current.text, spec);
      if (configuration === 'mismatch') {
        return { client, state: 'connection_failed', toolCount: 0, lastError: 'MCP_CONFIG_MISMATCH' };
      }
      return { client, state: configuration === 'matching' ? 'configured' : 'unconfigured', toolCount: 0, lastError: null };
    } catch {
      return { client, state: 'connection_failed', toolCount: 0, lastError: 'MCP_CONFIG_PARSE_FAILED' };
    }
  }

  async function test(client: McpClientId): Promise<McpClientStatus> {
    const current = await readOptionalFile(options.clientPaths[client]);
    if (!current.exists) return { client, state: 'unconfigured', toolCount: 0, lastError: null };
    let configuration: 'missing' | 'matching' | 'mismatch';
    try {
      configuration = client === 'codex'
        ? classifyCodexConfig(current.text, spec)
        : classifyWorkBuddyConfig(current.text, spec);
    } catch {
      return { client, state: 'connection_failed', toolCount: 0, lastError: 'MCP_CONFIG_PARSE_FAILED' };
    }
    if (configuration === 'missing') {
      return { client, state: 'unconfigured', toolCount: 0, lastError: null };
    }
    if (configuration === 'mismatch') {
      return { client, state: 'connection_failed', toolCount: 0, lastError: 'MCP_CONFIG_MISMATCH' };
    }
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

function withConfigMutationLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const previous = configMutationTails.get(path) ?? Promise.resolve();
  const result = previous.then(operation, operation);
  const tail = result.then(() => undefined, () => undefined);
  configMutationTails.set(path, tail);
  void tail.then(() => {
    if (configMutationTails.get(path) === tail) configMutationTails.delete(path);
  });
  return result;
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

type CodexTomlSection = {
  readonly start: number;
  readonly contentStart: number;
  readonly end: number;
};

type CodexTomlTarget = {
  readonly sections: readonly CodexTomlSection[];
  readonly roots: readonly CodexTomlSection[];
};

type CodexTomlHeader = {
  readonly start: number;
  readonly contentStart: number;
  readonly path: readonly string[];
  readonly array: boolean;
};

type CodexTomlAssignment = {
  readonly start: number;
  readonly end: number;
  readonly path: readonly string[];
};

type CodexTomlDocument = {
  readonly headers: readonly CodexTomlHeader[];
  readonly assignments: readonly CodexTomlAssignment[];
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
  const backupBase = join(dirname(path), `${basename(path)}.canvas-atelier-backup-${formatTimestamp(date)}`);
  await mkdir(dirname(path), { recursive: true });
  for (let sequence = 0; sequence < 1_000; sequence += 1) {
    const backup = sequence === 0 ? backupBase : `${backupBase}-${sequence}`;
    try {
      await writeFile(backup, text, { encoding: 'utf8', flag: 'wx' });
      return;
    } catch (error) {
      if (isNodeError(error) && error.code === 'EEXIST') continue;
      throw error;
    }
  }
  throw new McpClientConfigError('MCP_CONFIG_BACKUP_FAILED');
}

async function atomicWrite(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.canvas-atelier-tmp-${process.pid}-${Date.now()}`;
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

function classifyWorkBuddyConfig(text: string, spec: McpLaunchSpec): 'missing' | 'matching' | 'mismatch' {
  const root = parseWorkBuddyRoot(text);
  if (!isPlainRecord(root.mcpServers)
    || !Object.prototype.hasOwnProperty.call(root.mcpServers, MCP_SERVER_KEY)) return 'missing';
  const candidate = root.mcpServers[MCP_SERVER_KEY];
  if (!isPlainRecord(candidate)
    || !sameKeys(candidate, ['args', 'command', 'env'])
    || candidate.command !== spec.command
    || !sameStringArray(candidate.args, spec.args)
    || !sameStringRecord(candidate.env, spec.env)) return 'mismatch';
  return 'matching';
}

function parseWorkBuddyRoot(text: string): Record<string, unknown> {
  if (text.trim().length === 0) return {};
  const value = JSON.parse(text) as unknown;
  if (!isPlainRecord(value)) throw new McpClientConfigError('MCP_CONFIG_PARSE_FAILED');
  if (Object.prototype.hasOwnProperty.call(value, 'mcpServers') && !isPlainRecord(value.mcpServers)) {
    throw new McpClientConfigError('MCP_CONFIG_PARSE_FAILED');
  }
  return value;
}

function mergeCodexConfig(text: string, spec: McpLaunchSpec): string {
  const target = findCodexTarget(text);
  if (target.roots.length > 1) throw new McpClientConfigError('MCP_CONFIG_DUPLICATE_SECTION');
  const eol = detectLineEnding(text);
  const rendered = renderCodexSection(spec).split('\n').join(eol);
  if (target.sections.length === 0) {
    const separator = text.length === 0 || text.endsWith('\n') ? '' : eol;
    return `${text}${separator}${rendered}${eol}`;
  }
  if (target.roots.length === 0) {
    const withoutDottedTarget = replaceCodexSections(text, target.sections, '');
    const separator = withoutDottedTarget.length === 0 || withoutDottedTarget.endsWith('\n') ? '' : eol;
    return `${withoutDottedTarget}${separator}${rendered}${eol}`;
  }
  return replaceCodexSections(text, target.sections, `${rendered}${eol}`);
}

function removeCodexConfig(text: string): string {
  const target = findCodexTarget(text);
  if (target.roots.length > 1) throw new McpClientConfigError('MCP_CONFIG_DUPLICATE_SECTION');
  return replaceCodexSections(text, target.sections, '');
}

function classifyCodexConfig(text: string, spec: McpLaunchSpec): 'missing' | 'matching' | 'mismatch' {
  const target = findCodexTarget(text);
  if (target.roots.length > 1) throw new McpClientConfigError('MCP_CONFIG_DUPLICATE_SECTION');
  if (target.sections.length === 0) return 'missing';
  if (target.roots.length !== 1 || target.sections.length !== 1) return 'mismatch';
  const section = target.roots[0]!;
  const expectedBody = renderCodexSection(spec).split('\n').slice(1).join('\n');
  const actualBody = text.slice(section.contentStart, section.end).replace(/\r\n/gu, '\n').trim();
  return actualBody === expectedBody
    ? 'matching'
    : 'mismatch';
}

function findCodexTarget(text: string): CodexTomlTarget {
  const document = scanCodexToml(text);
  const headers = document.headers;
  const sections: CodexTomlSection[] = [];
  const roots: CodexTomlSection[] = [];
  headers.forEach((header, index) => {
    if (header.path.length < 2 || header.path[0] !== 'mcp_servers' || header.path[1] !== MCP_SERVER_KEY) return;
    const section = {
      start: header.start,
      contentStart: header.contentStart,
      end: headers[index + 1]?.start ?? text.length,
    };
    sections.push(section);
    if (!header.array && header.path.length === 2) roots.push(section);
  });
  for (const assignment of document.assignments) {
    if (!isCanvasAtelierTomlPath(assignment.path)) continue;
    sections.push({ start: assignment.start, contentStart: assignment.end, end: assignment.end });
  }
  return { sections: coalesceCodexSections(sections), roots };
}

function isCanvasAtelierTomlPath(path: readonly string[]): boolean {
  return path.length >= 2 && path[0] === 'mcp_servers' && path[1] === MCP_SERVER_KEY;
}

function coalesceCodexSections(sections: readonly CodexTomlSection[]): readonly CodexTomlSection[] {
  const sorted = [...sections].sort((left, right) => left.start - right.start || right.end - left.end);
  const result: CodexTomlSection[] = [];
  for (const section of sorted) {
    const previous = result[result.length - 1];
    if (previous !== undefined && section.start <= previous.end) {
      if (section.end > previous.end) result[result.length - 1] = { ...previous, end: section.end };
      continue;
    }
    result.push(section);
  }
  return result;
}

function replaceCodexSections(text: string, sections: readonly CodexTomlSection[], replacement: string): string {
  if (sections.length === 0) return text;
  let result = '';
  let cursor = 0;
  sections.forEach((section, index) => {
    result += text.slice(cursor, section.start);
    if (index === 0) result += replacement;
    cursor = section.end;
  });
  return `${result}${text.slice(cursor)}`;
}

function scanCodexToml(text: string): CodexTomlDocument {
  const headers: CodexTomlHeader[] = [];
  const assignments: CodexTomlAssignment[] = [];
  let currentTablePath: readonly string[] = [];
  let lineStart = 0;
  while (lineStart < text.length) {
    const newline = text.indexOf('\n', lineStart);
    const physicalEnd = newline < 0 ? text.length : newline;
    const contentEnd = physicalEnd > lineStart && text[physicalEnd - 1] === '\r' ? physicalEnd - 1 : physicalEnd;
    const line = text.slice(lineStart, contentEnd);
    const first = skipHorizontalWhitespace(line, 0);
    if (first >= line.length || line[first] === '#') {
      lineStart = newline < 0 ? text.length : newline + 1;
      continue;
    }
    if (line[first] === '[') {
      const parsed = parseTomlTableHeader(line, first);
      currentTablePath = parsed.path;
      headers.push({
        start: lineStart,
        contentStart: newline < 0 ? text.length : newline + 1,
        path: parsed.path,
        array: parsed.array,
      });
      lineStart = newline < 0 ? text.length : newline + 1;
      continue;
    }

    const parsedKey = parseTomlDottedKey(line, first, '=');
    let valueStart = skipHorizontalWhitespace(line, parsedKey.end + 1);
    if (valueStart >= line.length || line[valueStart] === '#') throw new McpClientConfigError('MCP_CONFIG_PARSE_FAILED');
    valueStart += lineStart;
    const valueEnd = parseTomlValue(text, valueStart);
    let assignmentEnd = skipHorizontalWhitespace(text, valueEnd);
    if (text[assignmentEnd] === '#') {
      while (assignmentEnd < text.length && text[assignmentEnd] !== '\r' && text[assignmentEnd] !== '\n') assignmentEnd += 1;
    }
    if (text[assignmentEnd] === '\r') {
      if (text[assignmentEnd + 1] !== '\n') throw new McpClientConfigError('MCP_CONFIG_PARSE_FAILED');
      assignmentEnd += 2;
    } else if (text[assignmentEnd] === '\n') {
      assignmentEnd += 1;
    } else if (assignmentEnd !== text.length) {
      throw new McpClientConfigError('MCP_CONFIG_PARSE_FAILED');
    }
    assignments.push({
      start: lineStart,
      end: assignmentEnd,
      path: [...currentTablePath, ...parsedKey.path],
    });
    lineStart = assignmentEnd;
  }
  return { headers, assignments };
}

function parseTomlValue(text: string, start: number): number {
  if (text.startsWith('"""', start)) return parseTomlMultilineBasicString(text, start);
  if (text.startsWith("'''", start)) return parseTomlMultilineLiteralString(text, start);
  if (text[start] === '"') return parseTomlBasicQuotedString(text, start).end;
  if (text[start] === "'") return parseTomlLiteralQuotedString(text, start).end;
  if (text[start] === '[') return parseTomlArray(text, start);
  if (text[start] === '{') return parseTomlInlineTable(text, start);
  return parseTomlScalar(text, start);
}

function parseTomlArray(text: string, start: number): number {
  let index = skipTomlCollectionWhitespace(text, start + 1);
  if (text[index] === ']') return index + 1;
  while (index < text.length) {
    index = parseTomlValue(text, index);
    index = skipTomlCollectionWhitespace(text, index);
    if (text[index] === ']') return index + 1;
    if (text[index] !== ',') throw new McpClientConfigError('MCP_CONFIG_PARSE_FAILED');
    index = skipTomlCollectionWhitespace(text, index + 1);
    if (text[index] === ']') return index + 1;
  }
  throw new McpClientConfigError('MCP_CONFIG_PARSE_FAILED');
}

function parseTomlInlineTable(text: string, start: number): number {
  let index = skipHorizontalWhitespace(text, start + 1);
  if (text[index] === '}') return index + 1;
  while (index < text.length) {
    const parsedKey = parseTomlDottedKey(text, index, '=');
    index = skipHorizontalWhitespace(text, parsedKey.end + 1);
    if (text[index] === '\r' || text[index] === '\n' || text[index] === '#') throw new McpClientConfigError('MCP_CONFIG_PARSE_FAILED');
    index = parseTomlValue(text, index);
    index = skipHorizontalWhitespace(text, index);
    if (text[index] === '}') return index + 1;
    if (text[index] !== ',') throw new McpClientConfigError('MCP_CONFIG_PARSE_FAILED');
    index = skipHorizontalWhitespace(text, index + 1);
    if (text[index] === '}') throw new McpClientConfigError('MCP_CONFIG_PARSE_FAILED');
  }
  throw new McpClientConfigError('MCP_CONFIG_PARSE_FAILED');
}

function parseTomlScalar(text: string, start: number): number {
  let end = start;
  while (end < text.length && text[end] !== '#' && text[end] !== ',' && text[end] !== ']' && text[end] !== '}'
    && text[end] !== '\r' && text[end] !== '\n') end += 1;
  const token = text.slice(start, end).trimEnd();
  if (!isValidTomlScalar(token)) throw new McpClientConfigError('MCP_CONFIG_PARSE_FAILED');
  return start + token.length;
}

function isValidTomlScalar(token: string): boolean {
  if (/^(?:true|false|[+-]?(?:inf|nan))$/u.test(token)) return true;
  if (/^[+-]?0x[0-9A-Fa-f](?:_?[0-9A-Fa-f])*$/u.test(token)) return true;
  if (/^[+-]?0o[0-7](?:_?[0-7])*$/u.test(token)) return true;
  if (/^[+-]?0b[01](?:_?[01])*$/u.test(token)) return true;
  if (/^[+-]?(?:0|[1-9](?:_?\d)*)(?:\.\d(?:_?\d)*)?(?:[eE][+-]?\d(?:_?\d)*)?$/u.test(token)) return true;
  if (/^\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})?)?$/u.test(token)) return true;
  return /^\d{2}:\d{2}:\d{2}(?:\.\d+)?$/u.test(token);
}

function parseTomlMultilineBasicString(text: string, start: number): number {
  let index = start + 3;
  if (text[index] === '\r' && text[index + 1] === '\n') index += 2;
  else if (text[index] === '\n') index += 1;
  while (index < text.length) {
    if (text[index] === '"') {
      const quoteEnd = consumeRepeated(text, index, '"');
      const quoteCount = quoteEnd - index;
      if (quoteCount >= 3) return quoteCount <= 5 ? quoteEnd : index + 3;
      index = quoteEnd;
      continue;
    }
    if (text[index] === '\\') {
      if (text[index + 1] === '\n' || (text[index + 1] === '\r' && text[index + 2] === '\n')) {
        index += text[index + 1] === '\r' ? 3 : 2;
        while (text[index] === ' ' || text[index] === '\t' || text[index] === '\r' || text[index] === '\n') index += 1;
        continue;
      }
      index = validateTomlBasicEscape(text, index);
      continue;
    }
    validateTomlMultilineCharacter(text, index);
    index += 1;
  }
  throw new McpClientConfigError('MCP_CONFIG_PARSE_FAILED');
}

function parseTomlMultilineLiteralString(text: string, start: number): number {
  let index = start + 3;
  if (text[index] === '\r' && text[index + 1] === '\n') index += 2;
  else if (text[index] === '\n') index += 1;
  while (index < text.length) {
    if (text[index] === "'") {
      const quoteEnd = consumeRepeated(text, index, "'");
      const quoteCount = quoteEnd - index;
      if (quoteCount >= 3) return quoteCount <= 5 ? quoteEnd : index + 3;
      index = quoteEnd;
      continue;
    }
    validateTomlMultilineCharacter(text, index);
    index += 1;
  }
  throw new McpClientConfigError('MCP_CONFIG_PARSE_FAILED');
}

function consumeRepeated(text: string, start: number, character: string): number {
  let index = start;
  while (text[index] === character) index += 1;
  return index;
}

function validateTomlMultilineCharacter(text: string, index: number): void {
  const code = text.charCodeAt(index);
  if (code === 0x7F || code === 0x0B || code === 0x0C || code < 0x09 || (code > 0x0D && code < 0x20)
    || (text[index] === '\r' && text[index + 1] !== '\n')) throw new McpClientConfigError('MCP_CONFIG_PARSE_FAILED');
}

function validateTomlBasicEscape(text: string, start: number): number {
  const escape = text[start + 1];
  if (escape === 'u' || escape === 'U') {
    const digits = escape === 'u' ? 4 : 8;
    const encoded = text.slice(start + 2, start + 2 + digits);
    if (!new RegExp(`^[0-9A-Fa-f]{${digits}}$`, 'u').test(encoded)) throw new McpClientConfigError('MCP_CONFIG_PARSE_FAILED');
    const codePoint = Number.parseInt(encoded, 16);
    if (codePoint > 0x10_FFFF || (codePoint >= 0xD800 && codePoint <= 0xDFFF)) throw new McpClientConfigError('MCP_CONFIG_PARSE_FAILED');
    return start + digits + 2;
  }
  if (escape === 'b' || escape === 't' || escape === 'n' || escape === 'f' || escape === 'r' || escape === '"' || escape === '\\') {
    return start + 2;
  }
  throw new McpClientConfigError('MCP_CONFIG_PARSE_FAILED');
}

function skipTomlCollectionWhitespace(text: string, start: number): number {
  let index = start;
  while (index < text.length) {
    if (text[index] === ' ' || text[index] === '\t' || text[index] === '\r' || text[index] === '\n') {
      index += 1;
      continue;
    }
    if (text[index] === '#') {
      while (index < text.length && text[index] !== '\r' && text[index] !== '\n') index += 1;
      continue;
    } else {
      return index;
    }
  }
  return index;
}

function parseTomlTableHeader(line: string, start: number): { path: readonly string[]; array: boolean } {
  const array = line[start + 1] === '[';
  const parsed = parseTomlDottedKey(line, start + (array ? 2 : 1), ']');
  let index = parsed.end;
  if (line[index] !== ']') throw new McpClientConfigError('MCP_CONFIG_PARSE_FAILED');
  index += 1;
  if (array) {
    if (line[index] !== ']') throw new McpClientConfigError('MCP_CONFIG_PARSE_FAILED');
    index += 1;
  }
  index = skipHorizontalWhitespace(line, index);
  if (index < line.length && line[index] !== '#') throw new McpClientConfigError('MCP_CONFIG_PARSE_FAILED');
  return { path: parsed.path, array };
}

function parseTomlDottedKey(line: string, start: number, terminator: ']' | '='): { path: readonly string[]; end: number } {
  const path: string[] = [];
  let index = start;
  while (true) {
    index = skipHorizontalWhitespace(line, index);
    const parsed = parseTomlKeySegment(line, index, terminator);
    path.push(parsed.value);
    index = skipHorizontalWhitespace(line, parsed.end);
    if (line[index] !== '.') break;
    index += 1;
  }
  if (path.length === 0 || line[index] !== terminator) throw new McpClientConfigError('MCP_CONFIG_PARSE_FAILED');
  return { path, end: index };
}

function parseTomlKeySegment(line: string, start: number, terminator: ']' | '='): { value: string; end: number } {
  if (line[start] === '"') return parseTomlBasicQuotedString(line, start);
  if (line[start] === "'") return parseTomlLiteralQuotedString(line, start);
  let end = start;
  while (end < line.length && line[end] !== '.' && line[end] !== terminator && line[end] !== ' ' && line[end] !== '\t') end += 1;
  const value = line.slice(start, end);
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new McpClientConfigError('MCP_CONFIG_PARSE_FAILED');
  return { value, end };
}

function parseTomlBasicQuotedString(line: string, start: number): { value: string; end: number } {
  let value = '';
  let index = start + 1;
  while (index < line.length) {
    const character = line[index]!;
    if (character === '"') return { value, end: index + 1 };
    if (character === '\\') {
      const escapeEnd = validateTomlBasicEscape(line, index);
      const escape = line[index + 1]!;
      value += escape === 'b' ? '\b'
        : escape === 't' ? '\t'
          : escape === 'n' ? '\n'
            : escape === 'f' ? '\f'
              : escape === 'r' ? '\r'
                : escape === '"' ? '"'
                  : escape === '\\' ? '\\'
                    : String.fromCodePoint(Number.parseInt(line.slice(index + 2, escapeEnd), 16));
      index = escapeEnd;
      continue;
    }
    if (character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7F) throw new McpClientConfigError('MCP_CONFIG_PARSE_FAILED');
    value += character;
    index += 1;
  }
  throw new McpClientConfigError('MCP_CONFIG_PARSE_FAILED');
}

function parseTomlLiteralQuotedString(line: string, start: number): { value: string; end: number } {
  const end = line.indexOf("'", start + 1);
  if (end < 0) throw new McpClientConfigError('MCP_CONFIG_PARSE_FAILED');
  const value = line.slice(start + 1, end);
  if ([...value].some((character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7F)) {
    throw new McpClientConfigError('MCP_CONFIG_PARSE_FAILED');
  }
  return { value, end: end + 1 };
}

function skipHorizontalWhitespace(text: string, start: number): number {
  let index = start;
  while (text[index] === ' ' || text[index] === '\t') index += 1;
  return index;
}

function detectLineEnding(text: string): '\n' | '\r\n' {
  const newline = text.indexOf('\n');
  return newline > 0 && text[newline - 1] === '\r' ? '\r\n' : '\n';
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

function sameStringArray(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value)
    && value.length === expected.length
    && value.every((entry, index) => typeof entry === 'string' && entry === expected[index]);
}

function sameStringRecord(value: unknown, expected: Readonly<Record<string, string>>): boolean {
  if (!isPlainRecord(value)) return false;
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = Object.keys(expected).sort();
  return actualKeys.length === expectedKeys.length
    && actualKeys.every((key, index) => key === expectedKeys[index] && value[key] === expected[key]);
}

function sameKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = [...expected].sort();
  return actualKeys.length === expectedKeys.length
    && actualKeys.every((key, index) => key === expectedKeys[index]);
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
