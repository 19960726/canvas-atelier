import { describe, expect, it } from 'vitest';

import { BRIDGE_CHANNELS, createPreloadApi } from './preload-api';

const summary = {
  recentProjectId: 'recent_0123456789abcdef01234567',
  projectId: 'project-safe',
  displayName: '安全项目',
  lastOpenedAt: '2026-08-10T08:00:00.000Z',
  lastSavedAt: '2026-08-10T08:01:00.000Z',
  availability: 'available' as const,
  nodeCount: 3,
  imageCount: 2,
  videoCount: 1,
  previewUrl: 'novus-recent-project://recent_0123456789abcdef01234567/preview',
};

describe('recent project preload API', () => {
  it('subscribes to only the narrow update-state channel and returns the unsubscribe handle', () => {
    let eventListener: ((payload: unknown) => void) | undefined;
    const unsubscribe = () => undefined;
    const subscribe = (channel: string, listener: (payload: unknown) => void) => {
      expect(channel).toBe(BRIDGE_CHANNELS.updates.stateChanged);
      eventListener = listener;
      return unsubscribe;
    };
    const api = createPreloadApi(async () => undefined as never, subscribe);
    const states: unknown[] = [];

    expect(api.updates.subscribeState((state) => states.push(state))).toBe(unsubscribe);
    eventListener?.({ status: 'downloading', version: '1.6.63', progress: 0.42 });
    eventListener?.({ status: 'arbitrary-electron-event' });

    expect(states).toEqual([{ status: 'downloading', version: '1.6.63', progress: 0.42 }]);
  });

  it('uses dedicated channels and never asks the renderer for a native path', async () => {
    const calls: Array<{ channel: string; payload: unknown }> = [];
    const api = createPreloadApi(async <TResponse>(channel: string, payload?: unknown): Promise<TResponse> => {
      calls.push({ channel, payload });
      if (channel === BRIDGE_CHANNELS.recentProjects.open) return { projectId: 'project-safe' } as TResponse;
      if (channel === BRIDGE_CHANNELS.recentProjects.relocate) return summary as TResponse;
      return [summary] as TResponse;
    });

    await expect(api.recentProjects.list()).resolves.toEqual([summary]);
    await api.recentProjects.open({ recentProjectId: summary.recentProjectId, mode: 'write' });
    await api.recentProjects.remove({ recentProjectId: summary.recentProjectId });
    await api.recentProjects.relocate({ recentProjectId: summary.recentProjectId });

    expect(calls).toEqual([
      { channel: BRIDGE_CHANNELS.recentProjects.list, payload: undefined },
      { channel: BRIDGE_CHANNELS.recentProjects.open, payload: { recentProjectId: summary.recentProjectId, mode: 'write' } },
      { channel: BRIDGE_CHANNELS.recentProjects.remove, payload: { recentProjectId: summary.recentProjectId } },
      { channel: BRIDGE_CHANNELS.recentProjects.relocate, payload: { recentProjectId: summary.recentProjectId } },
    ]);
    expect(JSON.stringify(calls)).not.toMatch(/[A-Za-z]:\\/u);
  });

  it('submits only the session and managed asset identity for Photoshop import', async () => {
    const calls: Array<{ channel: string; payload: unknown }> = [];
    const api = createPreloadApi(async <TResponse>(channel: string, payload?: unknown): Promise<TResponse> => {
      calls.push({ channel, payload });
      return { ok: true, layerName: 'Generated image' } as TResponse;
    });

    await expect(api.projectImages.importToPhotoshop({
      sessionId: 'session-1',
      assetId: '0123456789abcdef',
    })).resolves.toEqual({ ok: true, layerName: 'Generated image' });

    expect(calls).toEqual([{
      channel: BRIDGE_CHANNELS.importProjectImageToPhotoshop,
      payload: { sessionId: 'session-1', assetId: '0123456789abcdef' },
    }]);
    expect(JSON.stringify(calls)).not.toMatch(/path|script|[A-Za-z]:\\/u);
  });

  it('exposes only narrow RelayMe account and active-provider calls', async () => {
    const calls: Array<{ channel: string; payload: unknown }> = [];
    const api = createPreloadApi(async <TResponse>(channel: string, payload?: unknown): Promise<TResponse> => {
      calls.push({ channel, payload });
      return { ok: true, value: { activeProvider: channel.includes('logout') ? null : 'relayme' } } as TResponse;
    });
    const provider = api.provider as typeof api.provider & {
      getActiveProvider(): Promise<{ activeProvider: 'comfly' | 'relayme' | null }>;
      setActiveProvider(request: { activeProvider: 'comfly' | 'relayme' | null }): Promise<{ activeProvider: 'comfly' | 'relayme' | null }>;
      loginRelayMe(request: { username: string; password: string }): Promise<{ activeProvider: 'relayme' }>;
      logoutRelayMe(): Promise<{ activeProvider: null }>;
    };

    await expect(provider.getActiveProvider()).resolves.toEqual({ activeProvider: 'relayme' });
    await expect(provider.setActiveProvider({ activeProvider: 'relayme' })).resolves.toEqual({ activeProvider: 'relayme' });
    await expect(provider.loginRelayMe({ username: 'artist@example.test', password: 'not-a-real-password' })).resolves.toEqual({ activeProvider: 'relayme' });
    await expect(provider.logoutRelayMe()).resolves.toEqual({ activeProvider: null });
    expect(calls).toEqual([
      { channel: BRIDGE_CHANNELS.provider.getActiveProvider, payload: undefined },
      { channel: BRIDGE_CHANNELS.provider.setActiveProvider, payload: { activeProvider: 'relayme' } },
      { channel: BRIDGE_CHANNELS.provider.loginRelayMe, payload: { username: 'artist@example.test', password: 'not-a-real-password' } },
      { channel: BRIDGE_CHANNELS.provider.logoutRelayMe, payload: undefined },
    ]);
    expect(JSON.stringify(calls)).not.toMatch(/jwt|token|bearer/i);
  });

  it('exposes a narrow RelayMe task-list call', async () => {
    const calls: Array<{ channel: string; payload: unknown }> = [];
    const result = { tasks: [{ taskId: 'task-1', type: 'image', status: 'COMPLETED' }], total: 1, page: 1, totalPages: 1 };
    const api = createPreloadApi(async <TResponse>(channel: string, payload?: unknown): Promise<TResponse> => {
      calls.push({ channel, payload });
      return { ok: true, value: result } as TResponse;
    });

    await expect(api.provider.listTasks({ provider: 'relayme', page: 1, size: 20 })).resolves.toEqual(result);
    expect(calls).toEqual([{
      channel: BRIDGE_CHANNELS.provider.listTasks,
      payload: { provider: 'relayme', page: 1, size: 20 },
    }]);
  });
});
