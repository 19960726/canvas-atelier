import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { CANVAS_MCP_TOOL_DEFINITIONS } from '@agent-canvas/domain';
import { CANVASFORGE_MCP_INSTRUCTIONS, createCanvasForgeMcpServer } from './server.js';

const closers: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(closers.splice(0).map((close) => close())); });

describe('CanvasForge stdio MCP server contract', () => {
  it('instructs clients to retry confirmed workflow and paid requests to retrieve one-time approval codes', () => {
    expect(CANVASFORGE_MCP_INSTRUCTIONS).toContain('retry the exact same canvas_plan_workflow request');
    expect(CANVASFORGE_MCP_INSTRUCTIONS).toContain('approvalCode');
    expect(CANVASFORGE_MCP_INSTRUCTIONS).toContain('canvas_apply_workflow.confirmationToken');
    expect(CANVASFORGE_MCP_INSTRUCTIONS).toContain('retry the same canvas_run_node request without confirmationToken');
    expect(CANVASFORGE_MCP_INSTRUCTIONS).toContain('call canvas_run_node again with confirmationToken set to approvalCode');
  });
  it('initializes and lists exactly the stable 14 canvas tools', async () => {
    const runtimeClient = { call: vi.fn(async () => ({ ok: true as const, result: {} })), close: vi.fn(async () => undefined) };
    const { client } = await connectTestClient(runtimeClient);

    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(
      CANVAS_MCP_TOOL_DEFINITIONS.map((tool) => tool.name),
    );
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
    const runtimeClient = { call: vi.fn(async () => ({ ok: false as const, error: { code: 'MCP_WAITING_FOR_CANVAS', message: 'Open CanvasForge.' } })), close: vi.fn(async () => undefined) };
    const { client } = await connectTestClient(runtimeClient);

    const invalid = await client.callTool({ name: 'canvas_get_job_status', arguments: {} });
    expect(invalid.isError).toBe(true);

    const unavailable = await client.callTool({ name: 'canvas_read_workflow', arguments: {} });
    expect(unavailable.isError).toBe(true);
    expect(unavailable.structuredContent).toMatchObject({ ok: false, error: { code: 'MCP_WAITING_FOR_CANVAS' } });
  });
});

async function connectTestClient(runtimeClient: { call(request: unknown): Promise<unknown>; close(): Promise<void> }) {
  const server = createCanvasForgeMcpServer(runtimeClient);
  const client = new Client({ name: 'canvasforge-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  closers.push(async () => { await client.close(); await server.close(); await runtimeClient.close(); });
  return { client, server };
}