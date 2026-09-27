import { describe, expect, it } from 'vitest';
import { createCanvasModuleNode } from '@agent-canvas/domain';
import { restoreLayeringDraft } from './layering-draft';

describe('saved layering analysis', () => {
  it('rejects corrupt saved plans and malformed fallback layer records without crashing', () => {
    const draft = { sourceAssetId: 'source', plan: { sourceAssetId: 'source', layers: [null] }, analysisRoute: '', generationRoute: '',
      resolution: '4K', layerCountMode: 'auto', targetLayerCount: 5, selection: { mode: 'whole' }, step: 'edit', createdGroupId: null, started: false };
    expect(restoreLayeringDraft('source', { layeringDrafts: { source: draft } }, [])).toBeNull();
    const group = createCanvasModuleNode('group', 'image_layering', { x: 0, y: 0 });
    group.data.config = { sourceAssetId: 'source', canvasWidth: 2, canvasHeight: 2, planLayers: [null] };
    expect(restoreLayeringDraft('source', {}, [group])).toBeNull();
  });
  it('recovers descriptions and submitted status from an existing group without another analysis request', () => {
    const group = createCanvasModuleNode('group', 'image_layering', { x: 0, y: 0 });
    group.data.config = { sourceAssetId: 'source', canvasWidth: 2480, canvasHeight: 3312, groupId: 'saved-group', status: 'queued', planLayers: [
      { layerId: 'background', kind: 'background', name: '厨房', description: '补全台面', order: 0 },
      { layerId: 'fruit', kind: 'transparent', name: '水果', description: '右侧水果，不含投影', order: 1 },
    ] };
    const restored = restoreLayeringDraft('source', {}, [group]);
    expect(restored?.plan?.layers[1]).toMatchObject({ description: '右侧水果，不含投影', included: true });
    expect(restored).toMatchObject({ createdGroupId: 'saved-group', started: true, step: 'edit' });
    expect(restoreLayeringDraft('another-source', {}, [group])).toBeNull();
  });
});
