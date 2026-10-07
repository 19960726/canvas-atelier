export type ReverseProposalState =
  | 'idle'
  | 'analyzing'
  | 'proposal_ready'
  | 'confirming'
  | 'executing'
  | 'completed'
  | 'partial_failure'
  | 'failed'
  | 'cancelled';

export interface ReverseReferenceDuty {
  assetId: string;
  mention: string;
  responsibility: string;
  inherit: string[];
  replace: string[];
  doNotCopy: string[];
  conflict?: string;
}

export interface ReverseAnalysisResult {
  intent: { deliverable: string; useCase: string; defaults: string[]; missing: string[] };
  referenceDuties: ReverseReferenceDuty[];
  visual: {
    subject: string;
    environment: string;
    material: string;
    lighting: string;
    camera: string;
    depth: string;
    composition: string;
    perspective: string;
    layers: string;
  };
  prompts: { zh: string; en: string; negative: string[] };
  variants: Array<{ id: string; name: 'faithful' | 'balanced' | 'exploratory'; change: string; prompt: string }>;
  checklist: Array<{ id: string; label: string; state: 'pending' | 'done' | 'blocked' }>;
  missing: string[];
  runnable: boolean;
  legacyText?: string;
}

export interface ReverseWorkflowProposal {
  id: string;
  projectId: string;
  persistenceGeneration: number;
  referenceAssetIds: string[];
  modelRoute: string;
  state: ReverseProposalState;
  analysis: ReverseAnalysisResult;
  editedAnalysis: ReverseAnalysisResult;
  plannedNodes: Array<{ id: string; moduleType: string; variantId?: string }>;
  plannedEdges: Array<{ source: string; target: string; targetPortId: string; order: number }>;
}

const visualFields = ['subject', 'environment', 'material', 'lighting', 'camera', 'depth', 'composition', 'perspective', 'layers'] as const;

export function normalizeReverseAnalysisResult(value: unknown, references: readonly ReverseReferenceDuty[]): ReverseAnalysisResult {
  const source = isRecord(value) ? value : {};
  const sourceVisual = isRecord(source.visual) ? source.visual : {};
  const sourcePrompts = isRecord(source.prompts) ? source.prompts : {};
  const missing = Array.isArray(source.missing) ? source.missing.filter(isString) : [];
  for (const field of visualFields) if (!isNonEmptyString(sourceVisual[field])) missing.push(`visual.${field}`);
  if (!isNonEmptyString(sourcePrompts.zh)) missing.push('prompts.zh');
  if (!isNonEmptyString(sourcePrompts.en)) missing.push('prompts.en');
  const modelDuties = Array.isArray(source.referenceDuties) ? source.referenceDuties : [];
  if (references.some((reference) => !modelDuties.some((item: unknown) => isRecord(item)
    && item.assetId === reference.assetId && isNonEmptyString(item.responsibility)
    && (item.mention === undefined || item.mention === reference.mention)))) missing.push('referenceDuties');
  if (modelDuties.some((item: unknown) => isRecord(item)
    && !references.some((reference) => reference.assetId === item.assetId))) missing.push('referenceDuties.unknown');
  const duties = Array.isArray(source.referenceDuties)
    ? references.map((reference) => {
      const found = source.referenceDuties.find((item: unknown) => isRecord(item) && item.assetId === reference.assetId);
      return normalizeDuty(found, reference);
    })
    : references.map((reference) => normalizeDuty(undefined, reference));
  const variants = normalizeVariants(source.variants, isNonEmptyString(sourcePrompts.zh) ? sourcePrompts.zh : '');
  if (variants.length === 0) missing.push('variants');
  const result: ReverseAnalysisResult = {
    intent: normalizeIntent(source.intent, missing),
    referenceDuties: duties,
    visual: Object.fromEntries(visualFields.map((field) => [field, readString(sourceVisual[field])])) as ReverseAnalysisResult['visual'],
    prompts: {
      zh: readString(sourcePrompts.zh),
      en: readString(sourcePrompts.en),
      negative: Array.isArray(sourcePrompts.negative) ? sourcePrompts.negative.filter(isString) : [],
    },
    variants,
    checklist: normalizeChecklist(source.checklist),
    missing: [...new Set(missing)],
    runnable: missing.length === 0 && duties.length === references.length,
  };
  return result;
}

export function parseReverseAnalysisResponse(value: unknown, references: readonly ReverseReferenceDuty[]): ReverseAnalysisResult {
  if (isRecord(value)) return normalizeReverseAnalysisResult(value, references);
  const legacyText = typeof value === 'string' ? value.trim() : '';
  const structured = parseJsonResponse(legacyText);
  if (structured !== null) return normalizeReverseAnalysisResult(structured, references);
  const result = normalizeReverseAnalysisResult({
    prompts: { zh: legacyText },
    visual: {},
    missing: ['structured_response'],
  }, references);
  return { ...result, legacyText: legacyText || '模型没有返回可读的反推内容。' };
}

function parseJsonResponse(value: string): Record<string, unknown> | null {
  if (!value) return null;
  const candidates = [value, value.replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '').trim()];
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (isRecord(parsed)) return parsed;
    } catch {
      // Provider responses may include prose; keep the legacy fallback readable.
    }
  }
  return null;
}

function normalizeDuty(value: unknown, fallback: ReverseReferenceDuty): ReverseReferenceDuty {
  const source = isRecord(value) ? value : {};
  return {
    ...fallback,
    responsibility: readString(source.responsibility) || fallback.responsibility,
    inherit: Array.isArray(source.inherit) ? readStringArray(source.inherit) : [...fallback.inherit],
    replace: Array.isArray(source.replace) ? readStringArray(source.replace) : [...fallback.replace],
    doNotCopy: Array.isArray(source.doNotCopy) ? readStringArray(source.doNotCopy) : [...fallback.doNotCopy],
    conflict: readString(source.conflict) || fallback.conflict,
  };
}

function normalizeIntent(value: unknown, missing: readonly string[]) {
  const source = isRecord(value) ? value : {};
  return {
    deliverable: readString(source.deliverable),
    useCase: readString(source.useCase),
    defaults: readStringArray(source.defaults),
    missing: [...new Set([...missing, ...readStringArray(source.missing)])],
  };
}

function normalizeVariants(value: unknown, basePrompt: string): ReverseAnalysisResult['variants'] {
  const defaults: ReverseAnalysisResult['variants'] = [
    { id: 'faithful', name: 'faithful', change: '采用本次反推的完整提示词。', prompt: basePrompt },
  ];
  if (!Array.isArray(value) || value.length === 0) return defaults;
  const ids = new Set<string>();
  const prompts = new Set<string>();
  return value.flatMap((item) => {
    if (!isRecord(item) || !isString(item.id) || !isString(item.name)) return [];
    if (!['faithful', 'balanced', 'exploratory'].includes(item.name)) return [];
    const prompt = readString(item.prompt) || basePrompt;
    const key = prompt.replace(/\s+/gu, ' ').toLocaleLowerCase();
    if (!prompt || ids.has(item.id) || prompts.has(key)) return [];
    ids.add(item.id);
    prompts.add(key);
    return [{ id: item.id, name: item.name as ReverseAnalysisResult['variants'][number]['name'], change: readString(item.change), prompt }];
  }).slice(0, 3);
}

export function reverseWorkflowPlanningInstructions(references: readonly { assetId: string; mention: string; label: string }[]): string {
  return [
    '按本次参考素材和用户需求反推，先分析再提供可编辑工作流，不能声称已生成图片或修改画布。观察必须来自可见图像；推测与未知单独说明。',
    `本次有序素材清单（原编号与 assetId 必须逐项对应）：${JSON.stringify(references.map(({ assetId, mention, label }) => ({ assetId, mention, label: label.slice(0, 100) })))}`,
    '只返回以下 JSON 合同，不输出代码块或八段散文：{"intent":{"deliverable":"交付物","useCase":"用途","defaults":[],"missing":[]},"referenceDuties":[{"assetId":"清单中的ID","mention":"原编号","responsibility":"本图负责的主体/构图/光线/风格","inherit":[],"replace":[],"doNotCopy":[],"conflict":"冲突或未知"}],"visual":{"subject":"主体","environment":"环境","material":"材质","lighting":"光线","camera":"机位镜头","depth":"景深","composition":"构图","perspective":"透视","layers":"前中后景"},"prompts":{"zh":"完整中文执行提示词","en":"完整英文执行提示词","negative":[]},"variants":[{"id":"faithful","name":"faithful","change":"实际改动与取舍","prompt":"完整执行提示词"}],"checklist":[{"id":"check-1","label":"可核验的用户要求","state":"pending"}],"missing":[]}。',
    '每张输入都要给出职责，保留其编号，不得忽略或交换素材。不确定的内容填 missing，不能编造观察。给出1至3个真正不同且符合用户边界的 variants，name 只用 faithful/balanced/exploratory；提示词相同只提供一版，不得为了三版擅改产品或构图。数量、位置、比例、颜色、不得改变的内容必须写进各版完整提示词。',
  ].join('\n');
}

function normalizeChecklist(value: unknown): ReverseAnalysisResult['checklist'] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item, index) => {
    if (!isRecord(item)) return [];
    const state = item.state === 'done' || item.state === 'blocked' ? item.state : 'pending';
    return [{ id: readString(item.id) || `check-${index + 1}`, label: readString(item.label), state }];
  });
}

function readString(value: unknown): string { return typeof value === 'string' ? value.trim() : ''; }
function isString(value: unknown): value is string { return typeof value === 'string'; }
function isNonEmptyString(value: unknown): value is string { return isString(value) && value.trim().length > 0; }
function readStringArray(value: unknown): string[] { return Array.isArray(value) ? value.filter(isString).map((item) => item.trim()).filter(Boolean) : []; }
function isRecord(value: unknown): value is Record<string, any> { return typeof value === 'object' && value !== null; }
