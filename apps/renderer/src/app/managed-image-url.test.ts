import { describe, expect, it } from 'vitest';

import { isRenderableManagedImageUrl } from './managed-image-url';

describe('managed image URL policy', () => {
  it('allows only active-format project URLs and the same-origin E2E fixture path', () => {
    expect(isRenderableManagedImageUrl('novus-asset://project/session-1/0123456789abcdef')).toBe(true);
    expect(isRenderableManagedImageUrl(`${window.location.origin}/__novus_e2e_asset/0123456789abcdef.svg`)).toBe(true);
    expect(isRenderableManagedImageUrl(
      'novus-asset://project/session-1/0123456789abcdef',
      'fedcba9876543210',
    )).toBe(false);
    expect(isRenderableManagedImageUrl(
      `${window.location.origin}/__novus_e2e_asset/0123456789abcdef.svg`,
      'fedcba9876543210',
    )).toBe(false);

    expect(isRenderableManagedImageUrl('novus-asset://project/session-1/0123456789abcdef?path=private')).toBe(false);
    expect(isRenderableManagedImageUrl('https://assets.example/image.png')).toBe(false);
    expect(isRenderableManagedImageUrl(['data:image/png;base', '64,AAAAAAAAAAAAAAAA'].join(''))).toBe(true);
    expect(isRenderableManagedImageUrl(['blob', 'managed-preview'].join(':'))).toBe(false);
  });

  it('allows only same-origin browser blob previews used by imported media thumbnails', () => {
    expect(isRenderableManagedImageUrl(
      `blob:${window.location.origin}/01234567-89ab-cdef`,
      '0123456789abcdef',
    )).toBe(true);
    expect(isRenderableManagedImageUrl(
      'blob:https://other.example/01234567-89ab-cdef',
      '0123456789abcdef',
    )).toBe(false);
  });
  it('allows only bounded raster image data URLs used by durable browser previews', () => {
    const png = `data:image/png;base64,${'A'.repeat(32)}`;
    expect(isRenderableManagedImageUrl(png, '0123456789abcdef')).toBe(true);
    expect(isRenderableManagedImageUrl('data:image/svg+xml;base64,PHN2Zz4=', '0123456789abcdef')).toBe(false);
    expect(isRenderableManagedImageUrl('data:text/html;base64,PGgxPk5vPC9oMT4=', '0123456789abcdef')).toBe(false);
  });
});
