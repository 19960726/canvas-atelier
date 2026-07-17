import { readFileSync } from 'node:fs';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAgentKnowledgeLease, type PlacementObject, type ProjectMemoryEntry } from '@agent-canvas/domain';
import {
  createStarterProject,
  replaceKnowledgeClientForTests,
  replaceModelJobExecutorForTests,
  replaceProjectPersistenceClientForTests,
  resetAppStoreForTests,
  useAppStore,
} from '../app/app-store';
import type { KnowledgeClient } from '../app/knowledge-client';
import type {
  ProjectCommitRequest,
  ProjectCommitResult,
  ProjectHydrationResult,
  ProjectPersistenceClient,
} from '../app/desktop-persistence';
import { calculateModulePlacement, CanvasWorkspace, type ModulePlacementBounds } from './CanvasWorkspace';
import { MODULE_DRAG_MIME } from './ModuleLibrary';

const appStyles = readFileSync('apps/renderer/src/styles/app.css', 'utf8');

beforeEach(() => {
  delete window.novusDesktop;
  replaceProjectPersistenceClientForTests(createImmediateBrowserClient());
  resetAppStoreForTests();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Reflect.deleteProperty(URL, 'createObjectURL');
  Reflect.deleteProperty(URL, 'revokeObjectURL');
});

describe('CanvasWorkspace', () => {
  it('exposes stable visual-state hooks for the professional shell', () => {
    render(<CanvasWorkspace />);

    expect(screen.getByTestId('workspace')).toHaveClass('workspace');
    expect(screen.getByTestId('topbar')).toHaveAttribute('data-surface', 'chrome');
    expect(screen.getByTestId('tool-placement')).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(screen.getByTestId('tool-placement'));

    expect(screen.getByTestId('tool-placement')).toHaveAttribute('aria-pressed', 'true');
  });

  it('keeps shell controls within approved geometry and zero letter spacing', () => {
    const style = document.createElement('style');
    style.textContent = appStyles;
    document.head.append(style);
    try {
      const { container } = render(<CanvasWorkspace />);
      const workspace = screen.getByTestId('workspace');
      const selectors = ['.project-button', '.icon-button', '.run-button', '.tool-button'];

      for (const selector of selectors) {
        const control = container.querySelector<HTMLElement>(selector);
        expect(control).not.toBeNull();
        expect(getComputedStyle(control!).borderRadius).toBe('5px');
      }
      expect(getComputedStyle(workspace).letterSpacing).toBe('0px');
    } finally {
      style.remove();
    }
  });

  it('renders the canvas-first application shell', () => {
    render(<CanvasWorkspace />);
    expect(screen.getByRole('application', { name: '无限画布' })).toBeVisible();
    expect(screen.getByLabelText('选择工具')).toBeVisible();
    expect(screen.getByLabelText('Agent 面板')).toBeVisible();
    expect(screen.getByLabelText('任务队列')).toBeVisible();
  });

  it('opens the module library without persisting and places clicked modules in a cascade', async () => {
    const commit = vi.fn(async ({ nextProject }: ProjectCommitRequest): Promise<ProjectCommitResult> => ({
      ok: true,
      project: nextProject,
      revision: 1,
    }));
    replaceProjectPersistenceClientForTests(createImmediateBrowserClient({ commit }));
    resetAppStoreForTests();

    render(<CanvasWorkspace />);

    fireEvent.click(screen.getByRole('button', { name: 'Modules' }));
    expect(commit).not.toHaveBeenCalled();
    expect(screen.getByRole('searchbox', { name: 'Search modules' })).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Add Text Prompt' }));
    fireEvent.click(screen.getByRole('button', { name: 'Add Text Prompt' }));

    await waitFor(() => expect(commit).toHaveBeenCalledTimes(2));
    const moduleNodes = useAppStore.getState().project.nodes.filter((node) => node.type === 'module');
    expect(moduleNodes).toHaveLength(2);
    expect(moduleNodes[0]?.position).not.toEqual(moduleNodes[1]?.position);

    fireEvent.click(screen.getByRole('button', { name: 'Modules' }));
    expect(screen.queryByRole('searchbox', { name: 'Search modules' })).toBeNull();
    expect(commit).toHaveBeenCalledTimes(2);
  });

  it('keeps module placement inside the unobscured canvas with at most four columns', () => {
    const bounds: ModulePlacementBounds = { left: 310, right: 958, top: 12, bottom: 612 };
    const positions = [];
    for (let index = 0; index < 4; index += 1) {
      const next = calculateModulePlacement(bounds, positions);
      expect(next).not.toBeNull();
      positions.push(next!);
    }

    expect(new Set(positions.map((position) => position.x)).size).toBe(2);
    for (const position of positions) {
      expect(position.x).toBeGreaterThanOrEqual(bounds.left);
      expect(position.x + 264).toBeLessThanOrEqual(bounds.right);
      expect(position.y).toBeGreaterThanOrEqual(bounds.top);
      expect(position.y + 214).toBeLessThanOrEqual(bounds.bottom);
    }
    expect(positions[0]).not.toEqual(positions[1]);
    expect(positions[2]).not.toEqual(positions[3]);
  });

  it('keeps the module library and placement workbench mutually exclusive', () => {
    const commit = vi.fn(async ({ nextProject }: ProjectCommitRequest): Promise<ProjectCommitResult> => ({
      ok: true,
      project: nextProject,
      revision: 1,
    }));
    replaceProjectPersistenceClientForTests(createImmediateBrowserClient({ commit }));
    resetAppStoreForTests();

    render(<CanvasWorkspace />);
    fireEvent.click(screen.getByTestId('tool-placement'));
    expect(screen.getByTestId('placement-workbench')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Modules' }));
    expect(screen.getByTestId('module-library')).toBeVisible();
    expect(screen.queryByTestId('placement-workbench')).toBeNull();
    expect(screen.getByTestId('tool-placement')).toHaveAttribute('aria-pressed', 'false');
    expect(commit).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('tool-placement'));
    expect(screen.queryByTestId('module-library')).toBeNull();
    expect(screen.getByTestId('placement-workbench')).toBeVisible();
  });

  it('ignores foreign and invalid module drops', async () => {
    const commit = vi.fn(async ({ nextProject }: ProjectCommitRequest): Promise<ProjectCommitResult> => ({
      ok: true,
      project: nextProject,
      revision: 1,
    }));
    replaceProjectPersistenceClientForTests(createImmediateBrowserClient({ commit }));
    resetAppStoreForTests();

    render(<CanvasWorkspace />);
    const canvas = screen.getByTestId('canvas-stage');

    fireEvent.drop(canvas, {
      clientX: 320,
      clientY: 240,
      dataTransfer: { types: ['text/plain'], getData: vi.fn(() => 'text_prompt') },
    });
    fireEvent.drop(canvas, {
      clientX: 320,
      clientY: 240,
      dataTransfer: { types: [MODULE_DRAG_MIME], getData: vi.fn(() => 'not-a-module') },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(commit).not.toHaveBeenCalled();
    expect(useAppStore.getState().project.nodes.filter((node) => node.type === 'module')).toHaveLength(0);
  });

  it('creates a valid dropped module at the React Flow drop position', async () => {
    const commit = vi.fn(async ({ nextProject }: ProjectCommitRequest): Promise<ProjectCommitResult> => ({
      ok: true,
      project: nextProject,
      revision: 1,
    }));
    replaceProjectPersistenceClientForTests(createImmediateBrowserClient({ commit }));
    resetAppStoreForTests();

    render(<CanvasWorkspace />);
    const getData = vi.fn((mime: string) => mime === MODULE_DRAG_MIME ? 'text_prompt' : 'foreign');
    fireEvent.drop(screen.getByTestId('canvas-stage'), {
      clientX: 320,
      clientY: 240,
      dataTransfer: {
        types: [MODULE_DRAG_MIME],
        getData,
      },
    });

    expect(getData).toHaveBeenCalledWith(MODULE_DRAG_MIME);
    await waitFor(() => expect(commit).toHaveBeenCalledTimes(1));
    const moduleNode = useAppStore.getState().project.nodes.find((node) => node.type === 'module');
    expect(moduleNode).toMatchObject({ type: 'module', data: { moduleType: 'text_prompt' } });
    expect(moduleNode?.position.x).toEqual(expect.any(Number));
    expect(moduleNode?.position.y).toEqual(expect.any(Number));
  });

  it('renders React Flow nodes from the domain project state', () => {
    useAppStore.getState().setProject({
      version: 1,
      id: 'project-prop',
      name: '道具项目',
      nodes: [{ id: 'prop-1', type: 'reference', position: { x: 80, y: 120 }, data: { assetId: 'asset-prop', role: 'prop_reference' } }],
      edges: [],
      projectMemory: [],
      skillPromotionCandidates: [],
    });
    render(<CanvasWorkspace />);
    const canvas = within(screen.getByRole('application', { name: '无限画布' }));
    expect(canvas.getByText('道具参考')).toBeInTheDocument();
    expect(canvas.queryByText('产品身份参考')).not.toBeInTheDocument();
  });

  it('mounts far-from-origin nodes before the first React Flow viewport initializes fitView', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      bottom: 600,
      height: 600,
      left: 0,
      right: 800,
      toJSON: () => ({}),
      top: 0,
      width: 800,
      x: 0,
      y: 0,
    } as DOMRect);
    useAppStore.getState().setProject({
      version: 1,
      id: 'project-far-from-origin',
      name: 'Far Initial FitView Project',
      nodes: [
        {
          id: 'far-reference',
          type: 'reference',
          position: { x: 5200, y: 4800 },
          data: { assetId: 'asset-far-reference', role: 'product_identity' },
        },
        {
          id: 'far-prompt',
          type: 'prompt',
          position: { x: 5600, y: 4800 },
          data: { prompt: 'fitView should see this far prompt', requirementIds: [] },
        },
      ],
      edges: [{ id: 'far-edge', source: 'far-reference', target: 'far-prompt' }],
      projectMemory: [],
      skillPromotionCandidates: [],
    });

    render(<CanvasWorkspace />);

    expect(screen.getAllByText(/asset-far-reference/).length).toBeGreaterThan(0);
    expect(screen.getAllByText('fitView should see this far prompt').length).toBeGreaterThan(0);
  });

  it('opens the placement workbench with separate reference uploads', () => {
    render(<CanvasWorkspace />);
    fireEvent.click(screen.getByLabelText('摆放预览'));
    expect(screen.getByLabelText('摆放工作台')).toBeVisible();
    expect(screen.getByLabelText('上传产品参考')).toBeInTheDocument();
    expect(screen.getByLabelText('上传场景参考')).toBeInTheDocument();
    expect(screen.getByLabelText('上传道具参考')).toBeInTheDocument();
    expect(screen.getByLabelText('上传材质光照参考')).toBeInTheDocument();
  });

  it('keeps temporary preview URLs outside project JSON and revokes them on unmount', () => {
    const createObjectUrl = vi.fn(() => 'blob:scene-preview');
    const revokeObjectUrl = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectUrl });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectUrl });
    const { unmount } = render(<CanvasWorkspace />);
    fireEvent.click(screen.getByLabelText('摆放预览'));
    fireEvent.change(screen.getByLabelText('上传场景参考'), { target: { files: [new File(['scene'], 'scene.png', { type: 'image/png' })] } });

    const placementNode = useAppStore.getState().project.nodes.find((node) => node.type === 'placement_preview');
    const sceneObject = placementNode?.type === 'placement_preview'
      ? placementNode.data.objects.find((object) => object.role === 'scene_composition')
      : undefined;
    expect(createObjectUrl).toHaveBeenCalledOnce();
    expect(sceneObject?.assetId).toMatch(/^local-reference-/);
    expect(sceneObject?.assetId).not.toContain('blob:');
    expect(placementNode?.type === 'placement_preview' ? placementNode.data.objects.some((object) => object.assetId === 'starter-product') : false).toBe(true);
    expect(screen.getByAltText('场景参考')).toHaveAttribute('src', 'blob:scene-preview');
    expect(within(screen.getByLabelText('当前参考职责')).getByText('已添加 1 张')).toBeInTheDocument();

    unmount();
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:scene-preview');
  });

  it('does not persist on pointermove and commits once on pointerup', async () => {
    const commit = vi.fn(async ({ nextProject }: ProjectCommitRequest): Promise<ProjectCommitResult> => ({
      ok: true,
      project: nextProject,
      revision: 1,
    }));
    replaceProjectPersistenceClientForTests(createImmediateBrowserClient({ commit }));
    resetAppStoreForTests();
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      bottom: 500,
      height: 500,
      left: 0,
      right: 400,
      toJSON: () => ({}),
      top: 0,
      width: 400,
      x: 0,
      y: 0,
    } as DOMRect);

    render(<CanvasWorkspace />);
    fireEvent.click(screen.getByLabelText('摆放预览'));
    const canvas = screen.getByTestId('placement-board');
    const object = screen.getByTestId('placement-object-product-main');

    fireEvent.pointerDown(object, { clientX: 120, clientY: 120, pointerId: 1 });
    fireEvent.pointerMove(canvas, { clientX: 180, clientY: 180, pointerId: 1 });

    expect(commit).not.toHaveBeenCalled();

    fireEvent.pointerUp(canvas, { clientX: 180, clientY: 180, pointerId: 1 });

    await waitFor(() => expect(commit).toHaveBeenCalledTimes(1));
  });

  it('uses desktop snapshot ids from the store for memory restore actions', async () => {
    const restore = vi.fn(async () => ({
      availableSnapshotIds: ['desktop-after'],
      project: createStarterProject(),
      revision: 4,
      saveStatus: 'saved' as const,
    }));
    replaceProjectPersistenceClientForTests(createImmediateBrowserClient({ restore }));
    resetAppStoreForTests();
    const memory: ProjectMemoryEntry = {
      actor: 'agent',
      changeSummary: 'Desktop snapshot is available from bridge state',
      context: { referenceAssetIds: [], resultAssetIds: [] },
      createdAt: '2026-07-14T03:00:00.000Z',
      feedback: { change: ['Use desktop snapshot ids'], keep: ['No localStorage snapshot probing'], never: ['Do not hide bridge snapshots'] },
      id: 'memory-desktop-snapshot',
      kind: 'optimization',
      nextStep: 'Restore from desktop bridge',
      projectId: createStarterProject().id,
      projectRevision: 4,
      rationale: 'Renderer must not inspect browser localStorage in desktop mode',
      schemaVersion: 1,
      snapshots: { afterId: 'desktop-after', beforeId: 'desktop-before' },
      title: 'Desktop Snapshot Memory',
    };
    useAppStore.setState({
      availableSnapshotIds: ['desktop-after'],
      persistenceMode: 'desktop',
      project: { ...createStarterProject(), projectMemory: [memory] },
      saveStatus: 'saved',
    });

    render(<CanvasWorkspace />);
    fireEvent.click(screen.getByRole('tab', { name: '记忆' }));
    fireEvent.click(screen.getByRole('button', { name: /^恢复 Desktop Snapshot Memory$/ }));

    await waitFor(() => expect(restore).toHaveBeenCalledWith('desktop-after'));
  });

  it('passes store knowledge state and lease pinning into the production reverse agent', async () => {
    const getLease = vi.fn((runId, capability, references, citations) => createAgentKnowledgeLease({
      runId,
      capability,
      snapshots: [{
        knowledgeBaseId: 'scene-skill',
        version: 7,
        contentHash: 'a'.repeat(64),
      }],
      references,
      citations,
    }, {
      leaseId: 'lease-production',
      createdAt: '2026-07-15T08:00:00.000Z',
    }));
    replaceKnowledgeClientForTests(createKnowledgeClient({ getLease }));
    resetAppStoreForTests();
    const project = createStarterProject();
    useAppStore.setState({
      knowledgeBases: [knowledgeState()],
      project: {
        ...project,
        nodes: project.nodes.map((node) => node.type === 'placement_preview'
          ? {
              ...node,
              data: {
                ...node.data,
                objects: [{
                  ...node.data.objects[0]!,
                  assetId: 'uploaded-product',
                  id: 'uploaded-product',
                }],
              },
            }
          : node),
      },
    });

    render(<CanvasWorkspace />);
    fireEvent.click(screen.getByRole('button', { name: '开始反推' }));

    await waitFor(() => expect(getLease).toHaveBeenCalledTimes(1));
    expect(screen.getByText('scene-skill@7 updated 2026-07-15T08:00:00.000Z')).toBeInTheDocument();
    expect(screen.getByText(/Pinned scene-skill@7/)).toBeInTheDocument();
  });

  it('clears an uncommitted workspace preview when reference dragging is cancelled', () => {
    const commit = vi.fn(async ({ nextProject }: ProjectCommitRequest): Promise<ProjectCommitResult> => ({
      ok: true,
      project: nextProject,
      revision: 1,
    }));
    replaceProjectPersistenceClientForTests(createImmediateBrowserClient({ commit }));
    resetAppStoreForTests();
    const project = createStarterProject();
    useAppStore.setState({
      project: {
        ...project,
        nodes: project.nodes.map((node) => node.type === 'placement_preview'
          ? {
              ...node,
              data: {
                ...node.data,
                objects: [
                  { ...node.data.objects[0]!, id: 'product', assetId: 'product', name: 'Product' },
                  { ...node.data.objects[0]!, id: 'scene', assetId: 'scene', name: 'Scene', role: 'scene_composition' },
                ],
              },
            }
          : node),
      },
    });

    render(<CanvasWorkspace />);
    fireEvent.dragStart(screen.getByText('Scene'));
    fireEvent.dragOver(screen.getByText('Product'));
    expect(screen.getByRole('button', { name: 'Move Scene up' })).toBeDisabled();

    fireEvent.dragEnd(screen.getByText('Scene'));

    expect(screen.getByRole('button', { name: 'Move Product up' })).toBeDisabled();
    expect(commit).not.toHaveBeenCalled();
  });
  it('shares persisted reference order and structured citations with reverse prompt', async () => {
    const commit = vi.fn(async ({ nextProject }: ProjectCommitRequest): Promise<ProjectCommitResult> => ({
      ok: true,
      project: nextProject,
      revision: 1,
    }));
    replaceProjectPersistenceClientForTests(createImmediateBrowserClient({ commit }));
    const getLease = vi.fn((runId, capability, references, citations) => createAgentKnowledgeLease({
      runId,
      capability,
      snapshots: [],
      references,
      citations,
    }, {
      leaseId: 'lease-shared-context',
      createdAt: '2026-07-15T08:00:00.000Z',
    }));
    replaceKnowledgeClientForTests(createKnowledgeClient({ getLease }));
    resetAppStoreForTests();
    const project = createStarterProject();
    useAppStore.setState({
      project: {
        ...project,
        nodes: project.nodes.map((node) => node.type === 'placement_preview'
          ? {
              ...node,
              data: {
                ...node.data,
                objects: [
                  { ...node.data.objects[0]!, id: 'product', assetId: 'product', name: 'Product' },
                  { ...node.data.objects[0]!, id: 'scene', assetId: 'scene', name: 'Scene', role: 'scene_composition' },
                ],
              },
            }
          : node),
      },
    });

    render(<CanvasWorkspace />);
    fireEvent.dragStart(screen.getByText('Scene'));
    fireEvent.dragOver(screen.getByText('Product'));
    expect(commit).not.toHaveBeenCalled();
    fireEvent.drop(screen.getByText('Product'));
    await waitFor(() => expect(commit).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: 'Mention image' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Mention Scene' }));
    fireEvent.click(screen.getByRole('button', { name: '发送消息' }));
    expect(useAppStore.getState().agentPlan?.transaction.operations[0]).toMatchObject({
      kind: 'update_node',
      node: { data: { prompt: '@Scene' } },
    });
    fireEvent.click(screen.getByRole('tab', { name: '对话' }));
    expect(screen.getByLabelText('向 Agent 发送消息')).toHaveValue('');

    fireEvent.click(screen.getByRole('button', { name: 'Move Product up' }));
    await waitFor(() => expect(commit).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: 'Mention image' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Mention Product' }));
    expect(screen.getByLabelText('向 Agent 发送消息')).toHaveValue('@Product');

    const run = document.querySelector<HTMLButtonElement>('.reverse-agent__run');
    if (!run) throw new Error('Missing reverse prompt button');
    fireEvent.click(run);

    await waitFor(() => expect(getLease).toHaveBeenCalledTimes(1));
    expect(getLease.mock.calls[0]![2].map((reference: { assetId: string }) => reference.assetId)).toEqual(['scene', 'product']);
    expect(getLease.mock.calls[0]![2].map((reference: { role: string }) => reference.role)).toEqual(['scene_composition', 'product_identity']);
    expect(getLease.mock.calls[0]![3]).toEqual([{ assetId: 'scene', label: 'Scene' }]);
  });
  it('records reverse-prompt feedback as durable memory and pending review without auto-approving', async () => {
    const commit = vi.fn(async ({ nextProject }: ProjectCommitRequest): Promise<ProjectCommitResult> => ({
      ok: true,
      project: nextProject,
      revision: 1,
    }));
    const review = vi.fn();
    replaceProjectPersistenceClientForTests(createImmediateBrowserClient({ commit }));
    replaceKnowledgeClientForTests(createKnowledgeClient({
      getLease: (runId, capability, references, citations) => createAgentKnowledgeLease({
        runId,
        capability,
        snapshots: [],
        references,
        citations,
      }, {
        leaseId: 'lease-workspace-feedback',
        createdAt: '2026-07-15T08:00:00.000Z',
      }),
      review,
    }));
    resetAppStoreForTests();
    const project = createStarterProject();
    useAppStore.setState({
      project: {
        ...project,
        nodes: project.nodes.map((node) => node.type === 'placement_preview'
          ? {
              ...node,
              data: {
                ...node.data,
                objects: [{
                  ...node.data.objects[0]!,
                  assetId: 'scene',
                  id: 'scene',
                  name: 'Scene',
                  role: 'scene_composition',
                }],
              },
            }
          : node),
      },
    });

    render(<CanvasWorkspace />);
    const run = document.querySelector<HTMLButtonElement>('.reverse-agent__run');
    if (!run) throw new Error('Missing reverse prompt button');
    fireEvent.click(run);
    await waitFor(() => expect(document.querySelector('.reverse-result')).not.toBeNull());
    const feedbackBox = screen.getByLabelText(/^Feedback for /);
    fireEvent.change(feedbackBox, { target: { value: 'Keep the atmosphere but simplify props.' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save feedback for / }));

    await waitFor(() => expect(useAppStore.getState().project.projectMemory).toHaveLength(1));
    expect(useAppStore.getState().project.projectMemory[0]).toMatchObject({
      kind: 'user_feedback',
      context: {
        knowledgeLease: { leaseId: 'lease-workspace-feedback' },
        references: [{ assetId: 'scene', label: 'Scene', role: 'scene_composition', position: 0 }],
        citations: [],
      },
      feedback: {
        change: ['Keep the atmosphere but simplify props.'],
      },
    });
    expect(useAppStore.getState().project.skillPromotionCandidates).toMatchObject([{
      reviewStatus: 'pending_review',
      sourceProjectMemoryId: useAppStore.getState().project.projectMemory[0]?.id,
    }]);
    expect(review).not.toHaveBeenCalled();
  });
  it('shows a specific notice after desktop revision conflicts', () => {
    resetAppStoreForTests();
    useAppStore.setState({
      saveErrorCode: 'REVISION_CONFLICT',
      saveStatus: 'error',
    });

    render(<CanvasWorkspace />);

    expect(screen.getByText('桌面项目已更新，已重新载入最新版本')).toBeInTheDocument();
  });

  it('previews, confirms, and undoes an Agent canvas plan as one transaction', async () => {
    replaceModelJobExecutorForTests({
      submit: vi.fn(async (job) => ({ providerTaskId: `task-${job.id}` })),
      poll: vi.fn(async () => ({ status: 'running' as const, progress: 0.5 })),
      cancel: vi.fn(async () => {}),
    });
    installProviderProfilesForModelJobTests();
    render(<CanvasWorkspace />);
    await waitFor(() => expect(screen.getByTestId('model-route-image-generation')).toBeVisible());
    fireEvent.change(screen.getByLabelText('向 Agent 发送消息'), { target: { value: '制作一张高端产品海报' } });
    fireEvent.click(screen.getByLabelText('发送消息'));

    expect(screen.getByLabelText('Agent 方案预览')).toBeVisible();
    expect(screen.getByText('创建审核节点')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('确认模型执行'));
    fireEvent.click(screen.getByRole('button', { name: '确认执行' }));
    await waitFor(() => expect(useAppStore.getState().project.nodes.some((node) => node.type === 'review')).toBe(true));
    expect(useAppStore.getState().project.edges.find((edge) => edge.id.startsWith('agent-edge-'))?.label).toBeUndefined();
    expect(useAppStore.getState().confirmedModelJobs).toBe(1);
    expect(screen.getByText('1 个任务运行中')).toBeInTheDocument();
    expect(useAppStore.getState().agentPlan?.state).toBe('reviewing_results');

    fireEvent.click(screen.getByLabelText('撤销'));
    await waitFor(() => expect(useAppStore.getState().project.nodes.some((node) => node.type === 'review')).toBe(false));
    expect(useAppStore.getState().project.edges).toHaveLength(2);
    const prompt = useAppStore.getState().project.nodes.find((node) => node.type === 'prompt');
    expect(prompt?.type === 'prompt' ? prompt.data.prompt : '').toBe('等待确认后执行模型任务');
  });

  it('hides edit-only provider profiles from the image generation route selector', async () => {
    installProviderProfilesForModelJobTests([
      {
        provider: 'comfly',
        modelRoute: 'image-edit-only-route',
        displayName: 'Image Edit Only',
        modelId: 'edit-only-model',
        capabilities: ['image_edit', 'async_tasks'],
      },
      {
        provider: 'comfly',
        modelRoute: 'image-generation',
        displayName: 'GPT Image',
        modelId: 'gpt-image-1',
        capabilities: ['image_generation', 'async_tasks'],
      },
    ]);

    render(<CanvasWorkspace />);

    await waitFor(() => expect(screen.getByTestId('model-route-image-generation')).toBeVisible());
    expect(screen.queryByTestId('model-route-image-edit-only-route')).not.toBeInTheDocument();
  });

  it('cancels an Agent plan without showing it as applied', () => {
    render(<CanvasWorkspace />);
    fireEvent.change(screen.getByLabelText('向 Agent 发送消息'), { target: { value: '先预览，不要执行' } });
    fireEvent.click(screen.getByLabelText('发送消息'));
    fireEvent.click(screen.getByRole('button', { name: '取消方案' }));

    expect(useAppStore.getState().agentPlan).toBeNull();
    expect(screen.queryByText('方案已应用')).not.toBeInTheDocument();
  });

  it('keeps a post-commit model queue retry visible in the plan tab', () => {
    useAppStore.setState({
      agentPlan: {
        id: 'agent-plan-retry-visible',
        state: 'waiting_for_job_retry',
        transaction: {
          id: 'agent-tx-retry-visible',
          label: 'Committed canvas, retry models',
          operations: [{
            kind: 'create_node',
            node: {
              id: 'review-retry-visible',
              type: 'review',
              position: { x: 320, y: 220 },
              data: { keep: ['product'], change: ['scene'], never: [] },
            },
          }],
        },
        requestedCapabilities: ['model_execution'],
        confirmations: {
          canvas: '2026-07-16T09:00:00.000Z',
          models: '2026-07-16T09:00:00.000Z',
        },
        conflicts: ['model queue unavailable: retry model enqueue after the current commit settles'],
        jobCount: 1,
        modelRoute: 'image-generation',
        modelRouteDisplayName: 'GPT Image',
      },
    });

    render(<CanvasWorkspace />);
    fireEvent.click(screen.getByTestId('agent-tab-plan'));

    expect(screen.getByTestId('plan-job-retry-state')).toBeVisible();
    expect(screen.getByTestId('plan-retry-jobs')).toHaveTextContent(/重试模型任务|Retry model tasks/i);
  });

  it('blocks image 21 before allocating a preview URL', () => {
    const project = createStarterProject();
    const objects: PlacementObject[] = Array.from({ length: 20 }, (_, index) => ({
      id: `uploaded-${index}`,
      assetId: `local-reference-${index}`,
      role: index % 4 === 0 ? 'product_identity' : index % 4 === 1 ? 'scene_composition' : index % 4 === 2 ? 'prop_reference' : 'material_lighting',
      x: 0,
      y: 0,
      w: 0.2,
      h: 0.2,
      rotation: 0,
      zIndex: index,
      locked: false,
      visible: true,
      flipX: false,
      flipY: false,
      semanticLayer: 'midground',
    }));
    useAppStore.setState({
      project: {
        ...project,
        nodes: project.nodes.map((node) => node.type === 'placement_preview'
          ? { ...node, data: { ...node.data, objects } }
          : node),
      },
    });
    const createObjectUrl = vi.fn(() => 'blob:should-not-exist');
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectUrl });

    render(<CanvasWorkspace />);
    fireEvent.click(screen.getByLabelText('摆放预览'));
    fireEvent.change(screen.getByLabelText('上传材质光照参考'), {
      target: { files: [new File(['material'], 'material.png', { type: 'image/png' })] },
    });

    expect(screen.getByRole('alert')).toHaveTextContent('参考图最多 20 张');
    expect(createObjectUrl).not.toHaveBeenCalled();
    const placement = useAppStore.getState().project.nodes.find((node) => node.type === 'placement_preview');
    expect(placement?.type === 'placement_preview' ? placement.data.objects : []).toHaveLength(20);
  });
  it('opens the dedicated project-memory timeline from the Agent memory tab', () => {
    render(<CanvasWorkspace />);
    fireEvent.click(screen.getByRole('tab', { name: '记忆' }));
    expect(screen.getByLabelText('项目记忆时间线')).toBeVisible();
  });

  it('keeps conversation, plan, and memory as distinct keyboard-navigable tab panels', () => {
    render(<CanvasWorkspace />);
    const tabs = screen.getAllByRole('tab');
    expect(screen.getAllByRole('tabpanel', { hidden: true })).toHaveLength(3);
    for (const tab of tabs) {
      const panelId = tab.getAttribute('aria-controls');
      expect(panelId).toBeTruthy();
      expect(document.getElementById(panelId!)).toHaveAttribute('role', 'tabpanel');
    }
    const conversationTab = screen.getByRole('tab', { name: '对话' });
    fireEvent.keyDown(conversationTab, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: '计划' })).toHaveFocus();
    expect(screen.getByText('暂无待确认计划')).toBeVisible();
    expect(screen.getByLabelText('反推 Agent')).not.toBeVisible();
  });

  it('moves focus to the Plan tab after submitting an Agent message', () => {
    render(<CanvasWorkspace />);
    fireEvent.change(screen.getByLabelText('向 Agent 发送消息'), { target: { value: '优化这张画布' } });

    fireEvent.click(screen.getByRole('button', { name: '发送消息' }));

    expect(screen.getByRole('tab', { name: '计划' })).toHaveFocus();
  });
});

function createKnowledgeClient(overrides: Partial<KnowledgeClient> = {}): KnowledgeClient {
  return {
    configure: overrides.configure ?? (async () => {}),
    getLease: overrides.getLease ?? (() => createAgentKnowledgeLease({
      runId: 'fallback-run',
      capability: 'reverse_prompt',
      snapshots: [],
      references: [],
      citations: [],
    }, {
      leaseId: 'fallback-lease',
      createdAt: '2026-07-15T08:00:00.000Z',
    })),
    prepareSkillCandidateReview: overrides.prepareSkillCandidateReview ?? (async () => {
      throw new Error('prepareSkillCandidateReview not expected');
    }),
    review: overrides.review ?? (async () => {
      throw new Error('review not expected');
    }),
    start: overrides.start ?? (async () => {}),
    stop: overrides.stop ?? (() => {}),
  };
}

function knowledgeState() {
  return {
    schemaVersion: 1 as const,
    knowledgeBaseId: 'scene-skill',
    displayName: 'Scene Skill',
    status: 'active' as const,
    activeVersion: 7,
    activeContentHash: 'a'.repeat(64),
    versionCount: 1,
    versions: [{
      version: 7,
      contentHash: 'a'.repeat(64),
      publishedAt: '2026-07-15T08:00:00.000Z',
      sourceDeviceId: 'device-a',
      displayName: 'Scene Skill',
    }],
    lastFailure: null,
    lastRollbackAt: null,
  };
}

function installProviderProfilesForModelJobTests(profiles = [{
  provider: 'comfly',
  modelRoute: 'image-generation',
  displayName: 'GPT Image',
  modelId: 'gpt-image-1',
  capabilities: ['image_generation', 'async_tasks'],
}]): void {
  window.novusDesktop = {
    provider: {
      ackImageJobTerminal: vi.fn(),
      cancelImageJob: vi.fn(),
      configure: vi.fn(),
      getStatus: vi.fn(async () => ({ configured: true, locked: false, encryption: 'safeStorage' as const })),
      listProfiles: vi.fn(async () => profiles),
      pollImageJob: vi.fn(),
      submitImageJob: vi.fn(),
      unlock: vi.fn(),
    },
  } as unknown as typeof window.novusDesktop;
}

function createImmediateBrowserClient(
  overrides: Partial<ProjectPersistenceClient> = {},
): ProjectPersistenceClient {
  let hydratedProject = createStarterProject();
  const hydrate = overrides.hydrate ?? (async (): Promise<ProjectHydrationResult> => ({
    availableSnapshotIds: [],
    mode: 'browser',
    project: hydratedProject,
    revision: 0,
    saveStatus: 'pending',
  }));
  return {
    close: overrides.close ?? (async () => {}),
    commit: overrides.commit ?? (async ({ nextProject }: ProjectCommitRequest): Promise<ProjectCommitResult> => {
      hydratedProject = nextProject;
      return { ok: true, project: nextProject, revision: 0 };
    }),
    hydrate,
    restore: overrides.restore ?? (async () => {
      const result = await hydrate();
      return {
        availableSnapshotIds: result.availableSnapshotIds,
        project: result.project,
        revision: result.revision,
        saveStatus: result.saveStatus === 'read_only' ? 'read_only' : 'saved',
      };
    }),
    stablePoint: overrides.stablePoint ?? (async () => {
      const result = await hydrate();
      return {
        availableSnapshotIds: result.availableSnapshotIds,
        project: result.project,
        revision: result.revision,
      };
    }),
  };
}
