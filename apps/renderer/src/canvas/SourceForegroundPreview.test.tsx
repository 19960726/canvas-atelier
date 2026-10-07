import { cleanup, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, expect, it, vi } from 'vitest';
import { SourceForegroundPreview } from './SourceForegroundPreview';

const { decodeLayerPixels, layerPixelsUrl } = vi.hoisted(() => ({
  decodeLayerPixels: vi.fn(async (url: string) => url === 'candidate'
    ? Uint8Array.from([10, 20, 30, 128, 0, 0, 0, 0])
    : Uint8Array.from([100, 100, 100, 255, 100, 100, 100, 255])),
  layerPixelsUrl: vi.fn((rgba: Uint8Array) => `data:image/png;base64,${rgba.join(',')}`),
}));

vi.mock('../app/managed-layer-pixels', () => ({ decodeLayerPixels, layerPixelsUrl }));

afterEach(() => {
  cleanup();
  decodeLayerPixels.mockClear();
  layerPixelsUrl.mockClear();
});

it('previews a straight RGBA candidate without extracting RGB from the source image', async () => {
  render(<SourceForegroundPreview sourceUrl="source" maskUrl="candidate" width={2} height={1}
    bounds={{ x: 0, y: 0, width: 1, height: 1 }} selection={{ mode: 'whole' }} label="候选层" independentRgba />);

  await waitFor(() => expect(screen.getByRole('img', { name: '候选层' })).toBeVisible());
  expect(decodeLayerPixels).toHaveBeenCalledWith('candidate', 2, 1);
  expect(layerPixelsUrl).toHaveBeenCalledWith(Uint8Array.from([10, 20, 30, 128, 0, 0, 0, 0]), 2, 1);
});
