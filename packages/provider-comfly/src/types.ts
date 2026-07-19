export type ComflyModelCapability =
  | 'chat'
  | 'vision'
  | 'image_generation'
  | 'image_edit'
  | 'responses'
  | 'gemini_native'
  | 'async_tasks';

export interface ComflyFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
  arrayBuffer?(): Promise<ArrayBuffer>;
}

export interface ComflyFetchInit {
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
  readonly signal?: AbortSignal;
  readonly trustedResolvedAddress?: string;
}

export type ComflyFetch = (url: string, init?: ComflyFetchInit) => Promise<ComflyFetchResponse>;

export interface ComflyClientOptions {
  readonly baseUrl: string;
  readonly tokenSupplier: () => Promise<string>;
  readonly fetch: ComflyFetch;
  readonly timeoutMs?: number;
}

export interface ComflyChatRequest {
  readonly model: string;
  readonly messages: unknown[];
  readonly [key: string]: unknown;
}

export interface ComflyResponsesRequest {
  readonly model: string;
  readonly input: unknown;
  readonly [key: string]: unknown;
}

export interface ComflyImageGenerationRequest {
  readonly model: string;
  readonly prompt: string;
  readonly async?: boolean;
  readonly image?: unknown;
  readonly [key: string]: unknown;
}

export interface ComflyImageEditRequest {
  readonly model: string;
  readonly prompt: string;
  readonly image: unknown;
  readonly mask?: unknown;
  readonly [key: string]: unknown;
}

export interface ComflyGeminiContentRequest {
  readonly model: string;
  readonly contents: unknown[];
  readonly [key: string]: unknown;
}

export interface ComflyModelRegistration {
  readonly provider: string;
  readonly modelRoute: string;
  readonly displayName: string;
  readonly modelId?: string;
  readonly capabilities: readonly ComflyModelCapability[];
}

export interface ComflyMergedModelRegistration extends ComflyModelRegistration {
  readonly source: 'provider' | 'profile' | 'merged';
}
