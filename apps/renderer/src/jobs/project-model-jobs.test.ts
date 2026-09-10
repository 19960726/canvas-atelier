import { createCanvasModuleNode, type CanvasProject, type ModelJob } from '@agent-canvas/domain';
import { describe, expect, it } from 'vitest';
import { createStarterProject } from '../app/app-store';
import { filterModelJobsForProject, filterModelJobsForTaskStrip, modelJobBelongsToProject } from './project-model-jobs';

function projectWithGenerationNode(): CanvasProject {
  const node = createCanvasModuleNode('shared-generation-node', 'image_generation', { x: 0, y: 0 });
  node.data.config = {
    prompt: 'Original product prompt',
    modelRoute: 'image-route',
    aspectRatio: '1:1',
    resolution: '2K',
    imageQuality: 'medium',
    lastResultJobId: 'legacy-owned-job',
    pendingResultJobIds: ['legacy-owned-sibling'],
    resultAssetIds: ['legacy-owned-asset'],
  };
  return { ...createStarterProject(), id: 'project-current', nodes: [node], edges: [] };
}

function modelJob(overrides: Partial<ModelJob> & { id: string }): ModelJob {
  return {
    kind: 'image',
    modelId: 'image-model',
    modelRoute: 'image-route',
    promptNodeId: 'shared-generation-node',
    prompt: 'Original product prompt',
    aspectRatio: '1:1',
    resolution: '2K',
    imageQuality: 'medium',
    referenceAssetIds: [],
    retryCount: 0,
    status: 'running',
    ...overrides,
  };
}

describe('project model job ownership', () => {
  it('uses stable project ownership across desktop session replacement', () => {
    const project = projectWithGenerationNode();
    const owned = modelJob({
      id: 'owned-after-restart',
      projectId: project.id,
      projectSessionId: 'session-before-restart',
    } as Partial<ModelJob> & { id: string; projectId: string });
    const foreign = modelJob({
      id: 'foreign-same-node-id',
      projectId: 'project-foreign',
      projectSessionId: 'session-current',
    } as Partial<ModelJob> & { id: string; projectId: string });

    expect(modelJobBelongsToProject(owned, project, 'session-current')).toBe(true);
    expect(modelJobBelongsToProject(foreign, project, 'session-current')).toBe(false);
    expect(filterModelJobsForProject([foreign, owned], project, 'session-current')).toEqual([owned]);
  });

  it('accepts legacy jobs only when the current durable node or session proves ownership', () => {
    const project = projectWithGenerationNode();
    const durable = modelJob({ id: 'legacy-owned-job', projectSessionId: 'retired-session' });
    const durableSibling = modelJob({ id: 'legacy-owned-sibling', projectSessionId: 'retired-session' });
    const durableOlderResult = modelJob({
      id: 'legacy-older-result',
      status: 'completed',
      resultAssetId: 'legacy-owned-asset',
      projectSessionId: 'retired-session',
    });
    const currentSession = modelJob({ id: 'legacy-current-session', projectSessionId: 'session-current' });
    const ambiguous = modelJob({ id: 'legacy-ambiguous-sessionless' });

    expect(filterModelJobsForProject(
      [durable, durableSibling, durableOlderResult, currentSession, ambiguous],
      project,
      'session-current',
    )).toEqual([durable, durableSibling, durableOlderResult, currentSession]);
  });

  it('omits terminal task-strip jobs whose source node is missing', () => {
    const project = { ...projectWithGenerationNode(), nodes: [] };
    const failed = modelJob({ id: 'missing-source-failed', projectId: project.id, status: 'failed' });
    const cancelled = modelJob({ id: 'missing-source-cancelled', projectId: project.id, status: 'cancelled' });
    const running = modelJob({ id: 'missing-source-running', projectId: project.id, status: 'running' });

    expect(filterModelJobsForTaskStrip([failed, cancelled, running], project, 'session-current')).toEqual([running]);
  });

  it('omits superseded terminal formal jobs that are no longer anchored by the generation node', () => {
    const project = projectWithGenerationNode();
    const anchored = modelJob({ id: 'legacy-owned-job', projectId: project.id, status: 'failed' });
    const superseded = modelJob({ id: 'superseded-failed-job', projectId: project.id, status: 'failed' });

    expect(filterModelJobsForTaskStrip([superseded, anchored], project, 'session-current')).toEqual([anchored]);
  });

  it.each([
    ['prompt', { prompt: 'Edited product prompt' }],
    ['model route', { modelRoute: 'new-image-route' }],
    ['aspect ratio', { aspectRatio: '16:9' }],
    ['resolution', { resolution: '4K' }],
    ['quality', { imageQuality: 'high' }],
  ] as const)('omits an anchored failed job after the current node changes its %s', (_label, changedConfig) => {
    const project = projectWithGenerationNode();
    const source = project.nodes[0];
    if (source?.type !== 'module') throw new Error('Expected generation module');
    source.data.config = { ...source.data.config, ...changedConfig };
    const anchored = modelJob({ id: 'legacy-owned-job', projectId: project.id, status: 'failed' });

    expect(filterModelJobsForTaskStrip([anchored], project, 'session-current')).toEqual([]);
  });
});
