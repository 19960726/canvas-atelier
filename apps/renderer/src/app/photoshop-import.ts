import type {
  PhotoshopCapability,
  PhotoshopImportErrorCode,
  PhotoshopImportResult,
  ProjectImageAssetSummary,
} from '@agent-canvas/desktop-core';

const PHOTOSHOP_IMPORT_MESSAGES: Readonly<Record<PhotoshopImportErrorCode, string>> = {
  asset_not_found: '原始生成图片不存在，请重新生成或重新导入',
  asset_not_owned: '当前项目无权使用这张图片',
  automation_denied: 'Photoshop 拒绝了自动化操作，请检查权限设置',
  automation_unavailable: '无法连接 Photoshop 自动化，请以相同权限启动 Photoshop 和画布后重试',
  desktop_bridge_unavailable: '当前环境不支持 Photoshop 导入',
  import_busy: '这张图片正在导入 Photoshop',
  no_active_document: '请先在 Photoshop 中打开 PSD 或 PSB 文档',
  photoshop_not_installed: '未找到 Photoshop CS6 或更高版本',
  photoshop_not_running: '请先启动 Photoshop 并打开目标文档',
  photoshop_version_unsupported: '当前 Photoshop 版本过低，仅支持 CS6 及以上版本',
  placement_failed: '图片未能导入 Photoshop，请重试',
  unsupported_media: '只有生成图片可以导入 Photoshop',
};

export function getPhotoshopImportAvailability(
  asset: ProjectImageAssetSummary,
  sessionId: string | null,
): PhotoshopCapability {
  if (window.novusDesktop?.projectImages.importToPhotoshop === undefined || sessionId === null) {
    return { available: false, code: 'desktop_bridge_unavailable' };
  }
  if (asset.origin !== 'generated') {
    return { available: false, code: 'unsupported_media' };
  }
  return { available: true };
}

export async function importGeneratedImageToPhotoshop(
  asset: ProjectImageAssetSummary,
  sessionId: string | null,
): Promise<PhotoshopImportResult> {
  const availability = getPhotoshopImportAvailability(asset, sessionId);
  if (!availability.available) {
    return { ok: false, code: availability.code ?? 'desktop_bridge_unavailable' };
  }

  try {
    return await window.novusDesktop!.projectImages.importToPhotoshop({
      assetId: asset.assetId,
      sessionId: sessionId!,
    });
  } catch {
    return { ok: false, code: 'placement_failed' };
  }
}

export function photoshopImportMessage(result: PhotoshopImportResult): string {
  return result.ok
    ? '已导入当前 Photoshop 文档'
    : PHOTOSHOP_IMPORT_MESSAGES[result.code];
}
