import { create } from 'zustand';
import type { CanvasProject } from '@agent-canvas/domain';

const initialProject: CanvasProject = {
  version: 1,
  id: 'local-project',
  name: '未命名画布',
  nodes: [],
  edges: [],
};

interface AppState {
  project: CanvasProject;
  agentPanelCollapsed: boolean;
  activeTool: 'select' | 'hand' | 'upload' | 'image' | 'prompt';
  setActiveTool: (tool: AppState['activeTool']) => void;
  toggleAgentPanel: () => void;
  setProject: (project: CanvasProject) => void;
}

export const useAppStore = create<AppState>((set) => ({
  project: initialProject,
  agentPanelCollapsed: false,
  activeTool: 'select',
  setActiveTool: (activeTool) => set({ activeTool }),
  toggleAgentPanel: () => set((state) => ({ agentPanelCollapsed: !state.agentPanelCollapsed })),
  setProject: (project) => set({ project }),
}));
