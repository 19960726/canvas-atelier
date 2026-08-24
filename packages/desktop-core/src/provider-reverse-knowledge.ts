import { ManagedKnowledgeStore } from './managed-knowledge-store.js';
import { createProviderBridgeError } from './provider-contracts.js';

type KnowledgePin = {
  readonly knowledgeBaseId: string;
  readonly version: number;
  readonly contentHash: string;
};

export async function readPinnedReverseKnowledge(
  store: ManagedKnowledgeStore,
  pins: readonly KnowledgePin[],
): Promise<readonly {
  readonly knowledgeBaseId: string;
  readonly version: number;
  readonly contentHash: string;
  readonly documents: readonly { readonly relativePath: string; readonly content: string }[];
}[]> {
  return Promise.all(pins.map(async (pin) => {
    const snapshot = await store.readVersion(pin.knowledgeBaseId, pin.version);
    if (snapshot === null || snapshot.contentHash !== pin.contentHash) {
      throw createProviderBridgeError('PROVIDER_UNAVAILABLE', 'Pinned reverse-analysis knowledge is unavailable');
    }
    return {
      knowledgeBaseId: snapshot.knowledgeBaseId,
      version: snapshot.version,
      contentHash: snapshot.contentHash,
      documents: snapshot.documents.map(({ relativePath, content }) => ({ relativePath, content })),
    };
  }));
}
