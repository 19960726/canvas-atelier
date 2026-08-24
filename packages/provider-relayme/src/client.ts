import { z } from 'zod';
import type {
  RelayMeChatRequest,
  RelayMeClientOptions,
  RelayMeFetchResponse,
  RelayMeImageGenerationRequest,
  RelayMeModel,
  RelayMeModelOffer,
  RelayMeVideoGenerationRequest,
} from './types';

const DEFAULT_BASE_URL = 'https://www.ml.relayme.uk/api/ai-tools/v1';
const DEFAULT_TIMEOUT_MS = 30_000;
const nonEmptyStringSchema = z.string().min(1);
const pricingSchema = z.record(z.string(), z.union([z.string(), z.number()])).transform((value) => Object.fromEntries(
  Object.entries(value).map(([key, item]) => [key, String(item)]),
));
const durationSchema = z.union([
  z.object({
    mode: z.literal('options'),
    defaultValue: z.number().finite().positive().optional(),
    options: z.array(z.number().finite().positive()).min(1),
  }).passthrough(),
  z.object({
    mode: z.literal('range'),
    defaultValue: z.number().finite().positive().optional(),
    min: z.number().finite().positive(),
    max: z.number().finite().positive(),
    step: z.number().finite().positive(),
  }).passthrough(),
]);
const aspectRatioSchema = z.enum(['1:1', '2:3', '3:2', '4:3', '3:4', '16:9', '9:16']);
const videoResolutionSchema = z.enum(['360p', '480p', '512p', '540p', '720p', '768p', '1080p', '2K', '4K']);
const modelTypeSchema = z.enum(['IMAGE', 'TEXT', 'VIDEO']);
const modelEntrySchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String).optional(),
  name: nonEmptyStringSchema,
  model: nonEmptyStringSchema.optional(),
  originalName: z.string().optional(),
  deploymentName: nonEmptyStringSchema.optional(),
  capability: z.enum(['text', 'image', 'video']).optional(),
  modelType: modelTypeSchema.optional(),
  type: modelTypeSchema.optional(),
  endpoints: z.array(nonEmptyStringSchema).optional(),
  inputModalities: z.array(z.enum(['text', 'image', 'video', 'audio'])).optional(),
  supportsVision: z.boolean().optional(),
  supportsImageToImage: z.boolean().optional(),
  description: z.string().optional(),
  isDefault: z.boolean().optional().default(false),
  isSpecialOffer: z.boolean().optional().default(false),
  pricing: pricingSchema.optional(),
  videoCapabilities: z.object({
    resolutions: z.array(videoResolutionSchema).min(1).optional(),
    aspectRatios: z.array(aspectRatioSchema).min(1).optional(),
    duration: durationSchema.optional(),
  }).passthrough().optional(),
}).passthrough().superRefine((value, context) => {
  if (value.model === undefined && value.deploymentName === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['model'], message: 'RelayMe model identifier is required' });
  }
  if (value.capability === undefined && value.modelType === undefined && value.type === undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['capability'], message: 'RelayMe model capability is required' });
  }
});
const modelEntriesSchema = z.array(modelEntrySchema);
const modelListSchema = z.union([
  z.object({ models: modelEntriesSchema }).passthrough().transform((value) => value.models),
  z.object({ data: modelEntriesSchema }).passthrough().transform((value) => value.data),
  z.object({ data: z.object({ models: modelEntriesSchema }).passthrough() }).passthrough().transform((value) => value.data.models),
]);const chatResponseSchema = z.object({
  id: nonEmptyStringSchema,
  model: nonEmptyStringSchema,
  choices: z.array(z.object({
    message: z.object({ role: nonEmptyStringSchema, content: z.unknown() }).passthrough(),
  }).passthrough()).min(1),
}).passthrough();
const taskSubmissionItemSchema = z.object({
  taskId: nonEmptyStringSchema,
  status: nonEmptyStringSchema.optional().default('PENDING'),
}).passthrough();
const taskStateItemSchema = z.object({
  taskId: nonEmptyStringSchema.optional(),
  status: nonEmptyStringSchema,
  imageContent: z.string().optional(),
  videoContent: z.string().optional(),
  error: z.string().optional(),
  progress: z.number().finite().optional(),
  result: z.unknown().optional(),
  data: z.unknown().optional(),
}).passthrough();
const taskSubmissionSchema = z.union([
  taskSubmissionItemSchema,
  z.object({ data: taskSubmissionItemSchema }).passthrough().transform((value) => value.data),
]);
const taskStateSchema = z.union([
  taskStateItemSchema,
  z.object({ data: taskStateItemSchema }).passthrough().transform((value) => value.data),
]);const errorBodySchema = z.union([
  z.object({ error: z.object({ message: nonEmptyStringSchema }).passthrough() }).passthrough(),
  z.object({ error: nonEmptyStringSchema, success: z.boolean().optional() }).passthrough(),
  z.object({ message: nonEmptyStringSchema }).passthrough(),
]);

export class RelayMeClient {
  private readonly baseUrl: string;
  private readonly tokenSupplier: RelayMeClientOptions['tokenSupplier'];
  private readonly fetch: RelayMeClientOptions['fetch'];
  private readonly timeoutMs: number;

  constructor(options: RelayMeClientOptions) {
    this.baseUrl = normalizeRelayMeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
    this.tokenSupplier = options.tokenSupplier;
    this.fetch = options.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async checkConnection(): Promise<void> {
    await this.listModels();
  }

  async listModels(): Promise<RelayMeModel[]> {
    const response = await this.request('/models', { method: 'GET', schema: modelListSchema });
    return mergeModelOffers(response);
  }

  async chat(input: RelayMeChatRequest) {
    return this.request('/chat/completions', { method: 'POST', body: input, schema: chatResponseSchema });
  }

  async generateImage(input: RelayMeImageGenerationRequest) {
    return this.request('/images/generations', { method: 'POST', body: input, schema: taskSubmissionSchema });
  }

  async generateVideo(input: RelayMeVideoGenerationRequest) {
    return this.request('/videos/generations', { method: 'POST', body: input, schema: taskSubmissionSchema });
  }

  async getTask(taskId: string) {
    return this.request(`/tasks/${encodeURIComponent(taskId)}`, { method: 'GET', schema: taskStateSchema });
  }

  async cancelTask(_taskId: string): Promise<never> {
    const error = new Error('RelayMe 当前没有公开可验证的任务取消接口') as Error & {
      code: 'CAPABILITY_UNSUPPORTED'; retryable: boolean;
    };
    error.code = 'CAPABILITY_UNSUPPORTED';
    error.retryable = false;
    throw error;
  }

  private async request<T>(
    path: string,
    options: {
      readonly method: 'GET' | 'POST';
      readonly body?: object;
      readonly schema: z.ZodType<T, z.ZodTypeDef, unknown>;
    },
  ): Promise<T> {
    const controller = new AbortController();
    const timer = this.timeoutMs > 0 ? globalThis.setTimeout(() => controller.abort(), this.timeoutMs) : null;
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
      });
      return await parseResponse(response, path, options.schema);
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`RelayMe 请求在 ${this.timeoutMs}ms 后 timed out: ${path}`);
      }
      if (isRelayMeError(error)) throw error;
      throw new Error(`RelayMe 请求失败: ${path}: ${sanitizeRelayMeMessage(error)}`);
    } finally {
      if (timer !== null) globalThis.clearTimeout(timer);
    }
  }
}

export function normalizeRelayMeBaseUrl(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/u, '');
  if (normalized.length === 0) throw new Error('RelayMe base URL is required');
  try {
    const url = new URL(normalized);
    if (url.hostname.toLowerCase() === 'api.relayme.ai') {
      url.hostname = 'www.ml.relayme.uk';
      return url.toString().replace(/\/$/u, '');
    }
  } catch {
    return normalized;
  }
  return normalized;
}

function mergeModelOffers(entries: readonly z.infer<typeof modelEntrySchema>[]): RelayMeModel[] {
  const merged = new Map<string, RelayMeModel>();
  for (const entry of entries) {
    const deploymentName = entry.model ?? entry.deploymentName;
    const modelType = entry.modelType ?? entry.type ?? capabilityToModelType(entry.capability);
    const capability = entry.capability ?? modelTypeToCapability(modelType);
    if (deploymentName === undefined || modelType === undefined || capability === undefined) continue;
    const offer: RelayMeModelOffer = {
      id: entry.id ?? deploymentName,
      specialOffer: entry.isSpecialOffer,
      ...(entry.pricing === undefined ? {} : { pricing: entry.pricing }),
    };
    const current = merged.get(deploymentName);
    if (current !== undefined) {
      merged.set(deploymentName, { ...current, offers: [...current.offers, offer] });
      continue;
    }
    merged.set(deploymentName, {
      name: entry.name,
      deploymentName,
      ...(entry.originalName === undefined ? {} : { originalName: entry.originalName }),
      capability,
      modelType,
      ...(entry.endpoints === undefined ? {} : { endpoints: [...entry.endpoints] }),
      ...(entry.inputModalities === undefined ? {} : { inputModalities: [...entry.inputModalities] }),
      ...(entry.supportsVision === undefined ? {} : { supportsVision: entry.supportsVision }),
      ...(entry.supportsImageToImage === undefined ? {} : { supportsImageToImage: entry.supportsImageToImage }),
      ...(entry.description === undefined ? {} : { description: entry.description }),
      isDefault: entry.isDefault,
      offers: [offer],
      ...(entry.videoCapabilities === undefined ? {} : { videoCapabilities: entry.videoCapabilities }),
    });
  }
  return [...merged.values()];
}

function capabilityToModelType(capability: 'text' | 'image' | 'video' | undefined): RelayMeModel['modelType'] | undefined {
  if (capability === 'image') return 'IMAGE';
  if (capability === 'video') return 'VIDEO';
  if (capability === 'text') return 'TEXT';
  return undefined;
}

function modelTypeToCapability(modelType: RelayMeModel['modelType'] | undefined): RelayMeModel['capability'] | undefined {
  if (modelType === 'IMAGE') return 'image';
  if (modelType === 'VIDEO') return 'video';
  if (modelType === 'TEXT') return 'text';
  return undefined;
}
async function parseResponse<T>(response: RelayMeFetchResponse, path: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>): Promise<T> {
  const body = await response.json();
  if (!response.ok) {
    const parsed = errorBodySchema.safeParse(body);
    const detail = parsed.success
      ? extractRelayMeErrorMessage(parsed.data)
      : '供应商返回了无效错误响应';
    const error = new Error(`RelayMe 请求 ${path} 返回 ${response.status}: ${sanitizeRelayMeMessage(detail)}`) as Error & {
      status?: number; retryable?: boolean;
    };
    error.status = response.status;
    error.retryable = response.status >= 500 || response.status === 429;
    throw error;
  }
  try {
    return schema.parse(body);
  } catch (error) {
    throw new Error(`RelayMe 响应格式无效: ${path}: ${sanitizeRelayMeMessage(error)}`);
  }
}

function extractRelayMeErrorMessage(value: z.infer<typeof errorBodySchema>): string {
  const candidate = value as { readonly error?: string | { readonly message?: unknown }; readonly message?: unknown };
  if (typeof candidate.error === 'string') return candidate.error;
  if (typeof candidate.error?.message === 'string') return candidate.error.message;
  return typeof candidate.message === 'string' ? candidate.message : '供应商返回了无效错误响应';
}

function sanitizeRelayMeMessage(value: unknown): string {
  const raw = value instanceof Error ? value.message : String(value ?? '未知错误');
  return raw
    .replace(/authorization\s*:\s*\S+(?:\s+\S+)?/giu, '[redacted]')
    .replace(/\bbearer\s+[a-z0-9._~+/=\-]{8,}/giu, '[redacted]')
    .replace(/\b(?:api[_ -]?key|token|secret|password)\s*[:=]\s*\S{4,}/giu, '[redacted]')
    .replace(/[A-Za-z]:[\\/][^\s"'`]+/gu, '[redacted]')
    .replace(/\\\\[^\\\s]+\\[^\s"'`]+/gu, '[redacted]')
    .replace(/data:(?:image|video)\/[^;]+;base64,[a-z0-9+/=]+/giu, '[redacted]')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 180);
}

function isRelayMeError(value: unknown): value is Error & { readonly status?: number; readonly retryable?: boolean } {
  return value instanceof Error && ('status' in value || 'retryable' in value);
}
