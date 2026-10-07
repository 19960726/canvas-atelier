import { describe, expect, it } from 'vitest';
import {
  normalizeReverseAnalysisResult,
  parseReverseAnalysisResponse,
  type ReverseReferenceDuty,
} from './reverse-workflow-contract';

const references: ReverseReferenceDuty[] = [
  { assetId: 'b', mention: '@图片1', responsibility: '场景', inherit: [], replace: [], doNotCopy: [] },
  { assetId: 'a', mention: '@图片2', responsibility: '主体', inherit: [], replace: [], doNotCopy: [] },
];

describe('structured reverse workflow contract', () => {
  const completePayload = {
    referenceDuties: references,
    prompts: { zh: '保持产品原位与比例，自然窗光。', en: 'Keep the original product, scale and window light.' },
    visual: { subject: '主体', environment: '环境', material: '材质', lighting: '灯光', camera: '镜头', depth: '景深', composition: '构图', perspective: '透视', layers: '前中后景' },
  };

  it.each(['object', 'json', 'fenced json'] as const)('blocks a structured response whose supplied variants normalize to no executable choice (%s)', format => {
    const payload = { ...completePayload, variants: [
      null,
      'not a variant',
      { id: 'unsupported', name: 'unrecognized', prompt: '不能采用的方案' },
      { id: 7, name: 'faithful', prompt: '非法方案编号' },
      { id: 'missing-name', prompt: '缺少方案类型' },
    ] };
    const response = format === 'object' ? payload
      : format === 'json' ? JSON.stringify(payload)
        : `\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``;
    const result = parseReverseAnalysisResponse(response, references);

    expect(result.variants).toEqual([]);
    expect(result.runnable).toBe(false);
    expect(result.missing).toContain('variants');
    expect(result.intent.missing).toContain('variants');
    expect(result.prompts.zh).toBe(completePayload.prompts.zh);
    expect(result.referenceDuties.map(duty => duty.assetId)).toEqual(['b', 'a']);
  });

  it.each([undefined, []])('preserves the faithful base-prompt fallback when variants are omitted or empty (%s)', variants => {
    const result = normalizeReverseAnalysisResult({ ...completePayload, variants }, references);

    expect(result.variants).toEqual([{ id: 'faithful', name: 'faithful', change: '采用本次反推的完整提示词。', prompt: completePayload.prompts.zh }]);
    expect(result.runnable).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it('keeps a legal executable choice runnable alongside rejected variant entries', () => {
    const variant = { id: 'valid', name: 'faithful', change: '保留原位', prompt: '保留产品与构图，采用柔和窗光。' };
    const result = normalizeReverseAnalysisResult({ ...completePayload, variants: [
      { id: 'bad', name: 'unrecognized', prompt: '非法类型' },
      variant,
      null,
    ] }, references);

    expect(result.variants).toEqual([variant]);
    expect(result.runnable).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it('offers one faithful execution when only a base prompt is supplied instead of fabricating three equivalent choices', () => {
    const result = normalizeReverseAnalysisResult({
      prompts: { zh: '产品原位构图，保持轮廓与比例，自然窗光，原背景金属材质。', en: 'Keep the original product and framing.' },
      visual: { subject: '主体', environment: '环境', material: '材质', lighting: '灯光', camera: '镜头', depth: '景深', composition: '构图', perspective: '透视', layers: '前中后景' },
    }, references);
    expect(result.variants).toEqual([{ id: 'faithful', name: 'faithful', change: '采用本次反推的完整提示词。', prompt: result.prompts.zh }]);
  });

  it('merges equivalent model variants and keeps an actual different execution prompt', () => {
    const prompt = '产品原位构图，原背景自然窗光，保留轮廓与比例。';
    const result = normalizeReverseAnalysisResult({ prompts: { zh: prompt, en: 'Original framing.' }, variants: [
      { id: 'a', name: 'faithful', change: '原位复现', prompt },
      { id: 'b', name: 'balanced', change: '均衡', prompt: ` ${prompt}\n` },
      { id: 'c', name: 'exploratory', change: '改变背景光线', prompt: '产品原位构图，冷色背景光，保留轮廓与比例。' },
    ] }, references);
    expect(result.variants.map((variant) => variant.id)).toEqual(['a', 'c']);
  });

  it('preserves ordered reference duties instead of sorting asset ids', () => {
    const result = normalizeReverseAnalysisResult({
      referenceDuties: references,
      prompts: { zh: '中文', en: 'English', negative: ['水印'] },
      visual: { subject: '主体', environment: '环境', material: '材质', lighting: '灯光', camera: '镜头', depth: '景深', composition: '构图', perspective: '透视', layers: '前中后景' },
    }, references);

    expect(result.referenceDuties.map((item) => item.assetId)).toEqual(['b', 'a']);
    expect(result.referenceDuties.map((item) => item.mention)).toEqual(['@图片1', '@图片2']);
  });

  it('reports missing required reverse sections instead of treating a connected provider as runnable', () => {
    const result = normalizeReverseAnalysisResult({ prompts: { zh: '中文' }, visual: {} }, references);

    expect(result.missing).toEqual(expect.arrayContaining(['prompts.en', 'visual.layers']));
    expect(result.runnable).toBe(false);
  });

  it('does not mark image understanding runnable when the model omits every reference responsibility', () => {
    const result = normalizeReverseAnalysisResult({
      prompts: { zh: '产品原位，真实材质，自然窗光。', en: 'Original product, real material, window light.' },
      visual: { subject: '主体', environment: '环境', material: '材质', lighting: '灯光', camera: '镜头', depth: '景深', composition: '构图', perspective: '透视', layers: '前中后景' },
    }, references);
    expect(result.runnable).toBe(false);
    expect(result.missing).toContain('referenceDuties');
  });

  it('keeps legacy provider text readable while exposing a structured fallback', () => {
    const result = parseReverseAnalysisResponse('主体是白色产品，浅色背景。', references);

    expect(result.legacyText).toContain('主体是白色产品');
    expect(result.prompts.zh).toContain('主体是白色产品');
    expect(result.runnable).toBe(false);
  });

  it('parses JSON and fenced JSON assistant responses into the structured contract', () => {
    const payload = {
      visual: { subject: '主体', environment: '环境', material: '材质', lighting: '灯光', camera: '镜头', depth: '景深', composition: '构图', perspective: '透视', layers: '前中后景' },
      prompts: { zh: '中文提示词', en: 'English prompt', negative: ['水印'] },
    };
    for (const response of [JSON.stringify(payload), `\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``]) {
      const result = parseReverseAnalysisResponse(response, references);
      expect(result.prompts.zh).toBe('中文提示词');
      expect(result.prompts.en).toBe('English prompt');
      expect(result.legacyText).toBeUndefined();
    }
  });

  it('preserves reference duties when a provider omits optional arrays', () => {
    const fallback: ReverseReferenceDuty = {
      assetId: 'b',
      mention: '@图片1',
      responsibility: '场景',
      inherit: ['背景色', '地面关系'],
      replace: ['主体'],
      doNotCopy: ['水印'],
    };
    const result = normalizeReverseAnalysisResult({
      referenceDuties: [{ assetId: 'b', responsibility: '场景' }],
      prompts: { zh: '中文', en: 'English' },
      visual: { subject: '主体', environment: '环境', material: '材质', lighting: '灯光', camera: '镜头', depth: '景深', composition: '构图', perspective: '透视', layers: '前中后景' },
    }, [fallback, references[1]!]);

    expect(result.referenceDuties[0]).toMatchObject({
      inherit: ['背景色', '地面关系'],
      replace: ['主体'],
      doNotCopy: ['水印'],
    });
  });
});
