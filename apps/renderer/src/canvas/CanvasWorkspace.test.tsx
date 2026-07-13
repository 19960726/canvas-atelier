import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlacementObject } from '@agent-canvas/domain';
import { createStarterProject, useAppStore } from '../app/app-store';
import { CanvasWorkspace } from './CanvasWorkspace';

beforeEach(() => {
  useAppStore.setState({ project: createStarterProject(), activeTool: 'select', agentPanelCollapsed: false, agentPlan: null, undoStack: [], confirmedModelJobs: 0 });
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

  it('previews, confirms, and undoes an Agent canvas plan as one transaction', () => {
    render(<CanvasWorkspace />);
    fireEvent.change(screen.getByLabelText('向 Agent 发送消息'), { target: { value: '制作一张高端产品海报' } });
    fireEvent.click(screen.getByLabelText('发送消息'));

    expect(screen.getByLabelText('Agent 方案预览')).toBeVisible();
    expect(screen.getByText('创建审核节点')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('确认模型执行'));
    fireEvent.click(screen.getByRole('button', { name: '确认执行' }));
    expect(useAppStore.getState().project.nodes.some((node) => node.type === 'review')).toBe(true);
    expect(useAppStore.getState().project.edges.find((edge) => edge.id.startsWith('agent-edge-'))?.label).toBeUndefined();
    expect(useAppStore.getState().confirmedModelJobs).toBe(1);
    expect(screen.getByText('1 个已确认任务待排队')).toBeInTheDocument();
    expect(useAppStore.getState().agentPlan?.state).toBe('reviewing_results');

    fireEvent.click(screen.getByLabelText('撤销'));
    expect(useAppStore.getState().project.nodes.some((node) => node.type === 'review')).toBe(false);
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
  });});