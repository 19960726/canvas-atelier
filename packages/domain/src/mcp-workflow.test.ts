import { describe, expect, it } from 'vitest';

import {
  CANVAS_MCP_TOOL_DEFINITIONS,
  CanvasMcpRequestSchema,
  CanvasMcpResponseSchema,
  CanvasWorkflowSnapshotSchema,
  redactMcpValue,
} from './mcp-workflow';

const TOOL_NAMES = [
  'canvas_describe_nodes',
  'canvas_read_workflow',
  'canvas_get_selection',
  'canvas_get_job_status',
  'canvas_plan_workflow',
  'canvas_apply_workflow',
  'canvas_create_node',
  'canvas_update_node',
  'canvas_connect_nodes',
  'canvas_move_nodes',
  'canvas_delete_selection',
  'canvas_run_node',
  'canvas_cancel_job',
  'canvas_import_media',
] as const;

describe('Canvas Atelier MCP workflow contract', () => {
  it('publishes exactly the stable 14-tool catalog in protocol order', () => {
    expect(CANVAS_MCP_TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual(TOOL_NAMES);
    expect(new Set(CANVAS_MCP_TOOL_DEFINITIONS.map((tool) => tool.name)).size).toBe(14);
  });

  it('publishes only the current product identity in user-facing tool descriptions', () => {
    const descriptions = CANVAS_MCP_TOOL_DEFINITIONS.map((tool) => tool.description).join('\n');

    expect(descriptions).toContain('Canvas Atelier');
    expect(descriptions).not.toContain('CanvasForge');
  });

  it('rejects unknown tools and unknown request keys', () => {
    expect(() => CanvasMcpRequestSchema.parse({ tool: 'canvas_shell' })).toThrow();
    expect(() => CanvasMcpRequestSchema.parse({
      tool: 'canvas_read_workflow',
      unexpected: true,
    })).toThrow();
  });

  it('requires the current project revision for every canvas mutation', () => {
    const mutationRequests = [
      { tool: 'canvas_apply_workflow', planId: 'plan-1', confirmationToken: 'grant-1' },
      { tool: 'canvas_create_node', moduleType: 'image_input', position: { x: 1, y: 2 } },
      { tool: 'canvas_update_node', nodeId: 'node-1', config: { prompt: 'hello' } },
      { tool: 'canvas_connect_nodes', sourceNodeId: 'a', sourcePortId: 'image', targetNodeId: 'b', targetPortId: 'references' },
      { tool: 'canvas_move_nodes', positions: [{ nodeId: 'a', x: 4, y: 5 }] },
      { tool: 'canvas_delete_selection' },
      { tool: 'canvas_run_node', nodeId: 'node-1' },
      { tool: 'canvas_import_media', mediaKind: 'image', position: { x: 1, y: 2 } },
    ];

    for (const request of mutationRequests) {
      expect(() => CanvasMcpRequestSchema.parse(request), request.tool).toThrow();
    }
  });

  it('accepts edge-only deletion inside a confirmed workflow plan', () => {
    expect(CanvasMcpRequestSchema.parse({
      tool: 'canvas_plan_workflow',
      expectedRevision: 2,
      workflowIntent: 'Disconnect selected nodes',
      mutations: [{ kind: 'delete_edges', edgeIds: ['edge-1'] }],
    })).toMatchObject({ mutations: [{ kind: 'delete_edges', edgeIds: ['edge-1'] }] });
  });

  it('accepts a bounded public workflow snapshot with ports and managed result ids', () => {
    expect(CanvasWorkflowSnapshotSchema.parse({
      protocol: 'canvasforge.mcp.snapshot.v1',
      projectId: 'project-1',
      revision: 7,
      nodes: [{
        id: 'node-1',
        moduleType: 'image_generation',
        position: { x: 20, y: 40 },
        selected: true,
        config: { prompt: 'studio product photo', resolution: '2K' },
        executionState: 'idle',
        managedResultIds: ['asset-1'],
        ports: [{ id: 'prompt', direction: 'input', dataType: 'text_prompt', cardinality: 'one', required: true }],
      }],
      edges: [],
      selection: { nodeIds: ['node-1'], edgeIds: [] },
    })).toMatchObject({ revision: 7, nodes: [{ id: 'node-1' }] });
  });

  it('rejects secrets, absolute paths, data URLs, base64 payloads, and oversized strings', () => {
    const protectedValues = [
      { apiKey: 'sk-secret' },
      { nested: { Authorization: 'Bearer hidden' } },
      { path: 'C:\\Users\\person\\private.png' },
      { path: '\\\\server\\share\\private.mp4' },
      { url: 'file:///C:/private.png' },
      { image: 'data:image/png;base64,AAAA' },
      { payload: 'A'.repeat(9000) },
      { payload: 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo='.repeat(80) },
    ];

    for (const value of protectedValues) {
      expect(() => redactMcpValue(value)).toThrow();
    }
  });

  it('returns only strict success or error envelopes', () => {
    expect(CanvasMcpResponseSchema.parse({
      ok: true,
      result: { projectId: 'project-1', revision: 1 },
    })).toEqual({ ok: true, result: { projectId: 'project-1', revision: 1 } });

    expect(CanvasMcpResponseSchema.parse({
      ok: false,
      error: { code: 'PROJECT_REVISION_CONFLICT', message: 'Canvas changed; read it again.' },
    })).toMatchObject({ ok: false });

    expect(() => CanvasMcpResponseSchema.parse({ absolutePath: 'C:\\secret.png' })).toThrow();
    expect(() => CanvasMcpResponseSchema.parse({ ok: true, result: { token: 'hidden' } })).toThrow();
  });
});
