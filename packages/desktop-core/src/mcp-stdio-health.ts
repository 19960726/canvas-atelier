import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

import { CANVAS_MCP_TOOL_DEFINITIONS } from '@agent-canvas/domain';
import type { McpClientHealthResult } from './mcp-client-config';

export interface McpStdioLaunchSpec {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

type HealthTransport = Transport;

interface HealthClient {
  connect(transport: HealthTransport, options: { timeout: number }): Promise<void>;
  listTools(params?: undefined, options?: { timeout: number }): Promise<{ tools: Array<{ name: string }> }>;
  callTool(
    params: { name: string; arguments: Record<string, never> },
    resultSchema: undefined,
    options: { timeout: number },
  ): Promise<unknown>;
  close(): Promise<void>;
}

interface McpStdioHealthDependencies {
  readonly createTransport: (parameters: {
    command: string;
    args: string[];
    env: Record<string, string>;
    stderr: 'pipe';
  }) => HealthTransport;
  readonly createClient: () => HealthClient;
  readonly inheritedEnv: Record<string, string>;
}

const HEALTH_TIMEOUT_MS = 10_000;
const EXPECTED_TOOL_NAMES = CANVAS_MCP_TOOL_DEFINITIONS.map((tool) => tool.name);
export const MCP_STDIO_HEALTH_CLIENT_INFO = Object.freeze({ name: 'canvas-atelier-health-check', version: '1.0.0' });

export function createMcpStdioHealthCheck(
  spec: McpStdioLaunchSpec,
  dependencies: Partial<McpStdioHealthDependencies> = {},
): () => Promise<McpClientHealthResult> {
  const createTransport: McpStdioHealthDependencies['createTransport'] =
    dependencies.createTransport ?? ((parameters) => new StdioClientTransport(parameters));
  const createClient: McpStdioHealthDependencies['createClient'] =
    dependencies.createClient ?? (() => new Client(MCP_STDIO_HEALTH_CLIENT_INFO));
  const inheritedEnv = dependencies.inheritedEnv ?? getDefaultEnvironment();

  return async () => {
    const transport = createTransport({
      command: spec.command,
      args: [...spec.args],
      env: { ...inheritedEnv, ...spec.env },
      stderr: 'pipe',
    });
    const client = createClient();
    try {
      await client.connect(transport, { timeout: HEALTH_TIMEOUT_MS });
      const listed = await client.listTools(undefined, { timeout: HEALTH_TIMEOUT_MS });
      const names = listed.tools.map((tool) => tool.name);
      if (!sameOrderedStrings(names, EXPECTED_TOOL_NAMES)) return failedHealth();

      const described = await client.callTool(
        { name: 'canvas_describe_nodes', arguments: {} },
        undefined,
        { timeout: HEALTH_TIMEOUT_MS },
      );
      return !isPlainRecord(described)
        || described.isError === true
        || !isPlainRecord(described.structuredContent)
        || described.structuredContent.ok !== true
        ? failedHealth()
        : { connected: true, toolCount: 14 };
    } catch {
      return failedHealth();
    } finally {
      await client.close().catch(() => undefined);
    }
  };
}

function sameOrderedStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function failedHealth(): McpClientHealthResult {
  return { connected: false, toolCount: 14 };
}
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
