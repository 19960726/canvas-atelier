import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { createElectronUpdaterDriver } from './electron-updater-adapter.js';

describe('electron updater adapter', () => {
  it('disables automatic install, maps safe events, and installs only on explicit driver invocation', async () => {
    const updater = Object.assign(new EventEmitter(), {
      autoDownload: true,
      autoInstallOnAppQuit: true,
      checkForUpdates: vi.fn(async () => undefined),
      downloadUpdate: vi.fn(async () => undefined),
      quitAndInstall: vi.fn(),
    });
    const driver = createElectronUpdaterDriver(updater);
    const events: unknown[] = [];
    driver.subscribe((event) => events.push(event));

    updater.emit('update-available', { version: '1.6.63', releaseNotes: '<b>Safe</b> notes' });
    updater.emit('download-progress', { percent: 37.5 });
    updater.emit('update-downloaded', { version: '1.6.63', releaseNotes: 'Ready' });

    expect(updater.autoDownload).toBe(false);
    expect(updater.autoInstallOnAppQuit).toBe(false);
    expect(events).toEqual([
      { type: 'available', version: '1.6.63', notes: 'Safe notes' },
      { type: 'download-progress', percent: 37.5 },
      { type: 'downloaded', version: '1.6.63', notes: 'Ready' },
    ]);
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    driver.quitAndInstall();
    expect(updater.quitAndInstall).toHaveBeenCalledOnce();
  });
});
