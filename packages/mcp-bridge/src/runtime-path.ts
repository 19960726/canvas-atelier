import { join } from 'node:path';

export interface McpRuntimePathEnvironment {
  readonly APPDATA?: string;
  readonly CANVASFORGE_MCP_RUNTIME_FILE?: string;
}

export function resolveMcpRuntimeFilePath(environment: McpRuntimePathEnvironment): string {
  if (environment.CANVASFORGE_MCP_RUNTIME_FILE) return environment.CANVASFORGE_MCP_RUNTIME_FILE;
  return environment.APPDATA
    ? join(environment.APPDATA, 'Canvas Atelier', 'mcp', 'runtime-modern-v1.json')
    : 'runtime-v1.json';
}
