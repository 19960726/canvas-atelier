import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REVERSE_PROMPT_PERSONA,
  createReversePromptRun,
  parseReversePromptResult,
  reversePromptPersonaSchema,
} from './reverse-prompt-agent';

const snapshot = {
  version: 'approved-2026-07-13-2',
  approvedAt: '2026-07-13T12:00:00.000Z',
  approvedMemoryIds: ['memory-1', 'memory-2'],
};

const referenceAssetIds = ['asset-product', 'asset-scene'];

function deps(ids: string[], nonces: string[]) {
  return {
    createId: () => ids.shift()!,
    createNonce: () => nonces.shift()!,
    now: () => '2026-07-13T12:01:00.000Z',
  };
}

describe('reverse prompt personas', () => {
  it('uses the approved senior commercial visual persona by default', () => {
    expect(DEFAULT_REVERSE_PROMPT_PERSONA.label).toBe('高级商业视觉设计师 + 产品摄影指导 + 提示词工程师');
    expect(reversePromptPersonaSchema.parse(DEFAULT_REVERSE_PROMPT_PERSONA)).toEqual(DEFAULT_REVERSE_PROMPT_PERSONA);
  });

  it.each(['ecommerce_key_visual', 'brand_poster', 'composition_director', 'material_lighting_director'])('supports specialist persona %s', (id) => {
    expect(() => reversePromptPersonaSchema.parse({ id, label: '专业角色' })).not.toThrow();
  });
});

describe('reverse prompt runs', () => {
  it('captures the newest approved memory snapshot and current references', () => {
    const run = createReversePromptRun({
      projectId: 'project-1',
      skill: { id: 'scene-skill', version: 'v2' },
      approvedMemorySnapshot: snapshot,
      projectMemoryIds: ['project-memory-1'],
      referenceAssetIds,
    }, deps(['session-1'], ['nonce-1']));

    expect(run).toMatchObject({
      sessionId: 'session-1',
      nonce: 'nonce-1',
      persona: DEFAULT_REVERSE_PROMPT_PERSONA,
      approvedMemorySnapshot: snapshot,
      projectMemoryIds: ['project-memory-1'],
      referenceAssetIds,
    });
  });

  it('creates a fresh session and nonce every time even when references are unchanged', () => {
    const identity = deps(['session-1', 'session-2'], ['nonce-1', 'nonce-2']);
    const input = {
      projectId: 'project-1',
      skill: { id: 'scene-skill', version: 'v2' },
      approvedMemorySnapshot: snapshot,
      projectMemoryIds: ['project-memory-1'],
      referenceAssetIds,
    };
    const first = createReversePromptRun(input, identity);
    const second = createReversePromptRun({ ...input, approvedMemorySnapshot: { ...snapshot, version: 'approved-2026-07-13-3' } }, identity);
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(second.nonce).not.toBe(first.nonce);
    expect(second.approvedMemorySnapshot.version).toBe('approved-2026-07-13-3');
  });

  it('rejects more than 20 references', () => {
    expect(() => createReversePromptRun({
      projectId: 'project-1',
      skill: { id: 'scene-skill', version: 'v2' },
      approvedMemorySnapshot: snapshot,
      referenceAssetIds: Array.from({ length: 21 }, (_, index) => `asset-${index}`),
    })).toThrow(/参考图最多 20 张/);
  });

  it('requires structured output to match the current run identity', () => {
    const run = createReversePromptRun({
      projectId: 'project-1',
      skill: { id: 'scene-skill', version: 'v2' },
      approvedMemorySnapshot: snapshot,
      projectMemoryIds: ['project-memory-1'],
      referenceAssetIds,
    }, deps(['session-1'], ['nonce-1']));
    const result = {
      sessionId: run.sessionId,
      nonce: run.nonce,
      knowledgeSnapshotVersion: snapshot.version,
      analysis: '产品身份明确，构图需要增强层次。',
      keywords: ['高端商业视觉', '左前主光'],
      positivePrompt: '高端产品主视觉，产品居中，左前主光。',
      negativeConstraints: ['禁止修改 Logo', '禁止产品变形'],
      executionChecklist: ['核对产品身份', '核对安全区'],
    };
    expect(parseReversePromptResult(result, run)).toEqual(result);
    expect(() => parseReversePromptResult({ ...result, nonce: 'stale-nonce' }, run)).toThrow(/运行身份不匹配/);
  });
});