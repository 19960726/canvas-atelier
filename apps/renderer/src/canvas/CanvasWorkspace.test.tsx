import { cleanup, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it } from 'vitest';
import { useAppStore } from '../app/app-store';
import { CanvasWorkspace } from './CanvasWorkspace';

afterEach(() => cleanup());

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
});
