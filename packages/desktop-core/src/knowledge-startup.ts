import type { KnowledgeBaseStateSummary } from '@agent-canvas/skill-store';

export async function startConfiguredKnowledgeRefresh(
  store: { listStates(): Promise<KnowledgeBaseStateSummary[]> },
  refresh: { start(knowledgeBaseIds: string[]): Promise<void> },
): Promise<string[]> {
  const states = await store.listStates();
  const knowledgeBaseIds = [...new Set(states.map((state) => state.knowledgeBaseId))].sort(compareStrings);
  await refresh.start(knowledgeBaseIds);
  return knowledgeBaseIds;
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}