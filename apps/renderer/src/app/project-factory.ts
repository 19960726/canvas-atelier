import type { CanvasProject } from '@agent-canvas/domain';

let untitledSequence = 0;

export function createUntitledProject(): CanvasProject {
  untitledSequence += 1;
  const randomPart = Math.random().toString(36).slice(2, 10).padEnd(8, '0');
  return {
    version: 1,
    graphVersion: 2,
    id: `untitled-${Date.now().toString(36)}-${untitledSequence.toString(36)}-${randomPart}`,
    name: '未命名画布',
    nodes: [],
    edges: [],
    projectMemory: [],
    skillPromotionCandidates: [],
  };
}
