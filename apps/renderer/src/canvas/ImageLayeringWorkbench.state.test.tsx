import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, expect, it } from 'vitest';
import { createCanvasModuleNode } from '@agent-canvas/domain';
import { ImageLayeringWorkbench } from './ImageLayeringWorkbench';
afterEach(cleanup);

it('invalidates saved composition records when a child is removed or replaced', () => {
  const records = ['background', 'subject'].map((layerId, i) => ({ layerId, kind: i ? 'transparent' : 'background',
    name: layerId, assetId: layerId, x: 0, y: 0, width: 2, height: 2, visible: true, opacity: 1 }));
  const nodes = records.map((record, order) => {
    const node = createCanvasModuleNode(record.layerId, 'image_layer', { x: 0, y: 0 });
    node.data.config = { layerId: record.layerId, resultAssetId: record.assetId, qualityStatus: 'passed', order, visible: true };
    return node;
  });
  const assets = [...records.map(r => r.assetId), 'replacement'].map(assetId => ({ assetId, mediaType: 'image/png' as const, displayUrl: `${assetId}-url` }));
  const props = { config: { canvasWidth: 2, canvasHeight: 2, planLayers: records, layers: records }, assets, onLayersChange: () => {} };
  const view = render(<ImageLayeringWorkbench {...props} layerNodes={nodes} />);
  expect(screen.getByRole('button', { name: '导出 PSD' })).toBeEnabled();
  view.rerender(<ImageLayeringWorkbench {...props} layerNodes={nodes.slice(0, 1)} />);
  expect(screen.getByRole('button', { name: '导出 PSD' })).toBeDisabled();
  expect(screen.queryByRole('img', { name: '合成预览图层 subject' })).not.toBeInTheDocument();
  const pending = { ...nodes[1]!, data: { ...nodes[1]!.data, config: { ...nodes[1]!.data.config, qualityStatus: 'pending' } } };
  view.rerender(<ImageLayeringWorkbench {...props} layerNodes={[nodes[0]!, pending]} />);
  expect(screen.getByRole('button', { name: '导出 PSD' })).toBeDisabled();
  const replaced = { ...pending, data: { ...pending.data, config: { ...pending.data.config, qualityStatus: 'passed', resultAssetId: 'replacement' } } };
  view.rerender(<ImageLayeringWorkbench {...props} layerNodes={[nodes[0]!, replaced]} />);
  expect(screen.getByRole('img', { name: '合成预览图层 subject' })).toHaveAttribute('src', 'replacement-url');
});
