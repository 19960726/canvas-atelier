import { readFile } from 'node:fs/promises';
import { resolve, win32 } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import * as desktopCore from './index';

type NetworkPathDetector = (
  path: string,
  options?: {
    readonly platform?: NodeJS.Platform;
    readonly probeDriveType?: (driveRoot: string) => Promise<string | Uint8Array>;
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

  it('accepts GBK encoded fixed-drive output from localized Windows fsutil', async () => {
    const detect = (desktopCore as Record<string, unknown>).isHistoryNetworkPath as NetworkPathDetector | undefined;
    expect(detect).toBeTypeOf('function');
    if (detect === undefined) return;
    const fixedDriveOutput = Buffer.from([
      0x43, 0x3a, 0x20, 0x2d, 0x20,
      0xb9, 0xcc, 0xb6, 0xa8, 0xc7, 0xfd, 0xb6, 0xaf, 0xc6, 0xf7,
      0x0d, 0x0a,
    ]);

    await expect(detect(win32.join('C:', 'video.mp4'), {
      platform: 'win32',
      probeDriveType: async () => fixedDriveOutput,
    })).resolves.toBe(false);
  });

  it.each(['desktop-legacy', 'desktop-modern'])('injects the detector into the %s main history store', async (shell) => {
    const source = await readFile(resolve(process.cwd(), 'apps', shell, 'src', 'main.ts'), 'utf8');
    expect(source).toContain('isHistoryNetworkPath');
    expect(source).toContain('historyIsNetworkPath: isHistoryNetworkPath');
  });
});
