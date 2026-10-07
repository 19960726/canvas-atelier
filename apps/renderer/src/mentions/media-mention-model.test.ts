import { describe, expect, it } from 'vitest';
import {
  buildConnectedMentionCatalog,
  parseCanonicalMentions,
  reconcileConnectedMentions,
} from './media-mention-model';

describe('media mention model', () => {
  it('keeps node binding numbers stable while preview metadata reloads', () => {
    const media = [{ assetId: 'a', kind: 'image' }, { assetId: 'b', kind: 'image' }] as const;
    expect(buildConnectedMentionCatalog(media, [{ assetId: 'b', label: 'B' }], [], true).map(item => [item.token, item.assetId]))
      .toEqual([['@图片1', 'a'], ['@图片2', 'b']]);
  });
  it('preserves an as-yet unbound token while a user connects its first reference', () => {
    const next = [{ token: '@图片1', assetId: 'new-image', kind: 'image', label: 'New' }] as const;
    expect(reconcileConnectedMentions([], next, '先写 @图片1 再连线')).toBe('先写 @图片1 再连线');
  });
  it('does not parse or erase a partial token inside a larger number', () => {
    const value = '@图片100 @视频200';
    expect(parseCanonicalMentions(value)).toEqual([{ kind: 'text', text: value, start: 0, end: value.length }]);
    expect(reconcileConnectedMentions([], [], value)).toBe(value);
  });
  it('parses canonical tokens while exposing labels without @', () => {
    expect(parseCanonicalMentions('参考 @图片1 和 @视频2')).toEqual([
      { kind: 'text', text: '参考 ', start: 0, end: 3 },
      { kind: 'image', text: '图片1', token: '@图片1', start: 3, end: 7 },
      { kind: 'text', text: ' 和 ', start: 7, end: 10 },
      { kind: 'video', text: '视频2', token: '@视频2', start: 10, end: 14 },
    ]);
  });

  it('numbers only connected images and videos in their own sequences', () => {
    const catalog = buildConnectedMentionCatalog(
      [
        { edgeId: 'e1', assetId: 'image-a', kind: 'image' },
        { edgeId: 'e2', assetId: 'video-a', kind: 'video' },
        { edgeId: 'e3', assetId: 'image-b', kind: 'image' },
      ],
      [
        { assetId: 'image-a', label: 'A', displayUrl: 'managed://a' },
        { assetId: 'image-b', label: 'B', displayUrl: 'managed://b' },
        { assetId: 'unconnected', label: 'History generated', displayUrl: 'managed://history' },
      ],
      [{ assetId: 'video-a', label: 'V', displayUrl: 'managed://v' }],
    );
    expect(catalog.map(({ token, assetId }) => ({ token, assetId }))).toEqual([
      { token: '@图片1', assetId: 'image-a' },
      { token: '@视频1', assetId: 'video-a' },
      { token: '@图片2', assetId: 'image-b' },
    ]);
    expect(catalog.some((item) => item.assetId === 'unconnected')).toBe(false);
  });

  it('removes disconnected references and rebinds remaining tokens by asset identity', () => {
    const previous = [
      { token: '@图片1', assetId: 'image-a', kind: 'image', label: 'A' },
      { token: '@图片2', assetId: 'image-b', kind: 'image', label: 'B' },
    ] as const;
    const next = [{ token: '@图片1', assetId: 'image-b', kind: 'image', label: 'B' }] as const;
    expect(reconcileConnectedMentions(previous, next, '保留 @图片2 删除 @图片1')).toBe('保留 @图片1 删除');
  });

  it('skips unresolved assets, preserves repeated mentions, and handles multiline single-kind catalogs', () => {
    const catalog = buildConnectedMentionCatalog(
      [
        { assetId: 'missing', kind: 'image' },
        { assetId: 'image-a', kind: 'image' },
      ],
      [{ assetId: 'image-a', label: 'A' }],
      [],
    );
    expect(catalog).toEqual([{
      token: '@图片1', assetId: 'image-a', kind: 'image', label: 'A',
    }]);
    expect(reconcileConnectedMentions(catalog, catalog, '@图片1\n@图片1')).toBe('@图片1\n@图片1');
  });

  it('preserves unrelated horizontal whitespace while removing only mention-local separators', () => {
    const previous = [{ token: '@图片1', assetId: 'image-a', kind: 'image', label: 'A' }] as const;
    const unchanged = reconcileConnectedMentions(previous, previous, '描述  保留 @图片1 ');
    expect(unchanged).toBe('描述  保留 @图片1 ');

    const removed = reconcileConnectedMentions(previous, [], '描述  保留 @图片1 后');
    expect(removed).toBe('描述  保留 后');
  });
});
