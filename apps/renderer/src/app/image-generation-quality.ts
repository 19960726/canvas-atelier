import type { ImageQuality } from '@agent-canvas/domain';

export const IMAGE_QUALITY_OPTIONS = ['auto', 'low', 'medium', 'high'] as const satisfies readonly ImageQuality[];

const IMAGE_QUALITY_LABELS: Readonly<Record<ImageQuality, string>> = {
  auto: '自动',
  low: '低',
  medium: '中',
  high: '高',
};

export function normalizeImageQuality(value: unknown): ImageQuality | undefined {
  return value === 'auto' || value === 'low' || value === 'medium' || value === 'high' ? value : undefined;
}

export function imageQualityLabel(value: ImageQuality): string {
  return IMAGE_QUALITY_LABELS[value];
}

export function imageQualityFromLabel(value: string): ImageQuality | undefined {
  return IMAGE_QUALITY_OPTIONS.find((quality) => IMAGE_QUALITY_LABELS[quality] === value);
}

export function supportsGptImageQuality(
  profile: {
    readonly capabilities: readonly string[];
    readonly displayName: string;
    readonly modelId?: string;
    readonly modelRoute: string;
  } | undefined,
): boolean {
  if (profile === undefined || !profile.capabilities.includes('image_generation')) return false;
  return isGptImageQualityIdentity(profile.modelId, profile.modelRoute, profile.displayName);
}

export function isGptImageQualityIdentity(...values: readonly unknown[]): boolean {
  const identity = values
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .trim()
    .toLocaleLowerCase();
  return /(?:^|[^a-z0-9])gpt[-_\s]?image(?:[-_\s]?(?:1(?:\.5)?|2(?:\.\d+)?))?(?:$|[^a-z0-9])/u.test(identity);
}
