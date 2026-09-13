export type ReverseAnalysisDepth = 'fast' | 'standard' | 'deep';

const PROVIDER_SETTLEMENT_MARGIN_MS = 15_000;

export function resolveReverseAnalysisOperationTimeoutMs(depth: ReverseAnalysisDepth | undefined): number {
  const providerTimeoutMs = depth === 'fast'
    ? 180_000
    : depth === 'deep'
      ? 600_000
      : 360_000;
  return providerTimeoutMs + PROVIDER_SETTLEMENT_MARGIN_MS;
}
