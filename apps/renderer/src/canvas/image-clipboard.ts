import type { ProjectImageAssetSummary } from '@agent-canvas/desktop-core';
import { readImageSourceBlob } from '../app/image-source-blob';
import { renderImageColorCorrectionBlob, type ImageColorCorrection } from '../app/image-color-correction';
export async function copyProjectImageToClipboard(asset: ProjectImageAssetSummary, colorCorrection?: ImageColorCorrection): Promise<boolean> {
  try {
    const blob = colorCorrection === undefined
      ? await readImageSourceBlob(asset.displayUrl)
      : await renderImageColorCorrectionBlob(asset.displayUrl, colorCorrection);
    const nativeWrite = globalThis.window?.novusDesktop?.projectImages.writeClipboardImage;
    if (nativeWrite) {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (await nativeWrite(bytes)) return true;
    }
    if (typeof ClipboardItem !== 'undefined' && globalThis.navigator?.clipboard?.write) {
      const mediaType = blob.type || asset.mediaType;
      await globalThis.navigator.clipboard.write([new ClipboardItem({ [mediaType]: blob })]);
      return true;
    }
  } catch {
    // The caller presents one consistent, sanitized failure state.
  }
  return false;
}
