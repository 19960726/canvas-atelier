import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';
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
import { isBenignRendererError } from './renderer-error-policy';

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
      let sourcePath = '';
      try {
        // Context-isolated Electron windows proxy File objects across worlds, so
        // `instanceof File` is not reliable here. The Electron API is the trust
        // boundary: it returns a path only for a real dropped file.
        sourcePath = webUtils.getPathForFile(file as File);
      } catch {
        return Promise.resolve(null);
      }
      if (!sourcePath) return Promise.resolve(null);
      return ipcRenderer.invoke(BRIDGE_CHANNELS.importDroppedProjectMedia, { request, sourcePath });
    },
  },
};

contextBridge.exposeInMainWorld(DESKTOP_BRIDGE_PRELOAD_KEY, desktopApi);
contextBridge.exposeInMainWorld(AGENT_CANVAS_PRELOAD_KEY, apis.agentCanvas);
contextBridge.exposeInMainWorld('agentCanvasRuntimeProfile', getRuntimeProfile('modern'));

const reportSafeModeFailure = (value: unknown) => {
  const message = value instanceof Error ? value.stack ?? value.message : String(value);
  ipcRenderer.send('novus-desktop:safe-mode-failure', redactBridgeDiagnostics(message));
};

window.addEventListener('error', (event) => {
  const failure = event.error ?? event.message;
  if (isBenignRendererError(failure)) return;
  reportSafeModeFailure(failure);
});

window.addEventListener('unhandledrejection', (event) => {
  reportSafeModeFailure(event.reason);
});
