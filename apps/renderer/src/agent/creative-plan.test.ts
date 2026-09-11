import { describe, expect, it } from 'vitest';
import { parseCreativePlan, recoverEmptyCreativePlan, creativePlanningInstructions, creativeWorkflowSteps, constrainCreativePlanKind } from './creative-plan';
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
  it('preserves model-authored workflow steps and supplies an understandable executable fallback', () => {
    const plan = parseCreativePlan(JSON.stringify({
      summary: '电商主图方案',
      options: [{
        id: 'a', title: '暖色厨房', kind: 'image', prompt: '红色产品置于厨房台面', reason: '突出使用场景',
        workflow: [
          { title: '锁定产品', detail: '使用参考图保持产品比例、Logo 和红色外观。' },
          { title: '生成场景', detail: '生成暖色厨房背景并保留顶部文案安全区。' },
          { title: '检查交付', detail: '核对产品轮廓和实际返图像素。' },
        ],
      }],
    }));
    expect(creativeWorkflowSteps(plan!.options[0]!, 1).map((step) => step.title)).toEqual(['锁定产品', '生成场景', '检查交付']);
    const incomplete = creativeWorkflowSteps({
      id: 'thin', title: '过于简略的方案', kind: 'image', prompt: '生成产品图', reason: '展示产品',
      workflow: [{ title: '生图', detail: '执行' }],
    }, 0);
    expect(incomplete.map((step) => step.title)).toEqual(['整理需求与素材', '执行图片生成', '回写并检查结果']);
    const fallback = creativeWorkflowSteps({ id: 'b', title: '短片', kind: 'video', prompt: '环绕产品', reason: '展示外观' }, 0);
    expect(fallback.map((step) => step.title)).toEqual(['整理需求与素材', '执行视频生成', '回写并检查结果']);
  });
  it('recovers an empty structured response into one exact executable reference-edit option', () => {
    const imageEdit: ProviderBridgeProfile = {
      provider: 'comfly', modelRoute: 'image-edit', displayName: 'Image edit', capabilities: ['image_generation', 'image_edit'],
    };
    const plan = recoverEmptyCreativePlan(
      '```json\n{"summary":"需要只精修产品","observations":["保留背景"],"unknowns":[],"options":[]}\n```',
      '把产品单独精修，其他不需要改变',
      defaultGenerationPreferences(),
      [imageEdit],
      1,
    );

    expect(plan).toMatchObject({
      summary: '需要只精修产品',
      options: [{
        title: '按当前要求精修',
        kind: 'image',
        prompt: '把产品单独精修，其他不需要改变',
        modelRoute: 'image-edit',
      }],
    });
  });

  it('keeps an empty structured plan visible when the selected workflow has no compatible route', () => {
    expect(recoverEmptyCreativePlan(
      JSON.stringify({ summary: '没有兼容的图片编辑路线', observations: ['需要保留原图'], options: [] }),
      '@图片1 精修产品，其他不要改变',
      defaultGenerationPreferences(),
      [{ provider: 'relayme', modelRoute: 'relayme-rena2', modelId: 'RENA2', displayName: 'RENA2', capabilities: ['image_generation'] }],
      1,
    )).toEqual({
      summary: '没有兼容的图片编辑路线',
      observations: ['需要保留原图'],
      estimates: [],
      unknowns: [],
      options: [],
    });
  });
  it('instructs planning and confirmation, with no fabricated thinking', () => {
    const text = creativePlanningInstructions(defaultGenerationPreferences(), profiles);
    expect(text).toContain('用户选择');
    expect(text).toContain('观察');
    expect(text).toContain('不输出隐藏思考');
    expect(text).toContain('video');
    expect(text).toContain('workflow');
    expect(text).toContain('本次已明确选择输出类型：image');
    expect(text).toContain('不得自动改成 video');
  });
  it('removes a model-authored video fallback when the user selected an image workflow', () => {
    const plan = parseCreativePlan(JSON.stringify({
      summary: '模型擅自改成视频',
      options: [{ id: 'video-fallback', title: '动态展示', kind: 'video', prompt: '生成动态展示', reason: '图片编辑路线不可用' }],
    }))!;

    expect(constrainCreativePlanKind(plan, 'image')).toMatchObject({
      selectedKind: 'image',
      rejectedCount: 1,
      plan: { options: [] },
    });
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
