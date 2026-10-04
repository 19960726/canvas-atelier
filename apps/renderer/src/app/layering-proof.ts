import type { CanvasModuleNode } from '@agent-canvas/domain';

/**
 * A returned layer may still be useful for inspection while its proof is no
 * longer valid.  Keep the pixels and job binding, but remove every status
 * that could make a stale result look PSD-ready.
 */
export function invalidateLayeringProof(
  config: Readonly<Record<string, unknown>>,
  reason = '分层方案已变更，请重新确认并检查图层',
): Record<string, unknown> {
  const next: Record<string, unknown> = {
    ...config,
    needsReconfirm: true,
    resultState: 'needs_review',
    qualityStatus: 'pending',
    qualityReason: reason,
    qualityValidationVersion: config.formatQualityStatus === 'passed'
      && config.qualityFormatCheckedAssetId === config.resultAssetId && config.qualityValidationVersion === 2 ? 2 : null,
    status: typeof config.resultAssetId === 'string' && config.resultAssetId ? 'validating' : 'planned',
  };
  // These fields are evidence for the old plan and must never survive a
  // bounds/order/name change.  The returned asset itself remains available for
  // review and for the draft PSD path.
  for (const field of [
    'assemblyConfirmationDigest', 'semanticReviewAccepted', 'semanticReviewDigest',
    'foregroundValidation',
  ]) delete next[field];
  return next;
}

/** The exact, immutable content inspected by a local review. Inspection toggles
 * and proof fields are excluded so accepting it cannot change its own digest. */
export function serializeLayeringReviewSnapshot(
  groupConfig: Readonly<Record<string, unknown>>,
  children: readonly CanvasModuleNode[],
): string {
  const pick = (config: Readonly<Record<string, unknown>>, keys: readonly string[]) =>
    Object.fromEntries(keys.map(key => [key, config[key] === undefined ? null : config[key]]));
  const layerFields = ['sourceAssetId', 'layerId', 'layerKind', 'name', 'description', 'sourceBounds', 'order',
    'canvasWidth', 'canvasHeight', 'layerSelection', 'pixelMode', 'maskSpace', 'resultAssetId', 'resultWidth', 'resultHeight',
    'layeringOutputContract', 'outputContract', 'resultRepresentation', 'preparedRgb', 'layerPrepared', 'pixelColorSpace',
    'shadowOnly', 'refinedFromAssetId', 'mattingRegions', 'foregroundProvenance'] as const;
  const planFields = ['layerId', 'kind', 'name', 'description', 'included', 'sourceBounds', 'order'] as const;
  const ownershipFields = [...planFields, 'elementIds'] as const;
  const ownershipPlan = Array.isArray(groupConfig.planOwnershipLayers) ? groupConfig.planOwnershipLayers.map(value => value !== null
    && typeof value === 'object' && !Array.isArray(value) ? pick(value as Record<string, unknown>, ownershipFields) : value) : undefined;
  const snapshot = {
    schema: 'canvas-atelier.layering-local-review.v1',
    group: pick(groupConfig, ['groupId', 'sourceAssetId', 'canvasWidth', 'canvasHeight', 'layerSelection', 'selection', 'pixelMode',
      'maskSpace', 'backgroundMode', 'planVersion', ...(groupConfig.foregroundOutputContract === undefined ? [] : ['foregroundOutputContract'])]),
    plan: Array.isArray(groupConfig.planLayers) ? groupConfig.planLayers.map(value => value !== null
      && typeof value === 'object' && !Array.isArray(value) ? pick(value as Record<string, unknown>, planFields) : value) : null,
    ...(ownershipPlan !== undefined || Array.isArray(groupConfig.planElements) ? {
      ownershipPlan: ownershipPlan ?? null,
      elements: Array.isArray(groupConfig.planElements) ? groupConfig.planElements : null,
    } : {}),
    children: [...children].sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0).map(child => ({
      nodeId: child.id, moduleType: child.data.moduleType, ...pick(child.data.config, layerFields),
    })),
  };
  return JSON.stringify(normalizeSnapshotValue(snapshot));
}

export async function buildLayeringReviewDigest(
  groupConfig: Readonly<Record<string, unknown>>,
  children: readonly CanvasModuleNode[],
): Promise<string> {
  const snapshot = serializeLayeringReviewSnapshot(groupConfig, children);
  if (!globalThis.crypto?.subtle) throw new Error('本地分层复核需要安全摘要支持');
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(snapshot));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function normalizeSnapshotValue(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(normalizeSnapshotValue);
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, normalizeSnapshotValue((value as Record<string, unknown>)[key])]));
  }
  throw new Error('分层复核内容不是有效的本地快照');
}

export function isLayeringProofCurrent(config: Readonly<Record<string, unknown>>): boolean {
  return config.needsReconfirm !== true
    && config.qualityStatus === 'passed'
    && typeof config.layeringConfirmationDigest === 'string'
    && /^[a-f0-9]{64}$/u.test(config.layeringConfirmationDigest)
    && config.semanticReviewAccepted !== false;
}
