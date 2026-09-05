import { describe, expect, it, vi } from 'vitest';

import { CODEX_CLI_CHANNELS, CODEX_ASTRA_PROFILE, registerCodexCliIpc } from './codex-cli-ipc';

describe('Codex CLI IPC', () => {
  it('keeps the bridge on independent channels and authorizes the renderer', async () => {
    const listeners = new Map<string, (event: unknown, payload?: unknown) => Promise<unknown>>();
    const ipcMain = {
      handle: vi.fn((channel: string, listener: (event: unknown, payload?: unknown) => Promise<unknown>) => listeners.set(channel, listener)),
      removeHandler: vi.fn((channel: string) => listeners.delete(channel)),
    };
    const trustedSender = { id: 'renderer' };
    const service = {
      listProfiles: vi.fn(async () => [CODEX_ASTRA_PROFILE]),
      chat: vi.fn(async () => ({ message: 'ok', modelRoute: CODEX_ASTRA_PROFILE.modelRoute, sources: [] })),
      cancel: vi.fn(async () => ({ cancelled: true })),
      dispose: vi.fn(async () => undefined),
    };
    const registration = registerCodexCliIpc({ ipcMain, service, getTrustedSender: () => trustedSender });

    await expect(listeners.get(CODEX_CLI_CHANNELS.listProfiles)?.({ sender: {} })).rejects.toThrow('CODEX_CLI_UNTRUSTED_SENDER');
    await expect(listeners.get(CODEX_CLI_CHANNELS.listProfiles)?.({ sender: trustedSender })).resolves.toEqual([CODEX_ASTRA_PROFILE]);
    await expect(listeners.get(CODEX_CLI_CHANNELS.cancel)?.({ sender: trustedSender }, { requestId: 'request-astra-1' }))
      .resolves.toEqual({ ok: true, value: { cancelled: true } });
    expect(CODEX_CLI_CHANNELS.chat).not.toMatch(/provider/iu);

    await registration.dispose();
    expect(service.dispose).toHaveBeenCalledOnce();
    expect(ipcMain.removeHandler).toHaveBeenCalledWith(CODEX_CLI_CHANNELS.chat);
    expect(ipcMain.removeHandler).toHaveBeenCalledWith(CODEX_CLI_CHANNELS.cancel);
  });
});
