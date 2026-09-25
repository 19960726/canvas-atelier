import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { memo, useContext } from 'react';
import { AgentWindowControlsContext, FloatingAgentWindow, clampAgentWindow } from './FloatingAgentWindow';

afterEach(() => { cleanup(); localStorage.clear(); });
describe('floating Agent window', () => {
  it('keeps restored geometry inside a smaller viewport', () => {
    expect(clampAgentWindow({ x: 1800, y: 900, width: 700, height: 800 }, 800, 600)).toEqual({ x: 92, y: 8, width: 700, height: 584 });
    expect(clampAgentWindow({ x: -10, y: -10, width: 10, height: 10 }, 320, 400)).toEqual({ x: 8, y: 8, width: 304, height: 384 });
  });
  it('minimizes without unmounting or losing the composer draft', () => {
    render(<FloatingAgentWindow open onClose={vi.fn()}><input aria-label="Draft" defaultValue="unsent" /></FloatingAgentWindow>);
    fireEvent.change(screen.getByLabelText('Draft'), { target: { value: 'keep this' } });
    fireEvent.click(screen.getByRole('button', { name: '最小化 Agent' }));
    expect(screen.getByLabelText('Draft')).toHaveValue('keep this');
    expect(screen.getByLabelText('Draft')).not.toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '展开 Agent' }));
    expect(screen.getByLabelText('Draft')).toBeVisible();
    expect(screen.getByLabelText('Draft')).toHaveValue('keep this');
  });
  it('switches between floating and docked without unmounting the conversation', () => {
    render(<FloatingAgentWindow open onClose={vi.fn()}><input aria-label="Draft" defaultValue="unsent" /></FloatingAgentWindow>);
    const panel = screen.getByTestId('agent-panel');
    const draft = screen.getByLabelText('Draft');
    fireEvent.change(draft, { target: { value: 'keep across layouts' } });
    fireEvent.click(screen.getByRole('button', { name: '停靠到侧边' }));
    expect(panel).toHaveAttribute('data-presentation-mode', 'docked');
    expect(screen.getByLabelText('Draft')).toHaveValue('keep across layouts');
    expect(localStorage.getItem('novus.agent-window.presentation.v1')).toBe('docked');
  });
  it('keeps the Agent controls context stable when the canvas parent rerenders', () => {
    const onClose = vi.fn();
    const observeControls = vi.fn();
    const Consumer = memo(function Consumer() {
      const controls = useContext(AgentWindowControlsContext);
      observeControls(controls);
      return <span>{controls?.mode}</span>;
    });
    const view = render(<FloatingAgentWindow open onClose={onClose}><Consumer /></FloatingAgentWindow>);

    expect(observeControls).toHaveBeenCalledTimes(1);
    view.rerender(<FloatingAgentWindow open onClose={onClose}><Consumer /></FloatingAgentWindow>);

    expect(observeControls).toHaveBeenCalledTimes(1);
    expect(screen.getByText('floating')).toBeInTheDocument();
  });
  it('moves with the keyboard and persists only the window geometry', () => {
    render(<FloatingAgentWindow open onClose={vi.fn()}><p>body</p></FloatingAgentWindow>);
    const handle = screen.getByRole('button', { name: '拖动 Agent 窗口' });
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    const saved = JSON.parse(localStorage.getItem('novus.agent-window.v1')!);
    expect(Object.keys(saved).sort()).toEqual(['height', 'width', 'x', 'y']);
    expect(saved.width).toBe(440);
    expect(saved.x).toBeLessThan(window.innerWidth - 440 - 24);
  });
});
