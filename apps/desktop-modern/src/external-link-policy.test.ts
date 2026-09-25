import { describe, expect, it, vi } from 'vitest';

import { installExternalLinkPolicy } from './external-link-policy.js';

describe('main window external link policy', () => {
  it('opens http and https links in the system browser while denying an Electron child window', async () => {
    const setWindowOpenHandler = vi.fn();
    const openExternal = vi.fn(async () => undefined);

    installExternalLinkPolicy({ setWindowOpenHandler }, openExternal);

    const handler = setWindowOpenHandler.mock.calls[0]?.[0];
    expect(handler).toBeTypeOf('function');
    expect(handler?.({ url: 'https://www.ml.relayme.uk/' })).toEqual({ action: 'deny' });
    expect(handler?.({ url: 'http://example.test/provider-help' })).toEqual({ action: 'deny' });
    await Promise.resolve();

    expect(openExternal).toHaveBeenNthCalledWith(1, 'https://www.ml.relayme.uk/');
    expect(openExternal).toHaveBeenNthCalledWith(2, 'http://example.test/provider-help');
  });

  it('denies non-web and invalid URLs without sending them to the system browser', async () => {
    const setWindowOpenHandler = vi.fn();
    const openExternal = vi.fn(async () => undefined);

    installExternalLinkPolicy({ setWindowOpenHandler }, openExternal);

    const handler = setWindowOpenHandler.mock.calls[0]?.[0];
    for (const url of [
      'javascript:alert(1)',
      'file:///C:/Windows/System32/calc.exe',
      'data:text/html,unsafe',
      'not a URL',
    ]) {
      expect(handler?.({ url })).toEqual({ action: 'deny' });
    }
    await Promise.resolve();

    expect(openExternal).not.toHaveBeenCalled();
  });

  it('keeps the main-window handler stable when the system browser rejects a link', async () => {
    const setWindowOpenHandler = vi.fn();
    const openExternal = vi.fn(async () => { throw new Error('browser unavailable'); });

    installExternalLinkPolicy({ setWindowOpenHandler }, openExternal);

    const handler = setWindowOpenHandler.mock.calls[0]?.[0];
    expect(handler?.({ url: 'https://julun.cc/' })).toEqual({ action: 'deny' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(openExternal).toHaveBeenCalledOnce();
  });
});
