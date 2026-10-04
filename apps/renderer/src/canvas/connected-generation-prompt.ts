import type { CanvasProject } from '@agent-canvas/domain';

export type ConnectedGenerationPrompt =
  | { readonly status: 'disconnected' }
  | { readonly status: 'invalid' }
  | { readonly status: 'connected'; readonly sourceNodeId: string; readonly prompt: string };

/** An explicit prompt connection is authoritative, including an empty source. */
export function resolveConnectedGenerationPrompt(project: CanvasProject, nodeId: string): ConnectedGenerationPrompt {
  const incoming = project.edges.filter(edge => edge.target === nodeId && edge.targetPortId === 'prompt');
  if (incoming.length === 0) return { status: 'disconnected' };
  if (incoming.length !== 1) return { status: 'invalid' };
  const edge = incoming[0]!;
  const source = project.nodes.find(node => node.id === edge.source);
  if (edge.sourcePortId !== 'prompt' || source?.type !== 'module' || source.data.moduleType !== 'text_prompt'
    || typeof source.data.config.prompt !== 'string') return { status: 'invalid' };
  return { status: 'connected', sourceNodeId: source.id, prompt: source.data.config.prompt };
}
