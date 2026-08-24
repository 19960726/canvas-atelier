import { useState, useSyncExternalStore } from 'react';
import { AlertTriangle, Check, GitBranch, Sparkles, X } from 'lucide-react';

import {
  mcpUiConfirmationStore,
  type McpUiConfirmationRequest,
  type McpUiConfirmationStore,
} from '../app/mcp-ui-confirmation-store';

export function McpWorkflowPlanPreview({ store = mcpUiConfirmationStore }: { readonly store?: McpUiConfirmationStore }) {
  const requests = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const [error, setError] = useState<string | null>(null);
  const request = requests[0];
  if (!request) return null;

  const isWorkflow = request.kind === 'workflow';
  const confirmLabel = isWorkflow ? '确认 MCP 工作流' : '确认 MCP 付费任务';
  const dialogLabel = isWorkflow ? 'MCP 工作流确认' : 'MCP 付费任务确认';

  const confirm = () => {
    try {
      store.confirm(request.id);
      setError(null);
    } catch {
      setError('确认请求已经失效，请让客户端重新提交。');
    }
  };
  const reject = () => {
    try {
      store.reject(request.id);
      setError(null);
    } catch {
      setError('请求已经关闭。');
    }
  };

  return <aside className="mcp-workflow-preview" role="dialog" aria-label={dialogLabel} aria-modal="false">
    <header>
      <span>{isWorkflow ? <GitBranch size={16} /> : <Sparkles size={16} />}</span>
      <div><strong>{request.title}</strong><small>{isWorkflow ? 'Codex / WorkBuddy 工作流计划' : '独立付费模型任务'}</small></div>
      <b>{isWorkflow ? '待确认' : '额度操作'}</b>
    </header>

    {isWorkflow ? <WorkflowSummary request={request} /> : <PaidJobSummary request={request} />}

    <p className="mcp-workflow-preview__notice"><AlertTriangle size={13} />确认只授权这一次、这一版本的请求；画布变化后授权自动失效。</p>
    {error && <p className="mcp-workflow-preview__error" role="alert">{error}</p>}
    <footer>
      <button type="button" aria-label="拒绝 MCP 请求" onClick={reject}><X size={14} />拒绝</button>
      <button type="button" className="is-primary" aria-label={confirmLabel} onClick={confirm}><Check size={14} />确认</button>
    </footer>
  </aside>;
}

function WorkflowSummary({ request }: { readonly request: Extract<McpUiConfirmationRequest, { kind: 'workflow' }> }) {
  const mutationKinds = request.mutations.reduce<Record<string, number>>((counts, mutation) => {
    counts[mutation.kind] = (counts[mutation.kind] ?? 0) + 1;
    return counts;
  }, {});
  return <div className="mcp-workflow-preview__body">
    <div className="mcp-workflow-preview__metrics">
      <span><strong>{request.mutations.length}</strong><small>项画布修改</small></span>
      <span><strong>{request.paidJobs.length}</strong><small>个付费任务</small></span>
      <span><strong>r{request.expectedRevision}</strong><small>项目版本</small></span>
    </div>
    <ul aria-label="MCP 工作流修改摘要">
      {Object.entries(mutationKinds).map(([kind, count]) => <li key={kind}><span>{formatMutationKind(kind)}</span><b>{count}</b></li>)}
    </ul>
    {request.paidJobs.length > 0 && <div className="mcp-workflow-preview__paid-list">
      {request.paidJobs.map((job) => <span key={`${job.nodeId}-${job.modelRoute}`}>{job.jobKind} · {job.modelRoute}</span>)}
    </div>}
  </div>;
}

function PaidJobSummary({ request }: { readonly request: Extract<McpUiConfirmationRequest, { kind: 'paid_job' }> }) {
  return <dl className="mcp-workflow-preview__paid">
    <div><dt>任务</dt><dd>{request.jobKind}</dd></div>
    <div><dt>模型</dt><dd>{request.modelRoute}</dd></div>
    <div><dt>节点</dt><dd>{request.nodeId}</dd></div>
    <div><dt>版本</dt><dd>r{request.expectedRevision}</dd></div>
  </dl>;
}

function formatMutationKind(kind: string): string {
  return ({
    create_node: '创建节点',
    update_node: '更新节点',
    connect_nodes: '连接节点',
    move_nodes: '移动节点',
    delete_nodes: '删除节点',
  } as Record<string, string>)[kind] ?? kind;
}