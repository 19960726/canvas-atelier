import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetAppStoreForTests, useAppStore } from '../app/app-store';
import { CanvasWorkspace } from './CanvasWorkspace';

const THEME_STORAGE_KEY = 'novus.theme.mode';

beforeEach(() => {
  delete window.novusDesktop;
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  resetAppStoreForTests();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  document.documentElement.removeAttribute('data-theme');
});

describe('renderer theme behavior', () => {
  it('defaults to system mode and exposes an accessible three-mode selector', () => {
    installMatchMedia(false);

    render(<CanvasWorkspace />);

    const selector = screen.getByRole('combobox', { name: '主题 Theme' });
    expect(selector).toHaveValue('system');
    expect(screen.getByRole('option', { name: '跟随系统 System' })).toBeVisible();
    expect(screen.getByRole('option', { name: '浅色 Light' })).toBeVisible();
    expect(screen.getByRole('option', { name: '深色 Dark' })).toBeVisible();
    expect(document.documentElement).toHaveAttribute('data-theme', 'light');
  });

  it('reflects system light and dark changes on the renderer root and unsubscribes on unmount', () => {
    const media = installMatchMedia(false);
    const view = render(<CanvasWorkspace />);

    expect(document.documentElement).toHaveAttribute('data-theme', 'light');

    act(() => media.setMatches(true));

    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
    expect(media.addEventListener).toHaveBeenCalledWith('change', expect.any(Function));

    view.unmount();

    expect(media.removeEventListener).toHaveBeenCalledWith('change', expect.any(Function));
  });

  it('lets an explicit light or dark override win over the media preference', () => {
    const media = installMatchMedia(false);
    localStorage.setItem(THEME_STORAGE_KEY, 'dark');

    render(<CanvasWorkspace />);

    const selector = screen.getByRole('combobox', { name: '主题 Theme' });
    expect(selector).toHaveValue('dark');
    expect(document.documentElement).toHaveAttribute('data-theme', 'dark');

    fireEvent.change(selector, { target: { value: 'light' } });
    act(() => media.setMatches(true));

    expect(selector).toHaveValue('light');
    expect(document.documentElement).toHaveAttribute('data-theme', 'light');
  });

  it('keeps the override device-local without mutating project state', () => {
    installMatchMedia(false);
    const projectBefore = useAppStore.getState().project;

    render(<CanvasWorkspace />);
    fireEvent.change(screen.getByRole('combobox', { name: '主题 Theme' }), {
      target: { value: 'dark' },
    });

    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    expect(useAppStore.getState().project).toBe(projectBefore);
  });
});

function installMatchMedia(initialMatches: boolean) {
  let matches = initialMatches;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const addEventListener = vi.fn((_type: 'change', listener: (event: MediaQueryListEvent) => void) => {
    listeners.add(listener);
  });
  const removeEventListener = vi.fn((_type: 'change', listener: (event: MediaQueryListEvent) => void) => {
    listeners.delete(listener);
  });
  const mediaQueryList = {
    get matches() {
      return matches;
    },
    media: '(prefers-color-scheme: dark)',
    onchange: null,
    addEventListener,
    removeEventListener,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(() => true),
  } as unknown as MediaQueryList;

  vi.stubGlobal('matchMedia', vi.fn(() => mediaQueryList));

  return {
    addEventListener,
    removeEventListener,
    setMatches(nextMatches: boolean) {
      matches = nextMatches;
      const event = { matches, media: mediaQueryList.media } as MediaQueryListEvent;
      for (const listener of listeners) listener(event);
    },
  };
}
