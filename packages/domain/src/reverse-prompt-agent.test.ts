import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import {
  DEFAULT_REVERSE_PROMPT_PERSONA,
  createReversePromptRun,
  parseReversePromptResult,
  reversePromptPersonaSchema,
} from './reverse-prompt-agent';
import {
  UNCONFIGURED_KNOWLEDGE_VERSION_KEY,
  createAgentKnowledgeLease,
} from './knowledge-context';

const snapshot = {
  version: 'approved-2026-07-13-2',
  approvedAt: '2026-07-13T12:00:00.000Z',
  approvedMemoryIds: ['memory-1', 'memory-2'],
};

const references = [
  { assetId: 'asset-product', label: 'Product', role: 'product_identity' as const, position: 0 },
  { assetId: 'asset-scene', label: 'Scene', role: 'scene_composition' as const, position: 1 },
];

function createKnowledgeLease(runId = 'run-1') {
  return createAgentKnowledgeLease({
    runId,
    capability: 'reverse_prompt',
    snapshots: [
      { knowledgeBaseId: 'scene-skill', version: 3, contentHash: 'b'.repeat(64) },
      { knowledgeBaseId: 'ecommerce-detail', version: 2, contentHash: 'a'.repeat(64) },
    ],
    references,
    citations: [{ assetId: 'asset-scene', label: 'Scene' }],
  }, {
    leaseId: `lease-${runId}`,
    createdAt: '2026-07-15T10:00:00.000Z',
  });
}

function deps(ids: string[], nonces: string[]) {
  return {
    createId: () => ids.shift()!,
    createNonce: () => nonces.shift()!,
    now: () => '2026-07-13T12:01:00.000Z',
  };
}

describe('reverse prompt personas', () => {
  it('uses the approved senior commercial visual persona by default', () => {
    expect(DEFAULT_REVERSE_PROMPT_PERSONA.id).toBe('commercial_visual_director');
    expect(reversePromptPersonaSchema.parse(DEFAULT_REVERSE_PROMPT_PERSONA)).toEqual(DEFAULT_REVERSE_PROMPT_PERSONA);
  });

  it.each(['ecommerce_key_visual', 'brand_poster', 'composition_director', 'material_lighting_director'])('supports specialist persona %s', (id) => {
    expect(() => reversePromptPersonaSchema.parse({ id, label: '娑撴挷绗熺憴鎺曞' })).not.toThrow();
  });
});

describe('reverse prompt runs', () => {
  it('captures the newest approved memory snapshot and pinned ordered references', () => {
    const knowledgeLease = createKnowledgeLease('run-1');
    const run = createReversePromptRun({
      projectId: 'project-1',
      skill: { id: 'scene-skill', version: 'v2' },
      knowledgeLease,
      approvedMemorySnapshot: snapshot,
      projectMemoryIds: ['project-memory-1'],
      references,
    }, deps(['session-1'], ['nonce-1']));

    expect(run).toMatchObject({
      sessionId: 'run-1',
      nonce: 'nonce-1',
      persona: DEFAULT_REVERSE_PROMPT_PERSONA,
      knowledgeLease,
      approvedMemorySnapshot: snapshot,
      projectMemoryIds: ['project-memory-1'],
      references,
    });
  });

  it('rejects references that differ from the pinned lease', () => {
    const knowledgeLease = createKnowledgeLease('run-1');
    expect(() => createReversePromptRun({
      projectId: 'project-1',
      skill: { id: 'scene-skill', version: 'v2' },
      knowledgeLease,
      approvedMemorySnapshot: snapshot,
      references: [...references].reverse(),
    })).toThrow(ZodError);
  });

  it('requires an explicit knowledge lease', () => {
    const legacyInput = {
      projectId: 'project-1',
      skill: { id: 'scene-skill', version: 'v2' },
      approvedMemorySnapshot: snapshot,
      references,
    } as unknown as Parameters<typeof createReversePromptRun>[0];

    expect(() => createReversePromptRun(legacyInput)).toThrow(ZodError);
  });

  it('creates a fresh session and nonce every time even when references are unchanged', () => {
    const identity = deps(['session-1', 'session-2'], ['nonce-1', 'nonce-2']);
    const first = createReversePromptRun({
      projectId: 'project-1',
      skill: { id: 'scene-skill', version: 'v2' },
      knowledgeLease: createKnowledgeLease('run-1'),
      approvedMemorySnapshot: snapshot,
      projectMemoryIds: ['project-memory-1'],
      references,
    }, identity);
    const second = createReversePromptRun({
      projectId: 'project-1',
      skill: { id: 'scene-skill', version: 'v2' },
      knowledgeLease: createKnowledgeLease('run-2'),
      approvedMemorySnapshot: { ...snapshot, version: 'approved-2026-07-13-3' },
      projectMemoryIds: ['project-memory-1'],
      references,
    }, identity);
    expect(second.sessionId).not.toBe(first.sessionId);
    expect(second.sessionId).toBe('run-2');
    expect(second.nonce).not.toBe(first.nonce);
    expect(second.approvedMemorySnapshot.version).toBe('approved-2026-07-13-3');
  });

  it('rejects more than 20 references with a stable max-reference issue', () => {
    try {
      createReversePromptRun({
        projectId: 'project-1',
        skill: { id: 'scene-skill', version: 'v2' },
        knowledgeLease: createKnowledgeLease('run-1'),
        approvedMemorySnapshot: snapshot,
        references: Array.from({ length: 21 }, (_, index) => ({
          assetId: `asset-${index}`,
          label: `Asset ${index}`,
          role: index % 2 === 0 ? 'product_identity' as const : 'material_lighting' as const,
          position: index,
        })),
      });
      throw new Error('expected createReversePromptRun to reject more than 20 references');
    } catch (error) {
      expect(error).toBeInstanceOf(ZodError);
      expect((error as ZodError).issues).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: 'too_big',
          maximum: 20,
          path: ['references'],
        }),
        expect.objectContaining({
          code: 'too_big',
          maximum: 20,
          path: ['referenceAssetIds'],
        }),
      ]));
    }
  });

  it('requires structured output to match the current run identity', () => {
    const knowledgeLease = createKnowledgeLease('run-1');
    const run = createReversePromptRun({
      projectId: 'project-1',
      skill: { id: 'scene-skill', version: 'v2' },
      knowledgeLease,
      approvedMemorySnapshot: snapshot,
      projectMemoryIds: ['project-memory-1'],
      references,
    }, deps(['session-1'], ['nonce-1']));
    const result = {
      sessionId: run.sessionId,
      nonce: run.nonce,
      knowledgeSnapshotVersion: knowledgeLease.versionKey,
      analysis: 'Product identity is clear and the composition needs more depth.',
      keywords: ['premium product visual', 'left front key light'],
      positivePrompt: 'Premium product hero shot with centered framing and a left-front key light.',
      negativeConstraints: ['Do not alter the logo', 'Do not deform the product'],
      executionChecklist: ['Verify product identity', 'Verify safe area'],
    };
    expect(parseReversePromptResult(result, run)).toEqual(result);
    expect(() => parseReversePromptResult({ ...result, knowledgeSnapshotVersion: '' }, run)).toThrow(ZodError);
    expect(() => parseReversePromptResult({ ...result, knowledgeSnapshotVersion: 'stale-version' }, run)).toThrowError(Error);
  });

  it('accepts an explicit no-snapshots lease for legacy callers', () => {
    const run = createReversePromptRun({
      projectId: 'project-1',
      skill: { id: 'scene-skill', version: 'v2' },
      knowledgeLease: createAgentKnowledgeLease({
        runId: 'run-legacy',
        capability: 'reverse_prompt',
        snapshots: [],
        references,
        citations: [],
      }, {
        leaseId: 'lease-legacy',
        createdAt: '2026-07-15T10:00:00.000Z',
      }),
      approvedMemorySnapshot: snapshot,
      references,
    }, deps(['session-ignored'], ['nonce-1']));

    expect(run.sessionId).toBe('run-legacy');
    expect(run.knowledgeLease.versionKey).toBe(UNCONFIGURED_KNOWLEDGE_VERSION_KEY);
  });
});
