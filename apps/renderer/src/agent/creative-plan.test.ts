import { describe, expect, it } from 'vitest';
import { parseCreativePlan, creativePlanningInstructions } from './creative-plan';
import { defaultGenerationPreferences, resolveGenerationPreference, readGenerationPreferences, writeGenerationPreferences } from './generation-preferences';
import type { ProviderBridgeProfile } from '@agent-canvas/desktop-core';

const profiles: ProviderBridgeProfile[] = [
  { provider: 'comfly', modelRoute: 'chat', displayName: 'Chat', capabilities: ['chat'] },
  { provider: 'comfly', modelRoute: 'image', displayName: 'Image', capabilities: ['image_generation'] },
  { provider: 'comfly', modelRoute: 'video', displayName: 'Video', capabilities: ['video_generation'], constraints: { video: { aspectRatios: ['16:9'], resolutions: ['720p'], outputCounts: [1], duration: { mode: 'options', options: [4, 8] } } } },
];
describe('creative plan boundary', () => {
  it('accepts only model-provided executable choices, preserving evidence labels', () => {
    const plan = parseCreativePlan(JSON.stringify({ summary: '产品短片方案', observations: ['主体居中'], estimates: ['约50mm'], unknowns: ['内部结构不可见'], options: [{ id: 'a', title: '缓慢环绕', kind: 'video', prompt: '镜头缓慢环绕产品', reason: '保持产品轮廓' }] }));
    expect(plan?.options[0]?.kind).toBe('video');
    expect(plan?.estimates).toEqual(['约50mm']);
    expect(parseCreativePlan('帮我生成一张图')).toBeNull();
    expect(parseCreativePlan('{"summary":"猜测","options":[{"kind":"shell","prompt":"run"}]}')).toBeNull();
  });
  it('rejects duplicate choices and empty prompts instead of inventing variants', () => {
    const option = { id: 'a', title: 'A', kind: 'image', prompt: '产品居中', reason: '展示主体' };
    expect(parseCreativePlan(JSON.stringify({ summary: 'test', options: [option, option] }))).toBeNull();
    expect(parseCreativePlan(JSON.stringify({ summary: 'test', options: [{ ...option, prompt: '' }] }))).toBeNull();
  });
  it('instructs planning and confirmation, with no fabricated thinking', () => {
    const text = creativePlanningInstructions(defaultGenerationPreferences(), profiles);
    expect(text).toContain('用户选择');
    expect(text).toContain('观察');
    expect(text).toContain('不输出隐藏思考');
    expect(text).toContain('video');
  });
  it('bounds the model catalog while retaining the fixed choice', () => {
    const catalog: ProviderBridgeProfile[] = Array.from({ length: 120 }, (_, i) => ({ provider: 'comfly', modelRoute: `image-${i}`, displayName: 'Model '.repeat(30), capabilities: ['image_generation'] }));
    const prefs = defaultGenerationPreferences();
    prefs.image = { mode: 'fixed', modelRoute: 'image-119', parameters: {} };
    const instructions = creativePlanningInstructions(prefs, catalog);
    expect(instructions.length).toBeLessThan(9000);
    expect(instructions).toContain('image-119');
  });
});
describe('separate generation preferences', () => {
  it('resolves video auto choice by capability and never picks the chat route', () => {
    expect(resolveGenerationPreference('video', defaultGenerationPreferences(), profiles, 'chat').profile.modelRoute).toBe('video');
  });
  it('blocks missing fixed model and unsupported parameters instead of silently changing either', () => {
    const prefs = defaultGenerationPreferences();
    prefs.video = { mode: 'fixed', modelRoute: 'gone', parameters: {} };
    expect(() => resolveGenerationPreference('video', prefs, profiles)).toThrow();
    prefs.video = { mode: 'fixed', modelRoute: 'video', parameters: { durationSeconds: 99 } };
    expect(() => resolveGenerationPreference('video', prefs, profiles)).toThrow();
  });
  it('persists image and video preferences independently for each project', () => {
    const prefs = defaultGenerationPreferences();
    prefs.video = { mode: 'fixed', modelRoute: 'video', parameters: { durationSeconds: 8 } };
    writeGenerationPreferences('prefs-a', prefs);
    expect(readGenerationPreferences('prefs-a')).toEqual(prefs);
    expect(readGenerationPreferences('prefs-b')).toEqual(defaultGenerationPreferences());
  });
});
