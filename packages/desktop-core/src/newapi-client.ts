import { randomBytes } from 'node:crypto';

import { z } from 'zod';

import type { ComflyFetchResponse } from '@agent-canvas/provider-comfly';

import { parseNewApiPricing, type NewApiPricingEntry, type NewApiProviderId } from './newapi-model-catalog.js';
import { createProviderBridgeError } from './provider-contracts.js';

const DEFAULTS = {
  julun: { apiBaseUrl: 'https://julun.cc/v1', pricingUrl: 'https://julun.cc/api/pricing', host: 'julun.cc' },
  '4dai': { apiBaseUrl: 'https://api.4dai.cc/v1', pricingUrl: 'https://api.4dai.cc/api/pricing', host: 'api.4dai.cc' },
} as const;

const ModelListSchema = z.object({
  data: z.array(z.object({ id: z.string().min(1).max(200) }).passthrough()).max(10_000),
}).passthrough();
const VideoTaskSchema = z.object({
  id: z.string().min(1).max(500),
  status: z.string().min(1).max(100),
  progress: z.number().finite().optional(),
  error: z.unknown().optional(),
}).passthrough();
const ImageResultSchema = z.object({
  data: z.array(z.object({ b64_json: z.string().optional(), url: z.string().url().optional() }).passthrough()).min(1),
}).passthrough();
const GeminiImageResultSchema = z.object({
  candidates: z.array(z.object({
    content: z.object({
      parts: z.array(z.object({
        inlineData: z.object({ mimeType: z.string(), data: z.string() }).optional(),
        inline_data: z.object({ mime_type: z.string(), data: z.string() }).optional(),
      }).passthrough()).min(1),
    }).passthrough(),
  }).passthrough()).min(1),
}).passthrough();
const ChatResultSchema = z.object({
  choices: z.array(z.object({
    message: z.object({ content: z.union([z.string(), z.array(z.object({ text: z.string() }).passthrough())]) }).passthrough(),
  }).passthrough()).min(1),
}).passthrough();

export interface NewApiVideoTask {
  readonly id: string;
  readonly status: string;
  readonly progress?: number;
  readonly error?: unknown;
}

export type NewApiGeneratedImage =
  | { readonly kind: 'inline'; readonly bytes: Uint8Array; readonly mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' }
  | { readonly kind: 'remote'; readonly url: string };

export interface NewApiClient {
  listModelIds(): Promise<string[]>;
  listPublicPricing(): Promise<NewApiPricingEntry[]>;
  createVideo(input: {
    readonly model: string;
    readonly prompt: string;
    readonly duration: number;
    readonly width: number;
    readonly height: number;
    readonly inputReference?: { readonly bytes: Uint8Array; readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp' };
  }): Promise<NewApiVideoTask>;
  getVideo(id: string): Promise<NewApiVideoTask>;
  getVideoContent(id: string): Promise<Uint8Array>;
  generateImage(input: {
    readonly model: string;
    readonly prompt: string;
    readonly n: number;
    readonly quality?: 'auto' | 'low' | 'medium' | 'high';
    readonly output_format?: 'png' | 'jpeg' | 'webp';
    readonly background?: 'auto' | 'opaque' | 'transparent';
    readonly size?: string;
  }): Promise<NewApiGeneratedImage>;
  generateGeminiImage(input: {
    readonly model: string;
    readonly prompt: string;
    readonly aspectRatio: '1:1' | '2:3' | '3:2' | '4:3' | '3:4' | '16:9' | '9:16';
    readonly imageSize: '1K' | '2K' | '4K';
    readonly references?: readonly {
      readonly bytes: Uint8Array;
      readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp';
    }[];
  }): Promise<NewApiGeneratedImage>;
  createChatCompletion(
    input: {
      readonly model: string;
      readonly messages: readonly unknown[];
      readonly max_tokens?: number;
    },
    timeoutMs?: number,
  ): Promise<string>;
}

export interface NewApiFetchInit {
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string | Uint8Array;
  readonly signal?: AbortSignal;
  readonly maxResponseBytes?: number;
  readonly timeoutMs?: number;
  readonly trustedResolvedAddress?: string;
}

export type NewApiFetch = (url: string, init?: NewApiFetchInit) => Promise<ComflyFetchResponse>;

export function createNewApiClient(options: {
  readonly provider: NewApiProviderId;
  readonly apiBaseUrl?: string;
  readonly tokenSupplier: () => Promise<string>;
  readonly fetch: NewApiFetch;
  readonly boundarySupplier?: () => string;
  readonly timeoutMs?: number;
}): NewApiClient {
  const defaults = DEFAULTS[options.provider];
  const apiBaseUrl = normalizeOfficialBaseUrl(options.apiBaseUrl ?? defaults.apiBaseUrl, defaults.host, options.provider);
  const apiOrigin = new URL(apiBaseUrl).origin;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const request = async (url: string, init: NewApiFetchInit = {}) => {
    try {
      return await options.fetch(url, init);
    } catch (error) {
      if (isProviderBridgeError(error)) throw error;
      throw createProviderBridgeError('PROVIDER_ERROR', 'New API network request failed', true);
    }
  };
  const authenticatedUrl = async (url: string, init: NewApiFetchInit = {}) => {
    const token = await options.tokenSupplier();
    if (token.length === 0 || token !== token.trim()) throw new Error('New API credential is unavailable');
    return request(url, {
      ...init,
      headers: { authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
      timeoutMs: init.timeoutMs ?? timeoutMs,
    });
  };
  const authenticated = (path: string, init: NewApiFetchInit = {}) => authenticatedUrl(`${apiBaseUrl}${path}`, init);
  return {
    async listModelIds() {
      const response = await authenticated('/models');
      assertOk(response.ok, response.status);
      const parsed = ModelListSchema.safeParse(await readJson(response));
      if (!parsed.success) throw invalidResponse('New API model response is invalid');
      return [...new Set(parsed.data.data.map((entry) => entry.id))];
    },
    async listPublicPricing() {
      const response = await request(defaults.pricingUrl, { method: 'GET', timeoutMs });
      assertOk(response.ok, response.status);
      try {
        return parseNewApiPricing(await readJson(response));
      } catch (error) {
        if (isProviderBridgeError(error)) throw error;
        throw invalidResponse('New API pricing response is invalid');
      }
    },
    async createVideo(input) {
      if (options.provider !== 'julun') throw new Error('Video generation is unavailable for this provider');
      const boundary = (options.boundarySupplier ?? (() => `canvas-${randomBytes(12).toString('hex')}`))();
      if (!/^[A-Za-z0-9_-]{1,70}$/u.test(boundary)) throw new Error('Multipart boundary is invalid');
      const body = buildVideoMultipart(boundary, input);
      const response = await authenticated('/videos', {
        method: 'POST',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
        body,
        timeoutMs: 180_000,
      });
      assertOk(response.ok, response.status);
      return parseVideoTask(await readJson(response));
    },
    async getVideo(id) {
      const response = await authenticated(`/videos/${encodeURIComponent(assertTaskId(id))}`);
      assertOk(response.ok, response.status);
      return parseVideoTask(await readJson(response));
    },
    async getVideoContent(id) {
      const response = await authenticated(`/videos/${encodeURIComponent(assertTaskId(id))}/content`, {
        maxResponseBytes: 512 * 1024 * 1024,
        timeoutMs: 180_000,
      });
      assertOk(response.ok, response.status);
      if (response.arrayBuffer === undefined) throw invalidResponse('New API video response is invalid');
      let bytes: Uint8Array;
      try { bytes = new Uint8Array(await response.arrayBuffer()); }
      catch { throw invalidResponse('New API video response is invalid'); }
      if (bytes.byteLength === 0 || bytes.byteLength > 512 * 1024 * 1024) throw invalidResponse('New API video response is invalid');
      return bytes;
    },
    async generateImage(input) {
      if (options.provider !== '4dai') throw new Error('Image generation is unavailable for this provider');
      const response = await authenticated('/images/generations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
        timeoutMs: 180_000,
      });
      assertOk(response.ok, response.status);
      const parsed = ImageResultSchema.safeParse(await readJson(response));
      if (!parsed.success) throw invalidResponse('New API image response is invalid');
      const item = parsed.data.data[0]!;
      if (item.b64_json !== undefined) {
        const bytes = decodeBase64(item.b64_json);
        return { kind: 'inline', bytes, mediaType: detectImageMediaType(bytes) };
      }
      if (item.url !== undefined && new URL(item.url).protocol === 'https:') return { kind: 'remote', url: item.url };
      throw invalidResponse('New API image response is invalid');
    },
    async generateGeminiImage(input) {
      if (options.provider !== '4dai') throw new Error('Gemini image generation is unavailable for this provider');
      const parts = [
        ...(input.references ?? []).map((reference) => ({
          inlineData: {
            mimeType: reference.mediaType,
            data: Buffer.from(reference.bytes).toString('base64'),
          },
        })),
        { text: input.prompt },
      ];
      const response = await authenticatedUrl(
        `${apiOrigin}/v1beta/models/${encodeURIComponent(input.model)}:generateContent`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts }],
            generationConfig: {
              responseModalities: ['TEXT', 'IMAGE'],
              imageConfig: { aspectRatio: input.aspectRatio, imageSize: input.imageSize },
            },
          }),
          timeoutMs: 180_000,
        },
      );
      assertOk(response.ok, response.status);
      const parsed = GeminiImageResultSchema.safeParse(await readJson(response));
      if (!parsed.success) throw invalidResponse('New API Gemini image response is invalid');
      for (const candidate of parsed.data.candidates) {
        for (const part of candidate.content.parts) {
          const inline = part.inlineData === undefined
            ? part.inline_data === undefined
              ? undefined
              : { mimeType: part.inline_data.mime_type, data: part.inline_data.data }
            : part.inlineData;
          if (inline === undefined) continue;
          const declaredMediaType = parseImageMediaType(inline.mimeType);
          const bytes = decodeBase64(inline.data);
          const detectedMediaType = detectImageMediaType(bytes);
          if (detectedMediaType !== declaredMediaType) throw invalidResponse('New API Gemini image response is invalid');
          return { kind: 'inline', bytes, mediaType: detectedMediaType };
        }
      }
      throw invalidResponse('New API Gemini image response is invalid');
    },
    async createChatCompletion(input, requestTimeoutMs = 180_000) {
      if (options.provider !== '4dai') throw new Error('Chat is unavailable for this provider');
      const response = await authenticated('/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
        timeoutMs: requestTimeoutMs,
      });
      assertOk(response.ok, response.status);
      const parsed = ChatResultSchema.safeParse(await readJson(response));
      if (!parsed.success) throw invalidResponse('New API chat response is invalid');
      const content = parsed.data.choices[0]!.message.content;
      const text = typeof content === 'string' ? content.trim() : content.map((part) => part.text).join('\n').trim();
      if (text.length === 0) throw invalidResponse('New API chat response is invalid');
      return text;
    },
  };
}

function normalizeOfficialBaseUrl(value: string, host: string, provider: NewApiProviderId): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`New API requires the official ${provider} host`); }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== host || url.username || url.password || url.search || url.hash) {
    throw new Error(`New API requires the official ${provider} host`);
  }
  const pathname = url.pathname.replace(/\/+$/u, '');
  if (pathname !== '/v1') throw new Error(`New API requires the official ${provider} host`);
  return `https://${host}/v1`;
}

function parseVideoTask(value: unknown): NewApiVideoTask {
  const parsed = VideoTaskSchema.safeParse(value);
  if (!parsed.success) throw invalidResponse('New API video task response is invalid');
  return parsed.data;
}

function assertTaskId(value: string): string {
  if (value.length === 0 || value.length > 500 || /[\u0000-\u001f]/u.test(value)) throw new Error('New API task id is invalid');
  return value;
}

function buildVideoMultipart(boundary: string, input: Parameters<NewApiClient['createVideo']>[0]): Uint8Array {
  const chunks: Buffer[] = [];
  const appendText = (name: string, value: string) => {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`, 'utf8'));
  };
  appendText('model', input.model);
  appendText('prompt', input.prompt);
  appendText('duration', String(input.duration));
  appendText('width', String(input.width));
  appendText('height', String(input.height));
  if (input.inputReference !== undefined) {
    appendText('image', `data:${input.inputReference.mediaType};base64,${Buffer.from(input.inputReference.bytes).toString('base64')}`);
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return Buffer.concat(chunks);
}

function decodeBase64(value: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]+={0,2}$/u.test(value) || value.length % 4 !== 0) throw invalidResponse('New API image response is invalid');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.byteLength === 0 || bytes.byteLength > 256 * 1024 * 1024) throw invalidResponse('New API image response is invalid');
  return Uint8Array.from(bytes);
}

function detectImageMediaType(bytes: Uint8Array): 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' {
  const header = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 16));
  if (header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (header.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg';
  if (header.subarray(0, 6).toString('ascii') === 'GIF87a' || header.subarray(0, 6).toString('ascii') === 'GIF89a') return 'image/gif';
  if (header.subarray(0, 4).toString('ascii') === 'RIFF' && header.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  throw invalidResponse('New API image response is invalid');
}

function parseImageMediaType(value: string): 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' {
  if (value === 'image/png' || value === 'image/jpeg' || value === 'image/gif' || value === 'image/webp') return value;
  throw invalidResponse('New API Gemini image response is invalid');
}

function assertOk(ok: boolean, status: number): void {
  if (ok) return;
  const code = status === 401 || status === 403 ? 'CREDENTIALS_LOCKED' : 'PROVIDER_ERROR';
  const retryable = status === 408 || status === 425 || status === 429 || status >= 500;
  throw Object.assign(createProviderBridgeError(code, `New API request failed (${status})`, retryable), { status });
}

async function readJson(response: ComflyFetchResponse): Promise<unknown> {
  try { return await response.json(); }
  catch { throw invalidResponse('New API response is invalid'); }
}

function invalidResponse(message: string) {
  return createProviderBridgeError('PROVIDER_INVALID_RESPONSE', message, false);
}

function isProviderBridgeError(error: unknown): error is Error & { readonly code: string; readonly retryable: boolean } {
  return error instanceof Error
    && typeof (error as { code?: unknown }).code === 'string'
    && typeof (error as { retryable?: unknown }).retryable === 'boolean';
}
