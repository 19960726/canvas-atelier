import type { ComflyAccessibleModelCatalog, ComflyCatalogModel } from '@agent-canvas/provider-comfly';
import type { RelayMeModel, RelayMeWorkflow } from '@agent-canvas/provider-relayme';
import { ProviderBridgeProfileSchema, type ProviderBridgeProfile } from './provider-contracts.js';
import { hasVerifiedComflyVideoSubmissionContract } from './comfly-video-jobs.js';

const MEDIA_OUTPUT_IDENTITY_PATTERNS = [
  /(?:^|-)gemini-\d+(?:-\d+)?-(?:[a-z0-9]+-)*image(?:-|$)/u,
  /(?:^|-)gpt-4o-image(?:-|$)/u,
  /(?:^|-)qwen-(?:image(?:-edit)?|mt-image)(?:-|$)/u,
  /(?:^|-)seedream-v?\d+(?:-\d+)?(?:-|$)/u,
  /(?:^|-)dall(?:e|-e)(?:-|$)/u,
  /(?:^|-)grok-imagine-video(?:-|$)/u,
  /(?:^|-)hailuo-video(?:-|$)/u,
  /(?:^|-)kling-(?:advanced-lip-sync|meta-human)(?:-|$)/u,
  /(?:^|-)pixverse-video(?:-|$)/u,
  /(?:^|-)sora-2(?:-|$)/u,
  /(?:^|-)veo3(?:-\d+)?-(?:fast-4k|components)(?:-|$)/u,
  /(?:^|-)video-style-transform(?:-|$)/u,
  /(?:^|-)videoretalk(?:-|$)/u,
] as const;

export function isMediaOutputModelIdentity(...identities: (string | undefined)[]): boolean {
  return identities.some((identity) => {
    if (identity === undefined) return false;
    const normalized = identity.trim().toLocaleLowerCase().replace(/[._/\s]+/gu, '-');
    return MEDIA_OUTPUT_IDENTITY_PATTERNS.some((pattern) => pattern.test(normalized));
  });
}

// Comfly's public catalog currently describes the Gemini 3.1 Flash Image
// variants as supporting reference-image editing, while listing only the
// shared `/v1/images/generations` transport (the image is sent in the
// `image` field). Keep this exception deliberately narrow: a display name or
// a generic "image"/"edit" label is not enough evidence to grant the
// capability to an arbitrary model.
const VERIFIED_COMFLY_GEMINI_IMAGE_EDIT_MODELS = new Set([
  'gemini-3.1-flash-image-preview',
  'gemini-3.1-flash-image-preview-512px',
  'gemini-3.1-flash-image-preview-2k',
  'gemini-3.1-flash-image-preview-4k',
]);
const VERIFIED_COMFLY_GENERATIONS_REFERENCE_IMAGE_MODELS = new Set([
  ...VERIFIED_COMFLY_GEMINI_IMAGE_EDIT_MODELS,
  'seedream-v5-pro',
]);
const VERIFIED_COMFLY_GEMINI_NATIVE_REVERSE_MODELS = new Set([
  'gemini-3.1-pro-preview-customtools',
]);

export function isVerifiedComflyGeminiImageEditModel(modelId: string | undefined): boolean {
  if (modelId === undefined) return false;
  // The model id is forwarded to Comfly unchanged. Only exact canonical ids
  // observed in the provider catalog are safe to promote to image editing.
  return VERIFIED_COMFLY_GEMINI_IMAGE_EDIT_MODELS.has(modelId);
}

/**
 * Repair known Comfly catalog omissions for models whose generations endpoint
 * accepts reference images in its `image` field.
 *
 * The migration is applied both to freshly discovered catalog profiles and to
 * cached user profiles, so an existing canvas can be reopened and submitted
 * without requiring the user to delete/reselect the model. It only adds the
 * capability when image generation is already present and the model identity
 * is one of the exact models verified against the provider documentation.
 */
export function repairComflyImageEditCapability(profile: ProviderBridgeProfile): ProviderBridgeProfile {
  if (profile.provider !== 'comfly'
    || !profile.capabilities.includes('image_generation')
    || profile.capabilities.includes('image_edit')
    || profile.capabilityStatus === 'incomplete'
    || profile.modelId === undefined
    || !VERIFIED_COMFLY_GENERATIONS_REFERENCE_IMAGE_MODELS.has(profile.modelId)) {
    return profile;
  }
  const capabilities = [...profile.capabilities];
  const generationIndex = capabilities.indexOf('image_generation');
  capabilities.splice(generationIndex + 1, 0, 'image_edit');
  return { ...profile, capabilities };
}

export function repairComflyGeminiNativeReverseCapability(profile: ProviderBridgeProfile): ProviderBridgeProfile {
  if (profile.provider !== 'comfly'
    || profile.capabilityStatus === 'incomplete'
    || profile.modelId === undefined
    || !VERIFIED_COMFLY_GEMINI_NATIVE_REVERSE_MODELS.has(profile.modelId)
    || !profile.capabilities.includes('vision')
    || !profile.capabilities.includes('reverse_prompt')
    || profile.capabilities.includes('gemini_native')) {
    return profile;
  }
  return { ...profile, capabilities: [...profile.capabilities, 'gemini_native'] };
}

export function buildComflyModelProfiles(catalog: ComflyAccessibleModelCatalog): ProviderBridgeProfile[] {
  const seenModelKeys = new Set<string>();
  const validModels = catalog.models.filter((model) => {
    const key = model.key.trim();
    const name = model.name.trim();
    if (key.length === 0 || name.length === 0 || seenModelKeys.has(key)) return false;
    seenModelKeys.add(key);
    return true;
  });
  return ensureUniqueModelRoutes(validModels.map((model) => repairComflyImageEditCapability(ProviderBridgeProfileSchema.parse({
    provider: 'comfly',
    modelRoute: `comfly-${routeSlug(model.key)}`,
    displayName: model.name,
    modelId: model.key,
    capabilities: capabilitiesForComflyModel(model),
    capabilityStatus: model.capabilityStatus,
    constraints: constraintsForComflyModel(model),
    reasoning: reasoningForComflyModel(model),
  }))));
}

export function buildRelayMeModelProfiles(models: readonly RelayMeModel[]): ProviderBridgeProfile[] {
  return ensureUniqueModelRoutes(models.map((model) => ProviderBridgeProfileSchema.parse({
    provider: 'relayme',
    modelRoute: `relayme-${routeSlug(model.deploymentName)}`,
    displayName: model.name,
    modelId: model.deploymentName,
    capabilities: capabilitiesForRelayMeModel(model),
    capabilityStatus: relayMeCapabilityStatus(model),
    constraints: constraintsForRelayMeModel(model),
    reasoning: model.capability === 'text' ? defaultReasoningCapability('system_instruction') : undefined,
  })));
}

function relayMeCapabilityStatus(model: RelayMeModel): ProviderBridgeProfile['capabilityStatus'] {
  // RelayMe image/video generation and dialogue use provider-wide direct
  // endpoints. The catalog capability and real deployment id are sufficient;
  // a redundant per-model endpoint list is not required for these routes.
  if (model.capability === 'image' || model.capability === 'video' || model.capability === 'text') return 'complete';
  return model.endpoints === undefined || model.endpoints.length === 0 ? 'incomplete' : 'complete';
}

export function buildRelayMeWorkflowModelProfiles(workflows: readonly RelayMeWorkflow[]): ProviderBridgeProfile[] {
  const discovered = new Map<string, ProviderBridgeProfile>();
  for (const workflow of workflows) {
    const nodes = Array.isArray(workflow.data?.nodes) ? workflow.data.nodes : [];
    for (const node of nodes) {
      if (!isPlainRecord(node) || node.kind !== 'model' || typeof node.model !== 'string' || node.model.trim().length === 0) continue;
      const modelId = node.model.trim();
      const capabilities: ProviderBridgeProfile['capabilities'] = node.modelType === 'IMAGE'
        ? ['image_generation', 'async_tasks']
        : node.modelType === 'VIDEO'
          ? ['video_generation', 'async_tasks']
          : node.modelType === 'TEXT'
            ? ['chat']
            : [];
      if (capabilities.length === 0) continue;
      const key = `${String(node.modelType)}:${modelId.toLocaleLowerCase()}`;
      if (discovered.has(key)) continue;
      discovered.set(key, ProviderBridgeProfileSchema.parse({
        provider: 'relayme',
        modelRoute: `relayme-${routeSlug(modelId)}`,
        displayName: relayMeModelIdDisplayName(modelId),
        modelId,
        capabilities,
        capabilityStatus: 'complete',
        reasoning: node.modelType === 'TEXT' ? defaultReasoningCapability('system_instruction') : undefined,
      }));
    }
  }
  return ensureUniqueModelRoutes([...discovered.values()]);
}

function relayMeModelIdDisplayName(modelId: string): string {
  const normalized = modelId.toLocaleLowerCase();
  if (normalized === 'gpt-image-2') return 'GPT Image 2';
  if (normalized === 'kling3') return 'Kling 3';
  return modelId;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function mergeProviderModelProfiles(profiles: readonly ProviderBridgeProfile[]): ProviderBridgeProfile[] {
  const merged = new Map<string, ProviderBridgeProfile>();
  for (const profile of profiles) {
    const parsed = repairComflyImageEditCapability(ProviderBridgeProfileSchema.parse(profile));
    const key = `${parsed.provider}::${parsed.modelRoute}`;
    if (!merged.has(key)) merged.set(key, parsed);
  }
  return [...merged.values()];
}

export function cloneProviderProfile(profile: ProviderBridgeProfile): ProviderBridgeProfile {
  return {
    ...profile,
    capabilities: [...profile.capabilities],
    ...(profile.constraints === undefined ? {} : { constraints: cloneProviderConstraints(profile.constraints) }),
    ...(profile.reasoning === undefined ? {} : { reasoning: { ...profile.reasoning, efforts: [...profile.reasoning.efforts] } }),
  };
}

function defaultReasoningCapability(protocol: NonNullable<ProviderBridgeProfile['reasoning']>['protocol']): NonNullable<ProviderBridgeProfile['reasoning']> {
  return { efforts: ['low', 'medium', 'high'], defaultEffort: 'medium', protocol };
}

function reasoningForComflyModel(model: ComflyCatalogModel): ProviderBridgeProfile['reasoning'] {
  if (hasComflyApi(model, '/v1/responses') && !isMediaOutputModelIdentity(model.key, model.name)) {
    return defaultReasoningCapability('responses');
  }
  if (hasComflyApi(model, '/v1/chat/completions') && !isMediaOutputModelIdentity(model.key, model.name)) {
    return defaultReasoningCapability('system_instruction');
  }
  return undefined;
}

export function markProviderProfileSelections(
  available: readonly ProviderBridgeProfile[],
  configured: readonly ProviderBridgeProfile[],
): ProviderBridgeProfile[] {
  const matchesConfigured = (profile: ProviderBridgeProfile) => configured.some((candidate) => (
    candidate.enabled !== false
    && candidate.provider === profile.provider
    && (candidate.modelRoute === profile.modelRoute
      || (candidate.modelId !== undefined && profile.modelId !== undefined && candidate.modelId === profile.modelId))
  ));
  const hasExplicitSelection = configured.length > 0;
  return available.map((profile) => ({
    ...cloneProviderProfile(profile),
    enabled: !hasExplicitSelection || matchesConfigured(profile),
  }));
}

function cloneProviderConstraints(
  constraints: NonNullable<ProviderBridgeProfile['constraints']>,
): NonNullable<ProviderBridgeProfile['constraints']> {
  return {
    ...(constraints.image === undefined ? {} : { image: {
      ...(constraints.image.aspectRatios === undefined ? {} : { aspectRatios: [...constraints.image.aspectRatios] }),
      ...(constraints.image.resolutions === undefined ? {} : { resolutions: [...constraints.image.resolutions] }),
      ...(constraints.image.sizes === undefined ? {} : { sizes: [...constraints.image.sizes] }),
      ...(constraints.image.outputCounts === undefined ? {} : { outputCounts: [...constraints.image.outputCounts] }),
    } }),
    ...(constraints.video === undefined ? {} : { video: {
      ...(constraints.video.aspectRatios === undefined ? {} : { aspectRatios: [...constraints.video.aspectRatios] }),
      ...(constraints.video.resolutions === undefined ? {} : { resolutions: [...constraints.video.resolutions] }),
      ...(constraints.video.duration === undefined ? {} : { duration: constraints.video.duration.mode === 'options'
        ? { ...constraints.video.duration, options: [...constraints.video.duration.options] }
        : { ...constraints.video.duration } }),
      ...(constraints.video.outputCounts === undefined ? {} : { outputCounts: [...constraints.video.outputCounts] }),
    } }),
  };
}

function capabilitiesForComflyModel(model: ComflyCatalogModel): ProviderBridgeProfile['capabilities'] {
  const tags = new Set(model.tags);
  const capabilities: ProviderBridgeProfile['capabilities'] = [];
  const isMediaOutputModel = isMediaOutputModelIdentity(model.key, model.name);
  const hasExplicitVideoTag = tags.has('视频');
  const hasImageGeneration = hasComflyApi(model, '/v1/images/generations');
  const hasImageEdit = hasComflyApi(model, '/v1/images/edits');
  // The public Comfly catalog can attach its provider-wide video endpoint to
  // non-video models. Require positive model-level video evidence as well as
  // the executable endpoint so chat, vision, and action routes stay out of the
  // video generator.
  const hasVideoGeneration = hasExplicitVideoTag
    && hasComflyApi(model, '/v2/videos/generations')
    && hasVerifiedComflyVideoSubmissionContract(model.key);
  const hasChat = !isMediaOutputModel && hasComflyApi(model, '/v1/chat/completions');
  const hasResponses = !isMediaOutputModel && hasComflyApi(model, '/v1/responses');
  const hasGeminiNative = !isMediaOutputModel
    && /^gemini(?:[-./]|$)/iu.test(model.key)
    && (model.endpointTypes ?? []).some((endpointType) => endpointType.trim().toLocaleLowerCase() === 'gemini');
  const hasVisionTag = tags.has('识图') || tags.has('图生文') || tags.has('多模态');
  const hasVision = (hasChat || hasResponses || hasGeminiNative) && hasVisionTag;
  const hasVideoUnderstanding = hasChat && (tags.has('视频分析') || tags.has('视频理解'));
  if (hasImageGeneration) capabilities.push('image_generation');
  if (hasImageEdit) capabilities.push('image_edit');
  if (hasVideoGeneration) capabilities.push('video_generation');
  if (hasChat) capabilities.push('chat');
  if (hasVision && hasChat) capabilities.push('vision', 'reverse_prompt');
  if (hasVideoUnderstanding) capabilities.push('video_understanding');
  if (hasResponses) capabilities.push('responses');
  // The reverse executor currently sends images through chat completions.
  // Keep Responses-only vision metadata visible without advertising a route
  // that the installed transport cannot execute.
  if (hasVision && !hasChat) capabilities.push('vision');
  if (hasVision && hasGeminiNative) {
    if (!capabilities.includes('reverse_prompt')) capabilities.push('reverse_prompt');
    capabilities.push('gemini_native');
  }
  if (tags.has('异步任务')) capabilities.push('async_tasks');
  return capabilities;
}

function hasComflyApi(model: ComflyCatalogModel, endpoint: string): boolean {
  const normalizedEndpoint = endpoint.toLocaleLowerCase();
  return model.apis.some((api) => {
    const normalizedApi = api.trim().toLocaleLowerCase();
    if (normalizedApi === normalizedEndpoint) return true;
    const separator = normalizedApi.indexOf('-');
    if (separator < 0) return false;
    const declaredPath = normalizedApi.slice(separator + 1).replace(/-\d+$/u, '');
    return declaredPath === normalizedEndpoint;
  });
}
function constraintsForComflyModel(model: ComflyCatalogModel): ProviderBridgeProfile['constraints'] {
  const parsedImage = model.tags.includes('绘图') ? imageConstraintsFromTable(model.parameterTable) : undefined;
  // The current Seedream V5 provider contract exposes a 2K output tier. Its
  // pricing table contains pixel billing bands rather than selectable sizes.
  const image = model.key === 'seedream-v5-pro'
    ? { ...parsedImage, resolutions: ['2K' as const] }
    : parsedImage;
  const video = model.tags.includes('视频') ? videoConstraintsFromTable(model.parameterTable) : undefined;
  if (image === undefined && video === undefined) return undefined;
  return {
    ...(image === undefined ? {} : { image }),
    ...(video === undefined ? {} : { video }),
  };
}

function imageConstraintsFromTable(table: ComflyCatalogModel['parameterTable']): NonNullable<ProviderBridgeProfile['constraints']>['image'] {
  if (table === undefined) return undefined;
  const sizes = collectImageSizes(table);
  const aspectRatios = mergeUnique(
    collectTableValues(table, isAspectRatioHeader, parseAspectRatio),
    sizes.flatMap((size) => deriveImageAspectRatio(size) ?? []),
  );
  const resolutions = mergeUnique(
    collectTableValues(table, isResolutionHeader, parseImageResolution),
    sizes.map(deriveImageResolution),
  );
  const outputCounts = collectTableValues(table, isOutputCountHeader, parseOutputCount);
  if (aspectRatios.length === 0 && resolutions.length === 0 && sizes.length === 0 && outputCounts.length === 0) return undefined;
  return {
    ...(aspectRatios.length === 0 ? {} : { aspectRatios }),
    ...(resolutions.length === 0 ? {} : { resolutions }),
    ...(sizes.length === 0 ? {} : { sizes }),
    ...(outputCounts.length === 0 ? {} : { outputCounts }),
  };
}
function videoConstraintsFromTable(table: ComflyCatalogModel['parameterTable']): NonNullable<ProviderBridgeProfile['constraints']>['video'] {
  const aspectRatios = table === undefined ? [] : collectTableValues(table, isAspectRatioHeader, parseAspectRatio);
  const resolutions = table === undefined ? [] : collectTableValues(table, isResolutionHeader, parseVideoResolution);
  const durations = table === undefined ? [] : collectTableValues(table, isDurationHeader, parseDurationSeconds);
  return {
    ...(aspectRatios.length === 0 ? {} : { aspectRatios }),
    ...(resolutions.length === 0 ? {} : { resolutions }),
    ...(durations.length === 0 ? {} : { duration: { mode: 'options' as const, options: durations } }),
    outputCounts: [1],
  };
}

function collectTableValues<T extends string | number>(
  table: NonNullable<ComflyCatalogModel['parameterTable']>,
  matchesHeader: (header: string) => boolean,
  parseValue: (value: string) => T | undefined,
): T[] {
  const columnIndexes = table.headers.flatMap((header, index) => matchesHeader(normalizeHeader(header)) ? [index] : []);
  const values: T[] = [];
  for (const row of table.rows) {
    for (const columnIndex of columnIndexes) {
      const parsed = parseValue(row[columnIndex] ?? '');
      if (parsed !== undefined && !values.includes(parsed)) values.push(parsed);
    }
  }
  return values;
}

function normalizeHeader(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/gu, '');
}

function isResolutionHeader(value: string): boolean {
  return value.includes('分辨率') || value.includes('resolution') || value.includes('quality') || value.includes('质量') || value.includes('清晰度') || value === 'size';
}

function isAspectRatioHeader(value: string): boolean {
  return value.includes('宽高比') || value.includes('画面比例') || value.includes('aspectratio');
}

function isDurationHeader(value: string): boolean {
  return value.includes('时长') || value.includes('duration') || value.includes('seconds');
}

function isOutputCountHeader(value: string): boolean {
  return value.includes('张数') || value.includes('数量') || value.includes('count') || /(?:^|[^a-z])n(?:[^a-z]|$)/u.test(value);
}

function parseAspectRatio(value: string): '1:1' | '2:3' | '3:2' | '4:3' | '3:4' | '16:9' | '9:16' | undefined {
  const normalized = value.replace(/\s+/gu, '');
  return normalized === '1:1' || normalized === '2:3' || normalized === '3:2' || normalized === '4:3' || normalized === '3:4' || normalized === '16:9' || normalized === '9:16'
    ? normalized
    : undefined;
}

type CatalogImageAspectRatio = '1:1' | '2:3' | '3:2' | '4:3' | '3:4' | '16:9' | '9:16';
type CatalogImageResolution = '1K' | '2K' | '4K';

function collectImageSizes(table: NonNullable<ComflyCatalogModel['parameterTable']>): string[] {
  const columnIndexes = table.headers.flatMap((header, index) => isResolutionHeader(normalizeHeader(header)) ? [index] : []);
  const sizes: string[] = [];
  for (const row of table.rows) {
    for (const columnIndex of columnIndexes) {
      const value = row[columnIndex] ?? '';
      for (const match of value.matchAll(/(\d{3,5})\s*[x\u00d7]\s*(\d{3,5})/giu)) {
        const size = String(Number(match[1])) + 'x' + String(Number(match[2]));
        if (!sizes.includes(size)) sizes.push(size);
      }
    }
  }
  return sizes;
}

function deriveImageAspectRatio(size: string): CatalogImageAspectRatio | undefined {
  const dimensions = parseImageSize(size);
  if (dimensions === undefined) return undefined;
  const actual = dimensions.width / dimensions.height;
  const candidates: readonly CatalogImageAspectRatio[] = ['1:1', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9'];
  const nearest = [...candidates].sort((left, right) => ratioDistance(left, actual) - ratioDistance(right, actual))[0];
  return nearest !== undefined && ratioDistance(nearest, actual) <= 0.03 ? nearest : undefined;
}

function deriveImageResolution(size: string): CatalogImageResolution {
  const dimensions = parseImageSize(size);
  const longestEdge = dimensions === undefined ? 0 : Math.max(dimensions.width, dimensions.height);
  if (longestEdge > 2_560) return '4K';
  if (longestEdge > 1_280) return '2K';
  return '1K';
}

function parseImageSize(size: string): { width: number; height: number } | undefined {
  const match = size.match(/^(\d{3,5})x(\d{3,5})$/u);
  if (match === null) return undefined;
  return { width: Number(match[1]), height: Number(match[2]) };
}

function ratioDistance(ratio: CatalogImageAspectRatio, actual: number): number {
  const [width, height] = ratio.split(':').map(Number) as [number, number];
  return Math.abs(Math.log((width / height) / actual));
}

function mergeUnique<T>(...groups: readonly (readonly T[])[]): T[] {
  const merged: T[] = [];
  for (const group of groups) for (const value of group) if (!merged.includes(value)) merged.push(value);
  return merged;
}
function parseImageResolution(value: string): '1K' | '2K' | '4K' | undefined {
  const normalized = value.trim().toLocaleLowerCase();
  if (/(?:^|[^0-9])4k(?:[^0-9]|$)/u.test(normalized)) return '4K';
  if (/(?:^|[^0-9])2k(?:[^0-9]|$)/u.test(normalized)) return '2K';
  if (/(?:^|[^0-9])1k(?:[^0-9]|$)/u.test(normalized)) return '1K';
  return undefined;
}

function parseVideoResolution(value: string): '360p' | '480p' | '512p' | '540p' | '720p' | '768p' | '1080p' | '2K' | '4K' | undefined {
  const normalized = value.trim().toLocaleLowerCase();
  if (/(?:^|[^0-9])4k(?:[^0-9]|$)/u.test(normalized)) return '4K';
  if (/(?:^|[^0-9])2k(?:[^0-9]|$)/u.test(normalized)) return '2K';
  for (const tier of ['1080p', '768p', '720p', '540p', '512p', '480p', '360p'] as const) {
    if (normalized.includes(tier)) return tier;
  }
  const dimensions = normalized.match(/(?:^|[^0-9])(\d{3,4})[x×](\d{3,4})(?:[^0-9]|$)/u);
  if (dimensions !== null) {
    const height = Number(dimensions[2]);
    if (height === 360 || height === 480 || height === 512 || height === 540 || height === 720 || height === 768 || height === 1080) {
      return `${height}p` as '360p' | '480p' | '512p' | '540p' | '720p' | '768p' | '1080p';
    }
  }
  return undefined;
}
function parseDurationSeconds(value: string): number | undefined {
  const match = value.match(/\d+(?:\.\d+)?/u);
  if (match === null) return undefined;
  const seconds = Number(match[0]);
  return Number.isInteger(seconds) && seconds >= 1 && seconds <= 60 ? seconds : undefined;
}

function parseOutputCount(value: string): 1 | 2 | 3 | 4 | undefined {
  const count = Number(value.trim());
  return count === 1 || count === 2 || count === 3 || count === 4 ? count : undefined;
}function capabilitiesForRelayMeModel(model: RelayMeModel): ProviderBridgeProfile['capabilities'] {
  const capabilities: ProviderBridgeProfile['capabilities'] = [];
  if (model.capability === 'image') capabilities.push('image_generation', 'async_tasks');
  if (model.capability === 'video') capabilities.push('video_generation', 'async_tasks');
  if (model.capability === 'text') capabilities.push('chat');
  const explicitlyRejectsImageInput = model.supportsVision === false
    || (model.inputModalities !== undefined && !model.inputModalities.includes('image'));
  const hasImageInput = !explicitlyRejectsImageInput
    && (model.supportsVision === true || model.inputModalities?.includes('image') === true);
  const hasVideoInput = model.inputModalities?.includes('video') === true;
  // RelayMe's public directory can omit image-input metadata for this exact
  // reverse-analysis deployment. Keep the compatibility fallback narrow, and
  // never override explicit text-only or supportsVision=false metadata.
  const isVerifiedReverseFallback = model.deploymentName.trim().toLocaleLowerCase() === 'gemini-3.1-flash-lite';
  const hasVerifiedImageInput = hasImageInput
    || (isVerifiedReverseFallback && !explicitlyRejectsImageInput);
  if (hasVerifiedImageInput) capabilities.push('vision');
  if (model.capability === 'text' && hasVerifiedImageInput) {
    capabilities.push('reverse_prompt');
  }
  if (hasVideoInput) capabilities.push('video_understanding');
  return capabilities;
}

function constraintsForRelayMeModel(model: RelayMeModel): ProviderBridgeProfile['constraints'] {
  if (model.capability === 'image') {
    const resolutions = (['1K', '2K', '4K'] as const).filter((resolution) => model.offers.some((offer) => {
      const key = resolution === '1K' ? 'image1k' : resolution === '2K' ? 'image2k' : 'image4k';
      return offer.pricing?.[key] !== undefined;
    }));
    return { image: { ...(resolutions.length === 0 ? {} : { resolutions: [...resolutions] }), outputCounts: [1, 2, 3, 4] } };
  }
  if (model.capability === 'video') {
    const capabilities = model.videoCapabilities;
    if (capabilities === undefined) return undefined;
    const aspectRatios = capabilities.aspectRatios === undefined ? undefined : [...capabilities.aspectRatios];
    const resolutions = capabilities.resolutions === undefined ? undefined : [...capabilities.resolutions];
    const duration = cloneDuration(capabilities.duration);
    if (aspectRatios === undefined && resolutions === undefined && duration === undefined) return undefined;
    return { video: {
      ...(aspectRatios === undefined ? {} : { aspectRatios }),
      ...(resolutions === undefined ? {} : { resolutions }),
      ...(duration === undefined ? {} : { duration }),
      outputCounts: [1],
    } };
  }
  return undefined;
}

function cloneDuration(duration: NonNullable<RelayMeModel['videoCapabilities']>['duration']) {
  if (duration === undefined) return undefined;
  return duration.mode === 'options'
    ? { ...duration, options: [...duration.options] }
    : { ...duration };
}

function ensureUniqueModelRoutes(profiles: readonly ProviderBridgeProfile[]): ProviderBridgeProfile[] {
  const usedRoutes = new Set<string>();
  return profiles.map((profile) => {
    if (!usedRoutes.has(profile.modelRoute)) {
      usedRoutes.add(profile.modelRoute);
      return profile;
    }
    const identity = profile.modelId ?? profile.displayName;
    const suffix = stableRouteSuffix(identity);
    let modelRoute = `${profile.modelRoute}-${suffix}`;
    let sequence = 2;
    while (usedRoutes.has(modelRoute)) modelRoute = `${profile.modelRoute}-${suffix}-${sequence++}`;
    usedRoutes.add(modelRoute);
    return ProviderBridgeProfileSchema.parse({ ...profile, modelRoute });
  });
}

function stableRouteSuffix(value: string): string {
  let hash = 0x811c9dc5;
  for (const character of value) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36).padStart(7, '0').slice(-7);
}

function routeSlug(value: string): string {
  return value.toLocaleLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '').slice(0, 120) || 'model';
}
