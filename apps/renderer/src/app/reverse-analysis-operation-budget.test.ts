import { describe, expect, it } from 'vitest';
import { resolveReverseAnalysisOperationTimeoutMs } from './reverse-analysis-operation-budget';

describe('reverse analysis renderer operation budget', () => {
  it('stays beyond the provider transport budget at every selected depth', () => {
    expect(resolveReverseAnalysisOperationTimeoutMs('fast')).toBe(195_000);
    expect(resolveReverseAnalysisOperationTimeoutMs('standard')).toBe(375_000);
    expect(resolveReverseAnalysisOperationTimeoutMs('deep')).toBe(615_000);
  });
});
