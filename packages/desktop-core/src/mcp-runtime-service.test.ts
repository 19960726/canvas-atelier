import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readMcpRuntimeFile } from './mcp-runtime-file.js';
import { createMcpRuntimeService, type McpPipeResponseEnvelope } from './mcp-runtime-service.js';

describe('MCP named-pipe runtime broker', () => {
  let root: string;
  let runtimeFilePath: string;
  const services: { stop(): Promise<void> }[] = [];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'canvasforge-mcp-broker-'));
    runtimeFilePath = join(root, 'runtime-v1.json');
  });

  afterEach(async () => {
    await Promise.all(services.splice(0).map((service) => service.stop()));
    await rm(root, { force: true, recursive: true });
  });

  it('authenticates, validates, and forwards a request to the renderer authority', async () => {
    const forwardRequest = vi.fn(async () => ({ ok: true as const, result: { revision: 3 } }));
    const service = createMcpRuntimeService({ runtimeFilePath, serverVersion: '1.0.0', forwardRequest });
    services.push(service);
    await service.start();
    const descriptor = await readMcpRuntimeFile(runtimeFilePath, { isProcessAlive: () => true });

    await expect(callPipe(descriptor.pipeName, {
      protocol: 'canvasforge.mcp.pipe.v1',
      requestId: 'request-1',
      authToken: descriptor.authToken,
      request: { tool: 'canvas_read_workflow' },
    })).resolves.toMatchObject({ requestId: 'request-1', response: { ok: true, result: { revision: 3 } } });
    expect(forwardRequest).toHaveBeenCalledWith('request-1', { tool: 'canvas_read_workflow' });
    expect(service.getStatus()).toMatchObject({ state: 'running', rendererConnected: true });
  });

  it('rejects invalid authentication and malformed MCP requests without forwarding', async () => {
    const forwardRequest = vi.fn(async () => ({ ok: true as const, result: {} }));
    const service = createMcpRuntimeService({ runtimeFilePath, serverVersion: '1.0.0', forwardRequest });
    services.push(service);
    await service.start();
    const descriptor = await readMcpRuntimeFile(runtimeFilePath, { isProcessAlive: () => true });

    await expect(callPipe(descriptor.pipeName, {
      protocol: 'canvasforge.mcp.pipe.v1', requestId: 'bad-auth', authToken: 'wrong', request: { tool: 'canvas_read_workflow' },
    })).resolves.toMatchObject({ response: { ok: false, error: { code: 'MCP_AUTHENTICATION_FAILED' } } });
    await expect(callPipe(descriptor.pipeName, {
      protocol: 'canvasforge.mcp.pipe.v1', requestId: 'bad-tool', authToken: descriptor.authToken, request: { tool: 'canvas_shell' },
    })).resolves.toMatchObject({ response: { ok: false, error: { code: 'MCP_INVALID_REQUEST' } } });
    expect(forwardRequest).not.toHaveBeenCalled();
  });

  it('rejects duplicate request ids and frames larger than one MiB', async () => {
    let release: (() => void) | undefined;
    const forwardRequest = vi.fn(() => new Promise<{ ok: true; result: object }>((resolve) => { release = () => resolve({ ok: true, result: {} }); }));
    const service = createMcpRuntimeService({ runtimeFilePath, serverVersion: '1.0.0', forwardRequest, requestTimeoutMs: 2_000 });
    services.push(service);
    await service.start();
    const descriptor = await readMcpRuntimeFile(runtimeFilePath, { isProcessAlive: () => true });
    const envelope = { protocol: 'canvasforge.mcp.pipe.v1', requestId: 'same', authToken: descriptor.authToken, request: { tool: 'canvas_read_workflow' } };
    const first = callPipe(descriptor.pipeName, envelope);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(callPipe(descriptor.pipeName, envelope)).resolves.toMatchObject({ response: { ok: false, error: { code: 'MCP_DUPLICATE_REQUEST_ID' } } });
    release?.();
    await expect(first).resolves.toMatchObject({ response: { ok: true } });

    const oversized = `${JSON.stringify({ ...envelope, requestId: 'large', padding: 'x'.repeat(1_048_576) })}\n`;
    await expect(callRawPipe(descriptor.pipeName, oversized)).resolves.toMatchObject({ response: { ok: false, error: { code: 'MCP_FRAME_TOO_LARGE' } } });
  });

  it('times out disconnected renderer work and removes the runtime file on stop', async () => {
    const service = createMcpRuntimeService({
      runtimeFilePath,
      serverVersion: '1.0.0',
      requestTimeoutMs: 25,
      forwardRequest: async () => new Promise(() => undefined),
    });
    services.push(service);
    await service.start();
    const descriptor = await readMcpRuntimeFile(runtimeFilePath, { isProcessAlive: () => true });

    await expect(callPipe(descriptor.pipeName, {
      protocol: 'canvasforge.mcp.pipe.v1', requestId: 'timeout', authToken: descriptor.authToken, request: { tool: 'canvas_read_workflow' },
    })).resolves.toMatchObject({ response: { ok: false, error: { code: 'MCP_RENDERER_TIMEOUT' } } });
    await service.stop();
    await expect(readFile(runtimeFilePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

async function callPipe(pipeName: string, envelope: object): Promise<McpPipeResponseEnvelope> {
  return callRawPipe(pipeName, `${JSON.stringify(envelope)}\n`);
}

async function callRawPipe(pipeName: string, payload: string): Promise<McpPipeResponseEnvelope> {
  return new Promise((resolve, reject) => {
    const socket = connect(pipeName);
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(payload));
    socket.on('data', (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      socket.end();
      resolve(JSON.parse(buffer.slice(0, newline)) as McpPipeResponseEnvelope);
    });
    socket.on('error', reject);
  });
}