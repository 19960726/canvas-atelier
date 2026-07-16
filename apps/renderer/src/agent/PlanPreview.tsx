import { useEffect, useState } from 'react';
import { AlertTriangle, Check, Link2, Play, X } from 'lucide-react';
import type { AgentCanvasPlan, AgentPlanApprovalSelection, CanvasNode, CanvasOperation } from '@agent-canvas/domain';

interface PlanPreviewProps {
  plan: AgentCanvasPlan;
  onConfirm: (approvals: AgentPlanApprovalSelection) => void;
  onCancel: () => void;
}

export function PlanPreview({ plan, onConfirm, onCancel }: PlanPreviewProps) {
  const [approvals, setApprovals] = useState<AgentPlanApprovalSelection>({ models: false, deleteNodes: false, skillWriteback: false });
  const isProcessing = plan.state === 'confirming' || plan.state === 'committing';
  const toggle = (key: keyof AgentPlanApprovalSelection) => {
    if (isProcessing) return;
    setApprovals((current) => ({ ...current, [key]: !current[key] }));
  };
  const deletionRequired = plan.requestedCapabilities.includes('delete_nodes') || plan.transaction.operations.some((operation) => operation.kind === 'delete_node' || operation.kind === 'delete_edge');

  useEffect(() => {
    setApprovals({ models: false, deleteNodes: false, skillWriteback: false });
  }, [plan.id]);

  return (
    <section className="plan-preview" aria-label="Agent 方案预览" data-testid="plan-preview">
      <div className="plan-preview__heading"><span><Check size={15} />待确认方案</span><b>{plan.transaction.operations.length} 项画布变更</b></div>
      <div className="plan-operation-list">
        {plan.transaction.operations.map((operation, index) => <div className="plan-operation" data-testid="plan-operation" key={`${operation.kind}-${index}`}><Link2 size={13} /><span>{operationLabel(operation)}</span></div>)}
      </div>
      {plan.conflicts.length > 0 && <div className="plan-conflicts"><AlertTriangle size={14} />{plan.conflicts.join('；')}</div>}
      {isProcessing && <div className="plan-processing" data-testid="plan-processing-state" role="status">Processing confirmation</div>}
      <div className="plan-route"><span>模型路由<b data-testid="plan-model-route">{modelRouteLabel(plan)}</b></span><span>任务数量<b>{plan.jobCount} 个模型任务</b></span></div>
      <div className="plan-approval-list">
        {plan.requestedCapabilities.includes('model_execution') && <Approval dataTestId="plan-approve-models" label="同时确认模型执行" ariaLabel="确认模型执行" checked={approvals.models} disabled={isProcessing} onChange={() => toggle('models')} />}
        {deletionRequired && <Approval label="允许删除方案中的节点" ariaLabel="确认删除节点" checked={approvals.deleteNodes} disabled={isProcessing} onChange={() => toggle('deleteNodes')} />}
        {plan.requestedCapabilities.includes('skill_writeback') && <Approval label="允许写回 Skill 源目录" ariaLabel="确认 Skill 写回" checked={approvals.skillWriteback} disabled={isProcessing} onChange={() => toggle('skillWriteback')} />}
      </div>
      <div className="plan-actions">
        <button data-testid="plan-cancel" type="button" className="plan-cancel" disabled={isProcessing} onClick={onCancel}><X size={14} />取消方案</button>
        <button data-testid="plan-confirm" type="button" className="plan-confirm" disabled={isProcessing || (deletionRequired && !approvals.deleteNodes)} onClick={() => onConfirm(approvals)}><Play size={14} fill="currentColor" />确认执行</button>
      </div>
    </section>
  );
}

function Approval({ dataTestId, label, ariaLabel, checked, disabled, onChange }: { dataTestId?: string; label: string; ariaLabel: string; checked: boolean; disabled?: boolean; onChange: () => void }) {
  return <label className="plan-model-confirm"><input data-testid={dataTestId} type="checkbox" aria-label={ariaLabel} checked={checked} disabled={disabled} onChange={onChange} /><span>{label}</span></label>;
}

function modelRouteLabel(plan: AgentCanvasPlan): string {
  return plan.modelRouteDisplayName ?? plan.modelRoute ?? '未指定';
}

function operationLabel(operation: CanvasOperation): string {
  switch (operation.kind) {
    case 'create_node': return `创建${nodeTypeLabel(operation.node.type)}`;
    case 'update_node': return `更新${nodeTypeLabel(operation.node.type)}`;
    case 'delete_node': return '删除画布节点';
    case 'create_edge': return '连接画布节点';
    case 'delete_edge': return '删除节点连接';
  }
}

function nodeTypeLabel(type: CanvasNode['type']): string {
  switch (type) {
    case 'review': return '审核节点';
    case 'prompt': return '提示词节点';
    case 'reference': return '参考节点';
    case 'placement_preview': return '摆放预览';
    case 'model_job': return '模型任务';
    case 'image_result': return '结果节点';
    case 'memory_diff': return '记忆差异';
    case 'agent_plan': return 'Agent 方案';
  }
}
