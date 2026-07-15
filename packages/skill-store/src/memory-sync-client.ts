import { z } from 'zod';
import { generationMemoryEventSchema, type GenerationMemoryEvent } from './generation-memory';
import { knowledgeSnapshotSyncSchema, memorySyncBatchSchema, type MemorySyncBatch } from './memory-sync';
import type { KnowledgeSnapshot } from './knowledge-registry';

interface FetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type MemorySyncFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<FetchResponse>;

interface MemorySyncClientOptions {
  baseUrl: string;
  tokenSupplier: () => Promise<string>;
  fetch: MemorySyncFetch;
}

const uploadResultSchema = z.object({
  acceptedIds: z.array(z.string()),
  duplicateIds: z.array(z.string()),
  conflictIds: z.array(z.string()),
}).strict();

const pendingResultSchema = z.object({
  events: z.array(generationMemoryEventSchema),
  cursor: z.string().optional(),
}).strict();

const uploadApprovedSnapshotResultSchema = z.object({
  accepted: z.boolean(),
  duplicate: z.boolean(),
  snapshotId: z.string().min(1),
}).strict();

const approvedSnapshotPullResultSchema = z.object({
  snapshot: knowledgeSnapshotSyncSchema.nullable(),
  cursor: z.string().optional(),
}).strict();

export class MemorySyncClient {
  private readonly baseUrl: string;
  private readonly tokenSupplier: () => Promise<string>;
  private readonly fetch: MemorySyncFetch;

  constructor(options: MemorySyncClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.tokenSupplier = options.tokenSupplier;
    this.fetch = options.fetch;
  }

  async uploadBatch(input: MemorySyncBatch) {
    const batch = memorySyncBatchSchema.parse(input);
    const response = await this.request(
      `/v1/knowledge-bases/${encodeURIComponent(batch.knowledgeBaseId)}/memory-batches`,
      { method: 'POST', body: JSON.stringify(batch) },
    );
    return uploadResultSchema.parse(await response.json());
  }

  async pullPending(knowledgeBaseId: string, cursor?: string): Promise<{ events: GenerationMemoryEvent[]; cursor?: string }> {
    const suffix = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
    const response = await this.request(`/v1/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/memories/pending${suffix}`, { method: 'GET' });
    return pendingResultSchema.parse(await response.json());
  }

  async uploadApprovedSnapshot(snapshot: KnowledgeSnapshot, options: { idempotencyKey: string }) {
    const parsed = knowledgeSnapshotSyncSchema.parse(snapshot);
    const response = await this.request(
      `/v1/knowledge-bases/${encodeURIComponent(parsed.knowledgeBaseId)}/approved-snapshot`,
      {
        method: 'PUT',
        body: JSON.stringify(parsed),
        headers: { 'idempotency-key': options.idempotencyKey },
      },
    );
    return uploadApprovedSnapshotResultSchema.parse(await response.json());
  }

  async pullApprovedSnapshot(knowledgeBaseId: string, cursor?: string): Promise<{ snapshot: KnowledgeSnapshot | null; cursor?: string }> {
    const suffix = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
    const response = await this.request(`/v1/knowledge-bases/${encodeURIComponent(knowledgeBaseId)}/approved-snapshot${suffix}`, { method: 'GET' });
    const result = approvedSnapshotPullResultSchema.parse(await response.json());
    if (result.snapshot && result.snapshot.knowledgeBaseId !== knowledgeBaseId) {
      throw new Error('approved snapshot response knowledge base mismatch');
    }
    return result;
  }

  private async request(path: string, init: { method: string; body?: string; headers?: Record<string, string> }): Promise<FetchResponse> {
    const token = await this.tokenSupplier();
    const response = await this.fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...init.headers },
    });
    if (!response.ok) {
      throw new Error(`knowledge sync request failed with status ${response.status}`);
    }
    return response;
  }
}
