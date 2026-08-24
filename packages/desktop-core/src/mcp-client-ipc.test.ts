import { describe, expect, it, vi } from 'vitest';

import type { McpClientConfigManager } from './mcp-client-config';
import { registerMcpClientConfigIpc } from './mcp-client-ipc';
import { BRIDGE_CHANNELS } from './preload-api';

function createHarness() {
  const handlers = new Map<string, (event: { sender: unknown }, payload?: unknown) => unknown>();
  return {
    handlers,
    ipcMain: {
      handle: vi.fn((channel: string, handler: (event: { sender: unknown }, payload?: unknown) => unknown) => handlers.set(channel, handler)),
      removeHandler: vi.fn((channel: string) => handlers.delete(channel)),
    },
  };
}

describe('MCP client config IPC', () => {
  it('routes strict trusted requests to the configuration manager', async () => {
    const harness = createHarness();
    const trustedSender = {};
    const manager: McpClientConfigManager = {
      connect: vi.fn(async (client) => ({ client, state: 'connected' as const, toolCount: 14 as const, lastError: null })),
      disconnect: vi.fn(async (client) => ({ client, state: 'unconfigured' as const, toolCount: 0 as const, lastError: null })),
      getStatus: vi.fn(async (client) => ({ client, state: 'configured' as const, toolCount: 0 as const, lastError: null })),
      test: vi.fn(async (client) => ({ client, state: 'connected' as const, toolCount: 14 as const, lastError: null })),
      copyConfig: vi.fn((client) => `${client}-config`),
    };
    const registration = registerMcpClientConfigIpc({ ipcMain: harness.ipcMain, manager, getTrustedSender: () => trustedSender });

    await expect(harness.handlers.get(BRIDGE_CHANNELS.mcpIntegration.status)?.({ sender: trustedSender })).resolves.toHaveLength(2);
    await expect(harness.handlers.get(BRIDGE_CHANNELS.mcpIntegration.connect)?.({ sender: trustedSender }, { client: 'codex' })).resolves.toMatchObject({ client: 'codex', state: 'connected' });
    await expect(harness.handlers.get(BRIDGE_CHANNELS.mcpIntegration.copyConfig)?.({ sender: trustedSender }, { client: 'workbuddy' })).resolves.toEqual({ client: 'workbuddy', config: 'workbuddy-config' });
    expect(manager.connect).toHaveBeenCalledWith('codex');
    expect(manager.copyConfig).toHaveBeenCalledWith('workbuddy');

    registration.dispose();
    expect(harness.ipcMain.removeHandler).toHaveBeenCalledTimes(5);
  });

  it('rejects foreign senders, unknown clients, and extra payload fields', async () => {
    const harness = createHarness();
    const trustedSender = {};
    const manager = {
      connect: vi.fn(), disconnect: vi.fn(), getStatus: vi.fn(), test: vi.fn(), copyConfig: vi.fn(),
    } as unknown as McpClientConfigManager;
    registerMcpClientConfigIpc({ ipcMain: harness.ipcMain, manager, getTrustedSender: () => trustedSender });
    const connect = harness.handlers.get(BRIDGE_CHANNELS.mcpIntegration.connect)!;

    await expect(connect({ sender: {} }, { client: 'codex' })).rejects.toThrow('MCP_CLIENT_UNAUTHORIZED');
    await expect(connect({ sender: trustedSender }, { client: 'other' })).rejects.toThrow('MCP_CLIENT_INVALID_REQUEST');
    await expect(connect({ sender: trustedSender }, { client: 'codex', configPath: 'C:\\private' })).rejects.toThrow('MCP_CLIENT_INVALID_REQUEST');
    expect(manager.connect).not.toHaveBeenCalled();
  });
});