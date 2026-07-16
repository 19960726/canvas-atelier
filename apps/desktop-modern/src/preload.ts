import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { getRuntimeProfile } from '@agent-canvas/domain';

import {
  AGENT_CANVAS_PRELOAD_KEY,
  DESKTOP_BRIDGE_PRELOAD_KEY,
  createDesktopPreloadApis,
} from '@agent-canvas/desktop-bridge/preload';
import {
  redactBridgeDiagnostics,
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

contextBridge.exposeInMainWorld(DESKTOP_BRIDGE_PRELOAD_KEY, apis.novusDesktop);
contextBridge.exposeInMainWorld(AGENT_CANVAS_PRELOAD_KEY, apis.agentCanvas);
contextBridge.exposeInMainWorld('agentCanvasRuntimeProfile', getRuntimeProfile('modern'));

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
