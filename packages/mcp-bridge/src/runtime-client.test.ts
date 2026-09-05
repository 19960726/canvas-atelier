import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createMcpRuntimeClient } from './runtime-client.js';

describe('Canvas Atelier MCP runtime client', () => {
  let root: string;
  let runtimeFilePath: string;
  const closeCallbacks: Array<() => Promise<void>> = [];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'canvasforge-mcp-client-'));
    runtimeFilePath = join(root, 'runtime-v1.json');
  });
  afterEach(async () => {
    await Promise.all(closeCallbacks.splice(0).map((close) => close()));
    await rm(root, { force: true, recursive: true });
  });

  it('returns a stable waiting state when no desktop runtime is discoverable', async () => {
    const client = createMcpRuntimeClient({ runtimeFilePath, timeoutMs: 100 });
    await expect(client.call({ tool: 'canvas_read_workflow' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'MCP_WAITING_FOR_CANVAS', message: 'Open Canvas Atelier and keep a canvas window active.' },
    });
  });

  it('discovers the active pipe, authenticates, and validates the response', async () => {
    const descriptor = createMcpRuntimeDescriptor({ instanceId: 'bridge-test', processId: process.pid, serverVersion: '1.0.0' });
    const server = createServer((socket) => {
      socket.setEncoding('utf8');
      socket.once('data', (chunk) => {
        const request = JSON.parse(String(chunk).trim()) as { requestId: string; authToken: string };
        socket.end(`${JSON.stringify({
          protocol: 'canvasforge.mcp.pipe.v1',
          requestId: request.requestId,
          response: request.authToken === descriptor.authToken
            ? { ok: true, result: { revision: 9 } }
            : { ok: false, error: { code: 'MCP_AUTHENTICATION_FAILED', message: 'bad auth' } },
        })}\n`);
      });
    });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(descriptor.pipeName, resolve); });
    closeCallbacks.push(() => new Promise((resolve) => server.close(() => resolve())));
    await writeMcpRuntimeFile(runtimeFilePath, descriptor);
    const client = createMcpRuntimeClient({ runtimeFilePath, timeoutMs: 500 });

    await expect(client.call({ tool: 'canvas_read_workflow' })).resolves.toEqual({ ok: true, result: { revision: 9 } });
  });

  it('rejects invalid tool input before opening the local pipe', async () => {
    const client = createMcpRuntimeClient({ runtimeFilePath, timeoutMs: 100 });
    await expect(client.call({ tool: 'canvas_shell' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'MCP_INVALID_REQUEST', message: 'Tool arguments do not match the Canvas Atelier contract.' },
    });
  });

  it('uses the current product identity when the client has already closed', async () => {
    const client = createMcpRuntimeClient({ runtimeFilePath, timeoutMs: 100 });
    await client.close();

    await expect(client.call({ tool: 'canvas_read_workflow' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'MCP_CLIENT_CLOSED', message: 'The Canvas Atelier MCP client is closed.' },
    });
  });
});
type TestRuntimeDescriptor = {
  protocol: 'canvasforge.mcp.runtime.v1';
  instanceId: string;
  pipeName: string;
  authToken: string;
  serverVersion: string;
  startedAt: string;
  expiresAt: string;
  processId: number;
};

function createMcpRuntimeDescriptor(input: { instanceId: string; processId: number; serverVersion: string }): TestRuntimeDescriptor {
  const startedAt = new Date();
  const random = randomBytes(8).toString('hex');
  return {
    protocol: 'canvasforge.mcp.runtime.v1',
    instanceId: input.instanceId,
    pipeName: `\\\\.\\pipe\\canvasforge-mcp-${input.instanceId}-${random}`,
    authToken: randomBytes(32).toString('hex'),
    serverVersion: input.serverVersion,
    startedAt: startedAt.toISOString(),
    expiresAt: new Date(startedAt.getTime() + 15 * 60 * 1000).toISOString(),
    processId: input.processId,
  };
}

async function writeMcpRuntimeFile(path: string, descriptor: TestRuntimeDescriptor): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(descriptor)}\n`, 'utf8');
}
