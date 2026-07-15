import { describe, expect, it } from 'vitest';
import {
  UNCONFIGURED_KNOWLEDGE_VERSION_KEY,
  createAgentKnowledgeLease,
  reorderReferences,
  type OrderedReference,
} from './knowledge-context';

const references: OrderedReference[] = [
  { assetId: 'product', label: 'Product', role: 'product_identity', position: 0 },
  { assetId: 'scene', label: 'Scene', role: 'scene_composition', position: 1 },
];

describe('agent knowledge lease', () => {
  it('pins snapshots and preserves reference order', () => {
    const lease = createAgentKnowledgeLease({
      runId: 'run-1',
      capability: 'reverse_prompt',
      snapshots: [
        { knowledgeBaseId: 'scene-skill', version: 3, contentHash: 'b'.repeat(64) },
        { knowledgeBaseId: 'ecommerce-detail', version: 2, contentHash: 'a'.repeat(64) },
      ],
      references,
      citations: [{ assetId: 'scene', label: 'Scene' }],
    }, {
      leaseId: 'lease-1',
      createdAt: '2026-07-15T10:00:00.000Z',
    });

    expect(lease.snapshots.map((item) => item.knowledgeBaseId)).toEqual(['ecommerce-detail', 'scene-skill']);
    expect(lease.references.map((item) => item.assetId)).toEqual(['product', 'scene']);
    expect(lease.versionKey).toMatch(/^ecommerce-detail@2:/);
  });

  it('uses a stable explicit fallback version key when snapshots are not configured', () => {
    const lease = createAgentKnowledgeLease({
      runId: 'run-no-snapshots',
      capability: 'reverse_prompt',
      snapshots: [],
      references,
      citations: [],
    }, {
      leaseId: 'lease-no-snapshots',
      createdAt: '2026-07-15T10:00:00.000Z',
    });

    expect(lease.versionKey).toBe(UNCONFIGURED_KNOWLEDGE_VERSION_KEY);
  });

  it('reorders without mutating input', () => {
    const next = reorderReferences(references, 'scene', 'product');

    expect(next.map((item) => item.assetId)).toEqual(['scene', 'product']);
    expect(references.map((item) => item.assetId)).toEqual(['product', 'scene']);
  });

  it('keeps order when moving a reference before itself', () => {
    expect(reorderReferences(references, 'product', 'product')).toEqual(references);
  });

  it('rejects image citations whose labels do not match the ordered reference', () => {
    expect(() => createAgentKnowledgeLease({
      runId: 'run-bad-citation-label',
      capability: 'reverse_prompt',
      snapshots: [],
      references,
      citations: [{ assetId: 'scene', label: 'Product' }],
    }, {
      leaseId: 'lease-bad-citation-label',
      createdAt: '2026-07-15T10:00:00.000Z',
    })).toThrow(/label/i);
  });

  it('rejects duplicate image citations for the same asset', () => {
    expect(() => createAgentKnowledgeLease({
      runId: 'run-duplicate-citation',
      capability: 'reverse_prompt',
      snapshots: [],
      references,
      citations: [
        { assetId: 'scene', label: 'Scene' },
        { assetId: 'scene', label: 'Scene' },
      ],
    }, {
      leaseId: 'lease-duplicate-citation',
      createdAt: '2026-07-15T10:00:00.000Z',
    })).toThrow(/duplicate/i);
  });
});
