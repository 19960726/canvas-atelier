import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createMcpRuntimeClient } from './runtime-client.js';
import { resolveMcpRuntimeFilePath } from './runtime-path.js';
import { createCanvasAtelierMcpServer } from './server.js';

async function main(): Promise<void> {
  const runtimeFilePath = resolveMcpRuntimeFilePath(process.env);
  const runtimeClient = createMcpRuntimeClient({ runtimeFilePath });
  const server = createCanvasAtelierMcpServer(runtimeClient);

  async function shutdown(): Promise<void> {
    await server.close().catch(() => undefined);
    await runtimeClient.close();
  }

  process.once('SIGINT', () => { void shutdown().finally(() => process.exit(0)); });
  process.once('SIGTERM', () => { void shutdown().finally(() => process.exit(0)); });

  try {
    await server.connect(new StdioServerTransport());
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Canvas Atelier MCP bridge failed to start.');
    await shutdown();
    process.exitCode = 1;
  }
}

void main();
