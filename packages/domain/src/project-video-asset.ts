import { z } from 'zod';

import { containsProtectedPublicText } from './protected-public-text';

const contentAddressedAssetIdSchema = z.string().regex(/^[a-f0-9]{16}$/u, 'Asset id must be a content-addressed id');
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u, 'Asset hash must be a lowercase SHA-256 digest');

export const projectVideoAssetSchema = z.object({
  assetId: contentAddressedAssetIdSchema,
  byteSize: z.number().int().nonnegative(),
  durationMs: z.number().int().positive().nullable(),
  extension: z.literal('mp4'),
  height: z.number().int().positive().nullable(),
  label: z.string().trim().min(1).max(120).superRefine((label, context) => {
    if (containsProtectedPublicText(label)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Asset label contains protected content' });
    }
  }),
  mediaType: z.literal('video/mp4'),
  origin: z.literal('imported'),
  sha256: sha256Schema,
  width: z.number().int().positive().nullable(),
}).strict().superRefine((asset, context) => {
  if (!asset.sha256.startsWith(asset.assetId)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['assetId'],
      message: 'Asset id must match the SHA-256 prefix',
    });
  }
});

export type ProjectVideoAsset = z.infer<typeof projectVideoAssetSchema>;
