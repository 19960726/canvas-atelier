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

  it('cancels every in-flight pipe request and timer when closed', async () => {
    const descriptor = createMcpRuntimeDescriptor({ instanceId: 'bridge-close', processId: process.pid, serverVersion: '1.0.0' });
    const sockets = new Set<import('node:net').Socket>();
    const closures: Array<Promise<void>> = [];
    let accepted = 0;
    let resolveAccepted: () => void = () => undefined;
    const requestsAccepted = new Promise<void>((resolve) => { resolveAccepted = resolve; });
    const server = createServer((socket) => {
      sockets.add(socket);
      closures.push(new Promise<void>((resolve) => { socket.once('close', resolve); }));
      socket.on('close', () => { sockets.delete(socket); });
      socket.on('error', () => undefined);
      socket.once('data', () => { accepted += 1; if (accepted === 2) resolveAccepted(); });
    });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(descriptor.pipeName, resolve); });
    await writeMcpRuntimeFile(runtimeFilePath, descriptor);
    const client = createMcpRuntimeClient({ runtimeFilePath });
    const pending = [client.call({ tool: 'canvas_read_workflow' }), client.call({ tool: 'canvas_describe_nodes' })];
    try {
      expect(await settleWithin(requestsAccepted, 1_000)).not.toBe('pending');
      await client.close(); await client.close();
      const result = await settleWithin(Promise.all(pending), 500);
      expect(result).not.toBe('pending');
      expect(result).toEqual(Array.from({ length: 2 }, () => ({ ok: false,
        error: { code: 'MCP_CLIENT_CLOSED', message: 'The Canvas Atelier MCP client is closed.' } })));
      expect(await settleWithin(Promise.all(closures), 500)).not.toBe('pending');
      expect(sockets.size).toBe(0);
      await expect(client.call({ tool: 'canvas_read_workflow' })).resolves.toMatchObject({ error: { code: 'MCP_CLIENT_CLOSED' } });
      expect(accepted).toBe(2);
    } finally {
      await client.close();
      for (const socket of sockets) socket.end();
      await Promise.all(pending);
      await new Promise<void>((resolve) => { server.close(() => resolve()); });
    }
  });

  it('does not open a pipe when closed during descriptor discovery', async () => {
    const descriptor = createMcpRuntimeDescriptor({ instanceId: 'bridge-discovery-close', processId: process.pid, serverVersion: '1.0.0' });
    let connections = 0;
    const server = createServer((socket) => {
      connections += 1;
      socket.once('data', (chunk) => {
        const { requestId } = JSON.parse(String(chunk).trim()) as { requestId: string };
        socket.end(`${JSON.stringify({ protocol: 'canvasforge.mcp.pipe.v1', requestId, response: { ok: true, result: {} } })}\n`);
      });
    });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(descriptor.pipeName, resolve); });
    closeCallbacks.push(() => new Promise((resolve) => server.close(() => resolve())));
    await writeMcpRuntimeFile(runtimeFilePath, descriptor);
    const client = createMcpRuntimeClient({ runtimeFilePath });
    const pending = client.call({ tool: 'canvas_read_workflow' });
    await client.close();
    await expect(pending).resolves.toMatchObject({ ok: false, error: { code: 'MCP_CLIENT_CLOSED' } });
    expect(connections).toBe(0);
  });
});

async function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T | 'pending'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<'pending'>((resolve) => { timer = setTimeout(() => resolve('pending'), timeoutMs); })]);
  } finally { clearTimeout(timer); }
}
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
