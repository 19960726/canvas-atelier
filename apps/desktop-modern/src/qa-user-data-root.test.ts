import { describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolveDesktopDataRoots, resolveQaUserDataRoot, shouldShowQaWindow } from './qa-user-data-root';

describe('resolveDesktopDataRoots', () => {
  it('uses the explicit QA root without querying unavailable Windows default paths', () => {
    const getPath = vi.fn(() => { throw new Error("Failed to get 'userData' path"); });
    const qaRoot = 'E:\\build\\canvasforge-qa-candidate';
    expect(resolveDesktopDataRoots({ CANVASFORGE_QA_MODE: '1', CANVASFORGE_QA_USER_DATA_ROOT: qaRoot }, getPath))
      .toEqual({ qaUserDataRoot: qaRoot, stableUserDataRoot: qaRoot, legacyUserDataRoots: [] });
    expect(getPath).not.toHaveBeenCalled();
  });

  it('retains normal user data discovery and migration outside QA', () => {
    const getPath = vi.fn((name: 'appData' | 'userData') => name === 'appData'
      ? 'C:\\Users\\demo\\AppData\\Roaming' : 'C:\\Users\\demo\\AppData\\Roaming\\Old Canvas');
    const result = resolveDesktopDataRoots({}, getPath);
    expect(result.qaUserDataRoot).toBeNull();
    expect(result.stableUserDataRoot).toBe('C:\\Users\\demo\\AppData\\Roaming\\Canvas Atelier');
    expect(result.legacyUserDataRoots).toContain('C:\\Users\\demo\\AppData\\Roaming\\Old Canvas');
    expect(getPath).toHaveBeenCalledWith('appData');
    expect(getPath).toHaveBeenCalledWith('userData');
  });
});

describe('resolveQaUserDataRoot', () => {
  it('accepts only an explicit absolute QA root with the QA mode gate enabled', () => {
    expect(resolveQaUserDataRoot({
      CANVASFORGE_QA_MODE: '1',
      CANVASFORGE_QA_USER_DATA_ROOT: 'E:\\build\\canvasforge-qa-candidate',
    }, 'win32')).toBe('E:\\build\\canvasforge-qa-candidate');
  });

  it('rejects missing gates, relative paths, and ordinary user-data directory names', () => {
    expect(resolveQaUserDataRoot({ CANVASFORGE_QA_USER_DATA_ROOT: 'E:\\build\\canvasforge-qa-candidate' }, 'win32')).toBeNull();
    expect(resolveQaUserDataRoot({ CANVASFORGE_QA_MODE: '1', CANVASFORGE_QA_USER_DATA_ROOT: '.\\canvasforge-qa-candidate' }, 'win32')).toBeNull();
    expect(resolveQaUserDataRoot({ CANVASFORGE_QA_MODE: '1', CANVASFORGE_QA_USER_DATA_ROOT: 'C:\\Users\\Administrator\\AppData\\Roaming\\CanvasForge' }, 'win32')).toBeNull();
  });
});

describe('shouldShowQaWindow', () => {
  it('hides a desktop window only behind both explicit QA gates', () => {
    expect(shouldShowQaWindow({ CANVASFORGE_QA_MODE: '1', CANVASFORGE_QA_HIDDEN: '1' })).toBe(false);
    expect(shouldShowQaWindow({ CANVASFORGE_QA_HIDDEN: '1' })).toBe(true);
    expect(shouldShowQaWindow({ CANVASFORGE_QA_MODE: '1' })).toBe(true);
  });
});

describe('QA single-instance isolation', () => {
  it('does not redirect an explicit isolated QA launch into the real user window', async () => {
    const mainSource = await readFile(new URL('./main.ts', import.meta.url), 'utf8');
    expect(mainSource).toContain('qaUserDataRoot !== null || app.requestSingleInstanceLock()');
  });
});
