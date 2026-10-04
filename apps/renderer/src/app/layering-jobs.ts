import type { ProviderBridgeProfile } from '@agent-canvas/desktop-core';
import type { ImageAspectRatio, ImageResolutionTier } from '@agent-canvas/domain';
import { mapComflyGptImageSize } from '../../../../packages/provider-comfly/src/image-size';
import type { ModelJobRequest } from '../jobs/job-store';
import { getLayeringRouteContract, type LayeringRouteEvidence } from './layering-route-evidence';
import { matchesLayeringConfirmation, normalizeLayeringPlan, type LayeringConfirmation, type LayeringPlan } from './layering-plan';
import { compatibleLayerDimensions, readLayeringSelection, selectionInstruction } from './layering-selection';

export async function buildLayeringJobRequests(
  plan: LayeringPlan,
  confirmation: LayeringConfirmation,
  profile: ProviderBridgeProfile,
  groupId: string,
  evidence: readonly LayeringRouteEvidence[],
  createId: () => string,
): Promise<ModelJobRequest[]> {
  // Confirmation hashing yields; keep every request bound to the same checked inputs.
  plan = normalizeLayeringPlan(plan);
  profile = structuredClone(profile);
  confirmation = structuredClone(confirmation);
  evidence = structuredClone(evidence);
  if (!(await matchesLayeringConfirmation(confirmation, plan, profile.provider, profile.modelRoute, confirmation.resolution))) {
    throw new Error('The image, layer plan, or model route changed after confirmation. Review and confirm again.');
  }
  const contract = getLayeringRouteContract(profile, evidence);
  if (!contract) throw new Error('This GPT Image route does not support transparent image-edit requests.');
  if (!contract.resolutions.includes(confirmation.resolution)) throw new Error(`The selected route does not support ${confirmation.resolution} layer output.`);
  if (profile.capabilityStatus === 'incomplete') throw new Error('The selected GPT Image route has incomplete capability data.');
  if (profile.constraints?.image?.resolutions !== undefined
    && !profile.constraints.image.resolutions.includes(confirmation.resolution)) {
    throw new Error(`The selected GPT Image route does not support ${confirmation.resolution}.`);
  }
  if (!/^[A-Za-z0-9_-]{1,80}$/u.test(groupId)) throw new Error('The layering group identifier is invalid.');
  if (typeof profile.modelId !== 'string' || profile.modelId.length === 0) throw new Error('The selected GPT Image model id is unavailable.');
  if (profile.provider !== 'comfly') throw new Error('当前路线尚不支持已验证的受管原图分层编辑传输。未创建生成任务。');
  const aspectRatio = closestImageAspectRatio(plan.canvasWidth, plan.canvasHeight, confirmation.resolution,
    profile.modelId, profile.constraints?.image?.aspectRatios);
  if (plan.pixelMode === 'source' && plan.layers.some(layer => layer.included && layer.kind === 'transparent' && !layer.sourceBounds)) {
    throw new Error('请先在原图中标注每个透明图层的位置与范围。');
  }
  const independentForeground = plan.foregroundOutputContract === 'source-independent-rgba-v2';
  const sourceMatte = plan.pixelMode === 'source' && !independentForeground;

  return plan.layers.filter((layer) => layer.included).map((layer) => ({
    id: createId(),
    kind: 'image' as const,
    promptNodeId: `image-layer-${groupId}-${layer.layerId}`,
    prompt: buildLayerPrompt(layer.kind, layer.name, layer.description, sourceMatte)
      + (sourceMatte && layer.kind === 'transparent' ? `\nOUTPUT AN ALPHA MATTE ONLY. Use white RGB with continuous alpha: opaque surfaces alpha 1, empty space and handle holes alpha 0, anti-aliased edges, glass transmission and soft shadows use their actual partial opacity. Do not bake the original background into glass or fill handle holes. Do not redraw colors, textures, lettering, glow, or lighting. The application extracts original pixels locally and removes background contribution where alpha is partial. Original canvas ${plan.canvasWidth}x${plan.canvasHeight}; approximate original object bounds ${JSON.stringify(layer.sourceBounds)} describe the search area, not a crop or resize. Keep the whole source frame and exact pixel placement, with no zoom, crop, centering or enlargement.` : '')
      + (independentForeground && layer.kind === 'transparent' ? `\nOUTPUT COMPLETE STRAIGHT RGBA with independent foreground RGB and continuous alpha. Preserve the target's visible shape, original lettering, material, lighting and exact source position. Remove the original background's color contribution from partial-alpha edges and optical effects; do not bake peer objects or the scene into the foreground RGB. Opaque target surfaces retain their own color; genuine gaps and empty space have alpha 0. Keep authentic partial transparency and reflections belonging to the target. The output is a candidate for per-layer review, not an accepted mask. Original canvas ${plan.canvasWidth}x${plan.canvasHeight}; approximate sourceBounds ${JSON.stringify(layer.sourceBounds)} are search areas, not crops. Keep the full source frame without zoom, centering, enlargement or adding hidden foreground surfaces.` : '') + '\n'
      + selectionInstruction(readLayeringSelection(plan.selection), plan.canvasWidth, plan.canvasHeight)
      + (layer.kind === 'background' ? '\n' + buildBackgroundRemovalInstruction(plan)
        : plan.pixelMode === 'source' ? '\n' + buildForegroundOwnershipInstruction(plan, layer.layerId) : ''),
    provider: profile.provider,
    modelRoute: profile.modelRoute,
    displayName: profile.displayName,
    modelId: profile.modelId!,
    referenceAssetIds: [plan.sourceAssetId],
    aspectRatio,
    resolution: confirmation.resolution,
    imageQuality: 'high' as const,
    imageOutputFormat: contract.outputFormat,
    imageBackground: layer.kind === 'background' ? 'opaque' as const : 'transparent' as const,
    outputCount: 1 as const,
    layeringGroupId: groupId,
    layeringLayerId: layer.layerId,
    // Keep the representation promise beside the job. Transparent source
    // plans without an explicit new contract keep their original alpha-matte
    // representation. Independent RGB is only a candidate until local review.
    layeringOutputContract: layer.kind === 'background'
      ? 'opaque-background-v2' as const
      : plan.foregroundOutputContract ?? 'source-alpha-matte-v1' as const,
    layeringConfirmationDigest: confirmation.digest,
  }));
}

function closestImageAspectRatio(width: number, height: number, resolution: ImageResolutionTier,
  modelId: string, supportedRatios?: readonly ImageAspectRatio[]): ImageAspectRatio {
  const ratios: readonly ImageAspectRatio[] = ['1:1', '2:3', '3:2', '4:3', '3:4', '4:5', '5:4', '16:9', '9:16', '21:9'];
  const allowedRatios = supportedRatios === undefined ? ratios : ratios.filter(ratio => supportedRatios.includes(ratio));
  if (allowedRatios.length === 0) throw new Error(`原图 ${width}x${height}：当前路线没有可用的分层输出比例档位。未创建生成任务。`);
  const actual = width / height;
  const closest = allowedRatios.reduce((closest, candidate) => {
    const ratio = (value: ImageAspectRatio) => {
      const [w, h] = value.split(':').map(Number);
      return w! / h!;
    };
    return Math.abs(Math.log(ratio(candidate) / actual)) < Math.abs(Math.log(ratio(closest) / actual)) ? candidate : closest;
  });
  const [outputWidth, outputHeight] = mapComflyGptImageSize(modelId, resolution, closest).split('x').map(Number);
  if (!compatibleLayerDimensions(outputWidth!, outputHeight!, width, height)) {
    throw new Error(`原图 ${width}x${height} 无法保持完整画幅：当前路线可用比例为 ${allowedRatios.join('、')}，最接近的 ${closest}（${resolution}）仍不符合原图比例。请选择能保持原图比例的路线；未创建生成任务。`);
  }
  return closest;
}

function buildLayerPrompt(kind: 'background' | 'transparent', name: string, description: string, sourceMatte = false): string {
  const outputContract = kind === 'background'
    ? 'Generate one complete opaque background image covering the full original canvas. Preserve every unoccluded source pixel, perspective, texture, lighting and framing; inpaint only the removed objects and their shadows. Do not draw foreground objects unless named in this layer.'
    : sourceMatte
      ? 'Return only the named foreground opacity mask on a fully transparent background. Preserve the original canvas framing and exact location. Original foreground RGB is extracted locally; do not generate foreground colors or a scene background.'
      : 'Generate exactly the named foreground elements as one pixel layer on a fully transparent background. Preserve the original canvas framing and place the subject at its original location. Do not add a background.';
  return [
    'Use the attached original image as the sole visual reference. Create one independently editable image layer for a layered PSD.',
    `Layer name: ${name}.`,
    `Layer instructions: ${description}`,
    outputContract,
    'Keep each named product, prop, and its distinct contact or cast shadow on separate layer tasks. For a shadow-only layer, generate only the named shadow pixels; do not redraw the associated product or prop.',
    'Do not add new text, watermarks, frames, or unrelated objects. Keep all generated pixels aligned to the original image canvas.',
  ].join('\n');
}

function buildBackgroundRemovalInstruction(plan: LayeringPlan): string {
  const foregrounds = plan.layers.filter(layer => layer.included && layer.kind === 'transparent').map(layer => ({
    layerId: layer.layerId, name: layer.name, instructions: layer.description,
    ...(layer.sourceBounds ? { sourceBounds: layer.sourceBounds } : {}),
  }));
  return [
    `Original canvas ${plan.canvasWidth}x${plan.canvasHeight}. Keep the complete source frame; no zoom, crop, centering or enlargement.`,
    `Remove only these confirmed foreground elements within the saved selection: ${JSON.stringify(foregrounds)}. Their sourceBounds describe original search areas, not crops or transforms.`,
    `The ownership registry is authoritative. Every registry element belongs to exactly one layer; remove the named foreground owners and their listed shadows only, and preserve elements on unselected layers: ${JSON.stringify(plan.elements ?? [])}.`,
    'Reconstruct the background behind those elements and their explicitly listed shadows. Preserve unselected objects and every unoccluded source pixel; do not leave copies of the removed objects in the background.',
  ].join('\n');
}

function buildForegroundOwnershipInstruction(plan: LayeringPlan, targetLayerId: string): string {
  const peers = plan.layers.filter(layer => layer.kind === 'transparent' && layer.layerId !== targetLayerId).map(layer => ({
    layerId: layer.layerId, name: layer.name, instructions: layer.description, included: layer.included,
    ...(layer.sourceBounds ? { sourceBounds: layer.sourceBounds } : {}),
  }));
  return [
    `Target foreground layerId: ${targetLayerId}. Extract only its visible source contribution.`,
    `Owned element registry for this target: ${JSON.stringify((plan.elements ?? []).filter(element => element.layerId === targetLayerId))}`,
    `Forbidden element registry for this target: ${JSON.stringify((plan.elements ?? []).filter(element => element.layerId !== targetLayerId))}`,
    'The registry is a hard ownership contract: each element has one owner, and optical/shadow carrierElementId describes the surface it belongs to without transferring ownership.',
    `Other foreground layers in the confirmed plan: ${JSON.stringify(peers)}`,
    'These peers own their named elements, even when included=false (not exported). Their pixels must not be folded into the target layer. Holding, touching, or occluding another object does not make that object part of this layer: a hand holding a cup or lid owns only the visible hand and sleeve, not the held cup or lid. Explicitly exclude peer objects and their solid silhouettes.',
    'Do not complete hidden foreground parts or invent surfaces behind an occluder. Keep genuine gaps between visible target parts transparent. Never erase a whole peer sourceBounds rectangle: bounds are search areas, and visible target parts can lie within them.',
    'For glass, water, steam, glow and shadow layers, preserve only the named optical contribution with continuous alpha. Do not copy the carrier object, underlying solid surface, or unrelated peer silhouette into the effect layer. Genuine translucent contributions may overlap in source coordinates; do not force every layer into disjoint bounding boxes.',
    'Keep original product lettering on its product unless a separate confirmed layer owns those visible glyphs. A separate text layer contains source glyph pixels only; no OCR, font reconstruction or newly drawn text.',
  ].join('\n');
}
