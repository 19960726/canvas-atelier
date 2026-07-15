import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { MAX_GENERATION_REFERENCES, parseGenerationRequest } from './generation-request';
import { createAgentKnowledgeLease } from './knowledge-context';

const reference = (index: number) => ({
  assetId: `asset-${index}`,
  label: `Asset ${index}`,
  role: index % 2 === 0 ? 'product_identity' as const : 'material_lighting' as const,
  position: index,
});

function requestWithCount(count: number) {
  const references = Array.from({ length: count }, (_, index) => reference(index));
  const citations = count > 1 ? [{ assetId: 'asset-1', label: 'Asset 1' }] : [];
  return {
    projectId: 'project-1',
    prompt: 'Premium product scene',
    references,
    citations,
    knowledgeLease: createAgentKnowledgeLease({
      runId: 'run-1',
      capability: 'image_generation',
      snapshots: [{ knowledgeBaseId: 'scene-skill', version: 3, contentHash: 'a'.repeat(64) }],
      references,
      citations,
    }, {
      leaseId: 'lease-1',
      createdAt: '2026-07-15T10:00:00.000Z',
    }),
  };
}

describe('generation request reference validation', () => {
  it('accepts 20 unique ordered references and one immutable lease', () => {
    expect(MAX_GENERATION_REFERENCES).toBe(20);
    const request = parseGenerationRequest(requestWithCount(20));
    expect(request.references).toHaveLength(20);
    expect(request.knowledgeLease.leaseId).toBe('lease-1');
  });

  it('rejects references that differ from the pinned lease', () => {
    const request = requestWithCount(2);
    request.references = [request.references[1]!, request.references[0]!];
    expect(() => parseGenerationRequest(request)).toThrow(ZodError);
  });

  it('rejects a lease with an empty version key', () => {
    const request = requestWithCount(2);
    request.knowledgeLease = {
      ...request.knowledgeLease,
      versionKey: '',
    };

    expect(() => parseGenerationRequest(request)).toThrow(ZodError);
  });

  it('rejects image 21 with a stable max-reference issue', () => {
    try {
      parseGenerationRequest(requestWithCount(21));
      throw new Error('expected parseGenerationRequest to reject image 21');
    } catch (error) {
      expect(error).toBeInstanceOf(ZodError);
      const issue = (error as ZodError).issues[0];
      expect(issue).toMatchObject({
        code: 'too_big',
        maximum: MAX_GENERATION_REFERENCES,
        path: ['references'],
      });
    }
  });

  it('rejects duplicate reference assets with a stable duplicate issue', () => {
    const request = requestWithCount(2);
    request.references[1] = { ...request.references[1]!, assetId: request.references[0]!.assetId };

    try {
      parseGenerationRequest(request);
      throw new Error('expected parseGenerationRequest to reject duplicate reference assets');
    } catch (error) {
      expect(error).toBeInstanceOf(ZodError);
      const issue = (error as ZodError).issues[0];
      expect(issue).toMatchObject({
        code: 'custom',
        path: ['references', 1, 'assetId'],
      });
    }
  });
});
