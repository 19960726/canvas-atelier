import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { acquireRelayMeWebToken } from './relayme-web-login.js';

const OFFICIAL_ORIGIN = 'https://www.ml.relayme.uk';
const LOGIN_URL = `${OFFICIAL_ORIGIN}/`;

class FakeWebContents extends EventEmitter {
  currentUrl = LOGIN_URL;
  readonly executeJavaScript = vi.fn<() => Promise<unknown>>(async () => null);
  readonly setWindowOpenHandler = vi.fn();

  getURL(): string {
    return this.currentUrl;
  }

  isDestroyed(): boolean {
    return false;
  }
}

class FakeBrowserWindow extends EventEmitter {
  static instances: FakeBrowserWindow[] = [];
  readonly contents = new FakeWebContents();
  readonly loadURL = vi.fn(async () => undefined);
  readonly destroy = vi.fn(() => {
    this.destroyed = true;
  });
  destroyed = false;

  get webContents(): FakeWebContents {
    if (this.destroyed) throw new Error('Object has been destroyed');
    return this.contents;
  }

  constructor(readonly options: Record<string, unknown>) {
    super();
    FakeBrowserWindow.instances.push(this);
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  closeFromUser(): void {
    this.destroyed = true;
    this.emit('closed');
  }
}

function createHarness(overrides: Record<string, unknown> = {}) {
  FakeBrowserWindow.instances = [];
  const loginSession = {
    clearStorageData: vi.fn(async () => undefined),
    setProxy: vi.fn(async () => undefined),
  };
  const parent = { id: 'canvas-main-window' };
  const promise = acquireRelayMeWebToken({
    BrowserWindow: FakeBrowserWindow as never,
    parent: parent as never,
    session: loginSession as never,
    pollIntervalMs: 10,
    timeoutMs: 100,
    ...overrides,
  });
  return { loginSession, parent, promise };
}

async function getCreatedWindow(): Promise<FakeBrowserWindow> {
  await vi.waitFor(() => expect(FakeBrowserWindow.instances).toHaveLength(1));
  return FakeBrowserWindow.instances[0]!;
}

describe('RelayMe official web login', () => {
  it('uses an isolated secure modal window and prepares only the official localStorage on direct network', async () => {
    const { loginSession, parent, promise } = createHarness();
    const window = await getCreatedWindow();

    expect(loginSession.setProxy).toHaveBeenCalledWith({ mode: 'direct' });
    expect(loginSession.clearStorageData).toHaveBeenCalledWith({
      origin: OFFICIAL_ORIGIN,
      storages: ['localstorage'],
    });
    expect(loginSession.setProxy.mock.invocationCallOrder[0]!).toBeLessThan(window.loadURL.mock.invocationCallOrder[0]!);
    expect(loginSession.clearStorageData.mock.invocationCallOrder[0]!).toBeLessThan(window.loadURL.mock.invocationCallOrder[0]!);
    expect(window.options).toMatchObject({
      modal: true,
      parent,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        partition: 'persist:relayme-web-login',
        sandbox: true,
      },
    });
    expect((window.options.webPreferences as Record<string, unknown>).preload).toBeUndefined();
    expect(window.loadURL).toHaveBeenCalledWith(LOGIN_URL);

    window.closeFromUser();
    await expect(promise).rejects.toMatchObject({ code: 'WEB_LOGIN_CANCELLED', retryable: true });
  });

  it('denies popups and blocks navigation outside the official origin', async () => {
    const { promise } = createHarness();
    const window = await getCreatedWindow();
    const handler = window.webContents.setWindowOpenHandler.mock.calls[0]?.[0] as () => unknown;
    const event = { preventDefault: vi.fn() };

    expect(handler()).toEqual({ action: 'deny' });
    window.webContents.emit('will-navigate', event, 'https://example.com/steal');
    expect(event.preventDefault).toHaveBeenCalledOnce();
    window.webContents.emit('will-navigate', event, `${OFFICIAL_ORIGIN}/workflow/123`);
    expect(event.preventDefault).toHaveBeenCalledOnce();

    window.closeFromUser();
    await expect(promise).rejects.toMatchObject({ code: 'WEB_LOGIN_CANCELLED' });
  });

  it('polls only the fixed user_token expression on official-origin content and returns the bounded token', async () => {
    vi.useFakeTimers();
    try {
      const { promise } = createHarness();
      const window = await getCreatedWindow();
      window.webContents.executeJavaScript.mockResolvedValueOnce('opaque-official-token');

      window.webContents.emit('did-finish-load');
      await vi.advanceTimersByTimeAsync(1);

      await expect(promise).resolves.toBe('opaque-official-token');
      expect(window.contents.executeJavaScript).toHaveBeenCalledWith(
        "globalThis.localStorage.getItem('user_token')",
        true,
      );
      expect(window.destroy).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not read token data while the current page is invalid or off-origin', async () => {
    vi.useFakeTimers();
    try {
      const { promise } = createHarness();
      const window = await getCreatedWindow();
      window.webContents.currentUrl = 'not a url';
      window.webContents.emit('did-finish-load');
      await vi.advanceTimersByTimeAsync(20);
      window.webContents.currentUrl = 'https://example.com/';
      await vi.advanceTimersByTimeAsync(20);

      expect(window.webContents.executeJavaScript).not.toHaveBeenCalled();
      window.closeFromUser();
      await expect(promise).rejects.toMatchObject({ code: 'WEB_LOGIN_CANCELLED' });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['surrounding whitespace', ' token '],
    ['empty string', ''],
    ['oversized token', 'x'.repeat(16_385)],
    ['non-string storage value', { token: 'protected' }],
  ])('ignores %s without exposing storage data', async (_label, invalidToken) => {
    vi.useFakeTimers();
    try {
      const { promise } = createHarness();
      const window = await getCreatedWindow();
      window.webContents.executeJavaScript
        .mockResolvedValueOnce(invalidToken)
        .mockResolvedValueOnce('valid-token');
      window.webContents.emit('did-finish-load');
      await vi.advanceTimersByTimeAsync(20);

      await expect(promise).resolves.toBe('valid-token');
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns distinct sanitized timeout and load errors and cleans up the window', async () => {
    vi.useFakeTimers();
    try {
      const timeoutHarness = createHarness({ timeoutMs: 25 });
      const timeoutWindow = await getCreatedWindow();
      const timeoutExpectation = expect(timeoutHarness.promise).rejects.toMatchObject({
        code: 'WEB_LOGIN_TIMEOUT',
        message: 'RelayMe 网页登录超时，请重试',
        retryable: true,
      });
      await vi.advanceTimersByTimeAsync(25);
      await timeoutExpectation;
      expect(timeoutWindow.destroy).toHaveBeenCalledOnce();

      const loadHarness = createHarness();
      const loadWindow = await getCreatedWindow();
      const loadExpectation = expect(loadHarness.promise).rejects.toMatchObject({
        code: 'PROVIDER_UNAVAILABLE',
        message: 'RelayMe 网页登录服务暂时不可用，请稍后重试',
        retryable: true,
      });
      loadWindow.webContents.emit('did-fail-load', {}, -105, 'host secret', 'https://example.com/private');
      await loadExpectation;
      expect(loadWindow.destroy).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats an aborted load followed by window close as user cancellation', async () => {
    const { promise } = createHarness();
    const window = await getCreatedWindow();

    window.contents.emit('did-fail-load', {}, -3, 'ERR_ABORTED', LOGIN_URL, true);
    window.closeFromUser();

    await expect(promise).rejects.toMatchObject({ code: 'WEB_LOGIN_CANCELLED' });
  });

  it('cleans up listeners after success so later page events cannot change the result', async () => {
    const { promise } = createHarness();
    const window = await getCreatedWindow();
    window.webContents.executeJavaScript.mockResolvedValue('stable-token');
    window.webContents.emit('did-finish-load');
    await expect(promise).resolves.toBe('stable-token');

    expect(window.listenerCount('closed')).toBe(0);
    expect(window.contents.listenerCount('did-finish-load')).toBe(0);
    expect(window.contents.listenerCount('did-fail-load')).toBe(0);
    expect(window.contents.listenerCount('will-navigate')).toBe(0);
  });
});
