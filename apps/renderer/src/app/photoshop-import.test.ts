import type {
  DesktopBridgeApi,
  PhotoshopImportErrorCode,
  ProjectImageAssetSummary,
} from '@agent-canvas/desktop-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getPhotoshopImportAvailability,
  importGeneratedImageToPhotoshop,
  photoshopImportMessage,
} from './photoshop-import';

const generatedImage: ProjectImageAssetSummary = {
  assetId: '0123456789abcdef',
  byteSize: 2048,
  displayUrl: 'novus-asset://project/session-1/0123456789abcdef',
  extension: 'png',
  height: 1024,
  label: 'Generated image',
  mediaType: 'image/png',
  origin: 'generated',
  sha256: '0123456789abcdef'.repeat(4),
  usageCount: 1,
  width: 1024,
};

const originalDesktopBridge = window.novusDesktop;

afterEach(() => {
  window.novusDesktop = originalDesktopBridge;
});

describe('Photoshop renderer import client', () => {
  it('enables only managed generated images in an active desktop session', () => {
    window.novusDesktop = desktopBridgeWithPhotoshop(vi.fn());

    expect(getPhotoshopImportAvailability(generatedImage, 'session-1')).toEqual({ available: true });
    expect(getPhotoshopImportAvailability({ ...generatedImage, origin: 'imported' }, 'session-1'))
      .toEqual({ available: false, code: 'unsupported_media' });
    expect(getPhotoshopImportAvailability(generatedImage, null))
      .toEqual({ available: false, code: 'desktop_bridge_unavailable' });

    window.novusDesktop = undefined;
    expect(getPhotoshopImportAvailability(generatedImage, 'session-1'))
      .toEqual({ available: false, code: 'desktop_bridge_unavailable' });
  });

  it('submits only opaque session and managed asset identities', async () => {
    const importToPhotoshop = vi.fn().mockResolvedValue({ ok: true, layerName: 'Generated image' });
    window.novusDesktop = desktopBridgeWithPhotoshop(importToPhotoshop);

    await expect(importGeneratedImageToPhotoshop(generatedImage, 'session-1'))
      .resolves.toEqual({ ok: true, layerName: 'Generated image' });
    expect(importToPhotoshop).toHaveBeenCalledTimes(1);
    expect(importToPhotoshop).toHaveBeenCalledWith({
      assetId: generatedImage.assetId,
      sessionId: 'session-1',
    });
    expect(importToPhotoshop.mock.calls[0]?.[0]).not.toHaveProperty('displayUrl');
    expect(importToPhotoshop.mock.calls[0]?.[0]).not.toHaveProperty('path');
  });

  it('does not call the bridge when the asset is unavailable', async () => {
    const importToPhotoshop = vi.fn();
    window.novusDesktop = desktopBridgeWithPhotoshop(importToPhotoshop);

    await expect(importGeneratedImageToPhotoshop({ ...generatedImage, origin: 'imported' }, 'session-1'))
      .resolves.toEqual({ ok: false, code: 'unsupported_media' });
    await expect(importGeneratedImageToPhotoshop(generatedImage, null))
      .resolves.toEqual({ ok: false, code: 'desktop_bridge_unavailable' });
    expect(importToPhotoshop).not.toHaveBeenCalled();
  });

  it('contains unexpected bridge failures behind a fixed error code', async () => {
    const importToPhotoshop = vi.fn().mockRejectedValue(new Error('C:/private/user/project/image.png'));
    window.novusDesktop = desktopBridgeWithPhotoshop(importToPhotoshop);

    await expect(importGeneratedImageToPhotoshop(generatedImage, 'session-1'))
      .resolves.toEqual({ ok: false, code: 'placement_failed' });
  });

  it.each<[PhotoshopImportErrorCode, string]>([
    ['desktop_bridge_unavailable', '当前环境不支持 Photoshop 导入'],
    ['asset_not_found', '原始生成图片不存在，请重新生成或重新导入'],
    ['asset_not_owned', '当前项目无权使用这张图片'],
    ['unsupported_media', '只有生成图片可以导入 Photoshop'],
    ['photoshop_not_installed', '未找到 Photoshop CS6 或更高版本'],
    ['photoshop_not_running', '请先启动 Photoshop 并打开目标文档'],
    ['photoshop_version_unsupported', '当前 Photoshop 版本过低，仅支持 CS6 及以上版本'],
    ['no_active_document', '请先在 Photoshop 中打开 PSD 或 PSB 文档'],
    ['automation_denied', 'Photoshop 拒绝了自动化操作，请检查权限设置'],
    ['automation_unavailable', '无法连接 Photoshop 自动化，请以相同权限启动 Photoshop 和画布后重试'],
    ['placement_failed', '图片未能导入 Photoshop，请重试'],
    ['import_busy', '这张图片正在导入 Photoshop'],
  ])('maps %s to fixed actionable Chinese copy', (code, message) => {
    expect(photoshopImportMessage({ ok: false, code })).toBe(message);
  });

  it('maps a successful import to the fixed success message', () => {
    expect(photoshopImportMessage({ ok: true, layerName: 'Generated image' }))
      .toBe('已导入当前 Photoshop 文档');
  });
});

function desktopBridgeWithPhotoshop(importToPhotoshop: ReturnType<typeof vi.fn>): DesktopBridgeApi {
  return {
    projectImages: { importToPhotoshop },
  } as unknown as DesktopBridgeApi;
}
