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
  it('joins every Gemini text part before parsing the JSON document', () => {
    expect(extractGeminiReverseText([
      { text: '{"analysis":"完整' },
      { inlineData: { mimeType: 'image/png', data: 'ignored' } },
      { text: '分析"}' },
    ])).toBe('{"analysis":"完整分析"}');
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
    }, run)).toEqual({
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
    }, run)).toEqual({
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

  it('drops malformed optional professional sections while preserving the required core result', () => {
    expect(normalizeReverseProviderResult({
      analysis: '完整场景分析',
      keywords: ['商业摄影'],
      positivePrompt: '生成一张完整商品图',
      negativeConstraints: ['模糊'],
      executionChecklist: ['检查主体比例'],
      camera: 'wide-angle',
      composition: { visualCenter: '主体居中' },
    }, run)).toEqual({
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
