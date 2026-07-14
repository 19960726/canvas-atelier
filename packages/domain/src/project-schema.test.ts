import { describe, expect, it } from 'vitest';
import * as publicApi from './index';
import { parseCanvasProject } from './project-schema';

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
        title: '构图优化',
        changeSummary: '产品上移。',
        rationale: '保留文案安全区。',
        snapshots: { beforeId: 'snapshot-1', afterId: 'snapshot-2' },
        context: { referenceAssetIds: ['asset-1'], resultAssetIds: [] },
        feedback: { keep: [], change: [], never: [] },
        nextStep: '继续检查产品比例。',
      }],
    });

    expect(project.projectMemory[0]?.title).toBe('构图优化');
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
      title: '构图优化',
      changeSummary: '产品上移。',
      rationale: '保留文案安全区。',
      snapshots: { beforeId: 'snapshot-1', afterId: 'snapshot-2' },
      context: { referenceAssetIds: [], resultAssetIds: [] },
      feedback: { keep: [], change: [], never: [] },
      nextStep: '继续检查。',
    };
    const project = { version: 1, id: 'p1', name: 'memory validation', nodes: [], edges: [] };

    expect(() => parseCanvasProject({ ...project, projectMemory: [memory, memory] })).toThrow(/重复/);
    expect(() => parseCanvasProject({ ...project, projectMemory: [{ ...memory, projectId: 'p2' }] })).toThrow(/项目/);
    expect(() => parseCanvasProject({
      ...project,
      projectMemory: [memory, { ...memory, id: 'memory-2', projectRevision: 1 }],
    })).toThrow(/版本/);
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
      title: '构图优化',
      changeSummary: '产品上移。',
      rationale: '保留安全区。',
      snapshots: { beforeId: 'before-1', afterId: 'after-1' },
      context: { referenceAssetIds: [], resultAssetIds: [] },
      feedback: { keep: [], change: [], never: [] },
      nextStep: '继续检查。',
    };
    const candidate = {
      schemaVersion: 1,
      id: 'candidate-1',
      sourceProjectId: 'p1',
      sourceProjectMemoryId: 'memory-1',
      createdAt: '2026-07-14T02:00:00.000Z',
      title: '构图优化',
      rationale: '保留安全区。',
      rule: '继续检查。',
      evidence: { keep: [], change: [], never: [] },
      reviewStatus: 'pending_review',
    };
    const project = { version: 1, id: 'p1', name: 'candidate validation', nodes: [], edges: [], projectMemory: [memory] };

    expect(() => parseCanvasProject({ ...project, skillPromotionCandidates: [candidate, { ...candidate, id: 'candidate-2' }] })).toThrow(/重复提升/);
    expect(() => parseCanvasProject({ ...project, skillPromotionCandidates: [{ ...candidate, sourceProjectId: 'p2' }] })).toThrow(/当前项目/);
    expect(() => parseCanvasProject({ ...project, skillPromotionCandidates: [{ ...candidate, sourceProjectMemoryId: 'missing' }] })).toThrow(/当前项目/);
    const secondMemory = { ...memory, id: 'memory-2', projectRevision: 2 };
    expect(() => parseCanvasProject({
      ...project,
      projectMemory: [memory, secondMemory],
      skillPromotionCandidates: [candidate, { ...candidate, sourceProjectMemoryId: secondMemory.id }],
    })).toThrow(/候选 id/);
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
      title: '构图优化',
      changeSummary: '产品上移。',
      rationale: '保留安全区。',
      snapshots: { beforeId: 'before-1', afterId: 'after-1' },
      context: { referenceAssetIds: [], resultAssetIds: [] },
      feedback: { keep: [], change: [], never: [] },
      nextStep: '继续检查。',
    };
    const decision = {
      ...optimization,
      id: 'memory-2',
      projectRevision: 2,
      kind: 'decision',
      actor: 'user',
      title: '撤销构图优化',
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

    expect(() => parseCanvasProject({ ...project, skillPromotionCandidates: [candidate] })).toThrow(/可提升/);
    expect(() => parseCanvasProject({ ...project, skillPromotionCandidates: [{ ...candidate, sourceProjectMemoryId: optimization.id }] })).toThrow(/有效/);
  });

  it('rejects a reference node without a role', () => {
    expect(() => parseCanvasProject({
      version: 1,
      id: 'p1',
      name: 'test project',
      nodes: [{ id: 'r1', type: 'reference', position: { x: 0, y: 0 }, data: { assetId: 'asset-1' } }],
      edges: []
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
        data: { assetId: 'asset-1', role: 'product_identity', apiKey: 'secret' }
      }],
      edges: []
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
        data: { assetId: 'asset-1', role: 'product_identity', mimeType: 'image/png' }
      }],
      edges: []
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
            safeAreas: []
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
            semanticLayer: 'hero_product'
          }]
        }
      }],
      edges: []
    });

    expect(project.nodes[0]?.type).toBe('placement_preview');
  });
});

describe('public domain API', () => {
  it('exposes only the approved runtime functions', () => {
    expect(Object.keys(publicApi).sort()).toEqual([
      'DEFAULT_REVERSE_PROMPT_PERSONA',
      'MAX_GENERATION_REFERENCES',
      'REVERSE_PROMPT_PERSONAS',
      'appendProjectMemoryEntry',
      'applyTransaction',
      'buildProjectMemoryContext',
      'cancelAgentPlan',
      'confirmAgentPlan',
      'createReversePromptRun',
      'createSkillPromotionCandidate',
      'normalizePlacementObject',
      'parseCanvasProject',
      'parseGenerationRequest',
      'parseProjectMemoryEntry',
      'parseReversePromptResult',
      'placementToPromptConstraints',
      'revertTransaction',
      'selectActiveProjectMemoryEntries',
      'validateAgentPlan',
    ]);
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
  });  it('rejects the 21st combined reference image', () => {
    expect(() => parseCanvasProject(projectWithCount(21))).toThrow(/参考图最多 20 张/);
  });
});