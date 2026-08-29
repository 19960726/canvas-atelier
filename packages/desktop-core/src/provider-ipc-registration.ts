import {
  PROVIDER_BRIDGE_CHANNELS,
  createProviderBridgeError,
  createProviderBridgeErrorEnvelope,
  createProviderBridgeSuccessEnvelope,
} from './provider-contracts.js';
import type { ProviderBridgeHandlers, ProviderIpcMainLike } from './provider-service-types.js';

export function registerProviderBridgeHandlers(
  ipcMain: ProviderIpcMainLike,
  handlers: ProviderBridgeHandlers,
  options?: { readonly getTrustedSender: () => unknown | null },
): void {
  for (const [channel, handler] of providerHandlerEntries(handlers)) {
    ipcMain.handle(channel, wrapProviderIpcHandler(
      channel,
      handler,
      channel === PROVIDER_BRIDGE_CHANNELS.revealCredential ? options?.getTrustedSender : undefined,
    ));
  }
}

function providerHandlerEntries(handlers: ProviderBridgeHandlers) {
  return [
    [PROVIDER_BRIDGE_CHANNELS.getStatus, handlers.getStatus],
    [PROVIDER_BRIDGE_CHANNELS.revealCredential, handlers.revealCredential],
    [PROVIDER_BRIDGE_CHANNELS.checkConnection, handlers.checkConnection],
    [PROVIDER_BRIDGE_CHANNELS.configure, handlers.configure],
    [PROVIDER_BRIDGE_CHANNELS.updateProfiles, handlers.updateProfiles],
    [PROVIDER_BRIDGE_CHANNELS.unlock, handlers.unlock],
    [PROVIDER_BRIDGE_CHANNELS.listAvailableModelIds, handlers.listAvailableModelIds],
    [PROVIDER_BRIDGE_CHANNELS.listProfiles, handlers.listProfiles],
    [PROVIDER_BRIDGE_CHANNELS.listTasks, handlers.listTasks],
    [PROVIDER_BRIDGE_CHANNELS.getActiveProvider, handlers.getActiveProvider],
    [PROVIDER_BRIDGE_CHANNELS.setActiveProvider, handlers.setActiveProvider],
    [PROVIDER_BRIDGE_CHANNELS.loginRelayMe, handlers.loginRelayMe],
    [PROVIDER_BRIDGE_CHANNELS.logoutRelayMe, handlers.logoutRelayMe],
    [PROVIDER_BRIDGE_CHANNELS.submitImageJob, handlers.submitImageJob],
    [PROVIDER_BRIDGE_CHANNELS.pollImageJob, handlers.pollImageJob],
    [PROVIDER_BRIDGE_CHANNELS.cancelImageJob, handlers.cancelImageJob],
    [PROVIDER_BRIDGE_CHANNELS.ackImageJobTerminal, handlers.ackImageJobTerminal],
    [PROVIDER_BRIDGE_CHANNELS.submitVideoJob, handlers.submitVideoJob],
    [PROVIDER_BRIDGE_CHANNELS.pollVideoJob, handlers.pollVideoJob],
    [PROVIDER_BRIDGE_CHANNELS.cancelVideoJob, handlers.cancelVideoJob],
    [PROVIDER_BRIDGE_CHANNELS.ackVideoJobTerminal, handlers.ackVideoJobTerminal],
    [PROVIDER_BRIDGE_CHANNELS.analyzeReversePrompt, handlers.analyzeReversePrompt],
    [PROVIDER_BRIDGE_CHANNELS.chat, handlers.chat],
    [PROVIDER_BRIDGE_CHANNELS.generateStoryboard, handlers.generateStoryboard],
  ] as const;
}

function wrapProviderIpcHandler(
  channel: string,
  handler: (event: unknown, request: unknown) => Promise<unknown>,
  getTrustedSender?: () => unknown | null,
): (event: unknown, request: unknown) => Promise<unknown> {
  return async (event, request) => {
    try {
      if (getTrustedSender !== undefined) {
        const sender = typeof event === 'object' && event !== null && 'sender' in event
          ? (event as { readonly sender: unknown }).sender
          : null;
        const trustedSender = getTrustedSender();
        if (trustedSender === null || sender !== trustedSender) {
          throw createProviderBridgeError('INVALID_REQUEST', 'Credential reveal is not authorized');
        }
      }
      return createProviderBridgeSuccessEnvelope(channel, await handler(event, request));
    } catch (error) {
      return createProviderBridgeErrorEnvelope(error);
    }
  };
}
