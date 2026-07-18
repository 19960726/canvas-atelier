import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopBridgeApi, RecoveryPlanBridgeResult, RestoreBridgeResult } from '@agent-canvas/desktop-core';
import { createStarterProject } from './app-store';
import { createDesktopPersistenceClient } from './desktop-persistence';
import { PROJECT_STORAGE_KEY } from './project-persistence';
import {
  selectDurableRecoverySnapshotIds,
  validateRecoveredProject,
} from './recovery';

describe('renderer recovery validation', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('validates recovered projects through parseCanvasProject and keeps the last durable state on invalid input', () => {
    const durable = createStarterProject();
    const recovered = { ...durable, name: 'Recovered valid project' };

    expect(validateRecoveredProject(recovered, durable).name).toBe('Recovered valid project');
    expect(validateRecoveredProject({ ...recovered, nodes: [{ id: 'broken', type: 'reference' }] }, durable)).toBe(durable);
  });

  it('only exposes complete durable recovery candidates to the renderer', () => {
    expect(selectDurableRecoverySnapshotIds({
      action: 'choose_recovery',
      candidates: [
        { candidateId: 'candidate-partial', revision: 5, snapshotId: 'partial-5', tailStatus: 'partial_final_line' },
        { candidateId: 'candidate-complete', revision: 4, snapshotId: 'complete-4', tailStatus: 'complete' },
      ],
      issues: ['partial tail ignored by renderer'],
      projectId: 'local-project',
      recoveredRevision: 4,
      stableSnapshotId: 'stable-4',
      targetRevision: 5,
    })).toEqual(['complete-4']);
  });

  it('keeps the hydrated durable project when a desktop restore returns invalid project state', async () => {
    const durable = createStarterProject();
    const bridge = createBridge({
      getRecoveryPlan: vi.fn(async (): Promise<RecoveryPlanBridgeResult> => ({
        action: 'choose_recovery',
        candidates: [{ candidateId: 'candidate-invalid', revision: 9, snapshotId: 'invalid-after', tailStatus: 'complete' }],
        issues: [],
        projectId: durable.id,
        recoveredRevision: null,
        stableSnapshotId: 'stable-8',
        targetRevision: 9,
      })),
      restore: vi.fn(async () => ({
        currentRevision: 9,
        mode: 'write',
        project: { ...durable, nodes: [{ id: 'broken', type: 'reference' }] },
        projectId: durable.id,
        projectName: durable.name,
        restoredRevision: 9,
        sessionId: 'desktop-session',
        stableSnapshotId: 'invalid-after',
        stableSnapshotRevision: 9,
      }) as unknown as RestoreBridgeResult),
    });
    const client = createDesktopPersistenceClient(bridge);

    await client.openProject?.();
    const restored = await client.restore('invalid-after');

    expect(restored.project).toStrictEqual(durable);
    expect(restored.revision).toBe(8);
  });

  it('does not inspect browser localStorage while hydrating a desktop recovery session', async () => {
    localStorage.setItem(PROJECT_STORAGE_KEY, JSON.stringify({
      current: { ...createStarterProject(), name: 'Browser-only draft' },
      schemaVersion: 2,
      snapshots: [],
    }));
    const getItem = vi.spyOn(Storage.prototype, 'getItem');
    const client = createDesktopPersistenceClient(createBridge());

    await client.openProject?.();

    expect(getItem).not.toHaveBeenCalledWith(PROJECT_STORAGE_KEY);
  });
});

function createBridge(overrides: Partial<DesktopBridgeApi> = {}): DesktopBridgeApi {
  const durable = createStarterProject();
  return {
    closeProject: overrides.closeProject ?? vi.fn(async () => {}),
    commit: overrides.commit ?? vi.fn(async () => ({
      committedAt: '2026-07-16T00:00:00.000Z',
      projectId: durable.id,
      revision: 9,
      sequence: 9,
      transactionId: 'tx-recovery-test',
    })),
    configureKnowledgeBase: overrides.configureKnowledgeBase ?? vi.fn(async () => null),
    createStablePoint: overrides.createStablePoint ?? vi.fn(async () => ({
      path: 'redacted-path',
      reason: 'stable_point',
      revision: 8,
      snapshotId: 'stable-8',
    })),
    exportPack: overrides.exportPack ?? vi.fn(async () => null),
    getKnowledgeState: overrides.getKnowledgeState ?? vi.fn(async () => ({ states: [] })),
    getRecoveryPlan: overrides.getRecoveryPlan ?? vi.fn(async () => ({
      action: 'choose_recovery',
      candidates: [{ candidateId: 'candidate-complete', revision: 8, snapshotId: 'stable-8', tailStatus: 'complete' }],
      issues: [],
      projectId: durable.id,
      recoveredRevision: null,
      stableSnapshotId: 'stable-8',
      targetRevision: 8,
    })),
    importPack: overrides.importPack ?? vi.fn(async () => null),
    openProject: overrides.openProject ?? vi.fn(async () => ({
      currentRevision: 8,
      mode: 'write',
      project: durable,
      projectId: durable.id,
      projectName: durable.name,
      sessionId: 'desktop-session',
      stableSnapshotId: 'stable-8',
      stableSnapshotRevision: 8,
    })),
    provider: overrides.provider ?? {
      ackImageJobTerminal: vi.fn(),
      cancelImageJob: vi.fn(),
      configure: vi.fn(),
      getStatus: vi.fn(),
      listProfiles: vi.fn(),
      pollImageJob: vi.fn(),
      submitImageJob: vi.fn(),
      unlock: vi.fn(),
    },
    restore: overrides.restore ?? vi.fn(async () => ({
      currentRevision: 8,
      mode: 'write',
      project: durable,
      projectId: durable.id,
      projectName: durable.name,
      restoredRevision: 8,
      sessionId: 'desktop-session',
      stableSnapshotId: 'stable-8',
      stableSnapshotRevision: 8,
    })),
    reviewSkillCandidate: overrides.reviewSkillCandidate ?? vi.fn(),
    subscribeKnowledgeState: overrides.subscribeKnowledgeState ?? vi.fn(() => () => {}),
    subscribeKnowledgeSyncStatus: overrides.subscribeKnowledgeSyncStatus ?? vi.fn(() => () => {}),
  } as DesktopBridgeApi;
}
