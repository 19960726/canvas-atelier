import { writePsdUint8Array, type Layer, type Psd } from 'ag-psd';

export interface LayeredPsdLayer {
  readonly id: string;
  readonly kind: 'background' | 'transparent';
  readonly name: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly visible: boolean;
  readonly opacity: number;
  readonly rgba: Uint8Array;
}

export interface LayeredPsdDocument {
  readonly width: number;
  readonly height: number;
  /** Bottom to top, with one genuine background layer first. */
  readonly layers: readonly LayeredPsdLayer[];
}

const MAX_DOCUMENT_SIDE = 8_192;
const MAX_PIXEL_BYTES = 256 * 1024 * 1024;

export function encodeLayeredPsd(document: LayeredPsdDocument): Uint8Array {
  validateLayeredDocument(document);
  const composite = composeLayeredRgba(document);
  const children: Layer[] = [...document.layers].reverse().map(layer => ({
    name: layer.name,
    left: layer.x,
    top: layer.y,
    right: layer.x + layer.width,
    bottom: layer.y + layer.height,
    hidden: !layer.visible,
    opacity: layer.opacity,
    imageData: { data: layer.rgba, width: layer.width, height: layer.height },
  }));
  const psd: Psd = {
    width: document.width,
    height: document.height,
    bitsPerChannel: 8,
    children,
    imageData: { data: composite, width: document.width, height: document.height },
  };
  return writePsdUint8Array(psd, { noBackground: true, trimImageData: false });
}

export function composeLayeredRgba(document: LayeredPsdDocument): Uint8Array {
  validateLayeredDocument(document);
  const result = new Uint8Array(document.width * document.height * 4);
  for (const layer of document.layers) {
    if (!layer.visible || layer.opacity === 0) continue;
    for (let y = 0; y < layer.height; y += 1) {
      for (let x = 0; x < layer.width; x += 1) {
        const source = (y * layer.width + x) * 4;
        const target = ((layer.y + y) * document.width + layer.x + x) * 4;
        const sourceAlpha = layer.rgba[source + 3]! / 255 * layer.opacity;
        if (sourceAlpha === 0) continue;
        const targetAlpha = result[target + 3]! / 255;
        const resultAlpha = sourceAlpha + targetAlpha * (1 - sourceAlpha);
        for (let channel = 0; channel < 3; channel += 1) {
          result[target + channel] = Math.round((layer.rgba[source + channel]! * sourceAlpha
            + result[target + channel]! * targetAlpha * (1 - sourceAlpha)) / resultAlpha);
        }
        result[target + 3] = Math.round(resultAlpha * 255);
      }
    }
  }
  return result;
}

export function validateLayeredDocument(document: LayeredPsdDocument): void {
  if (!validDimension(document.width) || !validDimension(document.height)
    || document.width > MAX_DOCUMENT_SIDE || document.height > MAX_DOCUMENT_SIDE
    || document.width * document.height * 4 > MAX_PIXEL_BYTES) {
    throw new Error('Layered PSD canvas dimensions are invalid');
  }
  if (document.layers.length < 2 || document.layers.length > 17
    || document.layers[0]?.kind !== 'background'
    || document.layers.slice(1).some(layer => layer.kind !== 'transparent')) {
    throw new Error('Layered PSD requires one background and 1–16 transparent layers');
  }
  const seen = new Set<string>();
  let pixelBytes = 0;
  for (const layer of document.layers) {
    if (!layer.id || !layer.name.trim() || seen.has(layer.id)) throw new Error('Layered PSD layer identity is invalid');
    seen.add(layer.id);
    if (!validDimension(layer.width) || !validDimension(layer.height)
      || !Number.isInteger(layer.x) || !Number.isInteger(layer.y)
      || layer.x < 0 || layer.y < 0
      || layer.x + layer.width > document.width || layer.y + layer.height > document.height) {
      throw new Error('Layered PSD layer is outside canvas bounds');
    }
    const expectedBytes = layer.width * layer.height * 4;
    pixelBytes += expectedBytes;
    if (layer.rgba.length !== expectedBytes || pixelBytes > MAX_PIXEL_BYTES) {
      throw new Error('Layered PSD RGBA pixel data is invalid');
    }
    if (!Number.isFinite(layer.opacity) || layer.opacity < 0 || layer.opacity > 1) {
      throw new Error('Layered PSD opacity is invalid');
    }
    if (layer.kind === 'transparent') {
      let hasTransparency = false;
      for (let index = 3; index < layer.rgba.length; index += 4) {
        if (layer.rgba[index] !== 255) { hasTransparency = true; break; }
      }
      if (!hasTransparency) throw new Error('Layered PSD transparent layer has no alpha');
    }
  }
}

function validDimension(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}
