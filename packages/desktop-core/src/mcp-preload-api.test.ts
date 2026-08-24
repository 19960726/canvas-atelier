import { describe, expect, it, vi } from 'vitest';

import { BRIDGE_CHANNELS, createPreloadApi, type DesktopBridgeInvoke } from './preload-api';

describe('MCP renderer preload boundary', () => {
  it('exposes only request, response, and public status methods', async () => {
    const invoke = vi.fn(async () => ({ state: 'running', rendererConnected: true, serverVersion: '1.0.0', toolCount: 14, lastError: null })) as DesktopBridgeInvoke;
    const subscribe = vi.fn((_channel, _listener) => vi.fn());
    const send = vi.fn();
    const api = createPreloadApi(invoke, subscribe, send).mcpRuntime;

    expect(Object.keys(api).sort()).toEqual(['getStatus', 'onRequest', 'respond']);
    await expect(api.getStatus()).resolves.toEqual({ state: 'running', rendererConnected: true, serverVersion: '1.0.0', toolCount: 14, lastError: null });
    expect(invoke).toHaveBeenCalledWith(BRIDGE_CHANNELS.mcpRuntime.status);
    expect(api).not.toHaveProperty('pipeName');
    expect(api).not.toHaveProperty('authToken');
  });

  it('accepts strict renderer requests and responses without exposing authentication data', () => {
    const subscribe = vi.fn((_channel, _listener) => vi.fn());
    const send = vi.fn();
    const api = createPreloadApi(vi.fn(async () => undefined) as DesktopBridgeInvoke, subscribe, send).mcpRuntime;
    const listener = vi.fn();
    api.onRequest(listener);
    const eventListener = subscribe.mock.calls[0]?.[1];

    eventListener?.({ requestId: 'mcp-request-1', request: { tool: 'canvas_read_workflow' } });
    eventListener?.({ requestId: 'mcp-request-2', request: { tool: 'canvas_shell' } });
    eventListener?.({ requestId: 'mcp-request-3', request: { tool: 'canvas_read_workflow' }, authToken: 'hidden' });

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith({ requestId: 'mcp-request-1', request: { tool: 'canvas_read_workflow' } });
    expect(api.respond({ requestId: 'mcp-request-1', response: { ok: true, result: { revision: 1 } } })).toBe(true);
    expect(api.respond({ requestId: 'mcp-request-1', response: { ok: true, result: { absolutePath: 'C:\\private.png' } } } as never)).toBe(false);
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(BRIDGE_CHANNELS.mcpRuntime.response, { requestId: 'mcp-request-1', response: { ok: true, result: { revision: 1 } } });
  });
});