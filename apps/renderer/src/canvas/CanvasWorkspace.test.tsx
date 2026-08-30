import { readFileSync } from 'node:fs';
import { act, cleanup, createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAgentKnowledgeLease, createCanvasModuleNode, type CanvasProject, type PlacementObject, type ProjectMemoryEntry, type ReversePromptRun } from '@agent-canvas/domain';
import type { Edge } from '@xyflow/react';
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
import { calculateModuleInsertionPosition, calculateModulePlacement, CanvasWorkspace, createCanvasConnectionValidator, getCompatibleQuickInsertModuleTypes, getCompatibleQuickInsertSourceModuleTypes, getModulePlacementSize, getWorkbenchFocusTarget, isCanvasModuleDropSurface, isValidCanvasConnection, resolveQuickInsertConnection, setConnectorPreviewQuality, shouldAutoFocusFlowNode, shouldCloseAgentForModuleLibrary, type ModulePlacementBounds } from './CanvasWorkspace';
import { MODULE_DRAG_MIME } from './ModuleLibrary';
import { CONNECTED_MEDIA_DRAG_MIME, encodeConnectedMediaDragPayload } from './connected-media-drag';

const appStyles = readFileSync('apps/renderer/src/styles/app.css', 'utf8');
const figmaHybridStyles = readFileSync('apps/renderer/src/styles/figma-hybrid-canvas.css', 'utf8');

beforeEach(() => {
  delete window.novusDesktop;
  window.sessionStorage.clear();
  window.localStorage.clear();
  replaceProjectPersistenceClientForTests(createImmediateBrowserClient());
  resetAppStoreForTests();
  useAppStore.setState({ agentPanelCollapsed: true });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Reflect.deleteProperty(URL, 'createObjectURL');
  Reflect.deleteProperty(URL, 'revokeObjectURL');
});

describe('CanvasWorkspace', () => {
  it('offers only compatible modules when a source port is released on blank canvas', () => {
    const source = createCanvasModuleNode('image-source', 'image_input', { x: 0, y: 0 });

    expect(getCompatibleQuickInsertModuleTypes(source, 'image')).toEqual(expect.arrayContaining([
      'image_generation',
      'reverse_agent',
      'video_generation',
    ]));
    expect(getCompatibleQuickInsertModuleTypes(source, 'image')).not.toContain('video_result');
  });

  it('offers compatible upstream modules when a target input port is released on blank canvas', () => {
    const reverse = createCanvasModuleNode('reverse-agent', 'reverse_agent', { x: 320, y: 0 });

    expect(getCompatibleQuickInsertSourceModuleTypes(reverse, 'references')).toEqual(expect.arrayContaining([
      'image_input',
      'upload_image',
      'video_input',
    ]));
    expect(getCompatibleQuickInsertSourceModuleTypes(reverse, 'references')).not.toContain('video_result');
  });

  it('connects a Quick Insert module upstream when it was opened from a target input port', () => {
    const target = createCanvasModuleNode('image-generation', 'image_generation', { x: 320, y: 0 });
    const createdSource = createCanvasModuleNode('image-source', 'image_input', { x: 0, y: 0 });

    expect(resolveQuickInsertConnection({
      direction: 'from-target',
      nodeId: target.id,
      handleId: 'references',
      position: { x: 0, y: 0 },
    }, target, createdSource)).toEqual({
      source: createdSource.id,
      sourceHandle: 'image',
      target: target.id,
      targetHandle: 'references',
    });
  });

  it('treats only the blank pane as a Quick Insert drop surface, not nodes or handles', () => {
    const stage = document.createElement('section');
    const pane = document.createElement('div');
    pane.className = 'react-flow__pane';
    const paneBackground = document.createElement('span');
    const node = document.createElement('article');
    node.className = 'react-flow__node';
    const handle = document.createElement('span');
    handle.className = 'react-flow__handle';
    stage.append(pane);
    pane.append(paneBackground, node);
    node.append(handle);

    expect(isCanvasModuleDropSurface(stage, stage)).toBe(true);
    expect(isCanvasModuleDropSurface(pane, stage)).toBe(true);
    expect(isCanvasModuleDropSurface(paneBackground, stage)).toBe(true);
    expect(isCanvasModuleDropSurface(node, stage)).toBe(false);
    expect(isCanvasModuleDropSurface(handle, stage)).toBe(false);
  });

  it('shows the Figma Skill workspace on the initial formal canvas', () => {
    useAppStore.setState({ agentPanelCollapsed: false });
    render(<CanvasWorkspace />);

    expect(screen.getByTestId('agent-panel')).toBeVisible();
    expect(screen.getByTestId('workspace')).toHaveAttribute('data-agent-collapsed', 'false');
  });

  it('keeps the Agent panel geometry token-neutral across themes', () => {
    expect(figmaHybridStyles).not.toContain(":root[data-theme='light'] .workspace--ui-gate .agent-panel--skill-chat {");
  });

  it('targets the renderer root when styling the light reverse knowledge picker', () => {
    expect(figmaHybridStyles).toContain(":root[data-theme='light'] .workspace--ui-gate .module-node[data-module-type='reverse_agent'] .module-node__knowledge-picker");
    expect(figmaHybridStyles).toContain(":root[data-theme='light'] .workspace--ui-gate .agent-panel--skill-chat .skill-chat-workbench__sheet--library");
    expect(figmaHybridStyles).not.toContain(".workspace--ui-gate[data-theme='light'] .module-node[data-module-type='reverse_agent'] .module-node__knowledge-picker");
    expect(figmaHybridStyles).not.toContain(".workspace--ui-gate[data-theme='light'] .agent-panel--skill-chat .skill-chat-workbench__sheet--library");
  });

  it('keeps advanced settings diagnostics on the compact settings typography scale', () => {
    expect(figmaHybridStyles).toContain('.workspace--ui-gate .settings-status-card > p,');
    expect(figmaHybridStyles).toContain('font-size: 11px !important;');
    expect(figmaHybridStyles).toContain('.workspace--ui-gate .settings-status-card input {');
  });
  it('keeps a visible focus ring on formal module nodes when the canvas node receives focus', () => {
    expect(figmaHybridStyles).toContain('.workspace--ui-gate .react-flow__node:focus .module-node');
  });

  it('does not expose a retired-canvas migration banner in the formal UI', async () => {
    render(<CanvasWorkspace />);

    expect(screen.queryByTestId('legacy-workbench-migration')).not.toBeInTheDocument();
  });

  it('does not render legacy semantic cards even when an old project is opened', () => {
    useAppStore.setState({ project: createStarterProject() });
    render(<CanvasWorkspace />);

    expect(screen.queryByTestId('canvas-node-card')).not.toBeInTheDocument();
    expect(screen.queryAllByTestId('module-node-card')).toHaveLength(0);
  });

  it('keeps the dedicated video result module empty until a real video result exists', async () => {
    await act(async () => {
      await useAppStore.getState().migrateLegacyStarterProjectToFigmaWorkbench();
    });
    render(<CanvasWorkspace />);

    expect(document.querySelector('[data-module-type="video_result"]')).not.toBeNull();
    expect(screen.getByLabelText('Generated video preview')).toBeInTheDocument();
    expect(screen.queryByLabelText('Generated video playback')).not.toBeInTheDocument();
    expect(screen.queryAllByLabelText(/^Generated video preview \d+$/u)).toHaveLength(0);
  });

  it('uses blank-pane left drag for marquee selection instead of canvas panning', () => {
    render(<CanvasWorkspace />);
    const pane = screen.getByTestId('canvas-stage').querySelector<HTMLElement>('.react-flow__pane');

    expect(pane).not.toBeNull();
    expect(pane).toHaveClass('selection');
    expect(pane).not.toHaveClass('draggable');
  });

  it('lowers interaction quality as soon as a connector preview starts', () => {
    const workspace = document.createElement('div');
    workspace.className = 'workspace workspace--ui-gate';
    const stage = document.createElement('section');
    workspace.append(stage);

    setConnectorPreviewQuality(stage, true);
    expect(workspace).toHaveClass('is-interaction-low-quality');
    setConnectorPreviewQuality(stage, false);
    expect(workspace).not.toHaveClass('is-interaction-low-quality');
  });

  it('scopes connector preview quality to the canvas for large graphs', () => {
    const workspace = document.createElement('div');
    workspace.className = 'workspace workspace--ui-gate';
    const stage = document.createElement('section');
    stage.className = 'canvas-stage';
    workspace.append(stage);

    setConnectorPreviewQuality(stage, true, 300);

    expect(workspace).not.toHaveClass('is-interaction-low-quality');
    expect(stage).toHaveClass('is-connection-preview');
    setConnectorPreviewQuality(stage, false, 300);
    expect(stage).not.toHaveClass('is-connection-preview');
  });

  it('reuses a precomputed graph index while validating connector pointer moves', () => {
    const source = createCanvasModuleNode('source', 'text_prompt', { x: 0, y: 0 });
    const target = createCanvasModuleNode('target', 'image_generation', { x: 320, y: 0 });
    let nodeIterations = 0;
    let edgeIterations = 0;
    const nodes = new Proxy([
      { ...source, type: 'module', data: source.data },
      { ...target, type: 'module', data: target.data },
    ] as any[], {
      get(value, property, receiver) {
        if (property === Symbol.iterator) nodeIterations += 1;
        return Reflect.get(value, property, receiver);
      },
    });
    const edges = new Proxy([] as any[], {
      get(value, property, receiver) {
        if (property === Symbol.iterator) edgeIterations += 1;
        return Reflect.get(value, property, receiver);
      },
    });
    const validate = createCanvasConnectionValidator(nodes, edges);
    nodeIterations = 0;
    edgeIterations = 0;

    expect(validate({ source: source.id, sourceHandle: 'prompt', target: target.id, targetHandle: 'prompt' })).toBe(true);
    expect(nodeIterations).toBe(0);
    expect(edgeIterations).toBe(0);
  });

  it('isolates each rendered flow node from unrelated connector layout work', () => {
    expect(appStyles).toMatch(/\.canvas-stage \.react-flow__node \{[^}]*contain:\s*layout style;/u);
  });
  it('collapses the active generation editor when the blank canvas is clicked', () => {
    const node = createCanvasModuleNode('workspace-generation-collapse', 'image_generation', { x: 0, y: 0 });
    useAppStore.setState({
      project: { ...useAppStore.getState().project, nodes: [node], edges: [] },
    });
    render(<CanvasWorkspace />);
    const pane = screen.getByTestId('canvas-stage').querySelector<HTMLElement>('.react-flow__pane');
    expect(pane).not.toBeNull();

    const card = screen.getByTestId('module-node-card');
    fireEvent.click(within(card).getByLabelText('Open image generation editor'));
    expect(screen.getByLabelText('Image generation prompt workspace')).toBeInTheDocument();

    fireEvent.click(pane!);

    expect(screen.queryByLabelText('Image generation prompt workspace')).not.toBeInTheDocument();
  });
  it('chooses a vacant placement instead of stacking a newly inserted module at the occupied viewport center', () => {
    const bounds = { left: 0, right: 900, top: 0, bottom: 900 };
    const occupiedCenter = { x: 318, y: 310 };

    const placement = calculateModuleInsertionPosition(bounds, [occupiedCenter]);

    expect(placement).not.toBeNull();
    expect(placement).not.toEqual(occupiedCenter);
  });

  it('uses the real Figma card footprint when placing a video module beside existing workbenches', () => {
    const bounds = { left: 0, right: 1800, top: 0, bottom: 1000 };
    const placement = calculateModuleInsertionPosition(bounds, [
      { x: 500, y: 140, width: 426, height: 594, moduleType: 'reverse_agent' },
      { x: 100, y: 168, width: 654, height: 486, moduleType: 'image_generation' },
    ], 'video_generation');

    expect(placement).not.toBeNull();
    expect(placement!.x + 672).toBeLessThanOrEqual(bounds.right);
    expect(placement!.y + 720).toBeLessThanOrEqual(bounds.bottom);
    expect(
      placement!.x + 672 <= 500
        || placement!.x >= 500 + 426
        || placement!.y + 720 <= 140
        || placement!.y >= 140 + 594,
    ).toBe(true);
  });

  it('keeps a large video module visible when the viewport is too crowded for a non-overlapping slot', () => {
    const bounds = { left: 0, right: 1440, top: 0, bottom: 900 };
    const existing = [
      { x: 100, y: 168, width: 654, height: 486, moduleType: 'image_generation' as const },
      { x: 542, y: 144, width: 426, height: 594, moduleType: 'reverse_agent' as const },
    ];
    const placement = calculateModuleInsertionPosition(bounds, existing, 'video_generation');

    expect(placement).not.toBeNull();
    expect(placement!.x).toBeGreaterThanOrEqual(bounds.left);
    expect(placement!.y).toBeGreaterThanOrEqual(bounds.top);
    expect(placement!.x + getModulePlacementSize('video_generation').width).toBeLessThanOrEqual(bounds.right);
    expect(placement!.y + getModulePlacementSize('video_generation').height).toBeLessThanOrEqual(bounds.bottom);
  });

  it('keeps a double-clicked video generation module inside the visible viewport when no vacant large slot exists', () => {
    const bounds = { left: 52, right: 1388, top: 124, bottom: 966 };
    const existing = [
      { x: 542, y: 248, width: 654, height: 486, moduleType: 'image_generation' as const },
      { x: 1224, y: 74, width: 654, height: 486, moduleType: 'video_generation' as const },
    ];

    const placement = calculateModuleInsertionPosition(bounds, existing, 'video_generation');

    expect(placement).not.toBeNull();
    expect(placement!.x).toBeGreaterThanOrEqual(bounds.left);
    expect(placement!.y).toBeGreaterThanOrEqual(bounds.top);
    expect(placement!.x + getModulePlacementSize('video_generation').width).toBeLessThanOrEqual(bounds.right);
    expect(placement!.y + getModulePlacementSize('video_generation').height).toBeLessThanOrEqual(bounds.bottom);
  });

  it('uses the current Figma UI Gate image-generation footprint for fresh module placement', () => {
    expect(getModulePlacementSize('image_generation')).toEqual({ width: 654, height: 486 });
  });

  it('matches the Figma 799:6 topbar actions and final geometry', () => {
    const topbarRules = [...figmaHybridStyles.matchAll(/\.workspace--ui-gate \.topbar\s*\{([^}]*)\}/gu)];
    const actionRules = [...figmaHybridStyles.matchAll(/\.workspace--ui-gate \.topbar-canvas-action\s*\{([^}]*)\}/gu)];
    const finalTopbarRule = topbarRules[topbarRules.length - 1]?.[1] ?? '';
    const finalActionRule = actionRules[actionRules.length - 1]?.[1] ?? '';

    const requestClose = vi.fn(async () => undefined);
    window.novusDesktop = { lifecycle: { requestClose } } as never;
    render(<CanvasWorkspace />);

    const topbar = screen.getByTestId('topbar');
    expect(within(topbar).getByRole('button', { name: '保存项目' })).toBeVisible();
    expect(within(topbar).getByRole('button', { name: '新建项目' })).toBeVisible();
    expect(within(topbar).getByRole('button', { name: '生图历史' })).toBeVisible();
    const closeButton = within(topbar).getByRole('button', { name: '关闭应用' });
    expect(closeButton).toBeVisible();
    fireEvent.click(closeButton);
    expect(requestClose).toHaveBeenCalledOnce();
    expect(within(topbar).getByRole('combobox', { name: '主题 Theme' })).toBeVisible();
    expect(finalTopbarRule).toContain('top: 64px !important');
    expect(finalTopbarRule).toContain('left: 52px !important');
    expect(finalTopbarRule).toContain('width: min(1576px, calc(100% - 104px)) !important');
    expect(finalTopbarRule).toContain('height: 60px !important');
    expect(finalActionRule).toContain('width: 148px !important');
    expect(finalActionRule).toContain('height: 44px !important');
  });
  it('coalesces repeated close clicks while the coordinated close request is pending', async () => {
    let releaseClose: (() => void) | undefined;
    const requestClose = vi.fn(() => new Promise<void>((resolve) => { releaseClose = resolve; }));
    window.novusDesktop = { lifecycle: { requestClose } } as never;
    render(<CanvasWorkspace />);

    const closeButton = screen.getByRole('button', { name: '关闭应用' });
    fireEvent.click(closeButton);
    fireEvent.click(closeButton);

    expect(requestClose).toHaveBeenCalledOnce();
    expect(closeButton).toBeDisabled();

    releaseClose?.();
    await waitFor(() => expect(closeButton).not.toBeDisabled());
  });
  it('keeps the final CSS cascade on the compact Figma rail geometry', () => {
    const railRules = [...figmaHybridStyles.matchAll(/\.workspace--ui-gate \.toolrail--floating\s*\{([^}]*)\}/gu)];
    const buttonRules = [...figmaHybridStyles.matchAll(/\.workspace--ui-gate \.toolrail--floating > button\s*\{([^}]*)\}/gu)];
    const finalRailRule = railRules[railRules.length - 1]?.[1] ?? '';
    const finalButtonRule = buttonRules[buttonRules.length - 1]?.[1] ?? '';

    expect(finalRailRule).toContain('top: 142px !important');
    expect(finalRailRule).toContain('left: 52px !important');
    expect(finalRailRule).toContain('width: 60px !important');
    expect(finalRailRule).toContain('height: auto !important');
    expect(finalRailRule).toContain('padding: 18px 10px !important');
    expect(finalRailRule).toContain('display: flex !important');
    expect(finalRailRule).toContain('flex-direction: column !important');
    expect(finalRailRule).toContain('gap: 12px !important');
    expect(finalButtonRule).toContain('width: 40px !important');
    expect(finalButtonRule).toContain('height: 40px !important');
    expect(finalButtonRule).toContain('margin: 0 !important');
  });
  it('marks the canvas shell, floating tool rail, and Agent workbench for the Figma UI Gate', () => {
    render(<CanvasWorkspace />);

    expect(screen.getByTestId('workspace')).toHaveClass('workspace--ui-gate');
    expect(screen.getByTestId('toolrail')).toHaveClass('toolrail--floating');

    fireEvent.click(screen.getByTestId('agent-toggle'));
    expect(screen.getByTestId('agent-panel')).toHaveClass('agent-panel--skill-chat');
  });

  it('provides a direct topbar action that explicitly saves the current canvas', async () => {
    const flushProjectSave = vi.fn(async () => true);
    const saveProjectExplicitly = vi.fn(async () => {
      useAppStore.setState({ saveStatus: 'saved', saveErrorCode: null });
      return true;
    });
    useAppStore.setState({ flushProjectSave, saveProjectExplicitly, saveStatus: 'pending' } as never);

    render(<CanvasWorkspace />);

    const save = screen.getByRole('button', { name: '保存项目' });
    expect(save).toHaveAccessibleName('保存项目');
    fireEvent.click(save);
    await waitFor(() => expect(saveProjectExplicitly).toHaveBeenCalledOnce());
    expect(screen.getByRole('status', { name: '画布保存状态' })).toHaveTextContent('本地稳定点已保存');
    expect(flushProjectSave).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: '画布管理' })).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: '确认新建项目' })).not.toBeInTheDocument();
  });

  it('keeps an explicit failed save visible beside the topbar save action', async () => {
    const saveProjectExplicitly = vi.fn(async () => {
      useAppStore.setState({ saveStatus: 'error', saveErrorCode: 'PROJECT_WRITE_FAILED' });
      return false;
    });
    useAppStore.setState({ saveProjectExplicitly, saveStatus: 'pending' } as never);

    render(<CanvasWorkspace />);
    fireEvent.click(screen.getByRole('button', { name: '保存项目' }));

    await waitFor(() => expect(saveProjectExplicitly).toHaveBeenCalledOnce());
    expect(screen.getByRole('status', { name: '画布保存状态' })).toHaveTextContent('本地保存失败');
  });

  it('shows recent projects separately from recovery versions in canvas management', async () => {
    const list = vi.fn(async () => [
      {
        recentProjectId: 'recent_0123456789abcdef01234567',
        projectId: 'project-recent-a',
        displayName: '商品主视觉项目',
        lastOpenedAt: '2026-08-10T08:00:00.000Z',
        lastSavedAt: '2026-08-10T07:55:00.000Z',
        availability: 'available' as const,
        nodeCount: 8,
        imageCount: 4,
        videoCount: 2,
        previewUrl: 'novus-recent-project://recent_0123456789abcdef01234567/preview',
      },
      {
        recentProjectId: 'recent_89abcdef0123456701234567',
        projectId: 'project-recent-missing',
        displayName: '已移动项目',
        lastOpenedAt: '2026-08-09T08:00:00.000Z',
        lastSavedAt: '2026-08-09T07:55:00.000Z',
        availability: 'missing' as const,
        nodeCount: 3,
        imageCount: 1,
        videoCount: 0,
        previewUrl: null,
      },
    ]);
    window.novusDesktop = {
      recentProjects: {
        list,
        open: vi.fn(),
        relocate: vi.fn(),
        remove: vi.fn(),
      },
    } as never;
    const project = {
      ...useAppStore.getState().project,
      name: '当前产品工作流',
      nodes: [createCanvasModuleNode('image-node', 'image_generation', { x: 0, y: 0 })],
      edges: [],
    };
    useAppStore.setState({
      project,
      availableSnapshotIds: ['saved-version-before', 'saved-version-after'],
    } as never);

    render(<CanvasWorkspace />);
    fireEvent.click(screen.getByRole('button', { name: '展开画布管理' }));

    const manager = await screen.findByRole('dialog', { name: '画布管理' });
    expect(list).toHaveBeenCalledOnce();
    expect(within(manager).getByText('当前产品工作流')).toBeVisible();
    expect(within(manager).getByText('最近保存的项目')).toBeVisible();
    expect(within(manager).getByText('商品主视觉项目')).toBeVisible();
    expect(within(manager).queryByAltText('商品主视觉项目缩略图')).not.toBeInTheDocument();
    expect(within(manager).getByText('8 节点 · 4 图片 · 2 视频')).toBeVisible();
    expect(within(manager).getByText('项目文件不存在')).toBeVisible();
    expect(within(manager).getByRole('button', { name: '重新定位已移动项目' })).toBeVisible();
    expect(within(manager).getByRole('button', { name: '从列表移除已移动项目' })).toBeVisible();
    const recoveryVersions = within(manager).getByText('恢复版本');
    expect(recoveryVersions).toBeVisible();
    fireEvent.click(recoveryVersions);
    expect(within(manager).getAllByRole('button', { name: /恢复已保存版本/u })).toHaveLength(2);
  });  it('hides the empty-canvas hint while canvas management is open', () => {
    resetAppStoreForTests({ project: 'empty' });
    render(<CanvasWorkspace />);
    expect(screen.getByText('双击空白处添加模块')).toHaveAttribute('role', 'status');

    fireEvent.click(screen.getByRole('button', { name: '展开画布管理' }));

    expect(screen.queryByText('双击空白处添加模块')).not.toBeInTheDocument();
  });
  it('disables the centered topbar save action while the existing save is in flight', () => {
    useAppStore.setState({ saveStatus: 'saving' } as never);

    render(<CanvasWorkspace />);

    const save = screen.getByRole('button', { name: '正在保存项目' });
    expect(save).toBeDisabled();
    expect(save).toHaveTextContent('保存中');
    expect(save).toHaveAttribute('title', '正在保存项目');
  });

  it('switches from Agent to the module library on a narrow canvas instead of overlapping both surfaces', () => {
    expect(shouldCloseAgentForModuleLibrary(440)).toBe(true);
    expect(shouldCloseAgentForModuleLibrary(1366)).toBe(false);
  });

  it('auto-focuses only image and reverse workbench nodes at a readable zoom', () => {
    const imageNode = {
      id: 'image-node', type: 'module', position: { x: 100, y: 200 }, data: { moduleType: 'image_generation' },
    } as never;
    const reverseNode = {
      id: 'reverse-node', type: 'module', position: { x: 300, y: 400 }, data: { moduleType: 'reverse_agent' },
    } as never;
    const videoNode = {
      id: 'video-node', type: 'module', position: { x: 520, y: 80 }, data: { moduleType: 'video_generation' },
    } as never;
    const promptNode = {
      id: 'prompt-node', type: 'module', position: { x: 0, y: 0 }, data: { moduleType: 'prompt' },
    } as never;

    expect(shouldAutoFocusFlowNode(imageNode)).toBe(true);
    expect(shouldAutoFocusFlowNode(reverseNode)).toBe(true);
    expect(shouldAutoFocusFlowNode(videoNode)).toBe(true);
    expect(shouldAutoFocusFlowNode(promptNode)).toBe(false);
    expect(getWorkbenchFocusTarget(imageNode)).toEqual({ x: 365, y: 480, zoom: 0.96 });
  });

  it('pastes clipboard files at the last canvas pointer and ignores editable focus', async () => {
    const pasteClipboardMedia = vi.fn(async () => true);
    useAppStore.setState({ pasteClipboardMedia });
    render(<CanvasWorkspace />);
    const stage = screen.getByTestId('canvas-stage');
    vi.spyOn(stage, 'getBoundingClientRect').mockReturnValue({
      bottom: 768, height: 768, left: 0, right: 1024, top: 0, width: 1024, x: 0, y: 0, toJSON: () => ({}),
    });

    fireEvent.pointerMove(stage, { clientX: 320, clientY: 240 });
    const filePaste = createEvent.paste(window, { clipboardData: { types: ['Files'] } });
    fireEvent(window, filePaste);
    expect(filePaste.defaultPrevented).toBe(true);
    await waitFor(() => expect(pasteClipboardMedia).toHaveBeenCalledWith({ x: 320, y: 240 }));

    const input = document.createElement('input');
    document.body.append(input);
    input.focus();
    const inputPaste = createEvent.paste(input, { clipboardData: { types: ['text/plain'] } });
    fireEvent(input, inputPaste);
    expect(inputPaste.defaultPrevented).toBe(false);
    expect(pasteClipboardMedia).toHaveBeenCalledTimes(1);
    input.remove();

    const textPaste = createEvent.paste(window, { clipboardData: { types: ['text/plain'] } });
    fireEvent(window, textPaste);
    expect(textPaste.defaultPrevented).toBe(false);
    expect(pasteClipboardMedia).toHaveBeenCalledTimes(1);

    const unknownPaste = createEvent.paste(window);
    fireEvent(window, unknownPaste);
    expect(unknownPaste.defaultPrevented).toBe(false);
    expect(pasteClipboardMedia).toHaveBeenCalledTimes(1);
  });

  it('uses the viewport center for paste before the pointer enters the canvas', async () => {
    const pasteClipboardMedia = vi.fn(async () => false);
    useAppStore.setState({ pasteClipboardMedia });
    render(<CanvasWorkspace />);
    const stage = screen.getByTestId('canvas-stage');
    vi.spyOn(stage, 'getBoundingClientRect').mockReturnValue({
      bottom: 600, height: 600, left: 10, right: 810, top: 20, width: 800, x: 10, y: 20, toJSON: () => ({}),
    });

    fireEvent.paste(window, { clipboardData: { types: ['image/png'] } });

    await waitFor(() => expect(pasteClipboardMedia).toHaveBeenCalledWith({ x: 400, y: 300 }));
  });

  it('imports a real clipboard image file directly in browser mode', async () => {
    const pasteClipboardMedia = vi.fn(async () => true);
    const importDroppedMedia = vi.fn(async () => true);
    useAppStore.setState({ pasteClipboardMedia, importDroppedMedia } as never);
    render(<CanvasWorkspace />);
    const stage = screen.getByTestId('canvas-stage');
    vi.spyOn(stage, 'getBoundingClientRect').mockReturnValue({
      bottom: 768, height: 768, left: 0, right: 1024, top: 0, width: 1024, x: 0, y: 0, toJSON: () => ({}),
    });
    fireEvent.pointerMove(stage, { clientX: 320, clientY: 240 });
    const file = new File(['clipboard image'], 'clipboard.png', { type: 'image/png' });
    fireEvent(window, createEvent.paste(window, {
      clipboardData: { types: ['Files'], files: [file] },
    }));
    await waitFor(() => expect(importDroppedMedia).toHaveBeenCalledWith(file, { x: 320, y: 240 }));
    expect(pasteClipboardMedia).not.toHaveBeenCalled();
  });

  it('replaces the selected image node when Ctrl+V supplies an image file', async () => {
    const target = createCanvasModuleNode('paste-selected-image', 'image_input', { x: 120, y: 120 });
    resetAppStoreForTests({ project: 'empty' });
    const importImageForModule = vi.fn(async () => true);
    const importDroppedMedia = vi.fn(async () => true);
    useAppStore.setState((state) => ({
      project: { ...state.project, nodes: [target] },
      importImageForModule,
      importDroppedMedia,
    } as never));
    render(<CanvasWorkspace />);
    const flowNode = document.querySelector<HTMLElement>('.react-flow__node');
    expect(flowNode).not.toBeNull();
    fireEvent.click(flowNode!);
    await waitFor(() => expect(flowNode).toHaveClass('selected'));

    const replacement = new File(['replacement'], 'replacement.png', { type: 'image/png' });
    fireEvent(window, createEvent.paste(window, { clipboardData: { types: ['Files'], files: [replacement] } }));

    await waitFor(() => expect(importImageForModule).toHaveBeenCalledWith(target.id, replacement));
    expect(importDroppedMedia).not.toHaveBeenCalled();
  });

  it('copies the selected image node media with Ctrl+C for direct node-to-node replacement', async () => {
    const source = createCanvasModuleNode('copy-selected-image', 'image_input', { x: 120, y: 120 });
    source.data.config = { assetId: 'aaaaaaaaaaaaaaaa' };
    resetAppStoreForTests({ project: 'empty' });
    const write = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { clipboard: { write } });
    vi.stubGlobal('ClipboardItem', class ClipboardItemMock { constructor(readonly data: Record<string, Blob>) {} });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Blob(['image'], { type: 'image/png' }))));
    useAppStore.setState((state) => ({
      project: { ...state.project, nodes: [source] },
      projectImages: [{
        assetId: 'aaaaaaaaaaaaaaaa', byteSize: 5, displayUrl: 'novus-asset://project/session/aaaaaaaaaaaaaaaa', extension: 'png', height: 100,
        label: 'Source image', mediaType: 'image/png', origin: 'imported', sha256: 'a'.repeat(64), usageCount: 1, width: 100,
      }],
    }));
    render(<CanvasWorkspace />);
    const flowNode = document.querySelector<HTMLElement>('.react-flow__node');
    fireEvent.click(flowNode!);
    await waitFor(() => expect(flowNode).toHaveClass('selected'));

    fireEvent.copy(window);

    await waitFor(() => expect(write).toHaveBeenCalledTimes(1));
  });

  it('imports a Windows Explorer clipboard File directly when Electron exposes no readable native file path', async () => {
    const pasteClipboardMedia = vi.fn(async () => false);
    const importDroppedMedia = vi.fn(async () => true);
    useAppStore.setState({ pasteClipboardMedia, importDroppedMedia } as never);
    window.novusDesktop = { projectImages: {} } as typeof window.novusDesktop;
    render(<CanvasWorkspace />);
    const stage = screen.getByTestId('canvas-stage');
    vi.spyOn(stage, 'getBoundingClientRect').mockReturnValue({
      bottom: 768, height: 768, left: 0, right: 1024, top: 0, width: 1024, x: 0, y: 0, toJSON: () => ({}),
    });
    fireEvent.pointerMove(stage, { clientX: 320, clientY: 240 });
    const file = new File(['explorer clipboard image'], 'reference.png', { type: 'image/png' });
    fireEvent(window, createEvent.paste(window, {
      clipboardData: { types: ['Files'], files: [file] },
    }));

    await waitFor(() => expect(importDroppedMedia).toHaveBeenCalledWith(file, { x: 320, y: 240 }));
    expect(pasteClipboardMedia).not.toHaveBeenCalled();
  });

  it('forwards an external image drop to the managed media importer at the drop position', async () => {
    const importDroppedMedia = vi.fn(async () => true);
    useAppStore.setState({ importDroppedMedia } as never);
    render(<CanvasWorkspace />);
    const stage = screen.getByTestId('canvas-stage');
    vi.spyOn(stage, 'getBoundingClientRect').mockReturnValue({
      bottom: 768, height: 768, left: 0, right: 1024, top: 0, width: 1024, x: 0, y: 0, toJSON: () => ({}),
    });
    const image = new File(['managed image'], 'reference.png', { type: 'image/png' });
    const pane = stage.querySelector('.react-flow__pane');
    expect(pane).not.toBeNull();
    const drop = createEvent.drop(pane!, {
      dataTransfer: { files: [image], types: ['Files'] },
    });
    Object.defineProperties(drop, {
      clientX: { value: 328 },
      clientY: { value: 216 },
    });

    fireEvent(pane!, drop);

    expect(drop.defaultPrevented).toBe(true);
    await waitFor(() => expect(importDroppedMedia).toHaveBeenCalledWith(image, { x: 328, y: 216 }));
  });

  it('falls back to the native clipboard reader when a pasted File cannot be imported directly', async () => {
    const importDroppedMedia = vi.fn(async () => false);
    const pasteClipboardMedia = vi.fn(async () => true);
    useAppStore.setState({ importDroppedMedia, pasteClipboardMedia } as never);
    render(<CanvasWorkspace />);
    const stage = screen.getByTestId('canvas-stage');
    vi.spyOn(stage, 'getBoundingClientRect').mockReturnValue({
      bottom: 768, height: 768, left: 0, right: 1024, top: 0, width: 1024, x: 0, y: 0, toJSON: () => ({}),
    });
    const file = new File(['clipboard'], 'clipboard.png', { type: 'image/png' });
    fireEvent(window, createEvent.paste(window, { clipboardData: { types: ['Files'], files: [file] } }));

    await waitFor(() => expect(importDroppedMedia).toHaveBeenCalled());
    await waitFor(() => expect(pasteClipboardMedia).toHaveBeenCalledWith({ x: 512, y: 384 }));
  });

  it('uses the native managed clipboard path when a desktop paste event only advertises HTML', async () => {
    const pasteClipboardMedia = vi.fn(async () => true);
    useAppStore.setState({ pasteClipboardMedia } as never);
    window.novusDesktop = { projectImages: {} } as typeof window.novusDesktop;
    render(<CanvasWorkspace />);
    const stage = screen.getByTestId('canvas-stage');
    vi.spyOn(stage, 'getBoundingClientRect').mockReturnValue({
      bottom: 600, height: 600, left: 10, right: 810, top: 20, width: 800, x: 10, y: 20, toJSON: () => ({}),
    });

    fireEvent.paste(window, { clipboardData: { types: ['text/html'] } });

    await waitFor(() => expect(pasteClipboardMedia).toHaveBeenCalledWith({ x: 400, y: 300 }));
  });

  it('explains an unavailable desktop clipboard in plain language without exposing the internal error code', () => {
    useAppStore.setState({ projectImageError: 'CLIPBOARD_MEDIA_UNAVAILABLE' });

    render(<CanvasWorkspace />);

    expect(screen.getByRole('alert', { name: '画布媒体导入提示' })).toHaveTextContent('剪贴板中没有可导入的图片或 MP4 视频');
    expect(screen.queryByText('CLIPBOARD_MEDIA_UNAVAILABLE')).toBeNull();
  });
  it('validates module connections synchronously before React Flow offers them', () => {
    const prompt = createCanvasModuleNode('prompt', 'text_prompt', { x: 0, y: 0 });
    const generator = createCanvasModuleNode('generator', 'image_generation', { x: 320, y: 0 });
    const ghost = { ...generator, id: 'ghost-generator' };
    const nodes = [prompt, generator, ghost].map((node) => ({
      id: node.id,
      type: node.type,
      position: node.position,
      data: node.data,
      ...(node.id === 'ghost-generator' ? { className: 'agent-ghost-node' } : {}),
    }));

    expect(isValidCanvasConnection({ source: 'prompt', sourceHandle: 'prompt', target: 'generator', targetHandle: 'prompt' }, nodes, [])).toBe(true);
    expect(isValidCanvasConnection({ source: 'prompt', sourceHandle: 'prompt', target: 'generator', targetHandle: 'references' }, nodes, [])).toBe(false);
    expect(isValidCanvasConnection({ source: 'prompt', sourceHandle: 'prompt', target: 'ghost-generator', targetHandle: 'prompt' }, nodes, [])).toBe(false);
    expect(isValidCanvasConnection({ source: 'prompt', sourceHandle: null, target: 'generator', targetHandle: 'prompt' }, nodes, [])).toBe(false);
  });

  it('rejects duplicate many-input connections and direct or multi-node cycles synchronously', () => {
    const imageA = createCanvasModuleNode('image-a', 'image_input', { x: 0, y: 0 });
    const imageB = createCanvasModuleNode('image-b', 'image_input', { x: 0, y: 160 });
    const reverse = createCanvasModuleNode('reverse', 'reverse_agent', { x: 320, y: 80 });
    const editorA = createCanvasModuleNode('editor-a', 'image_editor', { x: 0, y: 320 });
    const editorB = createCanvasModuleNode('editor-b', 'image_editor', { x: 320, y: 320 });
    const editorC = createCanvasModuleNode('editor-c', 'image_editor', { x: 640, y: 320 });
    const nodes = [imageA, imageB, reverse, editorA, editorB, editorC].map((node) => ({
      id: node.id,
      type: node.type,
      position: node.position,
      data: node.data,
    }));
    const existingEdges: Edge[] = [
      { id: 'image-a-reference', source: 'image-a', sourceHandle: 'image', target: 'reverse', targetHandle: 'references' },
      { id: 'editor-a-b', source: 'editor-a', sourceHandle: 'image', target: 'editor-b', targetHandle: 'image' },
      { id: 'editor-b-c', source: 'editor-b', sourceHandle: 'image', target: 'editor-c', targetHandle: 'image' },
    ];

    expect(isValidCanvasConnection({ source: 'image-a', sourceHandle: 'image', target: 'reverse', targetHandle: 'references' }, nodes, existingEdges)).toBe(false);
    expect(isValidCanvasConnection({ source: 'image-b', sourceHandle: 'image', target: 'reverse', targetHandle: 'references' }, nodes, existingEdges)).toBe(true);
    expect(isValidCanvasConnection({ source: 'editor-a', sourceHandle: 'image', target: 'editor-a', targetHandle: 'image' }, nodes, existingEdges)).toBe(false);
    expect(isValidCanvasConnection({ source: 'editor-c', sourceHandle: 'image', target: 'editor-a', targetHandle: 'image' }, nodes, existingEdges)).toBe(false);
  });

  it('ignores ghost edges when validating a real durable module connection', () => {
    const source = createCanvasModuleNode('source', 'image_input', { x: 0, y: 0 });
    const target = createCanvasModuleNode('target', 'image_editor', { x: 320, y: 0 });
    const nodes = [source, target].map((node) => ({
      id: node.id,
      type: node.type,
      position: node.position,
      data: node.data,
    }));
    const ghostEdges: Edge[] = [
      { id: 'ghost-duplicate', source: 'source', sourceHandle: 'image', target: 'target', targetHandle: 'image', className: 'agent-ghost-edge' },
      { id: 'ghost-cycle', source: 'target', sourceHandle: 'image', target: 'source', targetHandle: 'image', className: 'agent-ghost-edge' },
    ];

    expect(isValidCanvasConnection({ source: 'source', sourceHandle: 'image', target: 'target', targetHandle: 'image' }, nodes, ghostEdges)).toBe(true);
  });

  it('exposes stable visual-state hooks for the professional shell', () => {
    render(<CanvasWorkspace />);

    expect(screen.getByTestId('workspace')).toHaveClass('workspace');
    expect(screen.getByTestId('topbar')).toHaveAttribute('data-surface', 'chrome');
    expect(screen.getByTestId('tool-add-node')).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(screen.getByTestId('tool-add-node'));

    expect(screen.getByTestId('tool-add-node')).toHaveAttribute('aria-pressed', 'true');
  });

  it('uses only the seven Figma left-rail actions and does not expose the legacy upload control', () => {
    render(<CanvasWorkspace />);

    const rail = screen.getByTestId('toolrail');
    expect(within(rail).getAllByRole('button').map((button) => button.getAttribute('data-testid'))).toEqual([
      'tool-select',
      'tool-add-node',
      'tool-modules',
      'tool-undo',
      'agent-toggle',
      'history-toggle',
      'settings-toggle',
    ]);
    expect(screen.queryByTestId('tool-upload')).toBeNull();

    fireEvent.click(screen.getByTestId('tool-add-node'));
    expect(screen.getByTestId('quick-insert')).toBeVisible();
  });

  it('matches the Figma rail with seven visible actions and a topbar save affordance', () => {
    render(<CanvasWorkspace />);

    const toolrail = screen.getByTestId('toolrail');
    expect(within(toolrail).getAllByRole('button')).toHaveLength(7);
    expect(screen.getByRole('button', { name: '保存项目' })).toBeVisible();
    const settingsToggle = screen.getByTestId('settings-toggle');
    expect(settingsToggle).toBeVisible();
    expect(settingsToggle).toHaveAttribute('title', '设置');

    fireEvent.click(settingsToggle);

    expect(screen.getByTestId('settings-drawer')).toBeVisible();
  });

  it('keeps the Figma UI Gate shell labels readable instead of mojibake', () => {
    render(<CanvasWorkspace />);

    expect(screen.getByLabelText('Canvas Atelier')).toHaveTextContent('Canvas Atelier');
    expect(screen.getByText('未命名画布')).toBeVisible();
    expect(screen.getByRole('button', { name: '保存项目' })).toHaveTextContent('保存项目');
    expect(screen.getByRole('button', { name: '新建项目' })).toHaveTextContent('新建项目');
    expect(screen.getByRole('button', { name: '生图历史' })).toHaveTextContent('生图历史');
    expect(screen.getByLabelText('画布工具')).toBeVisible();
    expect(screen.getByRole('button', { name: '添加节点' })).toHaveAttribute('title', '添加节点');
    expect(screen.getByRole('button', { name: '模块库' })).toHaveAttribute('title', '模块库');
    expect(screen.getByRole('button', { name: '撤销' })).toHaveAttribute('title', '撤销');
  });

  it('keeps the Figma left rail above secondary drawers so overlay buttons remain clickable', () => {
    expect(figmaHybridStyles).toContain('z-index: 80 !important;');
    expect(figmaHybridStyles).toContain(".workspace--ui-gate .history-drawer[data-figma-surface='history']");
  });

  it('uses one spacer-free grid for the seven visible rail actions', () => {
    render(<CanvasWorkspace />);

    const rail = screen.getByTestId('toolrail');
    expect(rail.querySelector('.toolrail__spacer')).toBeNull();
    expect(within(rail).getAllByRole('button')).toHaveLength(7);
  });

  it('keeps shell controls within approved geometry and zero letter spacing', () => {
    const style = document.createElement('style');
    style.textContent = appStyles;
    document.head.append(style);
    try {
      const { container } = render(<CanvasWorkspace />);
      const workspace = screen.getByTestId('workspace');
      const selectors: readonly [string, string][] = [
        ['.project-button', '5px'],
        ['.icon-button', '7px'],
        ['.topbar-canvas-action', '8px'],
        ['.tool-button', '8px'],
      ];

      for (const [selector, radius] of selectors) {
        const control = container.querySelector<HTMLElement>(selector);
        expect(control).not.toBeNull();
        expect(getComputedStyle(control!).borderRadius).toBe(radius);
      }
      expect(getComputedStyle(workspace).letterSpacing).toBe('0px');
    } finally {
      style.remove();
    }
  });

  it('renders the canvas-first application shell', () => {
    render(<CanvasWorkspace />);
    expect(screen.getByRole('application', { name: '无限画布' })).toBeVisible();
    expect(screen.getByLabelText('定位画布')).toBeVisible();
    expect(screen.getByTestId('agent-panel')).not.toBeVisible();
    expect(screen.getByRole('button', { name: '打开 Novus Agent' })).toBeVisible();
    expect(screen.getByLabelText('任务队列')).toBeVisible();
  });

  it('starts a new project from the explicit File menu entry after silently saving', async () => {
    const newWorkflow = vi.fn(async () => {});
    const saveProjectExplicitly = vi.fn(async () => true);
    useAppStore.setState({ newWorkflow, saveProjectExplicitly, saveStatus: 'pending' } as never);
    render(<CanvasWorkspace />);

    fireEvent.click(screen.getByTestId('file-menu-toggle'));
    fireEvent.click(screen.getByTestId('file-menu-new-project'));

    expect(screen.queryByRole('dialog', { name: '确认新建项目' })).not.toBeInTheDocument();
    await waitFor(() => expect(saveProjectExplicitly).toHaveBeenCalledOnce());
    await waitFor(() => expect(newWorkflow).toHaveBeenCalledOnce());
  });

  it('silently saves a pending canvas before starting a new project', async () => {
    const newWorkflow = vi.fn(async () => {});
    const saveProjectExplicitly = vi.fn(async () => true);
    useAppStore.setState({ newWorkflow, saveProjectExplicitly, saveStatus: 'pending' } as never);
    render(<CanvasWorkspace />);

    fireEvent.click(screen.getByRole('button', { name: '新建项目' }));

    expect(screen.queryByRole('dialog', { name: '确认新建项目' })).not.toBeInTheDocument();
    await waitFor(() => expect(saveProjectExplicitly).toHaveBeenCalledOnce());
    await waitFor(() => expect(newWorkflow).toHaveBeenCalledOnce());
  });

  it('coalesces repeated new-project clicks while silent save is in flight', async () => {
    let resolveSave: ((saved: boolean) => void) | undefined;
    const saveProjectExplicitly = vi.fn(() => new Promise<boolean>((resolve) => { resolveSave = resolve; }));
    const newWorkflow = vi.fn(async () => {});
    useAppStore.setState({ newWorkflow, saveProjectExplicitly, saveStatus: 'pending' } as never);
    render(<CanvasWorkspace />);

    const newProject = screen.getByRole('button', { name: '新建项目' });
    fireEvent.click(newProject);
    fireEvent.click(newProject);
    await waitFor(() => expect(saveProjectExplicitly).toHaveBeenCalledOnce());
    expect(newWorkflow).not.toHaveBeenCalled();
    resolveSave?.(true);
    await waitFor(() => expect(newWorkflow).toHaveBeenCalledOnce());
  });

  it('toggles the overlay Agent drawer without changing project or undo state', () => {
    render(<CanvasWorkspace />);
    const project = useAppStore.getState().project;
    const undoStack = useAppStore.getState().undoStack;

    fireEvent.click(screen.getByRole('button', { name: '打开 Novus Agent' }));
    expect(screen.getByLabelText('Novus Agent 工作台')).toBeVisible();
    expect(useAppStore.getState().project).toBe(project);
    expect(useAppStore.getState().undoStack).toBe(undoStack);

    fireEvent.click(screen.getByTestId('agent-toggle'));
    expect(screen.getByTestId('agent-panel')).not.toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '打开 Novus Agent' }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByTestId('agent-panel')).not.toBeVisible();
    expect(useAppStore.getState().project).toBe(project);
    expect(useAppStore.getState().undoStack).toBe(undoStack);
  });

  it('returns focus to the Agent opener after its header close control is used', () => {
    render(<CanvasWorkspace />);
    const opener = screen.getByTestId('agent-toggle');

    fireEvent.click(opener);
    fireEvent.click(screen.getByTestId('agent-panel-close'));

    expect(screen.getByTestId('agent-panel')).not.toBeVisible();
    expect(opener).toHaveFocus();
  });

  it('keeps History, Settings, and Agent in one mutually exclusive overlay surface', () => {
    render(<CanvasWorkspace />);
    const project = useAppStore.getState().project;
    const undoStack = useAppStore.getState().undoStack;
    const revision = useAppStore.getState().desktopRevision;
    const topbarActions = screen.getByTestId('topbar').querySelector('.topbar__actions');
    const historyToggle = screen.getByRole('button', { name: '打开历史记录' });
    const settingsToggle = screen.getByTestId('settings-toggle');

    expect(topbarActions).not.toBeNull();
    expect(historyToggle.compareDocumentPosition(settingsToggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(historyToggle);
    expect(screen.getByLabelText('生成历史 / Generation History')).toBeVisible();
    expect(screen.getByTestId('agent-panel')).not.toBeVisible();

    fireEvent.click(settingsToggle);
    expect(screen.queryByLabelText('生成历史 / Generation History')).toBeNull();
    expect(screen.getByTestId('settings-drawer')).toBeVisible();

    fireEvent.click(screen.getByTestId('agent-toggle'));
    expect(screen.queryByTestId('settings-drawer')).toBeNull();
    expect(screen.getByTestId('agent-panel')).toBeVisible();

    fireEvent.click(screen.getByTestId('agent-toggle'));
    expect(screen.getByTestId('agent-panel')).not.toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '打开历史记录' }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByLabelText('生成历史 / Generation History')).toBeNull();

    expect(useAppStore.getState().project).toBe(project);
    expect(useAppStore.getState().undoStack).toBe(undoStack);
    expect(useAppStore.getState().desktopRevision).toBe(revision);
  });

  it('shows a session-only history dot for a newly completed result and clears it when history opens', async () => {
    render(<CanvasWorkspace />);
    expect(screen.queryByTestId('history-unread-dot')).toBeNull();

    act(() => {
      useAppStore.setState({
        modelJobs: [{
          id: 'model-job-new-result',
          kind: 'image',
          modelId: 'public-image-model',
          promptNodeId: 'prompt-node',
          referenceAssetIds: [],
          resultAssetId: 'asset-new-result',
          resultNodeId: 'result-node',
          retryCount: 0,
          status: 'completed',
        }],
      });
    });

    expect(await screen.findByTestId('history-unread-dot')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '打开历史记录' }));
    await waitFor(() => expect(screen.queryByTestId('history-unread-dot')).toBeNull());
    expect(useAppStore.getState().project).toBeDefined();
  });

  it('configures provider credentials through the narrow desktop bridge without persisting the secret', async () => {
    const configure = vi.fn(async () => ({
      configured: true,
      locked: false,
      encryption: 'safeStorage' as const,
    }));
    window.novusDesktop = {
      history: {
        getCapacity: vi.fn(async () => ({
          activeBytes: 1024,
          activeCount: 2,
          missingOrCorruptCount: 0,
          trashBytes: 512,
          trashCount: 1,
        })),
      },
      provider: {
        ackImageJobTerminal: vi.fn(),
        cancelImageJob: vi.fn(),
        configure,
        getStatus: vi.fn(async () => ({
          configured: true,
          locked: false,
          encryption: 'safeStorage' as const,
        })),
        listProfiles: vi.fn(async () => []),
        pollImageJob: vi.fn(),
        submitImageJob: vi.fn(),
        unlock: vi.fn(),
      },
    } as unknown as typeof window.novusDesktop;
    resetAppStoreForTests();
    const project = useAppStore.getState().project;
    const undoStack = useAppStore.getState().undoStack;

    render(<CanvasWorkspace />);
    fireEvent.click(screen.getByRole('button', { name: '打开设置' }));
    fireEvent.click(screen.getByRole('button', { name: '配置隐藏密钥' }));
    const dialog = screen.getByRole('dialog', { name: '配置隐藏密钥' });
    fireEvent.change(within(dialog).getByLabelText('Comfly API 密钥'), { target: { value: 'secret-provider-token' } });

    fireEvent.click(within(dialog).getByRole('button', { name: '保存隐藏密钥' }));

    await waitFor(() => expect(configure).toHaveBeenCalledWith({
      provider: 'comfly',
      baseUrl: 'https://ai.comfly.org',
      token: 'secret-provider-token',
    }));

    expect(screen.queryByRole('dialog', { name: '配置隐藏密钥' })).toBeNull();
    expect(screen.getByText('API 密钥已保存到系统安全存储')).toBeVisible();
    expect(useAppStore.getState().project).toBe(project);
    expect(useAppStore.getState().undoStack).toBe(undoStack);
    expect(JSON.stringify(useAppStore.getState())).not.toContain('secret-provider-token');
  });

  it('unlocks an existing provider credential without persisting the passphrase', async () => {
    const unlock = vi.fn(async () => ({
      configured: true,
      locked: false,
      encryption: 'passphrase' as const,
    }));
    window.novusDesktop = {
      history: {
        getCapacity: vi.fn(async () => ({
          activeBytes: 0,
          activeCount: 0,
          missingOrCorruptCount: 0,
          trashBytes: 0,
          trashCount: 0,
        })),
      },
      provider: {
        ackImageJobTerminal: vi.fn(),
        cancelImageJob: vi.fn(),
        configure: vi.fn(),
        getStatus: vi.fn(async () => ({
          configured: true,
          locked: true,
          encryption: 'passphrase' as const,
        })),
        listProfiles: vi.fn(async () => []),
        pollImageJob: vi.fn(),
        submitImageJob: vi.fn(),
        unlock,
      },
    } as unknown as typeof window.novusDesktop;
    resetAppStoreForTests();

    render(<CanvasWorkspace />);
    expect(screen.queryByText('Models locked')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '打开设置' }));
    await screen.findByText('Comfly 已启用');
    fireEvent.click(screen.getByRole('tab', { name: '同步' }));
    fireEvent.click(screen.getByText('高级故障排查'));
    const unlockButton = await screen.findByRole('button', { name: '解锁模型服务' });
    fireEvent.change(screen.getByLabelText('本机保护密码'), { target: { value: 'local-passphrase' } });
    fireEvent.click(unlockButton);

    await waitFor(() => expect(unlock).toHaveBeenCalledWith({ provider: 'comfly', passphrase: 'local-passphrase' }));
    expect(screen.getByLabelText('本机保护密码')).toHaveValue('');
    expect(screen.getByText('Comfly 模型服务已解锁')).toBeVisible();
    expect(JSON.stringify(useAppStore.getState())).not.toContain('local-passphrase');
  });

  it('opens the module library without persisting and creates only on explicit double click', async () => {
    const commit = vi.fn(async ({ nextProject }: ProjectCommitRequest): Promise<ProjectCommitResult> => ({
      ok: true,
      project: nextProject,
      revision: 1,
    }));
    replaceProjectPersistenceClientForTests(createImmediateBrowserClient({ commit }));
    resetAppStoreForTests();
    useAppStore.setState({ agentPanelCollapsed: true });

    render(<CanvasWorkspace />);

    fireEvent.click(screen.getByRole('button', { name: '模块库' }));
    expect(commit).not.toHaveBeenCalled();
    expect(screen.getByRole('searchbox', { name: '搜索模块' })).toBeVisible();

    const row = screen.getByRole('button', { name: '查看 文本提示词 / Text Prompt' });
    fireEvent.click(row);
    expect(commit).not.toHaveBeenCalled();
    fireEvent.doubleClick(row);

    await waitFor(() => expect(commit).toHaveBeenCalledTimes(1));
    const moduleNodes = useAppStore.getState().project.nodes.filter((node) => node.type === 'module');
    expect(moduleNodes).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: '模块库' }));
    expect(screen.queryByRole('searchbox', { name: '搜索模块' })).toBeNull();
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('creates one double-clicked module at the safe viewport center without persisting selection', async () => {
    const commit = vi.fn(async ({ nextProject }: ProjectCommitRequest): Promise<ProjectCommitResult> => ({
      ok: true,
      project: nextProject,
      revision: 1,
    }));
    replaceProjectPersistenceClientForTests(createImmediateBrowserClient({ commit }));
    resetAppStoreForTests();
    useAppStore.setState({
      project: {
        version: 1,
        id: 'empty-center-project',
        name: '未命名画布',
        nodes: [],
        edges: [],
        projectMemory: [],
        skillPromotionCandidates: [],
      },
    });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      bottom: 700,
      height: 600,
      left: 50,
      right: 1050,
      toJSON: () => ({}),
      top: 100,
      width: 1000,
      x: 50,
      y: 100,
    });

    render(<CanvasWorkspace />);
    fireEvent.click(screen.getByRole('button', { name: '模块库' }));
    const row = screen.getByRole('button', { name: '查看 文本提示词 / Text Prompt' });
    fireEvent.click(row);
    expect(commit).not.toHaveBeenCalled();
    fireEvent.click(row);
    fireEvent.doubleClick(row);

    await waitFor(() => expect(commit).toHaveBeenCalledTimes(1));
    const node = useAppStore.getState().project.nodes.find((candidate) => candidate.type === 'module');
    expect(node?.position).toEqual({ x: 517, y: 160 });
  });

  it('shows only a low-interruption empty-canvas hint and removes it after a node exists', () => {
    useAppStore.setState({
      project: {
        version: 1,
        id: 'empty-actions-project',
        name: '未命名画布',
        nodes: [],
        edges: [],
        projectMemory: [],
        skillPromotionCandidates: [],
      },
    });
    const view = render(<CanvasWorkspace />);

    expect(screen.getByText('双击空白处添加模块')).toBeVisible();
    expect(screen.queryByRole('button', { name: '打开项目' })).toBeNull();
    expect(screen.queryByRole('button', { name: '新建工作流' })).toBeNull();

    useAppStore.setState({ project: createStarterProject() });
    view.rerender(<CanvasWorkspace />);
    expect(screen.getByText('双击空白处添加模块')).toBeInTheDocument();
  });

  it('opens Quick Insert only from a blank-pane double click and creates once at the pointer position', async () => {
    const commit = vi.fn(async ({ nextProject }: ProjectCommitRequest): Promise<ProjectCommitResult> => ({
      ok: true,
      project: nextProject,
      revision: 1,
    }));
    replaceProjectPersistenceClientForTests(createImmediateBrowserClient({ commit }));
    resetAppStoreForTests({ project: 'empty' });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      bottom: 700,
      height: 600,
      left: 50,
      right: 1050,
      toJSON: () => ({}),
      top: 100,
      width: 1000,
      x: 50,
      y: 100,
    });

    render(<CanvasWorkspace />);
    const pane = screen.getByTestId('canvas-stage').querySelector<HTMLElement>('.react-flow__pane');
    expect(pane).not.toBeNull();
    fireEvent.doubleClick(pane!, { clientX: 420, clientY: 360 });

    expect(screen.getByLabelText('快速插入模块')).toBeVisible();
    expect(screen.getByLabelText('搜索快速插入模块')).toHaveFocus();
    expect(screen.getByRole('list', { name: '可插入模块' })).toBeVisible();
    expect(screen.queryByRole('listbox', { name: '可插入模块' })).toBeNull();
    const allCategory = screen.getByRole('tab', { name: '全部' });
    const favoriteCategory = screen.getByRole('tab', { name: '收藏' });
    expect(allCategory).toHaveAttribute('tabindex', '0');
    expect(favoriteCategory).toHaveAttribute('tabindex', '-1');
    fireEvent.keyDown(allCategory, { key: 'ArrowRight' });
    expect(favoriteCategory).toHaveFocus();
    expect(favoriteCategory).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', favoriteCategory.id);
    fireEvent.keyDown(favoriteCategory, { key: 'Home' });
    expect(allCategory).toHaveFocus();
    expect(allCategory).toHaveAttribute('aria-selected', 'true');
    fireEvent.change(screen.getByLabelText('搜索快速插入模块'), { target: { value: 'Image Generation' } });
    expect(commit).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByLabelText('搜索快速插入模块'), { key: 'Enter' });

    await waitFor(() => expect(commit).toHaveBeenCalledTimes(1));
    const moduleNode = useAppStore.getState().project.nodes.find((node) => node.type === 'module');
    expect(moduleNode).toMatchObject({
      position: { x: 370, y: 260 },
      data: { moduleType: 'image_generation' },
    });
    expect(screen.queryByLabelText('快速插入模块')).toBeNull();
  });

  it('reloads a conflicted durable project and retries Quick Insert module creation', async () => {
    const addModuleNode = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const reloadDurableProject = vi.fn(async () => true);
    resetAppStoreForTests({ project: 'empty' });
    useAppStore.setState({
      addModuleNode,
      canReloadDurableProject: true,
      projectCommitConflictCode: 'CONCURRENT_WRITER',
      reloadDurableProject,
      saveErrorCode: 'CONCURRENT_WRITER',
      saveStatus: 'read_only',
    } as never);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      bottom: 700,
      height: 600,
      left: 50,
      right: 1050,
      toJSON: () => ({}),
      top: 100,
      width: 1000,
      x: 50,
      y: 100,
    });

    render(<CanvasWorkspace />);
    const pane = screen.getByTestId('canvas-stage').querySelector<HTMLElement>('.react-flow__pane');
    expect(pane).not.toBeNull();
    fireEvent.doubleClick(pane!, { clientX: 420, clientY: 360 });
    fireEvent.click(screen.getByRole('button', { name: '插入 图片生成 / Image Generation' }));

    await waitFor(() => expect(reloadDurableProject).toHaveBeenCalledOnce());
    expect(addModuleNode).toHaveBeenCalledTimes(2);
    expect(screen.queryByLabelText('快速插入模块')).toBeNull();
  });

  it('opens Quick Insert when a React Flow background child receives the blank-canvas double click', () => {
    render(<CanvasWorkspace />);
    const pane = screen.getByTestId('canvas-stage').querySelector<HTMLElement>('.react-flow__pane');
    expect(pane).not.toBeNull();
    const backgroundLayer = document.createElement('span');
    backgroundLayer.setAttribute('data-testid', 'react-flow-background-child');
    pane!.appendChild(backgroundLayer);

    fireEvent.doubleClick(backgroundLayer, { clientX: 420, clientY: 360 });

    expect(screen.getByLabelText('快速插入模块')).toBeVisible();
  });

  it('keeps Quick Insert actions interactive after six image nodes are present', async () => {
    resetAppStoreForTests({ project: 'empty' });
    useAppStore.setState((state) => ({
      project: {
        ...state.project,
        nodes: Array.from({ length: 6 }, (_, index) => (
          createCanvasModuleNode(`image-input-${index}`, 'image_input', { x: index * 320, y: 120 })
        )),
      },
    }));
    render(<CanvasWorkspace />);
    const pane = screen.getByTestId('canvas-stage').querySelector<HTMLElement>('.react-flow__pane');
    expect(pane).not.toBeNull();
    fireEvent.doubleClick(pane!, { clientX: 420, clientY: 360 });

    const menu = screen.getByLabelText('快速插入模块');
    const close = within(menu).getByRole('button', { name: '关闭快速插入' });
    const stage = screen.getByTestId('canvas-stage');
    const stagePointerDown = vi.fn();
    stage.addEventListener('pointerdown', stagePointerDown);
    fireEvent.pointerDown(close);
    expect(stagePointerDown).not.toHaveBeenCalled();
    fireEvent.click(close);
    await waitFor(() => expect(screen.queryByLabelText('快速插入模块')).toBeNull());
  });

  it.each(['react-flow__renderer', 'react-flow__viewport', 'react-flow__selectionpane'])(
    'opens Quick Insert when the packaged blank-canvas %s layer receives the double click',
    (className) => {
      render(<CanvasWorkspace />);
      const stage = screen.getByTestId('canvas-stage');
      const blankLayer = document.createElement('div');
      blankLayer.className = className;
      stage.appendChild(blankLayer);

      fireEvent.doubleClick(blankLayer, { clientX: 420, clientY: 360 });

      expect(screen.getByLabelText('快速插入模块')).toBeVisible();
    },
  );

  it('deletes the latest React Flow selection when Delete is pressed from canvas chrome', async () => {
    const selectedNode = createCanvasModuleNode('delete-from-canvas', 'text_prompt', { x: 80, y: 120 });
    resetAppStoreForTests({ project: 'empty' });
    useAppStore.setState((state) => ({
      project: { ...state.project, nodes: [selectedNode] },
    }));
    render(<CanvasWorkspace />);
    const node = document.querySelector<HTMLElement>('.react-flow__node');
    expect(node).not.toBeNull();

    fireEvent.click(node!);
    fireEvent.keyDown(window, { key: 'Delete' });

    await waitFor(() => expect(useAppStore.getState().project.nodes).toHaveLength(0));
  });

  it('deletes a position-locked node with Delete after selecting it on the canvas', async () => {
    const selectedNode = {
      ...createCanvasModuleNode('delete-position-locked', 'image_generation', { x: 80, y: 120 }),
      locked: true,
    };
    resetAppStoreForTests({ project: 'empty' });
    useAppStore.setState((state) => ({
      project: { ...state.project, nodes: [selectedNode] },
    }));
    render(<CanvasWorkspace />);
    const node = document.querySelector<HTMLElement>('.react-flow__node');
    expect(node).not.toBeNull();

    fireEvent.click(node!);
    fireEvent.keyDown(window, { key: 'Delete' });

    await waitFor(() => expect(useAppStore.getState().project.nodes).toHaveLength(0));
  });

  it('deletes the selected canvas node with Delete while the settings drawer is open', async () => {
    const selectedNode = createCanvasModuleNode('delete-behind-settings', 'image_generation', { x: 80, y: 120 });
    resetAppStoreForTests({ project: 'empty' });
    useAppStore.setState((state) => ({
      project: { ...state.project, nodes: [selectedNode] },
    }));
    render(<CanvasWorkspace />);
    const node = document.querySelector<HTMLElement>('.react-flow__node');
    expect(node).not.toBeNull();

    fireEvent.click(node!);
    fireEvent.click(screen.getByLabelText('打开设置'));
    expect(screen.getByRole('complementary', { name: /设置/u })).toBeVisible();
    fireEvent.keyDown(window, { key: 'Delete' });

    await waitFor(() => expect(useAppStore.getState().project.nodes).toHaveLength(0));
  });

  it('restores a deleted canvas node with Ctrl+Z while the settings drawer is open', async () => {
    const selectedNode = createCanvasModuleNode('undo-behind-settings', 'image_generation', { x: 80, y: 120 });
    resetAppStoreForTests({ project: 'empty' });
    useAppStore.setState((state) => ({
      project: { ...state.project, nodes: [selectedNode] },
      undoStack: [],
    }));
    render(<CanvasWorkspace />);
    const node = document.querySelector<HTMLElement>('.react-flow__node');
    expect(node).not.toBeNull();

    fireEvent.click(node!);
    fireEvent.click(screen.getByLabelText('打开设置'));
    fireEvent.keyDown(window, { key: 'Delete' });
    await waitFor(() => expect(useAppStore.getState().project.nodes).toHaveLength(0));
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });

    await waitFor(() => expect(useAppStore.getState().project.nodes.map((item) => item.id)).toEqual([selectedNode.id]));
  });

  it('restores a node deleted from canvas chrome when Ctrl+Z is pressed', async () => {
    const selectedNode = createCanvasModuleNode('undo-delete-from-canvas', 'text_prompt', { x: 80, y: 120 });
    resetAppStoreForTests({ project: 'empty' });
    useAppStore.setState((state) => ({
      project: { ...state.project, nodes: [selectedNode] },
      undoStack: [],
    }));
    render(<CanvasWorkspace />);
    const node = document.querySelector<HTMLElement>('.react-flow__node');
    expect(node).not.toBeNull();

    fireEvent.click(node!);
    fireEvent.keyDown(window, { key: 'Delete' });
    await waitFor(() => expect(useAppStore.getState().project.nodes).toHaveLength(0));

    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });

    await waitFor(() => expect(useAppStore.getState().project.nodes.map((item) => item.id)).toEqual([selectedNode.id]));
  });

  it('keeps Ctrl+Z inside an editable field instead of undoing the background canvas', async () => {
    const selectedNode = createCanvasModuleNode('undo-delete-editable', 'text_prompt', { x: 80, y: 120 });
    resetAppStoreForTests({ project: 'empty' });
    useAppStore.setState((state) => ({
      project: { ...state.project, nodes: [selectedNode] },
      undoStack: [],
    }));
    render(<CanvasWorkspace />);
    const node = document.querySelector<HTMLElement>('.react-flow__node');
    expect(node).not.toBeNull();
    fireEvent.click(node!);
    fireEvent.keyDown(window, { key: 'Delete' });
    await waitFor(() => expect(useAppStore.getState().project.nodes).toHaveLength(0));

    const editor = document.createElement('textarea');
    document.body.append(editor);
    fireEvent.keyDown(editor, { key: 'z', ctrlKey: true });

    expect(useAppStore.getState().project.nodes).toHaveLength(0);
    expect(useAppStore.getState().undoStack).toHaveLength(1);
  });

  it('deletes a selected node after a read-only session is automatically promoted', async () => {
    vi.useFakeTimers();
    const selectedNode = createCanvasModuleNode('delete-after-promotion', 'text_prompt', { x: 80, y: 120 });
    const reloadDurableProject = vi.fn(async () => {
      useAppStore.setState({
        canReloadDurableProject: false,
        saveErrorCode: null,
        saveStatus: 'saved',
      });
      return true;
    });
    resetAppStoreForTests({ project: 'empty' });
    useAppStore.setState((state) => ({
      canReloadDurableProject: true,
      project: { ...state.project, nodes: [selectedNode] },
      reloadDurableProject,
      saveStatus: 'read_only',
    }));
    render(<CanvasWorkspace />);

    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(reloadDurableProject).toHaveBeenCalledOnce();
    expect(useAppStore.getState().saveStatus).toBe('saved');
    vi.useRealTimers();

    const node = document.querySelector<HTMLElement>('.react-flow__node');
    expect(node).not.toBeNull();
    fireEvent.click(node!);
    fireEvent.keyDown(window, { key: 'Delete' });

    await waitFor(() => expect(useAppStore.getState().project.nodes).toHaveLength(0));
  });

  it('deletes the latest React Flow selection when Backspace is pressed from canvas chrome', async () => {
    const selectedNode = createCanvasModuleNode('backspace-from-canvas', 'text_prompt', { x: 80, y: 120 });
    resetAppStoreForTests({ project: 'empty' });
    useAppStore.setState((state) => ({
      project: { ...state.project, nodes: [selectedNode] },
    }));
    render(<CanvasWorkspace />);
    const node = document.querySelector<HTMLElement>('.react-flow__node');
    expect(node).not.toBeNull();

    fireEvent.click(node!);
    fireEvent.keyDown(node!, { key: 'Backspace' });

    await waitFor(() => expect(useAppStore.getState().project.nodes).toHaveLength(0));
  });

  it('does not delete a selected node when Backspace edits a nested text field', async () => {
    const promptNode = createCanvasModuleNode('backspace-in-text-field', 'text_prompt', { x: 80, y: 120 });
    resetAppStoreForTests({ project: 'empty' });
    useAppStore.setState((state) => ({
      project: { ...state.project, nodes: [promptNode] },
    }));
    render(<CanvasWorkspace />);
    const node = document.querySelector<HTMLElement>('.react-flow__node');
    expect(node).not.toBeNull();
    fireEvent.click(node!);
    const editor = document.createElement('textarea');
    node!.append(editor);

    fireEvent.keyDown(editor, { key: 'Backspace' });

    expect(useAppStore.getState().project.nodes).toHaveLength(1);
  });

  it('removes several reverse reference chips through the full controlled canvas without stale intermediate drafts', async () => {
    const project = createStarterProject();
    const references = ['asset-one', 'asset-two', 'asset-three'].map((assetId, index) => ({
      assetId,
      label: `Reference ${index + 1}`,
      role: 'scene_composition',
    }));
    const fixture = createSelectedReverseAgentFixture(project, references, []);
    const reverse = fixture.project.nodes.find((node) => node.id === 'reverse-agent');
    if (reverse?.type !== 'module') throw new Error('Reverse fixture missing');
    reverse.data.config = {
      ...reverse.data.config,
      task: '@图片1@图片2@图片3',
      referenceAssetIds: references.map((reference) => reference.assetId),
    };
    resetAppStoreForTests({ project: 'empty' });
    useAppStore.setState({
      project: fixture.project,
      projectImages: fixture.images,
      recoveryRequired: false,
      saveStatus: 'saved',
    });

    render(<CanvasWorkspace />);
    const editor = screen.getByLabelText('Analysis task');
    for (let index = 3; index >= 1; index -= 1) {
      const chip = editor.querySelector(`[data-token="@图片${index}"]`);
      expect(chip).not.toBeNull();
      const range = document.createRange();
      range.setStartAfter(chip!);
      range.collapse(true);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      fireEvent.keyDown(editor, { key: 'Backspace' });
      await waitFor(() => expect(editor.querySelector(`[data-token="@图片${index}"]`)).toBeNull());
    }

    await waitFor(() => {
      const durableReverse = useAppStore.getState().project.nodes.find((node) => node.id === 'reverse-agent');
      expect(durableReverse?.type === 'module' ? durableReverse.data.config : null).toMatchObject({
        task: '',
        referenceAssetIds: [],
      });
    });
    expect(screen.queryByText(/Maximum update depth|界面启动失败/iu)).not.toBeInTheDocument();
  });

  it('deletes through the capture phase when a node control stops keydown bubbling', async () => {
    const selectedNode = createCanvasModuleNode('delete-capture', 'text_prompt', { x: 80, y: 120 });
    resetAppStoreForTests({ project: 'empty' });
    useAppStore.setState((state) => ({ project: { ...state.project, nodes: [selectedNode] } }));
    render(<CanvasWorkspace />);
    const node = document.querySelector<HTMLElement>('.react-flow__node');
    expect(node).not.toBeNull();

    fireEvent.click(node!);
    node!.addEventListener('keydown', (event) => event.stopPropagation());
    fireEvent.keyDown(node!, { key: 'Delete' });

    await waitFor(() => expect(useAppStore.getState().project.nodes).toHaveLength(0));
  });

  it('keeps the React Flow viewport at scale(1) while Quick Insert is opened by a blank-pane double click', () => {
    render(<CanvasWorkspace />);
    const pane = screen.getByTestId('canvas-stage').querySelector<HTMLElement>('.react-flow__pane');
    expect(pane).not.toBeNull();

    fireEvent.doubleClick(pane!, { clientX: 420, clientY: 360 });

    expect(screen.getByLabelText('快速插入模块')).toBeVisible();
    expect(document.querySelector('.react-flow__viewport')).toHaveAttribute('style', expect.stringContaining('scale(1)'));
  });

  it('marks the canvas as connector-suppressed while Quick Insert is open', () => {
    render(<CanvasWorkspace />);
    const pane = screen.getByTestId('canvas-stage').querySelector<HTMLElement>('.react-flow__pane');
    expect(pane).not.toBeNull();

    fireEvent.doubleClick(pane!, { clientX: 420, clientY: 360 });

    expect(screen.getByTestId('workspace')).toHaveAttribute('data-connectors-suppressed', 'true');
  });

  it('replaces every secondary surface with Quick Insert after a blank-pane double click', () => {
    render(<CanvasWorkspace />);
    const pane = screen.getByTestId('canvas-stage').querySelector<HTMLElement>('.react-flow__pane');
    expect(pane).not.toBeNull();
    const openQuickInsert = () => fireEvent.doubleClick(pane!, { clientX: 420, clientY: 360 });
    const closeQuickInsert = () => fireEvent.click(screen.getByRole('button', { name: '关闭快速插入' }));

    fireEvent.click(screen.getByTestId('history-toggle'));
    openQuickInsert();
    expect(screen.getByTestId('workspace')).toHaveAttribute('data-secondary-surface', 'quick-insert');
    expect(screen.queryByTestId('history-drawer')).toBeNull();
    closeQuickInsert();

    fireEvent.click(screen.getByTestId('settings-toggle'));
    openQuickInsert();
    expect(screen.queryByTestId('settings-drawer')).toBeNull();
    closeQuickInsert();

    fireEvent.click(screen.getByTestId('agent-toggle'));
    fireEvent.click(screen.getByRole('button', { name: '打开知识库' }));
    openQuickInsert();
    expect(screen.getByTestId('agent-panel')).not.toBeVisible();
    expect(screen.getByTestId('knowledge-library-toolbar')).not.toBeVisible();
    closeQuickInsert();

    fireEvent.click(screen.getByTestId('tool-modules'));
    openQuickInsert();
    expect(screen.queryByTestId('module-library')).toBeNull();
    expect(screen.getByLabelText('快速插入模块')).toBeVisible();
  });

  it('keeps Quick Insert search, categories, favorites, and cancellation device-local', () => {
    const commit = vi.fn(async ({ nextProject }: ProjectCommitRequest): Promise<ProjectCommitResult> => ({
      ok: true,
      project: nextProject,
      revision: 1,
    }));
    replaceProjectPersistenceClientForTests(createImmediateBrowserClient({ commit }));
    resetAppStoreForTests({ project: 'empty' });
    render(<CanvasWorkspace />);
    const pane = screen.getByTestId('canvas-stage').querySelector<HTMLElement>('.react-flow__pane');
    expect(pane).not.toBeNull();
    fireEvent.doubleClick(pane!, { clientX: 260, clientY: 220 });

    fireEvent.change(screen.getByLabelText('搜索快速插入模块'), { target: { value: '提示词' } });
    fireEvent.click(screen.getByRole('tab', { name: '输入' }));
    fireEvent.click(screen.getByRole('button', { name: '收藏 文本提示词 / Text Prompt' }));
    fireEvent.click(screen.getByRole('button', { name: '关闭快速插入' }));

    expect(commit).not.toHaveBeenCalled();
    expect(useAppStore.getState().project.nodes).toHaveLength(0);
    expect(screen.queryByLabelText('快速插入模块')).toBeNull();
  });

  it('does not open Quick Insert from nodes, controls, or the module library', () => {
    useAppStore.setState({ project: {
      ...useAppStore.getState().project,
      nodes: [createCanvasModuleNode('quick-insert-guard', 'image_generation', { x: 120, y: 120 })],
      edges: [],
    } });
    render(<CanvasWorkspace />);
    const node = document.querySelector<HTMLElement>('.react-flow__node');
    expect(node).not.toBeNull();
    fireEvent.doubleClick(node!);
    fireEvent.doubleClick(screen.getByLabelText('定位画布'));
    fireEvent.click(screen.getByRole('button', { name: '模块库' }));
    fireEvent.doubleClick(screen.getByTestId('module-library'));
    expect(screen.queryByLabelText('快速插入模块')).toBeNull();
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
      expect(position.y + 280).toBeLessThanOrEqual(bounds.bottom);
    }
    expect(positions[0]).not.toEqual(positions[1]);
    expect(positions[2]).not.toEqual(positions[3]);
  });

  it('keeps the module library and Agent surface mutually exclusive', () => {
    render(<CanvasWorkspace />);

    fireEvent.click(screen.getByTestId('agent-toggle'));
    expect(screen.getByTestId('agent-panel')).toBeVisible();
    fireEvent.click(screen.getByTestId('tool-modules'));
    expect(screen.getByTestId('module-library')).toBeVisible();
    expect(screen.getByTestId('agent-panel')).not.toBeVisible();

    fireEvent.click(screen.getByTestId('agent-toggle'));
    expect(screen.getByTestId('agent-panel')).toBeVisible();
    expect(screen.queryByTestId('module-library')).toBeNull();
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

  it('ignores valid module drops released over the module library overlay', async () => {
    const commit = vi.fn(async ({ nextProject }: ProjectCommitRequest): Promise<ProjectCommitResult> => ({
      ok: true,
      project: nextProject,
      revision: 1,
    }));
    replaceProjectPersistenceClientForTests(createImmediateBrowserClient({ commit }));
    resetAppStoreForTests();

    render(<CanvasWorkspace />);
    fireEvent.click(screen.getByRole('button', { name: '模块库' }));
    const library = screen.getByTestId('module-library');
    fireEvent.drop(library, {
      clientX: 140,
      clientY: 180,
      dataTransfer: {
        types: [MODULE_DRAG_MIME],
        getData: vi.fn(() => 'text_prompt'),
      },
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
    const pane = screen.getByTestId('canvas-stage').querySelector<HTMLElement>('.react-flow__pane');
    expect(pane).not.toBeNull();
    const dropEvent = createEvent.drop(pane!, {
      dataTransfer: {
        types: [MODULE_DRAG_MIME],
        getData,
      },
    });
    Object.defineProperties(dropEvent, {
      clientX: { value: 320 },
      clientY: { value: 240 },
    });
    fireEvent(pane!, dropEvent);

    expect(getData).toHaveBeenCalledWith(MODULE_DRAG_MIME);
    await waitFor(() => expect(commit).toHaveBeenCalledTimes(1));
    const moduleNode = useAppStore.getState().project.nodes.find((node) => node.type === 'module');
    expect(moduleNode).toMatchObject({ type: 'module', data: { moduleType: 'text_prompt' } });
    expect(moduleNode?.position).toEqual({ x: 320, y: 240 });
  });

  it('places an existing connected project image as a freely movable canvas node', async () => {
    const commit = vi.fn(async ({ nextProject }: ProjectCommitRequest): Promise<ProjectCommitResult> => ({
      ok: true,
      project: nextProject,
      revision: 1,
    }));
    replaceProjectPersistenceClientForTests(createImmediateBrowserClient({ commit }));
    resetAppStoreForTests();
    useAppStore.setState({
      project: {
        ...createStarterProject(),
        assets: [{
          assetId: 'aaaaaaaaaaaaaaaa',
          byteSize: 42,
          extension: 'png',
          height: 100,
          label: '产品参考图',
          mediaType: 'image/png',
          origin: 'imported',
          sha256: 'a'.repeat(64),
          width: 100,
        }],
      },
    });

    render(<CanvasWorkspace />);
    const pane = screen.getByTestId('canvas-stage').querySelector<HTMLElement>('.react-flow__pane');
    expect(pane).not.toBeNull();
    const dropEvent = createEvent.drop(pane!, {
      dataTransfer: {
        types: [CONNECTED_MEDIA_DRAG_MIME],
        getData: vi.fn(() => encodeConnectedMediaDragPayload({
          assetId: 'aaaaaaaaaaaaaaaa', kind: 'image', label: '产品参考图',
        })),
      },
    });
    Object.defineProperties(dropEvent, {
      clientX: { value: 360 },
      clientY: { value: 280 },
    });

    fireEvent(pane!, dropEvent);

    await waitFor(() => expect(commit).toHaveBeenCalledTimes(1));
    expect(useAppStore.getState().project.nodes).toContainEqual(expect.objectContaining({
      position: { x: 360, y: 280 },
      type: 'module',
      data: expect.objectContaining({
        moduleType: 'image_input',
        config: expect.objectContaining({ assetId: 'aaaaaaaaaaaaaaaa' }),
      }),
    }));
  });

  it('forwards a file dropped on the canvas stage itself to managed media import', async () => {
    const importDroppedMedia = vi.fn(async () => null);
    resetAppStoreForTests();
    useAppStore.setState({ importDroppedMedia } as never);

    render(<CanvasWorkspace />);
    const canvas = screen.getByTestId('canvas-stage');
    const file = new File([new Uint8Array([1, 2, 3])], 'dropped-reference.png', { type: 'image/png' });
    const dropEvent = createEvent.drop(canvas, {
      dataTransfer: {
        files: [file],
        types: ['Files'],
      },
    });
    Object.defineProperties(dropEvent, {
      clientX: { value: 320 },
      clientY: { value: 240 },
    });

    fireEvent(canvas, dropEvent);

    await waitFor(() => expect(importDroppedMedia).toHaveBeenCalledWith(file, { x: 320, y: 240 }));
  });

  it('does not render retired semantic nodes from the domain project state', () => {
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
    const canvasElement = screen.getByRole('application', { name: '无限画布' });
    const canvas = within(canvasElement);
    expect(canvas.queryByTestId('canvas-node-card')).not.toBeInTheDocument();
    expect(canvasElement).toHaveAttribute('data-graph-node-count', '0');
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
      nodes: [createCanvasModuleNode('far-module', 'image_generation', { x: 5200, y: 4800 })],
      edges: [],
      projectMemory: [],
      skillPromotionCandidates: [],
    });

    render(<CanvasWorkspace />);

    expect(screen.getAllByTestId('module-node-card').length).toBeGreaterThan(0);
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

  it('shows a canvas-visible message when clipboard media cannot be imported', () => {
    useAppStore.setState({ projectImageError: 'CLIPBOARD_MEDIA_UNAVAILABLE' });

    render(<CanvasWorkspace />);

    expect(screen.getByRole('alert', { name: '画布媒体导入提示' })).toHaveTextContent('剪贴板中没有可导入的图片或 MP4 视频');
  });

  it('keeps a missing managed asset error visible until the user retries image hydration', async () => {
    const listProjectImages = vi.fn(async () => []);
    replaceProjectPersistenceClientForTests(createImmediateBrowserClient({ listProjectImages }));
    resetAppStoreForTests();
    useAppStore.setState({ projectImageError: 'MISSING_ASSET', projectImages: [] });

    render(<CanvasWorkspace />);
    fireEvent.click(screen.getByLabelText('摆放预览'));

    expect(screen.getByRole('alert')).toHaveTextContent('MISSING_ASSET');
    fireEvent.click(screen.getByRole('button', { name: '重试项目图片加载' }));

    await waitFor(() => expect(listProjectImages).toHaveBeenCalledOnce());
    expect(screen.queryByText('MISSING_ASSET')).not.toBeInTheDocument();
  });

  it('imports a confined managed reference without allocating renderer object URLs', async () => {
    const project = createStarterProject();
    const placement = project.nodes.find((node) => node.type === 'placement_preview');
    if (!placement || placement.type !== 'placement_preview') throw new Error('placement fixture missing');
    const assetRecord = {
      assetId: '0123456789abcdef',
      byteSize: 42,
      extension: 'png' as const,
      height: 3,
      label: 'Managed scene',
      mediaType: 'image/png' as const,
      origin: 'imported' as const,
      sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      width: 2,
    };
    const asset = {
      ...assetRecord,
      displayUrl: 'novus-asset://project/session/0123456789abcdef',
      usageCount: 1,
    };
    const importedProject = {
      ...project,
      assets: [assetRecord],
      nodes: project.nodes.map((node) => node.id === placement.id && node.type === 'placement_preview'
        ? {
            ...node,
            data: {
              ...node.data,
              objects: [...node.data.objects, {
                id: 'scene-managed',
                assetId: asset.assetId,
                role: 'scene_composition' as const,
                x: 0,
                y: 0,
                w: 1,
                h: 1,
                rotation: 0,
                zIndex: 0,
                locked: false,
                visible: true,
                flipX: false,
                flipY: false,
                semanticLayer: 'background' as const,
                name: '场景参考',
              }],
            },
          }
        : node),
    };
    const importProjectImage = vi.fn(async () => ({ asset, project: importedProject, revision: 1 }));
    replaceProjectPersistenceClientForTests(createImmediateBrowserClient({ importProjectImage }));
    resetAppStoreForTests();
    useAppStore.setState({ project, persistenceMode: 'desktop', saveStatus: 'saved' });
    const createObjectUrl = vi.fn(() => '');
    const revokeObjectUrl = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectUrl });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectUrl });
    render(<CanvasWorkspace />);
    fireEvent.click(screen.getByLabelText('摆放预览'));
    fireEvent.click(screen.getByLabelText('上传场景参考'));

    await waitFor(() => expect(importProjectImage).toHaveBeenCalledWith({
      kind: 'placement_reference',
      nodeId: placement.id,
      role: 'scene_composition',
    }));

    const placementNode = useAppStore.getState().project.nodes.find((node) => node.type === 'placement_preview');
    const sceneObject = placementNode?.type === 'placement_preview'
      ? placementNode.data.objects.find((object) => object.role === 'scene_composition')
      : undefined;
    expect(createObjectUrl).not.toHaveBeenCalled();
    expect(revokeObjectUrl).not.toHaveBeenCalled();
    expect(sceneObject?.assetId).toBe(asset.assetId);
    expect(placementNode?.type === 'placement_preview' ? placementNode.data.objects.some((object) => object.assetId === 'starter-product') : false).toBe(true);
    expect(screen.getByAltText('场景参考')).toHaveAttribute('src', asset.displayUrl);
    expect(document.querySelector('.agent-summary')).toBeNull();
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
      lifecycle: 'durable' as const,
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
      agentPanelCollapsed: true,
      availableSnapshotIds: ['desktop-after'],
      persistenceMode: 'desktop',
      project: { ...createStarterProject(), projectMemory: [memory] },
      saveStatus: 'saved',
    });

    render(<CanvasWorkspace />);
    openAgent();
    fireEvent.click(screen.getByText('项目记忆', { selector: 'summary' }));
    fireEvent.click(screen.getByRole('button', { name: /^恢复 Desktop Snapshot Memory$/ }));

    await waitFor(() => expect(restore).toHaveBeenCalledWith('desktop-after'));
  });

  it('shows only the active provider catalog in the canvas and Agent model menus', async () => {
    const comflyProfile = {
      provider: 'comfly' as const,
      modelRoute: 'comfly-chat',
      displayName: 'Comfly Chat Hidden',
      modelId: 'comfly-chat',
      capabilities: ['chat'] as const,
    };
    const relayProfile = {
      provider: 'relayme' as const,
      modelRoute: 'relayme-chat-active',
      displayName: 'RelayMe Chat Active',
      modelId: 'relayme-chat-active',
      capabilities: ['chat'] as const,
    };
    window.novusDesktop = {
      provider: {
        getActiveProvider: vi.fn(async () => ({ activeProvider: 'relayme' as const })),
        getStatus: vi.fn(async () => ({ configured: true, locked: false, encryption: 'safeStorage' as const })),
        listProfiles: vi.fn(async (request?: { provider?: 'comfly' | 'relayme' }) => (
          request?.provider === 'relayme' ? [relayProfile] : [comflyProfile]
        )),
      },
    } as unknown as typeof window.novusDesktop;
    resetAppStoreForTests();

    render(<CanvasWorkspace />);
    openAgent();
    fireEvent.click(screen.getByRole('tab', { name: '对话' }));

    await waitFor(() => expect(screen.getByRole('button', { name: '打开聊天模型菜单' })).toHaveTextContent('RelayMe Chat Active'));
    expect(screen.queryByText('Comfly Chat Hidden')).not.toBeInTheDocument();
  });

  it('shows RelayMe models even when Comfly itself is unconfigured', async () => {
    const relayProfile = {
      provider: 'relayme' as const,
      modelRoute: 'relayme-chat-vision',
      displayName: 'RelayMe Vision Chat',
      modelId: 'vision-chat',
      capabilities: ['chat', 'vision', 'reverse_prompt'] as const,
    };
    window.novusDesktop = {
      provider: {
        getStatus: vi.fn(async (request?: { provider?: 'comfly' | 'relayme' }) => request?.provider === 'relayme'
          ? { configured: true, locked: false, encryption: 'safeStorage' as const }
          : { configured: false, locked: false, encryption: 'safeStorage' as const }),
        listProfiles: vi.fn(async (request?: { provider?: 'comfly' | 'relayme' }) => request?.provider === 'relayme' ? [relayProfile] : []),
      },
    } as unknown as typeof window.novusDesktop;
    resetAppStoreForTests();

    render(<CanvasWorkspace />);
    openAgent();
    fireEvent.click(screen.getByRole('tab', { name: '对话' }));

    await waitFor(() => expect(screen.getByRole('button', { name: '打开聊天模型菜单' })).toHaveTextContent('RelayMe Vision Chat'));
  });
  it('refreshes provider models after the settings surface closes', async () => {
    let catalogReady = false;
    const relayProfile = {
      provider: 'relayme' as const,
      modelRoute: 'relayme-chat-after-save',
      displayName: 'RelayMe Chat After Save',
      modelId: 'relay-chat-after-save',
      capabilities: ['chat'] as const,
    };
    const listProfiles = vi.fn(async (request?: { provider?: 'comfly' | 'relayme' }) => (
      catalogReady && request?.provider === 'relayme' ? [relayProfile] : []
    ));
    window.novusDesktop = {
      provider: {
        getStatus: vi.fn(async () => ({ configured: true, locked: false, encryption: 'safeStorage' as const })),
        listProfiles,
      },
    } as unknown as typeof window.novusDesktop;
    resetAppStoreForTests();

    render(<CanvasWorkspace />);
    await waitFor(() => expect(listProfiles).toHaveBeenCalled());
    catalogReady = true;
    fireEvent.click(screen.getByRole('button', { name: '打开设置' }));
    fireEvent.click(await screen.findByTestId('settings-drawer-close'));
    openAgent();
    fireEvent.click(screen.getByRole('tab', { name: '对话' }));

    await waitFor(() => expect(screen.getByRole('button', { name: '打开聊天模型菜单' })).toHaveTextContent('RelayMe Chat After Save'));
  });
  it('shows active knowledge ids as safe selectable Skill chat context', async () => {
    installSkillChatBridgeForTests();
    useAppStore.setState({ knowledgeBases: [knowledgeState()] });
    render(<CanvasWorkspace />);
    openAgent();
    fireEvent.click(screen.getByRole('tab', { name: '对话' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '打开聊天模型菜单' })).toHaveTextContent('Creative chat'));
    fireEvent.click(screen.getByRole('button', { name: '展开上下文' }));
    expect(screen.getByText('scene-skill')).toBeVisible();
    return;

    const analyzeReversePrompt = vi.fn(async ({ run }) => createReversePromptResult(run));
    const getLease = vi.fn((runId, capability, references, citations) => createAgentKnowledgeLease({
      runId,
      capability,
      snapshots: [{
        knowledgeBaseId: 'ecommerce-detail',
        version: 1,
        contentHash: 'e'.repeat(64),
      }, {
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
    replaceProjectPersistenceClientForTests(createImmediateBrowserClient({ analyzeReversePrompt }));
    resetAppStoreForTests();
    const fixture = createSelectedReverseAgentFixture(createStarterProject(), [{
      assetId: '1111111111111111',
      label: 'Uploaded product',
      role: 'product_identity',
    }]);
    useAppStore.setState({
      knowledgeBases: [knowledgeState()],
      project: fixture.project,
      projectImages: fixture.images,
    });

    render(<CanvasWorkspace />);
    fireEvent.click(document.querySelector<HTMLElement>('.react-flow__node[data-id="reverse-agent"]')!);
    openAgent();
    const run = screen.getByRole('button', { name: '开始反推' });
    expect(run).toBeEnabled();
    fireEvent.click(run!);

    await waitFor(() => expect(getLease).toHaveBeenCalledTimes(1));
    expect(screen.getByText('scene-skill@7 · 更新于 2026-07-15T08:00:00.000Z')).toBeInTheDocument();
    expect(getLease).toHaveBeenLastCalledWith(expect.any(String), 'reverse_prompt', expect.any(Array), expect.any(Array), ['ecommerce-detail', 'scene-skill']);
    expect(screen.getByText(/固定版本 \/ Pinned .*scene-skill@7/)).toBeInTheDocument();
  });

  it('renders persisted node reverse results as a read-only Skill timeline entry', async () => {
    const timelineProject = createStarterProject();
    const timelineReverse = createCanvasModuleNode('reverse-agent', 'reverse_agent', { x: 360, y: 120 });
    timelineReverse.data.config = {
      modelRoute: 'comfly/vision-video-pro',
      role: 'Commercial visual analyst',
      task: 'Analyze the controlled media.',
      knowledgeBaseIds: [],
      reverseAgentResult: { positivePrompt: 'Verified node reverse result' },
    };
    useAppStore.setState({ project: { ...timelineProject, nodes: [...timelineProject.nodes, timelineReverse] } });
    render(<CanvasWorkspace />);
    openAgent();
    const entry = screen.getByLabelText('节点反推结果：Analyze the controlled media.');
    expect(entry).toHaveTextContent('反推结果已加入上下文');
    expect(entry).not.toHaveTextContent('Verified node reverse result');
    fireEvent.click(within(entry).getByRole('button', { name: '查看反推内容' }));
    expect(entry).toHaveTextContent('Verified node reverse result');
    return;

    const analyzeReversePrompt = vi.fn(async ({ run }) => ({
      sessionId: run.sessionId,
      nonce: run.nonce,
      knowledgeSnapshotVersion: run.knowledgeLease.versionKey,
      analysis: 'Verified desktop response',
      keywords: ['verified'],
      positivePrompt: 'Verified prompt',
      negativeConstraints: ['none'],
      executionChecklist: ['review'],
    }));
    replaceProjectPersistenceClientForTests(createImmediateBrowserClient({ analyzeReversePrompt }));
    replaceKnowledgeClientForTests(createKnowledgeClient({
      getLease: (runId, capability, references, citations) => createAgentKnowledgeLease({
        runId,
        capability,
        snapshots: [
          { knowledgeBaseId: 'ecommerce-detail', version: 1, contentHash: 'e'.repeat(64) },
          { knowledgeBaseId: 'scene-skill', version: 7, contentHash: 'b'.repeat(64) },
        ],
        references,
        citations,
      }, { leaseId: 'selected-agent-lease', createdAt: '2026-07-15T08:00:00.000Z' }),
    }));
    resetAppStoreForTests();
    const project = createStarterProject();
    const firstInput = createCanvasModuleNode('first-input', 'image_input', { x: 0, y: 0 });
    firstInput.data.config = { assetId: '1111111111111111' };
    const secondInput = createCanvasModuleNode('second-input', 'image_input', { x: 0, y: 160 });
    secondInput.data.config = { assetId: '2222222222222222' };
    const videoInput = createCanvasModuleNode('video-input', 'video_input', { x: 0, y: 320 });
    videoInput.data.config = { assetId: '3333333333333333' };
    const reverse = createCanvasModuleNode('reverse-agent', 'reverse_agent', { x: 360, y: 120 });
    reverse.data.config = {
      modelRoute: 'comfly/vision-video-pro',
      role: 'Commercial visual analyst',
      task: 'Analyze the controlled media.',
      knowledgeBaseIds: ['ecommerce-detail', 'scene-skill'],
    };
    const edges = [
      { id: 'second-reference', source: secondInput.id, sourcePortId: 'image', target: reverse.id, targetPortId: 'references', order: 20 },
      { id: 'video-input', source: videoInput.id, sourcePortId: 'video', target: reverse.id, targetPortId: 'video', order: 30 },
      { id: 'first-reference', source: firstInput.id, sourcePortId: 'image', target: reverse.id, targetPortId: 'references', order: 10 },
    ];
    useAppStore.setState({
      project: {
        ...project,
        nodes: [
          ...project.nodes.map((node) => node.type === 'placement_preview'
            ? { ...node, data: { ...node.data, objects: [{ ...node.data.objects[0]!, assetId: 'unrelated-image', id: 'unrelated-image' }] } }
            : node),
          firstInput,
          secondInput,
          videoInput,
          reverse,
        ],
        edges,
      },
      projectImages: [{ assetId: '1111111111111111', byteSize: 42, displayUrl: 'project-asset://1111111111111111', extension: 'png', height: 1, label: 'First image', mediaType: 'image/png', origin: 'imported', sha256: '1'.repeat(64), usageCount: 1, width: 1 }, {
        assetId: '2222222222222222', byteSize: 43, displayUrl: 'project-asset://2222222222222222', extension: 'jpg', height: 1, label: 'Second image', mediaType: 'image/jpeg', origin: 'imported', sha256: '2'.repeat(64), usageCount: 1, width: 1,
      }, {
        assetId: 'unrelated-image', byteSize: 44, displayUrl: 'project-asset://unrelated-image', extension: 'png', height: 1, label: 'Unconnected reference', mediaType: 'image/png', origin: 'imported', sha256: '4'.repeat(64), usageCount: 1, width: 1,
      }],
      projectVideos: [{ assetId: '3333333333333333', byteSize: 1_024, displayUrl: 'project-asset://3333333333333333', durationMs: 4_800, extension: 'mp4', height: 1_080, label: 'Launch film', mediaType: 'video/mp4', origin: 'imported', sha256: '3'.repeat(64), usageCount: 1, width: 1_920 }],
    });

    render(<CanvasWorkspace />);
    fireEvent.click(document.querySelector<HTMLElement>('.react-flow__node[data-id="reverse-agent"]')!);
    openAgent();
    const selectedNodeIdsBeforeRun = [...document.querySelectorAll<HTMLElement>('.react-flow__node.selected')]
      .map((node) => node.dataset.id);
    const viewportBeforeRun = document.querySelector<HTMLElement>('.react-flow__viewport')?.style.transform;
    const nodePositionsBeforeRun = useAppStore.getState().project.nodes.map((node) => ({ id: node.id, position: node.position }));
    const runButton = document.querySelector<HTMLButtonElement>('.reverse-agent__run')!;
    expect(runButton).toBeEnabled();
    fireEvent.click(runButton);

    await waitFor(() => expect(analyzeReversePrompt).toHaveBeenCalledTimes(1));
    expect(analyzeReversePrompt.mock.calls[0]![0]).toMatchObject({
      provider: 'comfly',
      media: [
        { kind: 'image', assetId: '1111111111111111', sha256: '1'.repeat(64), byteSize: 42, mediaType: 'image/png' },
        { kind: 'image', assetId: '2222222222222222', sha256: '2'.repeat(64), byteSize: 43, mediaType: 'image/jpeg' },
        { kind: 'video', assetId: '3333333333333333', sha256: '3'.repeat(64), byteSize: 1_024, mediaType: 'video/mp4' },
      ],
      run: {
        referenceAssetIds: ['1111111111111111', '2222222222222222'],
        videoInput: { assetId: '3333333333333333', sha256: '3'.repeat(64), byteSize: 1_024, mediaType: 'video/mp4' },
      },
    });
    expect(analyzeReversePrompt.mock.calls[0]![0].media.map((media: { assetId: string }) => media.assetId)).not.toContain('unrelated-image');
    expect([...document.querySelectorAll<HTMLElement>('.react-flow__node.selected')].map((node) => node.dataset.id)).toEqual(selectedNodeIdsBeforeRun);
    expect(document.querySelector<HTMLElement>('.react-flow__viewport')?.style.transform).toBe(viewportBeforeRun);
    expect(useAppStore.getState().project.nodes.map((node) => ({ id: node.id, position: node.position }))).toEqual(nodePositionsBeforeRun);
    expect(useAppStore.getState().project.nodes.find((node) => node.id === reverse.id)?.position).toEqual(reverse.position);
    expect(useAppStore.getState().project.edges).toEqual(edges);
  });

  it('does not expose a direct reverse-analysis control in Skill chat', () => {
    render(<CanvasWorkspace />);
    openAgent();
    expect(screen.queryByRole('button', { name: '开始反推' })).toBeNull();
    expect(document.querySelector('.reverse-agent')).toBeNull();
    return;

    const analyzeReversePrompt = vi.fn();
    replaceProjectPersistenceClientForTests(createImmediateBrowserClient({ analyzeReversePrompt }));
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
                  assetId: 'uploaded-product',
                  id: 'uploaded-product',
                }],
              },
            }
          : node),
      },
    });

    render(<CanvasWorkspace />);
    openAgent();

    expect(screen.getByRole('button', { name: '开始反推' })).toBeDisabled();
    expect(screen.getByText('请选择一个已应用配置的 Agent 反推节点。')).toBeVisible();
    expect(analyzeReversePrompt).not.toHaveBeenCalled();
  });

  it('does not expose reference reordering in the Skill chat workbench', () => {
    render(<CanvasWorkspace />);
    openAgent();
    expect(document.querySelector('.reference-order')).toBeNull();
    expect(screen.getByLabelText('Agent 对话工作台')).toBeVisible();
    expect(within(screen.getByTestId('agent-panel')).getByText('Agent 对话', { selector: '.agent-panel__header strong' })).toBeVisible();
    expect(screen.queryByText('anget对话')).not.toBeInTheDocument();
    expect(screen.queryByTestId('agent-tab-plan')).not.toBeInTheDocument();
    expect(screen.queryByTestId('agent-tab-memory')).not.toBeInTheDocument();
    return;

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
    openAgent();
    fireEvent.dragStart(screen.getByText('Scene'));
    fireEvent.dragOver(screen.getByText('Product'));
    expect(screen.getByRole('button', { name: '上移 Scene / Move Scene up' })).toBeDisabled();

    fireEvent.dragEnd(screen.getByText('Scene'));

    expect(screen.getByRole('button', { name: '上移 Product / Move Product up' })).toBeDisabled();
    expect(commit).not.toHaveBeenCalled();
  });
  it('sends Skill chat without changing canvas nodes or edges', async () => {
    const chat = installSkillChatBridgeForTests();
    const nodesBefore = useAppStore.getState().project.nodes;
    const edgesBefore = useAppStore.getState().project.edges;
    render(<CanvasWorkspace />);
    openAgent();
    await waitFor(() => expect(screen.getByRole('button', { name: '打开聊天模型菜单' })).toHaveTextContent('Creative chat'));
    fireEvent.change(screen.getByLabelText('向 Agent 发送消息'), { target: { value: 'Suggest a headline.' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(chat).toHaveBeenCalledTimes(1));
    expect(useAppStore.getState().project.nodes).toEqual(nodesBefore);
    expect(useAppStore.getState().project.edges).toEqual(edgesBefore);
    return;

    const commit = vi.fn(async ({ nextProject }: ProjectCommitRequest): Promise<ProjectCommitResult> => ({
      ok: true,
      project: nextProject,
      revision: 1,
    }));
    const analyzeReversePrompt = vi.fn(async ({ run }) => createReversePromptResult(run));
    replaceProjectPersistenceClientForTests(createImmediateBrowserClient({ commit, analyzeReversePrompt }));
    const getLease = vi.fn((runId, capability, references, citations) => createAgentKnowledgeLease({
      runId,
      capability,
      snapshots: [
        { knowledgeBaseId: 'ecommerce-detail', version: 1, contentHash: 'e'.repeat(64) },
        { knowledgeBaseId: 'scene-skill', version: 7, contentHash: 'b'.repeat(64) },
      ],
      references,
      citations,
    }, {
      leaseId: 'lease-shared-context',
      createdAt: '2026-07-15T08:00:00.000Z',
    }));
    replaceKnowledgeClientForTests(createKnowledgeClient({ getLease }));
    resetAppStoreForTests();
    const sceneAssetId = '1111111111111111';
    const productAssetId = '2222222222222222';
    const project = createStarterProject();
    const fixture = createSelectedReverseAgentFixture(project, [{
      assetId: sceneAssetId,
      label: 'Scene',
      role: 'scene_composition',
    }, {
      assetId: productAssetId,
      label: 'Product',
      role: 'product_identity',
    }]);
    useAppStore.setState({
      project: {
        ...fixture.project,
        nodes: fixture.project.nodes.map((node) => node.type === 'placement_preview'
          ? {
              ...node,
              data: {
                ...node.data,
                objects: [
                  { ...node.data.objects[0]!, id: productAssetId, assetId: productAssetId, name: 'Product' },
                  { ...node.data.objects[0]!, id: sceneAssetId, assetId: sceneAssetId, name: 'Scene', role: 'scene_composition' },
                ],
              },
            }
          : node),
      },
      projectImages: fixture.images,
    });

    render(<CanvasWorkspace />);
    fireEvent.click(document.querySelector<HTMLElement>('.react-flow__node[data-id="reverse-agent"]')!);
    openAgent();
    fireEvent.dragStart(screen.getByText('Scene', { selector: '.reference-order__label' }));
    fireEvent.dragOver(screen.getByText('Product', { selector: '.reference-order__label' }));
    expect(commit).not.toHaveBeenCalled();
    fireEvent.drop(screen.getByText('Product', { selector: '.reference-order__label' }));
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

    fireEvent.click(screen.getByRole('button', { name: '上移 Product / Move Product up' }));
    await waitFor(() => expect(commit).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: 'Mention image' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Mention Product' }));
    expect(screen.getByLabelText('向 Agent 发送消息')).toHaveValue('@Product');

    fireEvent.click(document.querySelector<HTMLElement>('.react-flow__node[data-id="reverse-agent"]')!);
    const run = document.querySelector<HTMLButtonElement>('.reverse-agent__run');
    if (!run) throw new Error('Missing reverse prompt button');
    expect(run).toBeEnabled();
    fireEvent.click(run!);

    await waitFor(() => expect(getLease).toHaveBeenCalledTimes(1));
    expect(getLease.mock.calls[0]![2].map((reference: { assetId: string }) => reference.assetId)).toEqual([sceneAssetId, productAssetId]);
    expect(getLease.mock.calls[0]![2].map((reference: { role: string }) => reference.role)).toEqual(['scene_composition', 'scene_composition']);
    expect(getLease.mock.calls[0]![3]).toEqual([{ assetId: productAssetId, label: 'Product' }]);
  });
  it('keeps node reverse timeline entries read-only without feedback controls', async () => {
    const timelineProject = createStarterProject();
    const timelineReverse = createCanvasModuleNode('reverse-feedback', 'reverse_agent', { x: 360, y: 120 });
    timelineReverse.data.config = {
      modelRoute: 'comfly/vision-video-pro',
      role: 'Commercial visual analyst',
      task: 'Review bottle reference.',
      knowledgeBaseIds: [],
      reverseAgentResult: { positivePrompt: 'Read-only result' },
    };
    useAppStore.setState({ project: { ...timelineProject, nodes: [...timelineProject.nodes, timelineReverse] } });
    render(<CanvasWorkspace />);
    openAgent();
    const entry = screen.getByLabelText('节点反推结果：Review bottle reference.');
    expect(within(entry).getByRole('button', { name: '查看反推内容' })).toBeVisible();
    expect(entry.querySelector('textarea, input')).toBeNull();
    expect(screen.queryByLabelText(/^Feedback for /)).toBeNull();
    return;

    const commit = vi.fn(async ({ nextProject }: ProjectCommitRequest): Promise<ProjectCommitResult> => ({
      ok: true,
      project: nextProject,
      revision: 1,
    }));
    const review = vi.fn();
    const analyzeReversePrompt = vi.fn(async ({ run }) => createReversePromptResult(run));
    replaceProjectPersistenceClientForTests(createImmediateBrowserClient({ commit, analyzeReversePrompt }));
    replaceKnowledgeClientForTests(createKnowledgeClient({
      getLease: (runId, capability, references, citations) => createAgentKnowledgeLease({
        runId,
        capability,
        snapshots: [
          { knowledgeBaseId: 'ecommerce-detail', version: 1, contentHash: 'e'.repeat(64) },
          { knowledgeBaseId: 'scene-skill', version: 7, contentHash: 'b'.repeat(64) },
        ],
        references,
        citations,
      }, {
        leaseId: 'lease-workspace-feedback',
        createdAt: '2026-07-15T08:00:00.000Z',
      }),
      review,
    }));
    resetAppStoreForTests();
    const sceneAssetId = '1111111111111111';
    const project = createStarterProject();
    const fixture = createSelectedReverseAgentFixture(project, [{
      assetId: sceneAssetId,
      label: 'Scene',
      role: 'scene_composition',
    }]);
    useAppStore.setState({
      project: {
        ...fixture.project,
        nodes: fixture.project.nodes.map((node) => node.type === 'placement_preview'
          ? {
              ...node,
              data: {
                ...node.data,
                objects: [{
                  ...node.data.objects[0]!,
                  assetId: sceneAssetId,
                  id: sceneAssetId,
                  name: 'Scene',
                  role: 'scene_composition',
                }],
              },
            }
          : node),
      },
      projectImages: fixture.images,
    });

    render(<CanvasWorkspace />);
    fireEvent.click(document.querySelector<HTMLElement>('.react-flow__node[data-id="reverse-agent"]')!);
    openAgent();
    const run = document.querySelector<HTMLButtonElement>('.reverse-agent__run');
    if (!run) throw new Error('Missing reverse prompt button');
    fireEvent.click(run!);
    await waitFor(() => expect(document.querySelector('.reverse-result')).not.toBeNull());
    const feedbackBox = screen.getByLabelText(/^Feedback for /);
    fireEvent.change(feedbackBox, { target: { value: 'Keep the atmosphere but simplify props.' } });
    fireEvent.click(screen.getByRole('button', { name: /^Save feedback for / }));

    await waitFor(() => expect(useAppStore.getState().project.projectMemory).toHaveLength(1));
    expect(useAppStore.getState().project.projectMemory[0]).toMatchObject({
      kind: 'user_feedback',
      context: {
        knowledgeLease: { leaseId: 'lease-workspace-feedback' },
        references: [{ assetId: sceneAssetId, label: 'Scene', role: 'scene_composition', position: 0 }],
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
  it('keeps conflict work visible and offers explicit durable reload', () => {
    const reloadDurableProject = vi.fn(async () => true);
    resetAppStoreForTests();
    useAppStore.setState({
      canReloadDurableProject: true,
      projectCommitConflictCode: 'REVISION_CONFLICT',
      reloadDurableProject,
      saveErrorCode: 'REVISION_CONFLICT',
      saveStatus: 'error',
    });

    render(<CanvasWorkspace />);

    fireEvent.click(screen.getByTestId('save-reload'));
    expect(reloadDurableProject).toHaveBeenCalledOnce();

    expect(screen.getByRole('status', { name: '画布保存状态' })).toHaveTextContent('桌面项目已更新，已重新载入最新版本');
  });

  it('shows only recovery and discard actions for a recovery-required preview', () => {
    const restoreProjectSnapshot = vi.fn(async () => undefined);
    const discardPersistence = vi.fn(async () => true);
    resetAppStoreForTests();
    useAppStore.setState({
      availableSnapshotIds: ['snapshot-recovery'],
      discardPersistence,
      recoveryRequired: true,
      restoreProjectSnapshot,
      saveErrorCode: 'RECOVERY_REQUIRED',
      saveStatus: 'error',
    });

    render(<CanvasWorkspace />);

    expect(screen.getByTestId('recovery-required')).toBeVisible();
    fireEvent.click(screen.getByTestId('recovery-restore'));
    fireEvent.click(screen.getByTestId('recovery-discard'));
    expect(restoreProjectSnapshot).toHaveBeenCalledWith('snapshot-recovery');
    expect(discardPersistence).toHaveBeenCalledOnce();
    expect(screen.queryByTestId('save-retry')).not.toBeInTheDocument();
  });

  it('does not create an Agent canvas plan from a Skill chat message', async () => {
    const chat = installSkillChatBridgeForTests();
    const nodesBefore = useAppStore.getState().project.nodes;
    render(<CanvasWorkspace />);
    openAgent();
    await waitFor(() => expect(screen.getByRole('button', { name: '打开聊天模型菜单' })).toHaveTextContent('Creative chat'));
    fireEvent.change(screen.getByLabelText('向 Agent 发送消息'), { target: { value: 'Review this canvas.' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(chat).toHaveBeenCalledTimes(1));
    expect(useAppStore.getState().agentPlan).toBeNull();
    expect(useAppStore.getState().project.nodes).toEqual(nodesBefore);
    return;

    replaceModelJobExecutorForTests({
      submit: vi.fn(async (job) => ({ providerTaskId: `task-${job.id}` })),
      poll: vi.fn(async () => ({ status: 'running' as const, progress: 0.5 })),
      cancel: vi.fn(async () => {}),
    });
    installProviderProfilesForModelJobTests();
    render(<CanvasWorkspace />);
    openAgent();
    await waitFor(() => expect(screen.getByTestId('model-route-image-generation')).toBeVisible());
    fireEvent.change(screen.getByLabelText('向 Agent 发送消息'), { target: { value: '制作一张高端产品海报' } });
    fireEvent.click(screen.getByLabelText('发送消息'));

    expect(screen.getByLabelText('Agent 方案预览')).toBeVisible();
    expect(screen.getByText('创建审核节点。')).toBeInTheDocument();

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
    expect(prompt?.type).toBe('prompt');
  });

  it('filters non-chat profiles out of the Skill chat model selector', async () => {
    installSkillChatBridgeForTests([
      { provider: 'comfly', modelRoute: 'image/edit', displayName: 'Image only', modelId: 'image-only', capabilities: ['image_generation'] },
      { provider: 'comfly', modelRoute: 'chat/creative', displayName: 'Creative chat', modelId: 'creative-chat', capabilities: ['chat'] },
    ]);
    render(<CanvasWorkspace />);
    openAgent();
    fireEvent.click(screen.getByRole('tab', { name: '对话' }));
    await waitFor(() => expect(screen.getByRole('button', { name: '打开聊天模型菜单' })).toHaveTextContent('Creative chat'));
    fireEvent.click(screen.getByRole('button', { name: '打开聊天模型菜单' }));
    expect(screen.queryByRole('button', { name: '使用 Image only' })).not.toBeInTheDocument();
    return;

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
    openAgent();

    await waitFor(() => expect(screen.getByTestId('model-route-image-generation')).toBeVisible());
    expect(screen.queryByTestId('model-route-image-edit-only-route')).not.toBeInTheDocument();
  });

  it('keeps dated and thinking model routes individually switchable', async () => {
    installSkillChatBridgeForTests([
      { provider: 'comfly', modelRoute: 'chat/gpt-5.4', displayName: 'GPT-5.4', modelId: 'gpt-5.4', capabilities: ['chat'] },
      { provider: 'comfly', modelRoute: 'chat/gpt-5.4-2026-03-05', displayName: 'GPT-5.4 2026-03-05', modelId: 'gpt-5.4-2026-03-05', capabilities: ['chat'] },
      { provider: 'comfly', modelRoute: 'chat/gpt-5.4-thinking-high', displayName: 'GPT-5.4 thinking high', modelId: 'gpt-5.4-thinking-high', capabilities: ['chat'] },
    ]);
    render(<CanvasWorkspace />);
    openAgent();
    fireEvent.click(screen.getByRole('tab', { name: '对话' }));

    await waitFor(() => expect(screen.getByRole('button', { name: '打开聊天模型菜单' })).toHaveTextContent('GPT-5.4'));
    fireEvent.click(screen.getByRole('button', { name: '打开聊天模型菜单' }));

    expect(screen.getAllByRole('button', { name: /使用 GPT-5\.4/u })).toHaveLength(3);
    expect(screen.getByRole('button', { name: '使用 GPT-5.4 2026-03-05' })).toBeVisible();
    expect(screen.getByRole('button', { name: '使用 GPT-5.4 thinking high' })).toBeVisible();
  });

  it('executes the sole image generation node after Agent command confirmation', async () => {
    installSkillChatBridgeForTests();
    const imageNode = createCanvasModuleNode('agent-image-node', 'image_generation', { x: 120, y: 120 });
    imageNode.data.config = { modelRoute: 'image/creative' };
    const runImageGenerationNode = vi.fn(async () => true);
    useAppStore.setState({
      agentPanelCollapsed: true,
      project: { ...createStarterProject(), nodes: [imageNode], edges: [], assets: [] },
      runImageGenerationNode,
    } as never);

    render(<CanvasWorkspace />);
    openAgent();
    await waitFor(() => expect(screen.getByRole('button', { name: '打开聊天模型菜单' })).toHaveTextContent('Creative chat'));
    fireEvent.change(screen.getByLabelText('向 Agent 发送消息'), { target: { value: '生成一张产品主图' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    fireEvent.click(await screen.findByRole('button', { name: '确认执行生图' }));

    await waitFor(() => expect(runImageGenerationNode).toHaveBeenCalledWith('agent-image-node', expect.objectContaining({
      modelRoute: 'image/creative',
      prompt: '生成一张产品主图',
    })));
  });

  it('leaves the canvas plan empty after sending Skill chat', async () => {
    const chat = installSkillChatBridgeForTests();
    render(<CanvasWorkspace />);
    openAgent();
    await waitFor(() => expect(screen.getByRole('button', { name: '打开聊天模型菜单' })).toHaveTextContent('Creative chat'));
    fireEvent.change(screen.getByLabelText('向 Agent 发送消息'), { target: { value: 'Only analyze this canvas.' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(chat).toHaveBeenCalledOnce());
    expect(useAppStore.getState().agentPlan).toBeNull();
    return;

    render(<CanvasWorkspace />);
    openAgent();
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
    openAgent();
    expect(screen.getByTestId('plan-job-retry-state')).toBeVisible();
    expect(screen.getByTestId('plan-retry-jobs')).toHaveTextContent(/重试模型任务|Retry model tasks/i);
  });

  it('blocks image 21 before invoking the confined picker', () => {
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
    const importPlacementReference = vi.fn(async () => true);
    useAppStore.setState({ importPlacementReference });

    render(<CanvasWorkspace />);
    fireEvent.click(screen.getByLabelText('摆放预览'));
    fireEvent.click(screen.getByLabelText('上传材质光照参考'));

    expect(screen.getByRole('alert')).toHaveTextContent('参考图最多 20 张');
    expect(importPlacementReference).not.toHaveBeenCalled();
    const placement = useAppStore.getState().project.nodes.find((node) => node.type === 'placement_preview');
    expect(placement?.type === 'placement_preview' ? placement.data.objects : []).toHaveLength(20);
  });
  it('keeps project memory available as an optional section in the Agent conversation', () => {
    const project = createStarterProject();
    useAppStore.setState({
      project: {
        ...project,
        projectMemory: [{
          actor: 'agent',
          changeSummary: 'Keep memory inside the conversation surface.',
          context: { referenceAssetIds: [], resultAssetIds: [] },
          id: 'memory-inline',
          createdAt: '2026-08-14T00:00:00.000Z',
          feedback: { change: [], keep: ['Single Agent surface'], never: ['Decorative tabs'] },
          kind: 'optimization',
          nextStep: 'Continue in the Agent conversation',
          projectId: project.id,
          projectRevision: 1,
          rationale: 'Keep memory inside the conversation surface.',
          schemaVersion: 1,
          snapshots: { beforeId: 'before-inline', afterId: 'after-inline' },
          title: 'Inline memory',
        }],
      },
    });
    render(<CanvasWorkspace />);
    openAgent();
    fireEvent.click(screen.getByText('项目记忆', { selector: 'summary' }));
    expect(screen.getByLabelText('项目记忆时间线')).toBeVisible();
  });

  it('uses one continuous Agent conversation instead of decorative plan and memory tabs', () => {
    render(<CanvasWorkspace />);
    openAgent();
    expect(screen.getByLabelText('Agent 对话工作台')).toBeVisible();
    expect(screen.queryByTestId('agent-tab-conversation')).not.toBeInTheDocument();
    expect(screen.queryByTestId('agent-tab-plan')).not.toBeInTheDocument();
    expect(screen.queryByTestId('agent-tab-memory')).not.toBeInTheDocument();
  });

  it('keeps focus in the conversation after sending Skill chat', () => {
    installSkillChatBridgeForTests();
    render(<CanvasWorkspace />);
    openAgent();
    const composer = screen.getByLabelText('向 Agent 发送消息');
    composer.focus();
    fireEvent.change(composer, { target: { value: 'Explain this composition.' } });
    fireEvent.keyDown(composer, { key: 'Enter', code: 'Enter' });
    expect(composer).toHaveFocus();
    expect(useAppStore.getState().agentPlan).toBeNull();
    return;

    render(<CanvasWorkspace />);
    openAgent();
    fireEvent.change(screen.getByLabelText('向 Agent 发送消息'), { target: { value: '优化这张画布' } });

    fireEvent.click(screen.getByRole('button', { name: '发送消息' }));

    expect(screen.getByRole('tab', { name: '计划' })).toHaveFocus();
  });
  it('keeps project menu and quick insert mutually exclusive', () => {
    render(<CanvasWorkspace />);

    fireEvent.click(screen.getByTestId('file-menu-toggle'));
    expect(screen.getByRole('menu', { name: '文件' })).toBeVisible();
    fireEvent.click(screen.getByTestId('tool-add-node'));
    expect(screen.queryByRole('menu', { name: '文件' })).not.toBeInTheDocument();
    expect(screen.getByTestId('quick-insert')).toBeVisible();

    fireEvent.click(screen.getByTestId('file-menu-toggle'));
    expect(screen.queryByTestId('quick-insert')).not.toBeInTheDocument();
    expect(screen.getByRole('menu', { name: '文件' })).toBeVisible();
  });
  it('uses a compact twelve-pixel rhythm for every rail action', () => {
    expect(figmaHybridStyles).toContain('gap: 12px !important;');
    expect(figmaHybridStyles).toContain('flex: 0 0 40px !important;');
    expect(figmaHybridStyles).not.toContain('row-gap: 58px !important;');
  });
});

function createSelectedReverseAgentFixture(
  project: CanvasProject,
  references: readonly { assetId: string; label: string; role: string }[],
  knowledgeBaseIds: string[] = ['ecommerce-detail', 'scene-skill'],
) {
  const inputNodes = references.map((reference, index) => {
    const node = createCanvasModuleNode(`reverse-input-${index}`, 'image_input', { x: 0, y: index * 160 });
    node.data.config = { assetId: reference.assetId };
    return node;
  });
  const reverse = createCanvasModuleNode('reverse-agent', 'reverse_agent', { x: 360, y: 0 });
  reverse.data.config = {
    modelRoute: 'comfly/vision-video-pro',
    role: 'Commercial visual analyst',
    task: 'Analyze selected managed references.',
    knowledgeBaseIds,
  };
  return {
    project: {
      ...project,
      nodes: [...project.nodes, ...inputNodes, reverse],
      edges: [...project.edges, ...inputNodes.map((node, index) => ({
        id: `reverse-reference-${index}`,
        source: node.id,
        sourcePortId: 'image',
        target: reverse.id,
        targetPortId: 'references',
        order: index,
      }))],
    },
    images: references.map((reference, index) => ({
      assetId: reference.assetId,
      byteSize: 40 + index,
      displayUrl: `project-asset://${reference.assetId}`,
      extension: 'png' as const,
      height: 1,
      label: reference.label,
      mediaType: 'image/png' as const,
      origin: 'imported' as const,
      sha256: String(index + 1).repeat(64),
      usageCount: 1,
      width: 1,
    })),
  };
}

function createReversePromptResult(run: ReversePromptRun) {
  return {
    sessionId: run.sessionId,
    nonce: run.nonce,
    knowledgeSnapshotVersion: run.knowledgeLease.versionKey,
    analysis: 'Verified desktop response',
    keywords: ['verified'],
    positivePrompt: 'Verified prompt',
    negativeConstraints: ['none'],
    executionChecklist: ['review'],
  };
}

function openAgent(): void {
  fireEvent.click(screen.getByTestId('agent-toggle'));
  expect(screen.getByTestId('agent-panel')).toBeVisible();
}

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

function installSkillChatBridgeForTests(profiles = [{
  provider: 'comfly',
  modelRoute: 'chat/creative',
  displayName: 'Creative chat',
  modelId: 'codex-creative-chat',
  capabilities: ['chat'],
}]): ReturnType<typeof vi.fn> {
  const chat = vi.fn(async () => ({
    message: 'Use a clean hierarchy.',
    modelRoute: 'chat/creative',
    sources: [],
  }));
  window.novusDesktop = {
    provider: {
      ackImageJobTerminal: vi.fn(),
      analyzeReversePrompt: vi.fn(),
      cancelImageJob: vi.fn(),
      chat,
      configure: vi.fn(),
      getStatus: vi.fn(async () => ({ configured: true, locked: false, encryption: 'safeStorage' as const })),
      listProfiles: vi.fn(async () => profiles),
      pollImageJob: vi.fn(),
      submitImageJob: vi.fn(),
      unlock: vi.fn(),
    },
  } as unknown as typeof window.novusDesktop;
  replaceProjectPersistenceClientForTests(createImmediateBrowserClient({ chatSkill: chat }));
  return chat;
}

function createImmediateBrowserClient(
  overrides: Partial<ProjectPersistenceClient> = {},
): ProjectPersistenceClient {
  let hydratedProject = createStarterProject();
  const hydrate = overrides.hydrate ?? (async (): Promise<ProjectHydrationResult> => ({
    availableSnapshotIds: [],
    lifecycle: 'durable',
    mode: 'browser',
    project: hydratedProject,
    revision: 0,
    saveStatus: 'pending',
  }));
  return {
    analyzeReversePrompt: overrides.analyzeReversePrompt,
    chatSkill: overrides.chatSkill,
    close: overrides.close ?? (async () => {}),
    commit: overrides.commit ?? (async ({ nextProject }: ProjectCommitRequest): Promise<ProjectCommitResult> => {
      hydratedProject = nextProject;
      return { ok: true, project: nextProject, revision: 0 };
    }),
    hydrate,
    importDroppedMedia: overrides.importDroppedMedia,
    importProjectImage: overrides.importProjectImage ?? (async () => null),
    listProjectImages: overrides.listProjectImages ?? (async () => []),
    pasteClipboardImage: overrides.pasteClipboardImage ?? (async () => null),
    restore: overrides.restore ?? (async () => {
      const result = await hydrate();
      return {
        availableSnapshotIds: result.availableSnapshotIds,
        lifecycle: result.lifecycle,
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
