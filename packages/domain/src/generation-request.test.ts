import { describe, expect, it } from 'vitest';
import { MAX_GENERATION_REFERENCES, parseGenerationRequest } from './generation-request';

const reference = (index: number) => ({
  assetId: `asset-${index}`,
  role: index % 2 === 0 ? 'product_identity' as const : 'material_lighting' as const,
});

function requestWithCount(count: number) {
  return {
    projectId: 'project-1',
    prompt: '高端产品主视觉',
    references: Array.from({ length: count }, (_, index) => reference(index)),
  };
}

describe('generation request reference validation', () => {
  it('accepts 20 unique references across all roles', () => {
    expect(MAX_GENERATION_REFERENCES).toBe(20);
    expect(parseGenerationRequest(requestWithCount(20)).references).toHaveLength(20);
  });

  it('rejects image 21', () => {
    expect(() => parseGenerationRequest(requestWithCount(21))).toThrow(/参考图最多 20 张/);
  });

  it('rejects duplicate reference assets', () => {
    const request = requestWithCount(2);
    request.references[1] = { ...request.references[1]!, assetId: request.references[0]!.assetId };
    expect(() => parseGenerationRequest(request)).toThrow(/参考图不能重复/);
  });
});