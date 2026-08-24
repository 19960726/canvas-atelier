import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CanvasProject } from '@agent-canvas/domain';

import { createDesktopBridgeHandlers, registerDesktopBridgeHandlers } from './bridge-handlers';
import { BRIDGE_CHANNELS } from './preload-api';
import type { OpenedProjectSession } from './project-repository';

const project: CanvasProject = {
  version: 1,
  id: 'project-recent',
  name: '最近项目',
  nodes: [],
  edges: [],
  assets: [],
  projectMemory: [],
  skillPromotionCandidates: [],
};

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const summary = {
  recentProjectId: 'recent_0123456789abcdef01234567',
  projectId: project.id,
  displayName: project.name,
  lastOpenedAt: '2026-08-10T08:00:00.000Z',
  lastSavedAt: '2026-08-10T08:00:00.000Z',
  availability: 'available' as const,
  nodeCount: 0,
  imageCount: 0,
  videoCount: 0,
  previewUrl: null,
};

describe('recent project desktop bridge', () => {
  it('registers all recent-project IPC channels', () => {
    const channels: string[] = [];
    const handlers = createDesktopBridgeHandlers({
      recentProjectStore: createRecentProjectStoreStub(),
      repository: { close: vi.fn(async () => undefined) },
    });

    registerDesktopBridgeHandlers({
      handle(channel) {
        channels.push(channel);
      },
    }, handlers);

    expect(channels).toEqual(expect.arrayContaining([
      BRIDGE_CHANNELS.recentProjects.list,
      BRIDGE_CHANNELS.recentProjects.open,
      BRIDGE_CHANNELS.recentProjects.remove,
      BRIDGE_CHANNELS.recentProjects.relocate,
    ]));
  });

  it('writes a captured project preview after the first durable save', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'novus-project-preview-'));
    tempRoots.push(tempRoot);
    const appDataRoot = join(tempRoot, 'app-data');
    const projectRoot = join(appDataRoot, 'projects', `${project.id}.novus-project`);
    const previewBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    let nextId = 0;
    const chooseCreateProjectRoot = vi.fn(async () => join(tempRoot, 'must-not-be-used.novus-project'));
    const handlers = createDesktopBridgeHandlers({
      appDataRoot,
      captureProjectPreview: vi.fn(async () => previewBytes),
      createId: () => `preview-${++nextId}`,
      dialogs: { chooseCreateProjectRoot },
    });

    try {
      await expect(handlers.createProject({}, { project })).resolves.toMatchObject({ projectId: project.id });
      await expect(readFile(join(projectRoot, 'preview.png'))).resolves.toEqual(Buffer.from(previewBytes));
      expect(chooseCreateProjectRoot).not.toHaveBeenCalled();
    } finally {
      await handlers.closeAllProjects();
    }
  });

  it('keeps one recent-project entry when the same managed canvas is saved repeatedly', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'novus-project-save-dedupe-'));
    tempRoots.push(tempRoot);
    const appDataRoot = join(tempRoot, 'app-data');
    let nextId = 0;
    const handlers = createDesktopBridgeHandlers({
      appDataRoot,
      createId: () => `save-dedupe-${++nextId}`,
      now: () => '2026-08-12T08:00:00.000Z',
    });

    try {
      const created = await handlers.createProject({}, { project });
      expect(created).not.toBeNull();

      await handlers.createStablePoint({}, { sessionId: created!.sessionId });
      await handlers.createStablePoint({}, { sessionId: created!.sessionId });

      const recentProjects = await handlers.listRecentProjects({});
      expect(recentProjects).toHaveLength(1);
      expect(recentProjects[0]).toMatchObject({
        projectId: project.id,
        displayName: project.name,
      });
    } finally {
      await handlers.closeAllProjects();
    }
  });

  it('opens an opaque recent-project id without asking the renderer for a native path', async () => {
    const projectRoot = 'C:\\private\\Recent.novus-project';
    const recentProjectStore = createRecentProjectStoreStub({ resolveRoot: vi.fn(async () => projectRoot) });
    const open = vi.fn(async () => createOpenedSession(projectRoot));
    const chooseProjectRoot = vi.fn(async () => 'C:\\renderer-must-not-choose\\Other.novus-project');
    const handlers = createDesktopBridgeHandlers({
      createId: () => 'session-recent',
      dialogs: { chooseProjectRoot },
      now: () => '2026-08-10T09:00:00.000Z',
      recentProjectStore,
      repository: {
        close: vi.fn(async () => undefined),
        open,
        openJournalWriter: vi.fn(async () => ({ commit: vi.fn() })),
        readCurrentProject: vi.fn(async () => project),
        readCurrentRevision: vi.fn(async () => 0),
      },
    });

    await expect(handlers.openRecentProject({}, {
      recentProjectId: summary.recentProjectId,
      mode: 'write',
    })).resolves.toMatchObject({ projectId: project.id, sessionId: 'session-recent' });

    expect(recentProjectStore.resolveRoot).toHaveBeenCalledWith(summary.recentProjectId);
    expect(open).toHaveBeenCalledWith(projectRoot, { mode: 'write' });
    expect(chooseProjectRoot).not.toHaveBeenCalled();
    expect(recentProjectStore.upsert).toHaveBeenCalledWith(expect.objectContaining({
      root: projectRoot,
      projectId: project.id,
      lastOpenedAt: '2026-08-10T09:00:00.000Z',
    }));
  });
});

function createRecentProjectStoreStub(overrides: Record<string, unknown> = {}) {
  return {
    list: vi.fn(async () => [summary]),
    relocate: vi.fn(async () => summary),
    remove: vi.fn(async () => []),
    resolvePreviewPath: vi.fn(async () => null),
    resolveRoot: vi.fn(async () => null),
    upsert: vi.fn(async () => [summary]),
    ...overrides,
  };
}

function createOpenedSession(root: string): OpenedProjectSession {
  return {
    lock: {
      schemaVersion: 1,
      projectId: project.id,
      deviceId: 'device-1',
      processId: 1,
      channel: 'modern',
      sessionId: 'lock-session',
      openedAt: '2026-08-10T08:00:00.000Z',
      heartbeatAt: '2026-08-10T08:00:00.000Z',
    },
    manifest: {
      projectId: project.id,
      projectName: project.name,
      formatVersion: 1,
      stableSnapshotId: null,
      stableSnapshotPath: null,
      stableSnapshotRevision: 0,
      activeJournalSegment: 'journal/active.ndjson',
      nextSequence: 1,
      assetInventory: { assetCount: 0, totalBytes: 0 },
      cleanClose: false,
      minimumCompatibleWriterVersion: 1,
    },
    mode: 'write',
    root,
  };
}
