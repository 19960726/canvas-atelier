import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { connect } from 'node:net';

import {
  CanvasMcpRequestSchema,
  CanvasMcpResponseSchema,
  type CanvasMcpRequest,
  type CanvasMcpResponse,
} from '@agent-canvas/domain';

const PIPE_PROTOCOL = 'canvasforge.mcp.pipe.v1' as const;
const MAX_RESPONSE_BYTES = 1024 * 1024;

export interface McpRuntimeClientOptions {
  readonly runtimeFilePath: string;
  readonly timeoutMs?: number;
}

export interface McpRuntimeClient {
  call(request: unknown): Promise<CanvasMcpResponse>;
  close(): Promise<void>;
}

export function createMcpRuntimeClient(options: McpRuntimeClientOptions): McpRuntimeClient {
  let closed = false;
  return {
    async call(input) {
      const parsedRequest = CanvasMcpRequestSchema.safeParse(input);
      if (!parsedRequest.success) return error('MCP_INVALID_REQUEST', 'Tool arguments do not match the CanvasForge contract.');
      if (closed) return error('MCP_CLIENT_CLOSED', 'The CanvasForge MCP client is closed.');
      let descriptor;
      try {
        descriptor = await readRuntimeDescriptor(options.runtimeFilePath);
      } catch {
        return error('MCP_WAITING_FOR_CANVAS', 'Open CanvasForge and keep a canvas window active.');
      }
      try {
        return await sendPipeRequest(descriptor.pipeName, descriptor.authToken, parsedRequest.data, options.timeoutMs ?? 15_000);
      } catch (cause) {
        return error(
          cause instanceof Error && cause.message === 'MCP_RUNTIME_TIMEOUT' ? 'MCP_RUNTIME_TIMEOUT' : 'MCP_RUNTIME_UNAVAILABLE',
          cause instanceof Error && cause.message === 'MCP_RUNTIME_TIMEOUT'
            ? 'CanvasForge did not answer in time.'
            : 'CanvasForge runtime is unavailable; reopen the desktop app.',
        );
      }
    },
    async close() { closed = true; },
  };
}

async function sendPipeRequest(
  pipeName: string,
  authToken: string,
  request: CanvasMcpRequest,
  timeoutMs: number,
): Promise<CanvasMcpResponse> {
  return new Promise((resolve, reject) => {
    const requestId = randomUUID();
    const socket = connect(pipeName);
    let buffer = '';
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      callback();
    };
    const timer = setTimeout(() => finish(() => reject(new Error('MCP_RUNTIME_TIMEOUT'))), timeoutMs);
    socket.setEncoding('utf8');
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ protocol: PIPE_PROTOCOL, requestId, authToken, request })}\n`);
    });
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, 'utf8') > MAX_RESPONSE_BYTES) {
        finish(() => reject(new Error('MCP_RUNTIME_RESPONSE_TOO_LARGE')));
        return;
      }
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      try {
        const envelope = JSON.parse(buffer.slice(0, newline)) as unknown;
        if (!isPlainRecord(envelope) || envelope.protocol !== PIPE_PROTOCOL || envelope.requestId !== requestId) {
          throw new Error('MCP_RUNTIME_INVALID_RESPONSE');
        }
        const response = CanvasMcpResponseSchema.parse(envelope.response);
        finish(() => resolve(response));
      } catch (error) {
        finish(() => reject(error));
      }
    });
    socket.on('error', (error) => finish(() => reject(error)));
    socket.on('close', () => {
      if (!settled) finish(() => reject(new Error('MCP_RUNTIME_DISCONNECTED')));
    });
  });
}

function error(code: string, message: string): CanvasMcpResponse {
  return { ok: false, error: { code, message } };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
interface RuntimeDescriptor {
  readonly pipeName: string;
  readonly authToken: string;
  readonly expiresAt: string;
  readonly processId: number;
}

async function readRuntimeDescriptor(runtimeFilePath: string): Promise<RuntimeDescriptor> {
  const value = JSON.parse(await readFile(runtimeFilePath, 'utf8')) as unknown;
  if (!isPlainRecord(value)
    || value.protocol !== 'canvasforge.mcp.runtime.v1'
    || typeof value.pipeName !== 'string'
    || !/^\\\\\.\\pipe\\canvasforge-mcp-[A-Za-z0-9_-]+-[A-Za-z0-9_-]+$/u.test(value.pipeName)
    || typeof value.authToken !== 'string'
    || value.authToken.length < 12
    || typeof value.expiresAt !== 'string'
    || !Number.isFinite(Date.parse(value.expiresAt))
    || Date.parse(value.expiresAt) <= Date.now()
    || typeof value.processId !== 'number'
    || !Number.isInteger(value.processId)
    || value.processId <= 0
    || !isProcessAlive(value.processId)) {
    throw new Error('MCP_RUNTIME_INVALID');
  }
  return { pipeName: value.pipeName, authToken: value.authToken, expiresAt: value.expiresAt, processId: value.processId };
}

function isProcessAlive(processId: number): boolean {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return error instanceof Error && 'code' in error && (error as Error & { code?: unknown }).code === 'EPERM';
  }
}