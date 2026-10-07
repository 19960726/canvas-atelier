import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { ReactFlowProvider } from '@xyflow/react';
import { createCanvasModuleNode, parseCanvasProject, type CanvasModuleNode, type ModelJob } from '@agent-canvas/domain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBrowserPersistenceClient } from '../app/desktop-persistence';
import { createInMemoryModelJobStorage } from '../jobs/job-store';
import { createStarterProject, replaceModelJobExecutorForTests, replaceModelJobStorageForTests, replaceProjectPersistenceClientForTests, resetAppStoreForTests, useAppStore } from '../app/app-store';
import { ModuleNodeCard } from './ModuleNodeCard';
import * as imageClipboard from './image-clipboard';
import * as imageColor from '../app/image-color-correction';
import * as photoshop from '../app/photoshop-import';

const originalDesktop = window.novusDesktop;
const image = { assetId: '0123456789abcdef', byteSize: 42, displayUrl: 'novus-asset://project/session/0123456789abcdef', extension: 'png' as const, height: 800, width: 1200, label: 'This connected result', mediaType: 'image/png' as const, origin: 'generated' as const, sha256: '0123456789abcdef'.repeat(4), usageCount: 1 };
const imageRecord = { assetId: image.assetId, byteSize: image.byteSize, extension: image.extension, height: image.height, width: image.width, label: image.label, mediaType: image.mediaType, origin: image.origin, sha256: image.sha256 };
const submit = vi.fn(async (job: ModelJob) => ({ providerTaskId: 'fixture-' + job.id }));

beforeEach(() => {
  localStorage.clear();
  resetAppStoreForTests();
  submit.mockClear();
  replaceModelJobStorageForTests(createInMemoryModelJobStorage());
  replaceModelJobExecutorForTests({ submit, poll: async () => ({ status: 'running', progress: 0.1 }), cancel: async () => {} });
  replaceProjectPersistenceClientForTests(Object.assign(createBrowserPersistenceClient(), {
    ensureModelExecutionSession: async () => 'pipeline-fixture-session', getSessionId: () => 'pipeline-fixture-session',
    commit: async (request: { nextProject: ReturnType<typeof createStarterProject>; baseRevision: number }) => ({ ok: true as const, project: parseCanvasProject(request.nextProject), revision: request.baseRevision + 1 }),
    stablePoint: async () => ({ project: parseCanvasProject(useAppStore.getState().project), revision: useAppStore.getState().desktopRevision, availableSnapshotIds: [], lifecycle: 'durable' as const }),
  }));
  window.novusDesktop = { projectImages: {}, provider: {
    getStatus: async () => ({ configured: true, locked: false, encryption: 'safeStorage' }),
    listProfiles: async () => ['image_generation', 'video_generation'].map(kind => ({ provider: kind === 'image_generation' ? 'comfly' : 'relayme', modelRoute: 'fixture/' + kind, displayName: 'Fixture ' + kind, capabilities: kind === 'image_generation' ? ['image_generation', 'image_edit', 'async_tasks'] : ['video_generation', 'async_tasks'] })),
  } } as unknown as typeof window.novusDesktop;
});
afterEach(() => {
  cleanup();
  resetAppStoreForTests();
  replaceProjectPersistenceClientForTests(createBrowserPersistenceClient());
  window.novusDesktop = originalDesktop;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

function prepare(kind: 'image_generation' | 'video_generation', result = false) {
  const source = createCanvasModuleNode('prompt-source', 'text_prompt', { x: 0, y: 0 });
  source.data.config = { prompt: 'The authoritative source prompt.' };
  const gen = createCanvasModuleNode('generation', kind, { x: 440, y: 0 });
  gen.data.config = { ...gen.data.config, prompt: 'Stale local generation prompt.', modelRoute: 'fixture/' + kind, ...(result ? { resultAssetIds: [image.assetId], resultState: 'fresh' } : {}) };
  const output = createCanvasModuleNode('output', kind === 'image_generation' ? 'result_output' : 'video_result', { x: 1360, y: 0 });
  const project = parseCanvasProject({ ...createStarterProject(), nodes: [source, gen, output], edges: [
    { id: 'prompt-edge', source: source.id, sourcePortId: 'prompt', target: gen.id, targetPortId: 'prompt', order: 0 },
    { id: 'output-edge', source: gen.id, sourcePortId: 'result', target: output.id, targetPortId: kind === 'image_generation' ? 'result' : 'video', order: 0 },
  ], assets: result ? [imageRecord] : [] });
  useAppStore.setState({ project, projectLifecycle: 'durable', saveStatus: 'saved', desktopRevision: 7, projectImages: result ? [image] : [] });
  return { source, gen, output };
}
function mount(...nodes: CanvasModuleNode[]) {
  return render(<ReactFlowProvider>{nodes.map(node => <ModuleNodeCard key={node.id} id={node.id} data={{ ...node.data, ...(node.data.moduleType === 'image_generation' ? { imageGenerationRoutes: [{ provider: 'comfly', modelRoute: 'fixture/image_generation', displayName: 'Fixture image', capabilities: ['image_generation', 'image_edit', 'async_tasks'] }] } : node.data.moduleType === 'video_generation' ? { videoGenerationRoutes: [{ provider: 'relayme', modelRoute: 'fixture/video_generation', displayName: 'Fixture video', capabilities: ['video_generation', 'async_tasks'] }] } : {}) }} selected={false} />)}</ReactFlowProvider>);
}
function open(kind: 'image_generation' | 'video_generation') {
  fireEvent.click(screen.getByRole('button', { name: kind === 'image_generation' ? 'Open image generation editor' : 'Open video generation editor' }));
}

describe('editable source prompt controls the visible and executed pipeline', () => {
  it.each(['image_generation', 'result_output'] as const)('keeps actual connected %s result material in the UI image generation request', async kind => {
    const { source, gen } = prepare('image_generation');
    const producer = createCanvasModuleNode('material-producer', 'image_generation', { x: 0, y: 800 });
    producer.data.config.resultAssetIds = [image.assetId];
    const materialOutput = createCanvasModuleNode('material-output', 'result_output', { x: 920, y: 800 });
    useAppStore.setState(state => ({ project: { ...state.project, assets: [imageRecord], nodes: [...state.project.nodes, producer, ...(kind === 'result_output' ? [materialOutput] : [])], edges: [...state.project.edges,
      { id: 'current-material-wire', source: kind === 'result_output' ? materialOutput.id : producer.id, sourcePortId: 'image', target: gen.id, targetPortId: 'references', order: 0 },
      ...(kind === 'result_output' ? [{ id: 'producer-output-wire', source: producer.id, sourcePortId: 'result', target: materialOutput.id, targetPortId: 'result', order: 0 }] : []),
    ] }, projectImages: [image] }));
    mount(source, gen);
    open('image_generation');
    expect(screen.getByLabelText('Image generation reference slots').querySelector('img')).toHaveAttribute('src', image.displayUrl);
    fireEvent.click(screen.getByRole('button', { name: 'Generate image' }));
    await waitFor(() => expect(useAppStore.getState().modelJobs).toHaveLength(1));
    expect(useAppStore.getState().modelJobs[0]!.referenceAssetIds).toEqual([image.assetId]);
  });
  it.each(['image_generation', 'result_output'] as const)('keeps actual connected %s result material in the UI video generation request', async kind => {
    const { source, gen } = prepare('video_generation');
    const route = { provider: 'comfly' as const, modelRoute: 'fixture/video_generation', modelId: 'doubao-seedance-2.5', displayName: 'Verified fixture Seedance', capabilities: ['video_generation', 'async_tasks'] as ('video_generation' | 'async_tasks')[] };
    window.novusDesktop!.provider.listProfiles = async () => [route];
    const producer = createCanvasModuleNode('material-producer', 'image_generation', { x: 0, y: 800 });
    producer.data.config.resultAssetIds = [image.assetId];
    const materialOutput = createCanvasModuleNode('material-output', 'result_output', { x: 920, y: 800 });
    useAppStore.setState(state => ({ project: { ...state.project, assets: [imageRecord], nodes: [...state.project.nodes, producer, ...(kind === 'result_output' ? [materialOutput] : [])], edges: [...state.project.edges,
      { id: 'current-material-wire', source: kind === 'result_output' ? materialOutput.id : producer.id, sourcePortId: 'image', target: gen.id, targetPortId: 'media', order: 0 },
      ...(kind === 'result_output' ? [{ id: 'producer-output-wire', source: producer.id, sourcePortId: 'result', target: materialOutput.id, targetPortId: 'result', order: 0 }] : []),
    ] }, projectImages: [image] }));
    render(<ReactFlowProvider><ModuleNodeCard id={source.id} data={source.data} selected={false} /><ModuleNodeCard id={gen.id} data={{ ...gen.data, videoGenerationRoutes: [route] }} selected={false} /></ReactFlowProvider>);
    open('video_generation');
    expect(screen.getByLabelText('Connected video media editor').querySelector('img')).toHaveAttribute('src', image.displayUrl);
    fireEvent.click(screen.getByRole('button', { name: '生成视频' }));
    await waitFor(() => expect(useAppStore.getState().modelJobs).toHaveLength(1));
    expect(useAppStore.getState().modelJobs[0]!.referenceAssetIds).toEqual([image.assetId]);
  });
  it.each(['image_generation', 'video_generation'] as const)('shows the connected %s source as read only in the generation editor', kind => {
    const { gen } = prepare(kind);
    mount(gen);
    open(kind);
    const prompt = screen.getByRole('textbox', { name: kind === 'image_generation' ? 'Image generation prompt' : 'Video preview prompt' });
    expect(prompt).toHaveTextContent('The authoritative source prompt.');
    expect(prompt).toHaveAttribute('aria-readonly', 'true');
    expect(screen.getByText('从提示词节点编辑')).toBeInTheDocument();
  });

  it.each(['image_generation', 'video_generation'] as const)('flushes an edited %s source on direct generation click without blur', async kind => {
    const { source, gen } = prepare(kind);
    mount(source, gen);
    open(kind);
    const editor = screen.getByRole('textbox', { name: 'Text prompt' });
    fireEvent.change(editor, { target: { value: 'Latest unblurred source with full constraints.' } });
    expect(useAppStore.getState().saveStatus).toBe('saved');
    fireEvent.click(screen.getByRole('button', { name: kind === 'image_generation' ? 'Generate image' : '生成视频' }));
    await waitFor(() => expect(useAppStore.getState().modelJobs).toHaveLength(1), { onTimeout: error => new Error(error.message + '\n' + JSON.stringify({ saveStatus: useAppStore.getState().saveStatus, saveErrorCode: useAppStore.getState().saveErrorCode, alerts: screen.queryAllByRole('alert').map(el => el.textContent), source: (useAppStore.getState().project.nodes.find(n => n.id === source.id) as CanvasModuleNode)?.data.config.prompt })) });
    expect(useAppStore.getState().modelJobs[0]!.prompt).toBe('Latest unblurred source with full constraints.');
    expect((useAppStore.getState().project.nodes.find(n => n.id === source.id) as CanvasModuleNode).data.config.prompt).toBe('Latest unblurred source with full constraints.');
  });

  it('blocks generation if saving the edited source fails', async () => {
    const { source, gen } = prepare('image_generation');
    vi.spyOn(useAppStore.getState(), 'draftTextPromptNodeConfig').mockResolvedValue(false);
    mount(source, gen);
    open('image_generation');
    fireEvent.change(screen.getByRole('textbox', { name: 'Text prompt' }), { target: { value: 'A source that cannot be saved.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate image' }));
    await waitFor(() => expect(screen.getByRole('alert', { name: 'Prompt save error' })).toBeVisible());
    expect(useAppStore.getState().modelJobs).toHaveLength(0);
    expect(submit).not.toHaveBeenCalled();
  });

  it.each(['image_generation', 'video_generation'] as const)('enables an initially empty %s source draft without blur and still saves before enqueue', async kind => {
    const { source, gen } = prepare(kind);
    source.data.config.prompt = '';
    useAppStore.setState(state => ({ project: { ...state.project, nodes: state.project.nodes.map(n => n.id === source.id ? source : n) } }));
    mount(source, gen);
    open(kind);
    const run = screen.getByRole('button', { name: kind === 'image_generation' ? 'Generate image' : '生成视频' });
    expect(run).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox', { name: 'Text prompt' }), { target: { value: 'The first complete prompt.' } });
    expect(run).toBeEnabled();
    expect(useAppStore.getState().modelJobs).toHaveLength(0);
    fireEvent.click(run);
    await waitFor(() => expect(useAppStore.getState().modelJobs).toHaveLength(1));
    expect(useAppStore.getState().modelJobs[0]!.prompt).toBe('The first complete prompt.');
    expect((useAppStore.getState().project.nodes.find(n => n.id === source.id) as CanvasModuleNode).data.config.prompt).toBe('The first complete prompt.');
  });

  it('waits for an in-flight source save and flushes a newer edit before enqueue', async () => {
    const { source, gen } = prepare('image_generation');
    const original = useAppStore.getState().draftTextPromptNodeConfig;
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(useAppStore.getState(), 'draftTextPromptNodeConfig').mockImplementation(async (id, prompt, projectId) => {
      await barrier;
      return original(id, prompt, projectId);
    });
    mount(source, gen);
    open('image_generation');
    const editor = screen.getByRole('textbox', { name: 'Text prompt' });
    fireEvent.change(editor, { target: { value: 'First in-flight edit.' } });
    fireEvent.blur(editor);
    fireEvent.change(editor, { target: { value: 'Latest edit during persistence.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate image' }));
    expect(useAppStore.getState().modelJobs).toHaveLength(0);
    await act(async () => { release(); await barrier; });
    await waitFor(() => expect(useAppStore.getState().modelJobs).toHaveLength(1));
    expect(useAppStore.getState().modelJobs[0]!.prompt).toBe('Latest edit during persistence.');
  });

  it('cleans a local source draft on project switch with reused node IDs', () => {
    const { source, gen } = prepare('image_generation');
    const view = mount(source, gen);
    open('image_generation');
    fireEvent.change(screen.getByRole('textbox', { name: 'Text prompt' }), { target: { value: 'Old project unsaved text.' } });
    act(() => useAppStore.getState().setProject({ ...useAppStore.getState().project, id: 'new-project', nodes: useAppStore.getState().project.nodes.map(n => n.id === source.id ? { ...source, data: { ...source.data, config: { prompt: 'New project source.' } } } : n) }, { schedulePersist: false }));
    view.unmount();
    const current = useAppStore.getState().project.nodes;
    mount(...current.filter((n): n is CanvasModuleNode => n.type === 'module' && n.id !== 'output'));
    open('image_generation');
    expect(screen.getByRole('textbox', { name: 'Text prompt' })).toHaveValue('New project source.');
    expect(screen.getByRole('textbox', { name: 'Image generation prompt' })).toHaveTextContent('New project source.');
    expect(useAppStore.getState().modelJobs).toHaveLength(0);
  });

  it('retains the dirty source and blocks enqueue if its persistence throws', async () => {
    const { source, gen } = prepare('image_generation');
    vi.spyOn(useAppStore.getState(), 'draftTextPromptNodeConfig').mockRejectedValue(new Error('Fixture persistence unavailable'));
    mount(source, gen);
    open('image_generation');
    fireEvent.change(screen.getByRole('textbox', { name: 'Text prompt' }), { target: { value: 'Dirty source must remain.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Generate image' }));
    await waitFor(() => expect(screen.getByRole('alert', { name: 'Prompt save error' })).toBeVisible());
    expect(screen.getByRole('textbox', { name: 'Text prompt' })).toHaveValue('Dirty source must remain.');
    expect(useAppStore.getState().modelJobs).toHaveLength(0);
  });
});

describe('actual typed image result output', () => {
  it.each(['等待结果', '已完成', '正在生成'] as const)('shows the accurate concise output status: %s', async status => {
    const { output, gen } = prepare('image_generation', status === '已完成');
    if (status === '正在生成') {
      expect(await useAppStore.getState().runImageGenerationNode(gen.id, { prompt: 'Ignored local prompt.', modelRoute: 'fixture/image_generation' })).toBe(true);
    }
    mount(output);
    const preview = screen.getByRole('region', { name: 'Generated image preview' });
    expect(preview.querySelector('header span')).toHaveTextContent(new RegExp('^' + status + '$', 'u'));
    expect(preview).not.toHaveTextContent(/IMAGE OUTPUT|上次结果/u);
  });

  const correction = { ...imageColor.ORIGINAL_IMAGE_COLOR_CORRECTION, version: 2 as const, mode: 'custom' as const, temperature: -12, tint: 9, saturation: 117, brightness: 104, contrast: 108 };
  function correctedOutput() {
    const { output, gen } = prepare('image_generation', true);
    gen.data.config.imageColorCorrections = { [image.assetId]: correction };
    useAppStore.setState(state => ({ project: { ...state.project, nodes: state.project.nodes.map(n => n.id === gen.id ? gen : n) } }));
    mount(output);
    return screen.getByRole('region', { name: 'Generated image preview' });
  }
  it('uses the source asset custom correction in the output image and immersive preview', () => {
    correctedOutput();
    const imageElement = screen.getByRole('img', { name: 'Connected generated image 1' });
    expect(imageElement.style.filter).toContain('saturate(1.17)');
    fireEvent.doubleClick(screen.getByRole('button', { name: 'Open connected generated image 1' }));
    const fullImage = screen.getByRole('dialog').querySelector('img');
    expect(fullImage?.style.filter).toContain('saturate(1.17)');
  });
  it.each(['copy', 'download', 'photoshop'] as const)('passes the same custom correction to the actual output %s action boundary', async action => {
    const copy = vi.spyOn(imageClipboard, 'copyProjectImageToClipboard').mockResolvedValue(true);
    const download = vi.spyOn(imageColor, 'renderImageColorCorrectionBlob').mockResolvedValue(new Blob(['fixture'], { type: 'image/png' }));
    const ps = vi.spyOn(photoshop, 'importGeneratedImageToPhotoshop').mockResolvedValue({ ok: true, documentName: 'Fixture smart object', layerName: 'Fixture' } as Awaited<ReturnType<typeof photoshop.importGeneratedImageToPhotoshop>>);
    vi.spyOn(photoshop, 'getPhotoshopImportAvailability').mockReturnValue({ available: true });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:fixture'), revokeObjectURL: vi.fn() }));
    fireEvent.contextMenu(correctedOutput());
    fireEvent.click(screen.getByRole('menuitem', { name: action === 'copy' ? '复制图片' : action === 'download' ? '下载图片' : '导入 Photoshop（智能对象）' }));
    await waitFor(() => {
      if (action === 'copy') expect(copy).toHaveBeenCalledWith(image, correction);
      else if (action === 'download') expect(download).toHaveBeenCalledWith(image.displayUrl, correction);
      else expect(ps).toHaveBeenCalledWith(image, 'pipeline-fixture-session', correction);
    });
  });
  it('shows only the connected generation result with enabled existing image actions', () => {
    const { output } = prepare('image_generation', true);
    mount(output);
    expect(screen.getByRole('img', { name: 'Connected generated image 1' })).toHaveAttribute('src', image.displayUrl);
    const preview = screen.getByRole('region', { name: 'Generated image preview' });
    fireEvent.contextMenu(preview, { clientX: 100, clientY: 100 });
    expect(screen.getByRole('menuitem', { name: '发送到 AI 对话' })).toBeEnabled();
    expect(screen.getByRole('menuitem', { name: '下载图片' })).toBeEnabled();
  });
  it('honors the existing whole-node controlled context menu and closes through its callback', () => {
    const { output } = prepare('image_generation', true);
    const onMenuChange = vi.fn();
    render(<ReactFlowProvider><ModuleNodeCard id={output.id} data={{ ...output.data, resultOutputMenuOpen: true, onResultOutputMenuChange: onMenuChange }} selected={false} /></ReactFlowProvider>);
    expect(screen.getByRole('menuitem', { name: '复制图片' })).toBeEnabled();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onMenuChange).toHaveBeenCalledWith(output.id, false);
  });

  it('does not label an empty connected output as completed or borrow unrelated images', () => {
    const { output } = prepare('image_generation');
    useAppStore.setState({ projectImages: [image] });
    mount(output);
    expect(screen.getByRole('region', { name: 'Generated image preview' })).not.toHaveTextContent('已完成');
    expect(screen.queryByRole('img', { name: 'Connected generated image 1' })).not.toBeInTheDocument();
  });
  it('removes a mounted image output if an assets-only update revokes its ownership', () => {
    const { output } = prepare('image_generation', true);
    mount(output);
    expect(screen.getByRole('img', { name: 'Connected generated image 1' })).toBeInTheDocument();
    act(() => useAppStore.setState(state => ({ project: { ...state.project, assets: [] } })));
    expect(screen.queryByRole('img', { name: 'Connected generated image 1' })).not.toBeInTheDocument();
  });

  it.each(['unsafe URL', 'missing source', 'multiple inputs', 'not owned'] as const)('does not display an invalid connected result: %s', fault => {
    const { output } = prepare('image_generation', true);
    act(() => useAppStore.setState(state => fault === 'unsafe URL'
      ? { projectImages: [{ ...image, displayUrl: 'https://outside.invalid/result.png' }] }
      : { project: { ...state.project, ...(fault === 'not owned' ? { assets: [] } : fault === 'missing source' ? { nodes: state.project.nodes.filter(n => n.id !== 'generation') } : { edges: [...state.project.edges, { ...state.project.edges[1]!, id: 'duplicate-output' }] }) } }));
    mount(output);
    expect(screen.queryByRole('img', { name: 'Connected generated image 1' })).not.toBeInTheDocument();
  });
});

describe('accurate typed video result output', () => {
  function videoOutput(metadata = true) {
    const { gen, output } = prepare('video_generation');
    const video = { ...image, assetId: 'fedcba9876543210', displayUrl: 'novus-asset://project/session/fedcba9876543210', extension: 'mp4' as const, mediaType: 'video/mp4' as const, origin: 'imported' as const, durationMs: metadata ? 7000 : null, width: metadata ? 1280 : null, height: metadata ? 720 : null };
    gen.data.config.videoResults = [{ assetId: video.assetId, mediaType: 'video/mp4', ...(metadata ? { durationMs: 7000 } : {}) }];
    useAppStore.setState(state => ({ project: { ...state.project, nodes: state.project.nodes.map(n => n.id === gen.id ? gen : n), assets: [video] }, projectVideos: [video] }));
    return { output, video };
  }
  it('shows the actual seven second 720p result with native playback controls', () => {
    const { output, video } = videoOutput();
    mount(output);
    expect(screen.getByLabelText('Generated video playback video')).toHaveAttribute('src', video.displayUrl);
    expect(screen.getByLabelText('Generated video playback video')).toHaveAttribute('controls');
    expect(screen.getByLabelText('Generated video playback')).toHaveTextContent('00:07 · 720p');
    expect(screen.getByLabelText('Generated video playback')).not.toHaveTextContent('1080p');
  });
  it('can play a managed result with unknown metadata without inventing duration or resolution', () => {
    const { output } = videoOutput(false);
    mount(output);
    expect(screen.getByLabelText('Generated video playback video')).toHaveAttribute('controls');
    expect(screen.getByLabelText('Generated video playback')).toHaveTextContent('时长未知 · 分辨率未知');
    expect(screen.getByLabelText('Generated video playback')).not.toHaveTextContent(/00:05|1080p/u);
  });
  it.each(['external URL', 'wrong asset URL', 'not owned', 'multiple inputs', 'no managed media'] as const)('does not report completed playback for %s', fault => {
    const { output, video } = videoOutput();
    useAppStore.setState(state => fault === 'not owned'
      ? { project: { ...state.project, assets: [] } }
      : fault === 'multiple inputs'
        ? { project: { ...state.project, edges: [...state.project.edges, { ...state.project.edges[1]!, id: 'duplicate-video-input' }] } }
        : { projectVideos: fault === 'no managed media' ? [] : [{ ...video, displayUrl: fault === 'external URL' ? 'https://outside.invalid/result.mp4' : 'novus-asset://project/session/0011223344556677' }] });
    mount(output);
    expect(screen.queryByLabelText('Generated video playback video')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Generated video preview')).not.toHaveTextContent('已完成');
  });
  it('refuses a foreign video even when its poster is owned by this project', () => {
    const { output } = videoOutput();
    useAppStore.setState(state => ({ project: { ...state.project, assets: [image], nodes: state.project.nodes.map(n => n.type === 'module' && n.data.moduleType === 'video_generation' ? { ...n, data: { ...n.data, config: { ...n.data.config, videoResults: [{ assetId: 'fedcba9876543210', mediaType: 'video/mp4', durationMs: 7000, posterAssetId: image.assetId }] } } } : n) }, projectImages: [image] }));
    mount(output);
    expect(screen.getByLabelText('Generated video preview')).not.toHaveTextContent('已完成');
    expect(screen.queryByRole('img', { name: 'Video result poster' })).not.toBeInTheDocument();
  });
  it('removes mounted video playback if an assets-only update revokes its ownership', () => {
    const { output } = videoOutput();
    mount(output);
    expect(screen.getByLabelText('Generated video playback video')).toBeInTheDocument();
    act(() => useAppStore.setState(state => ({ project: { ...state.project, assets: [] } })));
    expect(screen.queryByLabelText('Generated video playback video')).not.toBeInTheDocument();
  });
});
