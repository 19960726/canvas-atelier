import { describe, expect, it, vi } from 'vitest';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  CODEX_ASTRA_MODEL_ID,
  CODEX_ASTRA_MODEL_ROUTE,
  CODEX_ASTRA_PROFILE,
  buildCodexCliProcessEnvironment,
  createCodexCliService,
  normalizeCodexCliError,
  resolveCodexCliExecutablePath,
  type CodexCliProcessInvocation,
} from './codex-cli-service';

const SAFE_RUNTIME = {
  version: 'codex-cli 0.153.0',
  mcpServerNames: ['canvas_atelier', 'figma', 'node_repl'],
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
    inspect: vi.fn(async (): Promise<{ version: string; features: readonly string[]; mcpServerNames: readonly string[] }> => SAFE_RUNTIME),
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

const CODEX_TERRA_PROFILE = {
  provider: 'codex' as const,
  modelRoute: 'codex/gpt-5.6-terra' as const,
  modelId: 'gpt-5.6-terra',
  displayName: 'GPT-5.6 Terra',
  capabilities: ['responses'] as const,
  capabilityStatus: 'complete' as const,
  transport: 'codex-cli' as const,
  availability: 'installed' as const,
  supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const,
  defaultReasoningEffort: 'medium' as const,
};

const CODEX_ASTRA_CATALOG_PROFILE = {
  ...CODEX_ASTRA_PROFILE,
  supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const,
  defaultReasoningEffort: 'low' as const,
};

describe('Codex CLI Astra service', () => {
  it('classifies the actual invalid API key event as an authentication failure', async () => {
    const service = createCodexCliService({
      executablePath: 'C:\\Codex\\codex.exe',
      modelCatalog: [CODEX_ASTRA_CATALOG_PROFILE],
      mcpServer: { command: 'C:\\Canvas Atelier\\Canvas Atelier.exe', args: [], env: {} },
      processRunner: safeRunner(vi.fn(async () => ({
        exitCode: 1,
        stdout: JSON.stringify({
          type: 'turn.failed',
          error: { message: `401 Incorrect API key provided: ${['sk', 'redacted'].join('-')}. code=invalid_api_key` },
        }),
        stderr: '',
      }))),
    });

    await expect(service.chat(codexRequest('request-invalid-api-key'))).rejects.toMatchObject({
      code: 'CODEX_CLI_AUTH_REQUIRED',
      message: 'Codex 认证已失效，请使用 ChatGPT 登录或重新配置有效的 API Key。',
      retryable: false,
    });
  });

  it('classifies a structured invalid_api_key failure even when the CLI omits its message', async () => {
    const service = createCodexCliService({
      executablePath: 'C:\\Codex\\codex.exe',
      modelCatalog: [CODEX_ASTRA_CATALOG_PROFILE],
      mcpServer: { command: 'C:\\Canvas Atelier\\Canvas Atelier.exe', args: [], env: {} },
      processRunner: safeRunner(vi.fn(async () => ({
        exitCode: 1,
        stdout: JSON.stringify({ type: 'turn.failed', error: { code: 'invalid_api_key' } }),
        stderr: '',
      }))),
    });

    await expect(service.chat(codexRequest('request-structured-invalid-api-key'))).rejects.toMatchObject({
      code: 'CODEX_CLI_AUTH_REQUIRED',
      retryable: false,
    });
  });

  it('classifies a CLI event carrying a Canvas Atelier MCP startup failure without leaking diagnostics', async () => {
    const service = createCodexCliService({
      executablePath: 'C:\\Codex\\codex.exe',
      modelCatalog: [CODEX_ASTRA_CATALOG_PROFILE],
      mcpServer: { command: 'C:\\Canvas Atelier\\Canvas Atelier.exe', args: [], env: {} },
      processRunner: safeRunner(vi.fn(async () => ({
        exitCode: 1,
        stdout: JSON.stringify({
          type: 'error',
          message: 'MCP client for canvas_atelier failed to initialize: token=C:\\Users\\private\\runtime.json',
        }),
        stderr: 'private auth token should never reach the renderer',
      }))),
    });

    const error = await service.chat(codexRequest('request-mcp-startup')).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: 'CODEX_CLI_MCP_FAILED',
      message: 'Canvas Atelier MCP 操作未完成，未采用后续成功文本。',
    });
    expect(String((error as Error).message)).not.toContain('private');
    expect(String((error as Error).message)).not.toContain('runtime.json');
  });

  it('normalizes a runner MCP transport rejection to the same safe bridge error', () => {
    const normalized = normalizeCodexCliError(new Error(
      'MCP transport handshake failed for canvas_atelier at C:\\private\\mcp-token.json',
    ));
    expect(normalized).toEqual({
      code: 'CODEX_CLI_MCP_FAILED',
      message: 'Canvas Atelier MCP 操作未完成，未采用后续成功文本。',
      retryable: true,
    });
    expect(normalized.message).not.toContain('mcp-token');
  });

  it('uses catalog reasoning levels and rejects unsupported effort before execution', async () => {
    const root = await mkdtemp(join(tmpdir(), 'canvas-codex-efforts-'));
    const catalogPath = join(root, 'models_cache.json');
    const runner = safeRunner();
    try {
      await writeFile(catalogPath, JSON.stringify({ models: [{ slug: 'gpt-6-astra', visibility: 'list', supported_in_api: true,
        supported_reasoning_levels: [{ effort: 'low' }, { effort: 'ultra' }], default_reasoning_level: 'low' }] }));
      const service = createCodexCliService({ executablePath: 'C:\\Codex\\codex.exe', modelCatalogPath: catalogPath,
        mcpServer: { command: 'C:\\Canvas Atelier\\Canvas Atelier.exe', args: [], env: {} }, processRunner: runner });
      await expect(service.listProfiles()).resolves.toEqual([expect.objectContaining({ supportedReasoningEfforts: ['low', 'ultra'], defaultReasoningEffort: 'low' })]);
      await expect(service.chat({ ...codexRequest('unsupported-effort'), reasoningEffort: 'max' })).rejects.toMatchObject({ code: 'CODEX_CLI_INVALID_REQUEST' });
      expect(runner.run).not.toHaveBeenCalled();
      await writeFile(catalogPath, JSON.stringify({ models: [] }));
      await expect(service.listProfiles()).resolves.toEqual([]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('rejects execution when the cache does not declare any reasoning level', async () => {
    const root = await mkdtemp(join(tmpdir(), 'canvas-codex-no-efforts-'));
    const catalogPath = join(root, 'models_cache.json');
    const runner = safeRunner();
    try {
      await writeFile(catalogPath, JSON.stringify({ models: [{
        slug: 'gpt-6-astra', visibility: 'list', supported_in_api: true,
      }] }));
      const service = createCodexCliService({
        executablePath: 'C:\\Codex\\codex.exe',
        modelCatalogPath: catalogPath,
        mcpServer: { command: 'C:\\Canvas Atelier\\Canvas Atelier.exe', args: [], env: {} },
        processRunner: runner,
      });

      await expect(service.chat(codexRequest('missing-efforts')))
        .rejects.toMatchObject({ code: 'CODEX_CLI_INVALID_REQUEST' });
      expect(runner.run).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('does not invent GPT-6 Astra when no local model catalog is available', async () => {
    const service = createCodexCliService({
      executablePath: 'C:\\Codex\\codex.exe',
      mcpServer: {
        command: 'C:\\Canvas Atelier\\Canvas Atelier.exe',
        args: ['resources\\mcp\\canvasforge-mcp.cjs'],
        env: { ELECTRON_RUN_AS_NODE: '1', CANVASFORGE_MCP_RUNTIME_FILE: 'C:\\runtime.json' },
      },
      processRunner: safeRunner(),
    });

    await expect(service.listProfiles()).resolves.toEqual([]);
  });

  it('exposes every visible API-enabled local Codex model and executes the selected route', async () => {
    const run = vi.fn(async (_invocation: CodexCliProcessInvocation) => ({
      exitCode: 0,
      stderr: '',
      stdout: [
        JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Terra 已读取。' } }),
        JSON.stringify({ type: 'turn.completed' }),
      ].join('\n'),
    }));
    const service = createCodexCliService({
      executablePath: 'C:\\Codex\\codex.exe',
      modelCatalog: [CODEX_ASTRA_CATALOG_PROFILE, CODEX_TERRA_PROFILE],
      mcpServer: { command: 'C:\\Canvas Atelier\\Canvas Atelier.exe', args: [], env: {} },
      processRunner: safeRunner(run),
    });

    await expect(service.listProfiles()).resolves.toEqual([CODEX_ASTRA_CATALOG_PROFILE, CODEX_TERRA_PROFILE]);
    const result = await service.chat({
      ...codexRequest('request-terra-1'),
      modelRoute: CODEX_TERRA_PROFILE.modelRoute,
    });

    expect(result).toEqual({ message: 'Terra 已读取。', modelRoute: CODEX_TERRA_PROFILE.modelRoute, sources: [] });
    const invocation = run.mock.calls[0]?.[0] as CodexCliProcessInvocation | undefined;
    expect(invocation?.args).toEqual(expect.arrayContaining(['-m', CODEX_TERRA_PROFILE.modelId]));
    expect(invocation?.stdin).toContain(CODEX_TERRA_PROFILE.modelId);
  });

  it('filters the local Codex cache by public visibility and API availability', async () => {
    const root = await mkdtemp(join(tmpdir(), 'canvas-codex-models-'));
    const catalogPath = join(root, 'models_cache.json');
    const sixEfforts = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map((effort) => ({ effort }));
    const fiveEfforts = sixEfforts.slice(0, 5);
    const fourEfforts = sixEfforts.slice(0, 4);
    await writeFile(catalogPath, JSON.stringify({ models: [
      { slug: 'gpt-6-astra', display_name: 'GPT-6-Astra', visibility: 'list', supported_in_api: true,
        supported_reasoning_levels: sixEfforts, default_reasoning_level: 'low' },
      { slug: 'gpt-5.6-sol', display_name: 'GPT-5.6-Sol', visibility: 'list', supported_in_api: true,
        supported_reasoning_levels: sixEfforts, default_reasoning_level: 'low' },
      { slug: 'gpt-5.6-terra', display_name: 'GPT-5.6-Terra', visibility: 'list', supported_in_api: true,
        supported_reasoning_levels: sixEfforts, default_reasoning_level: 'medium' },
      { slug: 'gpt-5.6-luna', display_name: 'GPT-5.6-Luna', visibility: 'list', supported_in_api: true,
        supported_reasoning_levels: fiveEfforts, default_reasoning_level: 'medium' },
      { slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list', supported_in_api: true,
        supported_reasoning_levels: fourEfforts, default_reasoning_level: 'medium' },
      { slug: 'gpt-5.4-mini', display_name: 'GPT-5.4-Mini', visibility: 'list', supported_in_api: true,
        supported_reasoning_levels: fourEfforts, default_reasoning_level: 'medium' },
      { slug: 'gpt-reserve', display_name: 'GPT-Reserve', visibility: 'hide', supported_in_api: true },
      { slug: 'future-model', display_name: 'Future Model', visibility: 'list', supported_in_api: false },
    ] }), 'utf8');
    try {
      const service = createCodexCliService({
        executablePath: 'C:\\Codex\\codex.exe',
        modelCatalogPath: catalogPath,
        mcpServer: { command: 'C:\\Canvas Atelier\\Canvas Atelier.exe', args: [], env: {} },
        processRunner: safeRunner(),
      });
      await expect(service.listProfiles()).resolves.toHaveLength(6);
      await expect(service.listProfiles()).resolves.toEqual([
        expect.objectContaining({ modelId: 'gpt-6-astra', displayName: 'GPT-6 Astra',
          supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultReasoningEffort: 'low' }),
        expect.objectContaining({ modelId: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol',
          supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultReasoningEffort: 'low' }),
        expect.objectContaining({ modelId: 'gpt-5.6-terra', displayName: 'GPT-5.6 Terra',
          supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultReasoningEffort: 'medium' }),
        expect.objectContaining({ modelId: 'gpt-5.6-luna', displayName: 'GPT-5.6 Luna',
          supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultReasoningEffort: 'medium' }),
        expect.objectContaining({ modelId: 'gpt-5.5', displayName: 'GPT-5.5',
          supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'], defaultReasoningEffort: 'medium' }),
        expect.objectContaining({ modelId: 'gpt-5.4-mini', displayName: 'GPT-5.4 Mini',
          supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'], defaultReasoningEffort: 'medium' }),
      ]);
      await expect(service.listProfiles()).resolves.not.toEqual(expect.arrayContaining([
        expect.objectContaining({ modelId: 'gpt-reserve' }),
        expect.objectContaining({ modelId: 'future-model' }),
      ]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not add GPT-6 Astra when the local cache only advertises another model', async () => {
    const root = await mkdtemp(join(tmpdir(), 'canvas-codex-stale-models-'));
    const catalogPath = join(root, 'models_cache.json');
    await writeFile(catalogPath, JSON.stringify({ models: [
      { slug: 'gpt-5.6-terra', display_name: 'GPT-5.6-Terra', visibility: 'list', supported_in_api: true },
    ] }), 'utf8');
    try {
      const service = createCodexCliService({
        executablePath: 'C:\\Codex\\codex.exe',
        modelCatalogPath: catalogPath,
        mcpServer: { command: 'C:\\Canvas Atelier\\Canvas Atelier.exe', args: [], env: {} },
        processRunner: safeRunner(),
      });

      await expect(service.listProfiles()).resolves.toEqual([
        expect.objectContaining({ modelId: 'gpt-5.6-terra' }),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
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
      modelCatalog: [CODEX_ASTRA_CATALOG_PROFILE],
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
      modelCatalog: [CODEX_ASTRA_CATALOG_PROFILE],
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
      '--ignore-rules',
      '-m',
      CODEX_ASTRA_MODEL_ID,
      'model_reasoning_effort="max"',
    ]));
    expect(invocation?.args.join('\n')).toContain('mcp_servers.canvas_atelier.command=');
    expect(invocation?.args.join('\n')).toContain('CANVASFORGE_MCP_RUNTIME_FILE');
    expect(invocation?.args).toEqual(expect.arrayContaining([
      '--disable', 'view_image',
      '--disable', 'skill_search',
      '--disable', 'hooks',
      '--disable', 'goals',
      '--disable', 'sleep_tool',
      '--enable', 'code_mode_host',
      '--enable', 'unified_exec',
      '--enable', 'skip_host_skill_discovery',
      '--sandbox', 'read-only',
      'approval_policy="never"',
      'mcp_servers.canvas_atelier.default_tools_approval_mode="approve"',
      'mcp_servers.figma.enabled=false',
      'mcp_servers.node_repl.enabled=false',
    ]));
    expect(invocation?.args).not.toContain('--ignore-user-config');
    expect(invocation?.args).not.toContain('--approve-for-me');
    expect(invocation?.args.some((arg, index, args) => arg === '--disable'
      && (args[index + 1] === 'code_mode_host' || args[index + 1] === 'unified_exec'))).toBe(false);
    expect(invocation?.args.some((arg, index, args) => arg === '-c' && args[index + 1] === '-c')).toBe(false);
    expect(invocation?.stdin).toContain('读取当前画布');
    expect(invocation?.stdin).toContain('创建工作流时，先调用 canvas_read_workflow 一次');
    expect(invocation?.stdin).toContain('调用 canvas_plan_workflow');
    expect(invocation?.stdin).toContain('不能只返回关键词');
    expect(invocation?.stdin).toContain('避免重复读取画布');
  });

  it('resolves managed image references into short-lived CLI image arguments', async () => {
    const pngBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const run = vi.fn(async (invocation: CodexCliProcessInvocation) => {
      const imageFlag = invocation.args.indexOf('--image');
      expect(imageFlag).toBeGreaterThan(-1);
      const imagePath = invocation.args[imageFlag + 1];
      expect(imagePath).toMatch(/reference-01\.png$/u);
      expect(Buffer.from(await readFile(imagePath!))).toEqual(Buffer.from(pngBytes));
      expect(invocation.stdin).toContain('@图片1（产品主图）');
      return {
        exitCode: 0,
        stderr: '',
        stdout: [
          JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '已分析图片。' } }),
          JSON.stringify({ type: 'turn.completed' }),
        ].join('\n'),
      };
    });
    const resolveImages = vi.fn(async () => [{ bytes: pngBytes, mediaType: 'image/png' as const }]);
    const service = createCodexCliService({
      executablePath: 'C:\\Codex\\codex.exe',
      modelCatalog: [CODEX_ASTRA_CATALOG_PROFILE],
      mcpServer: { command: 'C:\\Canvas Atelier\\Canvas Atelier.exe', args: [], env: {} },
      processRunner: safeRunner(run),
      resolveImages,
    });

    await expect(service.chat({
      provider: 'codex', modelRoute: CODEX_ASTRA_MODEL_ROUTE, sessionId: 'desktop-session', agentMode: 'codex',
      requestId: 'request-media-1',
      messages: [{ role: 'user', content: '分析这个素材' }], context: { knowledgeBaseIds: [], projectMemoryIds: [] },
      referenceAssetIds: ['a'.repeat(16)],
      referenceMentions: [{ assetId: 'a'.repeat(16), label: '产品主图', mention: '@图片1' }],
      visualAnalysis: true,
    })).resolves.toMatchObject({ message: '已分析图片。' });
    expect(resolveImages).toHaveBeenCalledWith('desktop-session', ['a'.repeat(16)]);
    expect(run).toHaveBeenCalledOnce();
  });

  it('rejects non-canvas side effects even if a CLI process reports success', async () => {
    const service = createCodexCliService({
      executablePath: 'C:\\Codex\\codex.exe',
      modelCatalog: [CODEX_ASTRA_CATALOG_PROFILE],
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
      modelCatalog: [CODEX_ASTRA_CATALOG_PROFILE],
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

  it('accepts normal MCP started events before their completed events', async () => {
    const service = createCodexCliService({
      executablePath: 'C:\\Codex\\codex.exe',
      modelCatalog: [CODEX_ASTRA_CATALOG_PROFILE],
      mcpServer: { command: 'C:\\Canvas Atelier\\Canvas Atelier.exe', args: [], env: {} },
      processRunner: safeRunner(vi.fn(async () => ({
        exitCode: 0,
        stderr: '',
        stdout: [
          JSON.stringify({ type: 'item.started', item: { type: 'mcp_tool_call', server: 'canvas_atelier', tool: 'canvas_read_workflow', status: 'in_progress', error: null } }),
          JSON.stringify({ type: 'item.completed', item: { type: 'mcp_tool_call', server: 'canvas_atelier', tool: 'canvas_read_workflow', status: 'completed', error: null, result: { structured_content: { ok: true, result: { revision: 1 } } } } }),
          JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '画布已读取。' } }),
          JSON.stringify({ type: 'turn.completed' }),
        ].join('\n'),
      }))),
    });

    await expect(service.chat(codexRequest('request-mcp-started-event')))
      .resolves.toMatchObject({ message: '画布已读取。' });
  });

  it('accepts one revision conflict only after a read and successful retry of the same tool', async () => {
    const service = createCodexCliService({
      executablePath: 'C:\\Codex\\codex.exe',
      modelCatalog: [CODEX_ASTRA_CATALOG_PROFILE],
      mcpServer: { command: 'C:\\Canvas Atelier\\Canvas Atelier.exe', args: [], env: {} },
      processRunner: safeRunner(vi.fn(async () => ({
        exitCode: 0,
        stderr: '',
        stdout: [
          JSON.stringify({ type: 'item.completed', item: { type: 'mcp_tool_call', server: 'canvas_atelier', tool: 'canvas_update_node', status: 'failed', error: null, result: { structured_content: { ok: false, error: { code: 'PROJECT_REVISION_CONFLICT', message: 'read again' } } } } }),
          JSON.stringify({ type: 'item.completed', item: { type: 'mcp_tool_call', server: 'canvas_atelier', tool: 'canvas_read_workflow', status: 'completed', error: null, result: { structured_content: { ok: true, result: { revision: 2 } } } } }),
          JSON.stringify({ type: 'item.completed', item: { type: 'mcp_tool_call', server: 'canvas_atelier', tool: 'canvas_update_node', status: 'completed', error: null, result: { structured_content: { ok: true, result: { revision: 3 } } } } }),
          JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '已按最新版本更新画布。' } }),
          JSON.stringify({ type: 'turn.completed' }),
        ].join('\n'),
      }))),
    });

    await expect(service.chat(codexRequest('request-mcp-recovered-revision-conflict')))
      .resolves.toMatchObject({ message: '已按最新版本更新画布。' });
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
      modelCatalog: [CODEX_ASTRA_CATALOG_PROFILE],
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
      modelCatalog: [CODEX_ASTRA_CATALOG_PROFILE],
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
    let finishInspection: ((runtime: { version: string; features: readonly string[]; mcpServerNames: readonly string[] }) => void) | undefined;
    const runner = safeRunner();
    runner.inspect.mockImplementationOnce(() => new Promise((resolve) => { finishInspection = resolve; }));
    const service = createCodexCliService({
      executablePath: 'C:\\Codex\\codex.exe',
      modelCatalog: [CODEX_ASTRA_CATALOG_PROFILE],
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
      modelCatalog: [CODEX_ASTRA_CATALOG_PROFILE],
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
    })).rejects.toThrow('当前 Codex 模型上游通道不可用');
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
