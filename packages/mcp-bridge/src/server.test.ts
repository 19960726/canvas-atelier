import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CANVAS_MCP_TOOL_DEFINITIONS } from '@agent-canvas/domain';
import { CANVAS_ATELIER_MCP_INSTRUCTIONS, createCanvasAtelierMcpServer } from './server.js';

const closers: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(closers.splice(0).map((close) => close())); });

describe('Canvas Atelier stdio MCP server contract', () => {
  it('instructs clients to retry confirmed workflow and paid requests to retrieve one-time approval codes', () => {
    expect(CANVAS_ATELIER_MCP_INSTRUCTIONS).toContain('retry the exact same canvas_plan_workflow request');
    expect(CANVAS_ATELIER_MCP_INSTRUCTIONS).toContain('approvalCode');
    expect(CANVAS_ATELIER_MCP_INSTRUCTIONS).toContain('canvas_apply_workflow.confirmationToken');
    expect(CANVAS_ATELIER_MCP_INSTRUCTIONS).toContain('retry the same canvas_run_node request without confirmationToken');
    expect(CANVAS_ATELIER_MCP_INSTRUCTIONS).toContain('call canvas_run_node again with confirmationToken set to approvalCode');
    expect(CANVAS_ATELIER_MCP_INSTRUCTIONS).toContain('jobIds');
    expect(CANVAS_ATELIER_MCP_INSTRUCTIONS).toContain('canvas_get_job_status');
    expect(CANVAS_ATELIER_MCP_INSTRUCTIONS).toContain('canvas_delete_selection returns a workflow plan');
    expect(CANVAS_ATELIER_MCP_INSTRUCTIONS).toContain('canvas_import_media opens');
    expect(CANVAS_ATELIER_MCP_INSTRUCTIONS).toContain('Canvas Atelier');
    expect(CANVAS_ATELIER_MCP_INSTRUCTIONS).not.toContain('CanvasForge');
  });

  it('initializes with the stable canvas_atelier server identity', async () => {
    const runtimeClient = { call: vi.fn(async () => ({ ok: true as const, result: {} })), close: vi.fn(async () => undefined) };
    const { client } = await connectTestClient(runtimeClient);

    expect(client.getServerVersion()).toEqual({ name: 'canvas_atelier', version: '1.0.0' });
  });
  it('initializes and lists exactly the stable 14 canvas tools', async () => {
    const runtimeClient = { call: vi.fn(async () => ({ ok: true as const, result: {} })), close: vi.fn(async () => undefined) };
    const { client } = await connectTestClient(runtimeClient);

    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(
      CANVAS_MCP_TOOL_DEFINITIONS.map((tool) => tool.name),
    );
  });

  it('publishes each tool argument contract so Codex can construct valid node operations', async () => {
    const runtimeClient = { call: vi.fn(async () => ({ ok: true as const, result: {} })), close: vi.fn(async () => undefined) };
    const { client } = await connectTestClient(runtimeClient);
    const tools = (await client.listTools()).tools;

    const create = tools.find((tool) => tool.name === 'canvas_create_node');
    const connect = tools.find((tool) => tool.name === 'canvas_connect_nodes');
    const run = tools.find((tool) => tool.name === 'canvas_run_node');

    expect(create?.inputSchema).toMatchObject({
      type: 'object',
      properties: {
        expectedRevision: { type: 'integer' },
        moduleType: { type: 'string' },
        position: { type: 'object' },
      },
      required: expect.arrayContaining(['expectedRevision', 'moduleType', 'position']),
    });
    expect(Object.keys(connect?.inputSchema.properties ?? {})).toEqual(expect.arrayContaining([
      'expectedRevision',
      'sourceNodeId',
      'sourcePortId',
      'targetNodeId',
      'targetPortId',
    ]));
    expect(connect?.inputSchema.required).toEqual(expect.arrayContaining([
      'expectedRevision',
      'sourceNodeId',
      'sourcePortId',
      'targetNodeId',
      'targetPortId',
    ]));
    expect(Object.keys(run?.inputSchema.properties ?? {})).toEqual(expect.arrayContaining([
      'expectedRevision',
      'nodeId',
      'confirmationToken',
    ]));
    expect(run?.inputSchema.required).toEqual(expect.arrayContaining(['expectedRevision', 'nodeId']));
    expect(create?.inputSchema.properties).not.toHaveProperty('tool');
  });

  it('does not let tool arguments override the registered MCP tool name', async () => {
    const runtimeClient = { call: vi.fn(async () => ({ ok: true as const, result: {} })), close: vi.fn(async () => undefined) };
    const { client } = await connectTestClient(runtimeClient);

    const result = await client.callTool({
      name: 'canvas_read_workflow',
      arguments: {
        tool: 'canvas_create_node',
        expectedRevision: 0,
        moduleType: 'image_generation',
        position: { x: 0, y: 0 },
      },
    });

    expect(result.isError).toBe(true);
    expect(runtimeClient.call).not.toHaveBeenCalled();
  });

  it('forwards a tool call and returns bounded structured content', async () => {
    const runtimeClient = { call: vi.fn(async () => ({ ok: true as const, result: { revision: 8 } })), close: vi.fn(async () => undefined) };
    const { client } = await connectTestClient(runtimeClient);

    const result = await client.callTool({ name: 'canvas_read_workflow', arguments: {} });

    expect(runtimeClient.call).toHaveBeenCalledWith({ tool: 'canvas_read_workflow' });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toEqual({ ok: true, result: { revision: 8 } });
  });

  it('returns schema and runtime failures as MCP tool errors rather than crashing', async () => {
    const runtimeClient = { call: vi.fn(async () => ({ ok: false as const, error: { code: 'MCP_WAITING_FOR_CANVAS', message: 'Open Canvas Atelier.' } })), close: vi.fn(async () => undefined) };
    const { client } = await connectTestClient(runtimeClient);

    const invalid = await client.callTool({ name: 'canvas_get_job_status', arguments: {} });
    expect(invalid.isError).toBe(true);

    const unavailable = await client.callTool({ name: 'canvas_read_workflow', arguments: {} });
    expect(unavailable.isError).toBe(true);
    expect(unavailable.structuredContent).toMatchObject({ ok: false, error: { code: 'MCP_WAITING_FOR_CANVAS' } });
  });

  it('uses the current product identity when the desktop returns an invalid response', async () => {
    const runtimeClient = { call: vi.fn(async () => ({ unsafe: true })), close: vi.fn(async () => undefined) };
    const { client } = await connectTestClient(runtimeClient);

    const result = await client.callTool({ name: 'canvas_read_workflow', arguments: {} });

    expect(result.structuredContent).toMatchObject({
      ok: false,
      error: { code: 'MCP_RUNTIME_INVALID_RESPONSE', message: 'Canvas Atelier returned an invalid bounded response.' },
    });
  });
});

async function connectTestClient(runtimeClient: { call(request: unknown): Promise<unknown>; close(): Promise<void> }) {
  const server = createCanvasAtelierMcpServer(runtimeClient);
  const client = new Client({ name: 'canvas-atelier-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  closers.push(async () => { await client.close(); await server.close(); await runtimeClient.close(); });
  return { client, server };
}
