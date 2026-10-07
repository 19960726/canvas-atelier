import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { ReactFlowProvider } from '@xyflow/react';
import { createCanvasModuleNode } from '@agent-canvas/domain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ModuleNodeCard } from './ModuleNodeCard';
import { replaceProjectPersistenceClientForTests, resetAppStoreForTests, useAppStore } from '../app/app-store';
import { createBrowserPersistenceClient } from '../app/desktop-persistence';

beforeEach(() => {
  delete window.novusDesktop;
  replaceProjectPersistenceClientForTests(createBrowserPersistenceClient());
  resetAppStoreForTests({ project: 'empty' });
});

afterEach(() => { cleanup(); resetAppStoreForTests({ project: 'empty' }); vi.restoreAllMocks(); });

describe('reverse connected media preview order and ownership', () => {
  it('opens and steps through the visible order while its reorder is pending', () => {
    const f = mountReverse();
    fireEvent.click(within(f.tray).getByRole('button', { name: 'Move Reference 3 left' }));
    expect(within(f.tray).getAllByRole('img').map(item => item.getAttribute('alt')))
      .toEqual(['Reference 1', 'Reference 3', 'Reference 2']);
    fireEvent.doubleClick(within(f.tray).getByRole('img', { name: 'Reference 3' }));
    expect(preview()).toHaveAttribute('alt', 'Generated image 2 full preview');
    expect(preview()).toHaveAttribute('src', f.images[2]!.displayUrl);
    fireEvent.keyDown(dialog(), { key: 'ArrowRight' });
    expect(preview()).toHaveAttribute('src', f.images[1]!.displayUrl);
    expect(preview()).toHaveAttribute('alt', 'Generated image 3 full preview');
  });

  it('updates an already-open selection to its new visible position', () => {
    const f = mountReverse();
    fireEvent.doubleClick(within(f.tray).getByRole('img', { name: 'Reference 2' }));
    fireEvent.click(within(f.tray).getByRole('button', { name: 'Move Reference 3 left' }));
    expect(preview()).toHaveAttribute('alt', 'Generated image 3 full preview');
    fireEvent.keyDown(dialog(), { key: 'ArrowLeft' });
    expect(preview()).toHaveAttribute('src', f.images[2]!.displayUrl);
  });

  it('retains the selected asset when a rejected reorder returns to the authoritative order', async () => {
    const f = mountReverse();
    fireEvent.click(within(f.tray).getByRole('button', { name: 'Move Reference 3 left' }));
    fireEvent.doubleClick(within(f.tray).getByRole('img', { name: 'Reference 3' }));
    await act(async () => { f.pending.resolve(false); });
    expect(preview()).toHaveAttribute('src', f.images[2]!.displayUrl);
    expect(preview()).toHaveAttribute('alt', 'Generated image 3 full preview');
    fireEvent.keyDown(dialog(), { key: 'ArrowLeft' });
    expect(preview()).toHaveAttribute('src', f.images[1]!.displayUrl);
  });

  it('closes a same-asset selection when the canvas owner resets', () => {
    const f = mountReverse();
    fireEvent.doubleClick(within(f.tray).getByRole('img', { name: 'Reference 1' }));
    expect(dialog()).toBeVisible();
    act(() => useAppStore.setState(state => ({ canvasDraftResetKey: state.canvasDraftResetKey + 1 })));
    expect(screen.queryByRole('dialog', { name: 'Generated image preview' })).not.toBeInTheDocument();
  });

  it('closes a pending selection when its owned connection is removed', async () => {
    const f = mountReverse();
    fireEvent.click(within(f.tray).getByRole('button', { name: 'Move Reference 3 left' }));
    fireEvent.doubleClick(within(f.tray).getByRole('img', { name: 'Reference 3' }));
    act(() => useAppStore.setState(state => ({ project: { ...state.project,
      edges: state.project.edges.filter(edge => edge.id !== 'edge-2') } })));
    await act(async () => { f.pending.resolve(false); });
    expect(screen.queryByRole('dialog', { name: 'Generated image preview' })).not.toBeInTheDocument();
  });

  it('does not preview a summary without a matching managed asset in the current project', () => {
    const f = mountReverse();
    act(() => useAppStore.setState(state => ({ project: { ...state.project,
      assets: state.project.assets?.filter(asset => asset.assetId !== f.images[1]!.assetId) } })));
    fireEvent.doubleClick(within(f.tray).getByRole('img', { name: 'Reference 2' }));
    expect(screen.queryByRole('dialog', { name: 'Generated image preview' })).not.toBeInTheDocument();
  });

  it('keeps overflow references in the visible preview order without truncating their connections', () => {
    const f = mountReverse(25);
    expect(within(f.tray).getAllByRole('img')).toHaveLength(25);
    fireEvent.click(within(f.tray).getByRole('button', { name: 'Move Reference 25 left' }));
    fireEvent.doubleClick(within(f.tray).getByRole('img', { name: 'Reference 25' }));
    expect(preview()).toHaveAttribute('alt', 'Generated image 24 full preview');
    fireEvent.keyDown(dialog(), { key: 'ArrowRight' });
    expect(preview()).toHaveAttribute('src', f.images[23]!.displayUrl);
    expect(useAppStore.getState().project.edges).toHaveLength(25);
  });
});

function dialog() {
  return screen.getByRole('dialog', { name: 'Generated image preview' });
}

function preview() {
  return within(dialog()).getByRole('img');
}

function mountReverse(count = 3) {
  const images = Array.from({ length: count }, (_, index) => ({
    assetId: (index + 1).toString(16).padStart(16, '0'), sha256: (index + 1).toString(16).padStart(64, '0'),
    byteSize: 42, extension: 'png' as const, mediaType: 'image/png' as const, origin: 'imported' as const,
    width: 800, height: 600, label: `Reference ${index + 1}`,
    displayUrl: `novus-asset://project/reverse/${(index + 1).toString(16).padStart(16, '0')}`, usageCount: 1,
  }));
  const sources = images.map((image, index) => {
    const source = createCanvasModuleNode(`source-${index}`, 'image_input', { x: 0, y: index * 100 });
    source.data.config.assetId = image.assetId;
    return source;
  });
  const target = createCanvasModuleNode('reverse-owner', 'reverse_agent', { x: 500, y: 0 });
  const pending = deferred<boolean>();
  const reorder = vi.fn(() => pending.promise);
  useAppStore.setState(state => ({ project: { ...state.project, nodes: [...sources, target], assets: images,
    edges: sources.map((source, index) => ({ id: `edge-${index}`, source: source.id, sourcePortId: 'image',
      target: target.id, targetPortId: 'references', order: index })) },
    projectImages: images, reorderModuleInput: reorder }));
  render(<ReactFlowProvider><ModuleNodeCard id={target.id} data={target.data} /></ReactFlowProvider>);
  return { images, pending, reorder, tray: screen.getByLabelText('Connected reverse media slots') };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
