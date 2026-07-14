import { describe, expect, it } from 'vitest';

import { canonicalJson, sha256Canonical } from './canonical-json';

describe('canonicalJson', () => {
  it('canonicalizes object insertion order', () => {
    expect(canonicalJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
    expect(sha256Canonical({ b: 2, a: 1 })).toBe(sha256Canonical({ a: 1, b: 2 }));
  });

  it('sorts nested plain-object keys and preserves array order', () => {
    expect(
      canonicalJson({
        z: [{ d: 4, c: 3 }, { keep: ['first', 'second'] }],
        a: { y: 2, x: 1 },
      }),
    ).toBe('{"a":{"x":1,"y":2},"z":[{"c":3,"d":4},{"keep":["first","second"]}]}');
  });

  it('accepts nulls, booleans, strings, and finite numbers', () => {
    expect(
      canonicalJson({
        bool: false,
        nil: null,
        num: 12.5,
        str: 'hello',
        zero: 0,
      }),
    ).toBe('{"bool":false,"nil":null,"num":12.5,"str":"hello","zero":0}');
  });

  it.each([
    ['undefined', { value: undefined }],
    ['function', { value: () => 'nope' }],
    ['symbol', { value: Symbol('nope') }],
    ['bigint', { value: BigInt(1) }],
    ['NaN', { value: Number.NaN }],
    ['Infinity', { value: Number.POSITIVE_INFINITY }],
    ['-Infinity', { value: Number.NEGATIVE_INFINITY }],
  ])('rejects %s values', (_label, value) => {
    expect(() => canonicalJson(value)).toThrow(/JSON-safe/);
  });

  it('rejects sparse arrays', () => {
    expect(() => canonicalJson([1, , 3])).toThrow(/JSON-safe/);
  });

  it('rejects non-plain objects', () => {
    class CustomValue {
      constructor(readonly value: number) {}
    }

    expect(() => canonicalJson(new Date('2026-07-14T00:00:00.000Z'))).toThrow(/plain object/i);
    expect(() => canonicalJson(new CustomValue(1))).toThrow(/plain object/i);
    expect(() => canonicalJson(Object.create(null) as Record<string, unknown>)).toThrow(/plain object/i);
  });

  it('rejects circular references', () => {
    const value: { self?: unknown } = {};
    value.self = value;

    expect(() => canonicalJson(value)).toThrow(/circular/i);
  });
});
