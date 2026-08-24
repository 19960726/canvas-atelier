import { z } from 'zod';
import {
  type AgentKnowledgeLease,
  agentKnowledgeLeaseSchema,
  orderedReferenceSchema,
  orderedReferencesMatch,
  referenceRoleSchema,
} from './knowledge-context';
import { MAX_GENERATION_REFERENCES } from './project-schema';
import { projectVideoAssetSchema } from './project-video-asset';

export const reversePromptPersonaIdSchema = z.enum([
  'commercial_visual_director',
  'ecommerce_key_visual',
  'brand_poster',
  'composition_director',
  'material_lighting_director',
]);

export const reversePromptPersonaSchema = z.object({
  id: reversePromptPersonaIdSchema,
  label: z.string().min(1),
}).strict();

export const REVERSE_PROMPT_PERSONAS = [
  { id: 'commercial_visual_director', label: '高级商业视觉设计师 + 产品摄影指导 + 提示词工程师' },
  { id: 'ecommerce_key_visual', label: '电商主视觉设计总监' },
  { id: 'brand_poster', label: '品牌海报创意总监' },
  { id: 'composition_director', label: '商业构图与镜头指导' },
  { id: 'material_lighting_director', label: '材质与灯光视觉指导' },
] as const;

export const DEFAULT_REVERSE_PROMPT_PERSONA = REVERSE_PROMPT_PERSONAS[0];

export function normalizeReverseRolePreference(role: string): string | undefined {
  const normalized = role.trim().replace(/\s+/gu, ' ');
  if (normalized.length < 4 || /^\d+$/u.test(normalized)) return undefined;
  return normalized;
}

export const approvedMemorySnapshotSchema = z.object({
  version: z.string().min(1),
  approvedAt: z.string().datetime(),
  approvedMemoryIds: z.array(z.string().min(1)),
}).strict();

const nonEmptyTrimmedStringSchema = z.string().trim().min(1);

const reverseAgentCitationAssetIdsSchema = z.array(nonEmptyTrimmedStringSchema)
  .max(MAX_GENERATION_REFERENCES, 'Agent image citations are limited to 20 managed images')
  .superRefine((assetIds, context) => {
    if (new Set(assetIds).size !== assetIds.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: 'Agent image citations must be distinct' });
    }
  });
export const reverseAgentNodeConfigSchema = z.object({
  modelRoute: nonEmptyTrimmedStringSchema,
  role: nonEmptyTrimmedStringSchema,
  task: nonEmptyTrimmedStringSchema,
  referenceAssetIds: reverseAgentCitationAssetIdsSchema.optional(),
  knowledgeBaseIds: z.array(nonEmptyTrimmedStringSchema).superRefine((ids, context) => {
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['knowledgeBaseIds'],
        message: 'Agent node knowledge bases must be distinct',
      });
    }
  }),
}).strict();

export const MAX_REVERSE_PROMPT_MP4_BYTES = 20 * 1024 * 1024;

export const managedMp4InputSnapshotSchema = projectVideoAssetSchema.superRefine((asset, context) => {
  if (asset.byteSize > MAX_REVERSE_PROMPT_MP4_BYTES) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['byteSize'],
      message: 'Original MP4 exceeds the 20 MiB direct reverse-analysis payload limit',
    });
  }
});
const orderedAgentImageMediaItemSchema = z.object({
  kind: z.literal('image'),
  assetId: z.string().min(1),
  byteSize: z.number().int().nonnegative(),
  label: z.string().trim().min(1).max(120),
  mediaType: z.enum(['image/gif', 'image/jpeg', 'image/png', 'image/webp']),
  order: z.number().int().nonnegative(),
  role: referenceRoleSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/u, 'Asset hash must be a lowercase SHA-256 digest'),
}).strict();

const orderedAgentVideoMediaItemSchema = z.object({
  kind: z.literal('video'),
  assetId: z.string().regex(/^[a-f0-9]{16}$/u, 'Asset id must be a content-addressed id'),
  byteSize: z.number().int().nonnegative().max(MAX_REVERSE_PROMPT_MP4_BYTES, 'Original MP4 exceeds the 20 MiB direct reverse-analysis payload limit'),
  durationMs: z.number().int().positive(),
  extension: z.literal('mp4'),
  height: z.number().int().positive(),
  label: z.string().trim().min(1).max(120),
  mediaType: z.literal('video/mp4'),
  order: z.number().int().nonnegative(),
  origin: z.literal('imported'),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u, 'Asset hash must be a lowercase SHA-256 digest'),
  width: z.number().int().positive(),
}).strict().superRefine((asset, context) => {
  if (!asset.sha256.startsWith(asset.assetId)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['assetId'], message: 'Asset id must match the SHA-256 prefix' });
  }
});

export const orderedAgentMediaItemSchema = z.union([
  orderedAgentImageMediaItemSchema,
  orderedAgentVideoMediaItemSchema,
]);

const orderedAgentMediaSchema = z.array(orderedAgentMediaItemSchema)
  .max(MAX_GENERATION_REFERENCES, 'Agent media is limited to 20 images or videos')
  .superRefine((media, context) => {
    const assetIds = new Set<string>();
    for (const [index, item] of media.entries()) {
      if (assetIds.has(item.assetId)) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: [index, 'assetId'], message: 'Agent media cannot contain duplicate assets' });
      }
      assetIds.add(item.assetId);
      if (item.order !== index) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: [index, 'order'], message: 'Agent media order must be continuous from zero' });
      }
    }
  });

const reversePromptReferenceSchema = z.array(orderedReferenceSchema)
  .max(MAX_GENERATION_REFERENCES, '参考图最多 20 张')
  .superRefine((references, context) => {
    const assetIds = new Set<string>();
    for (const [index, reference] of references.entries()) {
      if (assetIds.has(reference.assetId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, 'assetId'],
          message: '参考图不能重复',
        });
      }
      assetIds.add(reference.assetId);
    }
  });

const reversePromptReferenceAssetIdsSchema = z.array(z.string().min(1))
  .max(MAX_GENERATION_REFERENCES, '参考图最多 20 张')
  .superRefine((assetIds, context) => {
    if (new Set(assetIds).size !== assetIds.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: '参考图不能重复' });
    }
  });

export const reversePromptRunSchema = z.object({
  sessionId: z.string().min(1),
  nonce: z.string().min(1),
  createdAt: z.string().datetime(),
  projectId: z.string().min(1),
  skill: z.object({ id: z.string().min(1), version: z.string().min(1) }).strict(),
  persona: reversePromptPersonaSchema,
  agentConfig: reverseAgentNodeConfigSchema.optional(),
  knowledgeLease: agentKnowledgeLeaseSchema,
  approvedMemorySnapshot: approvedMemorySnapshotSchema,
  projectMemoryIds: z.array(z.string().min(1)).default([]),
  references: reversePromptReferenceSchema,
  referenceAssetIds: reversePromptReferenceAssetIdsSchema,
  videoInput: managedMp4InputSnapshotSchema.optional(),
  orderedMedia: orderedAgentMediaSchema.default([]),
}).strict().superRefine((run, context) => {
  if (run.sessionId !== run.knowledgeLease.runId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['sessionId'],
      message: 'Reverse-prompt sessionId must match knowledge lease runId',
    });
  }
  if (!orderedReferencesMatch(run.references, run.knowledgeLease.references)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['knowledgeLease', 'references'],
      message: 'Knowledge lease references must match reverse-prompt references',
    });
  }

  const orderedImageAssetIds = run.orderedMedia
    .filter((item): item is z.infer<typeof orderedAgentImageMediaItemSchema> => item.kind === 'image')
    .map((item) => item.assetId);
  const referenceAssetIds = run.references.map((reference) => reference.assetId);
  if (
    run.orderedMedia.length > 0
    && (orderedImageAssetIds.length !== referenceAssetIds.length
      || orderedImageAssetIds.some((assetId, index) => assetId !== referenceAssetIds[index]))
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['orderedMedia'],
      message: 'Ordered Agent image media must match reverse-prompt references',
    });
  }
  if (
    referenceAssetIds.length !== run.referenceAssetIds.length
    || referenceAssetIds.some((assetId, index) => assetId !== run.referenceAssetIds[index])
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['referenceAssetIds'],
      message: 'Reference asset ids must match ordered references',
    });
  }

  if (run.agentConfig !== undefined) {
    const leasedKnowledgeBaseIds = run.knowledgeLease.snapshots
      .map((snapshot) => snapshot.knowledgeBaseId)
      .sort();
    const selectedKnowledgeBaseIds = [...run.agentConfig.knowledgeBaseIds].sort();
    if (
      leasedKnowledgeBaseIds.length !== selectedKnowledgeBaseIds.length
      || leasedKnowledgeBaseIds.some((id, index) => id !== selectedKnowledgeBaseIds[index])
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['knowledgeLease', 'snapshots'],
        message: 'Knowledge lease must pin the Agent node selected knowledge bases',
      });
    }
  }
});

const professionalDetailListSchema = z.array(nonEmptyTrimmedStringSchema).min(1);

const mediaResponsibilitySchema = z.object({
  mention: z.string().regex(/^@(图片|视频)\d{1,2}$/u).optional(),
  sourceId: nonEmptyTrimmedStringSchema,
  label: nonEmptyTrimmedStringSchema.optional(),
  role: nonEmptyTrimmedStringSchema,
  priority: z.enum(['primary', 'secondary', 'supporting']),
  inheritance: z.array(nonEmptyTrimmedStringSchema).default([]),
  conflicts: z.array(nonEmptyTrimmedStringSchema).default([]),
  usableElements: professionalDetailListSchema,
}).strict();

const sceneObjectSchema = z.object({
  name: nonEmptyTrimmedStringSchema,
  role: nonEmptyTrimmedStringSchema,
  placement: nonEmptyTrimmedStringSchema,
  scaleAndProportion: nonEmptyTrimmedStringSchema,
  depthLayer: z.enum(['foreground', 'midground', 'background']),
  occlusionAndZOrder: nonEmptyTrimmedStringSchema,
}).strict();

const effectAnalysisSchema = z.object({
  type: nonEmptyTrimmedStringSchema,
  purpose: nonEmptyTrimmedStringSchema,
  recreation: professionalDetailListSchema,
  productAdaptation: nonEmptyTrimmedStringSchema,
  sourceOrEmitter: nonEmptyTrimmedStringSchema.optional(),
  motionAndTiming: nonEmptyTrimmedStringSchema.optional(),
  parameters: z.array(nonEmptyTrimmedStringSchema).optional(),
  masksAndCompositing: z.array(nonEmptyTrimmedStringSchema).optional(),
  renderPasses: z.array(nonEmptyTrimmedStringSchema).optional(),
}).strict();

const fluidAnalysisSchema = z.object({
  type: nonEmptyTrimmedStringSchema,
  purpose: nonEmptyTrimmedStringSchema,
  physicalBehavior: nonEmptyTrimmedStringSchema,
  productionMethod: professionalDetailListSchema,
  shadingAndTexture: nonEmptyTrimmedStringSchema,
  productInteraction: nonEmptyTrimmedStringSchema,
  safetyConstraints: professionalDetailListSchema,
}).strict();

const videoTimelineShotSchema = z.object({
  timeRange: nonEmptyTrimmedStringSchema,
  shotType: nonEmptyTrimmedStringSchema,
  estimatedFocalLength: nonEmptyTrimmedStringSchema,
  cameraMovement: nonEmptyTrimmedStringSchema,
  speedCurveAndStabilization: nonEmptyTrimmedStringSchema,
  subjectAction: nonEmptyTrimmedStringSchema,
  lightingAndSweep: nonEmptyTrimmedStringSchema,
  effects: z.array(nonEmptyTrimmedStringSchema).optional(),
  transition: nonEmptyTrimmedStringSchema,
  keyframes: professionalDetailListSchema,
  productAdaptation: nonEmptyTrimmedStringSchema,
}).strict();

export const seedance25TaskTypeSchema = z.enum([
  'text_to_video',
  'multi_reference',
  'long_video',
  'video_edit',
  'extend_forward',
  'extend_backward',
  'first_last_frame',
  'multi_keyframe',
  'storyboard',
  'coarse_blocking',
  'fine_blocking',
  'one_click_film',
  'seamless_transition',
]);

const promptLogicSchema = z.object({
  subject: nonEmptyTrimmedStringSchema,
  action: nonEmptyTrimmedStringSchema,
  environment: nonEmptyTrimmedStringSchema,
  cameraAndComposition: nonEmptyTrimmedStringSchema,
  lightingAndColor: nonEmptyTrimmedStringSchema,
  materialsAndTextures: nonEmptyTrimmedStringSchema,
  effectsOrFluids: nonEmptyTrimmedStringSchema,
  styleAndQuality: nonEmptyTrimmedStringSchema,
  rationale: professionalDetailListSchema,
}).strict();

const seedance25AssetBindingSchema = z.object({
  sourceId: nonEmptyTrimmedStringSchema,
  target: nonEmptyTrimmedStringSchema,
  adopt: professionalDetailListSchema,
  reject: z.array(nonEmptyTrimmedStringSchema),
}).strict();

const seedance25StageSchema = z.object({
  label: nonEmptyTrimmedStringSchema,
  startState: nonEmptyTrimmedStringSchema,
  mainEvent: nonEmptyTrimmedStringSchema,
  endState: nonEmptyTrimmedStringSchema,
  carryForward: professionalDetailListSchema,
}).strict();

const seedance25ShotSchema = z.object({
  label: nonEmptyTrimmedStringSchema,
  shotSize: nonEmptyTrimmedStringSchema,
  camera: nonEmptyTrimmedStringSchema,
  movement: nonEmptyTrimmedStringSchema,
  action: nonEmptyTrimmedStringSchema,
  lightingAndEffects: nonEmptyTrimmedStringSchema,
  transition: nonEmptyTrimmedStringSchema,
  audio: nonEmptyTrimmedStringSchema,
}).strict();

const seedance25ResultSchema = z.object({
  taskType: seedance25TaskTypeSchema,
  rationale: nonEmptyTrimmedStringSchema,
  assetBindings: z.array(seedance25AssetBindingSchema).min(1),
  subjectContinuity: professionalDetailListSchema,
  stages: z.array(seedance25StageSchema).min(1),
  shots: z.array(seedance25ShotSchema).min(1),
  audioPlan: professionalDetailListSchema,
  parameterLocks: professionalDetailListSchema,
  promptZh: nonEmptyTrimmedStringSchema,
  promptEn: nonEmptyTrimmedStringSchema,
  negativeConstraints: professionalDetailListSchema,
  capabilityBoundaries: professionalDetailListSchema,
}).strict();

export const reversePromptResultSchema = z.object({
  sessionId: z.string().min(1),
  nonce: z.string().min(1),
  knowledgeSnapshotVersion: z.string().min(1),
  analysis: z.string().min(1),
  keywords: z.array(z.string().min(1)).min(1),
  positivePrompt: z.string().min(1),
  negativeConstraints: z.array(z.string().min(1)).min(1),
  executionChecklist: z.array(z.string().min(1)).min(1),
  mediaResponsibilities: z.array(mediaResponsibilitySchema).optional(),
  sceneDecomposition: z.object({
    spatialStructure: nonEmptyTrimmedStringSchema,
    spatialDepth: nonEmptyTrimmedStringSchema.optional(),
    objects: z.array(sceneObjectSchema).min(1),
  }).strict().optional(),
  composition: z.object({
    visualCenter: nonEmptyTrimmedStringSchema,
    whitespaceAndSafeArea: nonEmptyTrimmedStringSchema,
    guidingLinesAndBalance: nonEmptyTrimmedStringSchema,
    cropAndAspectRatio: nonEmptyTrimmedStringSchema,
  }).strict().optional(),
  camera: z.object({
    estimatedFocalLength: nonEmptyTrimmedStringSchema,
    shotSize: nonEmptyTrimmedStringSchema,
    positionAndAngle: nonEmptyTrimmedStringSchema,
    perspectiveAndVanishingPoints: nonEmptyTrimmedStringSchema,
    distortion: nonEmptyTrimmedStringSchema,
    confidence: nonEmptyTrimmedStringSchema,
  }).strict().optional(),
  depthAndFocus: z.object({
    focusSubjectAndPlane: nonEmptyTrimmedStringSchema,
    depthOfField: nonEmptyTrimmedStringSchema,
    foregroundBlur: nonEmptyTrimmedStringSchema,
    backgroundBlur: nonEmptyTrimmedStringSchema,
    separationMethod: nonEmptyTrimmedStringSchema,
  }).strict().optional(),
  materialsAndTextures: z.array(z.object({
    object: nonEmptyTrimmedStringSchema,
    material: nonEmptyTrimmedStringSchema,
    roughnessReflectionTransmission: nonEmptyTrimmedStringSchema,
    textureScaleAndDetail: nonEmptyTrimmedStringSchema,
    productionMethod: nonEmptyTrimmedStringSchema,
  }).strict()).optional(),
  lightingAndColor: z.object({
    keyFillRimEnvironment: professionalDetailListSchema,
    sweepLight: nonEmptyTrimmedStringSchema,
    colorTemperatureAndPalette: nonEmptyTrimmedStringSchema,
    contrastAndHighlightRolloff: nonEmptyTrimmedStringSchema,
    reflectionsAndVolumetrics: nonEmptyTrimmedStringSchema,
    premiumLookRationale: professionalDetailListSchema,
  }).strict().optional(),
  effects: z.array(effectAnalysisSchema).optional(),
  fluids: z.array(fluidAnalysisSchema).optional(),
  whiteBackgroundAdaptation: z.object({
    silhouetteProtection: professionalDetailListSchema,
    grounding: professionalDetailListSchema,
    contaminationPrevention: professionalDetailListSchema,
    doNotCopy: professionalDetailListSchema,
  }).strict().optional(),
  subjectScaleAndPlacement: z.array(z.object({
    subject: nonEmptyTrimmedStringSchema,
    relativeScale: nonEmptyTrimmedStringSchema,
    placement: nonEmptyTrimmedStringSchema,
    constraints: professionalDetailListSchema,
  }).strict()).optional(),
  videoTimeline: z.array(videoTimelineShotSchema).optional(),
  promptLogic: promptLogicSchema.optional(),
  seedance25: seedance25ResultSchema.optional(),
  positivePromptZh: nonEmptyTrimmedStringSchema.optional(),
  positivePromptEn: nonEmptyTrimmedStringSchema.optional(),
  uncertainties: z.array(nonEmptyTrimmedStringSchema).optional(),
}).strict();

export type ReversePromptPersona = z.infer<typeof reversePromptPersonaSchema>;
export type ReverseAgentNodeConfig = z.infer<typeof reverseAgentNodeConfigSchema>;
export type ManagedMp4InputSnapshot = z.infer<typeof managedMp4InputSnapshotSchema>;
export type OrderedAgentMediaItem = z.infer<typeof orderedAgentMediaItemSchema>;
export type ApprovedMemorySnapshot = z.infer<typeof approvedMemorySnapshotSchema>;
export type ReversePromptRun = z.infer<typeof reversePromptRunSchema>;
export type ReversePromptResult = z.infer<typeof reversePromptResultSchema>;

interface RunDeps {
  createNonce?: () => string;
  now?: () => string;
}

interface CreateReversePromptRunInput {
  projectId: string;
  skill: { id: string; version: string };
  persona?: ReversePromptPersona;
  agentConfig?: ReverseAgentNodeConfig;
  knowledgeLease: AgentKnowledgeLease;
  approvedMemorySnapshot: ApprovedMemorySnapshot;
  projectMemoryIds?: string[];
  references: ReversePromptRun['references'];
  videoInput?: ManagedMp4InputSnapshot;
  orderedMedia?: OrderedAgentMediaItem[];
}

export function createReversePromptRun(
  input: CreateReversePromptRunInput,
  deps: RunDeps = {},
): ReversePromptRun {
  const normalizedReferences = input.references.map((reference, index) => ({ ...reference, position: index }));
  const orderedMedia = input.orderedMedia ?? [
    ...normalizedReferences.map((reference, order) => ({
      kind: 'image' as const,
      assetId: reference.assetId,
      byteSize: 0,
      label: reference.label,
      mediaType: 'image/png' as const,
      order,
      role: reference.role,
      sha256: '0'.repeat(64),
    })),
    ...(input.videoInput === undefined ? [] : [{ kind: 'video' as const, ...input.videoInput, order: normalizedReferences.length }]),
  ];
  return reversePromptRunSchema.parse({
    sessionId: input.knowledgeLease?.runId ?? '',
    nonce: (deps.createNonce ?? createUniqueValue)(),
    createdAt: (deps.now ?? (() => new Date().toISOString()))(),
    projectId: input.projectId,
    skill: input.skill,
    persona: input.persona ?? DEFAULT_REVERSE_PROMPT_PERSONA,
    agentConfig: input.agentConfig,
    knowledgeLease: input.knowledgeLease,
    approvedMemorySnapshot: input.approvedMemorySnapshot,
    projectMemoryIds: input.projectMemoryIds ?? [],
    references: normalizedReferences,
    referenceAssetIds: normalizedReferences.map((reference) => reference.assetId),
    videoInput: input.videoInput,
    orderedMedia,
  });
}

export function parseReversePromptResult(input: unknown, run: ReversePromptRun): ReversePromptResult {
  const result = reversePromptResultSchema.parse(input);
  if (
    result.sessionId !== run.sessionId
    || result.nonce !== run.nonce
    || result.knowledgeSnapshotVersion !== run.knowledgeLease.versionKey
  ) {
    throw new Error('反推结果运行身份不匹配');
  }
  validateMediaResponsibilities(result, run);
  return result;
}

function validateMediaResponsibilities(result: ReversePromptResult, run: ReversePromptRun): void {
  // Keep compatibility with older provider responses that predate the
  // structured responsibility section. New responses that include the
  // section are validated strictly so no cited asset can be silently omitted.
  if (run.orderedMedia.length === 0 || result.mediaResponsibilities === undefined) return;
  const expected = new Map<string, string>();
  let imageNumber = 0;
  let videoNumber = 0;
  for (const item of [...run.orderedMedia].sort((left, right) => left.order - right.order)) {
    const mention = item.kind === 'image'
      ? `@图片${++imageNumber}`
      : `@视频${++videoNumber}`;
    expected.set(mention, item.assetId);
  }
  const actual = result.mediaResponsibilities ?? [];
  const actualMentions = new Set<string>();
  const mismatches: string[] = [];
  for (const responsibility of actual) {
    if (responsibility.mention === undefined) continue;
    actualMentions.add(responsibility.mention);
    const expectedSourceId = expected.get(responsibility.mention);
    if (expectedSourceId !== undefined && responsibility.sourceId !== expectedSourceId) {
      mismatches.push(`${responsibility.mention} 应对应 ${expectedSourceId}，实际为 ${responsibility.sourceId}`);
    }
  }
  const missing = [...expected.keys()].filter((mention) => !actualMentions.has(mention));
  if (missing.length > 0 || mismatches.length > 0) {
    throw new Error(`反推结果必须逐张输出素材职责；缺少 ${missing.join('、') || '无'}${mismatches.length > 0 ? `；映射错误：${mismatches.join('；')}` : ''}`);
  }
}

function createUniqueValue(): string {
  const cryptoApi = globalThis.crypto as Crypto | undefined;
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}
