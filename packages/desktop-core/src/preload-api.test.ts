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
});
