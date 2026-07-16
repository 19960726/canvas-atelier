import { afterEach, describe, expect, it, vi } from 'vitest';
import { UNCONFIGURED_KNOWLEDGE_VERSION_KEY, type OrderedReference } from '@agent-canvas/domain';
import type {
  KnowledgeStateBridgeResult,
  ReviewSkillCandidateBridgeRequest,
} from '@agent-canvas/desktop-core';
import type { KnowledgeBaseStateSummary } from '@agent-canvas/skill-store';
import { createKnowledgeClient, type SkillCandidateReviewResult } from './knowledge-client';

afterEach(() => {
  delete window.novusDesktop;
});

const references: OrderedReference[] = [{
  assetId: 'asset-1',
  label: 'Hero product',
  role: 'product_identity',
  position: 0,
}];

describe('KnowledgeClient', () => {
  it('keeps an active lease pinned while the next run gets the refreshed version', async () => {
    let listener: ((state: KnowledgeBaseStateSummary) => void) | undefined;
    window.novusDesktop = createBridge({
      getKnowledgeState: async () => ({ states: [knowledgeState({ version: 1, hashPrefix: 'a' })] }),
      subscribeKnowledgeState: vi.fn((next) => {
        listener = next;
        return () => undefined;
      }),
    });
    const client = createKnowledgeClient();

    await client.start(() => undefined);
    const first = client.getLease('run-1', 'reverse_prompt', references, []);
    listener?.(knowledgeState({ version: 2, hashPrefix: 'b' }));
    const second = client.getLease('run-2', 'reverse_prompt', references, []);

    expect(first.runId).toBe('run-1');
    expect(first.versionKey).toBe(`scene-skill@1:${'a'.repeat(12)}`);
    expect(first.snapshots).toEqual([{
      knowledgeBaseId: 'scene-skill',
      version: 1,
      contentHash: 'a'.repeat(64),
    }]);
    expect(second.versionKey).toBe(`scene-skill@2:${'b'.repeat(12)}`);
    expect(first.versionKey).toBe(`scene-skill@1:${'a'.repeat(12)}`);
  });

  it('buffers knowledge-state events during hydration so the next lease pins the newest activation', async () => {
    let stateListener: ((state: KnowledgeBaseStateSummary) => void) | undefined;
    let resolveHydration!: (value: KnowledgeStateBridgeResult) => void;
    const hydration = new Promise<KnowledgeStateBridgeResult>((resolve) => { resolveHydration = resolve; });
    window.novusDesktop = createBridge({
      getKnowledgeState: vi.fn(() => hydration),
      subscribeKnowledgeState: vi.fn((next) => {
        stateListener = next;
        return () => undefined;
      }),
    });
    const client = createKnowledgeClient();

    const start = client.start(() => undefined);
    expect(stateListener).toBeDefined();
    stateListener?.(knowledgeState({ version: 2, hashPrefix: 'b', stateRevision: 2 }));
    resolveHydration({ states: [knowledgeState({ version: 1, hashPrefix: 'a', stateRevision: 1 })] });
    await start;

    expect(client.getLease('run-after-race', 'reverse_prompt', references, []).versionKey)
      .toBe(`scene-skill@2:${'b'.repeat(12)}`);
  });

  it('prefers a newer buffered rollback over an older hydrated active snapshot', async () => {
    let stateListener: ((state: KnowledgeBaseStateSummary) => void) | undefined;
    let resolveHydration!: (value: KnowledgeStateBridgeResult) => void;
    const hydration = new Promise<KnowledgeStateBridgeResult>((resolve) => { resolveHydration = resolve; });
    window.novusDesktop = createBridge({
      getKnowledgeState: vi.fn(() => hydration),
      subscribeKnowledgeState: vi.fn((next) => {
        stateListener = next;
        return () => undefined;
      }),
    });
    const client = createKnowledgeClient();
    const states: KnowledgeBaseStateSummary[][] = [];

    const start = client.start((next) => states.push(next));
    stateListener?.(knowledgeState({ version: 2, hashPrefix: 'b', stateRevision: 8, status: 'rolled_back' }));
    resolveHydration({ states: [knowledgeState({ version: 3, hashPrefix: 'c', stateRevision: 7 })] });
    await start;

    expect(states[states.length - 1]?.[0]).toMatchObject({
      activeVersion: 2,
      stateRevision: 8,
      status: 'rolled_back',
    });
    expect(client.getLease('run-buffered-rollback', 'reverse_prompt', references, []).versionKey)
      .toBe(`scene-skill@2:${'b'.repeat(12)}`);
  });

  it('keeps newer hydrated fallback state over a stale buffered higher version', async () => {
    let stateListener: ((state: KnowledgeBaseStateSummary) => void) | undefined;
    let resolveHydration!: (value: KnowledgeStateBridgeResult) => void;
    const hydration = new Promise<KnowledgeStateBridgeResult>((resolve) => { resolveHydration = resolve; });
    window.novusDesktop = createBridge({
      getKnowledgeState: vi.fn(() => hydration),
      subscribeKnowledgeState: vi.fn((next) => {
        stateListener = next;
        return () => undefined;
      }),
    });
    const client = createKnowledgeClient();
    const states: KnowledgeBaseStateSummary[][] = [];

    const start = client.start((next) => states.push(next));
    stateListener?.(knowledgeState({ version: 4, hashPrefix: 'd', stateRevision: 8 }));
    resolveHydration({ states: [knowledgeState({ version: 3, hashPrefix: 'c', stateRevision: 9, status: 'fallback' })] });
    await start;

    expect(states[states.length - 1]?.[0]).toMatchObject({
      activeVersion: 3,
      stateRevision: 9,
      status: 'fallback',
    });
    expect(client.getLease('run-hydrated-fallback', 'reverse_prompt', references, []).versionKey)
      .toBe(`scene-skill@3:${'c'.repeat(12)}`);
  });

  it('ignores buffered events and hydration from a stopped start after restart', async () => {
    let resolveFirstHydration!: (value: KnowledgeStateBridgeResult) => void;
    const firstHydration = new Promise<KnowledgeStateBridgeResult>((resolve) => { resolveFirstHydration = resolve; });
    const stateListeners: Array<(state: KnowledgeBaseStateSummary) => void> = [];
    const unsubscribes = [vi.fn(), vi.fn()];
    window.novusDesktop = createBridge({
      getKnowledgeState: vi.fn()
        .mockReturnValueOnce(firstHydration)
        .mockResolvedValueOnce({ states: [knowledgeState({ version: 3, hashPrefix: 'c' })] }),
      subscribeKnowledgeState: vi.fn((next) => {
        stateListeners.push(next);
        return unsubscribes[stateListeners.length - 1]!;
      }),
    });
    const client = createKnowledgeClient();

    const firstStart = client.start(() => undefined);
    stateListeners[0]?.(knowledgeState({ version: 2, hashPrefix: 'b' }));
    const secondStart = client.start(() => undefined);
    await secondStart;
    resolveFirstHydration({ states: [knowledgeState({ version: 1, hashPrefix: 'a' })] });
    await firstStart;

    expect(unsubscribes[0]).toHaveBeenCalledOnce();
    expect(client.getLease('run-after-restart', 'reverse_prompt', references, []).versionKey)
      .toBe(`scene-skill@3:${'c'.repeat(12)}`);
  });

  it('keeps live knowledge state after hydration failure and reports a sanitized offline sync state', async () => {
    let stateListener: ((state: KnowledgeBaseStateSummary) => void) | undefined;
    let rejectHydration!: (reason?: unknown) => void;
    const hydration = new Promise<KnowledgeStateBridgeResult>((_resolve, reject) => { rejectHydration = reject; });
    const unsubscribeState = vi.fn();
    const unsubscribeSync = vi.fn();
    window.novusDesktop = createBridge({
      getKnowledgeState: vi.fn(() => hydration),
      subscribeKnowledgeState: vi.fn((next) => {
        stateListener = next;
        return unsubscribeState;
      }),
      subscribeKnowledgeSyncStatus: vi.fn(() => unsubscribeSync),
    });
    const client = createKnowledgeClient();
    const states: KnowledgeBaseStateSummary[][] = [];
    const syncStatuses: Array<{ status: string; reason: string | null }> = [];

    const start = client.start(
      (next) => states.push(next),
      (status) => syncStatuses.push({
        status: status.status,
        reason: status.lastFailure?.reason ?? null,
      }),
    );
    stateListener?.(knowledgeState({ version: 2, hashPrefix: 'b', stateRevision: 2 }));
    rejectHydration(new Error(String.raw`Authorization: Bearer secret at C:\Users\Private\sync.json`));
    await start;

    expect(unsubscribeState).not.toHaveBeenCalled();
    expect(unsubscribeSync).not.toHaveBeenCalled();
    expect(states[states.length - 1]?.[0]).toMatchObject({
      activeVersion: 2,
      stateRevision: 2,
    });
    expect(syncStatuses[syncStatuses.length - 1]).toEqual({
      status: 'offline',
      reason: 'Desktop knowledge bridge unavailable',
    });

    stateListener?.(knowledgeState({ version: 3, hashPrefix: 'c', stateRevision: 3 }));
    expect(client.getLease('run-after-hydration-failure', 'reverse_prompt', references, []).versionKey)
      .toBe(`scene-skill@3:${'c'.repeat(12)}`);
  });
  it('hydrates initial state, applies subscription events, and unsubscribes on stop', async () => {
    let listener: ((state: KnowledgeBaseStateSummary) => void) | undefined;
    const unsubscribe = vi.fn();
    window.novusDesktop = createBridge({
      getKnowledgeState: vi.fn(async () => ({ states: [knowledgeState({ version: 1, hashPrefix: 'a' })] })),
      subscribeKnowledgeState: vi.fn((next) => {
        listener = next;
        return unsubscribe;
      }),
    });
    const client = createKnowledgeClient();
    const states: KnowledgeBaseStateSummary[][] = [];

    await client.start((next) => states.push(next));
    listener?.(knowledgeState({ knowledgeBaseId: 'brand-rules', version: 3, hashPrefix: 'c' }));
    client.stop();
    listener?.(knowledgeState({ knowledgeBaseId: 'scene-skill', version: 4, hashPrefix: 'd' }));

    expect(states.map((entry) => entry.map((state) => `${state.knowledgeBaseId}:${state.activeVersion}`))).toEqual([
      ['scene-skill:1'],
      ['brand-rules:3', 'scene-skill:1'],
    ]);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('accepts a newer live summary revision over an older hydrated state', async () => {
    let listener: ((state: KnowledgeBaseStateSummary) => void) | undefined;
    window.novusDesktop = createBridge({
      getKnowledgeState: vi.fn(async () => ({ states: [knowledgeState({ version: 1, hashPrefix: 'a', stateRevision: 4 })] })),
      subscribeKnowledgeState: vi.fn((next) => {
        listener = next;
        return () => undefined;
      }),
    });
    const client = createKnowledgeClient();

    await client.start(() => undefined);
    listener?.(knowledgeState({ version: 2, hashPrefix: 'b', stateRevision: 5 }));

    expect(client.getLease('run-live-revision', 'reverse_prompt', references, []).versionKey)
      .toBe(`scene-skill@2:${'b'.repeat(12)}`);
  });

  it('falls back safely in the browser with separate offline sync state and an unconfigured lease', async () => {
    const client = createKnowledgeClient();
    const states: KnowledgeBaseStateSummary[][] = [];
    const syncStatuses: unknown[] = [];

    await client.start((next) => states.push(next), (next) => syncStatuses.push(next));
    const lease = client.getLease('run-browser', 'reverse_prompt', references, []);

    expect(states).toEqual([[]]);
    expect(syncStatuses).toEqual([expect.objectContaining({ status: 'offline' })]);
    expect(lease.versionKey).toBe(UNCONFIGURED_KNOWLEDGE_VERSION_KEY);
    expect(lease.snapshots).toEqual([]);
  });

  it('delivers sync lifecycle independently while preserving active knowledge state', async () => {
    let syncListener: ((status: {
      schemaVersion: 1;
      knowledgeBaseId: string;
      status: 'syncing' | 'updated' | 'offline' | 'conflict';
      changedAt: string;
      lastFailure: { reason: string; failedAt: string } | null;
    }) => void) | undefined;
    window.novusDesktop = createBridge({
      getKnowledgeState: async () => ({ states: [knowledgeState({ version: 2, hashPrefix: 'a' })] }),
      subscribeKnowledgeSyncStatus: vi.fn((next) => {
        syncListener = next;
        return () => undefined;
      }),
    });
    const client = createKnowledgeClient();
    const states: KnowledgeBaseStateSummary[][] = [];
    const statuses: unknown[] = [];

    await client.start((next) => states.push(next), (next) => statuses.push(next));
    syncListener?.({
      schemaVersion: 1,
      knowledgeBaseId: 'scene-skill',
      status: 'conflict',
      changedAt: '2026-07-16T04:00:00.000Z',
      lastFailure: { reason: 'Version conflict', failedAt: '2026-07-16T04:00:00.000Z' },
    });
    syncListener?.({
      schemaVersion: 1,
      knowledgeBaseId: 'scene-skill',
      status: 'updated',
      changedAt: '2026-07-16T04:01:00.000Z',
      lastFailure: null,
    });

    expect(states).toHaveLength(1);
    expect(states[0]?.[0]).toMatchObject({ activeVersion: 2, status: 'active' });
    expect(statuses).toEqual([
      expect.objectContaining({ status: 'conflict' }),
      expect.objectContaining({ status: 'updated' }),
    ]);
  });
  it('subscribes before hydration and keeps a newer retained sync event over an older snapshot', async () => {
    let syncListener: ((status: {
      schemaVersion: 1;
      knowledgeBaseId: string;
      status: 'syncing' | 'updated' | 'offline' | 'conflict';
      changedAt: string;
      lastFailure: { reason: string; failedAt: string } | null;
    }) => void) | undefined;
    let resolveHydration!: (value: KnowledgeStateBridgeResult) => void;
    const hydration = new Promise<KnowledgeStateBridgeResult>((resolve) => { resolveHydration = resolve; });
    window.novusDesktop = createBridge({
      getKnowledgeState: vi.fn(() => hydration),
      subscribeKnowledgeSyncStatus: vi.fn((next) => {
        syncListener = next;
        return () => undefined;
      }),
    });
    const client = createKnowledgeClient();
    const statuses: Array<{ status: string; changedAt: string }> = [];

    const start = client.start(() => undefined, (status) => statuses.push(status));
    expect(syncListener).toBeDefined();
    syncListener?.({
      schemaVersion: 1,
      knowledgeBaseId: 'scene-skill',
      status: 'updated',
      changedAt: '2026-07-16T04:01:00.000Z',
      lastFailure: null,
    });
    resolveHydration({
      states: [],
      syncStatuses: [{
        schemaVersion: 1,
        knowledgeBaseId: 'scene-skill',
        status: 'offline',
        changedAt: '2026-07-16T04:00:00.000Z',
        lastFailure: { reason: 'Earlier offline state', failedAt: '2026-07-16T04:00:00.000Z' },
      }],
    });
    await start;

    expect(statuses[statuses.length - 1]).toMatchObject({
      status: 'updated',
      changedAt: '2026-07-16T04:01:00.000Z',
    });
  });
  it('configures and reviews only through the narrow bridge payloads', async () => {
    const configured = knowledgeState({ version: 1, hashPrefix: 'a' });
    const reviewed = knowledgeState({ version: 2, hashPrefix: 'b' });
    const reviewedCandidate = {
      schemaVersion: 1 as const,
      id: 'candidate-1',
      sourceProjectId: 'project-1',
      sourceProjectMemoryId: 'memory-1',
      createdAt: '2026-07-15T08:00:00.000Z',
      title: 'Approved rule',
      rationale: 'Good evidence',
      rule: 'Keep product identity locked',
      evidence: { keep: [], change: [], never: [] },
      reviewStatus: 'approved' as const,
    };
    const reviewResult: SkillCandidateReviewResult = {
      projectId: 'project-1',
      currentRevision: 7,
      candidate: reviewedCandidate,
      candidates: [reviewedCandidate],
      knowledgeState: reviewed,
    };
    const configureKnowledgeBase = vi.fn(async () => configured);
    const reviewSkillCandidate = vi.fn(async () => reviewResult);
    window.novusDesktop = createBridge({
      configureKnowledgeBase,
      getKnowledgeState: async () => ({ states: [] }),
      reviewSkillCandidate,
    });
    const client = createKnowledgeClient();
    const states: KnowledgeBaseStateSummary[][] = [];

    await client.start((next) => states.push(next));
    await client.configure('scene-skill', 'Scene Skill');
    const request: ReviewSkillCandidateBridgeRequest = {
      projectId: 'project-1',
      candidateId: 'candidate-1',
      decision: 'approved',
    };
    const result = await client.review(request);

    expect(configureKnowledgeBase).toHaveBeenCalledWith({
      knowledgeBaseId: 'scene-skill',
      displayName: 'Scene Skill',
    });
    expect(JSON.stringify(configureKnowledgeBase.mock.calls)).not.toContain('root');
    expect(reviewSkillCandidate).toHaveBeenCalledWith(request);
    expect(result).toBe(reviewResult);
    expect(states[states.length - 1]?.map((state) => `${state.knowledgeBaseId}:${state.activeVersion}`)).toEqual(['scene-skill:2']);
  });

  it('prepares a Skill candidate for preview through the desktop bridge before approval', async () => {
    const reviewableCandidate = {
      schemaVersion: 1 as const,
      id: 'candidate-preview',
      sourceProjectId: 'project-1',
      sourceProjectMemoryId: 'memory-1',
      sourceProjectMemoryIds: ['memory-1'],
      createdAt: '2026-07-16T00:00:00.000Z',
      title: 'Prepared rule',
      rationale: 'Prepared from source memory',
      rule: 'Proposed rule body',
      sourceRule: 'Source memory body',
      managedRule: 'Managed active body',
      diffHunks: ['- Managed active body', '+ Proposed rule body'],
      targetKnowledgeBaseId: 'scene-skill',
      targetKnowledgeSection: 'scene',
      evidence: { keep: [], change: ['Proposed rule body'], never: [] },
      reviewStatus: 'pending_review' as const,
    };
    const prepareSkillCandidateReview = vi.fn(async () => ({
      projectId: 'project-1',
      currentRevision: 4,
      candidate: reviewableCandidate,
      candidates: [reviewableCandidate],
      knowledgeState: null,
    }));
    window.novusDesktop = createBridge({
      getKnowledgeState: async () => ({ states: [] }),
      prepareSkillCandidateReview,
    } as Partial<typeof window.novusDesktop>);
    const client = createKnowledgeClient();

    await client.start(() => undefined);
    const result = await client.prepareSkillCandidateReview({
      baseRevision: 3,
      projectId: 'project-1',
      candidateId: 'candidate-preview',
      candidateFingerprint: 'candidate-fingerprint-preview',
    });

    expect(prepareSkillCandidateReview).toHaveBeenCalledWith({
      baseRevision: 3,
      projectId: 'project-1',
      candidateId: 'candidate-preview',
      candidateFingerprint: 'candidate-fingerprint-preview',
    });
    expect(result.candidate.sourceRule).toContain('Source memory body');
    expect(result.candidate.managedRule).toContain('Managed active body');
    expect(result.candidate.diffHunks).toEqual(['- Managed active body', '+ Proposed rule body']);
  });
});

function createBridge(overrides: Partial<typeof window.novusDesktop>): typeof window.novusDesktop {
  return {
    closeProject: vi.fn(),
    commit: vi.fn(),
    configureKnowledgeBase: vi.fn(async () => null),
    createStablePoint: vi.fn(),
    exportPack: vi.fn(),
    getKnowledgeState: vi.fn(async (): Promise<KnowledgeStateBridgeResult> => ({ states: [] })),
    getRecoveryPlan: vi.fn(),
    importPack: vi.fn(),
    openProject: vi.fn(),
    restore: vi.fn(),
    reviewSkillCandidate: vi.fn(),
    subscribeKnowledgeState: vi.fn(() => () => undefined),
    subscribeKnowledgeSyncStatus: vi.fn(() => () => undefined),
    ...overrides,
  } as typeof window.novusDesktop;
}

function knowledgeState(options: {
  hashPrefix: string;
  knowledgeBaseId?: string;
  stateRevision?: number;
  status?: KnowledgeBaseStateSummary['status'];
  version: number;
}): KnowledgeBaseStateSummary {
  const knowledgeBaseId = options.knowledgeBaseId ?? 'scene-skill';
  return {
    schemaVersion: 1,
    knowledgeBaseId,
    displayName: `${knowledgeBaseId} display`,
    status: options.status ?? 'active',
    activeVersion: options.version,
    activeContentHash: options.hashPrefix.repeat(64),
    stateRevision: options.stateRevision ?? options.version,
    versionCount: options.version,
    versions: [{
      version: options.version,
      contentHash: options.hashPrefix.repeat(64),
      publishedAt: '2026-07-15T08:00:00.000Z',
      sourceDeviceId: 'device-1',
      displayName: `${knowledgeBaseId} display`,
    }],
    lastFailure: options.status === 'fallback'
      ? { reason: 'refresh failed', failedAt: '2026-07-16T04:00:00.000Z' }
      : null,
    lastRollbackAt: options.status === 'rolled_back'
      ? '2026-07-16T04:00:00.000Z'
      : null,
  };
}
