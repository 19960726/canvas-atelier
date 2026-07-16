import { z } from 'zod';
import { redactProviderLog } from './redact';
import type {
  ComflyChatRequest,
  ComflyClientOptions,
  ComflyFetchResponse,
  ComflyGeminiContentRequest,
  ComflyImageEditRequest,
  ComflyImageGenerationRequest,
  ComflyResponsesRequest,
} from './types';

const DEFAULT_TIMEOUT_MS = 30_000;

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

const imageTaskSchema = z.object({
  taskId: nonEmptyStringSchema,
  status: nonEmptyStringSchema,
  data: z.array(imageDatumSchema).optional(),
}).passthrough();

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

export class ComflyClient {
  private readonly baseUrl: string;
  private readonly tokenSupplier: () => Promise<string>;
  private readonly fetch: ComflyClientOptions['fetch'];
  private readonly timeoutMs: number;

  constructor(options: ComflyClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.tokenSupplier = options.tokenSupplier;
    this.fetch = options.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async chat(input: ComflyChatRequest) {
    return this.request('/v1/chat/completions', {
      method: 'POST',
      body: input,
      model: input.model,
      schema: chatResponseSchema,
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

  async generateImage(input: ComflyImageGenerationRequest) {
    const suffix = input.async === true ? '?async=true' : '';
    return this.request(`/v1/images/generations${suffix}`, {
      method: 'POST',
      body: input,
      model: input.model,
      schema: imageResultSchema,
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

  async generateGeminiContent(input: ComflyGeminiContentRequest) {
    const { model, ...body } = input;
    return this.request(`/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      body,
      model,
      schema: geminiResponseSchema,
    });
  }

  private async request<T>(
    path: string,
    options: {
      readonly method: 'GET' | 'POST';
      readonly body?: Record<string, unknown>;
      readonly model?: string;
      readonly schema: z.ZodType<T>;
    },
  ): Promise<T> {
    const controller = new AbortController();
    const timer = this.timeoutMs > 0
      ? globalThis.setTimeout(() => controller.abort(), this.timeoutMs)
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
      });
      return await this.parseResponse(response, path, options);
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(buildTimeoutMessage(path, options.model, this.timeoutMs));
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
      readonly schema: z.ZodType<T>;
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
