import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, expect, it, vi } from 'vitest';
import type { ProjectImageAssetSummary } from '@agent-canvas/desktop-core';
import { GeneratedImageActionMenu } from './GeneratedImageActionMenu';
import { AUTO_IMAGE_COLOR_CORRECTION } from '../app/image-color-correction';

const renderCorrected = vi.hoisted(() => vi.fn());
vi.mock('../app/image-color-correction', async (loadActual) => ({
  ...await loadActual<typeof import('../app/image-color-correction')>(),
  renderImageColorCorrectionBlob: renderCorrected,
}));

const asset = {
  assetId: 'generated-test-image',
  displayUrl: 'novus-asset://test/image',
  label: 'Generated test image',
  extension: 'jpg',
  mediaType: 'image/jpeg',
  origin: 'generated',
} as ProjectImageAssetSummary;

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); renderCorrected.mockReset(); });

it('shows download progress and keeps corrected image bytes alive until the browser starts saving', async () => {
  let finish!: (blob: Blob) => void;
  renderCorrected.mockReturnValue(new Promise<Blob>((resolve) => { finish = resolve; }));
  const blob = new Blob(['corrected'], { type: 'image/png' });
  const revokeObjectURL = vi.fn();
  class TestURL extends URL {
    static createObjectURL = vi.fn(() => 'blob:corrected-image');
    static revokeObjectURL = revokeObjectURL;
  }
  vi.stubGlobal('URL', TestURL);
  const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  render(<GeneratedImageActionMenu asset={asset} colorCorrection={AUTO_IMAGE_COLOR_CORRECTION}
    left={20} top={20} onSendToAgent={vi.fn()} onClose={vi.fn()} />);

  fireEvent.click(screen.getByRole('menuitem', { name: '下载图片' }));
  expect(screen.getByRole('menuitem', { name: '正在准备下载…' })).toBeDisabled();
  expect(renderCorrected).toHaveBeenCalledWith(asset.displayUrl, AUTO_IMAGE_COLOR_CORRECTION);
  await act(async () => { finish(blob); });
  await waitFor(() => expect(anchorClick).toHaveBeenCalledOnce());
  expect(revokeObjectURL).not.toHaveBeenCalled();
});
