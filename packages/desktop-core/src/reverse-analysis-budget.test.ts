import { describe, expect, it } from 'vitest';
import { resolveReverseAnalysisBudget } from './reverse-analysis-budget';

describe('reverse analysis budget', () => {
  it('keeps output strength while allowing visual models enough transport time', () => {
    expect(resolveReverseAnalysisBudget('fast')).toEqual({ maxOutputTokens: 4_096, timeoutMs: 180_000 });
    expect(resolveReverseAnalysisBudget('standard')).toEqual({ maxOutputTokens: 8_192, timeoutMs: 360_000 });
    expect(resolveReverseAnalysisBudget('deep')).toEqual({ maxOutputTokens: 16_384, timeoutMs: 600_000 });
  });
});
