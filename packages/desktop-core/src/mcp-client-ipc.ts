import type { McpClientConfigManager, McpClientId } from './mcp-client-config.js';
import { BRIDGE_CHANNELS } from './preload-api.js';

interface IpcEventLike {
  readonly sender: unknown;
}

export interface McpClientConfigIpcMainLike {
  handle(channel: string, handler: (event: IpcEventLike, payload?: unknown) => unknown): void;
  removeHandler(channel: string): void;
}

export interface McpClientConfigIpcRegistration {
  dispose(): void;
}

export function registerMcpClientConfigIpc(options: {
  readonly ipcMain: McpClientConfigIpcMainLike;
  readonly manager: McpClientConfigManager;
  readonly getTrustedSender: () => unknown | null;
}): McpClientConfigIpcRegistration {
  const channels = BRIDGE_CHANNELS.mcpIntegration;
  const authorize = (event: IpcEventLike): void => {
    const trusted = options.getTrustedSender();
    if (trusted === null || event.sender !== trusted) throw new Error('MCP_CLIENT_UNAUTHORIZED');
  };
  const clientFrom = (payload: unknown): McpClientId => {
    if (!isPlainRecord(payload) || Object.keys(payload).length !== 1 || (payload.client !== 'codex' && payload.client !== 'workbuddy')) {
      throw new Error('MCP_CLIENT_INVALID_REQUEST');
    }
    return payload.client;
  };

  options.ipcMain.handle(channels.status, async (event) => {
    authorize(event);
    return Promise.all([options.manager.getStatus('codex'), options.manager.getStatus('workbuddy')]);
  });
  options.ipcMain.handle(channels.connect, async (event, payload) => {
    authorize(event);
    return options.manager.connect(clientFrom(payload));
  });
  options.ipcMain.handle(channels.copyConfig, async (event, payload) => {
    authorize(event);
    const client = clientFrom(payload);
    return { client, config: options.manager.copyConfig(client) };
  });
  options.ipcMain.handle(channels.test, async (event, payload) => {
    authorize(event);
    return options.manager.test(clientFrom(payload));
  });
  options.ipcMain.handle(channels.disconnect, async (event, payload) => {
    authorize(event);
    return options.manager.disconnect(clientFrom(payload));
  });

  return {
    dispose() {
      options.ipcMain.removeHandler(channels.status);
      options.ipcMain.removeHandler(channels.connect);
      options.ipcMain.removeHandler(channels.copyConfig);
      options.ipcMain.removeHandler(channels.test);
      options.ipcMain.removeHandler(channels.disconnect);
    },
  };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}