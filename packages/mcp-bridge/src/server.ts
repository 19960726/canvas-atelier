import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import {
  CANVAS_MCP_TOOL_DEFINITIONS,
  CanvasMcpRequestSchema,
  CanvasMcpResponseSchema,
  type CanvasMcpRequest,
  type CanvasMcpResponse,
} from '@agent-canvas/domain';

export const CANVASFORGE_MCP_INSTRUCTIONS = [
  'Describe and read the current canvas before planning or editing.',
  'Workflow confirmation: call canvas_plan_workflow. When confirmationRequired is true, wait for the user to confirm the preview inside CanvasForge, then retry the exact same canvas_plan_workflow request. Read approvalCode from that retry and pass it as canvas_apply_workflow.confirmationToken.',
  'Paid job confirmation: first call canvas_run_node without confirmationToken. Wait for the user to confirm inside CanvasForge, retry the same canvas_run_node request without confirmationToken, read approvalCode, then call canvas_run_node again with confirmationToken set to approvalCode.',
  'Approval codes are one-time, request-specific, project-specific, and must never be reused after a project switch or revision change.',
].join(' ');
export interface CanvasForgeRuntimeClient {
  call(request: unknown): Promise<unknown>;
  close(): Promise<void>;
}

export function createCanvasForgeMcpServer(runtimeClient: CanvasForgeRuntimeClient): McpServer {
  const server = new McpServer(
    { name: 'canvasforge', version: '1.0.0' },
    {
      instructions: CANVASFORGE_MCP_INSTRUCTIONS,
    },
  );

  for (const definition of CANVAS_MCP_TOOL_DEFINITIONS) {
    server.registerTool(
      definition.name,
      {
        title: definition.title,
        description: definition.description,
        inputSchema: z.object({}).passthrough(),
      },
      async (args) => {
        const request = CanvasMcpRequestSchema.safeParse({ tool: definition.name, ...args });
        if (!request.success) return toToolResult({
          ok: false,
          error: { code: 'MCP_INVALID_REQUEST', message: 'Tool arguments do not match the CanvasForge contract.' },
        });
        let response: CanvasMcpResponse;
        try {
          response = CanvasMcpResponseSchema.parse(await runtimeClient.call(request.data as CanvasMcpRequest));
        } catch {
          response = { ok: false, error: { code: 'MCP_RUNTIME_INVALID_RESPONSE', message: 'CanvasForge returned an invalid bounded response.' } };
        }
        return toToolResult(response);
      },
    );
  }

  return server;
}

function toToolResult(response: CanvasMcpResponse) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(response) }],
    structuredContent: response,
    isError: !response.ok,
  };
}