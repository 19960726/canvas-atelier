import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createCanvasModuleNode,
  parseCanvasProject,
  type CanvasModuleExecutionState,
  type CanvasModuleType,
  type CanvasProject,
} from '@agent-canvas/domain';

import {
  createStarterProject,
  replaceModelJobExecutorForTests,
  replaceProjectPersistenceClientForTests,
  resetAppStoreForTests,
  useAppStore,
} from './app-store';
import type {
  ProjectCommitRequest,
  ProjectCommitResult,
  ProjectPersistenceClient,
} from './desktop-persistence';
import { toFlowNodes } from '../canvas/node-types';

describe('durable canvas semantics', () => {
  beforeEach(() => {
    delete window.novusDesktop;
    replaceProjectPersistenceClientForTests(createPersistenceClient());
    replaceModelJobExecutorForTests({
      submit: vi.fn(async (job) => ({ providerTaskId: `task-${job.id}` })),
      poll: vi.fn(async () => ({ status: 'cancelled' as const })),
    });
    resetAppStoreForTests();
  });

  it.each([
    ['reverse_agent', 'running'],
    ['image_generation', 'failed'],
    ['result_output', 'completed'],
  ] as const)('keeps %s movable while %s and only an explicit lock blocks dragging', (moduleType, state) => {
    const movable = moduleNode(moduleType, state, false);
    const locked = moduleNode(moduleType, state, true);

    expect(toFlowNodes([movable])[0]).toMatchObject({ draggable: true });
    expect(toFlowNodes([locked])[0]).toMatchObject({ draggable: false });
  });

  it('persists lock and unlock as one stable transaction each and blocks only locked position drops', async () => {
    const commit = vi.fn(async ({ nextProject, baseRevision }: ProjectCommitRequest): Promise<ProjectCommitResult> => ({
      ok: true,
      project: nextProject,
      revision: baseRevision + 1,
    }));
    replaceProjectPersistenceClientForTests(createPersistenceClient({ commit }));
    const project = parseCanvasProject({
      ...createStarterProject(),
      graphVersion: 2,
      nodes: [createCanvasModuleNode('reverse', 'reverse_agent', { x: 80, y: 120 })],
      edges: [],
    });
    useAppStore.setState({ project, saveStatus: 'saved' });

    expect(await useAppStore.getState().toggleNodeLock('reverse')).toBe(true);
    expect(await useAppStore.getState().commitNodePosition('reverse', { x: 260, y: 280 })).toBe(false);
    expect(await useAppStore.getState().toggleNodeLock('reverse')).toBe(true);
    expect(await useAppStore.getState().commitNodePosition('reverse', { x: 260, y: 280 })).toBe(true);

    expect(commit).toHaveBeenCalledTimes(3);
    expect(commit.mock.calls.map(([request]) => request.transaction.operations)).toEqual([
      [{ kind: 'canvas', operation: expect.objectContaining({ kind: 'update_node', node: expect.objectContaining({ locked: true }) }) }],
      [{ kind: 'canvas', operation: expect.objectContaining({ kind: 'update_node', node: expect.objectContaining({ locked: false }) }) }],
      [{ kind: 'canvas', operation: expect.objectContaining({ kind: 'update_node', node: expect.objectContaining({ position: { x: 260, y: 280 } }) }) }],
    ]);
  });

  it('freezes reference order at confirmation while live reorder stays editable and the next run snapshots the new order', async () => {
    const profiles = deferred<Array<{
      provider: string;
      modelRoute: string;
      displayName: string;
      modelId: string;
      capabilities: string[];
    }>>();
    window.novusDesktop = {
      provider: {
        ackImageJobTerminal: vi.fn(async () => ({ acknowledged: true as const })),
        cancelImageJob: vi.fn(async () => ({ status: 'cancelled' as const })),
        configure: vi.fn(),
        getStatus: vi.fn(async () => ({ configured: true, locked: false, encryption: 'safeStorage' as const })),
        listProfiles: vi.fn(() => profiles.promise),
        pollImageJob: vi.fn(async () => ({ status: 'cancelled' as const })),
        submitImageJob: vi.fn(async (request) => ({ providerTaskId: `provider-${request.jobId}` })),
        unlock: vi.fn(),
      },
    } as unknown as typeof window.novusDesktop;
    resetAppStoreForTests();
    useAppStore.setState({ project: projectWithOrderedReferences(['product', 'scene']), saveStatus: 'saved' });

    useAppStore.getState().draftAgentPlan('freeze the confirmed input order', { modelRoute: 'image-generation' });
    const firstConfirmation = useAppStore.getState().confirmAgentPlan({ models: true, deleteNodes: false, skillWriteback: false });
    await vi.waitFor(() => expect(window.novusDesktop!.provider!.listProfiles).toHaveBeenCalledTimes(1));

    expect(await useAppStore.getState().commitReferenceOrder(['scene', 'product'])).toBe(true);
    profiles.resolve([imageProfile()]);
    await firstConfirmation;
    await vi.waitFor(() => expect(useAppStore.getState().modelJobs).toHaveLength(1));

    const firstJob = useAppStore.getState().modelJobs[0]!;
    expect(firstJob.referenceAssetIds).toEqual(['product', 'scene']);
    expect(firstJob.referenceSnapshotRevision).toBe(0);
    expect(firstJob.referenceSnapshotFingerprint).toMatch(/^[a-f0-9]{16}$/u);

    useAppStore.getState().draftAgentPlan('same inputs after a live reorder', { modelRoute: 'image-generation' });
    await useAppStore.getState().confirmAgentPlan({ models: true, deleteNodes: false, skillWriteback: false });
    await vi.waitFor(() => expect(useAppStore.getState().modelJobs).toHaveLength(2));

    const secondJob = useAppStore.getState().modelJobs[1]!;
    expect(secondJob.referenceAssetIds).toEqual(['scene', 'product']);
    expect(secondJob.referenceSnapshotRevision).toBeGreaterThan(firstJob.referenceSnapshotRevision!);
    expect(secondJob.referenceSnapshotFingerprint).not.toBe(firstJob.referenceSnapshotFingerprint);
  });
});

function moduleNode(
  moduleType: CanvasModuleType,
  state: CanvasModuleExecutionState,
  locked: boolean,
) {
  return {
    ...createCanvasModuleNode(`module-${moduleType}-${state}`, moduleType, { x: 0, y: 0 }),
    locked,
    data: {
      ...createCanvasModuleNode(`module-${moduleType}-${state}`, moduleType, { x: 0, y: 0 }).data,
      execution: { state },
    },
  };
}

function projectWithOrderedReferences(order: Array<'product' | 'scene'>): CanvasProject {
  const project = createStarterProject();
  const roleByAsset = {
    product: 'product_identity' as const,
    scene: 'scene_composition' as const,
  };
  return parseCanvasProject({
    ...project,
    nodes: project.nodes.map((node) => node.type === 'placement_preview'
      ? {
          ...node,
          data: {
            ...node.data,
            objects: order.map((assetId, index) => ({
              ...node.data.objects[0]!,
              assetId,
              id: assetId,
              name: assetId === 'product' ? '产品主图 / Product hero' : '场景构图 / Scene composition',
              role: roleByAsset[assetId],
              zIndex: index,
            })),
          },
        }
      : node),
  });
}

function imageProfile() {
  return {
    provider: 'comfly',
    modelRoute: 'image-generation',
    displayName: 'GPT Image',
    modelId: 'gpt-image-1',
    capabilities: ['image_generation', 'async_tasks'],
  };
}

function createPersistenceClient(overrides: Partial<ProjectPersistenceClient> = {}): ProjectPersistenceClient {
  let revision = 0;
  return {
    close: overrides.close ?? (async () => {}),
    commit: overrides.commit ?? (async ({ nextProject }: ProjectCommitRequest): Promise<ProjectCommitResult> => ({
      ok: true,
      project: nextProject,
      revision: ++revision,
    })),
    hydrate: overrides.hydrate ?? (async () => ({
      availableSnapshotIds: [],
      lifecycle: 'durable',
      mode: 'browser',
      project: createStarterProject(),
      revision,
      saveStatus: 'saved',
    })),
    importProjectImage: overrides.importProjectImage ?? (async () => null),
    listProjectImages: overrides.listProjectImages ?? (async () => []),
    restore: overrides.restore ?? (async () => ({
      availableSnapshotIds: [],
      lifecycle: 'durable',
      project: createStarterProject(),
      revision,
      saveStatus: 'saved',
    })),
    stablePoint: overrides.stablePoint ?? (async () => ({
      availableSnapshotIds: [],
      project: createStarterProject(),
      revision,
    })),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}
