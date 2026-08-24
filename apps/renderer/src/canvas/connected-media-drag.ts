export const CONNECTED_MEDIA_DRAG_MIME = 'application/x-novus-project-media';

export interface ConnectedMediaDragPayload {
  readonly assetId: string;
  readonly kind: 'image' | 'video';
  readonly label: string;
}

export function encodeConnectedMediaDragPayload(payload: ConnectedMediaDragPayload): string {
  return JSON.stringify(payload);
}

export function decodeConnectedMediaDragPayload(value: string): ConnectedMediaDragPayload | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    if (typeof record.assetId !== 'string' || record.assetId.trim().length === 0) return null;
    if (record.kind !== 'image' && record.kind !== 'video') return null;
    if (typeof record.label !== 'string') return null;
    return { assetId: record.assetId, kind: record.kind, label: record.label };
  } catch {
    return null;
  }
}
