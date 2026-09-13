import { describe, expect, it } from 'vitest';
import type { ReversePromptResult } from '@agent-canvas/domain';
import { buildReverseResultSections, formatReverseResultDocument } from './reverse-result-sections';

const legacyResult: ReversePromptResult = {
  sessionId: 'session-1',
  nonce: 'nonce-1',
  knowledgeSnapshotVersion: 'knowledge-1',
  analysis: '产品位于画面中心。',
  keywords: ['产品', '暖光'],
  positivePrompt: '中心构图的商业产品摄影。',
  negativeConstraints: ['不要改变产品结构'],
  executionChecklist: ['检查 Logo 和比例'],
};

describe('buildReverseResultSections', () => {
  it('shows and copies camera, geometry, timeline and uncertainty without dropping detail', () => {
    const result: ReversePromptResult = { ...legacyResult,
      sceneDecomposition: { spatialStructure: '三层空间', spatialDepth: '前后距离估计 2 米', objects: [{ name: '杯体', role: '主角', placement: '居中', scaleAndProportion: '高宽比约 2:1', depthLayer: 'midground', occlusionAndZOrder: '位于台面之前' }] },
      camera: { estimatedFocalLength: '估计 85 mm，依据透视压缩', shotSize: '特写', positionAndAngle: '低机位', perspectiveAndVanishingPoints: '消失点在右上', distortion: '轻微', confidence: '低置信度' },
      videoTimeline: [{ timeRange: '0–3 秒', shotType: '特写', estimatedFocalLength: '85 mm 估计', cameraMovement: '推进', speedCurveAndStabilization: '缓入缓出', subjectAction: '三个零件依次向上分离', lightingAndSweep: '左侧扫光', effects: ['薄雾'], transition: '切镜', keyframes: ['0 秒闭合', '3 秒分离'], productAdaptation: '保持零件数量' }],
      uncertainties: ['真实焦距未知'],
    };
    const sections = buildReverseResultSections(result);
    expect(sections.map((section) => section.id)).toEqual(expect.arrayContaining(['scene-decomposition', 'camera', 'video-timeline', 'uncertainties']));
    const copied = formatReverseResultDocument(result);
    for (const detail of ['前后距离估计 2 米', '高宽比约 2:1', '消失点在右上', '三个零件依次向上分离', '3 秒分离', '真实焦距未知']) expect(copied).toContain(detail);
    expect(sections.find((section) => section.id === 'video-timeline')?.sendTarget).toBe('video_generation');
  });
  it('builds selectable image and Seedance prompt sections from a detailed result', () => {
    const result: ReversePromptResult = {
      ...legacyResult,
      mediaResponsibilities: [{
        sourceId: 'image-1',
        label: '@图片1',
        role: '锁定产品身份、结构和 Logo',
        priority: 'primary',
        inheritance: ['产品比例'],
        conflicts: ['原白底'],
        usableElements: ['产品轮廓和 Logo'],
      }],
      promptLogic: {
        subject: '唯一产品主体',
        action: '保持静止',
        environment: '暖色居家场景',
        cameraAndComposition: '45 度俯拍，中近景',
        lightingAndColor: '午后侧逆光',
        materialsAndTextures: '针织、玻璃与木纹',
        effectsOrFluids: '轻微热气',
        styleAndQuality: '高级电商摄影，细节清晰',
        rationale: ['主体到环境再到摄影参数'],
      },
      positivePromptZh: '中文生图提示词',
      positivePromptEn: 'English image prompt',
      seedance25: {
        taskType: 'video_edit',
        rationale: '存在唯一编辑母版。',
        assetBindings: [{ sourceId: '@视频1', target: '唯一编辑母版', adopt: ['镜头运动'], reject: ['原商品外观'] }],
        subjectContinuity: ['产品结构与 Logo 不变'],
        stages: [{ label: '阶段一', startState: '产品静止', mainEvent: '扫光经过产品', endState: '扫光离开且产品仍静止', carryForward: ['机位连续'] }],
        shots: [{ label: '镜头一', shotSize: '中近景', camera: '固定机位', movement: '缓慢推进', action: '产品保持静止', lightingAndEffects: '柔和扫光', transition: '无切镜', audio: '轻微环境声' }],
        audioPlan: ['保留环境声'],
        parameterLocks: ['跟随输入比例'],
        promptZh: '编辑@视频1并保持产品结构。',
        promptEn: 'Edit @video1 while preserving the product.',
        negativeConstraints: ['不要新增产品'],
        capabilityBoundaries: ['不承诺逐帧完全重合'],
      },
    };

    const sections = buildReverseResultSections(result);
    expect(sections.map((section) => section.id)).toEqual(expect.arrayContaining([
      'scene-responsibilities', 'prompt-logic', 'prompt-zh', 'prompt-en',
      'seedance-task', 'seedance-assets', 'seedance-stages', 'seedance-shots',
      'seedance-audio', 'seedance-prompt-zh', 'seedance-prompt-en',
    ]));
    expect(sections.find((section) => section.id === 'prompt-zh')).toMatchObject({ sendTarget: 'image_generation' });
    expect(sections.find((section) => section.id === 'seedance-prompt-zh')).toMatchObject({ sendTarget: 'video_generation' });
  });

  it('uses returned media mentions instead of response order for shuffled image and video responsibilities', () => {
    const responsibilities: NonNullable<ReversePromptResult['mediaResponsibilities']> = [
      { mention: '@图片2', sourceId: 'scene-image', label: '场景图', role: 'scene_composition', priority: 'secondary', inheritance: ['构图'], conflicts: [], usableElements: ['背景'] },
      { mention: '@视频1', sourceId: 'motion-video', label: '运镜参考', role: 'camera_motion', priority: 'supporting', inheritance: ['运镜'], conflicts: [], usableElements: ['推进节奏'] },
      { mention: '@图片1', sourceId: 'product-image', label: '产品图', role: 'subject_identity', priority: 'primary', inheritance: ['产品结构'], conflicts: [], usableElements: ['产品主体'] },
    ];

    const text = buildReverseResultSections({ ...legacyResult, mediaResponsibilities: responsibilities })
      .find((section) => section.id === 'scene-responsibilities')?.text;

    expect(text?.split('\n\n').map((block) => block.split('\n')[0])).toEqual([
      '@图片2 · 场景图（scene-image）',
      '@视频1 · 运镜参考（motion-video）',
      '@图片1 · 产品图（product-image）',
    ]);
  });

  it('does not create empty Seedance headings for legacy results', () => {
    const sections = buildReverseResultSections(legacyResult);
    expect(sections.some((section) => section.id.startsWith('seedance-'))).toBe(false);
    expect(sections.every((section) => section.text.trim().length > 0)).toBe(true);
  });
});
