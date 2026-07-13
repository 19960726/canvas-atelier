import { create } from 'zustand';
import { confirmAgentPlan as confirmDomainPlan, revertTransaction, type AgentCanvasPlan, type AgentPlanApprovalSelection, type CanvasProject, type CanvasTransaction } from '@agent-canvas/domain';

let planSequence = 0;

export function createStarterProject(): CanvasProject {
  return {
    version: 1, id: 'local-project', name: '未命名画布',
    nodes: [
      { id: 'reference-start', type: 'reference', position: { x: 120, y: 160 }, data: { assetId: 'starter-product', role: 'product_identity' } },
      { id: 'placement-start', type: 'placement_preview', position: { x: 460, y: 270 }, data: {
        board: { id: 'starter-board', aspectRatio: '4:5', width: 1080, height: 1350, safeAreas: [{ id: 'copy-top', x: 0.08, y: 0.06, w: 0.84, h: 0.16, purpose: 'copy_safe' }] },
        objects: [{ id: 'product-main', assetId: 'starter-product', role: 'product_identity', x: 0.34, y: 0.42, w: 0.32, h: 0.38, rotation: 0, zIndex: 20, locked: false, visible: true, flipX: false, flipY: false, semanticLayer: 'hero_product', name: '主产品' }],
      } },
      { id: 'prompt-start', type: 'prompt', position: { x: 800, y: 160 }, data: { prompt: '等待确认后执行模型任务', requirementIds: [] } },
    ],
    edges: [
      { id: 'edge-reference-placement', source: 'reference-start', target: 'placement-start' },
      { id: 'edge-placement-prompt', source: 'placement-start', target: 'prompt-start', label: 'agent-plan' },
    ],
  };
}

interface AppState {
  project: CanvasProject;
  agentPanelCollapsed: boolean;
  activeTool: 'select' | 'hand' | 'upload' | 'image' | 'prompt' | 'placement';
  agentPlan: AgentCanvasPlan | null;
  undoStack: CanvasTransaction[];
  confirmedModelJobs: number;
  setActiveTool: (tool: AppState['activeTool']) => void;
  toggleAgentPanel: () => void;
  setProject: (project: CanvasProject) => void;
  draftAgentPlan: (message: string) => void;
  confirmAgentPlan: (approvals: AgentPlanApprovalSelection) => void;
  cancelAgentPlan: () => void;
  undo: () => void;
}

export const useAppStore = create<AppState>((set) => ({
  project: createStarterProject(), agentPanelCollapsed: false, activeTool: 'select', agentPlan: null, undoStack: [], confirmedModelJobs: 0,
  setActiveTool: (activeTool) => set({ activeTool }),
  toggleAgentPanel: () => set((state) => ({ agentPanelCollapsed: !state.agentPanelCollapsed })),
  setProject: (project) => set({ project }),
  draftAgentPlan: (message) => set((state) => {
    const promptNode = state.project.nodes.find((node) => node.type === 'prompt');
    if (!promptNode || promptNode.type !== 'prompt' || message.trim().length === 0) return state;
    const suffix = `${Date.now()}-${planSequence++}`;
    const reviewId = `agent-review-${suffix}`;
    return { agentPlan: {
      id: `agent-plan-${suffix}`, state: 'waiting_for_confirmation',
      transaction: { id: `agent-tx-${suffix}`, label: 'Agent 创建画布方案', operations: [
        { kind: 'update_node', node: { ...promptNode, data: { ...promptNode.data, prompt: message.trim() } } },
        { kind: 'create_node', node: { id: reviewId, type: 'review', position: { x: promptNode.position.x + 320, y: promptNode.position.y + 80 }, data: { keep: ['产品身份与 Logo'], change: ['场景、光线与道具'], never: ['未经确认执行模型'] } } },
        { kind: 'create_edge', edge: { id: `agent-edge-${suffix}`, source: promptNode.id, target: reviewId } },
      ] },
      requestedCapabilities: ['model_execution'], confirmations: {}, conflicts: [], modelRoute: 'Comfly 图像生成', jobCount: 1,
    } };
  }),
  confirmAgentPlan: (approvals) => set((state) => {
    if (!state.agentPlan) return state;
    const now = new Date().toISOString();
    const result = confirmDomainPlan(state.project, { ...state.agentPlan, confirmations: { ...state.agentPlan.confirmations, canvas: now, models: approvals.models ? now : undefined, deleteNodes: approvals.deleteNodes ? now : undefined, skillWriteback: approvals.skillWriteback ? now : undefined } });
    return { project: result.project, agentPlan: result.plan, undoStack: [...state.undoStack, result.inverse], confirmedModelJobs: state.confirmedModelJobs + (result.executeModels ? state.agentPlan.jobCount : 0) };
  }),
  cancelAgentPlan: () => set({ agentPlan: null }),
  undo: () => set((state) => {
    const inverse = state.undoStack[state.undoStack.length - 1];
    return inverse ? { project: revertTransaction(state.project, inverse), undoStack: state.undoStack.slice(0, -1), agentPlan: null } : state;
  }),
}));