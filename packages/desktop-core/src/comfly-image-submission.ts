import type { ComflyClient } from '@agent-canvas/provider-comfly';
import type { ProviderBridgeProfile, SubmitImageJobBridgeRequest } from './provider-contracts.js';

// Comfly currently exposes Flux Pro 1.1 through its DALL-E-compatible edits
// transport (the public model row has an edits API but no generations API).
// Keep the exception exact so a generic model label cannot silently redirect
// an otherwise valid generation request to a different paid endpoint.
const COMFLY_EDIT_TRANSPORT_IMAGE_MODELS = new Set([
  'flux-pro-1.1-ultra',
  'flux-schnell',
]);

export function usesComflyImageEditTransport(modelId: string): boolean {
  return COMFLY_EDIT_TRANSPORT_IMAGE_MODELS.has(modelId.trim().toLocaleLowerCase());
}

export function submitComflyImage(
  client: ComflyClient,
  profile: ProviderBridgeProfile,
  input: SubmitImageJobBridgeRequest,
  prompt: string,
  references: readonly { readonly bytes: Uint8Array; readonly mediaType: string }[],
) {
  const model = profile.modelId ?? profile.modelRoute;
  const usesGptEdits = references.length > 0 && /^gpt-image-2(?:-(?:all|2k|4k|vip)|\.5-(?:flare|sunburst)(?:-(?:2k|4k))?)?$/u.test(model);
  const usesEditTransport = usesGptEdits || usesComflyImageEditTransport(model);
  const request = {
    model,
    prompt,
    ...(references.length === 0 ? {} : { image: usesGptEdits ? references : references.map((item) =>
      `data:${item.mediaType};base64,${Buffer.from(item.bytes).toString('base64')}`) }),
    ...(profile.capabilities.includes('async_tasks') ? { async: true } : {}),
    ...(input.aspectRatio === undefined ? {} : { aspect_ratio: input.aspectRatio }),
    ...(input.resolution === undefined ? {} : { size: input.resolution }),
    ...(input.quality === undefined ? {} : { quality: input.quality }),
    ...(input.imageOutputFormat === undefined || input.imageOutputFormat === 'png' ? {} : { output_format: input.imageOutputFormat }),
    ...(input.imageBackground === undefined || input.imageBackground === 'auto' ? {} : { background: input.imageBackground }),
    ...(input.outputCount === undefined ? {} : { n: input.outputCount }),
  };
  if (!usesEditTransport) return client.generateImage(request);
  if (usesGptEdits) return client.editImage({ ...request, image: references });
  return client.editImage({
    ...request,
    image: references.length === 0 ? undefined : request.image,
  });
}
