import { describe, expect, it } from 'vitest';
import {
  initialGenerationEditorState,
  reduceGenerationEditorState,
} from './generation-editor-state';

describe('generation editor state', () => {
  it('opens exactly the requested generation node', () => {
    expect(reduceGenerationEditorState(initialGenerationEditorState, { type: 'open', nodeId: 'video-1' }))
      .toEqual({ expandedNodeId: 'video-1' });
  });

  it.each(['canvas-click', 'escape'] as const)('collapses the active generation editor on %s', (type) => {
    expect(reduceGenerationEditorState({ expandedNodeId: 'image-1' }, { type }))
      .toEqual({ expandedNodeId: null });
  });

  it('collapses only when the expanded node is removed', () => {
    const state = { expandedNodeId: 'image-1' };
    expect(reduceGenerationEditorState(state, { type: 'node-removed', nodeIds: ['other'] })).toBe(state);
    expect(reduceGenerationEditorState(state, { type: 'node-removed', nodeIds: ['image-1'] }))
      .toEqual({ expandedNodeId: null });
  });
});
