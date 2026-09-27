import { describe, expect, it } from 'vitest';
import { createCanvasModuleNode, createConfirmedModelJob, type ModelJob } from '@agent-canvas/domain';
import { createStarterProject } from '../app/app-store';
import { isRejectedLayerResult } from './layer-result-retry';

function fixture() {
  const layer = createCanvasModuleNode('layer-node', 'image_layer', { x: 0, y: 0 });
  layer.data.config = { ...layer.data.config, groupId: 'group-a', layerId: 'subject', sourceAssetId: 'source-a',
    jobId: 'job-a', resultJobId: 'job-a', resultAssetId: 'result-a', qualityStatus: 'failed',
    modelRoute: 'gpt-image', provider: 'comfly', resolution: '4K' };
  const group = createCanvasModuleNode('group-node', 'image_layering', { x: 0, y: 0 });
  group.data.config = { ...group.data.config, groupId: 'group-a', sourceAssetId: 'source-a' };
  const project = { ...createStarterProject(), nodes: [layer, group], edges: [] };
  const job: ModelJob = { ...createConfirmedModelJob({ id: 'job-a', kind: 'image', projectId: project.id,
    confirmedAt: '2026-09-26T00:00:00.000Z', conversationId: 'conversation-a', displayName: 'GPT image',
    modelId: 'gpt-image', modelRoute: 'gpt-image', provider: 'comfly', prompt: 'Extract the subject',
    promptNodeId: layer.id, referenceAssetIds: ['source-a'], resolution: '4K',
    layeringGroupId: 'group-a', layeringLayerId: 'subject' }), status: 'completed', resultAssetId: 'result-a' };
  return { project, job, layer, group };
}

describe('isRejectedLayerResult', () => {
  it('accepts a completed image with a current failed layer result and matching source group', () => {
    const { project, job } = fixture();
    expect(isRejectedLayerResult(project, job, 'result-a')).toBe(true);
  });

  it.each([
    ['passed quality', { qualityStatus: 'passed' }],
    ['pending quality', { qualityStatus: 'pending' }],
    ['missing quality', { qualityStatus: undefined }],
    ['new node job', { jobId: 'replacement-job' }],
    ['stale result job', { resultJobId: 'old-job' }],
    ['missing result job', { resultJobId: undefined }],
    ['stale result asset', { resultAssetId: 'old-result' }],
    ['another group', { groupId: 'other-group' }],
    ['another layer', { layerId: 'other-layer' }],
    ['another source', { sourceAssetId: 'other-source' }],
    ['another route', { modelRoute: 'other-route' }],
    ['another provider', { provider: 'relayme' }],
    ['another resolution', { resolution: '1K' }],
  ])('refuses %s', (_label, changes) => {
    const { project, job, layer } = fixture();
    Object.assign(layer.data.config, changes);
    expect(isRejectedLayerResult(project, job, 'result-a')).toBe(false);
  });

  it.each([
    ['generic completed job', { layeringGroupId: undefined, layeringLayerId: undefined }],
    ['missing group identity', { layeringGroupId: undefined }],
    ['missing layer identity', { layeringLayerId: undefined }],
    ['non-image job', { kind: 'video' }],
    ['failed provider job', { status: 'failed' }],
    ['foreign project', { projectId: 'foreign-project' }],
    ['missing project identity', { projectId: undefined }],
    ['missing source node', { promptNodeId: 'missing-node' }],
    ['missing source asset', { referenceAssetIds: [] }],
    ['another result asset', { resultAssetId: 'other-result' }],
    ['missing route', { modelRoute: undefined }],
    ['missing provider', { provider: undefined }],
    ['missing resolution', { resolution: undefined }],
  ] satisfies [string, Partial<ModelJob>][])('refuses %s', (_label, changes) => {
    const { project, job } = fixture();
    expect(isRejectedLayerResult(project, { ...job, ...changes }, 'result-a')).toBe(false);
  });

  it.each([undefined, '', 'old-result'])('refuses absent or stale explicit result authorization %s', (assetId) => {
    const { project, job } = fixture();
    expect(isRejectedLayerResult(project, job, assetId)).toBe(false);
  });

  it('refuses absent project, missing group, wrong group source and a non-layer source node', () => {
    const { project, job, group } = fixture();
    expect(isRejectedLayerResult(undefined, job, 'result-a')).toBe(false);
    expect(isRejectedLayerResult({ ...project, nodes: project.nodes.filter((node) => node.id !== group.id) }, job, 'result-a')).toBe(false);
    group.data.config.sourceAssetId = 'other-source';
    expect(isRejectedLayerResult(project, job, 'result-a')).toBe(false);
    group.data.config.sourceAssetId = 'source-a';
    project.nodes[0] = createCanvasModuleNode(job.promptNodeId, 'image_layering', { x: 0, y: 0 });
    expect(isRejectedLayerResult(project, job, 'result-a')).toBe(false);
  });
});
