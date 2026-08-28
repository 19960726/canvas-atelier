import { autoUpdater } from 'electron-updater';
import type { UpdateDriver, UpdateDriverEvent } from '@agent-canvas/desktop-core';

interface ElectronUpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  on(event: string, listener: (...args: any[]) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(): void;
}

export function createElectronUpdaterDriver(
  updater: ElectronUpdaterLike = autoUpdater,
): UpdateDriver {
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  const listeners = new Set<(event: UpdateDriverEvent) => void>();
  const emit = (event: UpdateDriverEvent) => listeners.forEach((listener) => listener(event));

  updater.on('checking-for-update', () => emit({ type: 'checking' }));
  updater.on('update-available', (info: { version?: unknown; releaseNotes?: unknown }) => emit({
    type: 'available',
    version: safeVersion(info.version),
    notes: safeReleaseNotes(info.releaseNotes),
  }));
  updater.on('update-not-available', () => emit({ type: 'not-available' }));
  updater.on('download-progress', (progress: { percent?: unknown }) => emit({
    type: 'download-progress',
    percent: typeof progress.percent === 'number' && Number.isFinite(progress.percent) ? progress.percent : 0,
  }));
  updater.on('update-downloaded', (info: { version?: unknown; releaseNotes?: unknown }) => emit({
    type: 'downloaded',
    version: safeVersion(info.version),
    notes: safeReleaseNotes(info.releaseNotes),
  }));
  updater.on('error', () => emit({ type: 'error', message: 'Desktop update failed.' }));

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async checkForUpdates() { await updater.checkForUpdates(); },
    async downloadUpdate() { await updater.downloadUpdate(); },
    quitAndInstall() { updater.quitAndInstall(); },
  };
}

function safeVersion(value: unknown): string {
  return typeof value === 'string' && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(value)
    ? value.slice(0, 64)
    : 'unknown';
}

function safeReleaseNotes(value: unknown): string {
  const text = Array.isArray(value)
    ? value.map((item) => typeof item === 'object' && item !== null && 'note' in item ? String(item.note) : '').join('\n')
    : typeof value === 'string' ? value : '';
  return text.replace(/<[^>]*>/gu, ' ').replace(/\s+/gu, ' ').trim().slice(0, 4_000);
}
