export interface McpCanvasSelection {
  readonly nodeIds: readonly string[];
  readonly edgeIds: readonly string[];
}

let currentSelection: McpCanvasSelection = { nodeIds: [], edgeIds: [] };

export function getMcpCanvasSelection(): McpCanvasSelection {
  return { nodeIds: [...currentSelection.nodeIds], edgeIds: [...currentSelection.edgeIds] };
}

export function setMcpCanvasSelection(selection: McpCanvasSelection): void {
  currentSelection = { nodeIds: [...selection.nodeIds], edgeIds: [...selection.edgeIds] };
}

export function resetMcpCanvasSelection(): void {
  currentSelection = { nodeIds: [], edgeIds: [] };
}