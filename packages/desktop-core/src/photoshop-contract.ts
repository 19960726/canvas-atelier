import { z } from 'zod';

export const PHOTOSHOP_IMPORT_ERROR_CODES = [
  'desktop_bridge_unavailable',
  'asset_not_found',
  'asset_not_owned',
  'unsupported_media',
  'photoshop_not_installed',
  'photoshop_not_running',
  'photoshop_version_unsupported',
  'no_active_document',
  'automation_denied',
  'placement_failed',
  'import_busy',
] as const;

export type PhotoshopImportErrorCode = typeof PHOTOSHOP_IMPORT_ERROR_CODES[number];

export interface PhotoshopImportRequest {
  readonly sessionId: string;
  readonly assetId: string;
}

export type PhotoshopImportResult =
  | { readonly ok: true; readonly layerName: string }
  | { readonly ok: false; readonly code: PhotoshopImportErrorCode };

export interface PhotoshopCapability {
  readonly available: boolean;
  readonly code?: PhotoshopImportErrorCode;
}

const photoshopImportRequestSchema = z.object({
  sessionId: z.string().trim().min(1).max(160),
  assetId: z.string().regex(/^[a-f0-9]{16}$/u),
}).strict();

export function parsePhotoshopImportRequest(value: unknown): PhotoshopImportRequest {
  return photoshopImportRequestSchema.parse(value);
}
