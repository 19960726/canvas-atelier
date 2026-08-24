import { randomUUID } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';

import {
  CanvasMcpRequestSchema,
  CanvasMcpResponseSchema,
  type CanvasMcpRequest,
  type CanvasMcpResponse,
} from '@agent-canvas/domain';

import {
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
  readonly forwardRequest: (requestId: string, request: CanvasMcpRequest) => Promise<CanvasMcpResponse>;
}

export interface McpRuntimeService {
  start(): Promise<CanvasMcpRuntimeDescriptor>;
  stop(): Promise<void>;
  getStatus(): McpRuntimeServiceStatus;
}

export function createMcpRuntimeService(options: McpRuntimeServiceOptions): McpRuntimeService {
  let server: Server | null = null;
  let descriptor: CanvasMcpRuntimeDescriptor | null = null;
  let state: McpRuntimeServiceStatus['state'] = 'stopped';
  let rendererConnected = false;
  let lastError: string | null = null;
  const pendingIds = new Set<string>();
  const sockets = new Set<Socket>();
  const requestTimeoutMs = options.requestTimeoutMs ?? 15_000;

  async function start(): Promise<CanvasMcpRuntimeDescriptor> {
    if (server !== null && descriptor !== null) return descriptor;
    descriptor = createMcpRuntimeDescriptor({
      instanceId: options.instanceId ?? randomUUID().replace(/-/gu, ''),
      processId: options.processId ?? process.pid,
      serverVersion: options.serverVersion,
    });
    const runtimeDescriptor = descriptor;
    server = createServer((socket) => handleSocket(socket, runtimeDescriptor));
    server.on('error', () => {
      state = 'error';
      lastError = 'MCP_PIPE_ERROR';
    });
    await listen(server, runtimeDescriptor.pipeName);
    await writeMcpRuntimeFile(options.runtimeFilePath, runtimeDescriptor);
    state = 'waiting_for_canvas';
    lastError = null;
    return runtimeDescriptor;
  }

  async function stop(): Promise<void> {
    const currentServer = server;
    server = null;
    descriptor = null;
    state = 'stopped';
    rendererConnected = false;
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    if (currentServer !== null) await closeServer(currentServer);
    await deleteMcpRuntimeFile(options.runtimeFilePath);
  }

  function getStatus(): McpRuntimeServiceStatus {
    return Object.freeze({ state, rendererConnected, serverVersion: options.serverVersion, toolCount: 14, lastError });
  }

  function handleSocket(socket: Socket, runtimeDescriptor: CanvasMcpRuntimeDescriptor): void {
    sockets.add(socket);
    socket.setEncoding('utf8');
    let buffer = '';
    let frameRejected = false;
    socket.on('data', (chunk: string) => {
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
        void handleFrame(socket, frame, runtimeDescriptor);
        newline = buffer.indexOf('\n');
      }
    });
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => sockets.delete(socket));
  }

  async function handleFrame(socket: Socket, frame: string, runtimeDescriptor: CanvasMcpRuntimeDescriptor): Promise<void> {
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
      writeEnvelope(socket, errorEnvelope(requestId, 'MCP_INVALID_REQUEST', 'MCP request does not match the CanvasForge contract.'));
      return;
    }
    if (pendingIds.has(requestId)) {
      writeEnvelope(socket, errorEnvelope(requestId, 'MCP_DUPLICATE_REQUEST_ID', 'MCP request id is already pending.'));
      return;
    }
    pendingIds.add(requestId);
    try {
      const response = await withTimeout(
        options.forwardRequest(requestId, parsedRequest.data),
        requestTimeoutMs,
      );
      const parsedResponse = CanvasMcpResponseSchema.parse(response);
      rendererConnected = true;
      state = 'running';
      lastError = null;
      writeEnvelope(socket, { protocol: PIPE_PROTOCOL, requestId, response: parsedResponse });
    } catch (error) {
      const code = error instanceof Error && error.message === 'MCP_RENDERER_TIMEOUT'
        ? 'MCP_RENDERER_TIMEOUT'
        : 'MCP_RENDERER_UNAVAILABLE';
      rendererConnected = false;
      state = 'waiting_for_canvas';
      lastError = code;
      writeEnvelope(socket, errorEnvelope(requestId, code, code === 'MCP_RENDERER_TIMEOUT'
        ? 'CanvasForge renderer did not answer in time.'
        : 'CanvasForge renderer is not available.'));
    } finally {
      pendingIds.delete(requestId);
    }
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