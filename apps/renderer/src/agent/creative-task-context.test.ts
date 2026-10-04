import { describe, expect, it } from 'vitest';
import { createConfirmedCreativeTaskContext, formatCreativeTaskContext, parseCreativeTaskContext } from './creative-task-context';

const snapshotInput = () => ({
  generationKind: 'image' as const,
  originalRequest: '@图片8产品位置和比例不变，一家六口，桌上必须正好6个饺子。@图片3只参考光线。',
  executionPrompt: '产品原位原比例，一家六口，桌上正好6个饺子；参考图片3仅改变灯光，其他物体不得复制。',
  references: [{ assetId: 'product-eight', label: '原图产品', mention: '@图片8' }, { assetId: 'lighting-three', label: '灯光', mention: '@图片3' }],
  executionReferenceAssetIds: ['product-eight'], confirmedAt: 1_000,
});

describe('confirmed creative task context', () => {
  it('formats the full constraints and original numbered identities without replacing initial requirements with a later revision', () => {
    const input = { ...snapshotInput(), executionPrompt: '保持最初6个饺子、产品位置与比例；本次仅调整侧光，不改家人数量。' };
    const context = createConfirmedCreativeTaskContext(input);
    const formatted = formatCreativeTaskContext(context);
    expect(formatted).toContain(input.originalRequest);
    expect(formatted).toContain(input.executionPrompt);
    expect(formatted).toContain(JSON.stringify(input.references));
    expect(formatted).toContain('实际执行采用的素材 ID：["product-eight"]');
    expect(formatted).toContain('不代表生成结果已验收');
    expect(context.references.map(reference => reference.mention)).toEqual(['@图片8', '@图片3']);
  });

  it('copies mutable input references instead of retaining caller aliases', () => {
    const input = snapshotInput();
    const context = createConfirmedCreativeTaskContext(input);
    input.references[0]!.assetId = 'changed-after-confirmation';
    input.executionReferenceAssetIds[0] = 'changed-after-confirmation';
    expect(context.references[0]!.assetId).toBe('product-eight');
    expect(context.executionReferenceAssetIds).toEqual(['product-eight']);
  });

  it('rejects one asset bound to two original mentions instead of letting catalog deduplication lose one binding', () => {
    expect(parseCreativeTaskContext({ version: 1, ...snapshotInput(), references: [
      { assetId: 'product-eight', label: '产品', mention: '@图片8' },
      { assetId: 'product-eight', label: '重复产品', mention: '@图片3' },
    ] })).toBeUndefined();
  });

  it('accepts the exact 16000-character text limit and rejects overflow rather than truncating', () => {
    const executionPrompt = '图'.repeat(16_000);
    expect(createConfirmedCreativeTaskContext({ ...snapshotInput(), executionPrompt }).executionPrompt).toBe(executionPrompt);
    expect(() => createConfirmedCreativeTaskContext({ ...snapshotInput(), executionPrompt: executionPrompt + '尾' })).toThrow(/过长/u);
  });

  it('throws when the complete formatted snapshot exceeds the remaining message budget', () => {
    const context = createConfirmedCreativeTaskContext(snapshotInput());
    const formatted = formatCreativeTaskContext(context);
    expect(formatCreativeTaskContext(context, formatted.length)).toBe(formatted);
    expect(() => formatCreativeTaskContext(context, formatted.length - 1)).toThrow(/不能截断/u);
  });

  it('accepts twenty exact references with a bound execution subset and video output', () => {
    const references = Array.from({ length: 20 }, (_, index) => ({ assetId: `asset-${index}`, label: `素材${index}`, mention: `@图片${index + 1}` }));
    const context = createConfirmedCreativeTaskContext({ ...snapshotInput(), generationKind: 'video', references,
      executionReferenceAssetIds: ['asset-0', 'asset-19'] });
    expect(context.references).toHaveLength(20);
    expect(formatCreativeTaskContext(context)).toContain('已确认输出类型：视频');
    expect(context.executionReferenceAssetIds).toEqual(['asset-0', 'asset-19']);
  });

  it.each([
    { references: [{ assetId: 'product-eight', label: '产品', mention: '@图片8' }, { assetId: 'lighting-three', label: '灯光', mention: '@图片8' }] },
    { references: [{ assetId: 'product-eight', label: 'https://example.com', mention: '@图片8' }] },
    { references: [{ assetId: 'product-eight', label: '产品', mention: '@图片01' }] },
    { executionReferenceAssetIds: ['product-eight', 'product-eight'] },
    { executionReferenceAssetIds: ['foreign-asset'] },
    { confirmedAt: -1 },
    { version: 2 },
    { rawImage: 'data:image/png;base64,AAAA' },
  ])('rejects malformed or unbound snapshot metadata: %j', patch => {
    expect(parseCreativeTaskContext({ version: 1, ...snapshotInput(), ...patch })).toBeUndefined();
  });

  it.each(['Authorization: private-value', 'Bearer fakecredential123', 'sk-fakecredential123', 'api_key=fake-key', 'token: private-token', 'secret=private-secret', 'password: private-password'])
    ('refuses to retransmit credential material in confirmed task text: %s', credential => {
      expect(parseCreativeTaskContext({ version: 1, ...snapshotInput(), originalRequest: credential })).toBeUndefined();
      expect(parseCreativeTaskContext({ version: 1, ...snapshotInput(), executionPrompt: credential })).toBeUndefined();
    });

  it('rejects credential material in reference metadata while retaining ordinary words without credential values', () => {
    expect(parseCreativeTaskContext({ version: 1, ...snapshotInput(), references: [{ assetId: 'product-eight', label: 'token: private-token', mention: '@图片8' }] })).toBeUndefined();
    expect(parseCreativeTaskContext({ version: 1, ...snapshotInput(), references: [{ assetId: 'sk-fakecredential123', label: '产品', mention: '@图片8' }], executionReferenceAssetIds: ['sk-fakecredential123'] })).toBeUndefined();
    expect(parseCreativeTaskContext({ version: 1, ...snapshotInput(), originalRequest: '产品文字包含token一词，不是密钥值' })).toBeDefined();
  });
});
