import { describe, expect, it } from 'vitest';
import type { GenerationMemoryEvent } from './generation-memory';
import { createApprovedSnapshotSyncEnvelope, createMemorySyncBatch, ingestMemorySyncBatch } from './memory-sync';
import { createKnowledgeSnapshotCandidate } from './knowledge-snapshot';
import { KnowledgeSnapshotRegistry } from './knowledge-registry';

const event: GenerationMemoryEvent = {
  schemaVersion: 1,
  id: 'memory-device-b-1',
  knowledgeBaseId: 'scene-skill',
  projectId: 'project-remote',
  sourceDeviceId: 'device-b',
  createdAt: '2026-07-13T12:00:00.000Z',
  skill: { id: 'scene-skill', version: 'v1' },
  prompt: { userRequest: '生成产品图', reversePrompt: '产品居中', negativePrompt: '禁止改 Logo' },
  references: ['product_identity'],
  model: { provider: 'comfly', modelId: 'image-model', parameters: { aspectRatio: '4:5' } },
  outcome: { assetIds: ['asset-1'], keep: ['产品'], change: [], never: ['改 Logo'] },
  lesson: { category: '产品锁定', rootCause: '身份约束不足', preventionRule: '提高产品身份参考优先级', keywords: ['产品锁定'] },
  reviewStatus: 'pending_review',
};

describe('memory sync contract', () => {
  it('creates a device-attributed batch for one knowledge base', () => {
    expect(createMemorySyncBatch([event], { batchId: 'batch-1', createdAt: '2026-07-13T12:01:00.000Z' })).toMatchObject({
      schemaVersion: 1,
      batchId: 'batch-1',
      knowledgeBaseId: 'scene-skill',
      sourceDeviceId: 'device-b',
      events: [{ id: 'memory-device-b-1' }],
    });
  });

  it('rejects mixed devices or mixed knowledge bases in one upload', () => {
    expect(() => createMemorySyncBatch([event, { ...event, id: 'm2', sourceDeviceId: 'device-c' }], { batchId: 'b', createdAt: event.createdAt })).toThrow(/device/);
    expect(() => createMemorySyncBatch([event, { ...event, id: 'm3', knowledgeBaseId: 'other' }], { batchId: 'b', createdAt: event.createdAt })).toThrow(/knowledge base/);
  });

  it('ingests remote events as pending review and rejects the wrong destination', () => {
    const batch = createMemorySyncBatch([event], { batchId: 'batch-1', createdAt: '2026-07-13T12:01:00.000Z' });
    expect(ingestMemorySyncBatch([], batch, 'scene-skill').accepted[0]).toMatchObject({ id: event.id, reviewStatus: 'pending_review' });
    expect(() => ingestMemorySyncBatch([], batch, 'another-skill')).toThrow(/destination/);
  });

  it('wraps approved snapshots with cursor and idempotency metadata only', () => {
    const snapshot = createSnapshot();
    const envelope = createApprovedSnapshotSyncEnvelope(snapshot, {
      envelopeId: 'snapshot-envelope-1',
      cursor: 'cursor-2',
      idempotencyKey: 'idem-1',
      createdAt: '2026-07-15T10:02:00.000Z',
    });

    expect(envelope).toMatchObject({
      schemaVersion: 1,
      envelopeId: 'snapshot-envelope-1',
      knowledgeBaseId: 'scene-skill',
      cursor: 'cursor-2',
      idempotencyKey: 'idem-1',
      snapshot: { version: 1 },
    });
    expect(() => createApprovedSnapshotSyncEnvelope({ ...snapshot, knowledgeBaseId: 'other-skill' }, {
      envelopeId: 'snapshot-envelope-2',
      knowledgeBaseId: 'scene-skill',
      createdAt: '2026-07-15T10:03:00.000Z',
    })).toThrow(/knowledge base/i);
  });
});

function createSnapshot() {
  const registry = new KnowledgeSnapshotRegistry();
  return registry.publish(createKnowledgeSnapshotCandidate({
    knowledgeBaseId: 'scene-skill',
    displayName: 'Scene Skill',
    documents: [{ relativePath: 'memory/main.md', content: '# Scene Skill' }],
  }), {
    publishedAt: '2026-07-15T10:01:00.000Z',
    sourceDeviceId: 'device-a',
  });
}
