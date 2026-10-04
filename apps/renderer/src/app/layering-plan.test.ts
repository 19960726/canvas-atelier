import { describe, expect, it } from 'vitest';
import {
  confirmLayeringPlan,
  matchesLayeringConfirmation,
  parseLayeringAnalysis,
  type LayeringPlan,
} from './layering-plan';

const validReply = JSON.stringify({
  layers: [
    { layerId: 'background', kind: 'background', name: '背景', description: '补全被前景遮挡的场景', included: true },
    { layerId: 'product', kind: 'transparent', name: '主体', description: '保留主体轮廓和材质', included: true },
    { layerId: 'label', kind: 'transparent', name: '标签', description: '保留标签作为像素层', included: true },
  ],
});

describe('GPT assisted layering plan', () => {
  it('parses ordered background and transparent foreground recommendations', () => {
    const plan = parseLayeringAnalysis(validReply, 'asset-1', 1024, 768);
    expect(plan).toEqual({
      sourceAssetId: 'asset-1',
      canvasWidth: 1024,
      canvasHeight: 768,
      layers: [
        { layerId: 'background', kind: 'background', name: '背景', description: '补全被前景遮挡的场景', included: true },
        { layerId: 'product', kind: 'transparent', name: '主体', description: '保留主体轮廓和材质', included: true },
        { layerId: 'label', kind: 'transparent', name: '标签', description: '保留标签作为像素层', included: true },
      ],
    });
  });

  it.each([
    ['non JSON prose', 'Here are some layers: ' + validReply],
    ['missing foreground', JSON.stringify({ layers: [{ layerId: 'background', kind: 'background', name: '背景', description: '场景', included: true }] })],
    ['duplicate background', JSON.stringify({ layers: [
      { layerId: 'background-a', kind: 'background', name: '背景', description: '场景', included: true },
      { layerId: 'background-b', kind: 'background', name: '第二背景', description: '场景', included: true },
      { layerId: 'foreground', kind: 'transparent', name: '主体', description: '主体', included: true },
    ] })],
    ['duplicate layer id', JSON.stringify({ layers: [
      { layerId: 'same', kind: 'background', name: '背景', description: '场景', included: true },
      { layerId: 'same', kind: 'transparent', name: '主体', description: '主体', included: true },
    ] })],
    ['empty name', JSON.stringify({ layers: [
      { layerId: 'background', kind: 'background', name: ' ', description: '场景', included: true },
      { layerId: 'foreground', kind: 'transparent', name: '主体', description: '主体', included: true },
    ] })],
    ['twelve foregrounds', JSON.stringify({ layers: [
      { layerId: 'background', kind: 'background', name: '背景', description: '场景', included: true },
      ...Array.from({ length: 12 }, (_, index) => ({ layerId: `foreground-${index}`, kind: 'transparent', name: `前景 ${index}`, description: '主体', included: true })),
    ] })],
    ['untrusted extra fields', JSON.stringify({ layers: [
      { layerId: 'background', kind: 'background', name: '背景', description: '场景', included: true },
      { layerId: 'foreground', kind: 'transparent', name: '主体', description: '主体', included: true, command: 'run a tool' },
    ] })],
  ])('rejects %s before it can become an executable plan', (_name, reply) => {
    expect(() => parseLayeringAnalysis(reply, 'asset-1', 1024, 768)).toThrow();
  });

  it('binds confirmation to the exact editable plan, route, resolution and source', async () => {
    const plan = parseLayeringAnalysis(validReply, 'asset-1', 1024, 768);
    const confirmedAt = '2026-09-23T06:00:00.000Z';
    const confirmation = await confirmLayeringPlan(plan, 'comfly', 'comfly-gpt-image-2', '2K', confirmedAt);

    expect(confirmation.layerIds).toEqual(['background', 'product', 'label']);
    await expect(matchesLayeringConfirmation(confirmation, plan, 'comfly', 'comfly-gpt-image-2', '2K')).resolves.toBe(true);
    await expect(matchesLayeringConfirmation(confirmation, { ...plan, sourceAssetId: 'asset-2' }, 'comfly', 'comfly-gpt-image-2', '2K')).resolves.toBe(false);
    await expect(matchesLayeringConfirmation(confirmation, { ...plan, layers: plan.layers.map((layer, index) => index === 1 ? { ...layer, description: '修改主体说明' } : layer) }, 'comfly', 'comfly-gpt-image-2', '2K')).resolves.toBe(false);
    await expect(matchesLayeringConfirmation(confirmation, plan, 'comfly', 'comfly-gpt-image-2', '4K')).resolves.toBe(false);
    await expect(matchesLayeringConfirmation(confirmation, plan, 'relayme', 'comfly-gpt-image-2', '2K')).resolves.toBe(false);
  });

  it('ignores non-included suggestions when listing jobs but invalidates a changed inclusion choice', async () => {
    const plan: LayeringPlan = parseLayeringAnalysis(validReply, 'asset-1', 1024, 768);
    const edited = { ...plan, layers: plan.layers.map((layer) => layer.layerId === 'label' ? { ...layer, included: false } : layer) };
    const confirmation = await confirmLayeringPlan(edited, 'comfly', 'comfly-gpt-image-2', '1K', '2026-09-23T06:00:00.000Z');
    expect(confirmation.layerIds).toEqual(['background', 'product']);
    await expect(matchesLayeringConfirmation(confirmation, edited, 'comfly', 'comfly-gpt-image-2', '1K')).resolves.toBe(true);
    await expect(matchesLayeringConfirmation(confirmation, plan, 'comfly', 'comfly-gpt-image-2', '1K')).resolves.toBe(false);
  });

  it('requires one explicit owner for every inventoried element and allows real optical overlap', () => {
    const reply = {
      layers: [
        { layerId: 'background', kind: 'background', name: '背景', description: '场景', included: true, elementIds: ['scene'] },
        { layerId: 'cup', kind: 'transparent', name: '杯身', description: '杯身', included: true, sourceBounds: { x: 0, y: 0, width: 1, height: 1 }, elementIds: ['cup'] },
        { layerId: 'water', kind: 'transparent', name: '水流', description: '水流', included: true, sourceBounds: { x: 0, y: 0, width: 1, height: 1 }, elementIds: ['water'] },
      ],
      elements: [
        { elementId: 'scene', name: '场景', layerId: 'background', kind: 'object' },
        { elementId: 'cup', name: '杯身', layerId: 'cup', kind: 'object' },
        { elementId: 'water', name: '水流', layerId: 'water', kind: 'optical', carrierElementId: 'cup' },
      ],
    };
    const plan = parseLayeringAnalysis(JSON.stringify(reply), 'asset-1', 1024, 768, { requireElementInventory: true });
    expect(plan.elements?.[2]).toMatchObject({ elementId: 'water', carrierElementId: 'cup' });
    expect(() => parseLayeringAnalysis(JSON.stringify({ ...reply, layers: reply.layers.map(layer => layer.layerId === 'water' ? { ...layer, elementIds: ['cup'] } : layer) }), 'asset-1', 1024, 768, { requireElementInventory: true })).toThrow(/owner|ownership/u);
    expect(() => parseLayeringAnalysis(JSON.stringify({ ...reply, elements: reply.elements.map(element => element.elementId === 'water' ? { ...element, layerId: 'missing' } : element) }), 'asset-1', 1024, 768, { requireElementInventory: true })).toThrow(/layer/u);
    expect(() => parseLayeringAnalysis(JSON.stringify({ ...reply, elements: reply.elements.map(element => element.elementId === 'water' ? { ...element, carrierElementId: 'missing' } : element) }), 'asset-1', 1024, 768, { requireElementInventory: true })).toThrow(/carrier/u);
  });

  it('binds confirmation to ownership changes, including excluded layers', async () => {
    const reply = {
      layers: [
        { layerId: 'background', kind: 'background', name: '背景', description: '场景', included: true, elementIds: ['scene'] },
        { layerId: 'subject', kind: 'transparent', name: '主体', description: '主体', included: true, sourceBounds: { x: 0, y: 0, width: 1, height: 1 }, elementIds: ['subject'] },
        { layerId: 'hidden', kind: 'transparent', name: '隐藏对象', description: '未导出对象', included: false, sourceBounds: { x: 0, y: 0, width: .2, height: .2 }, elementIds: ['hidden'] },
      ],
      elements: [
        { elementId: 'scene', name: '场景', layerId: 'background', kind: 'object' },
        { elementId: 'subject', name: '主体', layerId: 'subject', kind: 'object' },
        { elementId: 'hidden', name: '隐藏对象', layerId: 'hidden', kind: 'object' },
      ],
    };
    const plan = parseLayeringAnalysis(JSON.stringify(reply), 'asset-1', 1024, 768, { requireElementInventory: true });
    const confirmation = await confirmLayeringPlan(plan, 'comfly', 'comfly-gpt-image-2', '2K', '2026-09-23T06:00:00.000Z');
    const changed = { ...plan, elements: plan.elements!.map(element => element.elementId === 'hidden' ? { ...element, name: '不同对象' } : element) };
    await expect(matchesLayeringConfirmation(confirmation, changed, 'comfly', 'comfly-gpt-image-2', '2K')).resolves.toBe(false);
  });
});
