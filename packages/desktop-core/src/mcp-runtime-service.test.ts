import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { connect, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { deleteMcpRuntimeFile, readMcpRuntimeFile, writeMcpRuntimeFile } from './mcp-runtime-file.js';
import { createMcpRuntimeService, presentMcpRuntimeStatus, type McpPipeResponseEnvelope } from './mcp-runtime-service.js';

describe('MCP named-pipe runtime broker', () => {
  let root: string;
  let runtimeFilePath: string;
  const services: { stop(): Promise<void> }[] = [];

  it('reports a loaded canvas as ready before the first external tool request', () => {
    expect(presentMcpRuntimeStatus({
      state: 'waiting_for_canvas', rendererConnected: false, serverVersion: '1.6.66', toolCount: 14,
      lastError: 'MCP_RENDERER_UNAVAILABLE',
    }, true)).toEqual({
      state: 'running', rendererConnected: true, serverVersion: '1.6.66', toolCount: 14, lastError: null,
    });
  });

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
    })).resolves.toMatchObject({
      response: {
        ok: false,
        error: { code: 'MCP_INVALID_REQUEST', message: 'MCP request does not match the Canvas Atelier contract.' },
      },
    });
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
    })).resolves.toMatchObject({
      response: {
        ok: false,
        error: { code: 'MCP_RENDERER_TIMEOUT', message: 'Canvas Atelier renderer did not answer in time.' },
      },
    });
    await service.stop();
    await expect(readFile(runtimeFilePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('renews the discovery descriptor while the desktop runtime stays open', async () => {
    const service = createMcpRuntimeService({
      runtimeFilePath,
      serverVersion: '1.0.0',
      runtimeRefreshIntervalMs: 10,
      forwardRequest: async () => ({ ok: true, result: {} }),
    });
    services.push(service);
    const initial = await service.start();

    await vi.waitFor(async () => {
      const renewed = await readMcpRuntimeFile(runtimeFilePath, { isProcessAlive: () => true });
      expect(Date.parse(renewed.expiresAt)).toBeGreaterThan(Date.parse(initial.expiresAt));
      expect(renewed.pipeName).toBe(initial.pipeName);
      expect(renewed.authToken).toBe(initial.authToken);
      expect(renewed.startedAt).toBe(initial.startedAt);
    }, { timeout: 1_000, interval: 10 });
  });

  it('fully rolls back a listening runtime when discovery-file publication fails and can start again', async () => {
    let markFirstWriteStarted: (() => void) | undefined;
    const firstWriteStarted = new Promise<void>((resolve) => { markFirstWriteStarted = resolve; });
    let rejectFirstWrite: ((reason?: unknown) => void) | undefined;
    const firstWriteFailure = new Promise<void>((_resolve, reject) => { rejectFirstWrite = reject; });
    let firstDescriptor: Parameters<typeof writeMcpRuntimeFile>[1] | undefined;
    let writeCount = 0;
    const writeRuntimeFile = vi.fn(async (path: string, descriptor: Parameters<typeof writeMcpRuntimeFile>[1]) => {
      writeCount += 1;
      await writeMcpRuntimeFile(path, descriptor);
      if (writeCount !== 1) return;
      firstDescriptor = descriptor;
      await writeFile(`${path}.tmp`, 'simulated partial publication', 'utf8');
      markFirstWriteStarted?.();
      await firstWriteFailure;
    });
    const deleteRuntimeFile = vi.fn(deleteMcpRuntimeFile);
    const service = createMcpRuntimeService({
      runtimeFilePath,
      serverVersion: '1.0.0',
      runtimeRefreshIntervalMs: 5,
      writeRuntimeFile,
      deleteRuntimeFile,
      forwardRequest: async () => ({ ok: true, result: { revision: 1 } }),
    });
    services.push(service);

    const failedStart = service.start();
    const failedStartExpectation = expect(failedStart).rejects.toThrow('simulated runtime publication failure');
    await firstWriteStarted;
    expect(firstDescriptor).toBeDefined();
    const openSocket = connect(firstDescriptor!.pipeName);
    await once(openSocket, 'connect');
    const socketClosed = once(openSocket, 'close');
    const concurrentStart = service.start();
    const concurrentOutcome = concurrentStart.then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (error: unknown) => ({ status: 'rejected' as const, error }),
    );
    const concurrentSettledBeforePublication = await Promise.race([
      concurrentOutcome.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 20)),
    ]);

    rejectFirstWrite?.(new Error('simulated runtime publication failure'));
    await failedStartExpectation;
    const concurrentResult = await concurrentOutcome;
    await socketClosed;

    expect(concurrentSettledBeforePublication).toBe(false);
    expect(concurrentResult).toMatchObject({
      status: 'rejected', error: expect.objectContaining({ message: 'simulated runtime publication failure' }),
    });
    expect(openSocket.destroyed).toBe(true);
    expect(service.getStatus()).toEqual({
      state: 'stopped', rendererConnected: false, serverVersion: '1.0.0', toolCount: 14, lastError: null,
    });
    await expect(readFile(runtimeFilePath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(`${runtimeFilePath}.tmp`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(isPipeListening(firstDescriptor!.pipeName)).resolves.toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(writeRuntimeFile).toHaveBeenCalledTimes(1);
    expect(deleteRuntimeFile).toHaveBeenCalledTimes(1);

    const restarted = await service.start();
    expect(restarted.pipeName).not.toBe(firstDescriptor!.pipeName);
    await expect(callPipe(restarted.pipeName, {
      protocol: 'canvasforge.mcp.pipe.v1',
      requestId: 'after-restart',
      authToken: restarted.authToken,
      request: { tool: 'canvas_read_workflow' },
    })).resolves.toMatchObject({ response: { ok: true, result: { revision: 1 } } });
  });

  it('does not let callbacks from a stopped runtime mutate a restarted generation', async () => {
    let resolveStaleRequest: ((value: { ok: true; result: { revision: number } }) => void) | undefined;
    const staleRequest = new Promise<{ ok: true; result: { revision: number } }>((resolve) => { resolveStaleRequest = resolve; });
    const listenedServers: Server[] = [];
    const forwardRequest = vi.fn(async () => staleRequest);
    const service = createMcpRuntimeService({
      runtimeFilePath,
      serverVersion: '1.0.0',
      listenServer: async (runtimeServer, pipeName) => {
        listenedServers.push(runtimeServer);
        await listenForTest(runtimeServer, pipeName);
      },
      forwardRequest,
    });
    services.push(service);
    const initial = await service.start();
    const staleSocket = connect(initial.pipeName);
    await once(staleSocket, 'connect');
    staleSocket.write(`${JSON.stringify({
      protocol: 'canvasforge.mcp.pipe.v1', requestId: 'stale-request', authToken: initial.authToken,
      request: { tool: 'canvas_read_workflow' },
    })}\n`);
    await vi.waitFor(() => expect(forwardRequest).toHaveBeenCalledTimes(1));

    await service.stop();
    await service.start();
    listenedServers[0]!.emit('error', new Error('late error from stopped pipe'));
    const afterStaleServerError = service.getStatus();
    resolveStaleRequest?.({ ok: true, result: { revision: 9 } });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(afterStaleServerError).toMatchObject({ state: 'waiting_for_canvas', rendererConnected: false, lastError: null });
    expect(service.getStatus()).toMatchObject({ state: 'waiting_for_canvas', rendererConnected: false, lastError: null });
  });

  it('does not carry pending request ids into a restarted runtime', async () => {
    let resolveStaleRequest: ((value: { ok: true; result: { revision: number } }) => void) | undefined;
    const staleRequest = new Promise<{ ok: true; result: { revision: number } }>((resolve) => { resolveStaleRequest = resolve; });
    let requestCount = 0;
    const service = createMcpRuntimeService({
      runtimeFilePath,
      serverVersion: '1.0.0',
      forwardRequest: async () => {
        requestCount += 1;
        return requestCount === 1 ? staleRequest : { ok: true, result: { revision: 2 } };
      },
    });
    services.push(service);
    const initial = await service.start();
    const staleSocket = connect(initial.pipeName);
    await once(staleSocket, 'connect');
    staleSocket.write(`${JSON.stringify({
      protocol: 'canvasforge.mcp.pipe.v1', requestId: 'reused-id', authToken: initial.authToken,
      request: { tool: 'canvas_read_workflow' },
    })}\n`);
    await vi.waitFor(() => expect(requestCount).toBe(1));

    await service.stop();
    const restarted = await service.start();
    const repeated = await callPipe(restarted.pipeName, {
      protocol: 'canvasforge.mcp.pipe.v1', requestId: 'reused-id', authToken: restarted.authToken,
      request: { tool: 'canvas_read_workflow' },
    });
    resolveStaleRequest?.({ ok: true, result: { revision: 1 } });

    expect(repeated).toMatchObject({ response: { ok: true, result: { revision: 2 } } });
    expect(requestCount).toBe(2);
  });

  it('keeps stopped state when an in-flight descriptor refresh fails during stop', async () => {
    let rejectRefresh: ((reason?: unknown) => void) | undefined;
    const refreshFailure = new Promise<void>((_resolve, reject) => { rejectRefresh = reject; });
    let writeCount = 0;
    const service = createMcpRuntimeService({
      runtimeFilePath,
      serverVersion: '1.0.0',
      runtimeRefreshIntervalMs: 5,
      writeRuntimeFile: async (path, descriptor) => {
        writeCount += 1;
        if (writeCount === 1) await writeMcpRuntimeFile(path, descriptor);
        else await refreshFailure;
      },
      forwardRequest: async () => ({ ok: true, result: {} }),
    });
    services.push(service);
    await service.start();
    await vi.waitFor(() => expect(writeCount).toBe(2));

    const stopping = service.stop();
    rejectRefresh?.(new Error('simulated refresh failure'));
    await stopping;

    expect(service.getStatus()).toMatchObject({ state: 'stopped', rendererConnected: false, lastError: null });
  });

  it('does not publish a restarted runtime until the preceding stop has finished deleting the old descriptor', async () => {
    let announceDeleteStarted: (() => void) | undefined;
    const deleteStarted = new Promise<void>((resolve) => { announceDeleteStarted = resolve; });
    let releaseDelete: (() => void) | undefined;
    const deleteGate = new Promise<void>((resolve) => { releaseDelete = resolve; });
    let writes = 0;
    const service = createMcpRuntimeService({
      runtimeFilePath,
      serverVersion: '1.0.0',
      writeRuntimeFile: async (path, descriptor) => {
        writes += 1;
        await writeMcpRuntimeFile(path, descriptor);
      },
      deleteRuntimeFile: async (path) => {
        announceDeleteStarted?.();
        await deleteGate;
        await deleteMcpRuntimeFile(path);
      },
      forwardRequest: async () => ({ ok: true, result: {} }),
    });
    services.push(service);
    const initial = await service.start();

    const stopping = service.stop();
    await deleteStarted;
    const restarting = service.start();
    const restartSettledBeforeStop = await Promise.race([
      restarting.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 20)),
    ]);
    const writesBeforeStopFinished = writes;
    releaseDelete?.();
    await stopping;
    const restarted = await restarting;

    expect(restartSettledBeforeStop).toBe(false);
    expect(writesBeforeStopFinished).toBe(1);
    expect(restarted.pipeName).not.toBe(initial.pipeName);
    await expect(readMcpRuntimeFile(runtimeFilePath, { isProcessAlive: () => true })).resolves.toEqual(restarted);
    expect(service.getStatus()).toMatchObject({ state: 'waiting_for_canvas', lastError: null });
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

async function isPipeListening(pipeName: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect(pipeName);
    let settled = false;
    const finish = (listening: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.destroy();
      resolve(listening);
    };
    const timeout = setTimeout(() => finish(false), 1_000);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

function listenForTest(server: Server, pipeName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => { server.off('listening', onListening); reject(error); };
    const onListening = () => { server.off('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(pipeName);
  });
}
