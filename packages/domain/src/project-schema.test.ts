import { describe, expect, it } from 'vitest';
import * as publicApi from './index';
import { createAgentKnowledgeLease } from './knowledge-context';
import { createSkillPromotionCandidate, createUserFeedbackMemory, reviewSkillPromotionCandidate } from './project-memory';
import { agentPlanSchema, parseCanvasProject } from './project-schema';

describe('parseCanvasProject', () => {
  it('migrates an older project to an empty project-memory timeline', () => {
    const project = parseCanvasProject({
      version: 1,
      id: 'p1',
      name: 'legacy project',
      nodes: [],
      edges: [],
    });

    expect(project.projectMemory).toEqual([]);
    expect(project.skillPromotionCandidates).toEqual([]);
  });

  it('restores project memory stored with the project', () => {
    const project = parseCanvasProject({
      version: 1,
      id: 'p1',
      name: 'remembered project',
      nodes: [],
      edges: [],
      projectMemory: [{
        schemaVersion: 1,
        id: 'memory-1',
        projectId: 'p1',
        projectRevision: 2,
        createdAt: '2026-07-13T13:00:00.000Z',
        kind: 'optimization',
        actor: 'agent',
        title: 'Composition refinement',
        changeSummary: 'Move the product upward.',
        rationale: 'Keep the copy-safe area open.',
        snapshots: { beforeId: 'snapshot-1', afterId: 'snapshot-2' },
        context: { referenceAssetIds: ['asset-1'], resultAssetIds: [] },
        feedback: { keep: [], change: [], never: [] },
        nextStep: 'Review the product scale.',
      }],
    });

    expect(project.projectMemory[0]?.title).toBe('Composition refinement');
  });

  it('rejects duplicate, cross-project, or decreasing project-memory timelines', () => {
    const memory = {
      schemaVersion: 1,
      id: 'memory-1',
      projectId: 'p1',
      projectRevision: 2,
      createdAt: '2026-07-13T13:00:00.000Z',
      kind: 'optimization',
      actor: 'agent',
      title: 'Composition refinement',
      changeSummary: 'Move the product upward.',
      rationale: 'Keep the copy-safe area open.',
      snapshots: { beforeId: 'snapshot-1', afterId: 'snapshot-2' },
      context: { referenceAssetIds: [], resultAssetIds: [] },
      feedback: { keep: [], change: [], never: [] },
      nextStep: 'Keep reviewing.',
    };
    const project = { version: 1, id: 'p1', name: 'memory validation', nodes: [], edges: [] };

    expect(() => parseCanvasProject({ ...project, projectMemory: [memory, memory] })).toThrow();
    expect(() => parseCanvasProject({ ...project, projectMemory: [{ ...memory, projectId: 'p2' }] })).toThrow();
    expect(() => parseCanvasProject({
      ...project,
      projectMemory: [memory, { ...memory, id: 'memory-2', projectRevision: 1 }],
    })).toThrow();
  });

  it('rejects Skill candidates that are duplicated, cross-project, or reference missing memory', () => {
    const memory = {
      schemaVersion: 1,
      id: 'memory-1',
      projectId: 'p1',
      projectRevision: 1,
      createdAt: '2026-07-14T01:00:00.000Z',
      kind: 'optimization',
      actor: 'agent',
      title: 'Composition refinement',
      changeSummary: 'Move the product upward.',
      rationale: 'Keep the copy-safe area open.',
      snapshots: { beforeId: 'before-1', afterId: 'after-1' },
      context: { referenceAssetIds: [], resultAssetIds: [] },
      feedback: { keep: [], change: [], never: [] },
      nextStep: 'Keep reviewing.',
    };
    const candidate = {
      schemaVersion: 1,
      id: 'candidate-1',
      sourceProjectId: 'p1',
      sourceProjectMemoryId: 'memory-1',
      createdAt: '2026-07-14T02:00:00.000Z',
      title: 'Composition refinement',
      rationale: 'Keep the copy-safe area open.',
      rule: 'Keep reviewing.',
      evidence: { keep: [], change: [], never: [] },
      reviewStatus: 'pending_review',
    };
    const project = { version: 1, id: 'p1', name: 'candidate validation', nodes: [], edges: [], projectMemory: [memory] };

    expect(() => parseCanvasProject({ ...project, skillPromotionCandidates: [candidate, { ...candidate, id: 'candidate-2' }] })).toThrow();
    expect(() => parseCanvasProject({ ...project, skillPromotionCandidates: [{ ...candidate, sourceProjectId: 'p2' }] })).toThrow();
    expect(() => parseCanvasProject({ ...project, skillPromotionCandidates: [{ ...candidate, sourceProjectMemoryId: 'missing' }] })).toThrow();
    const secondMemory = { ...memory, id: 'memory-2', projectRevision: 2 };
    expect(() => parseCanvasProject({
      ...project,
      projectMemory: [memory, secondMemory],
      skillPromotionCandidates: [candidate, { ...candidate, sourceProjectMemoryId: secondMemory.id }],
    })).toThrow();
  });

  it('rejects Skill candidates sourced from decisions or superseded memories', () => {
    const optimization = {
      schemaVersion: 1,
      id: 'memory-1',
      projectId: 'p1',
      projectRevision: 1,
      createdAt: '2026-07-14T01:00:00.000Z',
      kind: 'optimization',
      actor: 'agent',
      title: 'Composition refinement',
      changeSummary: 'Move the product upward.',
      rationale: 'Keep the copy-safe area open.',
      snapshots: { beforeId: 'before-1', afterId: 'after-1' },
      context: { referenceAssetIds: [], resultAssetIds: [] },
      feedback: { keep: [], change: [], never: [] },
      nextStep: 'Keep reviewing.',
    };
    const decision = {
      ...optimization,
      id: 'memory-2',
      projectRevision: 2,
      kind: 'decision',
      actor: 'user',
      title: 'Undo composition refinement',
      supersedesMemoryId: optimization.id,
    };
    const candidate = {
      schemaVersion: 1,
      id: 'candidate-1',
      sourceProjectId: 'p1',
      sourceProjectMemoryId: decision.id,
      createdAt: '2026-07-14T02:00:00.000Z',
      title: decision.title,
      rationale: decision.rationale,
      rule: decision.nextStep,
      evidence: decision.feedback,
      reviewStatus: 'pending_review',
    };
    const project = { version: 1, id: 'p1', name: 'candidate source validation', nodes: [], edges: [], projectMemory: [optimization, decision] };

    expect(() => parseCanvasProject({ ...project, skillPromotionCandidates: [candidate] })).toThrow();
    expect(() => parseCanvasProject({ ...project, skillPromotionCandidates: [{ ...candidate, sourceProjectMemoryId: optimization.id }] })).toThrow();
  });

  it('accepts active user-feedback memories as candidate sources with review lifecycle metadata', () => {
    const references = [{
      assetId: 'scene',
      label: 'Scene',
      role: 'scene_composition' as const,
      position: 0,
    }];
    const feedbackMemory = createUserFeedbackMemory({
      projectId: 'p1',
      projectRevision: 3,
      title: 'Refine liquid behavior',
      userRequest: 'Use thicker transparent liquid',
      correction: 'Reduce droplets',
      knowledgeLease: createAgentKnowledgeLease({
        runId: 'run-1',
        capability: 'image_generation',
        snapshots: [{
          knowledgeBaseId: 'kb-style',
          version: 4,
          contentHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        }],
        references,
        citations: [{ assetId: 'scene', label: 'Scene' }],
      }, {
        leaseId: 'lease-1',
        createdAt: '2026-07-15T10:00:00.000Z',
      }),
      references,
      citations: [{ assetId: 'scene', label: 'Scene' }],
      observations: {
        liquid: ['high viscosity'],
      },
      feedback: {
        keep: ['camera'],
        change: ['liquid'],
        never: ['fast splash'],
      },
    }, {
      memoryId: 'feedback-1',
      createdAt: '2026-07-15T10:01:00.000Z',
      snapshots: {
        beforeId: 'snapshot-feedback-before',
        afterId: 'snapshot-feedback-after',
      },
    });

    const approvedCandidate = reviewSkillPromotionCandidate({
      ...createSkillPromotionCandidate(feedbackMemory, {
        candidateId: 'candidate-feedback-1',
        createdAt: '2026-07-15T10:02:00.000Z',
      }),
      targetKnowledgeBaseId: 'kb-style',
      targetKnowledgeSection: 'liquid',
      beforeRule: 'existing-liquid-rule',
      counts: {
        supportingMemoryCount: 1,
        referenceCount: 1,
        citationCount: 1,
        observationCount: 1,
      },
      confidence: 0.82,
      affectedCapabilities: ['image_generation'],
    }, {
      decision: 'approved',
      reviewedAt: '2026-07-15T10:03:00.000Z',
      publishedKnowledgeVersion: 6,
    });

    const project = parseCanvasProject({
      version: 1,
      id: 'p1',
      name: 'feedback candidate validation',
      nodes: [],
      edges: [],
      projectMemory: [feedbackMemory],
      skillPromotionCandidates: [approvedCandidate],
    });

    expect(project.skillPromotionCandidates[0]?.reviewStatus).toBe('approved');
    expect(project.skillPromotionCandidates[0]?.targetKnowledgeSection).toBe('liquid');
  });

  it('rejects a persisted project whose feedback lease version key was tampered', () => {
    const references = [{
      assetId: 'scene',
      label: 'Scene',
      role: 'scene_composition' as const,
      position: 0,
    }];
    const feedbackMemory = createUserFeedbackMemory({
      projectId: 'p1',
      projectRevision: 1,
      title: 'Persisted feedback',
      userRequest: 'Keep the scene',
      correction: 'Use reviewed references',
      knowledgeLease: createAgentKnowledgeLease({
        runId: 'run-tampered-project',
        capability: 'image_generation',
        snapshots: [{ knowledgeBaseId: 'kb-style', version: 4, contentHash: 'a'.repeat(64) }],
        references,
        citations: [{ assetId: 'scene', label: 'Scene' }],
      }, {
        leaseId: 'lease-tampered-project',
        createdAt: '2026-07-15T10:00:00.000Z',
      }),
      references,
      citations: [{ assetId: 'scene', label: 'Scene' }],
      feedback: { keep: ['scene'], change: [], never: [] },
    }, {
      memoryId: 'feedback-tampered-project',
      createdAt: '2026-07-15T10:01:00.000Z',
      snapshots: { beforeId: 'before', afterId: 'after' },
    });
    const persisted = JSON.parse(JSON.stringify(feedbackMemory)) as typeof feedbackMemory;
    persisted.context.knowledgeLease!.versionKey = 'forged-version-key';

    expect(() => parseCanvasProject({
      version: 1,
      id: 'p1',
      name: 'tampered feedback project',
      nodes: [],
      edges: [],
      projectMemory: [persisted],
    })).toThrow(/version/i);
  });
  it('rejects invalid review lifecycle metadata on Skill candidates', () => {
    const memory = {
      schemaVersion: 1,
      id: 'memory-review-1',
      projectId: 'p1',
      projectRevision: 1,
      createdAt: '2026-07-14T01:00:00.000Z',
      kind: 'optimization',
      actor: 'agent',
      title: 'Review lifecycle',
      changeSummary: 'Tighten candidate metadata.',
      rationale: 'Track explicit lifecycle transitions.',
      snapshots: { beforeId: 'before-1', afterId: 'after-1' },
      context: { referenceAssetIds: [], resultAssetIds: [] },
      feedback: { keep: [], change: [], never: [] },
      nextStep: 'Promote after review.',
    } as const;
    const project = {
      version: 1,
      id: 'p1',
      name: 'candidate review validation',
      nodes: [],
      edges: [],
      projectMemory: [memory],
    };

    expect(() => parseCanvasProject({
      ...project,
      skillPromotionCandidates: [{
        schemaVersion: 1,
        id: 'candidate-review-1',
        sourceProjectId: 'p1',
        sourceProjectMemoryId: memory.id,
        createdAt: '2026-07-15T10:02:00.000Z',
        title: memory.title,
        rationale: memory.rationale,
        rule: memory.nextStep,
        evidence: memory.feedback,
        reviewStatus: 'approved',
        reviewedAt: '2026-07-15T10:03:00.000Z',
      }],
    })).toThrow(/published/i);
  });

  it('allows the primary id once in inclusive source lists and rejects true list duplicates', () => {
    const memory = {
      schemaVersion: 1,
      id: 'memory-1',
      projectId: 'p1',
      projectRevision: 1,
      createdAt: '2026-07-14T01:00:00.000Z',
      kind: 'optimization',
      actor: 'agent',
      title: 'Composition refinement',
      changeSummary: 'Move the product upward.',
      rationale: 'Keep the copy-safe area open.',
      snapshots: { beforeId: 'before-1', afterId: 'after-1' },
      context: { referenceAssetIds: [], resultAssetIds: [] },
      feedback: { keep: [], change: [], never: [] },
      nextStep: 'Keep reviewing.',
    };
    const secondMemory = { ...memory, id: 'memory-2', projectRevision: 2, snapshots: { beforeId: 'before-2', afterId: 'after-2' } };
    const thirdMemory = { ...memory, id: 'memory-3', projectRevision: 3, snapshots: { beforeId: 'before-3', afterId: 'after-3' } };
    const project = {
      version: 1,
      id: 'p1',
      name: 'combined source uniqueness',
      nodes: [],
      edges: [],
      projectMemory: [memory, secondMemory, thirdMemory],
    };

    const inclusive = parseCanvasProject({
      ...project,
      skillPromotionCandidates: [{
        schemaVersion: 1,
        id: 'candidate-repeat-primary',
        sourceProjectId: 'p1',
        sourceProjectMemoryId: memory.id,
        sourceProjectMemoryIds: [memory.id, secondMemory.id],
        createdAt: '2026-07-15T10:02:00.000Z',
        title: memory.title,
        rationale: memory.rationale,
        rule: memory.nextStep,
        evidence: memory.feedback,
        reviewStatus: 'pending_review',
      }],
    });
    expect(inclusive.skillPromotionCandidates[0]?.sourceProjectMemoryIds).toEqual([memory.id, secondMemory.id]);

    expect(() => parseCanvasProject({
      ...project,
      skillPromotionCandidates: [{
        schemaVersion: 1,
        id: 'candidate-repeat-supplemental',
        sourceProjectId: 'p1',
        sourceProjectMemoryId: memory.id,
        sourceProjectMemoryIds: [secondMemory.id, secondMemory.id, thirdMemory.id],
        createdAt: '2026-07-15T10:02:00.000Z',
        title: memory.title,
        rationale: memory.rationale,
        rule: memory.nextStep,
        evidence: memory.feedback,
        reviewStatus: 'pending_review',
      }],
    })).toThrow(/unique/i);
  });

  it('rejects a reference node without a role', () => {
    expect(() => parseCanvasProject({
      version: 1,
      id: 'p1',
      name: 'test project',
      nodes: [{ id: 'r1', type: 'reference', position: { x: 0, y: 0 }, data: { assetId: 'asset-1' } }],
      edges: [],
    })).toThrow(/role/);
  });

  it('rejects provider secrets in reference data', () => {
    expect(() => parseCanvasProject({
      version: 1,
      id: 'p1',
      name: 'test project',
      nodes: [{
        id: 'r1',
        type: 'reference',
        position: { x: 0, y: 0 },
        data: { assetId: 'asset-1', role: 'product_identity', apiKey: 'secret' },
      }],
      edges: [],
    })).toThrow(/Unrecognized key/);
  });

  it('rejects extra image metadata in reference data', () => {
    expect(() => parseCanvasProject({
      version: 1,
      id: 'p1',
      name: 'test project',
      nodes: [{
        id: 'r1',
        type: 'reference',
        position: { x: 0, y: 0 },
        data: { assetId: 'asset-1', role: 'product_identity', mimeType: 'image/png' },
      }],
      edges: [],
    })).toThrow(/Unrecognized key/);
  });

  it('accepts placement board metadata and objects as siblings', () => {
    const project = parseCanvasProject({
      version: 1,
      id: 'p1',
      name: 'test project',
      nodes: [{
        id: 'placement-1',
        type: 'placement_preview',
        position: { x: 0, y: 0 },
        data: {
          board: {
            id: 'board-1',
            aspectRatio: '4:5',
            width: 1080,
            height: 1350,
            safeAreas: [],
          },
          objects: [{
            id: 'product-1',
            assetId: 'asset-1',
            role: 'product_identity',
            x: 0.34,
            y: 0.42,
            w: 0.32,
            h: 0.38,
            rotation: 0,
            zIndex: 20,
            locked: false,
            visible: true,
            flipX: false,
            flipY: false,
            semanticLayer: 'hero_product',
          }],
        },
      }],
      edges: [],
    });

    expect(project.nodes[0]?.type).toBe('placement_preview');
  });
});

describe('agentPlanSchema', () => {
  it('accepts transient confirmation states for persisted agent plan nodes', () => {
    const basePlan = {
      id: 'agent-plan-node-1',
      proposedOperationIds: [],
      requiresModelConfirmation: true,
    };

    expect(agentPlanSchema.parse({ ...basePlan, state: 'confirming' }).state).toBe('confirming');
    expect(agentPlanSchema.parse({ ...basePlan, state: 'committing' }).state).toBe('committing');
  });
});

describe('public domain API', () => {
  it('exposes only the approved runtime functions', () => {
    expect(Object.keys(publicApi).sort()).toEqual([
      'DEFAULT_REVERSE_PROMPT_PERSONA',
      'MAX_GENERATION_REFERENCES',
      'REVERSE_PROMPT_PERSONAS',
      'RUNTIME_PROFILES',
      'UNCONFIGURED_KNOWLEDGE_VERSION_KEY',
      'appendProjectMemoryEntry',
      'applyProjectTransaction',
      'applyTransaction',
      'assertPublicModelJobPayload',
      'buildProjectMemoryContext',
      'cancelAgentPlan',
      'canvasOperationSchema',
      'confirmAgentPlan',
      'containsProtectedRendererPayload',
      'createAgentKnowledgeLease',
      'createConfirmedModelJob',
      'createReversePromptRun',
      'createSkillPromotionCandidate',
      'createUserFeedbackMemory',
      'getLegalModelJobTransitions',
      'getRuntimeProfile',
      'modelJobSchema',
      'modelJobStatusSchema',
      'normalizePlacementObject',
      'parseCanvasProject',
      'parseGenerationRequest',
      'parseProjectMemoryEntry',
      'parseReversePromptResult',
      'placementToPromptConstraints',
      'projectOperationSchema',
      'projectTransactionSchema',
      'reorderReferences',
      'revertTransaction',
      'reviewSkillPromotionCandidate',
      'rollbackSkillPromotionCandidate',
      'sanitizeModelJobError',
      'selectActiveProjectMemoryEntries',
      'skillPromotionCandidateSchema',
      'transitionModelJob',
      'validateAgentPlan',
    ].sort());
  });
});

describe('reference image budget', () => {
  const placementObject = (index: number) => ({
    id: `reference-${index}`,
    assetId: `asset-${index}`,
    role: index % 4 === 0 ? 'product_identity' : index % 4 === 1 ? 'scene_composition' : index % 4 === 2 ? 'prop_reference' : 'material_lighting',
    x: 0,
    y: 0,
    w: 0.2,
    h: 0.2,
    rotation: 0,
    zIndex: index,
    locked: false,
    visible: true,
    flipX: false,
    flipY: false,
    semanticLayer: 'midground',
  });

  const projectWithCount = (count: number) => ({
    version: 1,
    id: 'reference-budget',
    name: 'reference budget',
    nodes: [{
      id: 'placement-budget',
      type: 'placement_preview',
      position: { x: 0, y: 0 },
      data: {
        board: { id: 'board-budget', aspectRatio: '4:5', width: 1080, height: 1350, safeAreas: [] },
        objects: Array.from({ length: count }, (_, index) => placementObject(index)),
      },
    }],
    edges: [],
  });

  it('accepts exactly 20 combined reference images', () => {
    expect(parseCanvasProject(projectWithCount(20)).nodes).toHaveLength(1);
  });

  it('does not count a starter placeholder against the 20 user references', () => {
    const project = projectWithCount(20);
    const placement = project.nodes[0]!;
    placement.data.objects.unshift({ ...placementObject(99), id: 'starter-placeholder', assetId: 'starter-product' });
    expect(parseCanvasProject(project).nodes).toHaveLength(1);
  });

  it('rejects the 21st combined reference image', () => {
    expect(() => parseCanvasProject(projectWithCount(21))).toThrow();
  });
});
