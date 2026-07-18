import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createCanvasModuleNode, type CanvasProject, type ProjectImageAsset } from '@agent-canvas/domain';
import type { ProjectImageAssetSummary } from '@agent-canvas/desktop-core';

import {
  replaceProjectPersistenceClientForTests,
  resetAppStoreForTests,
  useAppStore,
} from './app-store';
import type {
  ProjectCommitRequest,
  ProjectCommitResult,
  ProjectHydrationResult,
  ProjectPersistenceClient,
  ProjectImageImportResult,
} from './desktop-persistence';

describe('project image store actions', () => {
  beforeEach(() => {
    resetAppStoreForTests();
  });

  it('shows saving during confined import and applies saved state only after the durable image ACK', async () => {
    const project = imageProject([createCanvasModuleNode('image-input', 'image_input', { x: 0, y: 0 })]);
    const importedProject = {
      ...project,
      assets: [assetRecord],
      nodes: project.nodes.map((node) => node.id === 'image-input' && node.type === 'module'
        ? { ...node, data: { ...node.data, config: { assetId: assetRecord.assetId } } }
        : node),
    };
    const deferred = createDeferred<ProjectImageImportResult | null>();
    const client = persistenceClient({
      importProjectImage: vi.fn(() => deferred.promise),
      listProjectImages: vi.fn(async () => [assetSummary]),
    });
    replaceProjectPersistenceClientForTests(client);
    useAppStore.setState({ project, desktopRevision: 4, persistenceMode: 'desktop', saveStatus: 'saved' });

    const pending = useAppStore.getState().importImageForModule('image-input');
    expect(useAppStore.getState().saveStatus).toBe('saving');
    expect(useAppStore.getState().project).toBe(project);

    deferred.resolve({ asset: assetSummary, project: importedProject, revision: 5 });
    await expect(pending).resolves.toBe(true);
    expect(client.importProjectImage).toHaveBeenCalledWith({ kind: 'module', nodeId: 'image-input' });
    expect(useAppStore.getState()).toMatchObject({
      desktopRevision: 5,
      project: importedProject,
      projectImages: [assetSummary],
      saveStatus: 'saved',
    });
  });

  it('persists canvas-library selection order as one stable project transaction', async () => {
    const library = createCanvasModuleNode('library', 'canvas_library', { x: 0, y: 0 });
    const project = imageProject([library], [assetRecord, assetRecordB]);
    const commit = vi.fn(async (request) => ({ ok: true as const, project: request.nextProject, revision: 3 }));
    replaceProjectPersistenceClientForTests(persistenceClient({ commit }));
    useAppStore.setState({
      project,
      projectImages: [assetSummary, assetSummaryB],
      desktopRevision: 2,
      persistenceMode: 'desktop',
      saveStatus: 'saved',
    });

    await expect(useAppStore.getState().setCanvasLibrarySelection('library', [assetRecordB.assetId, assetRecord.assetId]))
      .resolves.toBe(true);

    expect(commit).toHaveBeenCalledOnce();
    expect(commit.mock.calls[0]![0].transaction).toMatchObject({
      label: 'Update canvas image library',
      operations: [{
        kind: 'canvas',
        operation: {
          kind: 'update_node',
          node: { id: 'library', data: { config: { assetIds: [assetRecordB.assetId, assetRecord.assetId] } } },
        },
      }],
    });
    const saved = useAppStore.getState().project.nodes.find((node) => node.id === 'library');
    expect(saved).toMatchObject({ data: { config: { assetIds: [assetRecordB.assetId, assetRecord.assetId] } } });
  });

  it('refreshes transient image summaries after a desktop snapshot restore', async () => {
    const project = imageProject([], [assetRecord]);
    const restoredProject = imageProject([], [assetRecordB]);
    const restore = vi.fn(async () => ({
      availableSnapshotIds: ['snapshot-restored'],
      lifecycle: 'durable' as const,
      project: restoredProject,
      revision: 9,
      saveStatus: 'saved' as const,
    }));
    const listProjectImages = vi.fn(async () => [assetSummaryB]);
    replaceProjectPersistenceClientForTests(persistenceClient({ restore, listProjectImages }));
    useAppStore.setState({
      project,
      projectImages: [assetSummary],
      desktopRevision: 8,
      persistenceMode: 'desktop',
      saveStatus: 'saved',
    });

    await useAppStore.getState().restoreProjectSnapshot('snapshot-restored');

    expect(restore).toHaveBeenCalledWith('snapshot-restored');
    expect(listProjectImages).toHaveBeenCalledOnce();
    expect(useAppStore.getState()).toMatchObject({
      availableSnapshotIds: ['snapshot-restored'],
      desktopRevision: 9,
      project: restoredProject,
      projectImages: [assetSummaryB],
      projectImageError: null,
      saveStatus: 'saved',
    });
  });
});

const assetRecord: ProjectImageAsset = {
  assetId: '0123456789abcdef',
  byteSize: 42,
  extension: 'png',
  height: 3,
  label: 'Product',
  mediaType: 'image/png',
  origin: 'imported',
  sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  width: 2,
};

const assetRecordB: ProjectImageAsset = {
  ...assetRecord,
  assetId: 'fedcba9876543210',
  label: 'Scene',
  sha256: 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
};

const assetSummary: ProjectImageAssetSummary = {
  ...assetRecord,
  displayUrl: 'novus-asset://project/session/0123456789abcdef',
  usageCount: 1,
};

const assetSummaryB: ProjectImageAssetSummary = {
  ...assetRecordB,
  displayUrl: 'novus-asset://project/session/fedcba9876543210',
  usageCount: 0,
};

function imageProject(
  nodes: CanvasProject['nodes'],
  assets: ProjectImageAsset[] = [],
): CanvasProject {
  return {
    version: 1,
    graphVersion: 2,
    id: 'image-project',
    name: 'Image Project',
    nodes,
    edges: [],
    ...(assets.length === 0 ? {} : { assets }),
    projectMemory: [],
    skillPromotionCandidates: [],
  };
}

function persistenceClient(overrides: Partial<ProjectPersistenceClient> = {}): ProjectPersistenceClient {
  return {
    close: vi.fn(async () => undefined),
    commit: vi.fn(async (request: ProjectCommitRequest): Promise<ProjectCommitResult> => ({
      ok: true,
      project: request.nextProject,
      revision: 1,
    })),
    hydrate: vi.fn(async (): Promise<ProjectHydrationResult> => ({
      availableSnapshotIds: [],
      lifecycle: 'durable',
      mode: 'desktop',
      project: imageProject([]),
      revision: 0,
      saveStatus: 'saved',
    })),
    importProjectImage: vi.fn(async () => null),
    listProjectImages: vi.fn(async () => []),
    restore: vi.fn(),
    stablePoint: vi.fn(),
    ...overrides,
  };
}

function createDeferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}
