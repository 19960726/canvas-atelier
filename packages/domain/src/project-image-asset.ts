import { z } from 'zod';

const contentAddressedAssetIdSchema = z.string().regex(/^[a-f0-9]{16}$/u, 'Asset id must be a content-addressed id');
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u, 'Asset hash must be a lowercase SHA-256 digest');

export const projectImageAssetSchema = z.object({
  assetId: contentAddressedAssetIdSchema,
  byteSize: z.number().int().nonnegative(),
  extension: z.enum(['gif', 'jpg', 'png', 'webp']),
  height: z.number().int().positive().nullable(),
  label: z.string().trim().min(1).max(120).superRefine((label, context) => {
    if (containsProtectedAssetLabel(label)) {
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

function containsProtectedAssetLabel(value: string): boolean {
  return /authorization\s*:/i.test(value)
    || /\bbearer\s+[a-z0-9._~+/=\-]{8,}/i.test(value)
    || /data:image\/[a-z0-9.+-]+;base64,/i.test(value)
    || /blob:[^\s"'`]+/i.test(value)
    || /file:\/\/[^\s"'`]+/i.test(value)
    || /(?:^|[\s([{"'])(?:[a-zA-Z]:[\\/])/.test(value)
    || /\\\\[^\\\s]+\\[^\s"'`]+/.test(value)
    || /(?:^|[\s([{"'])\/(?:Users|home|var|opt|tmp|private|etc|root)\//.test(value);
}
