import { describe, expect, it } from 'vitest';
import { parseAssetByteRange } from './asset-byte-range.js';

describe('local asset byte ranges', () => {
  it('distinguishes full reads from partial video reads', () => {
    expect(parseAssetByteRange(null, 100)).toBeUndefined();
    expect(parseAssetByteRange('bytes=30-59', 100)).toEqual({start:30,end:59});
    expect(parseAssetByteRange('bytes=30-', 100)).toEqual({start:30,end:99});
    expect(parseAssetByteRange('bytes=-20', 100)).toEqual({start:80,end:99});
    expect(parseAssetByteRange('bytes=30-200', 100)).toEqual({start:30,end:99});
  });
  it('rejects invalid, empty, multiple and unsatisfiable byte ranges', () => {
    for(const range of ['bytes=100-', 'bytes=20-10', 'bytes=-0', 'bytes=-', 'bytes=1-2,4-5', 'bytes=999999999999999999999-', 'items=0-1']) expect(parseAssetByteRange(range,100)).toBeNull();
    expect(parseAssetByteRange('bytes=0-',0)).toBeNull();
  });
});
