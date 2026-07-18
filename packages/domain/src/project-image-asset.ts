import { z } from 'zod';

import { containsProtectedPublicText } from './protected-public-text';

const contentAddressedAssetIdSchema = z.string().regex(/^[a-f0-9]{16}$/u, 'Asset id must be a content-addressed id');
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u, 'Asset hash must be a lowercase SHA-256 digest');

export const projectImageAssetSchema = z.object({
  assetId: contentAddressedAssetIdSchema,
  byteSize: z.number().int().nonnegative(),
  extension: z.enum(['gif', 'jpg', 'png', 'webp']),
  height: z.number().int().positive().nullable(),
  label: z.string().trim().min(1).max(120).superRefine((label, context) => {
    if (containsProtectedPublicText(label)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Asset label contains protected content' });
    }
  }),
  mediaType: z.enum(['image/gif', 'image/jpeg', 'image/png', 'image/webp']),
  origin: z.enum(['imported', 'generated', 'edited']),
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
  const expectedMediaType = asset.extension === 'jpg' ? 'image/jpeg' : `image/${asset.extension}`;
  if (asset.mediaType !== expectedMediaType) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['mediaType'],
      message: 'Asset media type must match its extension',
    });
  }
});

export type ProjectImageAsset = z.infer<typeof projectImageAssetSchema>;
