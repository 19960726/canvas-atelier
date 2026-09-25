export interface ExternalLinkWebContents {
  setWindowOpenHandler(handler: (details: { readonly url: string }) => { readonly action: 'deny' }): void;
}

export type OpenExternal = (url: string) => Promise<void>;

export function installExternalLinkPolicy(
  webContents: ExternalLinkWebContents,
  openExternal: OpenExternal,
): void {
  webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalWebUrl(url)) {
      void openExternal(url).catch(() => undefined);
    }
    return { action: 'deny' };
  });
}

function isExternalWebUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}
