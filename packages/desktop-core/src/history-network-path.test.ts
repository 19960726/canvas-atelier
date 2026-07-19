import { readFile } from 'node:fs/promises';
import { resolve, win32 } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import * as desktopCore from './index';

type NetworkPathDetector = (
  path: string,
  options?: {
    readonly platform?: NodeJS.Platform;
    readonly probeDriveType?: (driveRoot: string) => Promise<string>;
  },
) => Promise<boolean>;

describe('generation history production network path detection', () => {
  it('rejects UNC and mapped remote drives while accepting a fixed local drive', async () => {
    expect(desktopCore).toHaveProperty('isHistoryNetworkPath');
    const detect = (desktopCore as Record<string, unknown>).isHistoryNetworkPath as NetworkPathDetector | undefined;
    if (detect === undefined) return;
    const probe = vi.fn(async (driveRoot: string) => (
      driveRoot.toUpperCase() === 'Z:' ? 'Z: - Remote Drive' : 'E: - Fixed Drive'
    ));
    const unc = [String.fromCharCode(92, 92), 'server', String.fromCharCode(92), 'share', String.fromCharCode(92), 'history'].join('');

    await expect(detect(unc, { platform: 'win32', probeDriveType: probe })).resolves.toBe(true);
    await expect(detect(win32.join('Z:', 'history'), { platform: 'win32', probeDriveType: probe })).resolves.toBe(true);
    await expect(detect(win32.join('E:', 'history'), { platform: 'win32', probeDriveType: probe })).resolves.toBe(false);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('fails closed for an unknown Windows drive type without probing ordinary non-Windows paths', async () => {
    const detect = (desktopCore as Record<string, unknown>).isHistoryNetworkPath as NetworkPathDetector | undefined;
    expect(detect).toBeTypeOf('function');
    if (detect === undefined) return;
    const failedProbe = vi.fn(async () => { throw new Error('drive type unavailable'); });
    const unusedProbe = vi.fn(async () => 'Remote Drive');

    await expect(detect(win32.join('Q:', 'history'), {
      platform: 'win32',
      probeDriveType: failedProbe,
    })).resolves.toBe(true);
    await expect(detect('/var/lib/novus/history', {
      platform: 'linux',
      probeDriveType: unusedProbe,
    })).resolves.toBe(false);
    expect(unusedProbe).not.toHaveBeenCalled();
  });

  it.each(['desktop-legacy', 'desktop-modern'])('injects the detector into the %s main history store', async (shell) => {
    const source = await readFile(resolve(process.cwd(), 'apps', shell, 'src', 'main.ts'), 'utf8');
    expect(source).toContain('isHistoryNetworkPath');
    expect(source).toContain('historyIsNetworkPath: isHistoryNetworkPath');
  });
});
