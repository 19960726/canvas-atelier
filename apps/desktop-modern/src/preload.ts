import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

import {
  DESKTOP_BRIDGE_PRELOAD_KEY,
  createPreloadApi,
  redactBridgeDiagnostics,
} from '@agent-canvas/desktop-core/preload-api';

contextBridge.exposeInMainWorld(
  DESKTOP_BRIDGE_PRELOAD_KEY,
  createPreloadApi(
    (channel, payload) => ipcRenderer.invoke(channel, payload),
    (channel, listener) => {
      const wrapped = (_event: IpcRendererEvent, payload: unknown) => {
        listener(payload);
      };
      ipcRenderer.on(channel, wrapped);
      return () => {
        ipcRenderer.removeListener(channel, wrapped);
      };
    },
  ),
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
