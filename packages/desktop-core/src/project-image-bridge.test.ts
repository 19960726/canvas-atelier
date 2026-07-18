import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCanvasModuleNode, type CanvasProject } from '@agent-canvas/domain';

import { createDesktopBridgeHandlers } from './bridge-handlers';
import { releaseJournalState } from './journal-writer';
import { createPreloadApi, BRIDGE_CHANNELS, type DesktopBridgeInvoke } from './preload-api';
import { ProjectRepository, type OpenedProjectSession } from './project-repository';

const pngBytes = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x03,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x9d, 0x74, 0x66,
  0x7a, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
  0x44, 0xae, 0x42, 0x60, 0x82,
]);

describe('project image bridge', () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
  });

  it('exposes only narrow project-image import and list methods through preload', async () => {
    const invoke = vi.fn(async () => null) as DesktopBridgeInvoke;
    const api = createPreloadApi(invoke);

    expect(Object.keys(api.projectImages).sort()).toEqual(['importImage', 'list']);
    expect(api.projectImages).not.toHaveProperty('readFile');
    await api.projectImages.importImage({
      sessionId: 'session-1',
      target: { kind: 'module', nodeId: 'image-input' },
    });
    await api.projectImages.list({ sessionId: 'session-1' });

    expect(invoke).toHaveBeenNthCalledWith(1, BRIDGE_CHANNELS.importProjectImage, {
      sessionId: 'session-1',
      target: { kind: 'module', nodeId: 'image-input' },
    });
    expect(invoke).toHaveBeenNthCalledWith(2, BRIDGE_CHANNELS.listProjectImages, { sessionId: 'session-1' });
  });

  it('imports through the main picker and durably commits catalog plus module reference without exposing paths', async () => {
    const tempRoot = await createTempRoot(tempRoots, 'project-image-import-');
    const projectRoot = join(tempRoot, 'Images.novus-project');
    const sourcePath = join(tempRoot, 'Private Product.png');
    await writeFile(sourcePath, pngBytes);
    const repository = new ProjectRepository({ createId: sequentialId('repo'), processId: 6142 });
    const created = await repository.create(projectRoot, {
      project: imageProject(),
      projectId: 'image-project',
      projectName: 'Image Project',
    });
    await repository.close(created);
    const handlers = createDesktopBridgeHandlers({
      createId: sequentialId('bridge'),
      dialogs: {
        chooseProjectImage: vi.fn(async () => sourcePath),
        chooseProjectRoot: vi.fn(async () => projectRoot),
      },
      snapshotScheduler: {
        consider: vi.fn(() => null),
        flush: vi.fn(),
      },
    });

    try {
      const opened = await handlers.openProject({}, { mode: 'write' });
      const result = await handlers.importProjectImage({}, {
        sessionId: opened!.sessionId,
        target: { kind: 'module', nodeId: 'image-input' },
      });
      const hash = createHash('sha256').update(pngBytes).digest('hex');

      expect(result).toMatchObject({
        currentRevision: 1,
        asset: {
          assetId: hash.slice(0, 16),
          byteSize: pngBytes.length,
          displayUrl: `novus-asset://project/${opened!.sessionId}/${hash.slice(0, 16)}`,
          height: 3,
          label: 'Private Product',
          mediaType: 'image/png',
          origin: 'imported',
          sha256: hash,
          usageCount: 1,
          width: 2,
        },
        project: {
          assets: [expect.objectContaining({ assetId: hash.slice(0, 16), label: 'Private Product' })],
          nodes: expect.arrayContaining([
            expect.objectContaining({
              id: 'image-input',
              data: expect.objectContaining({ config: { assetId: hash.slice(0, 16) } }),
            }),
          ]),
        },
      });
      expect(JSON.stringify(result)).not.toContain(sourcePath);
      expect(JSON.stringify(result)).not.toContain('relativePath');

      const resolved = await handlers.resolveProjectImagePath(result!.asset.displayUrl);
      expect(resolved).toBe(await realpath(join(projectRoot, 'assets', `${hash.slice(0, 16)}.png`)));
      expect(resolved).not.toBe(sourcePath);
      await expect(access(resolved!)).resolves.toBeUndefined();

      const placementResult = await handlers.importProjectImage({}, {
        sessionId: opened!.sessionId,
        target: { kind: 'placement_reference', nodeId: 'placement', role: 'scene_composition' },
      });
      expect(placementResult).toMatchObject({
        currentRevision: 2,
        asset: { assetId: hash.slice(0, 16), label: 'Private Product', usageCount: 2 },
        project: {
          assets: [expect.objectContaining({ assetId: hash.slice(0, 16) })],
          nodes: expect.arrayContaining([expect.objectContaining({
            id: 'placement',
            data: expect.objectContaining({
              objects: [expect.objectContaining({
                assetId: hash.slice(0, 16),
                name: 'Private Product',
                role: 'scene_composition',
              })],
            }),
          })]),
        },
      });
      await expect(handlers.listProjectImages({}, { sessionId: opened!.sessionId }))
        .resolves.toEqual([placementResult!.asset]);
      await expect(handlers.commit({}, {
        baseRevision: 2,
        kind: 'canvas',
        projectId: 'image-project',
        sessionId: opened!.sessionId,
        transaction: {
          id: 'renderer-forged-project-asset',
          label: 'Renderer forged project asset',
          operations: [{
            kind: 'set_project_assets',
            assets: [
              ...(placementResult!.project.assets ?? []),
              {
                assetId: 'fedcba9876543210',
                byteSize: 1,
                extension: 'png',
                height: null,
                label: 'Forged renderer asset',
                mediaType: 'image/png',
                origin: 'imported',
                sha256: `fedcba9876543210${'0'.repeat(48)}`,
                width: null,
              },
            ],
          }],
        },
      })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
      const forgedNode = placementResult!.project.nodes.find((node) => node.id === 'image-input');
      expect(forgedNode?.type).toBe('module');
      await expect(handlers.commit({}, {
        baseRevision: 2,
        kind: 'canvas',
        projectId: 'image-project',
        sessionId: opened!.sessionId,
        transaction: {
          id: 'renderer-forged-image-reference',
          label: 'Renderer forged image reference',
          operations: [{
            kind: 'canvas',
            operation: {
              kind: 'update_node',
              node: {
                ...forgedNode!,
                data: {
                  ...(forgedNode! as Extract<CanvasProject['nodes'][number], { type: 'module' }>).data,
                  config: { assetId: 'fedcba9876543210' },
                },
              },
            },
          }],
        },
      })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
      await expect(handlers.resolveProjectImagePath(
        result!.asset.displayUrl.replace(opened!.sessionId, 'unknown-session'),
      )).resolves.toBeNull();
      await expect(handlers.resolveProjectImagePath(`${result!.asset.displayUrl}?path=fixture`)).resolves.toBeNull();

      const tamperedBytes = Buffer.from(pngBytes);
      tamperedBytes[tamperedBytes.length - 1] = tamperedBytes[tamperedBytes.length - 1]! ^ 1;
      await writeFile(join(projectRoot, 'assets', `${hash.slice(0, 16)}.png`), tamperedBytes);
      await expect(handlers.resolveProjectImagePath(result!.asset.displayUrl)).resolves.toBeNull();
    } finally {
      await handlers.closeAllProjects();
      releaseJournalState(join(projectRoot, 'journal', 'active.ndjson'), 'image-project');
    }
  });

  it('rejects renderer-supplied paths and read-only imports before opening an image picker', async () => {
    const chooseProjectImage = vi.fn(async () => 'fixture/product.png');
    const handlers = createDesktopBridgeHandlers({
      createId: sequentialId('bridge'),
      dialogs: {
        chooseProjectImage,
        chooseProjectRoot: vi.fn(async () => 'fixture/Images.novus-project'),
      },
      repository: {
        close: vi.fn(async () => undefined),
        open: vi.fn(async () => openedSession('read_only')),
        openJournalWriter: vi.fn(),
        readCurrentProject: vi.fn(async () => imageProject()),
      },
    });
    const opened = await handlers.openProject({}, { mode: 'read_only' });

    await expect(handlers.importProjectImage({}, {
      sessionId: opened!.sessionId,
      sourcePath: 'fixture/product.png',
      target: { kind: 'module', nodeId: 'image-input' },
    })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(handlers.importProjectImage({}, {
      sessionId: opened!.sessionId,
      target: { kind: 'module', nodeId: 'image-input' },
    })).rejects.toMatchObject({ code: 'CONCURRENT_WRITER' });
    expect(chooseProjectImage).not.toHaveBeenCalled();
  });

  it('rejects concurrent image pickers for the same project session', async () => {
    let resolvePicker!: (path: string | null) => void;
    const picker = new Promise<string | null>((resolve) => { resolvePicker = resolve; });
    const chooseProjectImage = vi.fn(() => picker);
    const handlers = createDesktopBridgeHandlers({
      createId: sequentialId('bridge'),
      dialogs: {
        chooseProjectImage,
        chooseProjectRoot: vi.fn(async () => 'fixture/Images.novus-project'),
      },
      repository: {
        close: vi.fn(async () => undefined),
        open: vi.fn(async () => openedSession('write')),
        openJournalWriter: vi.fn(async () => ({ commit: vi.fn() })),
        readCurrentProject: vi.fn(async () => imageProject()),
        readCurrentRevision: vi.fn(async () => 0),
      },
      snapshotScheduler: {
        consider: vi.fn(() => null),
        flush: vi.fn(),
      },
    });
    const opened = await handlers.openProject({}, { mode: 'write' });

    const firstImport = handlers.importProjectImage({}, {
      sessionId: opened!.sessionId,
      target: { kind: 'module', nodeId: 'image-input' },
    });
    await vi.waitFor(() => expect(chooseProjectImage).toHaveBeenCalledTimes(1));
    const secondImport = handlers.importProjectImage({}, {
      sessionId: opened!.sessionId,
      target: { kind: 'module', nodeId: 'image-input' },
    });
    resolvePicker(null);

    await expect(secondImport).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(firstImport).resolves.toBeNull();
    expect(chooseProjectImage).toHaveBeenCalledTimes(1);
    await handlers.closeAllProjects();
  });

  it('replaces protected source filenames before the asset label reaches the durable journal', async () => {
    const tempRoot = await createTempRoot(tempRoots, 'project-image-label-');
    const projectRoot = join(tempRoot, 'Images.novus-project');
    const protectedValue = ['sk', 'live-secret-value'].join('-');
    const sourcePath = join(tempRoot, `clientSecret=${protectedValue}.png`);
    await writeFile(sourcePath, pngBytes);
    const repository = new ProjectRepository({ createId: sequentialId('repo'), processId: 6143 });
    const created = await repository.create(projectRoot, {
      project: imageProject(),
      projectId: 'image-project',
      projectName: 'Image Project',
    });
    await repository.close(created);
    const handlers = createDesktopBridgeHandlers({
      createId: sequentialId('bridge'),
      dialogs: {
        chooseProjectImage: vi.fn(async () => sourcePath),
        chooseProjectRoot: vi.fn(async () => projectRoot),
      },
      snapshotScheduler: {
        consider: vi.fn(() => null),
        flush: vi.fn(),
      },
    });

    try {
      const opened = await handlers.openProject({}, { mode: 'write' });
      const result = await handlers.importProjectImage({}, {
        sessionId: opened!.sessionId,
        target: { kind: 'module', nodeId: 'image-input' },
      });
      const journal = await readFile(join(projectRoot, 'journal', 'active.ndjson'), 'utf8');

      expect(result!.asset.label).toMatch(/^Image [a-f0-9]{8}$/u);
      expect(JSON.stringify(result)).not.toContain(protectedValue);
      expect(journal).not.toContain(protectedValue);
      expect(journal).not.toContain('clientSecret');
    } finally {
      await handlers.closeAllProjects();
      releaseJournalState(join(projectRoot, 'journal', 'active.ndjson'), 'image-project');
    }
  });

  it('quarantines a newly written image when the durable target transaction is not acknowledged', async () => {
    const tempRoot = await createTempRoot(tempRoots, 'project-image-quarantine-');
    const projectRoot = join(tempRoot, 'Images.novus-project');
    const sourcePath = join(tempRoot, 'product.png');
    await mkdir(join(projectRoot, 'assets'), { recursive: true });
    await mkdir(join(projectRoot, 'recovery', 'quarantine'), { recursive: true });
    await writeFile(sourcePath, pngBytes);
    const handlers = createDesktopBridgeHandlers({
      createId: sequentialId('bridge'),
      dialogs: {
        chooseProjectImage: vi.fn(async () => sourcePath),
        chooseProjectRoot: vi.fn(async () => projectRoot),
      },
      repository: {
        close: vi.fn(async () => undefined),
        open: vi.fn(async () => openedSession('write', projectRoot)),
        openJournalWriter: vi.fn(async () => ({
          commit: vi.fn(async () => { throw new Error('journal append failed'); }),
        })),
        readCurrentProject: vi.fn(async () => imageProject()),
        readCurrentRevision: vi.fn(async () => 0),
      },
    });
    const opened = await handlers.openProject({}, { mode: 'write' });

    await expect(handlers.importProjectImage({}, {
      sessionId: opened!.sessionId,
      target: { kind: 'module', nodeId: 'image-input' },
    })).rejects.toThrow(/journal append failed/);

    expect(await readdir(join(projectRoot, 'assets'))).toEqual([]);
    expect(await readdir(join(projectRoot, 'recovery', 'quarantine'))).toHaveLength(1);
  });
});

function imageProject(): CanvasProject {
  return {
    version: 1,
    graphVersion: 2,
    id: 'image-project',
    name: 'Image Project',
    nodes: [
      createCanvasModuleNode('image-input', 'image_input', { x: 0, y: 0 }),
      {
        id: 'placement',
        type: 'placement_preview',
        position: { x: 320, y: 0 },
        data: {
          board: { id: 'board', aspectRatio: '1:1', width: 1024, height: 1024, safeAreas: [] },
          objects: [],
        },
      },
    ],
    edges: [],
    projectMemory: [],
    skillPromotionCandidates: [],
  };
}

function openedSession(mode: 'write' | 'read_only', root = 'fixture/Images.novus-project'): OpenedProjectSession {
  return {
    lock: mode === 'write' ? {
      channel: 'modern',
      deviceId: 'device',
      heartbeatAt: '2026-07-18T00:00:00.000Z',
      openedAt: '2026-07-18T00:00:00.000Z',
      processId: 1,
      projectId: 'image-project',
      schemaVersion: 1,
      sessionId: 'lock-session',
    } : null,
    manifest: {
      activeJournalSegment: 'journal/active.ndjson',
      assetInventory: { assetCount: 0, totalBytes: 0 },
      cleanClose: false,
      formatVersion: 1,
      minimumCompatibleWriterVersion: 1,
      nextSequence: 1,
      projectId: 'image-project',
      projectName: 'Image Project',
      stableSnapshotId: null,
      stableSnapshotPath: null,
      stableSnapshotRevision: 0,
    },
    mode,
    root,
  };
}

function sequentialId(prefix: string): () => string {
  let value = 0;
  return () => `${prefix}-${++value}`;
}

async function createTempRoot(tempRoots: string[], prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}
