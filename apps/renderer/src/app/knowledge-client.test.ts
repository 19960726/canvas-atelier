import { afterEach, describe, expect, it, vi } from 'vitest';
import { UNCONFIGURED_KNOWLEDGE_VERSION_KEY, type OrderedReference } from '@agent-canvas/domain';
import type {
  KnowledgeStateBridgeResult,
  ReviewSkillCandidateBridgeRequest,
  ReviewSkillCandidateBridgeResult,
} from '@agent-canvas/desktop-core';
import type { KnowledgeBaseStateSummary } from '@agent-canvas/skill-store';
import { createKnowledgeClient } from './knowledge-client';

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

  it('falls back safely in the browser with offline state and an unconfigured lease', async () => {
    const client = createKnowledgeClient();
    const states: KnowledgeBaseStateSummary[][] = [];

    await client.start((next) => states.push(next));
    const lease = client.getLease('run-browser', 'reverse_prompt', references, []);

    expect(states[0]?.[0]).toMatchObject({
      knowledgeBaseId: 'browser-offline',
      status: 'offline',
      activeVersion: null,
      activeContentHash: null,
    });
    expect(lease.versionKey).toBe(UNCONFIGURED_KNOWLEDGE_VERSION_KEY);
    expect(lease.snapshots).toEqual([]);
  });

  it('configures and reviews only through the narrow bridge payloads', async () => {
    const configured = knowledgeState({ version: 1, hashPrefix: 'a' });
    const reviewed = knowledgeState({ version: 2, hashPrefix: 'b' });
    const reviewResult: ReviewSkillCandidateBridgeResult = {
      projectId: 'project-1',
      currentRevision: 7,
      candidate: {
        schemaVersion: 1,
        id: 'candidate-1',
        sourceProjectId: 'project-1',
        sourceProjectMemoryId: 'memory-1',
        createdAt: '2026-07-15T08:00:00.000Z',
        title: 'Approved rule',
        rationale: 'Good evidence',
        rule: 'Keep product identity locked',
        evidence: { keep: [], change: [], never: [] },
        reviewStatus: 'approved',
      },
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
    ...overrides,
  } as typeof window.novusDesktop;
}

function knowledgeState(options: {
  hashPrefix: string;
  knowledgeBaseId?: string;
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
    versionCount: options.version,
    versions: [{
      version: options.version,
      contentHash: options.hashPrefix.repeat(64),
      publishedAt: '2026-07-15T08:00:00.000Z',
      sourceDeviceId: 'device-1',
      displayName: `${knowledgeBaseId} display`,
    }],
    lastFailure: null,
    lastRollbackAt: null,
  };
}
