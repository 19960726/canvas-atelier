import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectedAgentMediaSlots, type ConnectedAgentMediaSlotItem } from './ConnectedAgentMediaSlots';
import { ReactFlowProvider } from '@xyflow/react';
import { createCanvasModuleNode } from '@agent-canvas/domain';
import { ModuleNodeCard } from './ModuleNodeCard';
import { replaceProjectPersistenceClientForTests, resetAppStoreForTests, useAppStore } from '../app/app-store';
import { createBrowserPersistenceClient } from '../app/desktop-persistence';

afterEach(() => { cleanup(); resetAppStoreForTests({ project: 'empty' }); vi.restoreAllMocks(); });

const media: ConnectedAgentMediaSlotItem[] = [
  { edgeId: 'edge-A', kind: 'image', assetId: 'asset-A', label: 'A' },
  { edgeId: 'edge-B', kind: 'image', assetId: 'asset-B', label: 'B' },
  { edgeId: 'edge-C', kind: 'image', assetId: 'asset-C', label: 'C' },
];

function slot(index: number) {
  return screen.getByLabelText(`Agent media slot ${index}`);
}

describe('connected media slot owner boundaries', () => {
  it('does not preview a slot when its reorder tool is double-clicked', () => {
    const onPreview = vi.fn();
    render(<ConnectedAgentMediaSlots ariaLabel="Inputs" media={media} onPreview={onPreview} onReorder={vi.fn()} />);
    fireEvent.doubleClick(screen.getByRole('button', { name: 'Move B left' }).querySelector('svg')!);
    expect(onPreview).not.toHaveBeenCalled();
    fireEvent.doubleClick(slot(2));
    expect(onPreview).toHaveBeenCalledOnce();
    expect(onPreview).toHaveBeenCalledWith(media[1], 1);
  });

  it('cancels a pointer reorder when the owner resets with identical media identities', () => {
    const onReorder = vi.fn();
    const { rerender } = render(<ConnectedAgentMediaSlots {...{ operationOwnerKey: 'owner:0' }} ariaLabel="Inputs" media={media} onReorder={onReorder} />);

    fireEvent.pointerDown(slot(2), { button: 0, pointerId: 1 });
    rerender(<ConnectedAgentMediaSlots {...{ operationOwnerKey: 'owner:1' }} ariaLabel="Inputs" media={media} onReorder={onReorder} />);
    fireEvent.pointerUp(slot(3), { button: 0, pointerId: 1 });

    expect(onReorder).not.toHaveBeenCalled();
  });

  it('cancels a native reorder when the owner resets with identical media identities', () => {
    const onReorder = vi.fn();
    const { rerender } = render(<ConnectedAgentMediaSlots {...{ operationOwnerKey: 'owner:0' }} ariaLabel="Inputs" media={media} onReorder={onReorder} />);

    fireEvent.dragStart(slot(2));
    rerender(<ConnectedAgentMediaSlots {...{ operationOwnerKey: 'owner:1' }} ariaLabel="Inputs" media={media} onReorder={onReorder} />);
    fireEvent.drop(slot(3));

    expect(onReorder).not.toHaveBeenCalled();
  });

  it('does not show a late rejection from the previous owner after an identical-media reset', async () => {
    const pending = deferred<boolean>();
    const onReorder = vi.fn(() => pending.promise);
    const { rerender } = render(<ConnectedAgentMediaSlots {...{ operationOwnerKey: 'owner:0' }} ariaLabel="Inputs" media={media} onReorder={onReorder} />);

    fireEvent.click(screen.getByRole('button', { name: 'Move B left' }));
    expect(slot(1)).toHaveAttribute('title', '1. B');
    rerender(<ConnectedAgentMediaSlots {...{ operationOwnerKey: 'owner:1' }} ariaLabel="Inputs" media={media} onReorder={onReorder} />);
    await act(async () => { pending.resolve(false); });

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(slot(1)).toHaveAttribute('title', '1. A');
  });

  it.each([
    ['image_generation', 'pointer'], ['image_generation', 'native'],
    ['video_generation', 'pointer'], ['video_generation', 'native'],
  ] as const)('cancels the actual %s %s gesture after the canvas reset changes', (kind, gesture) => {
    const f = mountNode(kind);
    const source = within(f.tray).getByLabelText('Agent media slot 2');
    if (gesture === 'pointer') fireEvent.pointerDown(source, { button: 0, pointerId: 1 });
    else fireEvent.dragStart(source);
    act(() => useAppStore.setState(state => ({ canvasDraftResetKey: state.canvasDraftResetKey + 1 })));
    const target = within(f.tray).getByLabelText('Agent media slot 1');
    if (gesture === 'pointer') fireEvent.pointerUp(target, { button: 0, pointerId: 1 });
    else fireEvent.drop(target);

    expect(f.reorder).not.toHaveBeenCalled();
  });

  it.each(['image_generation', 'video_generation'] as const)
  ('does not report the old %s reorder rejection in the new canvas owner', async kind => {
    const f = mountNode(kind);
    const pending = deferred<boolean>();
    f.reorder.mockReturnValueOnce(pending.promise);
    fireEvent.click(within(f.tray).getByRole('button', { name: 'Move Image 2 left' }));
    act(() => useAppStore.setState(state => ({ canvasDraftResetKey: state.canvasDraftResetKey + 1 })));
    await act(async () => { pending.resolve(false); });

    expect(within(f.tray).queryByRole('alert')).not.toBeInTheDocument();
    expect(within(f.tray).getByLabelText('Agent media slot 1')).toHaveAttribute('title', '1. Image 1');
  });
});

function mountNode(kind: 'image_generation' | 'video_generation') {
  delete window.novusDesktop;
  replaceProjectPersistenceClientForTests(createBrowserPersistenceClient());
  resetAppStoreForTests({ project: 'empty' });
  const images = [1, 2].map(index => ({
    assetId: index.toString(16).padStart(16, '0'), sha256: index.toString(16).padStart(64, '0'),
    byteSize: 42, extension: 'png' as const, mediaType: 'image/png' as const, origin: 'imported' as const,
    width: 800, height: 600, label: `Image ${index}`,
    displayUrl: `novus-asset://project/owner/${index.toString(16).padStart(16, '0')}`, usageCount: 1,
  }));
  const sources = images.map((image, index) => {
    const node = createCanvasModuleNode(`source-${index}`, 'image_input', { x: 0, y: index * 100 });
    node.data.config.assetId = image.assetId;
    return node;
  });
  const node = createCanvasModuleNode('generation-owner', kind, { x: 500, y: 0 });
  const port = kind === 'image_generation' ? 'references' : 'media';
  const reorder = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
  useAppStore.setState(state => ({
    project: { ...state.project, nodes: [...sources, node], assets: images,
      edges: sources.map((source, index) => ({ id: `edge-${index}`, source: source.id, sourcePortId: 'image',
        target: node.id, targetPortId: port, order: index })) },
    projectImages: images, reorderModuleInput: reorder,
  }));
  render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={node.data} /></ReactFlowProvider>);
  fireEvent.click(screen.getByRole('button', { name: kind === 'image_generation'
    ? 'Open image generation editor' : 'Open video generation editor' }));
  return { reorder, tray: screen.getByLabelText(kind === 'image_generation'
    ? 'Image generation reference slots' : 'Connected video media editor') };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
