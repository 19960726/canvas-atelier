export type MediaMentionKind = 'image' | 'video';

export interface ConnectedMentionItem {
  readonly token: string;
  readonly assetId: string;
  readonly kind: MediaMentionKind;
  readonly label: string;
  readonly displayUrl?: string;
}

export interface OrderedMediaMention {
  readonly edgeId?: string;
  readonly assetId: string;
  readonly kind: MediaMentionKind;
}

export interface ProjectMediaSummary {
  readonly assetId: string;
  readonly label: string;
  readonly displayUrl?: string;
}

export type CanonicalMentionSegment =
  | { readonly kind: 'text'; readonly text: string; readonly start: number; readonly end: number }
  | { readonly kind: MediaMentionKind; readonly text: string; readonly token: string; readonly start: number; readonly end: number };

export function tokenFor(kind: MediaMentionKind, index: number): string {
  return `@${kind === 'image' ? '图片' : '视频'}${index + 1}`;
}

export function parseCanonicalMentions(value: string): CanonicalMentionSegment[] {
  const segments: CanonicalMentionSegment[] = [];
  const pattern = /@(图片|视频)(\d{1,2})/gu;
  let cursor = 0;
  for (const match of value.matchAll(pattern)) {
    const start = match.index ?? 0;
    const token = match[0];
    if (start > cursor) segments.push({ kind: 'text', text: value.slice(cursor, start), start: cursor, end: start });
    const kind: MediaMentionKind = match[1] === '图片' ? 'image' : 'video';
    segments.push({ kind, text: token.slice(1), token, start, end: start + token.length });
    cursor = start + token.length;
  }
  if (cursor < value.length || segments.length === 0) {
    segments.push({ kind: 'text', text: value.slice(cursor), start: cursor, end: value.length });
  }
  return segments;
}

export function buildConnectedMentionCatalog(
  orderedMedia: readonly OrderedMediaMention[],
  projectImages: readonly ProjectMediaSummary[],
  projectVideos: readonly ProjectMediaSummary[],
): ConnectedMentionItem[] {
  let imageIndex = 0;
  let videoIndex = 0;
  const catalog: ConnectedMentionItem[] = [];
  for (const media of orderedMedia) {
    const summaries = media.kind === 'image' ? projectImages : projectVideos;
    const summary = summaries.find((item) => item.assetId === media.assetId);
    if (summary === undefined) continue;
    const index = media.kind === 'image' ? imageIndex++ : videoIndex++;
    catalog.push({
      token: tokenFor(media.kind, index),
      assetId: media.assetId,
      kind: media.kind,
      label: summary.label,
      ...(summary.displayUrl === undefined ? {} : { displayUrl: summary.displayUrl }),
    });
  }
  return catalog;
}

export function reconcileConnectedMentions(
  previous: readonly ConnectedMentionItem[],
  next: readonly ConnectedMentionItem[],
  value: string,
): string {
  const nextByAsset = new Map(next.map((item) => [`${item.kind}:${item.assetId}`, item]));
  const previousByToken = new Map(previous.map((item) => [item.token, item]));
  return value.replace(/@(图片|视频)(\d{1,2})/gu, (token) => {
    const prior = previousByToken.get(token);
    if (prior === undefined) return '';
    return nextByAsset.get(`${prior.kind}:${prior.assetId}`)?.token ?? '';
  }).replace(/[ \t]{2,}/gu, ' ').trimEnd();
}
