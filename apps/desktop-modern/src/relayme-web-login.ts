import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron';

import { createProviderBridgeError } from '@agent-canvas/desktop-core';

const RELAYME_ORIGIN = 'https://www.ml.relayme.uk';
const RELAYME_LOGIN_URL = 'https://www.ml.relayme.uk/';
const TOKEN_EXPRESSION = "globalThis.localStorage.getItem('user_token')";
const MAX_TOKEN_LENGTH = 16_384;
const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_TIMEOUT_MS = 5 * 60_000;

interface LoginWebContents {
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
  getURL(): string;
  isDestroyed(): boolean;
  setWindowOpenHandler(handler: () => { action: 'deny' }): void;
  on(event: string, listener: (...args: any[]) => void): this | void;
  removeListener(event: string, listener: (...args: any[]) => void): this | void;
}

interface LoginBrowserWindow {
  readonly webContents: LoginWebContents;
  destroy(): void;
  isDestroyed(): boolean;
  loadURL(url: string): Promise<void>;
  on(event: string, listener: (...args: any[]) => void): this | void;
  removeListener(event: string, listener: (...args: any[]) => void): this | void;
}

interface LoginBrowserWindowConstructor {
  new(options: BrowserWindowConstructorOptions): LoginBrowserWindow;
}

interface LoginSession {
  clearStorageData(options: { origin: string; storages: string[] }): Promise<void>;
  setProxy(config: { mode: 'system' }): Promise<void>;
}

export interface AcquireRelayMeWebTokenOptions {
  readonly BrowserWindow: LoginBrowserWindowConstructor;
  readonly parent: BrowserWindow | null;
  readonly session: LoginSession;
  readonly pollIntervalMs?: number;
  readonly timeoutMs?: number;
}

export async function acquireRelayMeWebToken(
  options: AcquireRelayMeWebTokenOptions,
): Promise<string> {
  await options.session.setProxy({ mode: 'system' });
  await options.session.clearStorageData({
    origin: RELAYME_ORIGIN,
    storages: ['localstorage'],
  });

  return new Promise<string>((resolve, reject) => {
    const authWindow = new options.BrowserWindow({
      width: 1080,
      height: 760,
      minWidth: 820,
      minHeight: 620,
      modal: options.parent !== null,
      ...(options.parent === null ? {} : { parent: options.parent }),
      show: true,
      autoHideMenuBar: true,
      title: '登录 RelayMe',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        partition: 'persist:relayme-web-login',
        sandbox: true,
      },
    });
    const authContents = authWindow.webContents;
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let settled = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let polling = false;

    const cleanup = () => {
      if (pollTimer !== null) clearInterval(pollTimer);
      clearTimeout(timeoutTimer);
      authWindow.removeListener('closed', onClosed);
      authContents.removeListener('did-finish-load', onDidFinishLoad);
      authContents.removeListener('did-fail-load', onDidFailLoad);
      authContents.removeListener('will-navigate', onWillNavigate);
    };
    const finish = (result: { token: string } | { error: Error }) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (!authWindow.isDestroyed()) authWindow.destroy();
      if ('token' in result) resolve(result.token);
      else reject(result.error);
    };
    const onClosed = () => finish({
      error: createProviderBridgeError('WEB_LOGIN_CANCELLED', 'RelayMe 网页登录已取消', true),
    });
    const onDidFailLoad = (_event?: unknown, errorCode?: number) => {
      if (errorCode === -3) return;
      finish({
        error: createProviderBridgeError(
          'PROVIDER_UNAVAILABLE',
          'RelayMe 网页登录服务暂时不可用，请稍后重试',
          true,
        ),
      });
    };
    const onWillNavigate = (event: { preventDefault(): void }, url: string) => {
      if (!isOfficialRelayMeUrl(url)) event.preventDefault();
    };
    const pollToken = async () => {
      if (settled || polling || authContents.isDestroyed()) return;
      if (!isOfficialRelayMeUrl(authContents.getURL())) return;
      polling = true;
      try {
        const value = await authContents.executeJavaScript(TOKEN_EXPRESSION, true);
        const token = parseWebToken(value);
        if (token !== null) finish({ token });
      } catch {
        // The page may navigate while polling; the next official-origin load retries.
      } finally {
        polling = false;
      }
    };
    const onDidFinishLoad = () => {
      void pollToken();
      if (pollTimer === null) pollTimer = setInterval(() => { void pollToken(); }, pollIntervalMs);
    };
    const timeoutTimer = setTimeout(() => finish({
      error: createProviderBridgeError('WEB_LOGIN_TIMEOUT', 'RelayMe 网页登录超时，请重试', true),
    }), timeoutMs);

    authContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    authWindow.on('closed', onClosed);
    authContents.on('did-finish-load', onDidFinishLoad);
    authContents.on('did-fail-load', onDidFailLoad);
    authContents.on('will-navigate', onWillNavigate);
    // did-fail-load carries the Electron error code. loadURL also rejects when
    // the user closes the window, but that rejection loses ERR_ABORTED (-3).
    void authWindow.loadURL(RELAYME_LOGIN_URL).catch(() => undefined);
  });
}

function isOfficialRelayMeUrl(value: string): boolean {
  try {
    return new URL(value).origin === RELAYME_ORIGIN;
  } catch {
    return false;
  }
}

function parseWebToken(value: unknown): string | null {
  if (typeof value !== 'string'
    || value.length === 0
    || value.length > MAX_TOKEN_LENGTH
    || value.trim() !== value) return null;
  return value;
}
