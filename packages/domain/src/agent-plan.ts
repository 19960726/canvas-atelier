import { applyTransaction, type CanvasTransaction } from './canvas-transaction';
import type { CanvasProject } from './project-schema';

export type AgentPlanState =
  | 'idle'
  | 'reading_canvas'
  | 'drafting_plan'
  | 'waiting_for_confirmation'
  | 'applying_transaction'
  | 'running_models'
  | 'reviewing_results'
  | 'waiting_for_memory_sync'
  | 'error_needs_user';

export type AgentCapability = 'delete_nodes' | 'skill_writeback' | 'model_execution';

export interface AgentPlanApprovalSelection {
  models: boolean;
  deleteNodes: boolean;
  skillWriteback: boolean;
}

export interface AgentPlanConfirmations {
  canvas?: string;
  deleteNodes?: string;
  skillWriteback?: string;
  models?: string;
}

export interface AgentCanvasPlan {
  id: string;
  state: AgentPlanState;
  transaction: CanvasTransaction;
  requestedCapabilities: AgentCapability[];
  confirmations: AgentPlanConfirmations;
  conflicts: string[];
  modelRoute?: string;
  jobCount: number;
}

export interface AgentPlanValidation {
  canPreview: boolean;
  canApplyTransaction: boolean;
  canExecuteModels: boolean;
  canDeleteNodes: boolean;
  canWritebackSkill: boolean;
  blockedCapabilities: AgentCapability[];
}

export function validateAgentPlan(plan: AgentCanvasPlan): AgentPlanValidation {
  const blockedCapabilities: AgentCapability[] = [];
  const deletesNodes = plan.transaction.operations.some((operation) => operation.kind === 'delete_node' || operation.kind === 'delete_edge');
  const needsDeletionApproval = deletesNodes || plan.requestedCapabilities.includes('delete_nodes');
  const needsSkillApproval = plan.requestedCapabilities.includes('skill_writeback');
  const needsModelApproval = plan.requestedCapabilities.includes('model_execution');

  if (needsDeletionApproval && !plan.confirmations.deleteNodes) blockedCapabilities.push('delete_nodes');
  if (needsSkillApproval && !plan.confirmations.skillWriteback) blockedCapabilities.push('skill_writeback');

  const canDeleteNodes = !needsDeletionApproval || Boolean(plan.confirmations.deleteNodes);
  const canWritebackSkill = !needsSkillApproval || Boolean(plan.confirmations.skillWriteback);
  const canApplyTransaction = plan.state === 'waiting_for_confirmation'
    && Boolean(plan.confirmations.canvas)
    && canDeleteNodes;
  const canExecuteModels = canApplyTransaction
    && needsModelApproval
    && Boolean(plan.confirmations.models);

  return {
    canPreview: plan.state === 'waiting_for_confirmation',
    canApplyTransaction,
    canExecuteModels,
    canDeleteNodes,
    canWritebackSkill,
    blockedCapabilities,
  };
}

export function confirmAgentPlan(project: CanvasProject, plan: AgentCanvasPlan) {
  if (plan.state !== 'waiting_for_confirmation') {
    throw new Error('agent plan must be waiting_for_confirmation');
  }
  const validation = validateAgentPlan(plan);
  if (!validation.canApplyTransaction) {
    throw new Error(`agent plan confirmation is incomplete: ${validation.blockedCapabilities.join(',')}`);
  }

  const applied = applyTransaction(project, plan.transaction);
  return {
    project: applied.project,
    inverse: applied.inverse,
    executeModels: validation.canExecuteModels,
    plan: {
      ...plan,
      state: 'reviewing_results' as const,
    },
  };
}

export function cancelAgentPlan(plan: AgentCanvasPlan): AgentCanvasPlan {
  return { ...plan, state: 'idle', confirmations: {} };
}