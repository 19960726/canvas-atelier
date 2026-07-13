import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStarterProject, useAppStore } from '../app/app-store';
import { CanvasWorkspace } from './CanvasWorkspace';

beforeEach(() => {
  useAppStore.setState({ project: createStarterProject(), activeTool: 'select', agentPanelCollapsed: false });
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
      nodes: [{
        id: 'prop-1',
        type: 'reference',
        position: { x: 80, y: 120 },
        data: { assetId: 'asset-prop', role: 'prop_reference' },
      }],
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
  });

  it('keeps temporary preview URLs outside project JSON and revokes them on unmount', () => {
    const createObjectUrl = vi.fn(() => 'blob:scene-preview');
    const revokeObjectUrl = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createObjectUrl });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revokeObjectUrl });
    const { unmount } = render(<CanvasWorkspace />);
    fireEvent.click(screen.getByLabelText('摆放预览'));

    fireEvent.change(screen.getByLabelText('上传场景参考'), {
      target: { files: [new File(['scene'], 'scene.png', { type: 'image/png' })] },
    });

    const placementNode = useAppStore.getState().project.nodes.find((node) => node.type === 'placement_preview');
    const sceneObject = placementNode?.type === 'placement_preview'
      ? placementNode.data.objects.find((object) => object.role === 'scene_composition')
      : undefined;
    expect(createObjectUrl).toHaveBeenCalledOnce();
    expect(sceneObject?.assetId).toMatch(/^local-reference-/);
    expect(sceneObject?.assetId).not.toContain('blob:');
    expect(screen.getByAltText('场景参考')).toHaveAttribute('src', 'blob:scene-preview');
    expect(within(screen.getByLabelText('当前参考职责')).getByText('已添加 1 张')).toBeInTheDocument();

    unmount();
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:scene-preview');
  });
});