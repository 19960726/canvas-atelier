import type { ReversePromptResult } from '@agent-canvas/domain';

export interface ReverseResultSection {
  readonly id: string;
  readonly title: string;
  readonly text: string;
  readonly kind: 'analysis' | 'prompt' | 'constraint' | 'checklist';
  readonly sendTarget: 'image_generation' | 'video_generation' | 'either' | 'none';
}

export function buildReverseResultSections(result: ReversePromptResult): ReverseResultSection[] {
  const sections: ReverseResultSection[] = [];
  addSection(sections, 'analysis', '综合分析', result.analysis, 'analysis', 'none');
  addSection(sections, 'keywords', '关键词', result.keywords.join('、'), 'analysis', 'either');

  if (result.mediaResponsibilities?.length) {
    addSection(
      sections,
      'scene-responsibilities',
      '素材职责与取舍',
      result.mediaResponsibilities.map((item, index) => [
        `${index + 1}. ${item.label ?? item.sourceId}（${item.sourceId}）`,
        `职责：${item.role}`,
        `优先级：${item.priority}`,
        `可用元素：${item.usableElements.join('；')}`,
        `继承：${item.inheritance.length > 0 ? item.inheritance.join('；') : '无'}`,
        `冲突：${item.conflicts.length > 0 ? item.conflicts.join('；') : '无'}`,
      ].join('\n')).join('\n\n'),
      'analysis',
      'none',
    );
  }

  if (result.promptLogic) {
    const logic = result.promptLogic;
    addSection(sections, 'prompt-logic', '生图提示词逻辑', [
      `主体：${logic.subject}`,
      `动作：${logic.action}`,
      `环境：${logic.environment}`,
      `相机与构图：${logic.cameraAndComposition}`,
      `灯光与色彩：${logic.lightingAndColor}`,
      `材质与纹理：${logic.materialsAndTextures}`,
      `特效或流体：${logic.effectsOrFluids}`,
      `风格与质量：${logic.styleAndQuality}`,
      `逻辑说明：${logic.rationale.join('；')}`,
    ].join('\n'), 'analysis', 'image_generation');
  }

  addSection(sections, 'prompt-zh', '中文生图提示词', result.positivePromptZh ?? result.positivePrompt, 'prompt', 'image_generation');
  addSection(sections, 'prompt-en', 'English Image Prompt', result.positivePromptEn, 'prompt', 'image_generation');
  addSection(sections, 'negative-constraints', '负向约束', result.negativeConstraints.join('\n'), 'constraint', 'either');
  addSection(sections, 'execution-checklist', '执行检查', result.executionChecklist.join('\n'), 'checklist', 'none');

  const seedance = result.seedance25;
  if (seedance) {
    addSection(sections, 'seedance-task', 'Seedance 2.5 任务判断', `任务类型：${seedance.taskType}\n判断依据：${seedance.rationale}`, 'analysis', 'video_generation');
    addSection(sections, 'seedance-assets', 'Seedance 素材职责', seedance.assetBindings.map((binding, index) => [
      `${index + 1}. ${binding.sourceId} → ${binding.target}`,
      `采用：${binding.adopt.join('；')}`,
      `拒绝：${binding.reject.length > 0 ? binding.reject.join('；') : '无'}`,
    ].join('\n')).join('\n\n'), 'analysis', 'video_generation');
    addSection(sections, 'seedance-continuity', '主体连续性', seedance.subjectContinuity.join('\n'), 'constraint', 'video_generation');
    addSection(sections, 'seedance-stages', '阶段与结束状态', seedance.stages.map((stage, index) => [
      `${index + 1}. ${stage.label}`,
      `开始状态：${stage.startState}`,
      `主要事件：${stage.mainEvent}`,
      `结束状态：${stage.endState}`,
      `延续条件：${stage.carryForward.join('；')}`,
    ].join('\n')).join('\n\n'), 'analysis', 'video_generation');
    addSection(sections, 'seedance-shots', '镜头拆解', seedance.shots.map((shot, index) => [
      `${index + 1}. ${shot.label}｜${shot.shotSize}`,
      `机位：${shot.camera}`,
      `运镜：${shot.movement}`,
      `动作：${shot.action}`,
      `灯光与特效：${shot.lightingAndEffects}`,
      `转场：${shot.transition}`,
      `声音：${shot.audio}`,
    ].join('\n')).join('\n\n'), 'analysis', 'video_generation');
    addSection(sections, 'seedance-audio', '声音与参数锁定', [
      `声音：${seedance.audioPlan.join('；')}`,
      `参数：${seedance.parameterLocks.join('；')}`,
    ].join('\n'), 'checklist', 'video_generation');
    addSection(sections, 'seedance-prompt-zh', 'Seedance 中文提示词', seedance.promptZh, 'prompt', 'video_generation');
    addSection(sections, 'seedance-prompt-en', 'Seedance English Prompt', seedance.promptEn, 'prompt', 'video_generation');
    addSection(sections, 'seedance-negative', 'Seedance 负向约束', seedance.negativeConstraints.join('\n'), 'constraint', 'video_generation');
    addSection(sections, 'seedance-boundaries', '能力边界', seedance.capabilityBoundaries.join('\n'), 'constraint', 'video_generation');
  }

  return sections;
}

function addSection(
  sections: ReverseResultSection[],
  id: string,
  title: string,
  text: string | undefined,
  kind: ReverseResultSection['kind'],
  sendTarget: ReverseResultSection['sendTarget'],
): void {
  if (text?.trim()) sections.push({ id, title, text: text.trim(), kind, sendTarget });
}
