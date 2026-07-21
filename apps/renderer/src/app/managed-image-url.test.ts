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
    expect(isRenderableManagedImageUrl(['data:image/png;base', '64,AAAAAAAAAAAAAAAA'].join(''))).toBe(false);
    expect(isRenderableManagedImageUrl(['blob', 'managed-preview'].join(':'))).toBe(false);
  });
});
