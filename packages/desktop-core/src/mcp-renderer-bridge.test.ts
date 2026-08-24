import { describe, expect, it, vi } from 'vitest';

import { BRIDGE_CHANNELS } from './preload-api';
import { createMcpRendererBridge } from './mcp-renderer-bridge';

function createIpcHarness() {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const listeners = new Map<string, (...args: any[]) => unknown>();
  return {
    ipcMain: {
      handle: vi.fn((channel: string, handler: (...args: any[]) => unknown) => handlers.set(channel, handler)),
      removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
      on: vi.fn((channel: string, listener: (...args: any[]) => unknown) => listeners.set(channel, listener)),
      removeListener: vi.fn((channel: string) => listeners.delete(channel)),
    },
    handlers,
    listeners,
  };
}

describe('MCP main-to-renderer bridge', () => {
  it('forwards one strict request to the trusted renderer and resolves the matching response', async () => {
    const harness = createIpcHarness();
    const trustedSender = {};
    const renderer = { isDestroyed: () => false, send: vi.fn() };
    const bridge = createMcpRendererBridge({
      ipcMain: harness.ipcMain,
      getRenderer: () => ({ sender: trustedSender, ...renderer }),
      getStatus: () => ({ state: 'running', rendererConnected: true, serverVersion: '1.0.0', toolCount: 14, lastError: null }),
      requestTimeoutMs: 100,
    });

    const responsePromise = bridge.forwardRequest('request-1', { tool: 'canvas_read_workflow' });
    expect(renderer.send).toHaveBeenCalledWith(BRIDGE_CHANNELS.mcpRuntime.request, {
      requestId: 'request-1',
      request: { tool: 'canvas_read_workflow' },
    });

    harness.listeners.get(BRIDGE_CHANNELS.mcpRuntime.response)?.(
      { sender: trustedSender },
      { requestId: 'request-1', response: { ok: true, result: { revision: 1 } } },
    );

    await expect(responsePromise).resolves.toEqual({ ok: true, result: { revision: 1 } });
    bridge.dispose();
  });

  it('ignores foreign senders and invalid responses, exposes public status, and times out cleanly', async () => {
    vi.useFakeTimers();
    const harness = createIpcHarness();
    const trustedSender = {};
    const renderer = { isDestroyed: () => false, send: vi.fn() };
    const status = { state: 'waiting_for_canvas' as const, rendererConnected: false, serverVersion: '1.0.0', toolCount: 14 as const, lastError: null };
    const bridge = createMcpRendererBridge({
      ipcMain: harness.ipcMain,
      getRenderer: () => ({ sender: trustedSender, ...renderer }),
      getStatus: () => status,
      requestTimeoutMs: 25,
    });

    await expect(harness.handlers.get(BRIDGE_CHANNELS.mcpRuntime.status)?.({ sender: trustedSender })).resolves.toEqual(status);
    const responsePromise = bridge.forwardRequest('request-2', { tool: 'canvas_read_workflow' });
    harness.listeners.get(BRIDGE_CHANNELS.mcpRuntime.response)?.(
      { sender: {} },
      { requestId: 'request-2', response: { ok: true, result: { revision: 2 } } },
    );
    harness.listeners.get(BRIDGE_CHANNELS.mcpRuntime.response)?.(
      { sender: trustedSender },
      { requestId: 'request-2', response: { ok: true, result: { absolutePath: 'C:\\private.png' } } },
    );
    const timeoutExpectation = expect(responsePromise).rejects.toThrow('MCP_RENDERER_TIMEOUT');
    await vi.advanceTimersByTimeAsync(25);
    await timeoutExpectation;

    bridge.dispose();
    expect(harness.ipcMain.removeHandler).toHaveBeenCalledWith(BRIDGE_CHANNELS.mcpRuntime.status);
    expect(harness.ipcMain.removeListener).toHaveBeenCalledWith(BRIDGE_CHANNELS.mcpRuntime.response, expect.any(Function));
    vi.useRealTimers();
  });

  it('rejects when no active renderer exists', async () => {
    const harness = createIpcHarness();
    const bridge = createMcpRendererBridge({
      ipcMain: harness.ipcMain,
      getRenderer: () => null,
      getStatus: () => ({ state: 'waiting_for_canvas', rendererConnected: false, serverVersion: '1.0.0', toolCount: 14, lastError: null }),
    });

    await expect(bridge.forwardRequest('request-3', { tool: 'canvas_read_workflow' })).rejects.toThrow('MCP_RENDERER_UNAVAILABLE');
    bridge.dispose();
  });
});