import { describe, expect, it, vi } from 'vitest';

import { createMcpStdioHealthCheck, MCP_STDIO_HEALTH_CLIENT_INFO } from './mcp-stdio-health';

describe('MCP stdio health check', () => {
  it('uses the current product identity for its MCP client handshake', () => {
    expect(MCP_STDIO_HEALTH_CLIENT_INFO).toEqual({ name: 'canvas-atelier-health-check', version: '1.0.0' });
  });

  it('initializes the configured bridge, verifies the stable tools, describes the canvas, and closes', async () => {
    const transport = {
      start: vi.fn(async () => undefined),
      send: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    const client = {
      connect: vi.fn(async () => undefined),
      listTools: vi.fn(async () => ({
        tools: [
          'canvas_describe_nodes', 'canvas_read_workflow', 'canvas_get_selection', 'canvas_get_job_status',
          'canvas_plan_workflow', 'canvas_apply_workflow', 'canvas_create_node', 'canvas_update_node',
          'canvas_connect_nodes', 'canvas_move_nodes', 'canvas_delete_selection', 'canvas_run_node',
          'canvas_cancel_job', 'canvas_import_media',
        ].map((name) => ({ name })),
      })),
      callTool: vi.fn(async () => ({ isError: false, structuredContent: { ok: true, result: { modules: [] } } })),
      close: vi.fn(async () => undefined),
    };
    const createTransport = vi.fn(() => transport);
    const createClient = vi.fn(() => client);
    const healthCheck = createMcpStdioHealthCheck({
      command: 'CanvasForge.exe',
      args: ['resources/mcp/canvasforge-mcp.cjs'],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    }, { createTransport, createClient, inheritedEnv: { SystemRoot: 'C:\\Windows' } });

    await expect(healthCheck()).resolves.toEqual({ connected: true, toolCount: 14 });
    expect(createTransport).toHaveBeenCalledWith({
      command: 'CanvasForge.exe',
      args: ['resources/mcp/canvasforge-mcp.cjs'],
      env: { SystemRoot: 'C:\\Windows', ELECTRON_RUN_AS_NODE: '1' },
      stderr: 'pipe',
    });
    expect(client.connect).toHaveBeenCalledWith(transport, { timeout: 10_000 });
    expect(client.callTool).toHaveBeenCalledWith(
      { name: 'canvas_describe_nodes', arguments: {} },
      undefined,
      { timeout: 10_000 },
    );
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it('reports failure and still closes when the bridge exposes the wrong catalog', async () => {
    const client = {
      connect: vi.fn(async () => undefined),
      listTools: vi.fn(async () => ({ tools: [{ name: 'canvas_describe_nodes' }] })),
      callTool: vi.fn(),
      close: vi.fn(async () => undefined),
    };
    const healthCheck = createMcpStdioHealthCheck({ command: 'CanvasForge.exe', args: [], env: {} }, {
      createTransport: vi.fn(() => ({
        start: vi.fn(async () => undefined),
        send: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
      })),
      createClient: vi.fn(() => client),
      inheritedEnv: {},
    });

    await expect(healthCheck()).resolves.toEqual({ connected: false, toolCount: 14 });
    expect(client.callTool).not.toHaveBeenCalled();
    expect(client.close).toHaveBeenCalledTimes(1);
  });
});
