import { z } from 'zod';
import { generationMemoryEventSchema, type GenerationMemoryEvent } from './generation-memory';
import { memorySyncBatchSchema, type MemorySyncBatch } from './memory-sync';

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

  private async request(path: string, init: { method: string; body?: string }): Promise<FetchResponse> {
    const token = await this.tokenSupplier();
    const response = await this.fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    });
    if (!response.ok) {
      throw new Error(`knowledge sync request failed with status ${response.status}`);
    }
    return response;
  }
}