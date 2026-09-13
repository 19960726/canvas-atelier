import { describe, expect, it } from 'vitest';
import { createAgentKnowledgeLease, createReversePromptRun } from '@agent-canvas/domain';
import { parseReverseProviderResponse } from './reverse-provider-response.js';
import { extractGeminiReverseText, normalizeReverseProviderResult } from './reverse-provider-result.js';

const run = {
  sessionId: 'session-1',
  nonce: 'nonce-1',
  knowledgeLease: { versionKey: 'knowledge-v1' },
} as const;

const reference = { assetId: 'a'.repeat(16), label: 'Product', position: 0, role: 'product_identity' as const };
const fullRun = createReversePromptRun({
  projectId: 'project-1',
  skill: { id: 'reverse-prompt', version: 'v1' },
  agentConfig: { modelRoute: 'reverse-model', role: 'Analyst', task: 'Analyze.', knowledgeBaseIds: [] },
  knowledgeLease: createAgentKnowledgeLease({
    runId: 'run-1', capability: 'reverse_prompt', snapshots: [], references: [reference], citations: [],
  }, { leaseId: 'lease-1', createdAt: '2026-08-28T00:00:00.000Z' }),
  approvedMemorySnapshot: { version: 'approved-1', approvedAt: '2026-08-28T00:00:00.000Z', approvedMemoryIds: [] },
  references: [reference],
}, { createNonce: () => 'nonce-1', now: () => '2026-08-28T00:00:00.000Z' });

const validCore = {
  sessionId: fullRun.sessionId,
  nonce: fullRun.nonce,
  knowledgeSnapshotVersion: fullRun.knowledgeLease.versionKey,
  analysis: 'Complete analysis.',
  keywords: ['product'],
  positivePrompt: 'A product photograph.',
  negativeConstraints: ['No distortion.'],
  executionChecklist: ['Check product identity.'],
};

describe('normalizeReverseProviderResult', () => {
  it('marks missing chapters partial and preserves recognized detail from malformed chapters', () => {
    expect(normalizeReverseProviderResult({ ...validCore, composition: { visualCenter: '主体居中', providerDebug: 'private' }, camera: '焦距未知' }, run)).toMatchObject({
      completeness: { status: 'partial', missingSections: expect.arrayContaining(['materialsAndTextures']), invalidSections: ['composition', 'camera'] },
      partialSections: [ { section: 'composition', content: '{"visualCenter":"主体居中"}' }, { section: 'camera', content: '"焦距未知"' } ],
    });
    expect(JSON.stringify(normalizeReverseProviderResult({ ...validCore, composition: { visualCenter: '主体居中', providerDebug: 'private' } }, run))).not.toContain('private');
  });
  it('joins every Gemini text part before parsing the JSON document', () => {
    expect(extractGeminiReverseText([
      { text: '{"analysis":"完整' },
      { inlineData: { mimeType: 'image/png', data: 'ignored' } },
      { text: '分析"}' },
    ])).toBe('{"analysis":"完整分析"}');
  });

  it('parses final Gemini JSON without concatenating provider thought parts', () => {
    const text = extractGeminiReverseText([
      { thought: true, text: 'I should inspect the composition first.' },
      { text: JSON.stringify(validCore) },
    ]);
    expect(parseReverseProviderResponse({ text }, fullRun).positivePrompt).toBe(validCore.positivePrompt);
    expect(extractGeminiReverseText([{ thought: true, text: 'No final response yet.' }])).toBeUndefined();
  });

  it('drops extra responsibility metadata while preserving validated source coverage', () => {
    const result = parseReverseProviderResponse({ text: JSON.stringify({
      ...validCore,
      mediaResponsibilities: [{
        mention: '@图片1',
        sourceId: reference.assetId,
        role: 'product_identity',
        priority: 'primary',
        usableElements: ['Product geometry'],
        confidence: 0.9,
        providerTrace: 'not part of the result contract',
      }],
    }) }, fullRun);
    expect(result.mediaResponsibilities).toEqual([{
      mention: '@图片1',
      sourceId: reference.assetId,
      role: 'product_identity',
      priority: 'primary',
      usableElements: ['Product geometry'],
      inheritance: [],
      conflicts: [],
    }]);
  });

  it('recovers omitted mention from an exact unique source ID as in the live Gemini response', () => {
    const result = parseReverseProviderResponse({ text: JSON.stringify({
      ...validCore,
      mediaResponsibilities: [{
        sourceId: reference.assetId, label: '@图片1', role: 'composition | camera_motion',
        priority: 'primary', inheritance: ['Scene layout'], conflicts: ['Replace props'], usableElements: ['Perspective'],
      }],
    }) }, fullRun);
    expect(result.mediaResponsibilities?.[0]).toMatchObject({ mention: '@图片1', sourceId: reference.assetId, usableElements: ['Perspective'] });
  });

  it('does not hide an explicitly wrong mention or unknown source ID', () => {
    for (const entry of [
      { mention: '@图片2', sourceId: reference.assetId },
      { sourceId: 'unknown-source' },
      { mention: '@图片1', sourceId: 'unknown-source' },
    ]) {
      expect(() => parseReverseProviderResponse({ text: JSON.stringify({
        ...validCore, mediaResponsibilities: [{ ...entry, role: 'composition', priority: 'primary', usableElements: ['Perspective'] }],
      }) }, fullRun)).toThrow(expect.objectContaining({ reason: 'MEDIA_RESPONSIBILITIES_INVALID' }));
    }
  });

  it('uses per-kind numbering and source identity, never response position or an ambiguous duplicate', () => {
    const media = (kind: 'image' | 'video', assetId: string, order: number) => {
      const common = { assetId, order, label: assetId, sha256: 'a'.repeat(64), byteSize: 128 };
      return kind === 'image'
        ? { ...common, kind, mediaType: 'image/png' as const, role: 'scene_composition' as const }
        : { ...common, kind, mediaType: 'video/mp4' as const, extension: 'mp4' as const, durationMs: 1000, width: 100, height: 100, origin: 'imported' as const };
    };
    const orderedMedia = [media('image', 'image-a', 0), media('video', 'video-a', 1), media('image', 'image-b', 2)];
    const entries = ['image-b', 'video-a', 'image-a'].map(sourceId => ({ sourceId, role: 'composition', priority: 'primary', usableElements: ['Layout'] }));
    const result = normalizeReverseProviderResult({ ...validCore, mediaResponsibilities: entries }, { ...fullRun, orderedMedia }) as { mediaResponsibilities: Array<{ mention?: string }> };
    expect(result.mediaResponsibilities.map(item => item.mention)).toEqual(['@图片2', '@视频1', '@图片1']);
    const ambiguous = normalizeReverseProviderResult({ ...validCore, mediaResponsibilities: entries }, { ...fullRun, orderedMedia: [...orderedMedia, media('image', 'image-a', 3)] }) as typeof result;
    expect(ambiguous.mediaResponsibilities[2]?.mention).toBeUndefined();
  });

  it.each([
    [{ text: '{"analysis":"cut', finishReason: 'MAX_TOKENS' }, 'TRUNCATED'],
    [{ text: undefined }, 'NO_TEXT'],
    [{ text: 'not-json' }, 'INVALID_JSON'],
    [{ text: '{}' }, 'CORE_SCHEMA_INVALID'],
    [{ text: JSON.stringify({ ...validCore, sessionId: 'wrong-session' }) }, 'IDENTITY_MISMATCH'],
    [{ text: JSON.stringify({ ...validCore, mediaResponsibilities: [] }) }, 'MEDIA_RESPONSIBILITIES_INVALID'],
  ])('classifies reverse response failures with stable reason %s', (response, reason) => {
    expect(() => parseReverseProviderResponse(response, fullRun)).toThrow(expect.objectContaining({
      code: 'PROVIDER_INVALID_RESPONSE',
      reason,
    }));
  });

  it('recovers a useful wrapped reverse result while pinning missing run identity', () => {
    expect(normalizeReverseProviderResult({
      result: {
        summary: '完整场景分析',
        keyword: '商业摄影, 暖色灯光',
        promptZh: '生成一张完整商品图',
        negativePrompt: '模糊, 变形',
        checklist: '检查主体比例；检查灯光',
        providerDebugField: 'must not cross the bridge',
      },
    }, run)).toMatchObject({
      sessionId: 'session-1',
      nonce: 'nonce-1',
      knowledgeSnapshotVersion: 'knowledge-v1',
      analysis: '完整场景分析',
      keywords: ['商业摄影', '暖色灯光'],
      positivePrompt: '生成一张完整商品图',
      negativeConstraints: ['模糊', '变形'],
      executionChecklist: ['检查主体比例', '检查灯光'],
    });
  });

  it('normalizes common scalar, object-list, and bilingual prompt drift without retaining extra fields', () => {
    expect(normalizeReverseProviderResult({
      data: {
        analysis: 'Nine-reference commercial layout.',
        keywords: [{ text: 'product' }, { label: 'studio' }],
        prompt: { zh: '中文商品摄影提示词', en: 'English product photography prompt' },
        negativeConstraints: 'blur; distortion',
        executionChecklist: [{ value: 'Check logo' }, { description: 'Check lighting' }],
        rawProviderTrace: 'must be dropped',
      },
    }, run)).toMatchObject({
      sessionId: 'session-1',
      nonce: 'nonce-1',
      knowledgeSnapshotVersion: 'knowledge-v1',
      analysis: 'Nine-reference commercial layout.',
      keywords: ['product', 'studio'],
      positivePrompt: '中文商品摄影提示词',
      negativeConstraints: ['blur', 'distortion'],
      executionChecklist: ['Check logo', 'Check lighting'],
    });
  });

  it('uses populated aliases when canonical list fields are empty', () => {
    expect(normalizeReverseProviderResult({
      ...validCore,
      keywords: [],
      keyword: 'studio lighting',
      negativeConstraints: [],
      negativePrompt: 'blur, distortion',
      executionChecklist: [],
      checklist: 'Check logo; Check lighting',
    }, run)).toMatchObject({
      keywords: ['studio lighting'],
      negativeConstraints: ['blur', 'distortion'],
      executionChecklist: ['Check logo', 'Check lighting'],
    });
  });

  it('marks critical empty professional collections invalid instead of complete', () => {
    const videoRun = {
      ...fullRun,
      orderedMedia: [
        ...fullRun.orderedMedia,
        {
          kind: 'video' as const,
          assetId: 'video-a',
          byteSize: 128,
          durationMs: 1000,
          extension: 'mp4' as const,
          height: 100,
          label: 'Video A',
          mediaType: 'video/mp4' as const,
          order: fullRun.orderedMedia.length,
          origin: 'imported' as const,
          sha256: 'b'.repeat(64),
          width: 100,
        },
      ],
    };
    expect(normalizeReverseProviderResult({
      ...validCore,
      materialsAndTextures: [],
      subjectScaleAndPlacement: [],
      videoTimeline: [],
      evidence: { observations: [], estimates: [], unknowns: [] },
    }, videoRun)).toMatchObject({
      completeness: {
        status: 'partial',
        invalidSections: [
          'materialsAndTextures',
          'subjectScaleAndPlacement',
          'videoTimeline',
          'evidence',
        ],
      },
    });
  });

  it('does not overwrite a mismatched provider identity', () => {
    expect(normalizeReverseProviderResult({
      sessionId: 'wrong-session',
      nonce: 'wrong-nonce',
      knowledgeSnapshotVersion: 'wrong-knowledge',
      analysis: 'analysis',
    }, run)).toMatchObject({
      sessionId: 'wrong-session',
      nonce: 'wrong-nonce',
      knowledgeSnapshotVersion: 'wrong-knowledge',
    });
  });

  it('keeps core content usable when professional sections are incomplete', () => {
    expect(normalizeReverseProviderResult({
      analysis: '完整场景分析',
      keywords: ['商业摄影'],
      positivePrompt: '生成一张完整商品图',
      negativeConstraints: ['模糊'],
      executionChecklist: ['检查主体比例'],
      camera: 'wide-angle',
      composition: { visualCenter: '主体居中' },
    }, run)).toMatchObject({
      sessionId: 'session-1',
      nonce: 'nonce-1',
      knowledgeSnapshotVersion: 'knowledge-v1',
      analysis: '完整场景分析',
      keywords: ['商业摄影'],
      positivePrompt: '生成一张完整商品图',
      negativeConstraints: ['模糊'],
      executionChecklist: ['检查主体比例'],
    });
  });
});
