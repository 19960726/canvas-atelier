import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it } from 'vitest';
import { CanvasWorkspace } from './CanvasWorkspace';

describe('CanvasWorkspace', () => {
  it('renders the canvas-first application shell', () => {
    render(<CanvasWorkspace />);

    expect(screen.getByRole('application', { name: '无限画布' })).toBeVisible();
    expect(screen.getByLabelText('选择工具')).toBeVisible();
    expect(screen.getByLabelText('Agent 面板')).toBeVisible();
    expect(screen.getByLabelText('任务队列')).toBeVisible();
  });
});
