import { applyImageColorCorrectionToPixels, type ImageColorCorrection } from './image-color-correction';

type CorrectionRequest = { source: Blob; correction: ImageColorCorrection };

globalThis.addEventListener('message', async (event: MessageEvent<CorrectionRequest>) => {
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(event.data.source);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (context === null) throw new Error('Image color correction canvas is unavailable');
    context.drawImage(bitmap, 0, 0);
    const image = context.getImageData(0, 0, bitmap.width, bitmap.height);
    image.data.set(applyImageColorCorrectionToPixels(image.data, event.data.correction));
    context.putImageData(image, 0, 0);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    globalThis.postMessage({ ok: true, blob });
  } catch {
    globalThis.postMessage({ ok: false });
  } finally {
    bitmap?.close();
  }
});
