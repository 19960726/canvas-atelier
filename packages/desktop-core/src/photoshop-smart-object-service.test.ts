import { describe, expect, it, vi } from 'vitest';
import { PhotoshopSmartObjectService } from './photoshop-smart-object-service.js';

describe('PhotoshopSmartObjectService', () => {
  it('resolves a managed original and imports it once', async () => {
    const place = vi.fn().mockResolvedValue({ ok: true, layerName: 'Nano Banana 2' });
    const resolve = vi.fn().mockResolvedValue({
      absolutePath: 'E:/managed/0123456789abcdef.png',
      label: 'Nano Banana 2',
      mediaType: 'image/png',
    });
    const service = new PhotoshopSmartObjectService({ resolve }, { place });

    await expect(service.import({ sessionId: 'session-1', assetId: '0123456789abcdef' }))
      .resolves.toEqual({ ok: true, layerName: 'Nano Banana 2' });
    expect(resolve).toHaveBeenCalledWith({ sessionId: 'session-1', assetId: '0123456789abcdef' });
    expect(place).toHaveBeenCalledTimes(1);
  });

  it('returns import_busy for a duplicate in-flight request', async () => {
    let finish: (() => void) | undefined;
    const place = vi.fn(() => new Promise<{ ok: true; layerName: string }>((resolve) => {
      finish = () => resolve({ ok: true, layerName: 'Layer' });
    }));
    const service = new PhotoshopSmartObjectService({
      resolve: vi.fn().mockResolvedValue({
        absolutePath: 'E:/managed/a.png',
        label: 'Layer',
        mediaType: 'image/png',
      }),
    }, { place });

    const first = service.import({ sessionId: 'session-1', assetId: '0123456789abcdef' });
    await expect(service.import({ sessionId: 'session-1', assetId: '0123456789abcdef' }))
      .resolves.toEqual({ ok: false, code: 'import_busy' });
    finish?.();
    await first;
  });

  it('rejects missing and non-image assets without invoking Photoshop', async () => {
    const place = vi.fn();
    const missing = new PhotoshopSmartObjectService({ resolve: vi.fn().mockResolvedValue(null) }, { place });
    await expect(missing.import({ sessionId: 'session-1', assetId: '0123456789abcdef' }))
      .resolves.toEqual({ ok: false, code: 'asset_not_found' });

    const video = new PhotoshopSmartObjectService({
      resolve: vi.fn().mockResolvedValue({ absolutePath: 'E:/managed/a.mp4', label: 'Video', mediaType: 'video/mp4' }),
    }, { place });
    await expect(video.import({ sessionId: 'session-1', assetId: '0123456789abcdef' }))
      .resolves.toEqual({ ok: false, code: 'unsupported_media' });
    expect(place).not.toHaveBeenCalled();
  });

  it('sanitizes the Photoshop layer name and releases the lock after failure', async () => {
    const place = vi.fn()
      .mockRejectedValueOnce(new Error('automation failed'))
      .mockResolvedValueOnce({ ok: true, layerName: 'Generated Layer' });
    const service = new PhotoshopSmartObjectService({
      resolve: vi.fn().mockResolvedValue({
        absolutePath: 'E:/managed/a.png',
        label: 'Generated\n\u0000Layer',
        mediaType: 'image/png',
      }),
    }, { place });
    const request = { sessionId: 'session-1', assetId: '0123456789abcdef' };

    await expect(service.import(request)).resolves.toEqual({ ok: false, code: 'placement_failed' });
    await expect(service.import(request)).resolves.toEqual({ ok: true, layerName: 'Generated Layer' });
    expect(place).toHaveBeenLastCalledWith({
      absolutePath: 'E:/managed/a.png',
      layerName: 'Generated Layer',
    });
  });
});
