import { describe, expect, it } from 'vitest';
import type { ReversePromptResult } from '@agent-canvas/domain';
import { buildReverseResultSections } from './reverse-result-sections';

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

  it('does not create empty Seedance headings for legacy results', () => {
    const sections = buildReverseResultSections(legacyResult);
    expect(sections.some((section) => section.id.startsWith('seedance-'))).toBe(false);
    expect(sections.every((section) => section.text.trim().length > 0)).toBe(true);
  });
});
