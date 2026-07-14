import { contextBridge, ipcRenderer } from 'electron';

import {
  DESKTOP_BRIDGE_PRELOAD_KEY,
  createSafeModePreloadApi,
  redactBridgeDiagnostics,
} from '@agent-canvas/desktop-core/preload-api';

contextBridge.exposeInMainWorld(
  DESKTOP_BRIDGE_PRELOAD_KEY,
  createSafeModePreloadApi((channel, payload) => ipcRenderer.invoke(channel, payload)),
);

const reportSafeModeFailure = (value: unknown) => {
  const message = value instanceof Error ? value.stack ?? value.message : String(value);
  ipcRenderer.send('novus-desktop:safe-mode-failure', redactBridgeDiagnostics(message));
};

window.addEventListener('error', (event) => {
  reportSafeModeFailure(event.error ?? event.message);
});

window.addEventListener('unhandledrejection', (event) => {
  reportSafeModeFailure(event.reason);
});
