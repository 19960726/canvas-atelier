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
