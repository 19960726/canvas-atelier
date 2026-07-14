import type { DesktopBridgeApi } from '@agent-canvas/desktop-core';

declare global {
  interface Window {
    novusDesktop?: DesktopBridgeApi;
  }
}

export {};
