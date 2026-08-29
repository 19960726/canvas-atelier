export interface RelayMeFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
  arrayBuffer?(): Promise<ArrayBuffer>;
}

export interface RelayMeFetchInit {
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
  readonly signal?: AbortSignal;
  readonly trustedResolvedAddress?: string;
}

export type RelayMeFetch = (url: string, init?: RelayMeFetchInit) => Promise<RelayMeFetchResponse>;

export interface RelayMeClientOptions {
  readonly baseUrl?: string;
  readonly tokenSupplier: () => Promise<string>;
  readonly fetch: RelayMeFetch;
  readonly timeoutMs?: number;
}

export interface RelayMeModelOffer {
  readonly id: string;
  readonly specialOffer: boolean;
  readonly pricing?: Readonly<Record<string, string>>;
}

export interface RelayMeDurationOptions {
  readonly mode: 'options';
  readonly defaultValue?: number;
  readonly options: readonly number[];
}

export interface RelayMeDurationRange {
  readonly mode: 'range';
  readonly defaultValue?: number;
  readonly min: number;
  readonly max: number;
  readonly step: number;
}

export type RelayMeAspectRatio = '1:1' | '2:3' | '3:2' | '4:3' | '3:4' | '16:9' | '9:16';
export type RelayMeVideoResolution = '360p' | '480p' | '512p' | '540p' | '720p' | '768p' | '1080p' | '2K' | '4K';

export interface RelayMeModel {
  readonly name: string;
  readonly deploymentName: string;
  readonly originalName?: string;
  readonly capability: 'text' | 'image' | 'video';
  readonly modelType: 'IMAGE' | 'TEXT' | 'VIDEO';
  readonly endpoints?: readonly string[];
  readonly inputModalities?: readonly ('text' | 'image' | 'video' | 'audio')[];
  readonly supportsVision?: boolean;
  readonly supportsImageToImage?: boolean;
  readonly description?: string;
  readonly isDefault: boolean;
  readonly offers: readonly RelayMeModelOffer[];
  readonly videoCapabilities?: {
    readonly resolutions?: readonly RelayMeVideoResolution[];
    readonly aspectRatios?: readonly RelayMeAspectRatio[];
    readonly duration?: RelayMeDurationOptions | RelayMeDurationRange;
  };
}

export interface RelayMeChatRequest {
  readonly model: string;
  readonly messages: readonly unknown[];
  readonly [key: string]: unknown;
}

export interface RelayMeImageGenerationRequest {
  readonly model: string;
  readonly messages: readonly unknown[];
  readonly imageAspectRatio?: string;
  readonly imageSampleSize?: string;
  readonly imageQuality?: string;
  readonly n?: number;
  readonly [key: string]: unknown;
}

export interface RelayMeVideoGenerationRequest {
  readonly model: string;
  readonly messages: readonly unknown[];
  readonly videoAspectRatio?: string;
  readonly videoQuality?: '360p' | '480p' | '512p' | '540p' | '720p' | '768p' | '1080p' | '2K' | '4K';
  readonly videoSeconds?: number;
  readonly audioEnabled?: boolean;
  readonly n?: number;
  readonly [key: string]: unknown;
}
