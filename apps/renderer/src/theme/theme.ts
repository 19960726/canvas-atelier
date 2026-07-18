import { useCallback, useEffect, useState } from 'react';

export type ThemeMode = 'system' | 'light' | 'dark';
export type ResolvedTheme = Exclude<ThemeMode, 'system'>;

export const THEME_STORAGE_KEY = 'novus.theme.mode';
const DARK_MEDIA_QUERY = '(prefers-color-scheme: dark)';

export interface ThemePreference {
  readonly mode: ThemeMode;
  readonly resolvedTheme: ResolvedTheme;
  readonly setMode: (mode: ThemeMode) => void;
}

export function useThemePreference(): ThemePreference {
  const [mode, updateMode] = useState<ThemeMode>(readStoredThemeMode);
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() => resolveTheme(mode));

  useEffect(() => {
    const mediaQuery = getDarkMediaQuery();
    const applyTheme = (prefersDark: boolean) => {
      const nextTheme = mode === 'system' ? (prefersDark ? 'dark' : 'light') : mode;
      document.documentElement.dataset.theme = nextTheme;
      setResolvedTheme(nextTheme);
    };

    applyTheme(mediaQuery?.matches ?? false);
    if (mode !== 'system' || mediaQuery === null) return undefined;

    const handlePreferenceChange = (event: MediaQueryListEvent) => applyTheme(event.matches);
    mediaQuery.addEventListener('change', handlePreferenceChange);
    return () => mediaQuery.removeEventListener('change', handlePreferenceChange);
  }, [mode]);

  const setMode = useCallback((nextMode: ThemeMode) => {
    storeThemeMode(nextMode);
    updateMode(nextMode);
  }, []);

  return { mode, resolvedTheme, setMode };
}

export function isThemeMode(value: string): value is ThemeMode {
  return value === 'system' || value === 'light' || value === 'dark';
}

function readStoredThemeMode(): ThemeMode {
  try {
    const storedMode = localStorage.getItem(THEME_STORAGE_KEY);
    return storedMode !== null && isThemeMode(storedMode) ? storedMode : 'system';
  } catch {
    return 'system';
  }
}

function storeThemeMode(mode: ThemeMode): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    // Theme persistence is best-effort and never enters project state.
  }
}

function resolveTheme(mode: ThemeMode): ResolvedTheme {
  if (mode !== 'system') return mode;
  return getDarkMediaQuery()?.matches ? 'dark' : 'light';
}

function getDarkMediaQuery(): MediaQueryList | null {
  return typeof window.matchMedia === 'function' ? window.matchMedia(DARK_MEDIA_QUERY) : null;
}
