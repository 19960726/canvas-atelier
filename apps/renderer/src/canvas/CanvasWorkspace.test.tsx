import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAgentKnowledgeLease, type PlacementObject, type ProjectMemoryEntry } from '@agent-canvas/domain';
import {
  createStarterProject,
  replaceKnowledgeClientForTests,
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
import { CanvasWorkspace } from './CanvasWorkspace';

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
  it('renders the canvas-first application shell', () => {
    render(<CanvasWorkspace />);
    expect(screen.getByRole('application', { name: '无限画布' })).toBeVisible();
    expect(screen.getByLabelText('选择工具')).toBeVisible();
    expect(screen.getByLabelText('Agent 面板')).toBeVisible();
    expect(screen.getByLabelText('任务队列')).toBeVisible();
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
    render(<CanvasWorkspace />);
    fireEvent.change(screen.getByLabelText('向 Agent 发送消息'), { target: { value: '制作一张高端产品海报' } });
    fireEvent.click(screen.getByLabelText('发送消息'));

    expect(screen.getByLabelText('Agent 方案预览')).toBeVisible();
    expect(screen.getByText('创建审核节点')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('确认模型执行'));
    fireEvent.click(screen.getByRole('button', { name: '确认执行' }));
    await waitFor(() => expect(useAppStore.getState().project.nodes.some((node) => node.type === 'review')).toBe(true));
    expect(useAppStore.getState().project.edges.find((edge) => edge.id.startsWith('agent-edge-'))?.label).toBeUndefined();
    expect(useAppStore.getState().confirmedModelJobs).toBe(1);
    expect(screen.getByText('1 个已确认任务待排队')).toBeInTheDocument();
    expect(useAppStore.getState().agentPlan?.state).toBe('reviewing_results');

    fireEvent.click(screen.getByLabelText('撤销'));
    await waitFor(() => expect(useAppStore.getState().project.nodes.some((node) => node.type === 'review')).toBe(false));
    expect(useAppStore.getState().project.edges).toHaveLength(2);
    const prompt = useAppStore.getState().project.nodes.find((node) => node.type === 'prompt');
    expect(prompt?.type === 'prompt' ? prompt.data.prompt : '').toBe('等待确认后执行模型任务');
  });
  it('cancels an Agent plan without showing it as applied', () => {
    render(<CanvasWorkspace />);
    fireEvent.change(screen.getByLabelText('向 Agent 发送消息'), { target: { value: '先预览，不要执行' } });
    fireEvent.click(screen.getByLabelText('发送消息'));
    fireEvent.click(screen.getByRole('button', { name: '取消方案' }));

    expect(useAppStore.getState().agentPlan).toBeNull();
    expect(screen.queryByText('方案已应用')).not.toBeInTheDocument();
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
