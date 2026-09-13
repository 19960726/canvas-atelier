export type ReverseAnalysisDepth = 'fast' | 'standard' | 'deep';

export interface ReverseAnalysisBudget {
  readonly maxOutputTokens: number;
  readonly timeoutMs: number;
}

export function resolveReverseAnalysisBudget(depth: ReverseAnalysisDepth | undefined): ReverseAnalysisBudget {
  if (depth === 'fast') return { maxOutputTokens: 4_096, timeoutMs: 90_000 };
  if (depth === 'deep') return { maxOutputTokens: 16_384, timeoutMs: 300_000 };
  return { maxOutputTokens: 8_192, timeoutMs: 180_000 };
}
