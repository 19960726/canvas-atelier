import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCanvasModuleNode, type CanvasProject } from '@agent-canvas/domain';

import { createDesktopBridgeHandlers } from './bridge-handlers';
import { releaseJournalState } from './journal-writer';
import { ProjectRepository } from './project-repository';

describe('project video bridge', () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
  });

  it('atomically imports a managed MP4 and binds it to a video input node', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'project-video-bridge-'));
    tempRoots.push(tempRoot);
    const projectRoot = join(tempRoot, 'Video.novus-project');
    const sourcePath = join(tempRoot, 'turntable.mp4');
    const bytes = createMinimalMp4();
    await writeFile(sourcePath, bytes);
    const repository = new ProjectRepository({ createId: sequentialId('repo'), processId: 7711 });
    const created = await repository.create(projectRoot, {
      project: videoProject(),
      projectId: 'video-project',
      projectName: 'Video Project',
    });
    await repository.close(created);
    const handlers = createDesktopBridgeHandlers({
      createId: sequentialId('bridge'),
      dialogs: {
        chooseProjectRoot: vi.fn(async () => projectRoot),
        chooseProjectVideo: vi.fn(async () => sourcePath),
      },
      snapshotScheduler: { consider: vi.fn(() => null), flush: vi.fn() },
    });

    try {
      const opened = await handlers.openProject({}, { mode: 'write' });
      const result = await handlers.importProjectVideo({}, {
        sessionId: opened!.sessionId,
        target: { kind: 'module', nodeId: 'video-input' },
      });

      expect(result).toMatchObject({
        currentRevision: 1,
        asset: {
          byteSize: bytes.length,
          durationMs: null,
          extension: 'mp4',
          label: expect.stringMatching(/^Video [a-f0-9]{8}$/u),
          mediaType: 'video/mp4',
        },
        project: {
          assets: [expect.objectContaining({ mediaType: 'video/mp4' })],
          nodes: [expect.objectContaining({
            id: 'video-input',
            data: expect.objectContaining({ config: { assetId: expect.stringMatching(/^[a-f0-9]{16}$/u) } }),
          })],
        },
      });
      expect(new URL(result!.asset.displayUrl).protocol).toBe('novus-asset:');
      expect(JSON.stringify(result)).not.toMatch(/turntable\.mp4|[A-Z]:\\|"bytes"|base64/iu);
      expect(await readFile(join(projectRoot, 'assets', `${result!.asset.assetId}.mp4`))).toEqual(bytes);
    } finally {
      await handlers.closeAllProjects();
      releaseJournalState(join(projectRoot, 'journal', 'active.ndjson'), 'video-project');
    }
  });

  it('reports MISSING_ASSET when a catalogued MP4 is replaced by same-size corrupt bytes', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'project-video-list-integrity-'));
    tempRoots.push(tempRoot);
    const projectRoot = join(tempRoot, 'Video.novus-project');
    const sourcePath = join(tempRoot, 'turntable.mp4');
    const bytes = createMinimalMp4();
    await writeFile(sourcePath, bytes);
    const repository = new ProjectRepository({ createId: sequentialId('repo'), processId: 7722 });
    const created = await repository.create(projectRoot, {
      project: videoProject(),
      projectId: 'video-project',
      projectName: 'Video Project',
    });
    await repository.close(created);
    const handlers = createDesktopBridgeHandlers({
      dialogs: {
        chooseProjectRoot: vi.fn(async () => projectRoot),
        chooseProjectVideo: vi.fn(async () => sourcePath),
      },
      snapshotScheduler: { consider: vi.fn(() => null), flush: vi.fn() },
    });

    try {
      const opened = await handlers.openProject({}, { mode: 'write' });
      const imported = await handlers.importProjectVideo({}, {
        sessionId: opened!.sessionId,
        target: { kind: 'module', nodeId: 'video-input' },
      });
      const corrupted = Buffer.from(bytes);
      corrupted[corrupted.length - 1] = corrupted[corrupted.length - 1]! ^ 1;
      await writeFile(join(projectRoot, 'assets', `${imported!.asset.assetId}.mp4`), corrupted);

      await expect(handlers.listProjectVideos({}, { sessionId: opened!.sessionId }))
        .rejects.toMatchObject({ code: 'MISSING_ASSET' });
    } finally {
      await handlers.closeAllProjects();
      releaseJournalState(join(projectRoot, 'journal', 'active.ndjson'), 'video-project');
    }
  });

  it('never exposes the source video filename through labels, bridge results, or the durable journal', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'project-video-label-'));
    tempRoots.push(tempRoot);
    const projectRoot = join(tempRoot, 'Video.novus-project');
    const confidentialName = 'Acquisition-Target-2027';
    const sourcePath = join(tempRoot, `${confidentialName}.mp4`);
    await writeFile(sourcePath, createMinimalMp4());
    const repository = new ProjectRepository({ createId: sequentialId('repo'), processId: 7712 });
    const created = await repository.create(projectRoot, {
      project: videoProject(),
      projectId: 'video-project',
      projectName: 'Video Project',
    });
    await repository.close(created);
    const handlers = createDesktopBridgeHandlers({
      createId: sequentialId('bridge'),
      dialogs: {
        chooseProjectRoot: vi.fn(async () => projectRoot),
        chooseProjectVideo: vi.fn(async () => sourcePath),
      },
      snapshotScheduler: { consider: vi.fn(() => null), flush: vi.fn() },
    });

    try {
      const opened = await handlers.openProject({}, { mode: 'write' });
      const result = await handlers.importProjectVideo({}, {
        sessionId: opened!.sessionId,
        target: { kind: 'module', nodeId: 'video-input' },
      });
      const journal = await readFile(join(projectRoot, 'journal', 'active.ndjson'), 'utf8');
      const publicResult = JSON.stringify(result);

      expect(result!.asset.label).toMatch(/^Video [a-f0-9]{8}$/u);
      expect(publicResult).not.toContain(confidentialName);
      expect(publicResult).not.toContain(sourcePath);
      expect(journal).not.toContain(confidentialName);
      expect(journal).not.toContain(sourcePath);
    } finally {
      await handlers.closeAllProjects();
      releaseJournalState(join(projectRoot, 'journal', 'active.ndjson'), 'video-project');
    }
  });

  it('returns null without writing when video selection is cancelled', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'project-video-cancel-'));
    tempRoots.push(tempRoot);
    const projectRoot = join(tempRoot, 'Video.novus-project');
    const repository = new ProjectRepository({ createId: sequentialId('repo'), processId: 7712 });
    const created = await repository.create(projectRoot, {
      project: videoProject(),
      projectId: 'video-project',
      projectName: 'Video Project',
    });
    await repository.close(created);
    const handlers = createDesktopBridgeHandlers({
      dialogs: {
        chooseProjectRoot: vi.fn(async () => projectRoot),
        chooseProjectVideo: vi.fn(async () => null),
      },
    });
    try {
      const opened = await handlers.openProject({}, { mode: 'write' });
      await expect(handlers.importProjectVideo({}, {
        sessionId: opened!.sessionId,
        target: { kind: 'module', nodeId: 'video-input' },
      })).resolves.toBeNull();
      expect(await readFile(join(projectRoot, 'journal', 'active.ndjson'), 'utf8')).toBe('');
    } finally {
      await handlers.closeAllProjects();
      releaseJournalState(join(projectRoot, 'journal', 'active.ndjson'), 'video-project');
    }
  });

  it('atomically pastes one clipboard MP4 into a new video input node', async () => {
    const fixture = await createEmptyVideoProject(tempRoots, 'project-video-paste-', 7713);
    const sourcePath = join(fixture.tempRoot, 'clipboard.mp4');
    const bytes = createMinimalMp4();
    await writeFile(sourcePath, bytes);
    const readVideoPath = vi.fn(async () => ({ sourcePath }));
    const handlers = createDesktopBridgeHandlers({
      clipboardVideo: { readVideoPath },
      dialogs: { chooseProjectRoot: vi.fn(async () => fixture.projectRoot) },
      snapshotScheduler: { consider: vi.fn(() => null), flush: vi.fn() },
    });

    try {
      const opened = await handlers.openProject({}, { mode: 'write' });
      const result = await handlers.pasteProjectClipboardVideo({}, {
        sessionId: opened!.sessionId,
        target: { kind: 'new_video_input', operationId: 'clipboard_video_atomic', position: { x: 120, y: -40 } },
      });

      expect(readVideoPath).toHaveBeenCalledOnce();
      expect(result).toMatchObject({
        currentRevision: 1,
        asset: { extension: 'mp4', mediaType: 'video/mp4' },
        project: {
          nodes: [expect.objectContaining({
            position: { x: 120, y: -40 },
            data: expect.objectContaining({ moduleType: 'video_input', config: { assetId: expect.any(String) } }),
          })],
        },
      });
      expect(JSON.stringify(result)).not.toMatch(/clipboard\.mp4|[A-Z]:\\|"sourcePath"|"bytes"/iu);
    } finally {
      await handlers.closeAllProjects();
      releaseJournalState(join(fixture.projectRoot, 'journal', 'active.ndjson'), 'video-project');
    }
  });

  it('replays a clipboard video operation after snapshot failure without rereading or duplicating', async () => {
    const fixture = await createEmptyVideoProject(tempRoots, 'project-video-replay-', 7714);
    const sourcePath = join(fixture.tempRoot, 'clipboard.mp4');
    await writeFile(sourcePath, createMinimalMp4());
    const readVideoPath = vi.fn(async () => ({ sourcePath }));
    const flush = vi.fn().mockRejectedValueOnce(new Error('snapshot response lost')).mockResolvedValue(undefined);
    const handlers = createDesktopBridgeHandlers({
      clipboardVideo: { readVideoPath },
      dialogs: { chooseProjectRoot: vi.fn(async () => fixture.projectRoot) },
      snapshotScheduler: { consider: vi.fn(() => ({ reason: 'agent_transaction' as const })), flush },
    });
    const target = { kind: 'new_video_input' as const, operationId: 'clipboard_video_replay', position: { x: 20, y: 30 } };

    try {
      const opened = await handlers.openProject({}, { mode: 'write' });
      await expect(handlers.pasteProjectClipboardVideo({}, { sessionId: opened!.sessionId, target }))
        .rejects.toThrow('snapshot response lost');
      const replayed = await handlers.pasteProjectClipboardVideo({}, { sessionId: opened!.sessionId, target });

      expect(readVideoPath).toHaveBeenCalledOnce();
      expect(replayed!.project.nodes).toHaveLength(1);
      expect(replayed!.project.assets).toHaveLength(1);
      expect(replayed!.currentRevision).toBe(1);
    } finally {
      await handlers.closeAllProjects();
      releaseJournalState(join(fixture.projectRoot, 'journal', 'active.ndjson'), 'video-project');
    }
  });

  it('reconciles a durable clipboard video commit when every commit acknowledgement is lost', async () => {
    const fixture = await createEmptyVideoProject(tempRoots, 'project-video-commit-ack-', 7720);
    const sourcePath = join(fixture.tempRoot, 'clipboard.mp4');
    await writeFile(sourcePath, createMinimalMp4());
    const repository = new ProjectRepository({ createId: sequentialId('repo-ack'), processId: 7721 });
    let commitCalls = 0;
    const handlers = createDesktopBridgeHandlers({
      clipboardVideo: { readVideoPath: vi.fn(async () => ({ sourcePath })) },
      dialogs: { chooseProjectRoot: vi.fn(async () => fixture.projectRoot) },
      repository: {
        close: repository.close.bind(repository),
        open: repository.open.bind(repository),
        openJournalWriter: async (session) => {
          const writer = await repository.openJournalWriter(session);
          return {
            commit: async (request) => {
              commitCalls += 1;
              await writer.commit(request);
              throw new Error('commit acknowledgement lost');
            },
          };
        },
        readCurrentProject: repository.readCurrentProject.bind(repository),
        readCurrentRevision: repository.readCurrentRevision.bind(repository),
      },
      snapshotScheduler: { consider: vi.fn(() => null), flush: vi.fn() },
    });
    const target = {
      kind: 'new_video_input' as const,
      operationId: 'clipboard_video_commit-ack',
      position: { x: 45, y: 55 },
    };

    try {
      const opened = await handlers.openProject({}, { mode: 'write' });
      const result = await handlers.pasteProjectClipboardVideo({}, { sessionId: opened!.sessionId, target });

      expect(result).toMatchObject({ currentRevision: 1 });
      expect(commitCalls).toBe(1);
      expect(result!.project.nodes).toHaveLength(1);
      expect(result!.project.assets).toHaveLength(1);
      await expect(readFile(join(
        fixture.projectRoot,
        'assets',
        `${result!.asset.assetId}.mp4`,
      ))).resolves.toEqual(createMinimalMp4());
    } finally {
      await handlers.closeAllProjects();
      releaseJournalState(join(fixture.projectRoot, 'journal', 'active.ndjson'), 'video-project');
    }
  });

  it('replays the same clipboard video operation after restart without reading the clipboard again', async () => {
    const fixture = await createEmptyVideoProject(tempRoots, 'project-video-restart-', 7717);
    const sourcePath = join(fixture.tempRoot, 'clipboard.mp4');
    await writeFile(sourcePath, createMinimalMp4());
    const target = { kind: 'new_video_input' as const, operationId: 'clipboard_video_restart', position: { x: 50, y: 70 } };
    const firstRead = vi.fn(async () => ({ sourcePath }));
    const firstHandlers = createDesktopBridgeHandlers({
      clipboardVideo: { readVideoPath: firstRead },
      dialogs: { chooseProjectRoot: vi.fn(async () => fixture.projectRoot) },
      snapshotScheduler: { consider: vi.fn(() => null), flush: vi.fn() },
    });
    const firstOpened = await firstHandlers.openProject({}, { mode: 'write' });
    await firstHandlers.pasteProjectClipboardVideo({}, { sessionId: firstOpened!.sessionId, target });
    await firstHandlers.closeAllProjects();
    releaseJournalState(join(fixture.projectRoot, 'journal', 'active.ndjson'), 'video-project');

    const secondRead = vi.fn(async () => { throw new Error('clipboard must not be read'); });
    const secondHandlers = createDesktopBridgeHandlers({
      clipboardVideo: { readVideoPath: secondRead },
      dialogs: { chooseProjectRoot: vi.fn(async () => fixture.projectRoot) },
      snapshotScheduler: { consider: vi.fn(() => null), flush: vi.fn() },
    });
    try {
      const reopened = await secondHandlers.openProject({}, { mode: 'write' });
      const replayed = await secondHandlers.pasteProjectClipboardVideo({}, { sessionId: reopened!.sessionId, target });

      expect(firstRead).toHaveBeenCalledOnce();
      expect(secondRead).not.toHaveBeenCalled();
      expect(replayed!.project.nodes).toHaveLength(1);
      expect(replayed!.currentRevision).toBe(1);
    } finally {
      await secondHandlers.closeAllProjects();
      releaseJournalState(join(fixture.projectRoot, 'journal', 'active.ndjson'), 'video-project');
    }
  });

  it('returns null for reconcile-only clipboard video when no durable operation exists', async () => {
    const fixture = await createEmptyVideoProject(tempRoots, 'project-video-reconcile-only-', 7724);
    const readVideoPath = vi.fn(async () => { throw new Error('clipboard must not be read'); });
    const handlers = createDesktopBridgeHandlers({
      clipboardVideo: { readVideoPath },
      dialogs: { chooseProjectRoot: vi.fn(async () => fixture.projectRoot) },
    });
    try {
      const opened = await handlers.openProject({}, { mode: 'write' });
      await expect(handlers.pasteProjectClipboardVideo({}, {
        sessionId: opened!.sessionId,
        target: {
          kind: 'new_video_input',
          operationId: 'clipboard_video_reconcile-only',
          position: { x: 1, y: 2 },
          reconcileOnly: true,
        },
      })).resolves.toBeNull();
      expect(readVideoPath).not.toHaveBeenCalled();
    } finally {
      await handlers.closeAllProjects();
      releaseJournalState(join(fixture.projectRoot, 'journal', 'active.ndjson'), 'video-project');
    }
  });

  it('returns MISSING_ASSET for a replay whose managed MP4 disappeared without rereading clipboard', async () => {
    const fixture = await createEmptyVideoProject(tempRoots, 'project-video-missing-', 7718);
    const sourcePath = join(fixture.tempRoot, 'clipboard.mp4');
    await writeFile(sourcePath, createMinimalMp4());
    const target = { kind: 'new_video_input' as const, operationId: 'clipboard_video_missing', position: { x: 5, y: 7 } };
    const firstHandlers = createDesktopBridgeHandlers({
      clipboardVideo: { readVideoPath: vi.fn(async () => ({ sourcePath })) },
      dialogs: { chooseProjectRoot: vi.fn(async () => fixture.projectRoot) },
      snapshotScheduler: { consider: vi.fn(() => null), flush: vi.fn() },
    });
    const firstOpened = await firstHandlers.openProject({}, { mode: 'write' });
    const firstResult = await firstHandlers.pasteProjectClipboardVideo({}, { sessionId: firstOpened!.sessionId, target });
    await firstHandlers.closeAllProjects();
    releaseJournalState(join(fixture.projectRoot, 'journal', 'active.ndjson'), 'video-project');
    await rm(join(fixture.projectRoot, 'assets', `${firstResult!.asset.assetId}.mp4`));

    const secondRead = vi.fn(async () => ({ sourcePath }));
    const secondHandlers = createDesktopBridgeHandlers({
      clipboardVideo: { readVideoPath: secondRead },
      dialogs: { chooseProjectRoot: vi.fn(async () => fixture.projectRoot) },
      snapshotScheduler: { consider: vi.fn(() => null), flush: vi.fn() },
    });
    try {
      const reopened = await secondHandlers.openProject({}, { mode: 'write' });
      await expect(secondHandlers.pasteProjectClipboardVideo({}, { sessionId: reopened!.sessionId, target }))
        .rejects.toMatchObject({ code: 'MISSING_ASSET' });
      expect(secondRead).not.toHaveBeenCalled();
    } finally {
      await secondHandlers.closeAllProjects();
      releaseJournalState(join(fixture.projectRoot, 'journal', 'active.ndjson'), 'video-project');
    }
  });

  it('rejects a directory clipboard video source', async () => {
    const kind = 'directory';
    const fixture = await createEmptyVideoProject(tempRoots, 'project-video-directory-', 7715);
    const sourcePath = join(fixture.tempRoot, 'unsafe.mp4');
    await mkdir(sourcePath);
    const handlers = createDesktopBridgeHandlers({
      clipboardVideo: { readVideoPath: vi.fn(async () => ({ sourcePath })) },
      dialogs: { chooseProjectRoot: vi.fn(async () => fixture.projectRoot) },
    });
    try {
      const opened = await handlers.openProject({}, { mode: 'write' });
      await expect(handlers.pasteProjectClipboardVideo({}, {
        sessionId: opened!.sessionId,
        target: { kind: 'new_video_input', operationId: `clipboard_video_${kind}`, position: { x: 0, y: 0 } },
      })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    } finally {
      await handlers.closeAllProjects();
      releaseJournalState(join(fixture.projectRoot, 'journal', 'active.ndjson'), 'video-project');
    }
  });

  it('closes the verified video handle and leaves the project unchanged when streaming fails', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'project-video-stream-failure-'));
    tempRoots.push(tempRoot);
    const projectRoot = join(tempRoot, 'Video.novus-project');
    const repository = new ProjectRepository({ createId: sequentialId('repo'), processId: 7719 });
    const created = await repository.create(projectRoot, {
      project: videoProject(),
      projectId: 'video-project',
      projectName: 'Video Project',
    });
    await repository.close(created);
    const close = vi.fn(async () => undefined);
    const stream = Readable.from((async function* failingStream() {
      yield createMinimalMp4().subarray(0, 12);
      throw new Error('source read failed');
    })());
    const handlers = createDesktopBridgeHandlers({
      dialogs: {
        chooseProjectRoot: vi.fn(async () => projectRoot),
        chooseProjectVideo: vi.fn(async () => join(tempRoot, 'selected.mp4')),
      },
      openVideoSource: vi.fn(async () => ({ byteSize: 1024, close, stream })),
      snapshotScheduler: { consider: vi.fn(() => null), flush: vi.fn() },
    });

    try {
      const opened = await handlers.openProject({}, { mode: 'write' });
      await expect(handlers.importProjectVideo({}, {
        sessionId: opened!.sessionId,
        target: { kind: 'module', nodeId: 'video-input' },
      })).rejects.toMatchObject({ code: 'DURABLE_WRITE_FAILED' });
      expect(close).toHaveBeenCalledOnce();
      expect(await readFile(join(projectRoot, 'journal', 'active.ndjson'), 'utf8')).toBe('');
    } finally {
      await handlers.closeAllProjects();
      releaseJournalState(join(projectRoot, 'journal', 'active.ndjson'), 'video-project');
    }
  });

  it('rejects a verified video source that grows while it is being streamed', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'project-video-stream-growth-'));
    tempRoots.push(tempRoot);
    const projectRoot = join(tempRoot, 'Video.novus-project');
    const repository = new ProjectRepository({ createId: sequentialId('repo'), processId: 7723 });
    const created = await repository.create(projectRoot, {
      project: videoProject(),
      projectId: 'video-project',
      projectName: 'Video Project',
    });
    await repository.close(created);
    const original = createMinimalMp4();
    const grown = Buffer.concat([original, box('free', Buffer.from([1, 2, 3, 4]))]);
    const close = vi.fn(async () => undefined);
    const handlers = createDesktopBridgeHandlers({
      dialogs: {
        chooseProjectRoot: vi.fn(async () => projectRoot),
        chooseProjectVideo: vi.fn(async () => join(tempRoot, 'selected.mp4')),
      },
      openVideoSource: vi.fn(async () => ({ byteSize: original.length, close, stream: Readable.from([grown]) })),
      snapshotScheduler: { consider: vi.fn(() => null), flush: vi.fn() },
    });

    try {
      const opened = await handlers.openProject({}, { mode: 'write' });
      await expect(handlers.importProjectVideo({}, {
        sessionId: opened!.sessionId,
        target: { kind: 'module', nodeId: 'video-input' },
      })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
      expect(close).toHaveBeenCalledOnce();
      expect(await readFile(join(projectRoot, 'journal', 'active.ndjson'), 'utf8')).toBe('');
    } finally {
      await handlers.closeAllProjects();
      releaseJournalState(join(projectRoot, 'journal', 'active.ndjson'), 'video-project');
    }
  });
});

function videoProject(): CanvasProject {
  return {
    version: 1,
    graphVersion: 2,
    id: 'video-project',
    name: 'Video Project',
    nodes: [createCanvasModuleNode('video-input', 'video_input', { x: 0, y: 0 })],
    edges: [],
    projectMemory: [],
    skillPromotionCandidates: [],
  };
}

function sequentialId(prefix: string): () => string {
  let value = 0;
  return () => `${prefix}-${++value}`;
}

async function createEmptyVideoProject(
  tempRoots: string[],
  prefix: string,
  processId: number,
): Promise<{ readonly projectRoot: string; readonly tempRoot: string }> {
  const tempRoot = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(tempRoot);
  const projectRoot = join(tempRoot, 'Video.novus-project');
  const repository = new ProjectRepository({ createId: sequentialId('repo'), processId });
  const created = await repository.create(projectRoot, {
    project: { ...videoProject(), nodes: [] },
    projectId: 'video-project',
    projectName: 'Video Project',
  });
  await repository.close(created);
  return { projectRoot, tempRoot };
}

function createMinimalMp4(): Buffer {
  const movieHeader = Buffer.alloc(100);
  movieHeader.writeUInt32BE(1_000, 12);
  return Buffer.concat([
    box('ftyp', Buffer.from('isom\0\0\0\0isomiso2mp41')),
    box('moov', Buffer.concat([
      box('mvhd', movieHeader),
      box('trak', box('tkhd', Buffer.alloc(4))),
    ])),
    box('mdat', Buffer.from([0, 0, 0, 1])),
  ]);
}

function box(type: string, payload: Uint8Array = new Uint8Array()): Buffer {
  const value = Buffer.alloc(8 + payload.length);
  value.writeUInt32BE(value.length, 0);
  value.write(type, 4, 4, 'ascii');
  Buffer.from(payload).copy(value, 8);
  return value;
}
