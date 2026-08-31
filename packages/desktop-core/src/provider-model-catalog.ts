import type { ComflyAccessibleModelCatalog, ComflyCatalogModel } from '@agent-canvas/provider-comfly';
import type { RelayMeModel, RelayMeWorkflow } from '@agent-canvas/provider-relayme';
import { ProviderBridgeProfileSchema, type ProviderBridgeProfile } from './provider-contracts.js';

export function buildComflyModelProfiles(catalog: ComflyAccessibleModelCatalog): ProviderBridgeProfile[] {
  const seenModelKeys = new Set<string>();
  const validModels = catalog.models.filter((model) => {
    const key = model.key.trim();
    const name = model.name.trim();
    if (key.length === 0 || name.length === 0 || seenModelKeys.has(key)) return false;
    seenModelKeys.add(key);
    return true;
  });
  return ensureUniqueModelRoutes(validModels.map((model) => ProviderBridgeProfileSchema.parse({
    provider: 'comfly',
    modelRoute: `comfly-${routeSlug(model.key)}`,
    displayName: model.name,
    modelId: model.key,
    capabilities: capabilitiesForComflyModel(model),
    capabilityStatus: model.capabilityStatus,
    constraints: constraintsForComflyModel(model),
  })));
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
  })));
}

function relayMeCapabilityStatus(model: RelayMeModel): ProviderBridgeProfile['capabilityStatus'] {
  // RelayMe image/video generation uses provider-wide direct endpoints. The
  // catalog capability and real deployment id are sufficient; a redundant
  // per-model endpoint list is not required for these routes to run.
  if (model.capability === 'image' || model.capability === 'video') return 'complete';
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
    const parsed = ProviderBridgeProfileSchema.parse(profile);
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
  };
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
  const hasImageGeneration = hasComflyApi(model, '/v1/images/generations');
  const hasImageEdit = hasComflyApi(model, '/v1/images/edits');
  const hasVideoGeneration = hasComflyApi(model, '/v2/videos/generations');
  const hasChat = hasComflyApi(model, '/v1/chat/completions');
  const hasVisionTag = tags.has('识图') || tags.has('图生文') || tags.has('多模态');
  const hasVision = hasChat && hasVisionTag;
  const hasVideoUnderstanding = hasChat && (tags.has('视频分析') || tags.has('视频理解'));
  if (hasImageGeneration) capabilities.push('image_generation');
  if (hasImageEdit) capabilities.push('image_edit');
  if (hasVideoGeneration) capabilities.push('video_generation');
  if (hasChat) capabilities.push('chat');
  if (hasVision) capabilities.push('vision', 'reverse_prompt');
  if (hasVideoUnderstanding) capabilities.push('video_understanding');
  if (hasComflyApi(model, '/v1/responses')) capabilities.push('responses');
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
  const image = model.tags.includes('绘图') ? imageConstraintsFromTable(model.parameterTable) : undefined;
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
  if (model.capability === 'image' && model.supportsImageToImage === true) capabilities.push('image_edit');
  const hasImageInput = model.supportsVision === true || model.inputModalities?.includes('image') === true;
  const hasVideoInput = model.inputModalities?.includes('video') === true;
  const hasChatEndpoint = model.endpoints?.some((endpoint) => endpoint.includes('/chat/completions')) === true;
  if (hasImageInput) capabilities.push('vision');
  if (hasImageInput && model.capability === 'text' && hasChatEndpoint) capabilities.push('reverse_prompt');
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
