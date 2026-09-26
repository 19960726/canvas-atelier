import { z } from 'zod';
import { redactProviderLog } from './redact';
import type {
  ComflyAccessibleModelCatalog,
  ComflyCatalogModel,
  ComflyChatRequest,
  ComflyClientOptions,
  ComflyFetchResponse,
  ComflyGeminiContentRequest,
  ComflyImageEditRequest,
  ComflyImageGenerationRequest,
  ComflyResponsesRequest,
  ComflyVideoGenerationRequest,
} from './types';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_GENERATION_TIMEOUT_MS = 300_000;

const jsonRecordSchema = z.record(z.string(), z.unknown());
const nonEmptyStringSchema = z.string().min(1);
const imageDatumSchema = z.object({
  url: nonEmptyStringSchema.optional(),
  b64_json: nonEmptyStringSchema.optional(),
  revised_prompt: z.string().optional(),
}).passthrough();

const chatResponseSchema = z.object({
  id: nonEmptyStringSchema,
  model: nonEmptyStringSchema,
  choices: z.array(z.object({
    finish_reason: z.string().optional(),
    message: z.object({
      role: nonEmptyStringSchema,
      content: z.unknown(),
    }).passthrough(),
  }).passthrough()).min(1),
}).passthrough();

const responsesResponseSchema = z.object({
  id: nonEmptyStringSchema,
  output: z.array(z.unknown()),
}).passthrough();

const modelInventorySchema = z.object({
  data: z.array(z.unknown()),
}).passthrough();
const modelInventoryEntrySchema = z.object({
  id: z.string().min(1).max(200).regex(/^[A-Za-z0-9._:/-]+$/u),
}).passthrough();
const publicCatalogTagsSchema = z.union([z.string(), z.array(z.string())]).optional().transform((value) => {
  if (Array.isArray(value)) return value.map((item) => item.trim()).filter(Boolean);
  return typeof value === 'string' ? value.split(/[,，]/u).map((item) => item.trim()).filter(Boolean) : [];
});
const publicCatalogParameterTableSchema = z.object({
  headers: z.array(z.union([z.string(), z.number()])).transform((items) => items.map(String)),
  rows: z.array(z.array(z.union([z.string(), z.number()]))).transform((rows) => rows.map((row) => row.map(String))),
}).passthrough().transform((value) => ({ headers: value.headers, rows: value.rows }));
const publicCatalogModelSchema = z.object({
  key: nonEmptyStringSchema,
  name: nonEmptyStringSchema,
  provider: nonEmptyStringSchema.optional().default('Comfly'),
  tags: publicCatalogTagsSchema,
  apis: z.array(nonEmptyStringSchema).optional().default([]),
  supported_endpoint_types: z.array(nonEmptyStringSchema).optional().default([]),
  desc: z.string().optional(),
  ratios: publicCatalogParameterTableSchema.optional(),
}).passthrough().transform(({ supported_endpoint_types: endpointTypes, ...value }) => ({
  ...value,
  endpointTypes,
}));
const publicCatalogSchema = z.object({
  data: z.object({
    version: z.union([z.string(), z.number()]).transform(String),
    models: z.array(publicCatalogModelSchema),
  }).passthrough(),
}).passthrough().transform((value) => value.data);
const publicPricingModelSchema = z.object({
  model_name: nonEmptyStringSchema,
  description: z.string().nullish().transform((value) => value ?? undefined),
  tags: z.union([z.string(), z.array(z.string())]).nullish().transform((value) => {
    if (Array.isArray(value)) return value.map((item) => item.trim()).filter(Boolean);
    return typeof value === 'string' ? value.split(/[,，]/u).map((item) => item.trim()).filter(Boolean) : [];
  }),
  supported_endpoint_types: z.array(nonEmptyStringSchema).nullish().transform((value) => value ?? []),
  apis: z.array(nonEmptyStringSchema).nullish().transform((value) => value ?? []),
  other_info: z.object({
    ratios: publicCatalogParameterTableSchema.optional(),
  }).passthrough().nullish().transform((value) => value ?? undefined),
}).passthrough().transform((value) => ({
  key: value.model_name,
  name: value.model_name,
  provider: 'Comfly',
  tags: value.tags,
  apis: verifiedImageApisFromPricing(value.model_name, value.supported_endpoint_types, value.apis),
  endpointTypes: value.supported_endpoint_types,
  ...(value.description === undefined ? {} : { desc: value.description }),
  ...(value.other_info?.ratios === undefined ? {} : { ratios: value.other_info.ratios }),
}));
const publicPricingSchema = z.object({
  data: z.array(publicPricingModelSchema).max(10_000),
}).passthrough().transform((value) => value.data);

type PublicCatalogMetadata = {
  readonly key: string;
  readonly name: string;
  readonly provider: string;
  readonly tags: readonly string[];
  readonly apis: readonly string[];
  readonly endpointTypes: readonly string[];
  readonly desc?: string;
  readonly ratios?: { readonly headers: readonly string[]; readonly rows: readonly (readonly string[])[] };
};

const IMAGE_GENERATION_ENDPOINT = '/v1/images/generations';
const IMAGE_EDIT_ENDPOINT = '/v1/images/edits';
// Comfly documents this exact model on the shared generations endpoint, with
// optional image[] references, but its public pricing row currently omits both
// `apis` and the `image-generation` endpoint type.
const DOCUMENTED_GENERATIONS_MODELS_WITH_INCOMPLETE_PRICING = new Set(['seedream-v5-pro']);

function verifiedImageApisFromPricing(modelId: string, endpointTypes: readonly string[], apis: readonly string[]): string[] {
  const verified: string[] = [];
  if (DOCUMENTED_GENERATIONS_MODELS_WITH_INCOMPLETE_PRICING.has(modelId)
    || endpointTypes.some((endpoint) => endpoint.trim().toLocaleLowerCase() === 'image-generation')) {
    verified.push(IMAGE_GENERATION_ENDPOINT);
  }
  for (const endpoint of [IMAGE_GENERATION_ENDPOINT, IMAGE_EDIT_ENDPOINT]) {
    if (apis.some((api) => declaresExactApi(api, endpoint)) && !verified.includes(endpoint)) verified.push(endpoint);
  }
  return verified;
}

function hasVerifiedImageApi(apis: readonly string[]): boolean {
  return apis.some((api) => declaresExactApi(api, IMAGE_GENERATION_ENDPOINT) || declaresExactApi(api, IMAGE_EDIT_ENDPOINT));
}

function declaresExactApi(api: string, endpoint: string): boolean {
  const normalizedApi = api.trim().toLocaleLowerCase();
  const normalizedEndpoint = endpoint.toLocaleLowerCase();
  if (normalizedApi === normalizedEndpoint) return true;
  const separator = normalizedApi.indexOf('-');
  if (separator < 0) return false;
  return normalizedApi.slice(separator + 1).replace(/-\d+$/u, '') === normalizedEndpoint;
}

function mergePublicCatalogModels(
  legacyModels: readonly PublicCatalogMetadata[],
  pricingModels: readonly PublicCatalogMetadata[],
): Map<string, PublicCatalogMetadata> {
  const merged = new Map<string, PublicCatalogMetadata>();
  for (const model of [...legacyModels, ...pricingModels]) {
    const current = merged.get(model.key);
    if (current === undefined) {
      merged.set(model.key, {
        ...model,
        tags: [...model.tags],
        apis: [...model.apis],
        endpointTypes: [...model.endpointTypes],
        ...(model.ratios === undefined ? {} : { ratios: { headers: [...model.ratios.headers], rows: model.ratios.rows.map((row) => [...row]) } }),
      });
      continue;
    }
    merged.set(model.key, {
      ...current,
      tags: [...new Set([...current.tags, ...model.tags])],
      apis: [...new Set([...current.apis, ...model.apis])],
      endpointTypes: [...new Set([...current.endpointTypes, ...model.endpointTypes])],
      ...(current.desc !== undefined || model.desc === undefined ? {} : { desc: model.desc }),
      ...(current.ratios !== undefined || model.ratios === undefined
        ? {}
        : { ratios: { headers: [...model.ratios.headers], rows: model.ratios.rows.map((row) => [...row]) } }),
    });
  }
  return merged;
}

const videoTaskSubmissionSchema = z.object({
  task_id: nonEmptyStringSchema,
}).passthrough().transform((value) => ({ taskId: value.task_id }));
const videoTaskStateSchema = z.object({
  task_id: nonEmptyStringSchema,
  status: nonEmptyStringSchema,
  progress: z.number().finite().optional(),
  fail_reason: z.string().optional(),
  data: z.object({
    output: nonEmptyStringSchema.optional(),
    duration: z.number().finite().positive().optional(),
    resolution: z.string().optional(),
    ratio: z.string().optional(),
  }).passthrough().optional(),
}).passthrough().transform((value) => ({
  taskId: value.task_id,
  status: value.status,
  ...(value.progress === undefined ? {} : { progress: value.progress }),
  ...(value.fail_reason === undefined ? {} : { failReason: value.fail_reason }),
  ...(value.data === undefined ? {} : { data: value.data }),
}));
const imageTaskEnvelopeSchema = z.object({
  taskId: nonEmptyStringSchema.optional(),
  task_id: nonEmptyStringSchema.optional(),
  status: nonEmptyStringSchema,
  data: z.unknown().optional(),
}).passthrough().refine((value) => value.taskId !== undefined || value.task_id !== undefined, {
  message: 'image task id is required',
}).transform(({ taskId, task_id: taskIdSnakeCase, status, data, ...rest }) => ({
  ...rest,
  taskId: taskId ?? taskIdSnakeCase!,
  status,
  ...(data === undefined ? {} : { data }),
}));
const imageTaskSchema = z.union([
  imageTaskEnvelopeSchema,
  z.object({ data: imageTaskEnvelopeSchema }).passthrough().transform((value) => value.data),
]);

const imageTaskSubmissionEnvelopeSchema = z.object({
  taskId: nonEmptyStringSchema.optional(),
  task_id: nonEmptyStringSchema.optional(),
  status: nonEmptyStringSchema.optional(),
  data: z.unknown().optional(),
}).passthrough().refine((value) => value.taskId !== undefined || value.task_id !== undefined, {
  message: 'image task id is required',
}).transform(({ taskId, task_id: taskIdSnakeCase, status, data, ...rest }) => ({
  ...rest,
  taskId: taskId ?? taskIdSnakeCase!,
  status: status ?? 'queued',
  ...(data === undefined ? {} : { data }),
}));
const imageTaskSubmissionSchema = z.union([
  imageTaskSubmissionEnvelopeSchema,
  z.object({ data: imageTaskSubmissionEnvelopeSchema }).passthrough().transform((value) => value.data),
]);

const imageResultSchema = z.union([
  z.object({
    created: z.number().int().optional(),
    data: z.array(imageDatumSchema).min(1),
  }).passthrough(),
  imageTaskSchema,
]);
const imageGenerationResultSchema = z.union([
  z.object({
    created: z.number().int().optional(),
    data: z.array(imageDatumSchema).min(1),
  }).passthrough(),
  imageTaskSubmissionSchema,
]);

const geminiResponseSchema = z.object({
  candidates: z.array(z.object({
    finishReason: z.string().optional(),
    content: z.object({
      parts: z.array(z.unknown()).optional(),
      role: z.string().optional(),
    }).passthrough().optional(),
  }).passthrough()).min(1),
}).passthrough();

const errorBodySchema = z.union([
  z.object({
    error: z.object({
      message: nonEmptyStringSchema,
      type: z.string().optional(),
      code: z.union([z.string(), z.number()]).optional(),
    }).passthrough(),
  }).passthrough(),
  z.object({
    message: nonEmptyStringSchema,
  }).passthrough(),
]);

export interface GeminiInlineImagePart {
  readonly mimeType: string;
  readonly data: string;
}

export function decodeGeminiInlineImage(part: GeminiInlineImagePart): Uint8Array {
  if (!part.mimeType.startsWith('image/') || !/^[A-Za-z0-9+/]*={0,2}$/u.test(part.data) || part.data.length % 4 !== 0) {
    throw new Error('Provider returned invalid inline image data');
  }
  const bytes = Buffer.from(part.data, 'base64');
  if (bytes.length === 0) throw new Error('Provider returned empty inline image data');
  return new Uint8Array(bytes);
}

export function parseGeminiImageResponse(value: unknown): GeminiInlineImagePart[] {
  if (!value || typeof value !== 'object') return [];
  const candidates = (value as { candidates?: unknown }).candidates;
  if (!Array.isArray(candidates)) return [];
  const images: GeminiInlineImagePart[] = [];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const content = (candidate as { content?: unknown }).content;
    if (!content || typeof content !== 'object') continue;
    const parts = (content as { parts?: unknown }).parts;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      if (!part || typeof part !== 'object') continue;
      const inlineData = (part as { inlineData?: unknown }).inlineData;
      if (!inlineData || typeof inlineData !== 'object') continue;
      const mimeType = (inlineData as { mimeType?: unknown }).mimeType;
      const data = (inlineData as { data?: unknown }).data;
      if (typeof mimeType === 'string' && mimeType.startsWith('image/') && typeof data === 'string' && data.length > 0) {
        images.push({ mimeType, data });
      }
    }
  }
  return images;
}

type ComflyImageResolutionTier = '1K' | '2K' | '4K';
type ComflyProviderImageSize = NonNullable<ComflyImageGenerationRequest['size']>;
type ComflyImageAspectRatio = NonNullable<ComflyImageGenerationRequest['aspect_ratio']>;
type ComflyImageGenerationInput = {
  readonly model: string;
  readonly prompt: string;
  readonly async?: boolean;
  readonly image?: unknown;
  readonly aspect_ratio?: ComflyImageAspectRatio;
  readonly size?: ComflyProviderImageSize | ComflyImageResolutionTier;
  readonly n?: 1 | 2 | 3 | 4;
  readonly [key: string]: unknown;
};

export function mapComflyImageResolutionTier(
  tier: ComflyImageResolutionTier,
  aspectRatio: ComflyImageAspectRatio = '1:1',
): ComflyProviderImageSize {
  if (tier === '4K') {
    const error = new Error('Comfly image generation does not support native 4K output') as Error & {
      code: 'CAPABILITY_UNSUPPORTED'; retryable: boolean;
    };
    error.code = 'CAPABILITY_UNSUPPORTED';
    error.retryable = false;
    throw error;
  }
  if (tier === '1K') return '1024x1024';
  return aspectRatio === '3:4' || aspectRatio === '9:16' ? '1024x1536' : '1536x1024';
}

function roundTo16(value: number): number {
  return Math.max(16, Math.round(value / 16) * 16);
}

function floorTo16(value: number): number {
  return Math.max(16, Math.floor(value / 16) * 16);
}

export function mapComflyGptImageExactSize(
  tier: ComflyImageResolutionTier,
  aspectRatio: ComflyImageAspectRatio = '1:1',
): string {
  if (aspectRatio === '1:1') return tier === '1K' ? '1024x1024' : tier === '2K' ? '2048x2048' : '2880x2880';
  if (tier === '2K') {
    const [rw, rh] = aspectRatio.split(':').map(Number) as [number, number];
    const shortEdge = roundTo16(2048 * Math.min(rw, rh) / Math.max(rw, rh));
    return rw > rh ? `2048x${shortEdge}` : `${shortEdge}x2048`;
  }
  if (tier === '4K' && aspectRatio === '16:9') return '3840x2160';
  if (tier === '4K' && aspectRatio === '9:16') return '2160x3840';

  const [rw, rh] = aspectRatio.split(':').map(Number) as [number, number];
  const targetArea = tier === '1K' ? 1_048_576 : 8_294_400;
  let width = roundTo16(Math.sqrt(targetArea * rw / rh));
  let height = roundTo16(width * rh / rw);
  while (width > 3840 || height > 3840 || width * height > 8_294_400) {
    const scale = Math.min(3840 / width, 3840 / height, Math.sqrt(8_294_400 / (width * height)));
    width = floorTo16(width * scale);
    height = floorTo16(height * scale);
  }
  return `${width}x${height}`;
}

function mapComflyImageGenerationInput(input: ComflyImageGenerationInput): Record<string, unknown> {
  const { async: _async, ...request } = input;
  if (input.model === 'nano-banana' || input.model === 'nano-banana-hd') {
    // These legacy routes select resolution by model id; the HD route is the
    // provider's native 4K variant, not a generic 1536px or image_size request.
    const { size, ...rest } = request;
    const nativeTier = input.model === 'nano-banana-hd' ? '4K' : '1K';
    if ((size === '1K' || size === '2K' || size === '4K') && size !== nativeTier) {
      throw Object.assign(new Error(`${input.model} uses its native ${nativeTier} route`), { code: 'CAPABILITY_UNSUPPORTED', retryable: false });
    }
    return rest;
  }
  if (input.model === 'dall-e-3') {
    const { aspect_ratio: ratio = '1:1', quality, ...rest } = request;
    if (input.size === '4K') throw Object.assign(new Error('DALL-E 3 supports native sizes up to 1792 pixels'), { code: 'CAPABILITY_UNSUPPORTED', retryable: false });
    const [width, height] = String(ratio).split(':').map(Number);
    const size = input.size === '1K' || input.size === '2K'
      ? width === height ? '1024x1024' : width! > height! ? '1792x1024' : '1024x1792'
      : input.size;
    return { ...rest, ...(size === undefined ? {} : { size }), quality: quality === 'high' || quality === 'hd' || quality === undefined ? 'hd' : 'standard' };
  }
  if (input.model === 'gpt-image-2-all' && (input.size === '2K' || input.size === '4K')) {
    throw Object.assign(new Error('GPT Image 2 All supports the 1K output tier only'), { code: 'CAPABILITY_UNSUPPORTED', retryable: false });
  }
  if (input.size !== '1K' && input.size !== '2K' && input.size !== '4K') return request;
  if (isNanoBananaImageModel(input.model)) {
    const { size, ...rest } = request;
    return { ...rest, image_size: size };
  }
  if (isGptImageExactSizeModel(input.model)) {
    const { aspect_ratio: _aspectRatio, ...rest } = request;
    return { ...rest, size: mapComflyGptImageExactSize(input.size, input.aspect_ratio) };
  }
  if (isComflyGptImageModel(input.model)) {
    // GPT Image 1/1.5 accept the three native sizes, not resolution tiers or
    // aspect_ratio. Keep square requests square even at the UI's default 2K.
    const { aspect_ratio: ratio = '1:1', ...rest } = request;
    if (input.size === '4K') return { ...rest, size: mapComflyImageResolutionTier(input.size, input.aspect_ratio) };
    const [width, height] = String(ratio).split(':').map(Number);
    return { ...rest, size: width === height ? '1024x1024' : width! > height! ? '1536x1024' : '1024x1536' };
  }
  // Seedream V5's documented unified request accepts the provider tier itself
  // (`size: "2K"`). Converting it to a generic pixel pair changes the contract.
  if (input.model === 'seedream-v5-pro') return request;
  return { ...request, size: mapComflyImageResolutionTier(input.size, input.aspect_ratio) };
}

function isGptImageExactSizeModel(model: string): boolean {
  return /^gpt-image-2(?:-(?:all|2k|4k|vip)|\.5-(?:flare|sunburst)(?:-(?:2k|4k))?)?$/u
    .test(model.trim().toLocaleLowerCase());
}

export function isComflyGptImageModel(model: string): boolean {
  return isGptImageExactSizeModel(model)
    || /^gpt-image-1(?:\.5|-mini)?(?:-\d{4}-\d{2}-\d{2})?$/u.test(model.trim().toLocaleLowerCase());
}

function isNanoBananaImageModel(model: string): boolean {
  // Comfly exposes Gemini 3.1 Flash Image through the same image-generation
  // contract as Nano Banana. Preserve the provider's resolution tier instead
  // of converting 2K/4K to the generic size field (or rejecting native 4K).
  if (/^gemini-3\.1-flash-image-preview(?:-(?:512px|2k|4k))?$/u.test(model)) return true;
  return /^nano-banana-(?:2|pro)(?:-(?:2k|4k))?$/u.test(model.trim().toLocaleLowerCase());
}
export class ComflyClient {
  private readonly baseUrl: string;
  private readonly tokenSupplier: () => Promise<string>;
  private readonly fetch: ComflyClientOptions['fetch'];
  private readonly timeoutMs: number;
  private readonly generationTimeoutMs: number;

  constructor(options: ComflyClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.tokenSupplier = options.tokenSupplier;
    this.fetch = options.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.generationTimeoutMs = options.generationTimeoutMs ?? DEFAULT_GENERATION_TIMEOUT_MS;
  }

  async checkConnection(): Promise<void> {
    await this.request('/v1/models', {
      method: 'GET',
      schema: modelInventorySchema,
    });
  }

  async listModelIds(): Promise<string[]> {
    const inventory = await this.request('/v1/models', {
      method: 'GET',
      schema: modelInventorySchema,
    });
    return inventory.data.flatMap((entry) => {
      const parsed = modelInventoryEntrySchema.safeParse(entry);
      return parsed.success ? [parsed.data.id] : [];
    });
  }

  async listAccessibleModelCatalog(): Promise<ComflyAccessibleModelCatalog> {
    const [visibleModelIds, catalog, pricingModels] = await Promise.all([
      this.listModelIds(),
      this.publicRequest('/api/models/price', publicCatalogSchema),
      this.publicRequest('/api/pricing', publicPricingSchema).catch(() => undefined),
    ]);
    const catalogByKey = mergePublicCatalogModels(catalog.models, pricingModels ?? []);
    const models: ComflyCatalogModel[] = visibleModelIds.map((modelId) => {
      const metadata = catalogByKey.get(modelId);
      if (metadata === undefined) {
        return {
          key: modelId,
          name: modelId,
          provider: 'Comfly',
          tags: [],
          apis: [],
          capabilityStatus: 'incomplete',
        };
      }
      return {
        key: metadata.key,
        name: metadata.name,
        provider: metadata.provider,
        tags: [...metadata.tags],
        apis: [...metadata.apis],
        endpointTypes: [...metadata.endpointTypes],
        ...(metadata.desc === undefined ? {} : { description: metadata.desc }),
        ...(metadata.ratios === undefined ? {} : { parameterTable: metadata.ratios }),
        // Generic provider-wide API lists are not enough to make a model
        // runnable. Exact image generation/edit paths are model-level positive
        // evidence, including for newer pricing entries whose tags are empty.
        capabilityStatus: metadata.tags.length > 0 || hasVerifiedImageApi(metadata.apis) ? 'complete' : 'incomplete',
      };
    });
    return { version: catalog.version, models };
  }

  async chat(input: ComflyChatRequest, timeoutMs = this.timeoutMs) {
    return this.request('/v1/chat/completions', {
      method: 'POST',
      body: input,
      model: input.model,
      schema: chatResponseSchema,
      timeoutMs,
    });
  }

  async responses(input: ComflyResponsesRequest, timeoutMs = this.timeoutMs) {
    return this.request('/v1/responses', {
      method: 'POST',
      body: input,
      model: input.model,
      schema: responsesResponseSchema,
      timeoutMs,
    });
  }

  async generateVideo(input: ComflyVideoGenerationRequest) {
    return this.request('/v2/videos/generations', {
      method: 'POST',
      body: { ...input },
      model: input.model,
      schema: videoTaskSubmissionSchema,
    });
  }

  async getVideoTask(taskId: string) {
    return this.request(`/v2/videos/generations/${encodeURIComponent(taskId)}`, {
      method: 'GET',
      schema: videoTaskStateSchema,
    });
  }
  async generateImage(input: ComflyImageGenerationInput) {
    const suffix = input.async === true ? '?async=true' : '';
    return this.request(`/v1/images/generations${suffix}`, {
      method: 'POST',
      body: mapComflyImageGenerationInput(input),
      model: input.model,
      schema: imageGenerationResultSchema,
      timeoutMs: this.generationTimeoutMs,
    });
  }

  async editImage(input: ComflyImageEditRequest) {
    // Comfly's async switch is a query parameter for edits as well as
    // generations. Dropping it leaves large reference edits waiting on one
    // synchronous connection until the provider's gateway can time out.
    const endpoint = `/v1/images/edits${input.async === true ? '?async=true' : ''}`;
    if (isComflyGptImageModel(input.model)) {
      const references = z.array(z.object({ mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']), bytes: z.instanceof(Uint8Array) })).min(1).parse(input.image);
      const { image: _image, ...parameters } = mapComflyImageGenerationInput(input as ComflyImageGenerationInput);
      const form = new FormData();
      for (const [name, value] of Object.entries(parameters)) {
        if (value !== undefined) form.append(name, String(value));
      }
      for (const [index, reference] of references.entries()) {
        const extension = reference.mediaType.split('/')[1];
        form.append('image', new Blob([Uint8Array.from(reference.bytes)], { type: reference.mediaType }), `reference-${index + 1}.${extension}`);
      }
      // Serialize with the platform encoder; Electron net requires raw bytes.
      const encoded = new Response(form);
      return this.request(endpoint, {
        method: 'POST',
        rawBody: new Uint8Array(await encoded.arrayBuffer()),
        contentType: encoded.headers.get('content-type')!,
        model: input.model,
        schema: imageGenerationResultSchema,
        timeoutMs: this.generationTimeoutMs,
      });
    }
    const { async: _async, ...body } = input;
    return this.request(endpoint, {
      method: 'POST',
      body,
      model: input.model,
      schema: input.async === true ? imageGenerationResultSchema : imageResultSchema,
    });
  }

  async getImageTask(taskId: string) {
    return this.request(`/v1/images/tasks/${encodeURIComponent(taskId)}`, {
      method: 'GET',
      schema: imageTaskSchema,
    });
  }

  async generateGeminiContent(input: ComflyGeminiContentRequest, timeoutMs = this.timeoutMs) {
    const { model, ...body } = input;
    return this.request(`/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      body,
      model,
      schema: geminiResponseSchema,
      timeoutMs,
    });
  }

  async generateGeminiImage(input: {
    readonly model: string;
    readonly prompt: string;
    readonly images?: readonly { readonly mediaType: string; readonly bytes: Uint8Array }[];
  }) {
    const parts = [
      { text: input.prompt },
      ...(input.images ?? []).map((image) => ({
        inlineData: {
          mimeType: image.mediaType,
          data: Buffer.from(image.bytes).toString('base64'),
        },
      })),
    ];
    const response = await this.generateGeminiContent({ model: input.model, generationConfig: { responseModalities: ['IMAGE'] }, contents: [{ role: 'user', parts }] }, this.generationTimeoutMs);
    const image = parseGeminiImageResponse(response)[0];
    if (image === undefined) throw new Error('Provider returned an invalid image response');
    return { mimeType: image.mimeType, bytes: decodeGeminiInlineImage(image) };
  }

  private async publicRequest<T>(path: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>): Promise<T> {
    const controller = new AbortController();
    const timer = this.timeoutMs > 0 ? globalThis.setTimeout(() => controller.abort(), this.timeoutMs) : null;
    try {
      const response = await this.fetch(`${this.baseUrl}${path}`, { method: 'GET', headers: {}, signal: controller.signal });
      return await this.parseResponse(response, path, { method: 'GET', schema });
    } catch (error) {
      if (controller.signal.aborted) throw new Error(buildTimeoutMessage(path, undefined, this.timeoutMs));
      throw new Error(buildFailureMessage(path, undefined, error));
    } finally {
      if (timer !== null) globalThis.clearTimeout(timer);
    }
  }

  private async request<T>(
    path: string,
    options: {
      readonly method: 'GET' | 'POST';
      readonly body?: Record<string, unknown>;
      readonly rawBody?: Uint8Array;
      readonly contentType?: string;
      readonly model?: string;
      readonly schema: z.ZodType<T, z.ZodTypeDef, unknown>;
      readonly timeoutMs?: number;
    },
  ): Promise<T> {
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const controller = new AbortController();
    const timer = timeoutMs > 0
      ? globalThis.setTimeout(() => controller.abort(), timeoutMs)
      : null;

    try {
      const token = await this.tokenSupplier();
      const response = await this.fetch(`${this.baseUrl}${path}`, {
        method: options.method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(options.contentType === undefined ? {} : { 'content-type': options.contentType }),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        ...(options.rawBody === undefined ? {} : { body: options.rawBody }),
        signal: controller.signal,
        timeoutMs,
      });
      return await this.parseResponse(response, path, options);
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(buildTimeoutMessage(path, options.model, timeoutMs));
      }
      throw new Error(buildFailureMessage(path, options.model, error));
    } finally {
      if (timer !== null) {
        globalThis.clearTimeout(timer);
      }
    }
  }

  private async parseResponse<T>(
    response: ComflyFetchResponse,
    path: string,
    options: {
      readonly method: 'GET' | 'POST';
      readonly model?: string;
      readonly schema: z.ZodType<T, z.ZodTypeDef, unknown>;
    },
  ): Promise<T> {
    const body = await response.json();
    if (!response.ok) {
      throw new Error(buildApiErrorMessage(path, options.model, response.status, body));
    }
    try {
      return options.schema.parse(body);
    } catch (error) {
      throw new Error(buildInvalidResponseMessage(path, options.model, error));
    }
  }
}

export function normalizeBaseUrl(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/u, '');
  if (normalized.length === 0) {
    throw new Error('Comfly base URL is required');
  }
  return normalized;
}

function buildApiErrorMessage(path: string, model: string | undefined, status: number, body: unknown): string {
  const parsed = errorBodySchema.safeParse(body);
  const detail = parsed.success
    ? extractErrorMessage(parsed.data)
    : 'Provider returned an invalid error response';
  return `Comfly request failed with status ${status} for ${describeRequest(path, model)}: ${redactProviderLog(detail)}`;
}

function buildInvalidResponseMessage(path: string, model: string | undefined, error: unknown): string {
  return `Invalid Comfly response for ${describeRequest(path, model)}: ${redactProviderLog(formatIssueSummary(error))}`;
}

function buildFailureMessage(path: string, model: string | undefined, error: unknown): string {
  return `Comfly request failed for ${describeRequest(path, model)}: ${redactProviderLog(error)}`;
}

function buildTimeoutMessage(path: string, model: string | undefined, timeoutMs: number): string {
  return `Comfly request timed out after ${timeoutMs}ms for ${describeRequest(path, model)}`;
}

function describeRequest(path: string, model: string | undefined): string {
  return model === undefined ? path : `${path} [model=${model}]`;
}

function extractErrorMessage(value: z.infer<typeof errorBodySchema>): string {
  const nested = value as { error?: { message?: unknown }; message?: unknown };
  if (typeof nested.error?.message === 'string') {
    return nested.error.message;
  }
  if (typeof nested.message === 'string') {
    return nested.message;
  }
  return 'Provider returned an invalid error response';
}

function formatIssueSummary(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues.map((issue) => issue.message).join('; ');
  }
  if (jsonRecordSchema.safeParse(error).success) {
    return JSON.stringify(error);
  }
  return error instanceof Error ? error.message : String(error);
}
