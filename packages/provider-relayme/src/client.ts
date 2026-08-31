import { z } from 'zod';
import type {
  RelayMeChatRequest,
  RelayMeClientOptions,
  RelayMeFetchResponse,
  RelayMeImageGenerationRequest,
  RelayMeModel,
  RelayMeModelOffer,
  RelayMeTaskList,
  RelayMeVideoGenerationRequest,
  RelayMeWorkflow,
  RelayMeWorkflowRun,
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
const videoAspectRatioListSchema = z.array(z.string()).transform((values) => values.flatMap((value) => {
  const parsed = aspectRatioSchema.safeParse(value.trim());
  return parsed.success ? [parsed.data] : [];
}));
const videoResolutionSchema = z.string().transform((value) => {
  const normalized = value.trim().toLowerCase();
  return normalized === '2k' || normalized === '4k'
    ? normalized.toUpperCase()
    : normalized;
}).pipe(z.enum(['360p', '480p', '512p', '540p', '720p', '768p', '1080p', '2K', '4K']));
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
    aspectRatios: videoAspectRatioListSchema.optional(),
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
]);
const openAiChatResponseSchema = z.object({
  id: nonEmptyStringSchema,
  model: nonEmptyStringSchema,
  choices: z.array(z.object({
    finish_reason: z.string().optional(),
    message: z.object({ role: nonEmptyStringSchema, content: z.unknown() }).passthrough(),
  }).passthrough()).min(1),
}).passthrough();
const liveChatResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    content: z.unknown(),
    model: nonEmptyStringSchema,
    promptTokens: z.number().int().nonnegative().optional(),
    completionTokens: z.number().int().nonnegative().optional(),
    totalTokens: z.number().int().nonnegative().optional(),
  }).passthrough(),
}).passthrough().transform((value) => ({
  id: 'relayme-chat',
  model: value.data.model,
  choices: [{ finish_reason: undefined, message: { role: 'assistant', content: value.data.content } }],
  usage: {
    ...(value.data.promptTokens === undefined ? {} : { prompt_tokens: value.data.promptTokens }),
    ...(value.data.completionTokens === undefined ? {} : { completion_tokens: value.data.completionTokens }),
    ...(value.data.totalTokens === undefined ? {} : { total_tokens: value.data.totalTokens }),
  },
}));
const chatResponseSchema = z.union([openAiChatResponseSchema, liveChatResponseSchema]);
const taskSubmissionItemSchema = z.object({
  taskId: nonEmptyStringSchema,
  status: nonEmptyStringSchema.optional().default('PENDING'),
}).passthrough();
const taskStateItemSchema = z.object({
  taskId: nonEmptyStringSchema.optional(),
  status: nonEmptyStringSchema,
  imageContent: z.string().nullish(),
  videoContent: z.string().nullish(),
  error: z.string().nullish(),
  progress: z.number().finite().optional(),
  result: z.unknown().optional(),
  data: z.unknown().optional(),
}).passthrough().transform(({ imageContent, videoContent, error, ...value }) => ({
  ...value,
  ...(imageContent == null ? {} : { imageContent }),
  ...(videoContent == null ? {} : { videoContent }),
  ...(error == null ? {} : { error }),
}));
const taskStateAliasSchema = z.object({
  id: nonEmptyStringSchema.optional(),
  taskId: nonEmptyStringSchema.optional(),
  state: nonEmptyStringSchema,
  output: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.string().optional(),
  errorMessage: z.string().optional(),
  progress: z.number().finite().optional(),
}).passthrough().transform((value) => ({
  taskId: value.taskId ?? value.id,
  status: value.state,
  result: value.result ?? value.output,
  error: value.error ?? value.errorMessage,
  progress: value.progress,
}));
const taskSubmissionSchema = z.union([
  taskSubmissionItemSchema,
  z.object({ data: taskSubmissionItemSchema }).passthrough().transform((value) => value.data),
]);
const taskStateSchema = z.union([
  taskStateItemSchema,
  z.object({ data: taskStateItemSchema }).passthrough().transform((value) => value.data),
  taskStateAliasSchema,
  z.object({ task: taskStateAliasSchema }).passthrough().transform((value) => value.task),
  z.object({ data: z.object({ task: taskStateAliasSchema }).passthrough() }).passthrough().transform((value) => value.data.task),
]);const errorBodySchema = z.union([
  z.object({ error: z.object({ message: nonEmptyStringSchema }).passthrough() }).passthrough(),
  z.object({ error: nonEmptyStringSchema, success: z.boolean().optional() }).passthrough(),
  z.object({ message: nonEmptyStringSchema }).passthrough(),
]);
const taskSummarySchema = z.object({
  taskId: nonEmptyStringSchema,
  type: z.enum(['image', 'video']).optional().default('image'),
  status: nonEmptyStringSchema,
  createdAt: z.union([z.string(), z.number().finite()]).nullish(),
  error: z.string().nullish(),
}).passthrough().transform((value) => ({
  taskId: value.taskId,
  type: value.type,
  status: value.status,
  ...(value.createdAt == null ? {} : {
    createdAt: typeof value.createdAt === 'number' ? new Date(value.createdAt).toISOString() : value.createdAt,
  }),
  ...(value.error == null ? {} : { error: value.error }),
}));
const taskListSchema = z.object({
  data: z.array(taskSummarySchema).optional(),
  tasks: z.array(taskSummarySchema).optional(),
  items: z.array(taskSummarySchema).optional(),
  total: z.number().int().nonnegative().optional(),
  page: z.number().int().positive().optional(),
  totalPages: z.number().int().positive().optional(),
}).passthrough().transform((value) => {
  const tasks = value.tasks ?? value.data ?? value.items ?? [];
  return {
    tasks,
    total: value.total ?? tasks.length,
    page: value.page ?? 1,
    totalPages: value.totalPages ?? 1,
  } satisfies RelayMeTaskList;
});

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

  async listWorkflows(): Promise<RelayMeWorkflow[]> {
    const response = await this.request<unknown>('/workflows', { method: 'GET', schema: z.unknown() });
    return extractWorkflowList(response);
  }

  async getWorkflow(workflowId: string): Promise<RelayMeWorkflow> {
    const response = await this.request<unknown>(`/workflows/${encodeURIComponent(workflowId)}`, { method: 'GET', schema: z.unknown() });
    return extractWorkflow(response);
  }

  async getWorkflowSchema(workflowId: string): Promise<unknown> {
    return this.request(`/workflows/${encodeURIComponent(workflowId)}/schema`, { method: 'GET', schema: z.unknown() });
  }

  async estimateWorkflow(workflowId: string, inputs: Readonly<Record<string, unknown>>): Promise<unknown> {
    return this.request(`/workflows/${encodeURIComponent(workflowId)}/estimate`, { method: 'POST', body: { inputs }, schema: z.unknown() });
  }

  async validateWorkflow(workflowId: string, data: Readonly<Record<string, unknown>>): Promise<unknown> {
    void workflowId;
    return this.request('/workflows/validate', { method: 'POST', body: { data }, schema: z.unknown() });
  }

  async runWorkflow(workflowId: string, inputs: Readonly<Record<string, unknown>>, idempotencyKey: string): Promise<RelayMeWorkflowRun> {
    return this.request(`/workflows/${encodeURIComponent(workflowId)}/runs`, { method: 'POST', body: { idempotencyKey, inputs }, headers: { 'Idempotency-Key': idempotencyKey }, schema: workflowRunSchema, allowEmptyAccepted: true });
  }

  async getWorkflowRun(runId: string): Promise<unknown> {
    return this.request(`/workflow-runs/${encodeURIComponent(runId)}`, { method: 'GET', schema: z.unknown() });
  }

  async cancelWorkflowRun(runId: string, reason?: string): Promise<unknown> {
    return this.request(`/workflow-runs/${encodeURIComponent(runId)}/cancel`, { method: 'POST', body: reason === undefined ? {} : { reason }, schema: z.unknown() });
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

  async listTasks(page = 1, size = 20): Promise<RelayMeTaskList> {
    const safePage = Number.isInteger(page) && page > 0 ? page : 1;
    const safeSize = Number.isInteger(size) && size > 0 && size <= 100 ? size : 20;
    return this.request(`/tasks?page=${safePage}&size=${safeSize}`, { method: 'GET', schema: taskListSchema });
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
      readonly headers?: Record<string, string>;
      readonly allowEmptyAccepted?: boolean;
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
          ...(options.headers ?? {}),
          ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal: controller.signal,
      });
      return await parseResponse(response, path, options.schema, options.allowEmptyAccepted === true);
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

const workflowSchema = z.object({
  id: z.union([nonEmptyStringSchema, z.number().int().nonnegative()]).transform(String),
}).passthrough();
const workflowRunSchema = z.union([
  z.object({ runId: nonEmptyStringSchema }).passthrough(),
  z.object({ data: z.object({ runId: nonEmptyStringSchema }).passthrough() }).passthrough().transform((value) => value.data),
]);

function extractWorkflowList(value: unknown): RelayMeWorkflow[] {
  const candidate = isRecord(value) && Array.isArray(value.workflows) ? value.workflows
    : isRecord(value) && isRecord(value.data) && Array.isArray(value.data.workflows) ? value.data.workflows
      : isRecord(value) && Array.isArray(value.data) ? value.data
        : isRecord(value) && Array.isArray(value.items) ? value.items
          : Array.isArray(value) ? value : [];
  return candidate.flatMap((item) => {
    const parsed = workflowSchema.safeParse(item);
    return parsed.success ? [parsed.data as RelayMeWorkflow] : [];
  });
}

function extractWorkflow(value: unknown): RelayMeWorkflow {
  const candidate = isRecord(value) && (typeof value.id === 'string' || typeof value.id === 'number') ? value
    : isRecord(value) && isRecord(value.workflow) ? value.workflow
    : isRecord(value) && isRecord(value.data) && isRecord(value.data.workflow) ? value.data.workflow
      : isRecord(value) && isRecord(value.data) ? value.data
        : value;
  const parsed = workflowSchema.safeParse(candidate);
  if (!parsed.success) throw new Error('RelayMe workflow response was invalid');
  return parsed.data as RelayMeWorkflow;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
async function parseResponse<T>(response: RelayMeFetchResponse, path: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>, allowEmptyAccepted = false): Promise<T> {
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    if (allowEmptyAccepted && response.status === 202) {
      const location = response.headers?.get('location') ?? '';
      const locationParts = location.split('/').filter(Boolean);
      const runId = locationParts[locationParts.length - 1];
      if (runId !== undefined && /^[0-9a-f-]{20,}$/iu.test(runId)) return { runId, status: 'QUEUED' } as T;
    }
    throw error;
  }
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
