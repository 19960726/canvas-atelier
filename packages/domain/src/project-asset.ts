import { z } from 'zod';

import { projectImageAssetSchema } from './project-image-asset';
import { projectVideoAssetSchema } from './project-video-asset';

export const projectAssetSchema = z.union([projectImageAssetSchema, projectVideoAssetSchema]);

export type ProjectAsset = z.infer<typeof projectAssetSchema>;
