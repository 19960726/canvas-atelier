import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { createCanvasModuleNode, type CanvasModuleNode } from '@agent-canvas/domain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { ModuleNodeCard } from './ModuleNodeCard';
import { createBrowserPersistenceClient } from '../app/desktop-persistence';
import { replaceProjectPersistenceClientForTests, resetAppStoreForTests, useAppStore } from '../app/app-store';

beforeEach(() => {
  delete window.novusDesktop;
  replaceProjectPersistenceClientForTests(createBrowserPersistenceClient());
  resetAppStoreForTests({ project: 'empty' });
});
afterEach(() => { cleanup(); resetAppStoreForTests({ project: 'empty' }); vi.restoreAllMocks(); });

const asset = (index: number) => ({
  assetId: index.toString(16).padStart(16, '0'), sha256: index.toString(16).padStart(64, '0'),
  byteSize: 42, extension: 'png' as const, mediaType: 'image/png' as const, origin: 'imported' as const,
  width: 800, height: 600, label: `Reference ${index}`,
  displayUrl: `novus-asset://project/tray/${index.toString(16).padStart(16, '0')}`, usageCount: 1,
});

function mountTray(kind: 'image_generation' | 'video_generation', count = 2, grouped = false) {
  const target = createCanvasModuleNode('tray-target', kind, { x: 700, y: 100 });
  const images = Array.from({ length: count }, (_, index) => asset(index + 1));
  const sources: CanvasModuleNode[] = grouped
    ? [createCanvasModuleNode('source-group', 'canvas_library', { x: 100, y: 100 }),
      createCanvasModuleNode('source-single', 'image_input', { x: 100, y: 500 })]
    : images.map((image, index) => {
      const node = createCanvasModuleNode(`source-${index}`, 'image_input', { x: 100, y: index * 120 });
      node.data.config.assetId = image.assetId;
      return node;
    });
  if (grouped) {
    sources[0]!.data.config.assetIds = images.slice(0, -1).map(image => image.assetId);
    sources[1]!.data.config.assetId = images[images.length - 1]!.assetId;
  }
  const port = kind === 'image_generation' ? 'references' : 'media';
  const edges = sources.map((source, index) => ({ id: `edge-${index}`, source: source.id,
    sourcePortId: source.data.moduleType === 'canvas_library' ? 'images' : 'image',
    target: target.id, targetPortId: port, order: index }));
  const reorder = vi.fn(async () => true);
  useAppStore.setState(state => ({ project: { ...state.project, nodes: [...sources, target], edges,
    assets: images.map(({ displayUrl: _url, usageCount: _count, ...image }) => image) },
    projectImages: images, reorderModuleInput: reorder }));
  const view = render(<ReactFlowProvider><ModuleNodeCard id={target.id} data={target.data} /></ReactFlowProvider>);
  fireEvent.click(screen.getByRole('button', { name: kind === 'image_generation'
    ? 'Open image generation editor' : 'Open video generation editor' }));
  const tray = screen.getByLabelText(kind === 'image_generation' ? 'Image generation reference slots' : 'Connected video media editor');
  return { tray, images, target, view, reorder, port };
}

describe('generation reference tray interactions', () => {
  it.each(['image_generation', 'video_generation'] as const)
  ('opens the selected owned image from %s references and closes when detached', kind => {
    const f = mountTray(kind);
    fireEvent.doubleClick(within(f.tray).getByRole('img', { name: 'Reference 2' }));
    expect(screen.getByRole('dialog', { name: 'Generated image preview' })).toBeVisible();
    expect(within(screen.getByRole('dialog', { name: 'Generated image preview' })).getByRole('img', { name: 'Generated image 2 full preview' }))
      .toHaveAttribute('src', f.images[1]!.displayUrl);
    act(() => useAppStore.setState(state => ({ project: { ...state.project,
      edges: state.project.edges.filter(edge => edge.id !== 'edge-1') } })));
    expect(screen.queryByRole('dialog', { name: 'Generated image preview' })).not.toBeInTheDocument();
  });

  it.each(['image_generation', 'video_generation'] as const)
  ('closes the %s reference preview across a project reset even if the asset remains', kind => {
    const f = mountTray(kind);
    fireEvent.doubleClick(within(f.tray).getByRole('img', { name: 'Reference 1' }));
    expect(screen.getByRole('dialog', { name: 'Generated image preview' })).toBeVisible();
    act(() => useAppStore.setState(state => ({ canvasDraftResetKey: state.canvasDraftResetKey + 1 })));
    expect(screen.queryByRole('dialog', { name: 'Generated image preview' })).not.toBeInTheDocument();
  });

  it.each(['image_generation', 'video_generation'] as const)
  ('navigates the current visible order while a %s reference reorder awaits saving', kind => {
    const f = mountTray(kind, 3);
    f.reorder.mockImplementationOnce(() => new Promise<boolean>(() => {}));
    fireEvent.click(within(f.tray).getByRole('button', { name: 'Move Reference 3 left' }));
    expect(within(f.tray).getAllByRole('img').map(image => image.getAttribute('alt')))
      .toEqual(['Reference 1', 'Reference 3', 'Reference 2']);
    fireEvent.doubleClick(within(f.tray).getByRole('img', { name: 'Reference 3' }));
    const dialog = screen.getByRole('dialog', { name: 'Generated image preview' });
    expect(within(dialog).getByRole('img', { name: 'Generated image 2 full preview' }))
      .toHaveAttribute('src', f.images[2]!.displayUrl);
    fireEvent.keyDown(dialog, { key: 'ArrowRight' });
    expect(within(dialog).getByRole('img', { name: 'Generated image 3 full preview' }))
      .toHaveAttribute('src', f.images[1]!.displayUrl);
  });

  it.each(['image_generation', 'video_generation'] as const)
  ('keeps the twenty-reference limit and preserves overflow edges while reordering %s', kind => {
    const f = mountTray(kind, 25);
    expect(within(f.tray).getAllByRole('img')).toHaveLength(20);
    expect(f.tray).toHaveTextContent('20 / 20');
    fireEvent.click(within(f.tray).getByRole('button', { name: 'Move Reference 20 left' }));
    expect(f.reorder).toHaveBeenCalledWith(f.target.id, f.port,
      [...Array.from({ length: 18 }, (_, index) => `edge-${index}`), 'edge-19', 'edge-18',
        ...Array.from({ length: 5 }, (_, index) => `edge-${index + 20}`)]);
    expect(useAppStore.getState().project.edges).toHaveLength(25);
  });

  it.each(['image_generation', 'video_generation'] as const)
  ('persists a shared library group move once per edge for %s', kind => {
    const f = mountTray(kind, 3, true);
    expect(within(f.tray).getAllByRole('img')).toHaveLength(3);
    fireEvent.click(within(f.tray).getByRole('button', { name: 'Move Reference 3 left' }));
    expect(f.reorder).toHaveBeenCalledWith(f.target.id, f.port, ['edge-1', 'edge-0']);
    expect(within(f.tray).getAllByRole('img').map(image => image.getAttribute('alt')))
      .toEqual(['Reference 3', 'Reference 1', 'Reference 2']);
  });
});
