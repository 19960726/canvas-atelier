import { describe, expect, it } from 'vitest';

import { protocolContentTypeForPath } from './protocol-content-type';

describe('desktop protocol content type', () => {
  it.each([
    ['preview.png', 'image/png'],
    ['preview.jpg', 'image/jpeg'],
    ['preview.jpeg', 'image/jpeg'],
    ['preview.gif', 'image/gif'],
    ['preview.webp', 'image/webp'],
    ['preview.mp4', 'video/mp4'],
  ])('preserves the media MIME for %s', (path, expected) => {
    expect(protocolContentTypeForPath(path)).toBe(expected);
  });

  it('fails closed to PNG for a validated image path with an unknown extension', () => {
    expect(protocolContentTypeForPath('preview.unknown')).toBe('image/png');
  });
});
