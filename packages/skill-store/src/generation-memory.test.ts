import { describe, expect, it } from 'vitest';
import {
  mergeGenerationMemoryEvents,
  parseGenerationMemoryEvent,
  renderGenerationMemoryMarkdown,
  type GenerationMemoryEvent,
} from './generation-memory';

const event: GenerationMemoryEvent = {
  schemaVersion: 1,
  id: 'memory-1',
  knowledgeBaseId: 'scene-skill',
  projectId: 'project-1',
  sourceDeviceId: 'device-a',
  createdAt: '2026-07-13T12:00:00.000Z',
  skill: { id: 'task-driven-image-prompt-workflow', version: '2026-07-13' },
  prompt: { userRequest: '生成石头产品海报', reversePrompt: '灰色岩石，产品居中', negativePrompt: '禁止修改 Logo' },
  references: ['product_identity', 'scene_composition'],
  model: { provider: 'comfly', modelId: 'image-model', parameters: { aspectRatio: '4:5', seed: 42 } },
  outcome: { assetIds: ['asset-result-1'], rating: 4, keep: ['产品身份'], change: ['光线'], never: ['修改 Logo'] },
  lesson: { category: '光线色调', rootCause: '主光方向不明确', preventionRule: '固定左前方柔光并控制高光', keywords: ['柔光', '左前主光'] },
  reviewStatus: 'pending_review',
};

describe('generation memory', () => {
  it('accepts a structured, reviewable memory event', () => {
    expect(parseGenerationMemoryEvent(event)).toEqual(event);
  });

  it('rejects secrets and raw image payloads from cross-device memory', () => {
    expect(() => parseGenerationMemoryEvent({ ...event, apiKey: 'secret' })).toThrow();
    expect(() => parseGenerationMemoryEvent({ ...event, rawImageBase64: 'AAAA' })).toThrow();
    expect(() => parseGenerationMemoryEvent({ ...event, model: { ...event.model, authorization: 'Bearer secret' } })).toThrow();
  });

  it('renders the growth loop into managed-copy markdown', () => {
    const markdown = renderGenerationMemoryMarkdown(event);
    expect(markdown).toContain('问题分类：光线色调');
    expect(markdown).toContain('原因复盘：主光方向不明确');
    expect(markdown).toContain('下次预防：固定左前方柔光并控制高光');
    expect(markdown).toContain('新关键词：柔光、左前主光');
    expect(markdown).toContain('来源设备：device-a');
  });

  it('deduplicates remote knowledge and quarantines same-id conflicts for review', () => {
    const duplicate = JSON.parse(JSON.stringify(event)) as GenerationMemoryEvent;
    const conflict = { ...event, lesson: { ...event.lesson, preventionRule: '改成右侧硬光' } };
    const remote = { ...event, id: 'memory-2', sourceDeviceId: 'device-b' };

    expect(mergeGenerationMemoryEvents([event], [duplicate, conflict, remote])).toMatchObject({
      accepted: [{ id: 'memory-2', sourceDeviceId: 'device-b', reviewStatus: 'pending_review' }],
      duplicateIds: ['memory-1'],
      conflictIds: ['memory-1'],
    });
  });
});
describe('generation memory markdown values', () => {
  it('renders actual dynamic memory values instead of frozen placeholders', () => {
    const markdown = renderGenerationMemoryMarkdown(event);
    expect(markdown).toContain('来源设备：device-a');
    expect(markdown).toContain('项目：project-1');
    expect(markdown).toContain('新关键词：柔光、左前主光');
    expect(markdown).toContain('KEEP：产品身份');
  });
});