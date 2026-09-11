import type { ProviderBridgeProfile } from '@agent-canvas/desktop-core';
import { generationProfiles, type GenerationKind, type GenerationPreferences } from './generation-preferences';

export interface CreativeWorkflowStep { title: string; detail: string }
export interface CreativePlanOption { id: string; title: string; reason: string; kind: GenerationKind; prompt: string; modelRoute?: string; workflow?: CreativeWorkflowStep[] }
export interface CreativePlan { summary: string; observations: string[]; estimates: string[]; unknowns: string[]; options: CreativePlanOption[] }
export interface ConstrainedCreativePlan { plan: CreativePlan; selectedKind: GenerationKind; rejectedCount: number }
const text = (value: unknown, max = 6000): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item) => text(item, 1200)).slice(0, 12) : [];
export function parseCreativePlan(message: string): CreativePlan | null {
  try {
    const source = JSON.parse(message.trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, ''));
    if (!source || !text(source.summary, 2000) || !Array.isArray(source.options) || source.options.length < 1 || source.options.length > 3) return null;
    const options: CreativePlanOption[] = [];
    for (const option of source.options) {
      if (!option || !text(option.id, 80) || !text(option.title, 160) || !text(option.reason, 1200) || !text(option.prompt) || !['image', 'video'].includes(option.kind) || options.some((item) => item.id === option.id)) return null;
      const workflow = Array.isArray(option.workflow)
        ? option.workflow.flatMap((step: unknown) => {
          if (!step || typeof step !== 'object') return [];
          const record = step as Record<string, unknown>;
          return text(record.title, 160) && text(record.detail, 1200)
            ? [{ title: record.title.trim(), detail: record.detail.trim() }]
            : [];
        }).slice(0, 6)
        : [];
      options.push({ id: option.id, title: option.title, reason: option.reason, kind: option.kind, prompt: option.prompt, ...(text(option.modelRoute, 200) ? { modelRoute: option.modelRoute } : {}), ...(workflow.length > 0 ? { workflow } : {}) });
    }
    return { summary: source.summary, observations: strings(source.observations), estimates: strings(source.estimates), unknowns: strings(source.unknowns), options };
  } catch { return null; }
}

export function creativeWorkflowSteps(option: CreativePlanOption, referenceCount: number): CreativeWorkflowStep[] {
  if ((option.workflow?.length ?? 0) >= 3) return option.workflow!;
  const kindLabel = option.kind === 'video' ? '视频' : '图片';
  return [
    {
      title: '整理需求与素材',
      detail: referenceCount > 0
        ? `连接 ${referenceCount} 个参考素材，按发送顺序保留主体、构图或风格约束。`
        : '把方案要求写入提示词节点，明确主体、场景、构图和禁止改变的内容。',
    },
    {
      title: `执行${kindLabel}生成`,
      detail: `使用${option.modelRoute ? ` ${option.modelRoute} ` : '已选择的生成模型'}执行完整提示词，保留已确认的比例、清晰度、质量和数量。`,
    },
    {
      title: '回写并检查结果',
      detail: `把${kindLabel}结果连接到输出节点，检查返图、实际尺寸和任务状态，应用重启后仍可恢复。`,
    },
  ];
}

export function constrainCreativePlanKind(plan: CreativePlan, selectedKind: GenerationKind): ConstrainedCreativePlan {
  const options = plan.options.filter((option) => option.kind === selectedKind);
  return {
    plan: { ...plan, options },
    selectedKind,
    rejectedCount: plan.options.length - options.length,
  };
}

export function recoverEmptyCreativePlan(
  message: string,
  request: string,
  preferences: GenerationPreferences,
  profiles: readonly ProviderBridgeProfile[],
  referenceCount = 0,
): CreativePlan | null {
  try {
    const source = JSON.parse(stripJsonFence(message));
    if (!source || !text(source.summary, 2000) || !Array.isArray(source.options) || source.options.length !== 0) return null;
    const kind = preferences.kind;
    const candidates = generationProfiles(profiles, kind, referenceCount);
    const preferredRoute = preferences[kind].modelRoute;
    const profile = candidates.find((candidate) => candidate.modelRoute === preferredRoute) ?? candidates[0];
    if (profile === undefined) {
      return {
        summary: source.summary,
        observations: strings(source.observations),
        estimates: strings(source.estimates),
        unknowns: strings(source.unknowns),
        options: [],
      };
    }
    const prompt = request.replace(/@(?:图片|视频)\d+/gu, ' ').replace(/\s+/gu, ' ').trim();
    if (!text(prompt)) return null;
    const refining = kind === 'image' && (referenceCount > 0 || /(?:精修|修改|调整|替换|移除|保留|不.*改变|edit|refine|preserve)/iu.test(prompt));
    return {
      summary: source.summary,
      observations: strings(source.observations),
      estimates: strings(source.estimates),
      unknowns: strings(source.unknowns),
      options: [{
        id: 'recovered-exact-request',
        title: refining ? '按当前要求精修' : kind === 'video' ? '按当前要求生成视频' : '按当前要求生成图片',
        reason: refining ? '使用已连接参考素材，只修改明确要求的部分。' : '按当前请求与已配置生成路线执行。',
        kind,
        prompt,
        modelRoute: profile.modelRoute,
      }],
    };
  } catch {
    return null;
  }
}

function stripJsonFence(message: string): string {
  return message.trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '');
}

export function creativePlanningInstructions(
  preferences: GenerationPreferences,
  profiles: readonly ProviderBridgeProfile[],
  referenceCount = 0,
): string {
  const routes = (['image', 'video'] as const).map((kind) => {
    const candidates = generationProfiles(profiles, kind, referenceCount);
    const fixed = candidates.find((profile) => profile.modelRoute === preferences[kind].modelRoute);
    const ordered = fixed ? [fixed, ...candidates.filter((profile) => profile !== fixed)] : candidates;
    const models: { route: string; name: string; parameters: unknown }[] = [];
    let budget = 3200;
    for (const profile of ordered) {
      const model = { route: profile.modelRoute, name: profile.displayName.slice(0, 100), parameters: profile.constraints?.[kind] };
      const size = JSON.stringify(model).length;
      if (size > budget) continue;
      models.push(model);
      budget -= size;
    }
    return { kind, preference: preferences[kind], models };
  });
  return [
    '请先分析需求，给出合理的创作方案，等待用户选择，再由界面请求确认执行。不能声称已生成或修改画布。不输出隐藏思考，只提供可核查的分析摘要。',
    '区分 observations（观察）、estimates（估计，含依据）、unknowns（未知）。需求不足以形成方案时，用普通文字询问缺失信息，不编造可执行方案。',
    '图片/视频生成需求明确时，返回纯 JSON：{"summary":"需求与取舍摘要","observations":[],"estimates":[],"unknowns":[],"options":[{"id":"option-1","title":"方案名称","reason":"适用原因","kind":"image 或 video","prompt":"完整具体可执行的提示词","modelRoute":"从可用生成模型中选择","workflow":[{"title":"用户能理解的步骤名称","detail":"该步骤会使用什么输入、创建什么节点、做什么检查"}]}]}。提供1至3个有实质差异的方案，每个方案提供3至6个具体 workflow 步骤，不能只给关键词或用相同提示词填充。',
    `本次已明确选择输出类型：${preferences.kind}。所有 options.kind 必须为 ${preferences.kind}，不得自动改成 ${preferences.kind === 'image' ? 'video' : 'image'}。如果所选类型没有兼容路线，返回 options:[] 并明确提示用户配置兼容模型；不能用另一种产物代替。固定模型与参数必须遵守，可用目录：${JSON.stringify(routes)}`,
    ...(referenceCount > 0 ? ['本次请求含有参考图，图片方案只能引用支持 image_edit 或 gemini_native 的路线；视频方案必须匹配参考图数量对应的输入模式。'] : []),
    '聊天模型只负责规划。选项中只引用生成目录的路线，不能使用聊天路线。没有可用生成模型时给出建议并说明需配置，不能声称可以执行。',
  ].join('\n');
}
