export type ComflyModelCapability =
  | 'chat'
  | 'vision'
  | 'image_generation'
  | 'image_edit'
  | 'responses'
  | 'gemini_native'
  | 'reverse_prompt'
  | 'video_understanding'
  | 'video_generation'
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
  readonly timeoutMs?: number;
  readonly trustedResolvedAddress?: string;
}

export type ComflyFetch = (url: string, init?: ComflyFetchInit) => Promise<ComflyFetchResponse>;

export interface ComflyClientOptions {
  readonly baseUrl: string;
  readonly tokenSupplier: () => Promise<string>;
  readonly fetch: ComflyFetch;
  readonly timeoutMs?: number;
  readonly generationTimeoutMs?: number;
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
  /** Optional Comfly-compatible image controls. A provider may reject or ignore
   * controls it has not documented; callers must only expose them for configured
   * image-generation routes. */
  readonly aspect_ratio?: '1:1' | '2:3' | '3:2' | '4:3' | '3:4' | '16:9' | '9:16';
  readonly size?: '1024x1024' | '1536x1024' | '1024x1536';
  readonly n?: 1 | 2 | 3 | 4;
  readonly [key: string]: unknown;
}

export interface ComflyVideoGenerationRequest {
  readonly model: string;
  readonly prompt: string;
  readonly aspect_ratio?: '1:1' | '2:3' | '3:2' | '4:3' | '3:4' | '16:9' | '9:16';
  readonly resolution?: '360p' | '480p' | '512p' | '540p' | '720p' | '768p' | '1080p' | '2k' | '4k';
  readonly duration?: number;
  readonly audio?: boolean;
  readonly images?: readonly string[];
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

export interface ComflyParameterTable {
  readonly headers: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

export interface ComflyCatalogModel {
  readonly key: string;
  readonly name: string;
  readonly provider: string;
  readonly tags: readonly string[];
  readonly apis: readonly string[];
  readonly description?: string;
  readonly parameterTable?: ComflyParameterTable;
  readonly capabilityStatus: 'complete' | 'incomplete';
}

export interface ComflyAccessibleModelCatalog {
  readonly version: string;
  readonly models: readonly ComflyCatalogModel[];
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
