export interface SkillChatReferenceMention {
  readonly assetId: string;
  readonly label: string;
  readonly mention: string;
}

export function buildSkillChatSystemInstructions(input: {
  readonly agentMode?: 'chat' | 'original' | 'codex';
  readonly reasoningEffort?: 'low' | 'medium' | 'high';
  readonly visualAnalysis: boolean;
  readonly referenceMentions: readonly SkillChatReferenceMention[];
}): string {
  const base = input.agentMode === 'codex'
    ? [
      'Act as the planning brain for the current Canvas Atelier project.',
      'When the user requests a workflow, provide a concrete blueprint with 节点类型、连接顺序、每个节点的职责、关键配置和运行前检查。',
      '不能声称已经修改画布。The interface will ask for 用户确认 before applying any nodes, connections, or paid model jobs.',
      reasoningInstruction(input.reasoningEffort),
    ].join(' ')
    : input.agentMode === 'original'
      ? '你是视觉创作助手，负责提示词、构图、镜头、分镜、生图与视频方案。给出可复制的创作结果，但 Do not create or modify canvas nodes.'
      : '你是通用对话助手，负责讨论、分析、文案与问答。Answer with useful and copyable suggestions only. Do not create or modify canvas nodes.';
  if (!input.visualAnalysis) return base;
  const orderedReferences = input.referenceMentions
    .map((reference) => `${reference.mention}（${reference.label}）`)
    .join('、');
  return [
    base,
    '只描述图片中真实可见的主体、环境、材质、光线、镜头和景深；无法确认的内容必须标记为不确定，不能把猜测写成事实。',
    '按固定结构输出：',
    '1. 主体与模特：主体身份、数量、姿态、朝向、服装、表情、可见细节；无人像时明确写无模特。',
    '2. 场景结构：前景、中景、背景、主体位置、空间层次、遮挡关系，以及桌面、墙面、置物架等空间连接。',
    '3. 构图：视觉中心、留白、安全区、画面比例、水平线、引导线、主体占比和裁切方式。',
    '4. 空间感：机位高度、镜头压缩感、前后景距离、景深衰减、透视关系和纵深来源。',
    '5. 材质与纹理：逐项描述真实可见的表面材质、粗糙度、反射、透明度、织物或颗粒纹理，无法确认时标记不确定。',
    `6. 引用职责：逐一判断产品、构图、道具、服装、灯光、材质或其他可验证职责。引用顺序：${orderedReferences || '无'}。`,
    '7. 分别列出继承、替换、禁止照搬；禁止默认复制品牌、文字、水印、人物身份或受保护标识。',
    '8. 最后依次输出中文提示词、英文提示词、负面约束、执行清单。执行清单必须保持引用顺序。',
    '完成反推后，结果本身不要声称已经创建工作流；画布界面会另外询问用户是否基于本次反推生成工作流。',
  ].join('\n');
}

function reasoningInstruction(effort: 'low' | 'medium' | 'high' | undefined): string {
  if (effort === 'high') return '使用深度推理，明确依赖关系、失败边界和验证步骤，再给出结论。';
  if (effort === 'low') return '使用快速推理，优先给出最短可执行方案。';
  return '使用标准推理，说明关键取舍和验证步骤。';
}
