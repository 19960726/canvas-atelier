import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createCanvasModuleNode, type CanvasProject } from '@agent-canvas/domain';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDesktopBridgeHandlers } from './bridge-handlers';
import { parseGenerationProjectBinding } from './generation-project-binding';
import { createPersistenceError } from './persistence-error';
import { ProjectRepository } from './project-repository';
import { createSolidPng } from './test/png-fixture';

const projectId = 'generation-binding-project';
const image = createSolidPng(2, 2, [50, 120, 180, 255]);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe('generated media project binding', () => {
  it('rejects malformed persisted project bindings', () => {
    expect(parseGenerationProjectBinding({ projectId, rootFingerprint: 'a'.repeat(64) }))
      .toEqual({ projectId, rootFingerprint: 'a'.repeat(64) });
    expect(() => parseGenerationProjectBinding({ projectId, rootFingerprint: 'A'.repeat(64) })).toThrow();
    expect(() => parseGenerationProjectBinding({ projectId, rootFingerprint: 'a'.repeat(64), root: 'unexpected-root' })).toThrow();
    expect(() => parseGenerationProjectBinding({ projectId: ' ', rootFingerprint: 'a'.repeat(64) })).toThrow();
  });
  it('rebinds a paid result to the same project root after the desktop session changes', async () => {
    const root = await makeProjectRoot('same-root');
    const first = makeHandlers(() => root, 'first');
    const opened = await first.openProject({}, { mode: 'write' });
    expect(opened).not.toBeNull();
    const binding = await first.bindGenerationProject(opened!.sessionId, projectId);
    expect(binding).toEqual({ projectId, rootFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u) });
    expect(JSON.stringify(binding)).not.toContain(root);
    await first.closeAllProjects();

    const second = makeHandlers(() => root, 'second');
    try {
      const reopened = await second.openProject({}, { mode: 'write' });
      expect(reopened!.sessionId).not.toBe(opened!.sessionId);
      const stored = await second.storeGeneratedImageForProject(binding, image, 'image/png');
      const assets = await second.listProjectImages({}, { sessionId: reopened!.sessionId });
      expect(assets).toContainEqual(expect.objectContaining({ assetId: stored.assetId }));
      const video = await second.storeGeneratedVideoForProject(binding, createMinimalMp4(), 'video/mp4');
      expect(await second.listProjectVideos({}, { sessionId: reopened!.sessionId }))
        .toContainEqual(expect.objectContaining({ assetId: video.assetId }));
      await expect(second.bindGenerationProject(reopened!.sessionId, 'different-project'))
        .rejects.toMatchObject({ code: 'INVALID_REQUEST', retryable: false });
    } finally {
      await second.closeAllProjects();
    }
  });

  it('never writes a result to a copied project with the same project id', async () => {
    const originalRoot = await makeProjectRoot('original');
    const copiedRoot = await makeProjectRoot('copy');
    const first = makeHandlers(() => originalRoot, 'original');
    const opened = await first.openProject({}, { mode: 'write' });
    const binding = await first.bindGenerationProject(opened!.sessionId, projectId);
    await first.closeAllProjects();

    let currentRoot = copiedRoot;
    const second = makeHandlers(() => currentRoot, 'copy');
    try {
      const copied = await second.openProject({}, { mode: 'write' });
      const copyBinding = await second.bindGenerationProject(copied!.sessionId, projectId);
      expect(copyBinding.rootFingerprint).not.toBe(binding.rootFingerprint);
      await expect(second.storeGeneratedImageForProject(binding, image, 'image/png'))
        .rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
      expect(await second.listProjectImages({}, { sessionId: copied!.sessionId })).toEqual([]);

      currentRoot = originalRoot;
      const restored = await second.openProject({}, { mode: 'write' });
      const stored = await second.storeGeneratedImageForProject(binding, image, 'image/png');
      expect(await second.listProjectImages({}, { sessionId: restored!.sessionId }))
        .toContainEqual(expect.objectContaining({ assetId: stored.assetId }));
      expect(await second.listProjectImages({}, { sessionId: copied!.sessionId })).toEqual([]);
    } finally {
      await second.closeAllProjects();
    }
  });

  it('keeps a result retryable while its project is closed or read-only', async () => {
    const root = await makeProjectRoot('closed');
    const handlers = makeHandlers(() => root, 'closed');
    const opened = await handlers.openProject({}, { mode: 'write' });
    const binding = await handlers.bindGenerationProject(opened!.sessionId, projectId);
    await handlers.closeAllProjects();
    await expect(handlers.storeGeneratedImageForProject(binding, image, 'image/png'))
      .rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });

    const readOnly = await handlers.openProject({}, { mode: 'read_only' });
    try {
      await expect(handlers.bindGenerationProject(readOnly!.sessionId, projectId))
        .rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
      await expect(handlers.storeGeneratedImageForProject(binding, image, 'image/png'))
        .rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
    } finally {
      await handlers.closeAllProjects();
    }
  });

  it('keeps a transient project commit failure retryable while rejecting invalid media', async () => {
    const root = await makeProjectRoot('commit-error');
    const stageAndCommit = vi.fn()
      .mockRejectedValueOnce(createPersistenceError('CONCURRENT_WRITER', true, 'Writer changed during generated media commit'))
      .mockRejectedValueOnce(createPersistenceError('PACKAGE_VALIDATION_FAILED', false, 'Project asset directories are unavailable'))
      .mockRejectedValueOnce(createPersistenceError('PACKAGE_VALIDATION_FAILED', false, 'Asset media type does not match detected content'));
    const handlers = createDesktopBridgeHandlers({
      dialogs: { chooseProjectRoot: vi.fn(async () => root) },
      snapshotScheduler: { consider: vi.fn(() => null), flush: vi.fn() },
      assetStore: {
        list: vi.fn(async () => []),
        resolvePath: vi.fn(async () => null),
        stageAndCommit,
      },
    });
    try {
      const opened = await handlers.openProject({}, { mode: 'write' });
      const binding = await handlers.bindGenerationProject(opened!.sessionId, projectId);
      await expect(handlers.storeGeneratedImageForProject(binding, image, 'image/png'))
        .rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
      await expect(handlers.storeGeneratedImageForProject(binding, image, 'image/png'))
        .rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
      await expect(handlers.storeGeneratedImageForProject(binding, image, 'image/png'))
        .rejects.toMatchObject({ code: 'PROVIDER_INVALID_RESPONSE', retryable: false });
      await expect(handlers.storeGeneratedImageForProject(binding, image, 'text/plain'))
        .rejects.toMatchObject({ code: 'PROVIDER_INVALID_RESPONSE', retryable: false });
      await expect(handlers.storeGeneratedVideoForProject(binding, new Uint8Array(), 'video/mp4'))
        .rejects.toMatchObject({ code: 'PROVIDER_INVALID_RESPONSE', retryable: false });
    } finally {
      await handlers.closeAllProjects();
    }
  });
});

async function makeProjectRoot(name: string): Promise<string> {
  const temp = await mkdtemp(join(tmpdir(), `generation-binding-${name}-`));
  roots.push(temp);
  const root = join(temp, `${name}.novus-project`);
  const repository = new ProjectRepository();
  const created = await repository.create(root, {
    project: project(), projectId, projectName: 'Generation Binding',
  });
  await repository.close(created);
  return root;
}

function makeHandlers(root: () => string, prefix: string) {
  let sequence = 0;
  return createDesktopBridgeHandlers({
    createId: () => `${prefix}-${++sequence}`,
    dialogs: { chooseProjectRoot: vi.fn(async () => root()) },
    snapshotScheduler: { consider: vi.fn(() => null), flush: vi.fn() },
  });
}

function project(): CanvasProject {
  return {
    version: 1, graphVersion: 2, id: projectId, name: 'Generation Binding',
    nodes: [createCanvasModuleNode('image-input', 'image_input', { x: 0, y: 0 })],
    edges: [], projectMemory: [], skillPromotionCandidates: [],
  };
}

function createMinimalMp4(): Buffer {
  const movieHeader = Buffer.alloc(100);
  movieHeader.writeUInt32BE(1_000, 12);
  return Buffer.concat([
    box('ftyp', Buffer.from('isom\0\0\0\0isomiso2mp41')),
    box('moov', Buffer.concat([box('mvhd', movieHeader), box('trak', box('tkhd', Buffer.alloc(4)))])),
    box('mdat', Buffer.from([0, 0, 0, 1])),
  ]);
}

function box(type: string, payload: Uint8Array): Buffer {
  const value = Buffer.alloc(8 + payload.length);
  value.writeUInt32BE(value.length, 0);
  value.write(type, 4, 4, 'ascii');
  Buffer.from(payload).copy(value, 8);
  return value;
}
