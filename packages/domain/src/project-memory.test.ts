import { describe, expect, it } from 'vitest';
import {
  appendProjectMemoryEntry,
  buildProjectMemoryContext,
  createSkillPromotionCandidate,
  parseProjectMemoryEntry,
  type ProjectMemoryEntry,
} from './project-memory';

const optimization: ProjectMemoryEntry = {
  schemaVersion: 1,
  id: 'memory-optimization-1',
  projectId: 'project-1',
  projectRevision: 12,
  createdAt: '2026-07-13T13:00:00.000Z',
  kind: 'optimization',
  actor: 'agent',
  title: '调整产品主视觉构图',
  changeSummary: '产品放大并上移，压低背景道具对比度。',
  rationale: '提高首屏产品识别度并保留顶部文案安全区。',
  snapshots: { beforeId: 'snapshot-11', afterId: 'snapshot-12' },
  context: {
    modelId: 'vision-model',
    prompt: '高级商业产品主视觉',
    referenceAssetIds: ['product-ref', 'scene-ref'],
    resultAssetIds: ['result-12'],
  },
  feedback: {
    keep: ['产品包装比例'],
    change: ['背景亮度'],
    never: ['修改 Logo'],
    score: 4,
  },
  nextStep: '降低背景高光后再次生成。',
};

describe('project memory', () => {
  it('appends optimization memory without mutating the previous timeline', () => {
    const timeline: ProjectMemoryEntry[] = [];
    const next = appendProjectMemoryEntry(timeline, optimization);

    expect(timeline).toEqual([]);
    expect(next).toEqual([optimization]);
  });

  it('rejects duplicate ids and a revision that moves backwards', () => {
    expect(() => appendProjectMemoryEntry([optimization], optimization)).toThrow(/重复/);
    expect(() => appendProjectMemoryEntry([optimization], {
      ...optimization,
      id: 'memory-optimization-2',
      projectRevision: 11,
    })).toThrow(/版本/);
  });

  it('rejects secrets, private paths, and raw images from project memory', () => {
    expect(() => parseProjectMemoryEntry({ ...optimization, apiKey: 'secret' })).toThrow();
    expect(() => parseProjectMemoryEntry({
      ...optimization,
      context: { ...optimization.context, prompt: 'D:\\private\\asset.png' },
    })).toThrow(/私有路径/);
    expect(() => parseProjectMemoryEntry({
      ...optimization,
      context: { ...optimization.context, rawImageBase64: 'AAAA' },
    })).toThrow();
    expect(() => parseProjectMemoryEntry({
      ...optimization,
      context: { ...optimization.context, prompt: '素材位于D:\\private\\asset.png' },
    })).toThrow(/私有路径/);
    expect(() => parseProjectMemoryEntry({
      ...optimization,
      context: { ...optimization.context, prompt: 'Authorization: Bearer secret-token-value' },
    })).toThrow(/敏感凭据/);
    expect(() => parseProjectMemoryEntry({
      ...optimization,
      context: { ...optimization.context, prompt: 'provider key sk-project-secret1234' },
    })).toThrow(/敏感凭据/);
    expect(() => parseProjectMemoryEntry({
      ...optimization,
      context: { ...optimization.context, prompt: '素材位于C:/Users/name/key.txt' },
    })).toThrow(/私有路径/);
    expect(() => parseProjectMemoryEntry({
      ...optimization,
      context: { ...optimization.context, prompt: '%USERPROFILE%\\private\\key.txt' },
    })).toThrow(/私有路径/);
    expect(() => parseProjectMemoryEntry({
      ...optimization,
      context: { ...optimization.context, prompt: 'Authorization: Basic Zm9vOmJhcg==' },
    })).toThrow(/敏感凭据/);
    expect(() => parseProjectMemoryEntry({
      ...optimization,
      context: { ...optimization.context, prompt: 'token=ghp_1234567890abcdefghijklmnop' },
    })).toThrow(/敏感凭据/);
  });

  it('builds a bounded newest-first context for the Agent', () => {
    const second = {
      ...optimization,
      id: 'memory-optimization-2',
      projectRevision: 13,
      createdAt: '2026-07-13T14:00:00.000Z',
      title: '第二次优化',
    };

    expect(buildProjectMemoryContext([optimization, second], 1)).toEqual([second]);
  });

  it('excludes a superseded optimization from future Agent context', () => {
    const revertDecision: ProjectMemoryEntry = {
      ...optimization,
      id: 'memory-revert-1',
      projectRevision: 13,
      createdAt: '2026-07-13T14:00:00.000Z',
      kind: 'decision',
      actor: 'user',
      title: '撤销画布优化',
      changeSummary: '撤销已确认的 Agent 画布事务。',
      rationale: '用户执行撤销。',
      snapshots: { beforeId: 'snapshot-12', afterId: 'snapshot-13' },
      supersedesMemoryId: optimization.id,
      nextStep: '以撤销后的画布状态继续。',
    };

    expect(buildProjectMemoryContext([optimization, revertDecision])).toEqual([revertDecision]);
  });

  it('reactivates memory when a later restore supersedes the earlier restore decision', () => {
    const second = { ...optimization, id: 'memory-2', projectRevision: 13, createdAt: '2026-07-13T14:00:00.000Z', title: '第二次优化' };
    const firstRestore: ProjectMemoryEntry = {
      ...optimization,
      id: 'restore-1',
      projectRevision: 14,
      createdAt: '2026-07-13T15:00:00.000Z',
      kind: 'decision',
      actor: 'user',
      title: '恢复到第一次优化',
      supersedesMemoryIds: [second.id],
    };
    const secondRestore: ProjectMemoryEntry = {
      ...firstRestore,
      id: 'restore-2',
      projectRevision: 15,
      createdAt: '2026-07-13T16:00:00.000Z',
      title: '恢复到第二次优化',
      supersedesMemoryIds: [firstRestore.id],
    };

    expect(buildProjectMemoryContext([optimization, second, firstRestore, secondRestore]).map((entry) => entry.id)).toEqual([
      secondRestore.id,
      second.id,
      optimization.id,
    ]);
  });

  it('promotes project experience only as a pending Skill candidate', () => {
    expect(createSkillPromotionCandidate(optimization, {
      candidateId: 'skill-candidate-1',
      createdAt: '2026-07-13T15:00:00.000Z',
    })).toMatchObject({
      id: 'skill-candidate-1',
      sourceProjectMemoryId: optimization.id,
      reviewStatus: 'pending_review',
      rule: optimization.nextStep,
    });
  });
});