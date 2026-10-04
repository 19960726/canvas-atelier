import { describe, expect, it } from 'vitest';
import { assessCreativeGenerationPrompt, buildCreativeExecutionPrompt, resolveCreativeGenerationReferences, parseCreativePlan, recoverEmptyCreativePlan, creativePlanningInstructions, creativeWorkflowSteps, constrainCreativePlanKind } from './creative-plan';

it('maps an original high reference number to its actual selected generation input', () => {
  const option = { id: 'faithful', title: '保留', reason: '保留原图', kind: 'image' as const,
    prompt: '保留主体比例和原机位，窗光照明，高清金属材质。', referenceMentions: ['@图片8', '@图片3'] };
  const requirements = { goal: '保留', mustKeep: ['@图片8 产品轮廓'], mustChange: [], mustAvoid: [], acceptanceCriteria: [] };
  const refs = [{ assetId: 'product', mention: '@图片8' }, { assetId: 'light', mention: '@图片3' }];
  const execution = buildCreativeExecutionPrompt(option, requirements, [], refs);
  expect(execution).toContain('第1张输入：参考图片8');
  expect(execution).toContain('第2张输入：参考图片3');
  expect(execution).not.toContain('@图片');
});
import { defaultGenerationPreferences, generationProfiles, resolveGenerationPreference, readGenerationPreferences, writeGenerationPreferences } from './generation-preferences';
import type { ProviderBridgeProfile } from '@agent-canvas/desktop-core';

const profiles: ProviderBridgeProfile[] = [
  { provider: 'comfly', modelRoute: 'chat', displayName: 'Chat', capabilities: ['chat'] },
  { provider: 'comfly', modelRoute: 'image', displayName: 'Image', capabilities: ['image_generation'] },
  { provider: 'comfly', modelRoute: 'video', displayName: 'Video', modelId: 'veo3.1', capabilities: ['video_generation'], constraints: { video: { aspectRatios: ['16:9'], resolutions: ['720p'], outputCounts: [1], duration: { mode: 'options', options: [4, 8] } } } },
];
describe('creative plan boundary', () => {
  it('binds each option to its actual product and lighting inputs while keeping a negative example out of generation', () => {
    const plan = parseCreativePlan(JSON.stringify({ summary: '多素材编辑', referenceDuties: [
      { mention: '@图片8', role: 'product', inherit: ['外观比例'], doNotCopy: [] },
      { mention: '@图片3', role: 'lighting', inherit: ['窗光方向'], doNotCopy: ['人物'] },
      { mention: '@图片2', role: 'negative', inherit: [], doNotCopy: ['红色'] },
    ], options: [{ id: 'a', title: '原位编辑', kind: 'image', reason: '保留产品', prompt: '产品原位构图，原背景自然窗光，真实材质与清晰轮廓。', referenceMentions: ['@图片8', '@图片3'] }] }))!;
    const references = [
      { assetId: 'product', mention: '@图片8', label: '产品' },
      { assetId: 'light', mention: '@图片3', label: '光线' },
      { assetId: 'negative', mention: '@图片2', label: '负例' },
    ];
    expect(resolveCreativeGenerationReferences(plan.options[0]!, references, plan.referenceDuties).map((reference) => reference.assetId))
      .toEqual(['product', 'light']);
    expect(plan.referenceDuties[1]).toMatchObject({ mention: '@图片3', role: 'lighting', doNotCopy: ['人物'] });
    expect(resolveCreativeGenerationReferences({ ...plan.options[0]!, referenceMentions: ['@图片2'] }, references, plan.referenceDuties))
      .toEqual([]);
  });

  it('blocks unknown option references rather than swapping in another image', () => {
    const option = { id: 'a', title: '方案', kind: 'image' as const, reason: '编辑', prompt: '产品原位构图，原背景自然窗光与真实材质。', referenceMentions: ['@图片9'] };
    expect(() => resolveCreativeGenerationReferences(option, [{ assetId: 'product', label: '产品', mention: '@图片8' }], []))
      .toThrow(/参考素材/u);
  });

  it('keeps every supplied hard requirement in a complex plan instead of dropping the last items', () => {
    const mustKeep = Array.from({ length: 14 }, (_, index) => `对象${index + 1}的原位置与比例`);
    const plan = parseCreativePlan(JSON.stringify({
      summary: '复杂场景局部编辑', requirements: { goal: '只改桌面材质', mustKeep },
      options: [{ id: 'a', title: '原位编辑', kind: 'image', reason: '保留主体与构图', prompt: '产品原位构图，柔和侧光突出金属材质；只把桌面换成浅色石材，保留人物姿态和全部产品比例。' }],
    }));
    expect(plan?.requirements.mustKeep).toEqual(mustKeep);
  });

  it('collapses differently named choices with the same execution prompt while retaining a real alternative', () => {
    const prompt = '产品原位构图，柔和侧光突出金属材质，保持人物与产品比例，厨房背景。';
    const option = { id: 'a', title: '方案一', kind: 'image', reason: '原位编辑', prompt };
    const plan = parseCreativePlan(JSON.stringify({ summary: '提供选择', options: [
      option, { ...option, id: 'b', title: '方案二', prompt: ` ${prompt}\n` },
      { ...option, id: 'c', title: '冷色场景', prompt: '产品原位构图，冷色窗光照亮金属材质，保持人物与产品比例，蓝灰色厨房背景。' },
    ] }));
    expect(plan?.options.map((item) => item.id)).toEqual(['a', 'c']);
  });

  it('carries the chosen plan hard constraints into the actual generation prompt', () => {
    const plan = parseCreativePlan(JSON.stringify({
      summary: '早餐场景编辑', requirements: {
        goal: '按要求编辑家庭早餐图', mustKeep: ['保持原图机位与透视', '@图片1的产品位置和比例不变'],
        mustChange: ['桌上恰好六个烧麦', '左侧女孩站立，右侧女模特坐下'],
        mustAvoid: ['画面不得出现红色'], acceptanceCriteria: ['六个烧麦全部可数，产品轮廓完整'],
      },
      options: [{ id: 'a', title: '原场景编辑', kind: 'image', reason: '保持机位', prompt: '家庭早餐产品摄影，原位构图、自然窗光与真实金属材质，厨房环境，高清细节。' }],
    }))!;
    const execution = buildCreativeExecutionPrompt(plan.options[0]!, plan.requirements);
    expect(execution).toContain(plan.options[0]!.prompt);
    for (const requirement of [...plan.requirements.mustKeep, ...plan.requirements.mustChange,
      ...plan.requirements.mustAvoid, ...plan.requirements.acceptanceCriteria]) {
      expect(execution).toContain(requirement.replace(/@图片(\d+)/gu, '参考图片$1'));
    }
    expect(execution).not.toMatch(/@(?:图片|视频)\d+/u);
  });

  it('reads a complete executable plan inside prose and a JSON fence', () => {
    const option = { id: 'a', title: '参考图编辑', kind: 'image', reason: '保留主体', prompt: '产品居中构图，柔和侧光突出金属材质，保持品牌标识，纯净暖灰背景。' };
    expect(parseCreativePlan(`以下是可选方案：\n\n\`\`\`json\n${JSON.stringify({ summary: '按参考图制作', options: [option] })}\n\`\`\`\n请选择一个方案。`)?.options).toEqual([option]);
  });

  it('keeps analysis readable when the provider omits executable options', () => {
    expect(recoverEmptyCreativePlan('```json\n{"summary":"早餐场景分析","requirements":{"goal":"根据参考图改造早餐场景"}}\n```', '制作早餐图片', defaultGenerationPreferences(), profiles))
      .toMatchObject({ summary: '早餐场景分析', options: [] });
  });
  it('rejects copied or underspecified generation prompts while allowing an executable rewrite', () => {
    expect(assessCreativeGenerationPrompt('根据你的要求，生成一张产品主图，请执行。', '生成一张产品主图'))
      .toEqual({ valid: false, reason: 'copied' });
    expect(assessCreativeGenerationPrompt('产品图', '为新品制作一张高级电商主图'))
      .toEqual({ valid: false, reason: 'underspecified' });
    expect(assessCreativeGenerationPrompt(
      '红色产品居中构图，严格保持外观比例与品牌标识，柔和侧光突出材质，纯净暖灰背景，高清商业摄影。',
      '生成一张产品主图',
    )).toEqual({ valid: true });
  });

  it('rejects reference mention tokens and long generic praise without visual execution dimensions', () => {
    expect(assessCreativeGenerationPrompt(
      '@图片1 红色产品居中构图，柔和侧光突出金属材质，暖灰背景，保持品牌标识不变。',
      '参考图片精修产品',
    )).toEqual({ valid: false, reason: 'contains-mention' });
    expect(assessCreativeGenerationPrompt(
      '把整个画面做得更加高级好看专业精致清晰，整体效果自然舒服并且更有品质感。',
      '优化产品图',
    )).toEqual({ valid: false, reason: 'underspecified' });
    expect(assessCreativeGenerationPrompt(
      '把产品效果做得更加高级好看专业精致清晰，采用优秀构图和光鲜特色，整体自然舒服有品质感。',
      '优化产品图',
    )).toEqual({ valid: false, reason: 'underspecified' });
  });

  it('accepts only model-provided executable choices, preserving evidence labels', () => {
    const plan = parseCreativePlan(JSON.stringify({
      summary: '产品短片方案',
      requirements: {
        goal: '生成突出产品外观的短片',
        mustKeep: ['产品轮廓与 Logo'],
        mustChange: ['增加缓慢环绕镜头'],
        mustAvoid: ['不要改动产品颜色'],
        acceptanceCriteria: ['主体全程完整可见'],
      },
      observations: ['主体居中'], estimates: ['约50mm'], unknowns: ['内部结构不可见'],
      options: [{ id: 'a', title: '缓慢环绕', kind: 'video', prompt: '镜头缓慢环绕产品', reason: '保持产品轮廓' }],
    }));
    expect(plan?.options[0]?.kind).toBe('video');
    expect(plan?.estimates).toEqual(['约50mm']);
    expect(plan?.requirements).toEqual({
      goal: '生成突出产品外观的短片',
      mustKeep: ['产品轮廓与 Logo'],
      mustChange: ['增加缓慢环绕镜头'],
      mustAvoid: ['不要改动产品颜色'],
      acceptanceCriteria: ['主体全程完整可见'],
    });
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
  it('preserves analysis but never invents an executable option when the model returns none', () => {
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
      requirements: {
        goal: '把产品单独精修，其他不需要改变',
        mustKeep: ['其他不需要改变'],
        mustChange: ['把产品单独精修'],
      },
      options: [],
    });
    expect(plan?.options).toHaveLength(0);
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
      referenceDuties: [],
      requirements: {
        goal: '精修产品，其他不要改变',
        mustKeep: ['其他不要改变'],
        mustChange: ['精修产品'],
        mustAvoid: [],
        acceptanceCriteria: [
          '最终交付为图片，不得改成其他输出类型。',
          '按发送顺序使用 1 个参考素材，并逐项核对需要保留和允许修改的内容。',
          '使用已确认的模型与参数执行，完成后检查返图、实际像素和清晰度。',
        ],
      },
      observations: ['需要保留原图'],
      estimates: [],
      unknowns: [],
      options: [],
    });
  });
  it('instructs planning and confirmation, with no fabricated thinking', () => {
    const text = creativePlanningInstructions(defaultGenerationPreferences(), profiles, 0, 'deep');
    expect(text).toContain('用户选择');
    expect(text).toContain('观察');
    expect(text).toContain('不输出隐藏思考');
    expect(text).toContain('video');
    expect(text).toContain('workflow');
    expect(text).toContain('本次已明确选择输出类型：image');
    expect(text).toContain('不得自动改成 video');
    expect(text).toContain('需求分析强度：deep（深度分析）');
    expect(text).toContain('mustKeep');
    expect(text).toContain('mustChange');
    expect(text).toContain('mustAvoid');
    expect(text).toContain('acceptanceCriteria');
    expect(text).toContain('每条要求必须落实到完整提示词或 workflow');
    expect(text).toContain('不能原样复制用户请求');
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
