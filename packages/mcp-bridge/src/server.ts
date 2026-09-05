import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  CANVAS_MCP_TOOL_DEFINITIONS,
  CanvasMcpRequestSchema,
  CanvasMcpResponseSchema,
  type CanvasMcpRequest,
  type CanvasMcpResponse,
} from '@agent-canvas/domain';

export const CANVAS_ATELIER_MCP_INSTRUCTIONS = [
  'Describe and read the current canvas before planning or editing.',
  'Workflow confirmation: call canvas_plan_workflow. When confirmationRequired is true, wait for the user to confirm the preview inside Canvas Atelier, then retry the exact same canvas_plan_workflow request. Read approvalCode from that retry and pass it as canvas_apply_workflow.confirmationToken.',
  'canvas_delete_selection returns a workflow plan for the current UI selection; apply it through the same confirmation and canvas_apply_workflow flow.',
  'Paid job confirmation: first call canvas_run_node without confirmationToken. Wait for the user to confirm inside Canvas Atelier, retry the same canvas_run_node request without confirmationToken, read approvalCode, then call canvas_run_node again with confirmationToken set to approvalCode.',
  'A successful canvas_run_node returns jobIds. Poll each id with canvas_get_job_status until completed, failed, or cancelled, then call canvas_read_workflow to read persisted managed result ids.',
  'canvas_import_media opens the trusted Canvas Atelier picker and returns immediately; ask the user to finish choosing a file inside the app, then read the workflow again.',
  'Approval codes are one-time, request-specific, project-specific, and must never be reused after a project switch or revision change.',
].join(' ');
export interface CanvasAtelierRuntimeClient {
  call(request: unknown): Promise<unknown>;
  close(): Promise<void>;
}

export function createCanvasAtelierMcpServer(runtimeClient: CanvasAtelierRuntimeClient): McpServer {
  const server = new McpServer(
    { name: 'canvas_atelier', version: '1.0.0' },
    {
      instructions: CANVAS_ATELIER_MCP_INSTRUCTIONS,
    },
  );

  for (const definition of CANVAS_MCP_TOOL_DEFINITIONS) {
    server.registerTool(
      definition.name,
      {
        title: definition.title,
        description: definition.description,
        inputSchema: definition.inputSchema,
      },
      async (args) => {
        const request = CanvasMcpRequestSchema.safeParse({ ...args, tool: definition.name });
        if (!request.success) return toToolResult({
          ok: false,
          error: { code: 'MCP_INVALID_REQUEST', message: 'Tool arguments do not match the Canvas Atelier contract.' },
        });
        let response: CanvasMcpResponse;
        try {
          response = CanvasMcpResponseSchema.parse(await runtimeClient.call(request.data as CanvasMcpRequest));
        } catch {
          response = { ok: false, error: { code: 'MCP_RUNTIME_INVALID_RESPONSE', message: 'Canvas Atelier returned an invalid bounded response.' } };
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
