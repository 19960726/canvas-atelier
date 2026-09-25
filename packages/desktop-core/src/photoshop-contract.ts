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
  'automation_unavailable',
  'placement_failed',
  'import_busy',
] as const;

export type PhotoshopImportErrorCode = typeof PHOTOSHOP_IMPORT_ERROR_CODES[number];

export interface PhotoshopColorCorrection {
  readonly temperature: number;
  readonly tint: number;
  readonly saturation: number;
  readonly contrast: number;
  readonly brightness: number;
}

export interface PhotoshopImportRequest {
  readonly sessionId: string;
  readonly assetId: string;
  readonly colorCorrection?: PhotoshopColorCorrection;
}

export type PhotoshopImportResult =
  | { readonly ok: true; readonly layerName: string }
  | { readonly ok: false; readonly code: PhotoshopImportErrorCode };

export interface PhotoshopCapability {
  readonly available: boolean;
  readonly code?: PhotoshopImportErrorCode;
}

const photoshopColorCorrectionSchema = z.object({
  temperature: z.number().int().min(-30).max(30),
  tint: z.number().int().min(-30).max(30),
  saturation: z.number().int().min(70).max(130),
  contrast: z.number().int().min(85).max(120),
  brightness: z.number().int().min(85).max(120),
}).strict();

const photoshopImportRequestSchema = z.object({
  sessionId: z.string().trim().min(1).max(160),
  assetId: z.string().regex(/^[a-f0-9]{16}$/u),
  colorCorrection: photoshopColorCorrectionSchema.optional(),
}).strict();

export function parsePhotoshopImportRequest(value: unknown): PhotoshopImportRequest {
  return photoshopImportRequestSchema.parse(value);
}
