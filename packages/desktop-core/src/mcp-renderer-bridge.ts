import {
  CanvasMcpRequestSchema,
  CanvasMcpResponseSchema,
  type CanvasMcpRequest,
  type CanvasMcpResponse,
} from '@agent-canvas/domain';

import type { McpRuntimePublicStatus, McpRuntimeRendererResponse } from './contracts.js';
import { BRIDGE_CHANNELS } from './preload-api.js';

interface McpIpcEventLike {
  readonly sender: unknown;
}

export interface McpIpcMainLike {
  handle(channel: string, handler: (event: McpIpcEventLike, payload?: unknown) => unknown): void;
  removeHandler(channel: string): void;
  on(channel: string, listener: (event: McpIpcEventLike, payload: unknown) => void): void;
  removeListener(channel: string, listener: (event: McpIpcEventLike, payload: unknown) => void): void;
}

export interface McpRendererEndpoint {
  readonly sender: unknown;
  isDestroyed(): boolean;
  send(channel: string, payload: unknown): void;
}

export interface McpRendererBridgeOptions {
  readonly ipcMain: McpIpcMainLike;
  readonly getRenderer: () => McpRendererEndpoint | null;
  readonly getStatus: () => McpRuntimePublicStatus;
  readonly requestTimeoutMs?: number;
}

export interface McpRendererBridge {
  forwardRequest(requestId: string, request: CanvasMcpRequest): Promise<CanvasMcpResponse>;
  dispose(): void;
}

interface PendingRequest {
  readonly resolve: (response: CanvasMcpResponse) => void;
  readonly reject: (error: Error) => void;
  readonly timeout: ReturnType<typeof setTimeout>;
}

export function createMcpRendererBridge(options: McpRendererBridgeOptions): McpRendererBridge {
  const pending = new Map<string, PendingRequest>();
  const requestTimeoutMs = options.requestTimeoutMs ?? 15_000;

  const handleResponse = (event: McpIpcEventLike, payload: unknown): void => {
    const renderer = options.getRenderer();
    if (renderer === null || renderer.isDestroyed() || event.sender !== renderer.sender) return;
    const parsed = parseRendererResponse(payload);
    if (parsed === null) return;
    const request = pending.get(parsed.requestId);
    if (request === undefined) return;
    pending.delete(parsed.requestId);
    clearTimeout(request.timeout);
    request.resolve(parsed.response);
  };

  options.ipcMain.handle(BRIDGE_CHANNELS.mcpRuntime.status, async () => options.getStatus());
  options.ipcMain.on(BRIDGE_CHANNELS.mcpRuntime.response, handleResponse);

  function forwardRequest(requestId: string, request: CanvasMcpRequest): Promise<CanvasMcpResponse> {
    const renderer = options.getRenderer();
    if (renderer === null || renderer.isDestroyed()) return Promise.reject(new Error('MCP_RENDERER_UNAVAILABLE'));
    if (!isRequestId(requestId) || pending.has(requestId)) return Promise.reject(new Error('MCP_DUPLICATE_REQUEST_ID'));
    const parsedRequest = CanvasMcpRequestSchema.safeParse(request);
    if (!parsedRequest.success) return Promise.reject(new Error('MCP_INVALID_REQUEST'));

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error('MCP_RENDERER_TIMEOUT'));
      }, requestTimeoutMs);
      pending.set(requestId, { resolve, reject, timeout });
      renderer.send(BRIDGE_CHANNELS.mcpRuntime.request, { requestId, request: parsedRequest.data });
    });
  }

  function dispose(): void {
    options.ipcMain.removeHandler(BRIDGE_CHANNELS.mcpRuntime.status);
    options.ipcMain.removeListener(BRIDGE_CHANNELS.mcpRuntime.response, handleResponse);
    for (const request of pending.values()) {
      clearTimeout(request.timeout);
      request.reject(new Error('MCP_RENDERER_UNAVAILABLE'));
    }
    pending.clear();
  }

  return { forwardRequest, dispose };
}

function parseRendererResponse(value: unknown): McpRuntimeRendererResponse | null {
  if (!isPlainRecord(value) || !hasOnlyKeys(value, ['requestId', 'response']) || !isRequestId(value.requestId)) return null;
  const response = CanvasMcpResponseSchema.safeParse(value.response);
  return response.success ? { requestId: value.requestId, response: response.data } : null;
}

function isRequestId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 160;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}