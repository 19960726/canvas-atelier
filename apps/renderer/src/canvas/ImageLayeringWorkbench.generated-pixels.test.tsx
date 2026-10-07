import { Blob as NodeBlob } from 'node:buffer';
import { createHash } from 'node:crypto';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readPsd } from 'ag-psd';
import { createCanvasModuleNode } from '@agent-canvas/domain';
import { ImageLayeringWorkbench } from './ImageLayeringWorkbench';
import { fixturePng } from '../test/rgba-png-fixture';

interface Raster { width: number; height: number; pixels: Uint8Array }
const rasters = new Map<string, Raster>();
let previousDesktop: typeof window.novusDesktop;
const drawImage = vi.fn();

function pngAsset(assetId: string, pixels: Uint8Array, width: number, height: number) {
  const displayUrl = fixturePng(pixels, width, height);
  rasters.set(displayUrl, { width, height, pixels });
  const sha256 = createHash('sha256').update(Buffer.from(displayUrl.split(',')[1]!, 'base64')).digest('hex');
  return { assetId, mediaType: 'image/png' as const, displayUrl, width, height, sha256 };
}

function solid(width: number, height: number, rgba: readonly number[]) {
  return Uint8Array.from(Array.from({ length: width * height }, () => rgba).flat());
}

function generatedFixture(width: number, height: number, foreground: Uint8Array) {
  const assets = [pngAsset('a'.repeat(16), solid(width, height, [20, 30, 40, 255]), width, height),
    pngAsset('b'.repeat(16), foreground, width, height)];
  const plans = [{ layerId: 'background', kind: 'background' as const, name: 'Background', order: 0 },
    { layerId: 'foreground', kind: 'transparent' as const, name: 'Foreground', order: 1 }];
  const nodes = plans.map((plan, index) => {
    const node = createCanvasModuleNode(`generated-node-${index}`, 'image_layer', { x: 0, y: 0 });
    node.data.config = { ...node.data.config, ...plan, layerKind: plan.kind, groupId: 'generated-pixel-regression',
      resultAssetId: assets[index]!.assetId, resultWidth: width, resultHeight: height, pixelMode: 'generated',
      qualityStatus: 'passed', formatQualityStatus: 'passed', qualityFormatCheckedAssetId: assets[index]!.assetId,
      qualityValidationVersion: 2, status: 'completed', visible: true };
    return node;
  });
  const config = { canvasWidth: width, canvasHeight: height, groupId: 'generated-pixel-regression', pixelMode: 'generated',
    planLayers: plans, layers: [], layerSelection: { mode: 'whole' } };
  return { assets, nodes, config };
}

function mountExport(fixture: ReturnType<typeof generatedFixture>, extra: Record<string, unknown> = {}) {
  const open = vi.fn(async (_bytes: Uint8Array) => ({ ok: true as const }));
  Object.defineProperty(window, 'novusDesktop', { configurable: true,
    value: { projectImages: { openLayeredPsdInPhotoshop: open } } });
  render(<ImageLayeringWorkbench config={{ ...fixture.config, ...extra }}
    assets={fixture.assets} layerNodes={fixture.nodes} onLayersChange={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: '\u5728 Photoshop \u4e2d\u6253\u5f00' }));
  return open;
}

async function decodedExport(fixture: ReturnType<typeof generatedFixture>, extra: Record<string, unknown> = {}) {
  const open = mountExport(fixture, extra);
  await waitFor(() => expect(open).toHaveBeenCalledOnce());
  return readPsd(open.mock.calls[0]![0]!, { useImageData: true });
}

beforeEach(() => {
  rasters.clear(); drawImage.mockClear(); previousDesktop = window.novusDesktop;
  vi.stubGlobal('Blob', NodeBlob);
  vi.stubGlobal('Worker', undefined);
  class RasterImage {
    naturalWidth = 0; naturalHeight = 0; crossOrigin = ''; private url = '';
    set src(value: string) {
      this.url = value;
      const raster = rasters.get(value);
      this.naturalWidth = raster?.width ?? 0; this.naturalHeight = raster?.height ?? 0;
    }
    get src() { return this.url; }
    async decode() { if (!rasters.has(this.url)) throw new Error('Unknown test image'); }
  }
  vi.stubGlobal('Image', RasterImage);
  // Model the existing 8-bit Canvas premultiplication boundary. The independent
  // PNG oracle and PSD readback below do not use this quantized readback.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function(this: HTMLCanvasElement) {
    let raster: Raster | undefined;
    return {
      imageSmoothingEnabled: true, imageSmoothingQuality: 'high',
      createImageData: (width: number, height: number) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }),
      putImageData: () => {},
      drawImage: (image: RasterImage) => { drawImage(image.src); raster = rasters.get(image.src); },
      getImageData: () => {
        const data = new Uint8ClampedArray(this.width * this.height * 4);
        if (!raster) return { data };
        for (let y = 0; y < this.height; y++) for (let x = 0; x < this.width; x++) {
          const sx = Math.min(raster.width - 1, Math.floor(x * raster.width / this.width));
          const sy = Math.min(raster.height - 1, Math.floor(y * raster.height / this.height));
          const source = (sy * raster.width + sx) * 4, target = (y * this.width + x) * 4;
          const alpha = raster.pixels[source + 3]!;
          data[target + 3] = alpha;
          for (let channel = 0; channel < 3; channel++) {
            data[target + channel] = alpha ? Math.round(Math.round(raster.pixels[source + channel]! * alpha / 255) * 255 / alpha) : 0;
          }
        }
        return { data };
      },
    } as never;
  });
});
afterEach(() => {
  cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals();
  Object.defineProperty(window, 'novusDesktop', { configurable: true, value: previousDesktop });
});

describe('generated image layering PSD preserves independent PNG pixels', () => {
  const pixels = Uint8Array.from([37, 83, 129, 32, 100, 150, 200, 64, 37, 83, 129, 255,
    37, 83, 129, 1, 255, 127, 63, 128, 37, 83, 129, 0]);

  it('preserves low-alpha and alpha-zero RGB in an actual generated UI PSD export', async () => {
    const psd = await decodedExport(generatedFixture(3, 2, pixels));
    expect([psd.width, psd.height]).toEqual([3, 2]);
    const foreground = psd.children!.find(layer => layer.name === 'Foreground')!;
    expect([foreground.left, foreground.top, foreground.right, foreground.bottom]).toEqual([0, 0, 3, 2]);
    expect([...foreground.imageData!.data]).toEqual([...pixels]);
    expect(drawImage).not.toHaveBeenCalled();
  });

  it('preserves a reviewed local RGBA replacement while its legacy group remains generated', async () => {
    const fixture = generatedFixture(3, 2, pixels);
    const source = pngAsset('c'.repeat(16), solid(3, 2, [90, 80, 70, 255]), 3, 2);
    const result = fixture.assets[1]!;
    fixture.assets.push(source);
    fixture.nodes[1]!.data.config = { ...fixture.nodes[1]!.data.config, pixelMode: 'source', pixelColorSpace: 'foreground',
      sourceAssetId: source.assetId, canvasWidth: 3, canvasHeight: 2,
      resultRepresentation: 'independent-rgba-candidate', semanticReviewAccepted: true,
      foregroundProvenance: { kind: 'local-rgba-import', version: 1, assetId: result.assetId, sha256: result.sha256,
        sourceAssetId: source.assetId, sourceSha256: source.sha256, width: 3, height: 2 } };
    const psd = await decodedExport(fixture, { sourceAssetId: source.assetId });
    expect([...psd.children![1]!.imageData!.data]).toEqual([...pixels]);
    expect(fixture.config.pixelMode).toBe('generated');
  });

  it('clips a regional generated export while retaining selected low-alpha pixels and the outside source', async () => {
    const foreground = solid(4, 4, [37, 83, 129, 32]);
    foreground[3] = 0;
    foreground.set([37, 83, 129, 1], 5 * 4);
    foreground.set([100, 150, 200, 64], 6 * 4);
    foreground.set([255, 127, 63, 128], 9 * 4);
    foreground.set([37, 83, 129, 255], 10 * 4);
    const fixture = generatedFixture(4, 4, foreground);
    const source = pngAsset('c'.repeat(16), solid(4, 4, [90, 80, 70, 255]), 4, 4);
    fixture.assets.push(source);
    const psd = await decodedExport(fixture, { sourceAssetId: source.assetId,
      layerSelection: { mode: 'region', box: { x: .25, y: .25, width: .5, height: .5 } } });
    const selected = new Set([5, 6, 9, 10]);
    const expectedForeground = foreground.slice(), expectedBackground = solid(4, 4, [20, 30, 40, 255]);
    for (let pixel = 0; pixel < 16; pixel++) if (!selected.has(pixel)) {
      expectedForeground.fill(0, pixel * 4, pixel * 4 + 4);
      expectedBackground.set([90, 80, 70, 255], pixel * 4);
    }
    expect([psd.children![1]!.left, psd.children![1]!.top, psd.children![1]!.right, psd.children![1]!.bottom]).toEqual([0, 0, 4, 4]);
    expect([...psd.children![1]!.imageData!.data]).toEqual([...expectedForeground]);
    expect([...psd.children![0]!.imageData!.data]).toEqual([...expectedBackground]);
  });

  it('retains compatible higher-resolution generated pixels at their native PSD dimensions', async () => {
    const foreground = solid(6, 4, [37, 83, 129, 32]);
    foreground.set([37, 83, 129, 0], 5 * 4);
    foreground.set([37, 83, 129, 1], 6 * 4);
    const psd = await decodedExport(generatedFixture(6, 4, foreground), { canvasWidth: 3, canvasHeight: 2 });
    expect([psd.width, psd.height]).toEqual([6, 4]);
    expect([...psd.children![1]!.imageData!.data]).toEqual([...foreground]);
  });

  it('rescales a smaller compatible PNG without losing its low-alpha independent RGB', async () => {
    const fixture = generatedFixture(3, 2, pixels);
    const larger = solid(6, 4, [20, 30, 40, 255]);
    fixture.assets[0] = pngAsset(fixture.assets[0]!.assetId, larger, 6, 4);
    fixture.nodes[0]!.data.config.resultWidth = 6; fixture.nodes[0]!.data.config.resultHeight = 4;
    const psd = await decodedExport(fixture);
    expect([psd.width, psd.height]).toEqual([6, 4]);
    expect([...psd.children![1]!.imageData!.data.slice(0, 4)]).toEqual([37, 83, 129, 32]);
  });

  it('rejects an actual incompatible PNG aspect ratio even when catalog metadata looks compatible', async () => {
    const fixture = generatedFixture(3, 2, pixels);
    const corruptCatalog = pngAsset(fixture.assets[1]!.assetId, solid(3, 3, [37, 83, 129, 32]), 3, 3);
    fixture.assets[1] = { ...corruptCatalog, width: 3, height: 2 };
    const open = mountExport(fixture);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/\u753b\u5e45\u6bd4\u4f8b/u));
    expect(open).not.toHaveBeenCalled();
  });
});
