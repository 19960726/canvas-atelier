import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import {
  CODEX_ASTRA_MODEL_ID,
  CODEX_ASTRA_MODEL_ROUTE,
  CODEX_ASTRA_PROFILE,
  CodexCliChatResultSchema,
  parseCodexCliCancelRequest,
  parseCodexCliChatRequest,
  type CodexCliBridgeError,
  type CodexCliChatRequest,
  type CodexCliChatResult,
  type CodexCliCancelResult,
  type CodexCliErrorCode,
  type CodexCliProfile,
} from './codex-cli-contract.js';

export { CODEX_ASTRA_MODEL_ID, CODEX_ASTRA_MODEL_ROUTE } from './codex-cli-contract.js';

export interface CodexCliMcpServer {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

export interface CodexCliProcessInvocation {
  readonly requestId: string;
  readonly executablePath: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly stdin: string;
  readonly timeoutMs: number;
}

export interface CodexCliProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CodexCliRuntimeInfo {
  readonly version: string;
  readonly features: readonly string[];
}

export interface CodexCliProcessRunner {
  inspect?(executablePath: string): Promise<CodexCliRuntimeInfo>;
  run(invocation: CodexCliProcessInvocation): Promise<CodexCliProcessResult>;
  cancel?(requestId: string): Promise<boolean>;
  dispose?(): Promise<void> | void;
}

export interface CodexCliKnowledgeContext {
  readonly knowledgeBaseId: string;
  readonly version: number;
  readonly displayName: string;
  readonly documents: readonly { readonly relativePath: string; readonly content: string }[];
}

export interface CodexCliProjectMemoryContext {
  readonly memoryId: string;
  readonly projectRevision: number;
  readonly summary: string;
}

export interface CodexCliService {
  listProfiles(): Promise<CodexCliProfile[]>;
  chat(request: unknown): Promise<CodexCliChatResult>;
  cancel(request: unknown): Promise<CodexCliCancelResult>;
  dispose(): Promise<void>;
}

export interface CreateCodexCliServiceOptions {
  readonly executablePath: string | null;
  readonly mcpServer: CodexCliMcpServer;
  readonly processRunner?: CodexCliProcessRunner;
  readonly resolveKnowledge?: (ids: readonly string[]) => Promise<readonly CodexCliKnowledgeContext[]>;
  readonly resolveProjectMemory?: (sessionId: string, ids: readonly string[]) => Promise<readonly CodexCliProjectMemoryContext[]>;
}

const CODEX_TIMEOUT_MS = 10 * 60 * 1_000;
const MAX_PROCESS_OUTPUT_BYTES = 4 * 1024 * 1024;
const DISABLED_CODEX_FEATURES = [
  'apps',
  'auth_elicitation',
  'browser_use',
  'browser_use_external',
  'code_mode_host',
  'computer_use',
  'goals',
  'hooks',
  'image_generation',
  'in_app_browser',
  'memories',
  'multi_agent',
  'plugin_sharing',
  'plugins',
  'recommended_plugins',
  'remote_plugin',
  'request_permissions_tool',
  'shell_snapshot',
  'shell_tool',
  'skill_mcp_dependency_install',
  'skill_search',
  'sleep_tool',
  'standalone_web_search',
  'tool_call_mcp_elicitation',
  'tool_suggest',
  'unified_exec',
  'view_image',
  'workspace_dependencies',
] as const;
const REQUIRED_CODEX_FEATURES = [...DISABLED_CODEX_FEATURES, 'skip_host_skill_discovery'] as const;
const CODEX_PROCESS_ENVIRONMENT_KEYS = [
  'SystemRoot', 'WINDIR', 'SystemDrive', 'ComSpec', 'PATH', 'PATHEXT', 'TEMP', 'TMP',
  'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'HOME', 'OS', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS',
  'CODEX_HOME', 'CODEX_API_KEY', 'OPENAI_API_KEY', 'OPENAI_ORG_ID', 'OPENAI_PROJECT_ID', 'OPENAI_BASE_URL',
  'AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_API_VERSION',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
] as const;
const ALLOWED_ITEM_TYPES = new Set(['agent_message', 'mcp_tool_call', 'plan', 'reasoning']);

class CodexCliServiceError extends Error {
  readonly code: CodexCliErrorCode;
  readonly retryable: boolean;

  constructor(code: CodexCliErrorCode, message: string, retryable: boolean) {
    super(message);
    this.name = 'CodexCliServiceError';
    this.code = code;
    this.retryable = retryable;
  }
}

export function createCodexCliService(options: CreateCodexCliServiceOptions): CodexCliService {
  const runner = options.processRunner ?? createNodeCodexCliProcessRunner();
  let disposed = false;
  let activeRequest: {
    readonly requestId: string;
    readonly completion: Promise<CodexCliChatResult>;
    readonly cancellation: { requested: boolean };
  } | null = null;
  let runtimeSafety: Promise<boolean> | null = null;
  const isRuntimeSafe = async () => {
    if (options.executablePath === null || runner.inspect === undefined) return false;
    runtimeSafety ??= runner.inspect(options.executablePath)
      .then((runtime) => isSafeCodexRuntime(runtime), () => false);
    return runtimeSafety;
  };
  return {
    async listProfiles() {
      if (options.executablePath === null || disposed || !await isRuntimeSafe() || disposed) return [];
      return [CODEX_ASTRA_PROFILE];
    },
    async chat(input) {
      if (disposed) throw new CodexCliServiceError('CODEX_CLI_FAILED', 'Codex CLI 已停止。', true);
      const request = parseRequest(input);
      if (activeRequest !== null) {
        throw new CodexCliServiceError('CODEX_CLI_BUSY', '已有 Codex 画布请求正在执行，请等待或先取消。', true);
      }
      if (options.executablePath === null) {
        throw new CodexCliServiceError('CODEX_CLI_NOT_INSTALLED', '未检测到可执行的 Codex CLI。', false);
      }
      const cancellation = { requested: false };
      const completion = executeCodexRequest(request, cancellation).finally(() => {
        if (activeRequest?.requestId === request.requestId) activeRequest = null;
      });
      activeRequest = { requestId: request.requestId, completion, cancellation };
      return completion;
    },
    async cancel(input) {
      let request;
      try {
        request = parseCodexCliCancelRequest(input);
      } catch {
        throw new CodexCliServiceError('CODEX_CLI_INVALID_REQUEST', 'Codex CLI 取消请求参数无效。', false);
      }
      const current = activeRequest;
      if (current === null || current.requestId !== request.requestId) {
        return { cancelled: false };
      }
      current.cancellation.requested = true;
      await runner.cancel?.(request.requestId);
      await current.completion.catch(() => undefined);
      return { cancelled: true };
    },
    async dispose() {
      disposed = true;
      if (activeRequest !== null) activeRequest.cancellation.requested = true;
      const completion = activeRequest?.completion;
      try {
        await runner.dispose?.();
      } finally {
        await completion?.catch(() => undefined);
      }
    },
  };

  async function executeCodexRequest(
    request: CodexCliChatRequest,
    cancellation: { requested: boolean },
  ): Promise<CodexCliChatResult> {
    if (!await isRuntimeSafe()) {
      throw new CodexCliServiceError('CODEX_CLI_UNSAFE_RUNTIME', '当前 Codex CLI 缺少安全执行能力，请更新 Codex 后重试。', false);
    }
    throwIfCodexCancelled(cancellation);
    const [knowledge, projectMemory] = await Promise.all([
        request.context.knowledgeBaseIds.length === 0 || options.resolveKnowledge === undefined
          ? Promise.resolve([])
          : options.resolveKnowledge(request.context.knowledgeBaseIds),
        request.context.projectMemoryIds.length === 0 || options.resolveProjectMemory === undefined
          ? Promise.resolve([])
          : options.resolveProjectMemory(request.sessionId, request.context.projectMemoryIds),
    ]);
    throwIfCodexCancelled(cancellation);
    const executionRoot = await mkdtemp(join(tmpdir(), 'canvas-atelier-codex-'));
    try {
      const executablePath = options.executablePath;
      if (executablePath === null) {
        throw new CodexCliServiceError('CODEX_CLI_NOT_INSTALLED', '未检测到可执行的 Codex CLI。', false);
      }
      const result = await runner.run({
        executablePath,
        requestId: request.requestId,
        args: buildCodexCliArgs(options.mcpServer, request.reasoningEffort, executionRoot),
        cwd: executionRoot,
        stdin: buildCodexPrompt(request, knowledge, projectMemory),
        timeoutMs: CODEX_TIMEOUT_MS,
      });
      throwIfCodexCancelled(cancellation);
      return parseCodexResult(result, knowledge);
    } finally {
      await rm(executionRoot, { recursive: true, force: true });
    }
  }
}

function throwIfCodexCancelled(cancellation: { requested: boolean }): void {
  if (cancellation.requested) {
    throw new CodexCliServiceError('CODEX_CLI_CANCELLED', 'Codex CLI 请求已取消。', true);
  }
}

function isSafeCodexRuntime(runtime: CodexCliRuntimeInfo): boolean {
  const match = /^codex-cli\s+(\d+)\.(\d+)\.(\d+)(.*)$/u.exec(runtime.version.trim());
  if (match === null) return false;
  const version = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  const minimum = [0, 153, 0] as const;
  for (let index = 0; index < version.length; index += 1) {
    if (version[index]! > minimum[index]!) break;
    if (version[index]! < minimum[index]!) return false;
    if (index === version.length - 1 && match[4]!.startsWith('-')) return false;
  }
  const features = new Set(runtime.features);
  return REQUIRED_CODEX_FEATURES.every((feature) => features.has(feature));
}

function parseRequest(input: unknown): CodexCliChatRequest {
  try {
    return parseCodexCliChatRequest(input);
  } catch {
    throw new CodexCliServiceError('CODEX_CLI_INVALID_REQUEST', 'Codex CLI 请求参数无效。', false);
  }
}

export function buildCodexCliArgs(
  mcpServer: CodexCliMcpServer,
  reasoningEffort: CodexCliChatRequest['reasoningEffort'],
  cwd: string,
): string[] {
  if (!isAbsolute(mcpServer.command) || !isAbsolute(cwd)) {
    throw new CodexCliServiceError('CODEX_CLI_INVALID_REQUEST', 'Codex CLI 执行路径无效。', false);
  }
  const disabledFeatures = DISABLED_CODEX_FEATURES.flatMap((feature) => ['--disable', feature]);
  return [
    'exec',
    '--ignore-user-config',
    '--ignore-rules',
    '--ephemeral',
    '--json',
    '--color',
    'never',
    '--skip-git-repo-check',
    '--sandbox',
    'read-only',
    ...disabledFeatures,
    '--enable',
    'skip_host_skill_discovery',
    '-c',
    'approval_policy="never"',
    '-C',
    cwd,
    '-m',
    CODEX_ASTRA_MODEL_ID,
    '-c',
    `model_reasoning_effort=${JSON.stringify(reasoningEffort)}`,
    '-c',
    `mcp_servers.canvas_atelier.command=${JSON.stringify(mcpServer.command)}`,
    '-c',
    `mcp_servers.canvas_atelier.args=[${mcpServer.args.map((value) => JSON.stringify(value)).join(',')}]`,
    '-c',
    `mcp_servers.canvas_atelier.env={ ${serializeMcpEnvironment(mcpServer.env)} }`,
    '-',
  ];
}

function serializeMcpEnvironment(environment: Readonly<Record<string, string>>): string {
  return Object.entries(environment)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) {
        throw new CodexCliServiceError('CODEX_CLI_INVALID_REQUEST', 'Codex MCP 环境变量无效。', false);
      }
      return `${key} = ${JSON.stringify(value)}`;
    })
    .join(', ');
}

function buildCodexPrompt(
  request: CodexCliChatRequest,
  knowledge: readonly CodexCliKnowledgeContext[],
  projectMemory: readonly CodexCliProjectMemoryContext[],
): string {
  return JSON.stringify({
    instructions: [
      '你是 Canvas Atelier 内嵌 Codex。基本问题可以直接回答。',
      '涉及当前画布的读取或修改时，只能调用 canvas_atelier MCP；不得使用 shell、文件、浏览器、网络搜索、应用或其他 MCP。',
      '每次写操作必须使用工具返回的最新 revision；没有成功的工具结果时不得声称画布操作成功。',
      '用户选择的推理强度已由宿主传给模型，不要在回复中虚构或改写该等级。',
    ],
    model: CODEX_ASTRA_MODEL_ID,
    conversation: request.messages,
    knowledge,
    projectMemory,
  });
}

function parseCodexResult(
  result: CodexCliProcessResult,
  knowledge: readonly CodexCliKnowledgeContext[],
): CodexCliChatResult {
  const events = parseJsonLines(result.stdout);
  auditTranscript(events);
  const eventFailure = events.find((event) => event.type === 'error' || event.type === 'turn.failed');
  if (result.exitCode !== 0 || eventFailure !== undefined) {
    throw mapCodexFailure(readFailureMessage(eventFailure) || result.stderr);
  }
  auditTerminalCompletion(events);
  const messages = events.flatMap((event) => {
    const item = isRecord(event.item) ? event.item : null;
    return event.type === 'item.completed' && item?.type === 'agent_message' && typeof item.text === 'string'
      ? [item.text.trim()]
      : [];
  }).filter(Boolean);
  const message = messages[messages.length - 1];
  if (!message) throw new CodexCliServiceError('CODEX_CLI_INVALID_RESPONSE', 'Codex CLI 未返回有效回复。', true);
  try {
    return CodexCliChatResultSchema.parse({
      message,
      modelRoute: CODEX_ASTRA_MODEL_ROUTE,
      sources: knowledge.map(({ knowledgeBaseId, version, displayName }) => ({ knowledgeBaseId, version, displayName })),
    });
  } catch {
    throw new CodexCliServiceError('CODEX_CLI_INVALID_RESPONSE', 'Codex CLI 返回内容无效。', true);
  }
}

function parseJsonLines(stdout: string): Record<string, unknown>[] {
  if (!stdout.trim()) return [];
  try {
    return stdout.split(/\r?\n/u).filter((line) => line.trim()).map((line) => {
      const parsed: unknown = JSON.parse(line);
      if (!isRecord(parsed)) throw new Error('invalid event');
      return parsed;
    });
  } catch {
    throw new CodexCliServiceError('CODEX_CLI_INVALID_RESPONSE', 'Codex CLI 返回了无效事件流。', true);
  }
}

function auditTranscript(events: readonly Record<string, unknown>[]): void {
  if (events.length === 0) {
    throw new CodexCliServiceError('CODEX_CLI_INVALID_RESPONSE', 'Codex CLI 未返回事件记录。', true);
  }
  for (const event of events) {
    const item = isRecord(event.item) ? event.item : null;
    if (item === null || typeof item.type !== 'string') continue;
    if (!ALLOWED_ITEM_TYPES.has(item.type)) {
      throw new CodexCliServiceError('CODEX_CLI_FORBIDDEN_SIDE_EFFECT', 'CODEX_CLI_FORBIDDEN_SIDE_EFFECT：已阻止非画布工具调用。', false);
    }
    if (item.type === 'mcp_tool_call' && item.server !== 'canvas_atelier') {
      throw new CodexCliServiceError('CODEX_CLI_FORBIDDEN_SIDE_EFFECT', 'CODEX_CLI_FORBIDDEN_SIDE_EFFECT：已阻止非 Canvas Atelier MCP。', false);
    }
    if (item.type === 'mcp_tool_call') {
      const status = typeof item.status === 'string' ? item.status.trim().toLocaleLowerCase() : '';
      if (status !== 'completed' || hasNonEmptyMcpError(item.error)) {
        throw new CodexCliServiceError('CODEX_CLI_MCP_FAILED', 'Canvas Atelier MCP 操作未完成，未采用后续成功文本。', true);
      }
    }
  }
}

function auditTerminalCompletion(events: readonly Record<string, unknown>[]): void {
  const completionIndexes = events.flatMap((event, index) => event.type === 'turn.completed' ? [index] : []);
  if (completionIndexes.length !== 1 || completionIndexes[0] !== events.length - 1) {
    throw new CodexCliServiceError('CODEX_CLI_INVALID_RESPONSE', 'Codex CLI 事件记录没有唯一的最终完成标记。', true);
  }
}

function hasNonEmptyMcpError(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  return true;
}

function readFailureMessage(event: Record<string, unknown> | undefined): string {
  if (event === undefined) return '';
  if (typeof event.message === 'string') return event.message;
  const error = isRecord(event.error) ? event.error : null;
  return typeof error?.message === 'string' ? error.message : '';
}

function mapCodexFailure(rawMessage: string): CodexCliServiceError {
  const message = rawMessage.toLocaleLowerCase();
  if (/no available channel|model .* unavailable|unknown model|model_not_found/u.test(message)) {
    return new CodexCliServiceError('CODEX_CLI_UPSTREAM_UNAVAILABLE', 'GPT-6 Astra 当前上游通道不可用，请检查 Codex 账号的模型权限后重试。', true);
  }
  if (/unauthorized|authentication|not logged in|login required|invalid api key|401/u.test(message)) {
    return new CodexCliServiceError('CODEX_CLI_AUTH_REQUIRED', 'Codex CLI 尚未登录或认证已失效，请先完成 Codex 登录。', false);
  }
  if (/timed?\s*out|timeout/u.test(message)) {
    return new CodexCliServiceError('CODEX_CLI_TIMEOUT', 'Codex CLI 请求超时，请稍后重试。', true);
  }
  return new CodexCliServiceError('CODEX_CLI_FAILED', 'Codex CLI 调用失败，请检查本机 Codex 状态后重试。', true);
}

export function normalizeCodexCliError(error: unknown): CodexCliBridgeError {
  if (error instanceof CodexCliServiceError) {
    return { code: error.code, message: error.message, retryable: error.retryable };
  }
  return { code: 'CODEX_CLI_FAILED', message: 'Codex CLI 调用失败，请检查本机 Codex 状态后重试。', retryable: true };
}

export interface CreateNodeCodexCliProcessRunnerOptions {
  readonly spawnProcess?: typeof spawn;
  readonly terminateProcessTree?: (child: ChildProcessWithoutNullStreams) => Promise<void>;
  readonly maxOutputBytes?: number;
  readonly inspectionTimeoutMs?: number;
  readonly terminationWaitMs?: number;
}

type ActiveCodexProcess = {
  readonly child: ChildProcessWithoutNullStreams;
  readonly completion: Promise<CodexCliProcessResult>;
  readonly stop: (reason: CodexCliServiceError) => Promise<void>;
};

export function createNodeCodexCliProcessRunner(
  options: CreateNodeCodexCliProcessRunnerOptions = {},
): CodexCliProcessRunner {
  const spawnProcess = options.spawnProcess ?? spawn;
  const terminateProcessTree = options.terminateProcessTree ?? terminateNativeProcessTree;
  const maxOutputBytes = options.maxOutputBytes ?? MAX_PROCESS_OUTPUT_BYTES;
  const active = new Map<string, ActiveCodexProcess>();
  let disposed = false;
  let poisoned = false;
  let inspectionSequence = 0;
  return {
    async inspect(executablePath) {
      const runInspection = async (args: readonly string[]): Promise<CodexCliProcessResult> => {
        inspectionSequence += 1;
        return this.run({
          requestId: `codex-inspect-${inspectionSequence}`,
          executablePath,
          args,
          cwd: tmpdir(),
          stdin: '',
          timeoutMs: options.inspectionTimeoutMs ?? 10_000,
        });
      };
      const versionResult = await runInspection(['--version']);
      const featuresResult = await runInspection(['features', 'list']);
      if (versionResult.exitCode !== 0 || featuresResult.exitCode !== 0) {
        throw new CodexCliServiceError('CODEX_CLI_UNSAFE_RUNTIME', '无法验证 Codex CLI 安全能力。', false);
      }
      return {
        version: versionResult.stdout.trim(),
        features: featuresResult.stdout.split(/\r?\n/gu)
          .map((line) => line.trim().split(/\s+/u)[0] ?? '')
          .filter(Boolean),
      };
    },
    run(invocation) {
      if (disposed || poisoned) {
        return Promise.reject(new CodexCliServiceError('CODEX_CLI_UNSAFE_RUNTIME', 'Codex CLI 进程监督器不可用。', false));
      }
      if (active.has(invocation.requestId)) {
        return Promise.reject(new CodexCliServiceError('CODEX_CLI_BUSY', 'Codex CLI 请求标识正在执行。', true));
      }
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawnProcess(invocation.executablePath, [...invocation.args], {
          cwd: invocation.cwd,
          env: buildCodexCliProcessEnvironment(process.env),
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } catch {
        return Promise.reject(new CodexCliServiceError('CODEX_CLI_FAILED', 'Codex CLI 进程无法启动。', true));
      }
      let resolveCompletion!: (result: CodexCliProcessResult) => void;
      let rejectCompletion!: (error: unknown) => void;
      const completion = new Promise<CodexCliProcessResult>((resolve, reject) => {
        resolveCompletion = resolve;
        rejectCompletion = reject;
      });
      let stdout = '';
      let stderr = '';
      let outputBytes = 0;
      let settled = false;
      let terminationReason: CodexCliServiceError | null = null;
      let terminationPromise: Promise<void> | null = null;
      let timeout: ReturnType<typeof setTimeout>;
      const finish = (result: CodexCliProcessResult | null, error?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        active.delete(invocation.requestId);
        if (terminationReason !== null) rejectCompletion(terminationReason);
        else if (error !== undefined) rejectCompletion(error);
        else resolveCompletion(result ?? { exitCode: 1, stdout, stderr });
      };
      const stop = async (reason: CodexCliServiceError): Promise<void> => {
        if (settled) return;
        terminationReason ??= reason;
        terminationPromise ??= (async () => {
          try {
            await terminateProcessTree(child);
          } catch {
            poisoned = true;
            child.kill('SIGKILL');
          }
        })();
        await terminationPromise;
        const closed = await new Promise<boolean>((resolve) => {
          const closeDeadline = setTimeout(() => resolve(false), options.terminationWaitMs ?? 5_000);
          void completion.then(() => {
            clearTimeout(closeDeadline);
            resolve(true);
          }, () => {
            clearTimeout(closeDeadline);
            resolve(true);
          });
        });
        if (!closed && !settled) {
          poisoned = true;
          terminationReason = new CodexCliServiceError(
            'CODEX_CLI_UNSAFE_RUNTIME',
            'Codex CLI 进程未能确认退出，已停止后续请求。',
            false,
          );
          finish(null);
        }
      };
      const entry: ActiveCodexProcess = { child, completion, stop };
      active.set(invocation.requestId, entry);
      timeout = setTimeout(() => {
        void stop(new CodexCliServiceError('CODEX_CLI_TIMEOUT', 'Codex CLI 请求超时，请稍后重试。', true));
      }, invocation.timeoutMs);
      const append = (target: 'stdout' | 'stderr', chunk: Buffer) => {
        if (settled || terminationReason !== null) return;
        outputBytes += chunk.byteLength;
        if (outputBytes > maxOutputBytes) {
          void stop(new CodexCliServiceError('CODEX_CLI_INVALID_RESPONSE', 'Codex CLI 返回内容过大。', false));
          return;
        }
        if (target === 'stdout') stdout += chunk.toString('utf8');
        else stderr += chunk.toString('utf8');
      };
      child.stdout.on('data', (chunk: Buffer) => append('stdout', chunk));
      child.stderr.on('data', (chunk: Buffer) => append('stderr', chunk));
      child.stdin.on('error', () => {
        if (settled || terminationReason !== null) return;
        void stop(new CodexCliServiceError('CODEX_CLI_FAILED', 'Codex CLI 输入流写入失败。', true));
      });
      child.on('error', () => finish(null, new CodexCliServiceError('CODEX_CLI_FAILED', 'Codex CLI 进程启动失败。', true)));
      child.on('close', (code) => finish({ exitCode: code ?? 1, stdout, stderr }));
      try {
        child.stdin.end(invocation.stdin, 'utf8');
      } catch {
        void stop(new CodexCliServiceError('CODEX_CLI_FAILED', 'Codex CLI 输入流写入失败。', true));
      }
      return completion;
    },
    async cancel(requestId) {
      const entry = active.get(requestId);
      if (entry === undefined) return false;
      await entry.stop(new CodexCliServiceError('CODEX_CLI_CANCELLED', 'Codex CLI 请求已取消。', true));
      return true;
    },
    async dispose() {
      disposed = true;
      await Promise.all([...active.values()].map((entry) => entry.stop(
        new CodexCliServiceError('CODEX_CLI_CANCELLED', 'Codex CLI 请求已取消。', true),
      )));
    },
  };
}

async function terminateNativeProcessTree(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.pid === undefined) {
    child.kill('SIGKILL');
    return;
  }
  if (process.platform !== 'win32') {
    child.kill('SIGKILL');
    return;
  }
  const windowsRoot = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows';
  const taskkill = join(windowsRoot, 'System32', 'taskkill.exe');
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const killer = spawn(taskkill, ['/PID', String(child.pid), '/T', '/F'], {
      env: buildCodexCliProcessEnvironment(process.env),
      shell: false,
      stdio: 'ignore',
      windowsHide: true,
    });
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (error === undefined) resolve();
      else reject(error);
    };
    const deadline = setTimeout(() => {
      killer.kill('SIGKILL');
      finish(new Error('taskkill timed out'));
    }, 5_000);
    killer.once('error', () => finish(new Error('taskkill failed')));
    killer.once('close', (code) => code === 0 ? finish() : finish(new Error(`taskkill exited ${code ?? 1}`)));
  });
}

export function buildCodexCliProcessEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const selected: Record<string, string> = {};
  for (const key of CODEX_PROCESS_ENVIRONMENT_KEYS) {
    const value = environment[key];
    if (typeof value === 'string' && value.length > 0) selected[key] = value;
  }
  selected.NO_COLOR = '1';
  return selected;
}

export interface CodexCliExecutableProbe {
  exists(path: string): Promise<boolean>;
  listDirectories(path: string): Promise<readonly string[]>;
  modifiedAt(path: string): Promise<number>;
}

const nodeCodexCliExecutableProbe: CodexCliExecutableProbe = {
  exists: async (path) => access(path).then(() => true, () => false),
  listDirectories: async (path) => readdir(path, { withFileTypes: true })
    .then((entries) => entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name), () => []),
  modifiedAt: async (path) => stat(path).then((metadata) => metadata.mtimeMs, () => 0),
};

export async function resolveCodexCliExecutablePath(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
  probe: CodexCliExecutableProbe = nodeCodexCliExecutableProbe,
): Promise<string | null> {
  const override = environment.CANVASFORGE_CODEX_EXECUTABLE_PATH;
  if (override && isAbsolute(override) && await probe.exists(override)) return override;
  if (platform !== 'win32') return null;

  const localAppData = environment.LOCALAPPDATA;
  if (localAppData && isAbsolute(localAppData)) {
    const desktopBin = join(localAppData, 'OpenAI', 'Codex', 'bin');
    const hashedExecutables = (await probe.listDirectories(desktopBin))
      .filter((name) => /^[a-f0-9]{16,64}$/iu.test(name))
      .map((name) => join(desktopBin, name, 'codex.exe'));
    const installedHashedExecutables = (await Promise.all(hashedExecutables.map(async (path) => ({
      path,
      installed: await probe.exists(path),
      modifiedAt: await probe.modifiedAt(path),
    }))))
      .filter((candidate) => candidate.installed)
      .sort((left, right) => right.modifiedAt - left.modifiedAt || left.path.localeCompare(right.path));
    if (installedHashedExecutables[0] !== undefined) return installedHashedExecutables[0].path;

    const stableDesktopExecutable = join(desktopBin, 'codex.exe');
    if (await probe.exists(stableDesktopExecutable)) return stableDesktopExecutable;
  }

  const appData = environment.APPDATA;
  if (!appData || !isAbsolute(appData)) return null;
  const packageRoot = join(appData, 'npm', 'node_modules', '@openai');
  const candidates = [
    join(packageRoot, 'codex', 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'codex', 'codex.exe'),
    join(packageRoot, 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'codex', 'codex.exe'),
    join(packageRoot, 'codex', 'node_modules', '@openai', 'codex-win32-arm64', 'vendor', 'aarch64-pc-windows-msvc', 'codex', 'codex.exe'),
  ];
  for (const candidate of candidates) if (await probe.exists(candidate)) return candidate;
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
