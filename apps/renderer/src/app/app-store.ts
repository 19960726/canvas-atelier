import { create } from 'zustand';
import type { CanvasProject } from '@agent-canvas/domain';

export function createStarterProject(): CanvasProject {
  return {
    version: 1,
    id: 'local-project',
    name: '未命名画布',
    nodes: [
      {
        id: 'reference-start',
        type: 'reference',
        position: { x: 120, y: 160 },
        data: { assetId: 'starter-product', role: 'product_identity' },
      },
      {
        id: 'placement-start',
        type: 'placement_preview',
        position: { x: 460, y: 270 },
        data: {
          board: {
            id: 'starter-board',
            aspectRatio: '4:5',
            width: 1080,
            height: 1350,
            safeAreas: [],
          },
          objects: [],
        },
      },
      {
        id: 'prompt-start',
        type: 'prompt',
        position: { x: 800, y: 160 },
        data: {
          prompt: '等待确认后执行模型任务',
          requirementIds: [],
        },
      },
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
  activeTool: 'select' | 'hand' | 'upload' | 'image' | 'prompt';
  setActiveTool: (tool: AppState['activeTool']) => void;
  toggleAgentPanel: () => void;
  setProject: (project: CanvasProject) => void;
}

export const useAppStore = create<AppState>((set) => ({
  project: createStarterProject(),
  agentPanelCollapsed: false,
  activeTool: 'select',
  setActiveTool: (activeTool) => set({ activeTool }),
  toggleAgentPanel: () => set((state) => ({ agentPanelCollapsed: !state.agentPanelCollapsed })),
  setProject: (project) => set({ project }),
}));
