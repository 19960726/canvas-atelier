import type { CanvasModuleNode, CanvasProject } from '@agent-canvas/domain';
import type { DesktopProjectImageBridgeApi, ProjectImageAssetSummary } from '@agent-canvas/desktop-core';
import { sourceLayerInputFromNodes, prepareSourceLayerDocument } from '../canvas/source-layer-preview';
import { encodeLayeredPsd } from './layered-psd';
import { buildLayeringReviewDigest } from './layering-proof';

/** Build through the same formal source-pixel checks as the UI; never accept a caller-supplied passed flag. */
export async function exportMcpLayeredPsd(input: {
  nodeId: string; openPhotoshop: boolean; getProject(): CanvasProject; getRevision(): number;
  getAssets(): readonly ProjectImageAssetSummary[]; bridge: DesktopProjectImageBridgeApi | undefined;
}) {
  const project = input.getProject(), revision = input.getRevision(), snapshot = JSON.stringify(project);
  const group = project.nodes.find((node): node is CanvasModuleNode => node.id === input.nodeId && node.type === 'module' && node.data.moduleType === 'image_layering');
  if (!group) throw new Error('PSD_EXPORT_GROUP_REQUIRED');
  if (group.data.config.pixelMode !== 'source') throw new Error('PSD_EXPORT_UNSUPPORTED_GENERATED_GROUP');
  if (group.data.config.needsReconfirm === true) throw new Error('PSD_EXPORT_RECONFIRM_REQUIRED');
  const layers = project.nodes.filter((node): node is CanvasModuleNode => node.type === 'module' && node.data.moduleType === 'image_layer' && node.data.config.groupId === group.data.config.groupId);
  if (typeof group.data.config.assemblyConfirmationDigest === 'string'
    && await buildLayeringReviewDigest(group.data.config, layers) !== group.data.config.assemblyConfirmationDigest) {
    throw new Error('PSD_EXPORT_REVIEW_CHANGED');
  }
  const assets = input.getAssets().filter(asset => project.assets?.some(owned => owned.assetId === asset.assetId && owned.mediaType.startsWith('image/')));
  const sourceInput = sourceLayerInputFromNodes(group.data.config, layers, assets);
  if (!sourceInput || sourceInput.layers.length < 2) throw new Error('PSD_EXPORT_QUALITY_OR_POSITION_NOT_READY');
  const document = await prepareSourceLayerDocument(sourceInput, 'strict');
  const bytes = encodeLayeredPsd(document);
  if (input.getProject().id !== project.id || input.getRevision() !== revision || JSON.stringify(input.getProject()) !== snapshot
    || JSON.stringify(input.getAssets().filter(asset => assets.some(before => before.assetId === asset.assetId))) !== JSON.stringify(assets)) throw new Error('PSD_EXPORT_CANVAS_CHANGED');
  if (input.openPhotoshop) {
    if (!input.bridge?.openLayeredPsdInPhotoshop) throw new Error('PSD_PHOTOSHOP_BRIDGE_UNAVAILABLE');
    const result = await input.bridge.openLayeredPsdInPhotoshop(bytes);
    return { ...result, saved: result.ok || result.saved === true, opened: result.ok };
  }
  if (!input.bridge?.saveLayeredPsd) throw new Error('PSD_SAVE_BRIDGE_UNAVAILABLE');
  return { ...await input.bridge.saveLayeredPsd(bytes), opened: false };
}
