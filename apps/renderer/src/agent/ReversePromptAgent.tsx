import { useMemo, useRef, useState, type ReactNode } from 'react';
import { MoreHorizontal, Pencil, Sparkles } from 'lucide-react';
import {
  DEFAULT_REVERSE_PROMPT_PERSONA,
  REVERSE_PROMPT_PERSONAS,
  createAgentKnowledgeLease,
  createReversePromptRun,
  parseReversePromptResult,
  type ApprovedMemorySnapshot,
  type FeedbackObservations,
  type ImageCitation,
  type OrderedReference,
  type ReversePromptPersona,
  type ReversePromptResult,
  type ReversePromptRun,
} from '@agent-canvas/domain';
import type { KnowledgeSyncStatusSummary } from '@agent-canvas/desktop-core';
import type { KnowledgeBaseStateSummary } from '@agent-canvas/skill-store';
import type { KnowledgeClient } from '../app/knowledge-client';
import { KnowledgeStatus } from './KnowledgeStatus';

interface ReversePromptAgentProps {
  projectId: string;
  references: OrderedReference[];
  citations: ImageCitation[];
  getApprovedMemorySnapshot: () => ApprovedMemorySnapshot;
  getProjectMemoryIds?: () => string[];
  getKnowledgeLease?: KnowledgeClient['getLease'];
  knowledgeBases?: KnowledgeBaseStateSummary[];
  knowledgeSyncStatuses?: KnowledgeSyncStatusSummary[];
  pendingKnowledgeReviewCount?: number;
  analyze: (run: ReversePromptRun) => Promise<ReversePromptResult>;
  analysisMode?: 'provider' | 'local_draft';
  onEditSkill?: () => void;
  onFeedback?: (input: ReversePromptFeedbackInput) => Promise<boolean>;
  onMoreSkill?: () => void;
}

interface RunHistoryEntry {
  run: ReversePromptRun;
  result: ReversePromptResult;
}

interface ReversePromptFeedbackInput {
  title: string;
  userRequest: string;
  correction: string;
  knowledgeLease: ReversePromptRun['knowledgeLease'];
  references: OrderedReference[];
  citations: ImageCitation[];
  observations?: FeedbackObservations;
  feedback: {
    keep: string[];
    change: string[];
    never: string[];
    score?: number;
  };
}

export function ReversePromptAgent({
  projectId,
  references,
  citations,
  getApprovedMemorySnapshot,
  getProjectMemoryIds = () => [],
  getKnowledgeLease = createFallbackKnowledgeLease,
  knowledgeBases = [],
  knowledgeSyncStatuses = [],
  pendingKnowledgeReviewCount = 0,
  analyze,
  analysisMode = 'provider',
  onEditSkill,
  onFeedback,
  onMoreSkill,
}: ReversePromptAgentProps) {
  const [personaId, setPersonaId] = useState<ReversePromptPersona['id']>(DEFAULT_REVERSE_PROMPT_PERSONA.id);
  const [history, setHistory] = useState<RunHistoryEntry[]>([]);
  const [feedbackDrafts, setFeedbackDrafts] = useState<Record<string, string>>({});
  const [savedFeedbackIds, setSavedFeedbackIds] = useState<Set<string>>(() => new Set());
  const [status, setStatus] = useState<'idle' | 'running'>('idle');
  const [error, setError] = useState<string | null>(null);
  const runningRef = useRef(false);
  const persona = useMemo(
    () => REVERSE_PROMPT_PERSONAS.find((item) => item.id === personaId) ?? DEFAULT_REVERSE_PROMPT_PERSONA,
    [personaId],
  );

  const startAnalysis = async () => {
    if (runningRef.current || references.length === 0) return;
    runningRef.current = true;
    setStatus('running');
    setError(null);
    try {
      const approvedMemorySnapshot = getApprovedMemorySnapshot();
      const runId = createClientUniqueValue();
      const knowledgeLease = getKnowledgeLease(runId, 'reverse_prompt', references, citations);
      const run = createReversePromptRun({
        projectId,
        skill: { id: 'scene-skill', version: 'managed-latest' },
        persona,
        knowledgeLease,
        approvedMemorySnapshot,
        projectMemoryIds: getProjectMemoryIds(),
        references,
      });
      const result = parseReversePromptResult(await analyze(run), run);
      setHistory((current) => [{ run, result }, ...current]);
    } catch (analysisError) {
      setError(analysisError instanceof Error ? analysisError.message : '反推失败，请重试');
    } finally {
      runningRef.current = false;
      setStatus('idle');
    }
  };

  const saveFeedback = async (entry: RunHistoryEntry) => {
    if (!onFeedback) return;
    const correction = feedbackDrafts[entry.run.sessionId]?.trim() ?? '';
    if (correction.length === 0) return;
    const saved = await onFeedback({
      title: 'Reverse prompt feedback',
      userRequest: entry.result.positivePrompt,
      correction,
      knowledgeLease: entry.run.knowledgeLease,
      references: entry.run.references.map((reference) => ({ ...reference })),
      citations: entry.run.knowledgeLease.citations.map((citation) => ({ ...citation })),
      feedback: {
        keep: [],
        change: [correction],
        never: [],
      },
    });
    if (!saved) return;
    setSavedFeedbackIds((current) => new Set([...current, entry.run.sessionId]));
  };

  return (
    <section className="reverse-agent" aria-label="反推 Agent">
      <header className="reverse-agent__header reverse-agent__skill-controls">
        <div className="reverse-agent__skill">
          <span>场景 Skill</span>
          <strong>场景生成 Skill</strong>
        </div>
        <div className="reverse-agent__tools">
          <button type="button" aria-label="编辑 Skill" title="编辑 Skill" disabled={!onEditSkill} onClick={onEditSkill}><Pencil size={14} /></button>
          <button type="button" aria-label="更多操作" title="更多操作" disabled={!onMoreSkill} onClick={onMoreSkill}><MoreHorizontal size={15} /></button>
        </div>
      </header>

      <label className="reverse-agent__persona reverse-agent__persona-control">反推角色
        <select aria-label="反推角色" value={personaId} onChange={(event) => setPersonaId(event.target.value as ReversePromptPersona['id'])}>
          {REVERSE_PROMPT_PERSONAS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
        </select>
      </label>

      <div className="reverse-agent__context reverse-agent__context-metrics">
        <span>参考图 <b>{references.length} / 20</b></span>
        <span>知识快照 <b>运行时读取</b></span>
      </div>
      <div className="reverse-agent__knowledge">
        <KnowledgeStatus
          knowledgeBases={knowledgeBases}
          pendingReviewCount={pendingKnowledgeReviewCount}
          syncStatuses={knowledgeSyncStatuses}
          pinnedLease={history[0]?.run.knowledgeLease ?? null}
        />
      </div>
      {analysisMode === 'local_draft' && <p className="reverse-agent__mode">本地草稿，未调用模型</p>}

      <button className="reverse-agent__run reverse-agent__run-action" type="button" disabled={status === 'running' || references.length === 0} onClick={startAnalysis}>
        <Sparkles size={15} />{status === 'running' ? '正在反推…' : '开始反推'}
      </button>
      {error && <p className="reverse-agent__error" role="alert">{error}</p>}

      {history.length > 0 && (
        <div className="reverse-agent__history" aria-label="反推历史">
          {history.map(({ run, result }) => (
            <article key={run.sessionId} className="reverse-result">
              <header><span>本次新生成</span><code>{run.sessionId.slice(0, 8)}</code></header>
              <ResultSection title="分析"><p>{result.analysis}</p></ResultSection>
              <ResultSection title="新关键词"><div className="reverse-keywords">{result.keywords.map((keyword) => <span key={keyword}>{keyword}</span>)}</div></ResultSection>
              <ResultSection title="反推正向提示词"><p>{result.positivePrompt}</p></ResultSection>
              <ResultSection title="负面约束"><ul>{result.negativeConstraints.map((item) => <li key={item}>{item}</li>)}</ul></ResultSection>
              <ResultSection title="执行检查清单"><ul>{result.executionChecklist.map((item) => <li key={item}>{item}</li>)}</ul></ResultSection>
              <footer>知识快照 <b>{result.knowledgeSnapshotVersion}</b> · nonce {run.nonce.slice(0, 8)}</footer>
              {onFeedback && (
                <div className="reverse-result__feedback">
                  <label>
                    <span>Feedback</span>
                    <textarea
                      aria-label={`Feedback for ${run.sessionId}`}
                      rows={2}
                      value={feedbackDrafts[run.sessionId] ?? ''}
                      onChange={(event) => setFeedbackDrafts((current) => ({
                        ...current,
                        [run.sessionId]: event.target.value,
                      }))}
                    />
                  </label>
                  <button
                    type="button"
                    aria-label={`Save feedback for ${run.sessionId}`}
                    disabled={(feedbackDrafts[run.sessionId]?.trim().length ?? 0) === 0 || savedFeedbackIds.has(run.sessionId)}
                    onClick={() => void saveFeedback({ run, result })}
                  >
                    Save feedback
                  </button>
                  {savedFeedbackIds.has(run.sessionId) && <span>Feedback saved</span>}
                </div>
              )}
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function ResultSection({ title, children }: { title: string; children: ReactNode }) {
  return <section className="reverse-result__section"><h3>{title}</h3>{children}</section>;
}

function createFallbackKnowledgeLease(
  runId: string,
  capability: 'reverse_prompt',
  references: OrderedReference[],
  citations: ImageCitation[],
) {
  return createAgentKnowledgeLease({
    runId,
    capability,
    snapshots: [],
    references,
    citations,
  }, {
    leaseId: createClientUniqueValue(),
    createdAt: new Date().toISOString(),
  });
}

function createClientUniqueValue(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}
