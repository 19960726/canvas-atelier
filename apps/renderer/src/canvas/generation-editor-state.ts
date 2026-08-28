export interface GenerationEditorState {
  readonly expandedNodeId: string | null;
}

export type GenerationEditorAction =
  | { readonly type: 'open'; readonly nodeId: string }
  | { readonly type: 'canvas-click' }
  | { readonly type: 'escape' }
  | { readonly type: 'generation-completed'; readonly nodeId: string }
  | { readonly type: 'node-removed'; readonly nodeIds: readonly string[] };

export const initialGenerationEditorState: GenerationEditorState = {
  expandedNodeId: null,
};

export function reduceGenerationEditorState(
  state: GenerationEditorState,
  action: GenerationEditorAction,
): GenerationEditorState {
  if (action.type === 'open') {
    return state.expandedNodeId === action.nodeId ? state : { expandedNodeId: action.nodeId };
  }
  if (action.type === 'node-removed') {
    return state.expandedNodeId !== null && action.nodeIds.includes(state.expandedNodeId)
      ? initialGenerationEditorState
      : state;
  }
  if (action.type === 'generation-completed') {
    return state.expandedNodeId === action.nodeId ? initialGenerationEditorState : state;
  }
  return state.expandedNodeId === null ? state : initialGenerationEditorState;
}
