import {
  PROVIDER_BRIDGE_CHANNELS,
  createProviderBridgeErrorEnvelope,
  createProviderBridgeSuccessEnvelope,
} from './provider-contracts.js';
import type { ProviderBridgeHandlers, ProviderIpcMainLike } from './provider-service-types.js';

export function registerProviderBridgeHandlers(
  ipcMain: ProviderIpcMainLike,
  handlers: ProviderBridgeHandlers,
): void {
  for (const [channel, handler] of providerHandlerEntries(handlers)) {
    ipcMain.handle(channel, wrapProviderIpcHandler(channel, handler));
  }
}

function providerHandlerEntries(handlers: ProviderBridgeHandlers) {
  return [
    [PROVIDER_BRIDGE_CHANNELS.getStatus, handlers.getStatus],
    [PROVIDER_BRIDGE_CHANNELS.checkConnection, handlers.checkConnection],
    [PROVIDER_BRIDGE_CHANNELS.configure, handlers.configure],
    [PROVIDER_BRIDGE_CHANNELS.unlock, handlers.unlock],
    [PROVIDER_BRIDGE_CHANNELS.listProfiles, handlers.listProfiles],
    [PROVIDER_BRIDGE_CHANNELS.submitImageJob, handlers.submitImageJob],
    [PROVIDER_BRIDGE_CHANNELS.pollImageJob, handlers.pollImageJob],
    [PROVIDER_BRIDGE_CHANNELS.cancelImageJob, handlers.cancelImageJob],
    [PROVIDER_BRIDGE_CHANNELS.ackImageJobTerminal, handlers.ackImageJobTerminal],
  ] as const;
}

function wrapProviderIpcHandler(
  channel: string,
  handler: (event: unknown, request: unknown) => Promise<unknown>,
): (event: unknown, request: unknown) => Promise<unknown> {
  return async (event, request) => {
    try {
      return createProviderBridgeSuccessEnvelope(channel, await handler(event, request));
    } catch (error) {
      return createProviderBridgeErrorEnvelope(error);
    }
  };
}
