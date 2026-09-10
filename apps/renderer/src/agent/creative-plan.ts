import type { ProviderBridgeProfile } from '@agent-canvas/desktop-core';
import { generationProfiles, type GenerationKind, type GenerationPreferences } from './generation-preferences';

export interface CreativePlanOption { id: string; title: string; reason: string; kind: GenerationKind; prompt: string; modelRoute?: string }
export interface CreativePlan { summary: string; observations: string[]; estimates: string[]; unknowns: string[]; options: CreativePlanOption[] }
const text = (value: unknown, max = 6000): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item) => text(item, 1200)).slice(0, 12) : [];
export function parseCreativePlan(message: string): CreativePlan | null {
  try {
    const source = JSON.parse(message.trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, ''));
    if (!source || !text(source.summary, 2000) || !Array.isArray(source.options) || source.options.length < 1 || source.options.length > 3) return null;
    const options: CreativePlanOption[] = [];
    for (const option of source.options) {
      if (!option || !text(option.id, 80) || !text(option.title, 160) || !text(option.reason, 1200) || !text(option.prompt) || !['image', 'video'].includes(option.kind) || options.some((item) => item.id === option.id)) return null;
      options.push({ id: option.id, title: option.title, reason: option.reason, kind: option.kind, prompt: option.prompt, ...(text(option.modelRoute, 200) ? { modelRoute: option.modelRoute } : {}) });
    }
    return { summary: source.summary, observations: strings(source.observations), estimates: strings(source.estimates), unknowns: strings(source.unknowns), options };
  } catch { return null; }
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
    const kind = inferRecoveryKind(request, preferences.kind, referenceCount);
    const candidates = generationProfiles(profiles, kind, referenceCount);
    const preferredRoute = preferences[kind].modelRoute;
    const profile = candidates.find((candidate) => candidate.modelRoute === preferredRoute) ?? candidates[0];
    if (profile === undefined) return null;
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

function inferRecoveryKind(request: string, preference: GenerationKind, referenceCount: number): GenerationKind {
  if (/(?:视频|动画|短片|video|animation)/iu.test(request)) return 'video';
  if (referenceCount > 0 || /(?:图片|图像|主图|海报|产品图|精修|修图|image|photo|poster)/iu.test(request)) return 'image';
  return preference;
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
    '图片/视频生成需求明确时，返回纯 JSON：{"summary":"需求与取舍摘要","observations":[],"estimates":[],"unknowns":[],"options":[{"id":"option-1","title":"方案名称","reason":"适用原因","kind":"image 或 video","prompt":"完整具体可执行的提示词","modelRoute":"从可用生成模型中选择"}]}。提供1至3个有实质差异的方案，不能用相同提示词填充。',
    `用户未指定产物时的偏好：${preferences.kind}。明确的图片或视频要求优先。固定模型与参数必须遵守，可用目录：${JSON.stringify(routes)}`,
    ...(referenceCount > 0 ? ['本次请求含有参考图，图片方案只能引用支持 image_edit 或 gemini_native 的路线；视频方案必须匹配参考图数量对应的输入模式。'] : []),
    '聊天模型只负责规划。选项中只引用生成目录的路线，不能使用聊天路线。没有可用生成模型时给出建议并说明需配置，不能声称可以执行。',
  ].join('\n');
}
