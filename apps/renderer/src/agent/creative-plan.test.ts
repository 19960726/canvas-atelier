import { describe, expect, it } from 'vitest';
import { parseCreativePlan, creativePlanningInstructions } from './creative-plan';
import { defaultGenerationPreferences, generationProfiles, resolveGenerationPreference, readGenerationPreferences, writeGenerationPreferences } from './generation-preferences';
import type { ProviderBridgeProfile } from '@agent-canvas/desktop-core';

const profiles: ProviderBridgeProfile[] = [
  { provider: 'comfly', modelRoute: 'chat', displayName: 'Chat', capabilities: ['chat'] },
  { provider: 'comfly', modelRoute: 'image', displayName: 'Image', capabilities: ['image_generation'] },
  { provider: 'comfly', modelRoute: 'video', displayName: 'Video', modelId: 'veo3.1', capabilities: ['video_generation'], constraints: { video: { aspectRatios: ['16:9'], resolutions: ['720p'], outputCounts: [1], duration: { mode: 'options', options: [4, 8] } } } },
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
  it('limits image routes in planning instructions when references are present', () => {
    const text = creativePlanningInstructions(defaultGenerationPreferences(), [
      ...profiles,
      { provider: 'comfly', modelRoute: 'image-edit', displayName: 'Image edit', capabilities: ['image_generation', 'image_edit'] as ProviderBridgeProfile['capabilities'] },
    ], 1);
    expect(text).toContain('image-edit');
    expect(text).not.toContain('"route":"image"');
    expect(text).toContain('本次请求含有参考图');
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
  it('filters referenced video choices by the exact Comfly input mode', () => {
    const routes: ProviderBridgeProfile[] = [
      { provider: 'comfly', modelRoute: 'wan/t2v', modelId: 'wan2.2-t2v-plus', displayName: 'Wan text', capabilities: ['video_generation'] },
      { provider: 'comfly', modelRoute: 'wan/i2v', modelId: 'wan2.2-i2v-plus', displayName: 'Wan image', capabilities: ['video_generation'] },
      { provider: 'comfly', modelRoute: 'wan/kf2v', modelId: 'wanx2.1-kf2v-plus', displayName: 'Wan keyframe', capabilities: ['video_generation'] },
      { provider: 'comfly', modelRoute: 'veo/one', modelId: 'veo3-pro-frames', displayName: 'Veo one frame', capabilities: ['video_generation'] },
      { provider: 'comfly', modelRoute: 'veo/two', modelId: 'veo2-fast-frames', displayName: 'Veo two frames', capabilities: ['video_generation'] },
    ];
    expect(generationProfiles(routes, 'video', 1).map((profile) => profile.modelRoute)).toEqual(['wan/i2v', 'veo/one', 'veo/two']);
    expect(generationProfiles(routes, 'video', 2).map((profile) => profile.modelRoute)).toEqual(['wan/kf2v', 'veo/two']);
  });
  it('keeps Julun video profiles available for their supported text and single-image modes', () => {
    const julun: ProviderBridgeProfile = {
      provider: 'julun',
      modelRoute: 'julun-seedance-2-0-deal',
      modelId: 'seedance-2.0-deal',
      displayName: 'Seedance 2.0 Deal',
      capabilities: ['video_generation', 'async_tasks'],
      capabilityStatus: 'complete',
    };

    expect(generationProfiles([julun], 'video', 0)).toEqual([julun]);
    expect(generationProfiles([julun], 'video', 1)).toEqual([julun]);
    expect(generationProfiles([julun], 'video', 2)).toEqual([]);
  });
  it('blocks missing fixed model and unsupported parameters instead of silently changing either', () => {
    const prefs = defaultGenerationPreferences();
    prefs.video = { mode: 'fixed', modelRoute: 'gone', parameters: {} };
    expect(() => resolveGenerationPreference('video', prefs, profiles)).toThrow();
    prefs.video = { mode: 'fixed', modelRoute: 'video', parameters: { durationSeconds: 99 } };
    expect(() => resolveGenerationPreference('video', prefs, profiles)).toThrow();
  });
  it('recovers a fixed preference saved before the model directory loaded', () => {
    const prefs = defaultGenerationPreferences();
    prefs.image = { mode: 'fixed', parameters: { resolution: '4K' } };
    expect(resolveGenerationPreference('image', prefs, profiles, 'image')).toEqual({
      profile: profiles[1],
      parameters: {},
    });
  });
  it('chooses a reference-capable image route when the request includes reference images', () => {
    const imageOnly = profiles.find((profile) => profile.modelRoute === 'image')!;
    const imageEdit: ProviderBridgeProfile = { ...imageOnly, modelRoute: 'image-edit', capabilities: ['image_generation', 'image_edit'] };
    expect(resolveGenerationPreference('image', defaultGenerationPreferences(), [imageOnly, imageEdit], undefined, 1).profile.modelRoute)
      .toBe('image-edit');
    const fixedIncompatible = resolveGenerationPreference('image', { ...defaultGenerationPreferences(), image: { mode: 'fixed', modelRoute: 'image', parameters: {} } }, [imageOnly, imageEdit], undefined, 1);
    expect(fixedIncompatible.profile.modelRoute).toBe('image-edit');
    expect(fixedIncompatible.parameters).toEqual({});
  });
  it('reports a clear error when no image route can accept reference images', () => {
    expect(() => resolveGenerationPreference('image', defaultGenerationPreferences(), profiles, undefined, 1))
      .toThrow(/参考图需要支持图像编辑/u);
  });
  it('persists image and video preferences independently for each project', () => {
    const prefs = defaultGenerationPreferences();
    prefs.image = { mode: 'fixed', modelRoute: 'image', parameters: { imageQuality: 'high' } };
    prefs.video = { mode: 'fixed', modelRoute: 'video', parameters: { durationSeconds: 8 } };
    writeGenerationPreferences('prefs-a', prefs);
    expect(readGenerationPreferences('prefs-a')).toEqual(prefs);
    expect(readGenerationPreferences('prefs-b')).toEqual(defaultGenerationPreferences());
  });
});
