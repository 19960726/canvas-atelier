import { join } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createMcpRuntimeClient } from './runtime-client.js';
import { createCanvasForgeMcpServer } from './server.js';

async function main(): Promise<void> {
  const appData = process.env.APPDATA;
  const runtimeFilePath = process.env.CANVASFORGE_MCP_RUNTIME_FILE
    ?? (appData ? join(appData, 'CanvasForge', 'mcp', 'runtime-v1.json') : 'runtime-v1.json');
  const runtimeClient = createMcpRuntimeClient({ runtimeFilePath });
  const server = createCanvasForgeMcpServer(runtimeClient);

  async function shutdown(): Promise<void> {
    await server.close().catch(() => undefined);
    await runtimeClient.close();
  }

  process.once('SIGINT', () => { void shutdown().finally(() => process.exit(0)); });
  process.once('SIGTERM', () => { void shutdown().finally(() => process.exit(0)); });

  try {
    await server.connect(new StdioServerTransport());
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'CanvasForge MCP bridge failed to start.');
    await shutdown();
    process.exitCode = 1;
  }
}

void main();