import { describe, expect, it } from 'vitest';
import { buildSkillChatSystemInstructions } from './skill-chat-visual-analysis.js';

describe('buildSkillChatSystemInstructions', () => {
  it('builds the full visible-image analysis contract with ordered mention responsibilities', () => {
    const instructions = buildSkillChatSystemInstructions({
      visualAnalysis: true,
      referenceMentions: [
        { assetId: 'a'.repeat(16), label: '产品参考', mention: '@图片1' },
        { assetId: 'b'.repeat(16), label: '场景参考', mention: '@图片2' },
      ],
    });

    expect(instructions).toContain('只描述图片中真实可见');
    expect(instructions).toContain('前景、中景、背景');
    expect(instructions).toContain('视觉中心、留白、安全区');
    expect(instructions).toContain('机位高度、镜头压缩感');
    expect(instructions).toContain('产品、构图、道具、服装、灯光、材质');
    expect(instructions).toContain('继承、替换、禁止照搬');
    expect(instructions).toContain('中文提示词、英文提示词、负面约束、执行清单');
    expect(instructions).toContain('@图片1（产品参考）');
    expect(instructions).toContain('@图片2（场景参考）');
  });

  it('keeps ordinary text chat concise when visual analysis is disabled', () => {
    const instructions = buildSkillChatSystemInstructions({ visualAnalysis: false, referenceMentions: [] });

    expect(instructions).toContain('Do not create or modify canvas nodes');
    expect(instructions).not.toContain('前景、中景、背景');
  });

  it('gives original mode a visual-creation role even before references are attached', () => {
    const instructions = buildSkillChatSystemInstructions({
      agentMode: 'original',
      visualAnalysis: false,
      referenceMentions: [],
    });

    expect(instructions).toContain('视觉创作');
    expect(instructions).toContain('提示词');
    expect(instructions).toContain('分镜');
    expect(instructions).toContain('Do not create or modify canvas nodes');
  });

  it('asks Codex for a concrete canvas workflow blueprint without bypassing confirmation', () => {
    const instructions = buildSkillChatSystemInstructions({
      agentMode: 'codex',
      visualAnalysis: false,
      referenceMentions: [],
    });

    expect(instructions).toContain('节点类型、连接顺序');
    expect(instructions).toContain('不能声称已经修改画布');
    expect(instructions).toContain('用户确认');
  });

  it('turns Codex reasoning effort into a real response-depth instruction', () => {
    const instructions = buildSkillChatSystemInstructions({
      agentMode: 'codex',
      reasoningEffort: 'high',
      visualAnalysis: false,
      referenceMentions: [],
    });

    expect(instructions).toContain('深度推理');
    expect(instructions).toContain('依赖关系、失败边界和验证步骤');
  });
});
