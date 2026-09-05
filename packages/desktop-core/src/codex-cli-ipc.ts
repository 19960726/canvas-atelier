import {
  CODEX_ASTRA_PROFILE,
  CODEX_CLI_CHANNELS,
  type CodexCliBridgeEnvelope,
  type CodexCliChatResult,
  type CodexCliCancelResult,
} from './codex-cli-contract.js';
import { normalizeCodexCliError, type CodexCliService } from './codex-cli-service.js';

export { CODEX_ASTRA_PROFILE, CODEX_CLI_CHANNELS } from './codex-cli-contract.js';

interface CodexCliIpcMainLike {
  handle(channel: string, listener: (event: { readonly sender?: unknown }, payload?: unknown) => Promise<unknown>): void;
  removeHandler?(channel: string): void;
}

export function registerCodexCliIpc(options: {
  readonly ipcMain: CodexCliIpcMainLike;
  readonly service: CodexCliService;
  readonly getTrustedSender: () => unknown | null;
}): { dispose(): Promise<void> } {
  const assertTrusted = (event: { readonly sender?: unknown }) => {
    const trusted = options.getTrustedSender();
    if (trusted === null || event.sender !== trusted) throw new Error('CODEX_CLI_UNTRUSTED_SENDER');
  };
  options.ipcMain.handle(CODEX_CLI_CHANNELS.listProfiles, async (event) => {
    assertTrusted(event);
    return options.service.listProfiles();
  });
  options.ipcMain.handle(CODEX_CLI_CHANNELS.chat, async (event, payload): Promise<CodexCliBridgeEnvelope<CodexCliChatResult>> => {
    assertTrusted(event);
    try {
      return { ok: true, value: await options.service.chat(payload) };
    } catch (error) {
      return { ok: false, error: normalizeCodexCliError(error) };
    }
  });
  options.ipcMain.handle(CODEX_CLI_CHANNELS.cancel, async (event, payload): Promise<CodexCliBridgeEnvelope<CodexCliCancelResult>> => {
    assertTrusted(event);
    try {
      return { ok: true, value: await options.service.cancel(payload) };
    } catch (error) {
      return { ok: false, error: normalizeCodexCliError(error) };
    }
  });
  return {
    async dispose() {
      options.ipcMain.removeHandler?.(CODEX_CLI_CHANNELS.listProfiles);
      options.ipcMain.removeHandler?.(CODEX_CLI_CHANNELS.chat);
      options.ipcMain.removeHandler?.(CODEX_CLI_CHANNELS.cancel);
      await options.service.dispose();
    },
  };
}
