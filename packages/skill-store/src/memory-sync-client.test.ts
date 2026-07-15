import { describe, expect, it, vi } from 'vitest';
import type { GenerationMemoryEvent } from './generation-memory';
import { createMemorySyncBatch } from './memory-sync';
import { MemorySyncClient } from './memory-sync-client';
import { createKnowledgeSnapshotCandidate } from './knowledge-snapshot';
import { KnowledgeSnapshotRegistry } from './knowledge-registry';

const event: GenerationMemoryEvent = {
  schemaVersion: 1, id: 'm1', knowledgeBaseId: 'scene-skill', projectId: 'p1', sourceDeviceId: 'device-b', createdAt: '2026-07-13T12:00:00.000Z',
  skill: { id: 'scene-skill', version: 'v1' }, prompt: { userRequest: '生图', reversePrompt: '产品居中' }, references: ['product_identity'],
  model: { provider: 'comfly', modelId: 'image-model', parameters: {} },
  outcome: { assetIds: ['a1'], keep: [], change: [], never: [] },
  lesson: { category: '产品锁定', rootCause: '约束不足', preventionRule: '锁定产品身份', keywords: ['锁定'] }, reviewStatus: 'pending_review',
};

describe('MemorySyncClient', () => {
  it('uploads a device batch to the configured central knowledge service', async () => {
    const fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ acceptedIds: ['m1'], duplicateIds: [], conflictIds: [] }) }));
    const client = new MemorySyncClient({ baseUrl: 'https://knowledge.example.com/', tokenSupplier: async () => 'token', fetch });
    const batch = createMemorySyncBatch([event], { batchId: 'batch-1', createdAt: '2026-07-13T12:01:00.000Z' });

    await expect(client.uploadBatch(batch)).resolves.toMatchObject({ acceptedIds: ['m1'] });
    expect(fetch).toHaveBeenCalledWith('https://knowledge.example.com/v1/knowledge-bases/scene-skill/memory-batches', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ authorization: 'Bearer token', 'content-type': 'application/json' }),
    }));
  });

  it('pulls pending remote memories for review without exposing the token in errors', async () => {
    const fetch = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({ message: 'Bearer token must never appear' }) }));
    const client = new MemorySyncClient({ baseUrl: 'https://knowledge.example.com', tokenSupplier: async () => 'secret-token', fetch });

    await expect(client.pullPending('scene-skill')).rejects.not.toThrow(/secret-token/);
  });

  it('uploads an approved snapshot with request-time authorization and idempotency', async () => {
    const snapshot = createSnapshot();
    const fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ accepted: true, duplicate: false, snapshotId: 'scene-skill@1' }) }));
    const client = new MemorySyncClient({ baseUrl: 'https://knowledge.example.com/', tokenSupplier: async () => 'token', fetch });

    await expect(client.uploadApprovedSnapshot(snapshot, { idempotencyKey: 'idem-1' })).resolves.toEqual({
      accepted: true,
      duplicate: false,
      snapshotId: 'scene-skill@1',
    });
    expect(fetch).toHaveBeenCalledWith('https://knowledge.example.com/v1/knowledge-bases/scene-skill/approved-snapshot', expect.objectContaining({
      method: 'PUT',
      headers: expect.objectContaining({ authorization: 'Bearer token', 'content-type': 'application/json', 'idempotency-key': 'idem-1' }),
      body: expect.stringContaining('"version":1'),
    }));
  });

  it('pulls an approved snapshot by cursor', async () => {
    const snapshot = createSnapshot();
    const fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ snapshot, cursor: 'cursor-2' }) }));
    const client = new MemorySyncClient({ baseUrl: 'https://knowledge.example.com', tokenSupplier: async () => 'token', fetch });

    await expect(client.pullApprovedSnapshot('scene-skill', 'cursor-1')).resolves.toEqual({ snapshot, cursor: 'cursor-2' });
    expect(fetch).toHaveBeenCalledWith('https://knowledge.example.com/v1/knowledge-bases/scene-skill/approved-snapshot?cursor=cursor-1', expect.anything());
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
