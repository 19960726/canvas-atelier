import { describe, expect, it, vi } from 'vitest';
import { access } from 'node:fs/promises';

import {
  CODEX_ASTRA_MODEL_ID,
  CODEX_ASTRA_MODEL_ROUTE,
  buildCodexCliProcessEnvironment,
  createCodexCliService,
  resolveCodexCliExecutablePath,
  type CodexCliProcessInvocation,
} from './codex-cli-service';

const SAFE_RUNTIME = {
  version: 'codex-cli 0.153.0',
  features: [
    'apps', 'auth_elicitation', 'browser_use', 'browser_use_external', 'code_mode_host',
    'computer_use', 'goals', 'hooks', 'image_generation', 'in_app_browser', 'memories',
    'multi_agent', 'plugin_sharing', 'plugins', 'recommended_plugins', 'remote_plugin',
    'request_permissions_tool', 'shell_snapshot', 'shell_tool', 'skill_mcp_dependency_install',
    'skill_search', 'sleep_tool', 'standalone_web_search', 'tool_call_mcp_elicitation',
    'tool_suggest', 'skip_host_skill_discovery', 'unified_exec', 'view_image', 'workspace_dependencies',
  ],
} as const;

function safeRunner(run = vi.fn()) {
  return {
    inspect: vi.fn(async (): Promise<{ version: string; features: readonly string[] }> => SAFE_RUNTIME),
    run,
    cancel: vi.fn(async () => false),
    dispose: vi.fn(async () => undefined),
  };
}

function codexRequest(requestId: string) {
  return {
    provider: 'codex' as const,
    modelRoute: CODEX_ASTRA_MODEL_ROUTE,
    sessionId: 'desktop-session',
    requestId,
    agentMode: 'codex' as const,
    messages: [{ role: 'user' as const, content: '读取当前画布' }],
    context: { knowledgeBaseIds: [], projectMemoryIds: [] },
  };
}

describe('Codex CLI Astra service', () => {
  it('exposes GPT-6 Astra only as a locally installed Codex profile', async () => {
    const service = createCodexCliService({
      executablePath: 'C:\\Codex\\codex.exe',
      mcpServer: {
        command: 'C:\\Canvas Atelier\\Canvas Atelier.exe',
        args: ['resources\\mcp\\canvasforge-mcp.cjs'],
        env: { ELECTRON_RUN_AS_NODE: '1', CANVASFORGE_MCP_RUNTIME_FILE: 'C:\\runtime.json' },
      },
      processRunner: safeRunner(),
    });

    await expect(service.listProfiles()).resolves.toEqual([expect.objectContaining({
      provider: 'codex',
      modelId: CODEX_ASTRA_MODEL_ID,
      modelRoute: CODEX_ASTRA_MODEL_ROUTE,
      displayName: 'GPT-6 Astra',
      capabilities: ['responses'],
    })]);
  });

  it.each([
    ['an outdated executable', { ...SAFE_RUNTIME, version: 'codex-cli 0.130.0' }],
    ['a runtime missing a required safety feature', {
      ...SAFE_RUNTIME,
      features: SAFE_RUNTIME.features.filter((feature) => feature !== 'unified_exec'),
    }],
  ])('does not expose or execute Astra through %s', async (_label, runtime) => {
    const runner = safeRunner();
    runner.inspect.mockResolvedValue(runtime);
    const service = createCodexCliService({
      executablePath: 'C:\\Codex\\codex.exe',
      mcpServer: { command: 'C:\\Canvas Atelier\\Canvas Atelier.exe', args: [], env: {} },
      processRunner: runner,
    });

    await expect(service.listProfiles()).resolves.toEqual([]);
    await expect(service.chat(codexRequest('request-unsafe-runtime')))
      .rejects.toMatchObject({ code: 'CODEX_CLI_UNSAFE_RUNTIME' });
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('executes the exact Astra id with isolated Canvas Atelier MCP and advanced effort', async () => {
    let mainLoopReentered = false;
    const run = vi.fn(async (_invocation: CodexCliProcessInvocation) => {
      await Promise.resolve();
      mainLoopReentered = true;
      return {
        exitCode: 0,
        stderr: '',
        stdout: [
          JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
          JSON.stringify({ type: 'item.completed', item: { type: 'mcp_tool_call', server: 'canvas_atelier', tool: 'canvas_read_workflow', status: 'completed', error: null } }),
          JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '画布已读取。' } }),
          JSON.stringify({ type: 'turn.completed' }),
        ].join('\n'),
      };
    });
    const service = createCodexCliService({
      executablePath: 'C:\\Codex\\codex.exe',
      mcpServer: {
        command: 'C:\\Canvas Atelier\\Canvas Atelier.exe',
        args: ['resources\\mcp\\canvasforge-mcp.cjs'],
        env: { ELECTRON_RUN_AS_NODE: '1', CANVASFORGE_MCP_RUNTIME_FILE: 'C:\\runtime.json' },
      },
      processRunner: safeRunner(run),
    });

    const result = await service.chat({
      provider: 'codex',
      modelRoute: CODEX_ASTRA_MODEL_ROUTE,
      sessionId: 'desktop-session',
      agentMode: 'codex',
      requestId: 'request-astra-1',
      reasoningEffort: 'max',
      messages: [{ role: 'user', content: '读取当前画布' }],
      context: { knowledgeBaseIds: [], projectMemoryIds: [] },
    });

    expect(mainLoopReentered).toBe(true);
    expect(result).toEqual({ message: '画布已读取。', modelRoute: CODEX_ASTRA_MODEL_ROUTE, sources: [] });
    const invocation = run.mock.calls[0]?.[0];
    expect(invocation?.executablePath).toBe('C:\\Codex\\codex.exe');
    expect(invocation?.args).toEqual(expect.arrayContaining([
      '--ignore-user-config',
      '--ignore-rules',
      '-m',
      CODEX_ASTRA_MODEL_ID,
      'model_reasoning_effort="max"',
    ]));
    expect(invocation?.args.join('\n')).toContain('mcp_servers.canvas_atelier.command=');
    expect(invocation?.args.join('\n')).toContain('CANVASFORGE_MCP_RUNTIME_FILE');
    expect(invocation?.args.join('\n')).not.toContain('figma');
    expect(invocation?.args).toEqual(expect.arrayContaining([
      '--disable', 'unified_exec',
      '--disable', 'view_image',
      '--disable', 'skill_search',
      '--disable', 'hooks',
      '--disable', 'goals',
      '--disable', 'sleep_tool',
      '--enable', 'skip_host_skill_discovery',
    ]));
    expect(invocation?.args.some((arg, index, args) => arg === '-c' && args[index + 1] === '-c')).toBe(false);
    expect(invocation?.stdin).toContain('读取当前画布');
  });

  it('rejects image and video references before spawning the local CLI', async () => {
    const run = vi.fn();
    const service = createCodexCliService({
      executablePath: 'C:\\Codex\\codex.exe',
      mcpServer: { command: 'C:\\Canvas Atelier\\Canvas Atelier.exe', args: [], env: {} },
      processRunner: safeRunner(run),
    });

    await expect(service.chat({
      provider: 'codex', modelRoute: CODEX_ASTRA_MODEL_ROUTE, sessionId: 'desktop-session', agentMode: 'codex',
      requestId: 'request-media-1',
      messages: [{ role: 'user', content: '分析这个素材' }], context: { knowledgeBaseIds: [], projectMemoryIds: [] },
      referenceAssetIds: ['managed-image-id'],
    })).rejects.toMatchObject({ code: 'CODEX_CLI_INVALID_REQUEST' });
    expect(run).not.toHaveBeenCalled();
  });

  it('rejects non-canvas side effects even if a CLI process reports success', async () => {
    const service = createCodexCliService({
      executablePath: 'C:\\Codex\\codex.exe',
      mcpServer: { command: 'C:\\Canvas Atelier\\Canvas Atelier.exe', args: [], env: {} },
      processRunner: safeRunner(vi.fn(async () => ({
        exitCode: 0,
        stderr: '',
        stdout: [
          JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
          JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: 'dir' } }),
          JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'done' } }),
        ].join('\n'),
      }))),
    });

    await expect(service.chat({
      provider: 'codex', modelRoute: CODEX_ASTRA_MODEL_ROUTE, sessionId: 'desktop-session', agentMode: 'codex',
      requestId: 'request-side-effect-1',
      messages: [{ role: 'user', content: '读取画布' }], context: { knowledgeBaseIds: [], projectMemoryIds: [] },
    })).rejects.toThrow('CODEX_CLI_FORBIDDEN_SIDE_EFFECT');
  });

  it.each([
    ['missing terminal completion', [
      { type: 'item.completed', item: { type: 'agent_message', text: '不能接受' } },
    ]],
    ['completion before a later event', [
      { type: 'turn.completed' },
      { type: 'item.completed', item: { type: 'agent_message', text: '不能接受' } },
    ]],
    ['multiple terminal completions', [
      { type: 'item.completed', item: { type: 'agent_message', text: '不能接受' } },
      { type: 'turn.completed' },
      { type: 'turn.completed' },
    ]],
  ])('rejects an incomplete transcript: %s', async (_label, events) => {
    const service = createCodexCliService({
      executablePath: 'C:\\Codex\\codex.exe',
      mcpServer: { command: 'C:\\Canvas Atelier\\Canvas Atelier.exe', args: [], env: {} },
      processRunner: safeRunner(vi.fn(async () => ({
        exitCode: 0,
        stderr: '',
        stdout: events.map((event) => JSON.stringify(event)).join('\n'),
      }))),
    });

    await expect(service.chat(codexRequest(`request-transcript-${_label.replace(/ /gu, '-')}`)))
      .rejects.toMatchObject({ code: 'CODEX_CLI_INVALID_RESPONSE' });
  });

  it.each([
    ['failed', 'failed', null],
    ['cancelled', 'cancelled', null],
    ['error', 'error', null],
    ['completed-with-error', 'completed', { message: 'MCP tool returned a private failure' }],
    ['missing-status', undefined, null],
    ['padded-failed', 'failed ', null],
    ['rejected', 'rejected', null],
    ['in-progress', 'in_progress', null],
  ])('rejects a %s canvas MCP item even when a later Agent message claims success', async (label, status, error) => {
    const service = createCodexCliService({
      executablePath: 'C:\\Codex\\codex.exe',
      mcpServer: { command: 'C:\\Canvas Atelier\\Canvas Atelier.exe', args: [], env: {} },
      processRunner: safeRunner(vi.fn(async () => ({
        exitCode: 0,
        stderr: '',
        stdout: [
          JSON.stringify({ type: 'item.completed', item: { type: 'mcp_tool_call', server: 'canvas_atelier', status, error } }),
          JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '已经成功修改画布。' } }),
          JSON.stringify({ type: 'turn.completed' }),
        ].join('\n'),
      }))),
    });

    await expect(service.chat(codexRequest(`request-mcp-${label}`)))
      .rejects.toMatchObject({ code: 'CODEX_CLI_MCP_FAILED' });
  });

  it('keeps one global request in flight and waits for cancellation before starting the next request', async () => {
    let rejectFirst: ((error: Error) => void) | undefined;
    const run = vi.fn()
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectFirst = reject; }))
      .mockResolvedValueOnce({
        exitCode: 0,
        stderr: '',
        stdout: [
          JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'second completed' } }),
          JSON.stringify({ type: 'turn.completed' }),
        ].join('\n'),
      });
    const runner = safeRunner(run);
    runner.cancel.mockImplementationOnce(async () => {
      rejectFirst?.(Object.assign(new Error('cancelled'), { code: 'CODEX_CLI_CANCELLED' }));
      return true;
    });
    const service = createCodexCliService({
      executablePath: 'C:\\Codex\\codex.exe',
      mcpServer: { command: 'C:\\Canvas Atelier\\Canvas Atelier.exe', args: [], env: {} },
      processRunner: runner,
    });

    const first = service.chat(codexRequest('request-single-flight-1'));
    const firstOutcome = first.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    await expect(service.chat(codexRequest('request-single-flight-2')))
      .rejects.toMatchObject({ code: 'CODEX_CLI_BUSY' });
    await expect(service.cancel({ requestId: 'request-single-flight-1' }))
      .resolves.toEqual({ cancelled: true });
    const cancelledExecutionRoot = (run.mock.calls[0]?.[0] as CodexCliProcessInvocation | undefined)?.cwd;
    expect(cancelledExecutionRoot).toBeDefined();
    await expect(access(cancelledExecutionRoot!)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await firstOutcome).toMatchObject({ ok: false, error: { code: 'CODEX_CLI_CANCELLED' } });
    await expect(service.chat(codexRequest('request-single-flight-3')))
      .resolves.toMatchObject({ message: 'second completed' });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('rejects malformed cancellation requests without invoking the process runner', async () => {
    const runner = safeRunner();
    const service = createCodexCliService({
      executablePath: 'C:\\Codex\\codex.exe',
      mcpServer: { command: 'C:\\Canvas Atelier\\Canvas Atelier.exe', args: [], env: {} },
      processRunner: runner,
    });

    await expect(service.cancel({ requestId: '../escape' }))
      .rejects.toMatchObject({ code: 'CODEX_CLI_INVALID_REQUEST' });
    expect(runner.cancel).not.toHaveBeenCalled();
  });

  it('cancels safely before the user process starts while runtime inspection is pending', async () => {
    let finishInspection: ((runtime: { version: string; features: readonly string[] }) => void) | undefined;
    const runner = safeRunner();
    runner.inspect.mockImplementationOnce(() => new Promise((resolve) => { finishInspection = resolve; }));
    const service = createCodexCliService({
      executablePath: 'C:\\Codex\\codex.exe',
      mcpServer: { command: 'C:\\Canvas Atelier\\Canvas Atelier.exe', args: [], env: {} },
      processRunner: runner,
    });
    const outcome = service.chat(codexRequest('request-cancel-preflight')).catch((error: unknown) => error);
    await vi.waitFor(() => expect(runner.inspect).toHaveBeenCalledOnce());

    const cancellation = service.cancel({ requestId: 'request-cancel-preflight' });
    finishInspection?.(SAFE_RUNTIME);

    await expect(cancellation).resolves.toEqual({ cancelled: true });
    await expect(outcome).resolves.toMatchObject({ code: 'CODEX_CLI_CANCELLED' });
    expect(runner.run).not.toHaveBeenCalled();
  });

  it('maps an unavailable upstream without leaking provider configuration', async () => {
    const service = createCodexCliService({
      executablePath: 'C:\\Codex\\codex.exe',
      mcpServer: { command: 'C:\\Canvas Atelier\\Canvas Atelier.exe', args: [], env: {} },
      processRunner: safeRunner(vi.fn(async () => ({
        exitCode: 1,
        stdout: JSON.stringify({ type: 'error', message: 'No available channel for model gpt-6-astra under group secret-group' }),
        stderr: 'Authorization: Bearer secret-token',
      }))),
    });

    await expect(service.chat({
      provider: 'codex', modelRoute: CODEX_ASTRA_MODEL_ROUTE, sessionId: 'desktop-session', agentMode: 'codex',
      requestId: 'request-upstream-1',
      messages: [{ role: 'user', content: '你好' }], context: { knowledgeBaseIds: [], projectMemoryIds: [] },
    })).rejects.toThrow('GPT-6 Astra 当前上游通道不可用');
    await expect(service.chat({
      provider: 'codex', modelRoute: CODEX_ASTRA_MODEL_ROUTE, sessionId: 'desktop-session', agentMode: 'codex',
      requestId: 'request-upstream-2',
      messages: [{ role: 'user', content: '你好' }], context: { knowledgeBaseIds: [], projectMemoryIds: [] },
    })).rejects.not.toThrow(/secret-group|secret-token/iu);
  });

  it('prefers the current Codex Desktop native executable over an older npm copy', async () => {
    const desktopBin = 'C:\\Users\\Test\\AppData\\Local\\OpenAI\\Codex\\bin';
    const currentDesktop = `${desktopBin}\\9ba750cce02d5e5c\\codex.exe`;
    const olderDesktop = `${desktopBin}\\1111111111111111\\codex.exe`;
    const stableDesktop = `${desktopBin}\\codex.exe`;
    const npmNative = 'C:\\Users\\Test\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\codex\\codex.exe';
    const available = new Set([currentDesktop, olderDesktop, stableDesktop, npmNative]);

    await expect(resolveCodexCliExecutablePath({
      LOCALAPPDATA: 'C:\\Users\\Test\\AppData\\Local',
      APPDATA: 'C:\\Users\\Test\\AppData\\Roaming',
    }, 'win32', {
      exists: async (candidate) => available.has(candidate),
      listDirectories: async (directory) => directory === desktopBin
        ? ['1111111111111111', '9ba750cce02d5e5c']
        : [],
      modifiedAt: async (candidate) => candidate === currentDesktop ? 200 : 100,
    })).resolves.toBe(currentDesktop);
  });

  it('falls back to the npm native Windows executable without trying to spawn codex.cmd', async () => {
    const expected = 'C:\\Users\\Test\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\codex\\codex.exe';

    await expect(resolveCodexCliExecutablePath({ APPDATA: 'C:\\Users\\Test\\AppData\\Roaming' }, 'win32', {
      exists: async (candidate) => candidate === expected,
      listDirectories: async () => [],
      modifiedAt: async () => 0,
    }))
      .resolves.toBe(expected);
  });

  it('does not inherit unrelated plugin or application secrets into the Codex subprocess', () => {
    expect(buildCodexCliProcessEnvironment({
      PATH: 'C:\\Windows\\System32',
      USERPROFILE: 'C:\\Users\\Test',
      CODEX_HOME: 'C:\\Users\\Test\\.codex',
      OPENAI_API_KEY: 'required-auth',
      FIGMA_ACCESS_TOKEN: 'must-not-leak',
      RELAYME_TOKEN: 'must-not-leak',
      COMFLY_API_KEY: 'must-not-leak',
    })).toEqual({
      PATH: 'C:\\Windows\\System32',
      USERPROFILE: 'C:\\Users\\Test',
      CODEX_HOME: 'C:\\Users\\Test\\.codex',
      OPENAI_API_KEY: 'required-auth',
      NO_COLOR: '1',
    });
  });
});
