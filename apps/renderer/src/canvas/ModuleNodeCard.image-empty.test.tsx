import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { ReactFlowProvider } from '@xyflow/react';
import { createCanvasModuleNode } from '@agent-canvas/domain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { replaceProjectPersistenceClientForTests, resetAppStoreForTests, useAppStore } from '../app/app-store';
import { createBrowserPersistenceClient } from '../app/desktop-persistence';
import { ModuleNodeCard } from './ModuleNodeCard';

const image = {
  assetId: 'aaaaaaaaaaaaaaaa', byteSize: 42, extension: 'png' as const, height: 1600,
  label: 'Imported reference', mediaType: 'image/png' as const, origin: 'imported' as const,
  sha256: 'a'.repeat(64), width: 900,
};
const summary = { ...image, displayUrl: 'novus-asset://project/session/aaaaaaaaaaaaaaaa', usageCount: 0 };

beforeEach(() => {
  delete window.novusDesktop;
  localStorage.clear();
  replaceProjectPersistenceClientForTests(createBrowserPersistenceClient());
  resetAppStoreForTests({ project: 'empty' });
});

afterEach(() => {
  cleanup();
  document.querySelectorAll('input[type="file"]').forEach(input => input.remove());
  resetAppStoreForTests({ project: 'empty' });
  vi.restoreAllMocks();
});

function openEmptyEditor(configured = false) {
  const node = createCanvasModuleNode('empty-image-target', 'image_generation', { x: 700, y: 120 });
  if (configured) node.data.config = { ...node.data.config, prompt: 'Keep the product shape', modelRoute: 'comfly-gpt-image-2' };
  const run = vi.fn(async () => true);
  useAppStore.setState(state => ({ project: { ...state.project, nodes: [node], edges: [], assets: [] },
    projectLifecycle: 'durable', saveStatus: 'saved', draftGenerationNodeConfig: vi.fn(async () => true), runImageGenerationNode: run }));
  render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={node.data} selected /></ReactFlowProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Open image generation editor' }));
  return { node, run };
}

function selectReferenceFile() {
  fireEvent.click(screen.getByRole('button', { name: '添加参考图片 / Add reference image' }));
  const picker = document.querySelector('input[type="file"]')!;
  expect(picker).toHaveAttribute('accept', 'image/png,image/jpeg,image/webp,image/gif');
  fireEvent.change(picker, { target: { files: [new File(['fixture'], 'reference.png', { type: 'image/png' })] } });
}

describe('image generation empty editor', () => {
  it.each([false, true])('does not number an empty reference as an image, configured=%s', configured => {
    const { run } = openEmptyEditor(configured);
    const tray = screen.getByLabelText('Image generation reference slots');
    expect(tray).toHaveTextContent('0 / 20');
    expect(within(tray).queryByLabelText('图槽编号 1')).not.toBeInTheDocument();
    expect(tray.querySelector('.connected-agent-media-slots__item')).toBeNull();
    const add = within(tray).getByRole('button', { name: '添加参考图片 / Add reference image' });
    expect(add).toBeEnabled();
    expect(add.querySelector('svg')).not.toBeNull();
    expect(screen.getByLabelText('生成摘要 / Generation summary')).toHaveAttribute('data-preview-frame', 'empty');
    expect(screen.getByTestId('module-node-card')).not.toHaveAttribute('data-preview-sizing', 'media');
    expect(screen.getByRole('textbox', { name: 'Image generation prompt' })).toHaveValue(configured ? 'Keep the product shape' : '');
    expect(screen.getByRole('button', { name: 'Image generation aspect ratio' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Image generation resolution' })).toBeVisible();
    expect(run).not.toHaveBeenCalled();
  });

  it('cancels the file picker without creating a source, connection or generation', () => {
    const { run } = openEmptyEditor();
    const before = useAppStore.getState().project;
    const imported = vi.spyOn(useAppStore.getState(), 'importAgentReferenceImage');
    fireEvent.click(screen.getByRole('button', { name: '添加参考图片 / Add reference image' }));
    fireEvent(document.querySelector('input[type="file"]')!, new Event('cancel'));
    expect(document.querySelector('input[type="file"]')).toBeNull();
    expect(useAppStore.getState().project).toBe(before);
    expect(imported).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it('imports a managed reference through the existing source and typed connection operations', async () => {
    const { node, run } = openEmptyEditor(true);
    const imported = vi.fn(async () => ({ asset: summary,
      project: { ...useAppStore.getState().project, assets: [image] }, revision: 1 }));
    replaceProjectPersistenceClientForTests({ ...createBrowserPersistenceClient(), importProjectImage: imported,
      listProjectImages: async () => [summary] });
    selectReferenceFile();
    await waitFor(() => expect(useAppStore.getState().project.edges).toHaveLength(1));
    const project = useAppStore.getState().project;
    const source = project.nodes.find(candidate => candidate.type === 'module' && candidate.data.moduleType === 'image_input')!;
    expect(source).toMatchObject({ data: { config: { assetId: image.assetId } } });
    expect(project.edges[0]).toMatchObject({ source: source.id, sourcePortId: 'image', target: node.id, targetPortId: 'references', order: 0 });
    expect(imported).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('Image generation reference slots')).toHaveTextContent('1 / 20');
    expect(screen.getByRole('img', { name: image.label })).toHaveAttribute('src', summary.displayUrl);
    expect(screen.getByLabelText('图槽编号 1')).toBeInTheDocument();
    expect(run).not.toHaveBeenCalled();
  });

  it('does not create a source in another project after a pending import returns', async () => {
    const { run } = openEmptyEditor();
    let finish!: (asset: typeof summary) => void;
    const imported = vi.fn(() => new Promise<typeof summary>(resolve => { finish = resolve; }));
    useAppStore.setState({ importAgentReferenceImage: imported });
    selectReferenceFile();
    act(() => useAppStore.setState(state => ({ project: { ...state.project, id: 'another-project', nodes: [], edges: [] } })));
    await act(async () => finish(summary));
    expect(useAppStore.getState().project).toMatchObject({ id: 'another-project', nodes: [], edges: [] });
    expect(run).not.toHaveBeenCalled();
  });

  it('retries a failed connection save without importing or creating another source', async () => {
    const { run } = openEmptyEditor(true);
    const imported = vi.fn(async () => ({ asset: summary,
      project: { ...useAppStore.getState().project, assets: [image] }, revision: 1 }));
    let failConnection = true;
    const commit = vi.fn(async (request: Parameters<ReturnType<typeof createBrowserPersistenceClient>['commit']>[0]) => {
      if (failConnection && request.transaction.operations.some(operation => operation.kind === 'canvas' && operation.operation.kind === 'create_edge')) {
        failConnection = false;
        return { ok: false as const, code: 'DURABLE_WRITE_FAILED' as const, retryable: true,
          project: request.previousProject, revision: request.baseRevision };
      }
      return { ok: true as const, project: request.nextProject, revision: request.baseRevision + 1 };
    });
    replaceProjectPersistenceClientForTests({ ...createBrowserPersistenceClient(), importProjectImage: imported,
      listProjectImages: async () => [summary], commit });
    selectReferenceFile();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('连线未保存'));
    const failed = commit.mock.calls.find(([request]) => request.transaction.operations.some(operation => operation.kind === 'canvas' && operation.operation.kind === 'create_edge'))![0];
    expect(useAppStore.getState()).toMatchObject({
      canRetryProjectCommit: true,
      saveErrorCode: 'DURABLE_WRITE_FAILED',
      saveStatus: 'error',
    });
    const failedEdges = useAppStore.getState().project.edges;
    expect(failedEdges).toHaveLength(1);
    const sourceIds = useAppStore.getState().project.nodes.filter(node => node.type === 'module' && node.data.moduleType === 'image_input').map(node => node.id);
    expect(sourceIds).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: '添加参考图片 / Add reference image' }));
    await waitFor(() => expect(useAppStore.getState()).toMatchObject({
      canRetryProjectCommit: false,
      saveErrorCode: null,
      saveStatus: 'saved',
    }));
    expect(useAppStore.getState().project.edges).toEqual(failedEdges);
    expect(document.querySelector('input[type="file"]')).toBeNull();
    expect(imported).toHaveBeenCalledTimes(1);
    expect(commit.mock.calls[commit.mock.calls.length - 1]![0]).toEqual(failed);
    const connectionRequests = commit.mock.calls.filter(([request]) => request.transaction.operations.some(operation => operation.kind === 'canvas' && operation.operation.kind === 'create_edge'));
    expect(connectionRequests).toHaveLength(2);
    expect(connectionRequests[1]![0]).toBe(failed);
    expect(useAppStore.getState().project.nodes.filter(node => node.type === 'module' && node.data.moduleType === 'image_input').map(node => node.id)).toEqual(sourceIds);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(run).not.toHaveBeenCalled();
  });

  it('stops after a project boundary reset while a reference import is pending', async () => {
    const { run } = openEmptyEditor();
    let finish!: (asset: typeof summary) => void;
    useAppStore.setState({ importAgentReferenceImage: vi.fn(() => new Promise<typeof summary>(resolve => { finish = resolve; })) });
    selectReferenceFile();
    act(() => useAppStore.setState(state => ({ canvasDraftResetKey: state.canvasDraftResetKey + 1 })));
    await act(async () => finish(summary));
    expect(useAppStore.getState().project.nodes).toHaveLength(1);
    expect(useAppStore.getState().project.edges).toHaveLength(0);
    expect(run).not.toHaveBeenCalled();
  });
});
