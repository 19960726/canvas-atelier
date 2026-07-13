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
  const toggle = (key: keyof AgentPlanApprovalSelection) => setApprovals((current) => ({ ...current, [key]: !current[key] }));
  const deletionRequired = plan.requestedCapabilities.includes('delete_nodes') || plan.transaction.operations.some((operation) => operation.kind === 'delete_node' || operation.kind === 'delete_edge');

  useEffect(() => {
    setApprovals({ models: false, deleteNodes: false, skillWriteback: false });
  }, [plan.id]);

  return (
    <section className="plan-preview" aria-label="Agent 方案预览">
      <div className="plan-preview__heading"><span><Check size={15} />待确认方案</span><b>{plan.transaction.operations.length} 项画布变更</b></div>
      <div className="plan-operation-list">
        {plan.transaction.operations.map((operation, index) => <div className="plan-operation" key={`${operation.kind}-${index}`}><Link2 size={13} /><span>{operationLabel(operation)}</span></div>)}
      </div>
      {plan.conflicts.length > 0 && <div className="plan-conflicts"><AlertTriangle size={14} />{plan.conflicts.join('；')}</div>}
      <div className="plan-route"><span>模型路由<b>{plan.modelRoute ?? '未指定'}</b></span><span>任务数量<b>{plan.jobCount} 个模型任务</b></span></div>
      <div className="plan-approval-list">
        {plan.requestedCapabilities.includes('model_execution') && <Approval label="同时确认模型执行" ariaLabel="确认模型执行" checked={approvals.models} onChange={() => toggle('models')} />}
        {deletionRequired && <Approval label="允许删除方案中的节点" ariaLabel="确认删除节点" checked={approvals.deleteNodes} onChange={() => toggle('deleteNodes')} />}
        {plan.requestedCapabilities.includes('skill_writeback') && <Approval label="允许写回 Skill 源目录" ariaLabel="确认 Skill 写回" checked={approvals.skillWriteback} onChange={() => toggle('skillWriteback')} />}
      </div>
      <div className="plan-actions">
        <button type="button" className="plan-cancel" onClick={onCancel}><X size={14} />取消方案</button>
        <button type="button" className="plan-confirm" disabled={deletionRequired && !approvals.deleteNodes} onClick={() => onConfirm(approvals)}><Play size={14} fill="currentColor" />确认执行</button>
      </div>
    </section>
  );
}

function Approval({ label, ariaLabel, checked, onChange }: { label: string; ariaLabel: string; checked: boolean; onChange: () => void }) {
  return <label className="plan-model-confirm"><input type="checkbox" aria-label={ariaLabel} checked={checked} onChange={onChange} /><span>{label}</span></label>;
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