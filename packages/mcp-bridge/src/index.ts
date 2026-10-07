import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createMcpRuntimeClient } from './runtime-client.js';
import { resolveMcpRuntimeFilePath } from './runtime-path.js';
import { createCanvasAtelierMcpServer } from './server.js';

async function main(): Promise<void> {
  const runtimeFilePath = resolveMcpRuntimeFilePath(process.env);
  const runtimeClient = createMcpRuntimeClient({ runtimeFilePath });
  const server = createCanvasAtelierMcpServer(runtimeClient);
  let shutdownPromise: Promise<void> | undefined;

  function shutdown(): Promise<void> {
    shutdownPromise ??= Promise.all([
      server.close().catch(() => undefined),
      runtimeClient.close(),
    ]).then(() => undefined);
    return shutdownPromise;
  }

  process.stdin.once('end', () => { void shutdown(); });
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
