import { describe, expect, it } from 'vitest';
import { resolveQaUserDataRoot, shouldShowQaWindow } from './qa-user-data-root';

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
