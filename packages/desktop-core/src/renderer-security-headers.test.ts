import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

describe('renderer security headers', () => {
  it('moves frame-ancestors out of the meta policy and installs it as an Electron response header', async () => {
    const helperPath = join(process.cwd(), 'packages/desktop-core/src/renderer-security-headers.ts');
    const helperExists = await fileExists(helperPath);

    expect(helperExists).toBe(true);
    if (!helperExists) return;

    const helper = await import(pathToFileURL(helperPath).href) as {
      FRAME_ANCESTORS_POLICY?: string;
      installRendererSecurityHeaders?: (electronSession: {
        webRequest: {
          onHeadersReceived(
            filter: { urls: readonly string[] },
            listener: (
              details: {
                resourceType: string;
                responseHeaders?: Record<string, string[]>;
              },
              callback: (response: { responseHeaders?: Record<string, string[]> }) => void,
            ) => void,
          ): void;
        };
      }) => void;
    };
    expect(helper.FRAME_ANCESTORS_POLICY).toBe("frame-ancestors 'none'");
    expect(helper.installRendererSecurityHeaders).toBeTypeOf('function');

    let listener: ((
      details: { resourceType: string; responseHeaders?: Record<string, string[]> },
      callback: (response: { responseHeaders?: Record<string, string[]> }) => void,
    ) => void) | undefined;
    const onHeadersReceived = vi.fn((
      _filter: { urls: readonly string[] },
      next: typeof listener,
    ) => {
      listener = next;
    });
    helper.installRendererSecurityHeaders?.({ webRequest: { onHeadersReceived } });

    expect(onHeadersReceived).toHaveBeenCalledWith(
      { urls: ['file://*/*'] },
      expect.any(Function),
    );
    expect(listener).toBeTypeOf('function');

    const documentCallback = vi.fn();
    listener?.({
      resourceType: 'mainFrame',
      responseHeaders: { 'content-security-policy': ["default-src 'self'"] },
    }, documentCallback);
    expect(documentCallback).toHaveBeenCalledWith({
      responseHeaders: {
        'content-security-policy': ["default-src 'self'", "frame-ancestors 'none'"],
      },
    });

    const assetHeaders = { 'Content-Type': ['image/png'] };
    const assetCallback = vi.fn();
    listener?.({ resourceType: 'image', responseHeaders: assetHeaders }, assetCallback);
    expect(assetCallback).toHaveBeenCalledWith({ responseHeaders: assetHeaders });

    const rendererHtml = await readFile(join(process.cwd(), 'apps/renderer/index.html'), 'utf8');
    expect(rendererHtml).toMatch(/Content-Security-Policy/i);
    expect(rendererHtml).not.toMatch(/frame-ancestors/i);

    for (const mainPath of [
      join(process.cwd(), 'apps/desktop-modern/src/main.ts'),
      join(process.cwd(), 'apps/desktop-legacy/src/main.ts'),
    ]) {
      const mainSource = await readFile(mainPath, 'utf8');
      expect(mainSource).toContain('installRendererSecurityHeaders(session.defaultSession)');
    }
  });

  it('adds a conjunctive none policy when an existing frame-ancestors directive is weaker', async () => {
    const listener = await loadHeadersReceivedListener();
    const callback = vi.fn();

    listener({
      resourceType: 'mainFrame',
      responseHeaders: {
        'Content-Security-Policy': ["default-src 'self'; frame-ancestors 'self'"],
      },
    }, callback);

    expect(callback).toHaveBeenCalledWith({
      responseHeaders: {
        'Content-Security-Policy': [
          "default-src 'self'; frame-ancestors 'self'",
          "frame-ancestors 'none'",
        ],
      },
    });
  });

  it('recognizes an effective mixed-case frame-ancestors none directive without duplicating it', async () => {
    const listener = await loadHeadersReceivedListener();
    const callback = vi.fn();

    listener({
      resourceType: 'subFrame',
      responseHeaders: {
        'CONTENT-SECURITY-POLICY': ["default-src 'self'; FrAmE-AnCeStOrS 'NoNe'"],
      },
    }, callback);

    expect(callback).toHaveBeenCalledWith({
      responseHeaders: {
        'CONTENT-SECURITY-POLICY': ["default-src 'self'; FrAmE-AnCeStOrS 'NoNe'"],
      },
    });
  });

  it('strengthens multi-policy headers unless one effective policy already enforces none', async () => {
    const listener = await loadHeadersReceivedListener();
    const weakCallback = vi.fn();
    listener({
      resourceType: 'mainFrame',
      responseHeaders: {
        'Content-Security-Policy': [
          "default-src 'self'; frame-ancestors *",
          "script-src 'self'",
        ],
      },
    }, weakCallback);
    expect(weakCallback).toHaveBeenCalledWith({
      responseHeaders: {
        'Content-Security-Policy': [
          "default-src 'self'; frame-ancestors *",
          "script-src 'self'",
          "frame-ancestors 'none'",
        ],
      },
    });

    const enforcedCallback = vi.fn();
    listener({
      resourceType: 'mainFrame',
      responseHeaders: {
        'Content-Security-Policy': [
          "default-src 'self'; frame-ancestors *",
          "FRAME-ANCESTORS 'NONE'",
        ],
      },
    }, enforcedCallback);
    expect(enforcedCallback).toHaveBeenCalledWith({
      responseHeaders: {
        'Content-Security-Policy': [
          "default-src 'self'; frame-ancestors *",
          "FRAME-ANCESTORS 'NONE'",
        ],
      },
    });
  });
});

type HeadersReceivedListener = (
  details: { resourceType: string; responseHeaders?: Record<string, string[]> },
  callback: (response: { responseHeaders?: Record<string, string[]> }) => void,
) => void;

async function loadHeadersReceivedListener(): Promise<HeadersReceivedListener> {
  const helperPath = join(process.cwd(), 'packages/desktop-core/src/renderer-security-headers.ts');
  const helper = await import(pathToFileURL(helperPath).href) as {
    installRendererSecurityHeaders: (electronSession: {
      webRequest: {
        onHeadersReceived(
          filter: { urls: readonly string[] },
          listener: HeadersReceivedListener,
        ): void;
      };
    }) => void;
  };
  let listener: HeadersReceivedListener | undefined;
  helper.installRendererSecurityHeaders({
    webRequest: {
      onHeadersReceived(_filter, next) {
        listener = next;
      },
    },
  });
  expect(listener).toBeTypeOf('function');
  return listener!;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
