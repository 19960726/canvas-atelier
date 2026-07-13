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
            safeAreas: [{ id: 'copy-top', x: 0.08, y: 0.06, w: 0.84, h: 0.16, purpose: 'copy_safe' }],
          },
          objects: [{
            id: 'product-main',
            assetId: 'starter-product',
            role: 'product_identity',
            x: 0.34,
            y: 0.42,
            w: 0.32,
            h: 0.38,
            rotation: 0,
            zIndex: 20,
            locked: false,
            visible: true,
            flipX: false,
            flipY: false,
            semanticLayer: 'hero_product',
            name: '主产品',
          }],
        },
      },
      {
        id: 'prompt-start',
        type: 'prompt',
        position: { x: 800, y: 160 },
        data: { prompt: '等待确认后执行模型任务', requirementIds: [] },
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
  activeTool: 'select' | 'hand' | 'upload' | 'image' | 'prompt' | 'placement';
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
