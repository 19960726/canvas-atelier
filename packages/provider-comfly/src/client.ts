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
const DEFAULT_GENERATION_TIMEOUT_MS = 180_000;

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
  desc: z.string().optional(),
  ratios: publicCatalogParameterTableSchema.optional(),
}).passthrough();
const publicCatalogSchema = z.object({
  data: z.object({
    version: z.union([z.string(), z.number()]).transform(String),
    models: z.array(publicCatalogModelSchema),
  }).passthrough(),
}).passthrough().transform((value) => value.data);

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
}).transform((value) => ({
  ...value,
  taskId: value.taskId ?? value.task_id!,
}));
const imageTaskSchema = z.union([
  imageTaskEnvelopeSchema,
  z.object({ data: imageTaskEnvelopeSchema }).passthrough().transform((value) => value.data),
]);

const imageResultSchema = z.union([
  z.object({
    created: z.number().int().optional(),
    data: z.array(imageDatumSchema).min(1),
  }).passthrough(),
  imageTaskSchema,
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

function mapComflyImageGenerationInput(input: ComflyImageGenerationInput): Record<string, unknown> {
  if (input.size !== '1K' && input.size !== '2K' && input.size !== '4K') return input;
  if (isNanoBananaImageModel(input.model)) {
    const { size, ...rest } = input;
    return { ...rest, image_size: size };
  }
  if (input.model.toLocaleLowerCase() === 'gpt-image-2') return input;
  return { ...input, size: mapComflyImageResolutionTier(input.size, input.aspect_ratio) };
}

function isNanoBananaImageModel(model: string): boolean {
  return /^nano-banana-(?:2|pro)(?:-(?:2k|4k))?$/iu.test(model.trim());
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
    const [visibleModelIds, catalog] = await Promise.all([
      this.listModelIds(),
      this.publicRequest('/api/models/price', publicCatalogSchema),
    ]);
    const catalogByKey = new Map(catalog.models.map((model) => [model.key, model]));
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
        ...(metadata.desc === undefined ? {} : { description: metadata.desc }),
        ...(metadata.ratios === undefined ? {} : { parameterTable: metadata.ratios }),
        // The public API list can be provider-wide (for example Midjourney
        // exposes describe/video endpoints on every operation entry). It is
        // not sufficient evidence that this particular model has that
        // capability; only an explicit model tag makes the profile complete.
        capabilityStatus: metadata.tags.length > 0 ? 'complete' : 'incomplete',
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

  async responses(input: ComflyResponsesRequest) {
    return this.request('/v1/responses', {
      method: 'POST',
      body: input,
      model: input.model,
      schema: responsesResponseSchema,
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
      schema: imageResultSchema,
      timeoutMs: this.generationTimeoutMs,
    });
  }

  async editImage(input: ComflyImageEditRequest) {
    return this.request('/v1/images/edits', {
      method: 'POST',
      body: input,
      model: input.model,
      schema: imageResultSchema,
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
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
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
