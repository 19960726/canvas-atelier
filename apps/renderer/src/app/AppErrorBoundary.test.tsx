import { cleanup, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';

const rendererFailure = vi.hoisted(() => ({
  message: 'legacy renderer state failed',
}));

vi.mock('../canvas/CanvasWorkspace', () => ({
  CanvasWorkspace() {
    throw new Error(rendererFailure.message);
  },
}));

import { App, resetAppHydrationForTests } from './App';

describe('App renderer failure recovery', () => {
  afterEach(() => {
    cleanup();
    resetAppHydrationForTests();
    rendererFailure.message = 'legacy renderer state failed';
    vi.restoreAllMocks();
  });

  it('shows a visible recovery screen when the canvas render crashes', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    render(<App />);

    expect(screen.getByRole('alert')).toHaveTextContent('界面启动失败');
    expect(screen.getByRole('button', { name: '重新加载' })).toBeInTheDocument();
  });

  it('shows the renderer exception summary so a blank-screen failure can be diagnosed', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});

    render(<App />);

    expect(screen.getByRole('alert')).toHaveTextContent('legacy renderer state failed');
  });

  it('redacts paths, urls, api keys, and long tokens from the visible exception summary', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    rendererFailure.message = [
      'Failed at C:\\Users\\Administrator\\AppData\\Roaming\\Canvas Atelier\\project.json',
      'request https://api.example.com/v1/images?api_key=visible-secret',
      'using sk-live-abcdefghijklmnopqrstuvwxyz123456',
      'token abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
    ].join(' ');

    render(<App />);

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('[本地路径]');
    expect(alert).toHaveTextContent('[链接]');
    expect(alert).toHaveTextContent('[密钥]');
    expect(alert).toHaveTextContent('[敏感信息]');
    expect(alert).not.toHaveTextContent('Administrator');
    expect(alert).not.toHaveTextContent('api.example.com');
    expect(alert).not.toHaveTextContent('sk-live-abcdefghijklmnopqrstuvwxyz123456');
    expect(alert).not.toHaveTextContent('abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG');
  });
});
