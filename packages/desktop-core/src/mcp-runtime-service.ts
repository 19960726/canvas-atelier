import { randomUUID } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';

import {
  CanvasMcpRequestSchema,
  CanvasMcpResponseSchema,
  type CanvasMcpRequest,
  type CanvasMcpResponse,
} from '@agent-canvas/domain';

import {
  MCP_RUNTIME_TTL_MS,
  createMcpRuntimeDescriptor,
  deleteMcpRuntimeFile,
  writeMcpRuntimeFile,
  type CanvasMcpRuntimeDescriptor,
} from './mcp-runtime-file.js';

const PIPE_PROTOCOL = 'canvasforge.mcp.pipe.v1' as const;
const MAX_FRAME_BYTES = 1024 * 1024;

export interface McpPipeRequestEnvelope {
  readonly protocol: typeof PIPE_PROTOCOL;
  readonly requestId: string;
  readonly authToken: string;
  readonly request: CanvasMcpRequest;
}

export interface McpPipeResponseEnvelope {
  readonly protocol: typeof PIPE_PROTOCOL;
  readonly requestId: string;
  readonly response: CanvasMcpResponse;
}

export interface McpRuntimeServiceStatus {
  readonly state: 'stopped' | 'waiting_for_canvas' | 'running' | 'error';
  readonly rendererConnected: boolean;
  readonly serverVersion: string;
  readonly toolCount: 14;
  readonly lastError: string | null;
}

export interface McpRuntimeServiceOptions {
  readonly runtimeFilePath: string;
  readonly serverVersion: string;
  readonly processId?: number;
  readonly instanceId?: string;
  readonly requestTimeoutMs?: number;
  readonly runtimeRefreshIntervalMs?: number;
  readonly listenServer?: (server: Server, pipeName: string) => Promise<void>;
  readonly writeRuntimeFile?: (runtimeFilePath: string, descriptor: CanvasMcpRuntimeDescriptor) => Promise<void>;
  readonly deleteRuntimeFile?: (runtimeFilePath: string) => Promise<void>;
  readonly forwardRequest: (requestId: string, request: CanvasMcpRequest) => Promise<CanvasMcpResponse>;
}

export interface McpRuntimeService {
  start(): Promise<CanvasMcpRuntimeDescriptor>;
  stop(): Promise<void>;
  getStatus(): McpRuntimeServiceStatus;
}

export function presentMcpRuntimeStatus(
  status: McpRuntimeServiceStatus,
  rendererAvailable: boolean,
): McpRuntimeServiceStatus {
  if (!rendererAvailable || status.state === 'stopped' || status.state === 'error') return status;
  return Object.freeze({ ...status, state: 'running', rendererConnected: true, lastError: null });
}

export function createMcpRuntimeService(options: McpRuntimeServiceOptions): McpRuntimeService {
  let server: Server | null = null;
  let descriptor: CanvasMcpRuntimeDescriptor | null = null;
  let runtimeGeneration = 0;
  let startInFlight: Promise<CanvasMcpRuntimeDescriptor> | null = null;
  let stopInFlight: Promise<void> | null = null;
  let queuedStartAfterStop: Promise<CanvasMcpRuntimeDescriptor> | null = null;
  let state: McpRuntimeServiceStatus['state'] = 'stopped';
  let rendererConnected = false;
  let lastError: string | null = null;
  const pendingRequests = new Map<string, { readonly generation: number; cancel(): void }>();
  const sockets = new Map<Socket, number>();
  const requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
  const runtimeRefreshIntervalMs = options.runtimeRefreshIntervalMs ?? Math.floor(MCP_RUNTIME_TTL_MS / 3);
  const listenRuntimeServer = options.listenServer ?? listen;
  const publishRuntimeFile = options.writeRuntimeFile ?? writeMcpRuntimeFile;
  const removeRuntimeFile = options.deleteRuntimeFile ?? deleteMcpRuntimeFile;
  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  let refreshPromise: Promise<void> = Promise.resolve();

  function start(): Promise<CanvasMcpRuntimeDescriptor> {
    if (stopInFlight !== null) {
      if (queuedStartAfterStop !== null) return queuedStartAfterStop;
      const pendingStop = stopInFlight;
      const queuedStart = pendingStop.then(() => start());
      queuedStartAfterStop = queuedStart;
      void queuedStart.then(
        () => { if (queuedStartAfterStop === queuedStart) queuedStartAfterStop = null; },
        () => { if (queuedStartAfterStop === queuedStart) queuedStartAfterStop = null; },
      );
      return queuedStart;
    }
    if (startInFlight !== null) return startInFlight;
    if (server !== null && descriptor !== null) return Promise.resolve(descriptor);
    const generation = runtimeGeneration + 1;
    runtimeGeneration = generation;
    const attempt = startRuntime(generation);
    startInFlight = attempt;
    void attempt.then(
      () => { if (startInFlight === attempt) startInFlight = null; },
      () => { if (startInFlight === attempt) startInFlight = null; },
    );
    return attempt;
  }

  async function startRuntime(generation: number): Promise<CanvasMcpRuntimeDescriptor> {
    descriptor = createMcpRuntimeDescriptor({
      instanceId: options.instanceId ?? randomUUID().replace(/-/gu, ''),
      processId: options.processId ?? process.pid,
      serverVersion: options.serverVersion,
    });
    const runtimeDescriptor = descriptor;
    const runtimeServer = createServer((socket) => handleSocket(socket, runtimeDescriptor, generation, runtimeServer));
    server = runtimeServer;
    runtimeServer.on('error', () => {
      if (!isCurrentRuntime(generation, runtimeServer)) return;
      state = 'error';
      lastError = 'MCP_PIPE_ERROR';
    });
    try {
      await listenRuntimeServer(runtimeServer, runtimeDescriptor.pipeName);
      await publishRuntimeFile(options.runtimeFilePath, runtimeDescriptor);
      if (!isCurrentRuntime(generation, runtimeServer)) throw new Error('MCP_RUNTIME_START_CANCELLED');
      scheduleRuntimeRefresh(generation, runtimeServer);
      state = 'waiting_for_canvas';
      lastError = null;
      return runtimeDescriptor;
    } catch (startError) {
      try {
        await resetRuntime(runtimeServer, generation);
      } catch {
        throw new Error('MCP_RUNTIME_START_ROLLBACK_FAILED');
      }
      throw startError;
    }
  }

  function stop(): Promise<void> {
    if (stopInFlight !== null) return stopInFlight;
    const attempt = stopRuntime();
    stopInFlight = attempt;
    void attempt.then(
      () => { if (stopInFlight === attempt) stopInFlight = null; },
      () => { if (stopInFlight === attempt) stopInFlight = null; },
    );
    return attempt;
  }

  async function stopRuntime(): Promise<void> {
    const pendingStart = startInFlight;
    if (pendingStart !== null) {
      try { await pendingStart; } catch { /* Failed starts perform their own rollback. */ }
    }
    const currentServer = server;
    await resetRuntime(currentServer, runtimeGeneration);
  }

  async function resetRuntime(currentServer: Server | null, generation: number): Promise<void> {
    const ownsCurrentRuntime = generation === runtimeGeneration && server === currentServer;
    if (ownsCurrentRuntime) {
      runtimeGeneration += 1;
      server = null;
      descriptor = null;
      state = 'stopped';
      rendererConnected = false;
      lastError = null;
      if (refreshTimer !== null) clearTimeout(refreshTimer);
      refreshTimer = null;
    }
    cancelPendingRequests(generation);
    for (const [socket, socketGeneration] of sockets) {
      if (socketGeneration !== generation) continue;
      socket.destroy();
      sockets.delete(socket);
    }
    if (currentServer !== null) await closeServer(currentServer);
    if (ownsCurrentRuntime) {
      const pendingRefresh = refreshPromise;
      await pendingRefresh;
      if (refreshPromise === pendingRefresh) refreshPromise = Promise.resolve();
      await removeRuntimeFile(options.runtimeFilePath);
    }
  }

  function scheduleRuntimeRefresh(generation: number, runtimeServer: Server): void {
    if (!isCurrentRuntime(generation, runtimeServer) || descriptor === null) return;
    const timer = setTimeout(() => {
      if (refreshTimer === timer) refreshTimer = null;
      const currentDescriptor = descriptor;
      if (!isCurrentRuntime(generation, runtimeServer) || currentDescriptor === null) return;
      const refreshedDescriptor = Object.freeze({
        ...currentDescriptor,
        expiresAt: new Date(Date.now() + MCP_RUNTIME_TTL_MS).toISOString(),
      });
      refreshPromise = publishRuntimeFile(options.runtimeFilePath, refreshedDescriptor)
        .then(() => {
          if (isCurrentRuntime(generation, runtimeServer) && descriptor === currentDescriptor) descriptor = refreshedDescriptor;
        })
        .catch(() => {
          if (!isCurrentRuntime(generation, runtimeServer)) return;
          state = 'error';
          lastError = 'MCP_RUNTIME_FILE_REFRESH_FAILED';
        })
        .finally(() => scheduleRuntimeRefresh(generation, runtimeServer));
    }, runtimeRefreshIntervalMs);
    refreshTimer = timer;
    timer.unref?.();
  }

  function getStatus(): McpRuntimeServiceStatus {
    return Object.freeze({ state, rendererConnected, serverVersion: options.serverVersion, toolCount: 14, lastError });
  }

  function handleSocket(
    socket: Socket,
    runtimeDescriptor: CanvasMcpRuntimeDescriptor,
    generation: number,
    runtimeServer: Server,
  ): void {
    sockets.set(socket, generation);
    socket.setEncoding('utf8');
    let buffer = '';
    let frameRejected = false;
    socket.on('data', (chunk: string) => {
      if (!isCurrentRuntime(generation, runtimeServer)) { socket.destroy(); return; }
      if (frameRejected) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer, 'utf8') > MAX_FRAME_BYTES) {
        frameRejected = true;
        writeEnvelope(socket, errorEnvelope('unknown', 'MCP_FRAME_TOO_LARGE', 'MCP frame exceeds one MiB.'));
        return;
      }
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const frame = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        void handleFrame(socket, frame, runtimeDescriptor, generation, runtimeServer);
        newline = buffer.indexOf('\n');
      }
    });
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => sockets.delete(socket));
  }

  async function handleFrame(
    socket: Socket,
    frame: string,
    runtimeDescriptor: CanvasMcpRuntimeDescriptor,
    generation: number,
    runtimeServer: Server,
  ): Promise<void> {
    if (!isCurrentRuntime(generation, runtimeServer)) return;
    let raw: unknown;
    try {
      raw = JSON.parse(frame) as unknown;
    } catch {
      writeEnvelope(socket, errorEnvelope('unknown', 'MCP_MALFORMED_FRAME', 'MCP frame must be newline-delimited JSON.'));
      return;
    }
    const requestId = readRequestId(raw);
    if (!isPlainRecord(raw) || raw.protocol !== PIPE_PROTOCOL || raw.authToken !== runtimeDescriptor.authToken) {
      writeEnvelope(socket, errorEnvelope(requestId, 'MCP_AUTHENTICATION_FAILED', 'Local MCP authentication failed.'));
      return;
    }
    const parsedRequest = CanvasMcpRequestSchema.safeParse(raw.request);
    if (!parsedRequest.success) {
      writeEnvelope(socket, errorEnvelope(requestId, 'MCP_INVALID_REQUEST', 'MCP request does not match the Canvas Atelier contract.'));
      return;
    }
    const pendingKey = `${generation}:${requestId}`;
    if (pendingRequests.has(pendingKey)) {
      writeEnvelope(socket, errorEnvelope(requestId, 'MCP_DUPLICATE_REQUEST_ID', 'MCP request id is already pending.'));
      return;
    }
    try {
      const response = await withTrackedTimeout(
        pendingKey,
        generation,
        () => options.forwardRequest(requestId, parsedRequest.data),
        requestTimeoutMs,
      );
      const parsedResponse = CanvasMcpResponseSchema.parse(response);
      if (!isCurrentRuntime(generation, runtimeServer)) return;
      rendererConnected = true;
      state = 'running';
      lastError = null;
      writeEnvelope(socket, { protocol: PIPE_PROTOCOL, requestId, response: parsedResponse });
    } catch (error) {
      if (!isCurrentRuntime(generation, runtimeServer)) return;
      const code = error instanceof Error && error.message === 'MCP_RENDERER_TIMEOUT'
        ? 'MCP_RENDERER_TIMEOUT'
        : 'MCP_RENDERER_UNAVAILABLE';
      rendererConnected = false;
      state = 'waiting_for_canvas';
      lastError = code;
      writeEnvelope(socket, errorEnvelope(requestId, code, code === 'MCP_RENDERER_TIMEOUT'
        ? 'Canvas Atelier renderer did not answer in time.'
        : 'Canvas Atelier renderer is not available.'));
    }
  }

  function isCurrentRuntime(generation: number, runtimeServer: Server): boolean {
    return runtimeGeneration === generation && server === runtimeServer;
  }

  function cancelPendingRequests(generation: number): void {
    for (const request of pendingRequests.values()) {
      if (request.generation === generation) request.cancel();
    }
  }

  function withTrackedTimeout<T>(
    pendingKey: string,
    generation: number,
    operation: () => Promise<T>,
    timeoutMs: number,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout>;
      const finish = (callback: (value: T | unknown) => void, value: T | unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (pendingRequests.get(pendingKey) === controller) pendingRequests.delete(pendingKey);
        callback(value);
      };
      const controller = {
        generation,
        cancel: () => finish(reject, new Error('MCP_RUNTIME_STOPPED')),
      };
      timer = setTimeout(() => finish(reject, new Error('MCP_RENDERER_TIMEOUT')), timeoutMs);
      timer.unref?.();
      pendingRequests.set(pendingKey, controller);
      void Promise.resolve().then(operation).then(
        (value) => finish(resolve as (result: T | unknown) => void, value),
        (error) => finish(reject, error),
      );
    });
  }

  return { start, stop, getStatus };
}

function errorEnvelope(requestId: string, code: string, message: string): McpPipeResponseEnvelope {
  return { protocol: PIPE_PROTOCOL, requestId, response: { ok: false, error: { code, message } } };
}

function writeEnvelope(socket: Socket, envelope: McpPipeResponseEnvelope): void {
  if (!socket.destroyed) socket.write(`${JSON.stringify(envelope)}\n`);
}

function readRequestId(value: unknown): string {
  if (!isPlainRecord(value) || typeof value.requestId !== 'string' || value.requestId.length < 1 || value.requestId.length > 160) return 'unknown';
  return value.requestId;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function listen(server: Server, pipeName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => { server.off('listening', onListening); reject(error); };
    const onListening = () => { server.off('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(pipeName);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) { resolve(); return; }
    server.close(() => resolve());
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('MCP_RENDERER_TIMEOUT')), timeoutMs);
    void promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}
