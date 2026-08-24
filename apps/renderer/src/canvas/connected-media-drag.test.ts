import { describe, expect, it } from 'vitest';

import {
  decodeConnectedMediaDragPayload,
  encodeConnectedMediaDragPayload,
} from './connected-media-drag';

describe('connected media drag payload', () => {
  it('round-trips a project image or video identity without preview URLs', () => {
    expect(decodeConnectedMediaDragPayload(encodeConnectedMediaDragPayload({
      assetId: 'asset-image-1',
      kind: 'image',
      label: '产品参考图',
    }))).toEqual({ assetId: 'asset-image-1', kind: 'image', label: '产品参考图' });
  });

  it.each([
    '',
    'not-json',
    '{}',
    '{"assetId":"","kind":"image","label":"x"}',
    '{"assetId":"asset-1","kind":"audio","label":"x"}',
  ])('rejects malformed or unsupported drag data: %s', (value) => {
    expect(decodeConnectedMediaDragPayload(value)).toBeNull();
  });
});
