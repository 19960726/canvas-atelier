export interface SkillChatReferenceMention {
  readonly assetId: string;
  readonly label: string;
  readonly mention: string;
}

export function buildSkillChatSystemInstructions(input: {
  readonly agentMode?: 'chat' | 'original' | 'codex';
  readonly purpose?: 'image_layering_analysis' | 'reverse_workflow';
  readonly reasoningEffort?: 'low' | 'medium' | 'high';
  readonly reverseAnalysisDepth?: 'fast' | 'standard' | 'deep';
  readonly visualAnalysis: boolean;
  readonly referenceMentions: readonly SkillChatReferenceMention[];
}): string {
  const role = input.agentMode === 'codex'
    ? [
      'Act as the planning brain for the current Canvas Atelier project.',
      'When the user requests a workflow, provide a concrete blueprint with 节点类型、连接顺序、每个节点的职责、关键配置和运行前检查。',
      '不能声称已经修改画布。The interface will ask for 用户确认 before applying any nodes, connections, or paid model jobs.',
    ].join(' ')
    : input.agentMode === 'original'
      ? '你是视觉创作助手，负责提示词、构图、镜头、分镜、生图与视频方案。给出可复制的创作结果，但 Do not create or modify canvas nodes.'
      : '你是通用对话助手，负责讨论、分析、文案与问答。Answer with useful and copyable suggestions only. Do not create or modify canvas nodes.';
  const base = [role, reasoningInstruction(input.reasoningEffort)].join(' ');
  if (input.purpose === 'image_layering_analysis') return [
    base,
    '本次任务仅分析原图的可见对象并提供图片分层建议。遵守用户消息中的层计划 JSON 合同，只返回一个 JSON 对象，不要 Markdown 围栏、额外文字或创作 options。',
    'layers 包含一个底部 background 和独立 transparent 图层；每个透明层提供原图相对坐标 sourceBounds，按可见位置、尺寸和遮挡关系拆分对象与对应阴影。',
    '必须同时返回 elements 清单；每个 elementId、可见对象或光学贡献只能归属一个 layer 的 elementIds。elements 的 layerId 必须存在，layer 的 elementIds 必须覆盖且只覆盖全部 elements。手、杯盖、杯身、水流、反光和阴影分别声明归属；光学/阴影可用 carrierElementId 指向承载对象，但不转移所有权。included=false 的层也保留清单，供背景移除和其他前景排除。重复、遗漏或未知引用时不要猜测，返回无法完成的 JSON 让调用方拒绝。',
    '不得编造图中不可见的物体、空层或重复层。只做分析供用户校对，不生成图片、不创建节点、不执行任务。',
  ].join('\n');
  if (input.purpose === 'reverse_workflow') return [
    base,
    reverseDepthInstruction(input.reverseAnalysisDepth),
    '本次任务按用户消息中的反推工作流 JSON 合同输出，只返回一个 JSON 对象，不要 Markdown 围栏或额外分析文章。',
    '只依据真实可见证据填写 visual、referenceDuties 和 prompts；主体数量、空间、材质、光线、机位、景深、构图、透视及遮挡均需分析，估计和未知必须说明。',
    `引用顺序：${input.referenceMentions.map(reference => `${reference.mention}（${reference.label}）`).join('、') || '无'}。逐一说明继承、替换、禁止照搬与冲突，不改变素材顺序。`,
    '将中文、英文提示词和负面约束放入 prompts，将方向放入 variants，将执行检查放入 checklist；不在 JSON 外再输出八段文字，不声称已创建或运行工作流。',
  ].join('\n');
  if (!input.visualAnalysis) return base;
  const orderedReferences = input.referenceMentions
    .map((reference) => `${reference.mention}（${reference.label}）`)
    .join('、');
  if (input.agentMode === 'original') return [
    base,
    reverseDepthInstruction(input.reverseAnalysisDepth),
    '结合用户需求和参考素材规划创作工作流。观察只依据可见证据，估计和未知分别标明；保留项、修改项和禁止项均落实到方案。',
    `引用顺序：${orderedReferences || '无'}。保持各素材的用途和顺序，不能漏掉用户要求的参考图。`,
    '遵循本次请求的 JSON 方案合同，必须优先完成 options：每个方案包含完整执行 prompt、可用生成模型 modelRoute 和 workflow 步骤；summary 和 requirements 简明。不能只返回分析报告或关键词。',
    '没有兼容生成模型或需求无法执行时明确说明并返回 options:[]。方案供界面预览、选择和确认；不要声称已经创建节点或生成图片。',
  ].join('\n');
  return [
    base,
    reverseDepthInstruction(input.reverseAnalysisDepth),
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

function reverseDepthInstruction(depth: 'fast' | 'standard' | 'deep' | undefined): string {
  if (depth === 'fast') return '使用快速取证反推：优先主体、构图、光线、材质和可执行提示词，内容保持简洁。';
  if (depth === 'deep') return '使用深度反推：逐素材证据、冲突裁决、空间与材质细节、复现步骤必须充分。';
  return '使用标准反推：覆盖完整分析合同并说明关键取舍。';
}

function reasoningInstruction(effort: 'low' | 'medium' | 'high' | undefined): string {
  if (effort === 'high') return '使用深度推理，明确依赖关系、失败边界和验证步骤，再给出结论。';
  if (effort === 'low') return '使用快速推理，优先给出最短可执行方案。';
  return '使用标准推理，说明关键取舍和验证步骤。';
}
