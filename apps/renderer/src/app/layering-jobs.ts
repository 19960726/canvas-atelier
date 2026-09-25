import type { ProviderBridgeProfile } from '@agent-canvas/desktop-core';
import type { ImageAspectRatio } from '@agent-canvas/domain';
import type { ModelJobRequest } from '../jobs/job-store';
import { getLayeringRouteContract, type LayeringRouteEvidence } from './layering-route-evidence';
import { matchesLayeringConfirmation, type LayeringConfirmation, type LayeringPlan } from './layering-plan';

export async function buildLayeringJobRequests(
  plan: LayeringPlan,
  confirmation: LayeringConfirmation,
  profile: ProviderBridgeProfile,
  groupId: string,
  evidence: readonly LayeringRouteEvidence[],
  createId: () => string,
): Promise<ModelJobRequest[]> {
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
  const aspectRatio = closestImageAspectRatio(plan.canvasWidth, plan.canvasHeight);

  return plan.layers.filter((layer) => layer.included).map((layer) => ({
    id: createId(),
    kind: 'image' as const,
    promptNodeId: `image-layer-${groupId}-${layer.layerId}`,
    prompt: buildLayerPrompt(layer.kind, layer.name, layer.description),
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
  }));
}

function closestImageAspectRatio(width: number, height: number): ImageAspectRatio {
  const ratios: readonly ImageAspectRatio[] = ['1:1', '2:3', '3:2', '4:3', '3:4', '4:5', '5:4', '16:9', '9:16', '21:9'];
  const actual = width / height;
  return ratios.reduce((closest, candidate) => {
    const ratio = (value: ImageAspectRatio) => {
      const [w, h] = value.split(':').map(Number);
      return w! / h!;
    };
    return Math.abs(Math.log(ratio(candidate) / actual)) < Math.abs(Math.log(ratio(closest) / actual)) ? candidate : closest;
  });
}

function buildLayerPrompt(kind: 'background' | 'transparent', name: string, description: string): string {
  const outputContract = kind === 'background'
    ? 'Generate one complete opaque background image covering the full original canvas. Do not draw foreground objects unless named in this layer.'
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
