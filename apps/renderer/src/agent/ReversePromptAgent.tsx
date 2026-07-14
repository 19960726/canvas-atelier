import { useMemo, useRef, useState, type ReactNode } from 'react';
import { MoreHorizontal, Pencil, Sparkles } from 'lucide-react';
import {
  DEFAULT_REVERSE_PROMPT_PERSONA,
  REVERSE_PROMPT_PERSONAS,
  createReversePromptRun,
  parseReversePromptResult,
  type ApprovedMemorySnapshot,
  type ReversePromptPersona,
  type ReversePromptResult,
  type ReversePromptRun,
} from '@agent-canvas/domain';

interface ReversePromptAgentProps {
  projectId: string;
  referenceAssetIds: string[];
  getApprovedMemorySnapshot: () => ApprovedMemorySnapshot;
  getProjectMemoryIds?: () => string[];
  analyze: (run: ReversePromptRun) => Promise<ReversePromptResult>;
  analysisMode?: 'provider' | 'local_draft';
  onEditSkill?: () => void;
  onMoreSkill?: () => void;
}

interface RunHistoryEntry {
  run: ReversePromptRun;
  result: ReversePromptResult;
}

export function ReversePromptAgent({
  projectId,
  referenceAssetIds,
  getApprovedMemorySnapshot,
  getProjectMemoryIds = () => [],
  analyze,
  analysisMode = 'provider',
  onEditSkill,
  onMoreSkill,
}: ReversePromptAgentProps) {
  const [personaId, setPersonaId] = useState<ReversePromptPersona['id']>(DEFAULT_REVERSE_PROMPT_PERSONA.id);
  const [history, setHistory] = useState<RunHistoryEntry[]>([]);
  const [status, setStatus] = useState<'idle' | 'running'>('idle');
  const [error, setError] = useState<string | null>(null);
  const runningRef = useRef(false);
  const persona = useMemo(
    () => REVERSE_PROMPT_PERSONAS.find((item) => item.id === personaId) ?? DEFAULT_REVERSE_PROMPT_PERSONA,
    [personaId],
  );

  const startAnalysis = async () => {
    if (runningRef.current || referenceAssetIds.length === 0) return;
    runningRef.current = true;
    setStatus('running');
    setError(null);
    try {
      const approvedMemorySnapshot = getApprovedMemorySnapshot();
      const run = createReversePromptRun({
        projectId,
        skill: { id: 'scene-skill', version: 'managed-latest' },
        persona,
        approvedMemorySnapshot,
        projectMemoryIds: getProjectMemoryIds(),
        referenceAssetIds,
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

  return (
    <section className="reverse-agent" aria-label="反推 Agent">
      <header className="reverse-agent__header">
        <div className="reverse-agent__skill">
          <span>场景 Skill</span>
          <strong>场景生成 Skill</strong>
        </div>
        <div className="reverse-agent__tools">
          <button type="button" aria-label="编辑 Skill" title="编辑 Skill" disabled={!onEditSkill} onClick={onEditSkill}><Pencil size={14} /></button>
          <button type="button" aria-label="更多操作" title="更多操作" disabled={!onMoreSkill} onClick={onMoreSkill}><MoreHorizontal size={15} /></button>
        </div>
      </header>

      <label className="reverse-agent__persona">反推角色
        <select aria-label="反推角色" value={personaId} onChange={(event) => setPersonaId(event.target.value as ReversePromptPersona['id'])}>
          {REVERSE_PROMPT_PERSONAS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
        </select>
      </label>

      <div className="reverse-agent__context">
        <span>参考图 <b>{referenceAssetIds.length} / 20</b></span>
        <span>知识快照 <b>运行时读取</b></span>
      </div>
      {analysisMode === 'local_draft' && <p className="reverse-agent__mode">本地草稿，未调用模型</p>}

      <button className="reverse-agent__run" type="button" disabled={status === 'running' || referenceAssetIds.length === 0} onClick={startAnalysis}>
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