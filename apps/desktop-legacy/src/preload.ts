import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { getRuntimeProfile } from '@agent-canvas/domain';

import {
  AGENT_CANVAS_PRELOAD_KEY,
  DESKTOP_BRIDGE_PRELOAD_KEY,
  createDesktopPreloadApis,
} from '@agent-canvas/desktop-bridge/preload';
import {
  redactBridgeDiagnostics,
  BRIDGE_CHANNELS,
} from '@agent-canvas/desktop-core/preload-api';

const invoke = (channel: string, payload?: unknown) => ipcRenderer.invoke(channel, payload);
const send = (channel: string, payload?: unknown) => {
  ipcRenderer.send(channel, payload);
};
const subscribe = (channel: string, listener: (payload: unknown) => void) => {
  const wrapped = (_event: IpcRendererEvent, payload: unknown) => {
    listener(payload);
  };
  ipcRenderer.on(channel, wrapped);
  return () => {
    ipcRenderer.removeListener(channel, wrapped);
  };
};
const apis = createDesktopPreloadApis(invoke, subscribe, send);
const desktopApi = {
  ...apis.novusDesktop,
  storage: apis.novusDesktop.storage,
  projectImages: {
    ...apis.novusDesktop.projectImages,
    importDroppedMedia(request: Parameters<typeof apis.novusDesktop.projectImages.importDroppedMedia>[0], file: unknown) {
      if (file === null || typeof file !== 'object') return Promise.resolve(null);
      // Electron 22 exposes the trusted path on the File object.  The newer
      // webUtils API used by the modern desktop shell is not available here.
      const sourcePath = (file as File & { path?: unknown }).path;
      if (typeof sourcePath !== 'string' || !sourcePath) return Promise.resolve(null);
      return ipcRenderer.invoke(BRIDGE_CHANNELS.importDroppedProjectMedia, { request, sourcePath });
    },
  },
};

contextBridge.exposeInMainWorld(DESKTOP_BRIDGE_PRELOAD_KEY, desktopApi);
contextBridge.exposeInMainWorld(AGENT_CANVAS_PRELOAD_KEY, apis.agentCanvas);
contextBridge.exposeInMainWorld('agentCanvasRuntimeProfile', getRuntimeProfile('legacy-win7'));

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
