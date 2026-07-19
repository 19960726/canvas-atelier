import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCanvasModuleNode, type CanvasProject } from '@agent-canvas/domain';

import type { AssetMetadata } from './asset-store';
import { createDesktopBridgeHandlers } from './bridge-handlers';
import type { CommitRequest } from './contracts';
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

  it('reports a referenced but missing managed asset explicitly without leaking its project path', async () => {
    const tempRoot = await createTempRoot(tempRoots, 'project-image-missing-');
    const projectRoot = join(tempRoot, 'MissingImage.novus-project');
    const missingAssetId = '0123456789abcdef';
    const repository = new ProjectRepository({ createId: sequentialId('repo'), processId: 6144 });
    const created = await repository.create(projectRoot, {
      project: {
        ...imageProject(),
        assets: [{
          assetId: missingAssetId,
          byteSize: pngBytes.length,
          extension: 'png',
          height: 3,
          label: 'Missing managed image',
          mediaType: 'image/png',
          origin: 'imported',
          sha256: `${missingAssetId}${'0'.repeat(48)}`,
          width: 2,
        }],
      },
      projectId: 'image-project-missing',
      projectName: 'MissingImage',
    });
    await repository.close(created);
    const handlers = createDesktopBridgeHandlers({
      createId: sequentialId('bridge'),
      dialogs: {
        chooseProjectImage: vi.fn(async () => null),
        chooseProjectRoot: vi.fn(async () => projectRoot),
      },
    });

    try {
      const opened = await handlers.openProject({}, { mode: 'write' });
      const failure = await handlers.listProjectImages({}, { sessionId: opened!.sessionId })
        .catch((error: unknown) => error);

      expect(failure).toMatchObject({ code: 'MISSING_ASSET', retryable: true });
      expect(JSON.stringify(failure)).not.toContain(projectRoot);
    } finally {
      await handlers.closeAllProjects();
      releaseJournalState(join(projectRoot, 'journal', 'active.ndjson'), 'image-project-missing');
    }
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

  it.each(['closed', 'retry_only'] as const)(
    'fences a deferred image picker after the session becomes %s',
    async (sessionState) => {
      const tempRoot = await createTempRoot(tempRoots, `project-image-${sessionState}-picker-`);
      const sourcePath = join(tempRoot, 'product.png');
      await writeFile(sourcePath, pngBytes);
      const picker = deferred<string | null>();
      const chooseProjectImage = vi.fn(() => picker.promise);
      const writerCommit = vi.fn(async (request: CommitRequest) => ({
        committedAt: '2026-07-19T00:00:00.000Z',
        projectId: 'image-project',
        revision: 1,
        sequence: 1,
        transactionId: request.transaction.id,
      }));
      const stageAndCommit = vi.fn(async (
        _root: string,
        _source: NodeJS.ReadableStream,
        options: { readonly commitReference?: (asset: AssetMetadata) => Promise<void> },
      ) => {
        (_source as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
        const asset = storedAsset();
        await options.commitReference?.(asset);
        return asset;
      });
      const flush = vi.fn();
      let closeCalls = 0;
      const close = vi.fn(async () => {
        closeCalls += 1;
        if (sessionState === 'retry_only' && closeCalls === 1) {
          throw Object.assign(new Error('Injected partial close failure'), {
            code: 'DURABLE_WRITE_FAILED',
            retryable: true,
          });
        }
      });
      const handlers = createDesktopBridgeHandlers({
        assetStore: {
          list: vi.fn(async () => []),
          resolvePath: vi.fn(async () => null),
          stageAndCommit,
        },
        createId: sequentialId('bridge'),
        dialogs: {
          chooseProjectImage,
          chooseProjectRoot: vi.fn(async () => 'fixture/Images.novus-project'),
        },
        repository: {
          close,
          open: vi.fn(async () => openedSession('write')),
          openJournalWriter: vi.fn(async () => ({ commit: writerCommit })),
          readCurrentProject: vi.fn(async () => imageProject()),
          readCurrentRevision: vi.fn(async () => 0),
        },
        snapshotScheduler: {
          consider: vi.fn(() => null),
          flush,
        },
      });
      const opened = await handlers.openProject({}, { mode: 'write' });
      if (opened === null) throw new Error('Expected project session');
      const importing = handlers.importProjectImage({}, {
        sessionId: opened.sessionId,
        target: { kind: 'module', nodeId: 'image-input' },
      });
      await vi.waitFor(() => expect(chooseProjectImage).toHaveBeenCalledTimes(1));

      if (sessionState === 'retry_only') {
        await expect(handlers.closeProject({}, {
          flush: false,
          sessionId: opened.sessionId,
        })).rejects.toMatchObject({ code: 'DURABLE_WRITE_FAILED' });
      } else {
        await handlers.closeProject({}, { flush: false, sessionId: opened.sessionId });
      }
      picker.resolve(sourcePath);

      try {
        const outcome = await importing.catch((error: unknown) => error);
        expect.soft(outcome).toMatchObject({ code: 'INVALID_SESSION' });
        expect.soft(stageAndCommit).not.toHaveBeenCalled();
        expect.soft(writerCommit).not.toHaveBeenCalled();
        expect.soft(flush).not.toHaveBeenCalled();
      } finally {
        await handlers.closeAllProjects().catch(() => undefined);
      }
    },
  );

  it.each(['restored', 'recovery_required'] as const)(
    'rejects a deferred image import after the session becomes %s',
    async (sessionState) => {
      const tempRoot = await createTempRoot(tempRoots, `project-image-${sessionState}-`);
      const projectRoot = join(tempRoot, 'Images.novus-project');
      const sourcePath = join(tempRoot, 'product.png');
      const mirrorPath = join(tempRoot, 'recovery-candidate.json');
      await writeFile(sourcePath, pngBytes);
      await writeFile(mirrorPath, sessionState === 'restored'
        ? `${JSON.stringify({
          project: imageProject(),
          projectId: 'image-project',
          revision: 0,
          snapshotId: 'recovery-image-0',
        })}\n`
        : '{}\n');
      const repository = new ProjectRepository({ createId: sequentialId('repo'), processId: 6150 });
      const created = await repository.create(projectRoot, {
        project: imageProject(),
        projectId: 'image-project',
        projectName: 'Image Project',
      });
      await repository.close(created);
      const picker = deferred<string | null>();
      const chooseProjectImage = vi.fn(() => picker.promise);
      const writerCommit = vi.fn();
      const stageAndCommit = vi.fn(async (
        _root: string,
        _source: NodeJS.ReadableStream,
        options: { readonly commitReference?: (asset: AssetMetadata) => Promise<void> },
      ) => {
        (_source as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
        const asset = storedAsset();
        await options.commitReference?.(asset);
        return asset;
      });
      const flush = vi.fn();
      const handlers = createDesktopBridgeHandlers({
        assetStore: {
          list: vi.fn(async () => []),
          resolvePath: vi.fn(async () => null),
          stageAndCommit,
        },
        createId: sequentialId('bridge'),
        dialogs: {
          chooseProjectImage,
          chooseProjectRoot: vi.fn(async () => projectRoot),
        },
        recoveryScanner: {
          scan: vi.fn(async () => ({
            action: 'choose_recovery' as const,
            candidates: [{
              path: mirrorPath,
              project: imageProject(),
              revision: 0,
              snapshotId: 'recovery-image-0',
              tailStatus: 'complete' as const,
            }],
            issues: ['corrupt_snapshot'],
            projectId: 'image-project',
            recoveredRevision: 0,
            stableSnapshotId: 'recovery-image-0',
            targetRevision: 0,
          })),
        },
        repository: {
          close: repository.close.bind(repository),
          open: repository.open.bind(repository),
          openJournalWriter: vi.fn(async (session) => {
            const writer = await repository.openJournalWriter(session);
            return {
              commit: async (request: CommitRequest) => {
                writerCommit(request);
                return writer.commit(request);
              },
            };
          }),
          readCurrentProject: repository.readCurrentProject.bind(repository),
          readCurrentRevision: repository.readCurrentRevision.bind(repository),
        },
        snapshotScheduler: {
          consider: vi.fn(() => null),
          flush,
        },
      });

      try {
        const opened = await handlers.openProject({}, { mode: 'write' });
        if (opened === null) throw new Error('Expected project session');
        const importing = handlers.importProjectImage({}, {
          sessionId: opened.sessionId,
          target: { kind: 'module', nodeId: 'image-input' },
        });
        await vi.waitFor(() => expect(chooseProjectImage).toHaveBeenCalledTimes(1));
        const recoveryPlan = await handlers.getRecoveryPlan({}, { sessionId: opened.sessionId });
        const candidateId = recoveryPlan.candidates[0]?.candidateId;
        if (candidateId === undefined) throw new Error('Expected recovery candidate');
        if (sessionState === 'restored') {
          await handlers.restore({}, { candidateId, sessionId: opened.sessionId });
        } else {
          await expect(handlers.restore({}, {
            candidateId,
            sessionId: opened.sessionId,
          })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
        }
        picker.resolve(sourcePath);

        const outcome = await importing.catch((error: unknown) => error);
        expect.soft(outcome).toMatchObject({
          code: sessionState === 'restored' ? 'INVALID_SESSION' : 'RECOVERY_REQUIRED',
        });
        expect.soft(stageAndCommit).not.toHaveBeenCalled();
        expect.soft(writerCommit).not.toHaveBeenCalled();
        expect.soft(flush).not.toHaveBeenCalled();
      } finally {
        await handlers.closeAllProjects().catch(() => undefined);
        releaseJournalState(join(projectRoot, 'journal', 'active.ndjson'), 'image-project');
      }
    },
  );

  it('serializes a managed image import through snapshot completion before close cleanup', async () => {
    const tempRoot = await createTempRoot(tempRoots, 'project-image-close-order-');
    const projectRoot = join(tempRoot, 'Images.novus-project');
    const sourcePath = join(tempRoot, 'product.png');
    await writeFile(sourcePath, pngBytes);
    const repository = new ProjectRepository({ createId: sequentialId('repo'), processId: 6151 });
    const created = await repository.create(projectRoot, {
      project: imageProject(),
      projectId: 'image-project',
      projectName: 'Image Project',
    });
    await repository.close(created);
    const picker = deferred<string | null>();
    const stageGate = deferred<void>();
    const stageEntered = deferred<void>();
    const closeGate = deferred<void>();
    const closeEntered = deferred<void>();
    const events: string[] = [];
    const stageAndCommit = vi.fn(async (
      _root: string,
      _source: NodeJS.ReadableStream,
      options: { readonly commitReference?: (asset: AssetMetadata) => Promise<void> },
    ) => {
      (_source as NodeJS.ReadableStream & { destroy?: () => void }).destroy?.();
      events.push('stage');
      stageEntered.resolve();
      await stageGate.promise;
      const asset = storedAsset();
      await options.commitReference?.(asset);
      return asset;
    });
    const close = vi.fn(async (session: OpenedProjectSession) => {
      events.push('close');
      closeEntered.resolve();
      await closeGate.promise;
      await repository.close(session);
    });
    const flush = vi.fn(async () => {
      events.push('flush');
      return {
        path: 'snapshots/image-import.json.gz',
        reason: 'agent_transaction' as const,
        revision: 1,
        snapshotId: 'image-import',
      };
    });
    const handlers = createDesktopBridgeHandlers({
      assetStore: {
        list: vi.fn(async () => []),
        resolvePath: vi.fn(async () => null),
        stageAndCommit,
      },
      createId: sequentialId('bridge'),
      dialogs: {
        chooseProjectImage: vi.fn(() => picker.promise),
        chooseProjectRoot: vi.fn(async () => projectRoot),
      },
      repository: {
        close,
        open: repository.open.bind(repository),
        openJournalWriter: vi.fn(async (session) => {
          const writer = await repository.openJournalWriter(session);
          return {
            commit: async (request: CommitRequest) => {
              events.push('writer');
              return writer.commit(request);
            },
          };
        }),
        readCurrentProject: repository.readCurrentProject.bind(repository),
        readCurrentRevision: repository.readCurrentRevision.bind(repository),
      },
      snapshotScheduler: {
        consider: vi.fn(() => ({ reason: 'agent_transaction' as const })),
        flush,
      },
    });

    try {
      const opened = await handlers.openProject({}, { mode: 'write' });
      if (opened === null) throw new Error('Expected project session');
      const importing = handlers.importProjectImage({}, {
        sessionId: opened.sessionId,
        target: { kind: 'module', nodeId: 'image-input' },
      });
      picker.resolve(sourcePath);
      await stageEntered.promise;

      const closing = handlers.closeProject({}, { flush: false, sessionId: opened.sessionId });
      const closeStartedBeforeImportSettled = await Promise.race([
        closeEntered.promise.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 30)),
      ]);
      stageGate.resolve();
      const result = await importing;
      closeGate.resolve();
      await closing;

      expect.soft(closeStartedBeforeImportSettled).toBe(false);
      expect.soft(result).toMatchObject({ currentRevision: 1, project: { id: 'image-project' } });
      expect.soft(events).toEqual(['stage', 'writer', 'flush', 'close']);
    } finally {
      stageGate.resolve();
      closeGate.resolve();
      await handlers.closeAllProjects().catch(() => undefined);
      releaseJournalState(join(projectRoot, 'journal', 'active.ndjson'), 'image-project');
    }
  });

  it('replaces protected source filenames before the asset label reaches the durable journal', async () => {
    const tempRoot = await createTempRoot(tempRoots, 'project-image-label-');
    const projectRoot = join(tempRoot, 'Images.novus-project');
    const protectedIdentifier = ['OPENAI', 'API', 'KEY'].join('_');
    const protectedValue = 'private-value';
    const sourcePath = join(tempRoot, `${protectedIdentifier}=${protectedValue}.png`);
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
      expect(journal).not.toContain(protectedIdentifier);
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
    })).rejects.toMatchObject({
      code: 'DURABLE_WRITE_FAILED',
      message: 'Managed project asset write failed: durable storage operation failed',
      retryable: true,
    });

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

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function storedAsset(): AssetMetadata {
  return {
    byteSize: pngBytes.length,
    extension: 'png',
    height: 3,
    id: '0123456789abcdef',
    mediaType: 'image/png',
    relativePath: 'assets/0123456789abcdef.png',
    sha256: `0123456789abcdef${'0'.repeat(48)}`,
    width: 2,
  };
}

async function createTempRoot(tempRoots: string[], prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}
