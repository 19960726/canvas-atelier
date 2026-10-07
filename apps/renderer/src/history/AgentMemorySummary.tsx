import { BookOpen } from 'lucide-react';
import type { ProjectMemoryEntry } from '@agent-canvas/domain';

export function AgentMemorySummary({ entries }: { readonly entries: readonly ProjectMemoryEntry[] }) {
  const latest = entries.reduce<ProjectMemoryEntry | undefined>((current, entry) => {
    if (!current || entry.projectRevision > current.projectRevision
      || (entry.projectRevision === current.projectRevision && entry.createdAt > current.createdAt)) return entry;
    return current;
  }, undefined);

  return (
    <div className="agent-memory-summary">
      <BookOpen size={15} aria-hidden="true" />
      <span className="agent-memory-summary__label">项目记忆</span>
      <span className="agent-memory-summary__count">{entries.length} 条</span>
      <span className="agent-memory-summary__latest" title={latest?.title}>{latest?.title}</span>
    </div>
  );
}
