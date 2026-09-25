import { describe, expect, it } from 'vitest';
import { parseLayeredImageConfig } from './layered-image-config';

const assets = [
  { assetId: 'a'.repeat(16), mediaType: 'image/png' as const, displayUrl: 'novus-asset://a' },
  { assetId: 'b'.repeat(16), mediaType: 'image/png' as const, displayUrl: 'novus-asset://b' },
];
const config = { canvasWidth: 2, canvasHeight: 2, layers: [
  { layerId: 'base', kind: 'background', name: 'Background', assetId: assets[0]!.assetId, x: 0, y: 0, width: 2, height: 2, visible: true, opacity: 1 },
  { layerId: 'cutout', kind: 'transparent', name: 'Cutout', assetId: assets[1]!.assetId, x: 1, y: 0, width: 1, height: 2, visible: true, opacity: 1 },
] };

describe('saved layered image config', () => {
  it('resolves only existing managed assets and keeps URLs out of project config', () => {
    const parsed = parseLayeredImageConfig(config, assets);
    expect(parsed?.layers.map(layer => layer.asset.displayUrl)).toEqual(['novus-asset://a', 'novus-asset://b']);
    expect(JSON.stringify(parsed?.layers.map(layer => layer.record))).not.toContain('novus-asset://');
  });

  it('rejects missing media, repeated assets, and out of bounds coordinates', () => {
    expect(() => parseLayeredImageConfig(config, assets.slice(0, 1))).toThrow(/managed/iu);
    expect(() => parseLayeredImageConfig({ ...config, layers: [config.layers[0], { ...config.layers[1], assetId: assets[0]!.assetId }] }, assets)).toThrow(/duplicate/iu);
    expect(() => parseLayeredImageConfig({ ...config, layers: [config.layers[0], { ...config.layers[1], x: 2 }] }, assets)).toThrow(/bounds/iu);
  });
});
