import { useMemo, useState } from 'react';
import { Brain, History, RotateCcw } from 'lucide-react';
import {
  selectActiveProjectMemoryEntries,
  type ProjectMemoryEntry,
  type SkillPromotionCandidate,
} from '@agent-canvas/domain';

interface ProjectMemoryTimelineProps {
  entries: ProjectMemoryEntry[];
  promotionCandidates: SkillPromotionCandidate[];
  availableSnapshotIds: string[];
  onRestore: (snapshotId: string) => void;
  onPromote: (memoryId: string) => void;
}

type MemoryFilter = 'all' | ProjectMemoryEntry['kind'];

const MEMORY_LABELS: Record<ProjectMemoryEntry['kind'], string> = {
  optimization: '优化',
  generation: '生图',
  reverse_prompt: '反推',
  user_feedback: '反馈',
  decision: '决策',
};

export function ProjectMemoryTimeline({
  entries,
  promotionCandidates,
  availableSnapshotIds,
  onRestore,
  onPromote,
}: ProjectMemoryTimelineProps) {
  const [filter, setFilter] = useState<MemoryFilter>('all');
  const pendingMemoryIds = useMemo(
    () => new Set(promotionCandidates.map((candidate) => candidate.sourceProjectMemoryId)),
    [promotionCandidates],
  );
  const activeMemoryIds = useMemo(
    () => new Set(selectActiveProjectMemoryEntries(entries).map((entry) => entry.id)),
    [entries],
  );
  const snapshotIds = useMemo(() => new Set(availableSnapshotIds), [availableSnapshotIds]);
  const visibleEntries = useMemo(
    () => entries
      .filter((entry) => filter === 'all' || entry.kind === filter)
      .slice()
      .sort((left, right) => right.projectRevision - left.projectRevision || right.createdAt.localeCompare(left.createdAt)),
    [entries, filter],
  );

  return (
    <section className="project-memory" aria-label="项目记忆时间线">
      <header className="project-memory__header">
        <div>
          <strong>项目记忆</strong>
          <span>{entries.length} 条记录 · {promotionCandidates.length} 条待审批</span>
        </div>
        <label>
          <span>筛选</span>
          <select aria-label="记忆类型筛选" value={filter} onChange={(event) => setFilter(event.target.value as MemoryFilter)}>
            <option value="all">全部</option>
            <option value="optimization">优化</option>
            <option value="generation">生图</option>
            <option value="reverse_prompt">反推</option>
            <option value="user_feedback">反馈</option>
            <option value="decision">决策</option>
          </select>
        </label>
      </header>

      {visibleEntries.length === 0 ? (
        <div className="project-memory__empty">
          <History size={20} />
          <p>{entries.length === 0 ? '确认一次画布优化后，项目记忆会出现在这里。' : '当前筛选没有记录。'}</p>
        </div>
      ) : (
        <div className="project-memory__list">
          {visibleEntries.map((entry) => {
            const isPending = pendingMemoryIds.has(entry.id);
            const isPromotable = ['optimization', 'generation', 'reverse_prompt'].includes(entry.kind)
              && activeMemoryIds.has(entry.id);
            const canRestore = snapshotIds.has(entry.snapshots.afterId);
            return (
              <article className="project-memory-entry" key={entry.id}>
                <header>
                  <span className={`project-memory-entry__kind is-${entry.kind}`}>{MEMORY_LABELS[entry.kind]}</span>
                  <time dateTime={entry.createdAt}>{formatMemoryTime(entry.createdAt)}</time>
                </header>
                <h3>{entry.title}</h3>
                <p>{entry.changeSummary}</p>
                <dl>
                  <div><dt>原因</dt><dd>{entry.rationale}</dd></div>
                  <div><dt>下一步</dt><dd>{entry.nextStep}</dd></div>
                </dl>
                <div className="project-memory-entry__actions">
                  <button
                    type="button"
                    aria-label={canRestore ? `恢复 ${entry.title}` : `${entry.title} 快照不可用`}
                    disabled={!canRestore}
                    onClick={() => onRestore(entry.snapshots.afterId)}
                  >
                    <RotateCcw size={14} />{canRestore ? '恢复' : '快照不可用'}
                  </button>
                  <button
                    type="button"
                    aria-label={isPending
                      ? `${entry.title} 已进入 Skill 审批`
                      : isPromotable ? `提升 ${entry.title} 为 Skill` : `${entry.title} 不可提升`}
                    disabled={isPending || !isPromotable}
                    onClick={() => onPromote(entry.id)}
                  >
                    <Brain size={14} />{isPending ? '待审批' : isPromotable ? '提升为 Skill' : '不可提升'}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

function formatMemoryTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value));
}