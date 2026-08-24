import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CanvasProject } from '@agent-canvas/domain';
import { createDesktopBridgeHandlers } from './bridge-handlers.js';
import { releaseJournalState } from './journal-writer.js';
import { ProjectRepository } from './project-repository.js';
import { createSolidPng } from './test/png-fixture.js';

describe('Photoshop desktop bridge', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it('resolves the original managed image before invoking the adapter', async () => {
    const root = await mkdtemp(join(tmpdir(), 'photoshop-bridge-'));
    roots.push(root);
    const projectRoot = join(root, 'Photoshop.novus-project');
    await mkdir(root, { recursive: true });
    const repository = new ProjectRepository({ createId: sequence('repository'), processId: 7821 });
    const created = await repository.create(projectRoot, {
      project: project(),
      projectId: 'photoshop-project',
      projectName: 'Photoshop Project',
    });
    await repository.close(created);
    const place = vi.fn().mockResolvedValue({ ok: true, layerName: 'Generated image' });
    const handlers = createDesktopBridgeHandlers({
      createId: sequence('bridge'),
      dialogs: { chooseProjectRoot: vi.fn(async () => projectRoot) },
      photoshopSmartObjectAdapter: { place },
      snapshotScheduler: { consider: vi.fn(() => null), flush: vi.fn() },
    });

    try {
      const opened = await handlers.openProject({}, { mode: 'write' });
      const asset = await handlers.storeGeneratedImage(opened!.sessionId, createSolidPng(), 'image/png');
      await expect(handlers.importProjectImageToPhotoshop({}, {
        sessionId: opened!.sessionId,
        assetId: asset.assetId,
      })).resolves.toEqual({ ok: true, layerName: 'Generated image' });

      expect(place).toHaveBeenCalledWith({
        absolutePath: expect.stringMatching(new RegExp(`${asset.assetId}\\.png$`, 'u')),
        layerName: asset.label,
      });
    } finally {
      await handlers.closeAllProjects();
      releaseJournalState(join(projectRoot, 'journal', 'active.ndjson'), 'photoshop-project');
    }
  });

  it('rejects extra path and script fields before invoking the adapter', async () => {
    const place = vi.fn();
    const handlers = createDesktopBridgeHandlers({ photoshopSmartObjectAdapter: { place } });
    await expect(handlers.importProjectImageToPhotoshop({}, {
      sessionId: 'session-1',
      assetId: '0123456789abcdef',
      path: 'C:/outside.png',
    })).rejects.toThrow();
    await expect(handlers.importProjectImageToPhotoshop({}, {
      sessionId: 'session-1',
      assetId: '0123456789abcdef',
      script: 'app.activeDocument.save()',
    })).rejects.toThrow();
    expect(place).not.toHaveBeenCalled();
  });
});

function project(): CanvasProject {
  return {
    version: 1,
    graphVersion: 2,
    id: 'photoshop-project',
    name: 'Photoshop Project',
    nodes: [],
    edges: [],
    assets: [],
    projectMemory: [],
    skillPromotionCandidates: [],
  };
}

function sequence(prefix: string): () => string {
  let value = 0;
  return () => `${prefix}-${++value}`;
}
