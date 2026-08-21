import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import {
  DEFAULT_REVERSE_PROMPT_PERSONA,
  MAX_REVERSE_PROMPT_MP4_BYTES,
  createReversePromptRun,
  managedMp4InputSnapshotSchema,
  normalizeReverseRolePreference,
  parseReversePromptResult,
  reverseAgentNodeConfigSchema,
  reversePromptPersonaSchema,
  reversePromptResultSchema,
} from './reverse-prompt-agent';
import {
  createAgentKnowledgeLease,
} from './knowledge-context';

const snapshot = {
  version: 'approved-2026-07-13-2',
  approvedAt: '2026-07-13T12:00:00.000Z',
  approvedMemoryIds: ['memory-1', 'memory-2'],
};

const references = [
  { assetId: 'asset-product', label: 'Product', role: 'product_identity' as const, position: 0 },
  { assetId: 'asset-scene', label: 'Scene', role: 'scene_composition' as const, position: 1 },
];

const agentConfig = {
  modelRoute: 'comfly/vision-video-pro',
  role: 'Commercial visual analyst',
  task: 'Analyze the original video and produce an image-generation prompt.',
  knowledgeBaseIds: ['ecommerce-detail', 'scene-skill'],
};

const managedVideoInput = {
  assetId: 'a'.repeat(16),
  byteSize: 1_024,
  durationMs: 4_800,
  extension: 'mp4' as const,
  height: 1_080,
  label: 'Launch film',
  mediaType: 'video/mp4' as const,
  origin: 'imported' as const,
  sha256: 'a'.repeat(64),
  width: 1_920,
};
function orderedImage(order: number) {
  return {
    kind: 'image' as const,
    assetId: `ordered-image-${order}`,
    byteSize: 128 + order,
    label: `Ordered image ${order}`,
    mediaType: 'image/png' as const,
    order,
    role: 'scene_composition' as const,
    sha256: order.toString(16).padStart(64, '0'),
  };
}

function orderedVideo(order: number) {
  const assetId = (order + 32).toString(16).padStart(16, '0');
  return {
    kind: 'video' as const,
    assetId,
    byteSize: 1_024 + order,
    durationMs: 4_800 + order,
    extension: 'mp4' as const,
    height: 1_080,
    label: `Ordered video ${order}`,
    mediaType: 'video/mp4' as const,
    order,
    origin: 'imported' as const,
    sha256: assetId.padEnd(64, 'f'),
    width: 1_920,
  };
}

function createKnowledgeLease(runId = 'run-1') {
  return createAgentKnowledgeLease({
    runId,
    capability: 'reverse_prompt',
    snapshots: [
      { knowledgeBaseId: 'scene-skill', version: 3, contentHash: 'b'.repeat(64) },
      { knowledgeBaseId: 'ecommerce-detail', version: 2, contentHash: 'a'.repeat(64) },
    ],
    references,
    citations: [{ assetId: 'asset-scene', label: 'Scene' }],
  }, {
    leaseId: `lease-${runId}`,
    createdAt: '2026-07-15T10:00:00.000Z',
  });
}

function deps(ids: string[], nonces: string[]) {
  return {
    createId: () => ids.shift()!,
    createNonce: () => nonces.shift()!,
    now: () => '2026-07-13T12:01:00.000Z',
  };
}

describe('reverse prompt personas', () => {
  it('uses the approved senior commercial visual persona by default', () => {
    expect(DEFAULT_REVERSE_PROMPT_PERSONA.id).toBe('commercial_visual_director');
    expect(reversePromptPersonaSchema.parse(DEFAULT_REVERSE_PROMPT_PERSONA)).toEqual(DEFAULT_REVERSE_PROMPT_PERSONA);
  });

  it.each(['ecommerce_key_visual', 'brand_poster', 'composition_director', 'material_lighting_director'])('supports specialist persona %s', (id) => {
    expect(() => reversePromptPersonaSchema.parse({ id, label: '娑撴挷绗熺憴鎺曞' })).not.toThrow();
  });

  it('keeps the professional persona authoritative over meaningless role input', () => {
    expect(normalizeReverseRolePreference('1')).toBeUndefined();
    expect(normalizeReverseRolePreference('  12  ')).toBeUndefined();
    expect(normalizeReverseRolePreference('摄影')).toBeUndefined();
    expect(normalizeReverseRolePreference('资深食品商业摄影指导')).toBe('资深食品商业摄影指导');
  });
});

describe('reverse prompt runs', () => {
  it('allows an Agent node to select zero or more distinct knowledge bases', () => {
    expect(reverseAgentNodeConfigSchema.parse(agentConfig)).toEqual(agentConfig);
    expect(() => reverseAgentNodeConfigSchema.parse({ ...agentConfig, modelRoute: '' })).toThrow(ZodError);
    expect(() => reverseAgentNodeConfigSchema.parse({ ...agentConfig, role: ' ' })).toThrow(ZodError);
    expect(() => reverseAgentNodeConfigSchema.parse({ ...agentConfig, task: '' })).toThrow(ZodError);
    expect(reverseAgentNodeConfigSchema.parse({ ...agentConfig, knowledgeBaseIds: [] })).toMatchObject({ knowledgeBaseIds: [] });
    expect(reverseAgentNodeConfigSchema.parse({ ...agentConfig, knowledgeBaseIds: ['scene-skill'] })).toMatchObject({ knowledgeBaseIds: ['scene-skill'] });
    expect(reverseAgentNodeConfigSchema.parse({
      ...agentConfig,
      knowledgeBaseIds: ['brand-rules', 'scene-skill', 'product-detail'],
    })).toMatchObject({ knowledgeBaseIds: ['brand-rules', 'scene-skill', 'product-detail'] });
    expect(() => reverseAgentNodeConfigSchema.parse({ ...agentConfig, knowledgeBaseIds: ['scene-skill', 'scene-skill'] })).toThrow(ZodError);
  });

  it('persists distinct managed image citation ids in an Agent node config', () => {
    const withCitations = { ...agentConfig, referenceAssetIds: ['image-a', 'image-b'] };
    expect(reverseAgentNodeConfigSchema.parse(withCitations)).toEqual(withCitations);
    expect(() => reverseAgentNodeConfigSchema.parse({ ...agentConfig, referenceAssetIds: ['image-a', 'image-a'] })).toThrow(ZodError);
    expect(() => reverseAgentNodeConfigSchema.parse({
      ...agentConfig,
      referenceAssetIds: Array.from({ length: 21 }, (_, index) => `image-${index}`),
    })).toThrow(ZodError);
  });
  it('captures an imported managed MP4 snapshot without any local path or URL', () => {
    expect(managedMp4InputSnapshotSchema.parse(managedVideoInput)).toEqual(managedVideoInput);
    expect(() => managedMp4InputSnapshotSchema.parse({ ...managedVideoInput, mediaType: 'video/webm' })).toThrow(ZodError);
    expect(() => managedMp4InputSnapshotSchema.parse({ ...managedVideoInput, assetId: 'C:/unsafe.mp4' })).toThrow(ZodError);
  });

  it('rejects an original MP4 that exceeds the direct reverse-analysis payload limit', () => {
    expect(() => managedMp4InputSnapshotSchema.parse({
      ...managedVideoInput,
      byteSize: MAX_REVERSE_PROMPT_MP4_BYTES + 1,
    })).toThrow(/20 MiB/u);
  });
  it('preserves twenty interleaved managed images and MP4 videos in one ordered media list', () => {
    const orderedMedia = Array.from({ length: 20 }, (_, order) => order % 2 === 0
      ? orderedImage(order)
      : orderedVideo(order));
    const imageReferences = orderedMedia
      .filter((item): item is ReturnType<typeof orderedImage> => item.kind === 'image')
      .map((item, position) => ({ assetId: item.assetId, label: item.label, role: item.role, position }));
    const knowledgeLease = createAgentKnowledgeLease({
      runId: 'run-mixed-20',
      capability: 'reverse_prompt',
      snapshots: [],
      references: imageReferences,
      citations: [],
    }, { leaseId: 'lease-mixed-20', createdAt: '2026-08-06T08:00:00.000Z' });

    const run = createReversePromptRun({
      projectId: 'project-1',
      skill: { id: 'scene-skill', version: 'v2' },
      knowledgeLease,
      approvedMemorySnapshot: snapshot,
      references: imageReferences,
      orderedMedia,
    } as unknown as Parameters<typeof createReversePromptRun>[0]);

    expect((run as unknown as { orderedMedia: unknown[] }).orderedMedia).toEqual(orderedMedia);
    expect(run.referenceAssetIds).toEqual(imageReferences.map((reference) => reference.assetId));
  });

  it('rejects a twenty-first ordered Agent media item instead of silently truncating it', () => {
    const orderedMedia = Array.from({ length: 21 }, (_, order) => orderedVideo(order));
    const knowledgeLease = createAgentKnowledgeLease({
      runId: 'run-media-21', capability: 'reverse_prompt', snapshots: [], references: [], citations: [],
    }, { leaseId: 'lease-media-21', createdAt: '2026-08-06T08:00:00.000Z' });

    expect(() => createReversePromptRun({
      projectId: 'project-1',
      skill: { id: 'scene-skill', version: 'v2' },
      knowledgeLease,
      approvedMemorySnapshot: snapshot,
      references: [],
      orderedMedia,
    } as unknown as Parameters<typeof createReversePromptRun>[0])).toThrow(/20/u);
  });

  it('rejects duplicate asset identities and non-contiguous ordered media positions', () => {
    const knowledgeLease = createAgentKnowledgeLease({
      runId: 'run-invalid-media', capability: 'reverse_prompt', snapshots: [], references: [], citations: [],
    }, { leaseId: 'lease-invalid-media', createdAt: '2026-08-06T08:00:00.000Z' });
    const base = {
      projectId: 'project-1',
      skill: { id: 'scene-skill', version: 'v2' },
      knowledgeLease,
      approvedMemorySnapshot: snapshot,
      references: [],
    };

    expect(() => createReversePromptRun({
      ...base,
      orderedMedia: [orderedVideo(0), { ...orderedVideo(1), assetId: orderedVideo(0).assetId }],
    } as unknown as Parameters<typeof createReversePromptRun>[0])).toThrow(/duplicate|重复/iu);
    expect(() => createReversePromptRun({
      ...base,
      orderedMedia: [orderedVideo(0), { ...orderedVideo(1), order: 3 }],
    } as unknown as Parameters<typeof createReversePromptRun>[0])).toThrow(/order|顺序/iu);
  });

  it('captures the newest approved memory snapshot and pinned ordered references', () => {
    const knowledgeLease = createKnowledgeLease('run-1');
    const run = createReversePromptRun({
      projectId: 'project-1',
      skill: { id: 'scene-skill', version: 'v2' },
      agentConfig,
      knowledgeLease,
      approvedMemorySnapshot: snapshot,
      projectMemoryIds: ['project-memory-1'],
      references,
      videoInput: managedVideoInput,
    }, deps(['session-1'], ['nonce-1']));

    expect(run).toMatchObject({
      sessionId: 'run-1',
      nonce: 'nonce-1',
      persona: DEFAULT_REVERSE_PROMPT_PERSONA,
      agentConfig,
      knowledgeLease,
      approvedMemorySnapshot: snapshot,
      projectMemoryIds: ['project-memory-1'],
      references,
      videoInput: managedVideoInput,
    });
  });

  it('rejects references that differ from the pinned lease', () => {
    const knowledgeLease = createKnowledgeLease('run-1');
    expect(() => createReversePromptRun({
      projectId: 'project-1',
      skill: { id: 'scene-skill', version: 'v2' },
      agentConfig,
      knowledgeLease,
      approvedMemorySnapshot: snapshot,
      references: [...references].reverse(),
    })).toThrow(ZodError);
  });

  it('requires an explicit knowledge lease', () => {
    const legacyInput = {
      projectId: 'project-1',
      skill: { id: 'scene-skill', version: 'v2' },
      approvedMemorySnapshot: snapshot,
      references,
    } as unknown as Parameters<typeof createReversePromptRun>[0];

    expect(() => createReversePromptRun(legacyInput)).toThrow(ZodError);
  });

  it('creates a fresh session and nonce every time even when references are unchanged', () => {
    const identity = deps(['session-1', 'session-2'], ['nonce-1', 'nonce-2']);
    const first = createReversePromptRun({
      projectId: 'project-1',
      skill: { id: 'scene-skill', version: 'v2' },
      agentConfig,
      knowledgeLease: createKnowledgeLease('run-1'),
      approvedMemorySnapshot: snapshot,
      projectMemoryIds: ['project-memory-1'],
      references,
    }, identity);
    const second = createReversePromptRun({
      projectId: 'project-1',
      skill: { id: 'scene-skill', version: 'v2' },
      agentConfig,
      knowledgeLease: createKnowledgeLease('run-2'),
      approvedMemorySnapshot: { ...snapshot, version: 'approved-2026-07-13-3' },
      projectMemoryIds: ['project-memory-1'],
      references,
    }, identity);
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(second.sessionId).toBe('run-2');
    expect(second.nonce).not.toBe(first.nonce);
    expect(second.approvedMemorySnapshot.version).toBe('approved-2026-07-13-3');
  });

  it('rejects more than 20 references with a stable max-reference issue', () => {
    try {
      createReversePromptRun({
      projectId: 'project-1',
      skill: { id: 'scene-skill', version: 'v2' },
      agentConfig,
      knowledgeLease: createKnowledgeLease('run-1'),
        approvedMemorySnapshot: snapshot,
        references: Array.from({ length: 21 }, (_, index) => ({
          assetId: `asset-${index}`,
          label: `Asset ${index}`,
          role: index % 2 === 0 ? 'product_identity' as const : 'material_lighting' as const,
          position: index,
        })),
      });
      throw new Error('expected createReversePromptRun to reject more than 20 references');
    } catch (error) {
      expect(error).toBeInstanceOf(ZodError);
      expect((error as ZodError).issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: 'too_big',
          maximum: 20,
          path: ['references'],
        }),
        expect.objectContaining({
          code: 'too_big',
          maximum: 20,
          path: ['referenceAssetIds'],
        }),
      ]));
    }
  });

  it('requires structured output to match the current run identity', () => {
    const knowledgeLease = createKnowledgeLease('run-1');
    const run = createReversePromptRun({
      projectId: 'project-1',
      skill: { id: 'scene-skill', version: 'v2' },
      agentConfig,
      knowledgeLease,
      approvedMemorySnapshot: snapshot,
      projectMemoryIds: ['project-memory-1'],
      references,
    }, deps(['session-1'], ['nonce-1']));
    const result = {
      sessionId: run.sessionId,
      nonce: run.nonce,
      knowledgeSnapshotVersion: knowledgeLease.versionKey,
      analysis: 'Product identity is clear and the composition needs more depth.',
      keywords: ['premium product visual', 'left front key light'],
      positivePrompt: 'Premium product hero shot with centered framing and a left-front key light.',
      negativeConstraints: ['Do not alter the logo', 'Do not deform the product'],
      executionChecklist: ['Verify product identity', 'Verify safe area'],
      positivePromptZh: '白底产品主视觉，左前方柔和主光。',
      positivePromptEn: 'White-background product hero with a soft front-left key light.',
      effects: [{
        type: 'sweep_light',
        purpose: 'Reveal the premium edge finish',
        recreation: ['Animate a narrow soft mask across the product edge'],
        productAdaptation: 'Confine the sweep to the product alpha and preserve the logo.',
      }],
      whiteBackgroundAdaptation: {
        silhouetteProtection: ['Keep the full product contour readable'],
        grounding: ['Add a soft contact shadow beneath the product'],
        contaminationPrevention: ['Prevent colored light from tinting the white background'],
        doNotCopy: ['Do not copy the reference brand mark'],
      },
    };
    expect(parseReversePromptResult(result, run)).toEqual(result);
    expect(() => parseReversePromptResult({ ...result, knowledgeSnapshotVersion: '' }, run)).toThrow(ZodError);
    expect(() => parseReversePromptResult({ ...result, knowledgeSnapshotVersion: 'stale-version' }, run)).toThrowError(Error);
  });

  it('rejects a lease that does not pin the node-selected two knowledge bases', () => {
    expect(() => createReversePromptRun({
      projectId: 'project-1',
      skill: { id: 'scene-skill', version: 'v2' },
      agentConfig,
      knowledgeLease: createAgentKnowledgeLease({
        runId: 'run-legacy',
        capability: 'reverse_prompt',
        snapshots: [],
        references,
        citations: [],
      }, {
        leaseId: 'lease-legacy',
        createdAt: '2026-07-15T10:00:00.000Z',
      }),
      approvedMemorySnapshot: snapshot,
      references,
    }, deps(['session-ignored'], ['nonce-1']))).toThrow(ZodError);
  });

  it('accepts detailed prompt logic and a complete Seedance 2.5 result document', () => {
    const legacyResult = {
      sessionId: 'run-1',
      nonce: 'nonce-1',
      knowledgeSnapshotVersion: 'knowledge-v1',
      analysis: '制作级分析',
      keywords: ['commercial product film'],
      positivePrompt: '产品主视觉',
      negativeConstraints: ['不要改变产品结构'],
      executionChecklist: ['检查产品身份'],
    };
    const result = reversePromptResultSchema.parse({
      ...legacyResult,
      promptLogic: {
        subject: '同一白底产品，保持轮廓、Logo 和包装文字。',
        action: '产品沿原路径缓慢旋转。',
        environment: '深色摄影棚与受控反射环境。',
        cameraAndComposition: '中近景，低机位缓慢环绕。',
        lightingAndColor: '冷色轮廓光与暖色窄幅扫光。',
        materialsAndTextures: '保留拉丝金属纹理与真实粗糙度。',
        effectsOrFluids: '扫光只作用于产品高光区。',
        styleAndQuality: '高端商业广告，真实摄影质感。',
        rationale: ['先锁定产品身份，再组织动作、镜头、灯光与材质。'],
      },
      seedance25: {
        taskType: 'video_edit',
        rationale: '存在原视频母版并要求局部替换。',
        assetBindings: [{
          sourceId: 'video-1',
          target: '唯一编辑母版',
          adopt: ['动作、镜头、遮挡与声音'],
          reject: ['原商品外观'],
        }],
        subjectContinuity: ['商品始终只有一个，结构与 Logo 不变'],
        stages: [{
          label: '阶段一',
          startState: '原视频首帧状态',
          mainEvent: '只替换商品外观',
          endState: '商品保持原路径离场',
          carryForward: ['机位与声音连续'],
        }],
        shots: [{
          label: '镜头一',
          shotSize: '中景',
          camera: '固定机位，约 50mm 的自然透视效果',
          movement: '继承原镜头运动',
          action: '商品沿原路径移动',
          lightingAndEffects: '保持原扫光与反射变化',
          transition: '保持原切点',
          audio: '保留环境声',
        }],
        audioPlan: ['保留原对白、环境声和动作音效'],
        parameterLocks: ['比例和基本时长跟随输入视频'],
        promptZh: '编辑@视频1，只替换商品外观并保持原时间线。',
        promptEn: 'Edit @video1, replacing only the product appearance while preserving the original timeline.',
        negativeConstraints: ['不要新增商品'],
        capabilityBoundaries: ['不承诺逐帧完全重合'],
      },
    });

    expect(result.seedance25?.taskType).toBe('video_edit');
    expect(result.promptLogic?.materialsAndTextures).toMatch(/拉丝金属/u);
  });

  it('continues to accept legacy results without promptLogic or seedance25', () => {
    const result = reversePromptResultSchema.parse({
      sessionId: 'run-legacy',
      nonce: 'nonce-legacy',
      knowledgeSnapshotVersion: 'knowledge-legacy',
      analysis: 'Legacy analysis',
      keywords: ['legacy'],
      positivePrompt: 'Legacy prompt',
      negativeConstraints: ['Keep identity'],
      executionChecklist: ['Check identity'],
    });

    expect(result.promptLogic).toBeUndefined();
    expect(result.seedance25).toBeUndefined();
  });
});
