import { describe, expect, it, vi } from 'vitest';

import { BRIDGE_CHANNELS, createPreloadApi, type DesktopBridgeInvoke } from './preload-api';

describe('MCP client integration preload boundary', () => {
  it('exposes only status, connect, copy, test, and disconnect actions', async () => {
    const invoke = vi.fn(async () => ({ client: 'codex', state: 'configured', toolCount: 0, lastError: null })) as DesktopBridgeInvoke;
    const api = createPreloadApi(invoke).mcpIntegration;

    expect(Object.keys(api).sort()).toEqual(['connect', 'copyConfig', 'disconnect', 'getStatus', 'test']);
    await api.connect('codex');
    await api.disconnect('workbuddy');
    expect(invoke).toHaveBeenCalledWith(BRIDGE_CHANNELS.mcpIntegration.connect, { client: 'codex' });
    expect(invoke).toHaveBeenCalledWith(BRIDGE_CHANNELS.mcpIntegration.disconnect, { client: 'workbuddy' });
  });

  it('rejects unknown clients and malformed status/config responses at preload', async () => {
    const invoke = vi.fn(async (channel: string) => {
      if (channel === BRIDGE_CHANNELS.mcpIntegration.copyConfig) return { client: 'codex', config: '[mcp_servers.canvasforge]\n' };
      if (channel === BRIDGE_CHANNELS.mcpIntegration.status) return [
        { client: 'codex', state: 'configured', toolCount: 0, lastError: null },
        { client: 'workbuddy', state: 'unconfigured', toolCount: 0, lastError: null },
      ];
      return { client: 'codex', state: 'connected', toolCount: 14, lastError: null };
    }) as DesktopBridgeInvoke;
    const api = createPreloadApi(invoke).mcpIntegration;

    await expect(api.getStatus()).resolves.toHaveLength(2);
    await expect(api.copyConfig('codex')).resolves.toEqual({ client: 'codex', config: '[mcp_servers.canvasforge]\n' });
    await expect(api.connect('invalid' as never)).rejects.toThrow('MCP_CLIENT_INVALID_REQUEST');

    const malformed = createPreloadApi(vi.fn(async () => ({ client: 'codex', state: 'connected', toolCount: 14, lastError: null, configPath: 'C:\\private' })) as DesktopBridgeInvoke).mcpIntegration;
    await expect(malformed.connect('codex')).rejects.toThrow('MCP_CLIENT_INVALID_RESPONSE');
  });
});