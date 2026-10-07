import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReactFlowProvider } from '@xyflow/react';
import { createCanvasModuleNode, createConfirmedModelJob, transitionModelJob, type ModelJob } from '@agent-canvas/domain';
import { resetAppStoreForTests, useAppStore, replaceProjectPersistenceClientForTests } from '../app/app-store';
import { createBrowserPersistenceClient } from '../app/desktop-persistence';
import { ModuleNodeCard } from './ModuleNodeCard';

const activeStatuses = ['queued', 'submitting', 'running'] as const;
type ActiveStatus = typeof activeStatuses[number];
const reviewButton = '\u68c0\u67e5\u5e76\u786e\u8ba4\u56fe\u5c42';
const replaceButton = '\u66ff\u6362\u56fe\u5c42\u7d20\u6750';

beforeEach(() => {
  delete window.novusDesktop; localStorage.clear();
  replaceProjectPersistenceClientForTests(createBrowserPersistenceClient());
  resetAppStoreForTests({ project: 'empty' });
});
afterEach(() => {
  cleanup(); resetAppStoreForTests({ project: 'empty' }); vi.restoreAllMocks();
  delete window.novusDesktop;
});

function fixture() {
  const sourceId = 'a'.repeat(16), groupId = 'shared-layer-group';
  const group = createCanvasModuleNode('layer-workbench', 'image_layering', { x: 0, y: 0 });
  const plans = ['background', 'foreground'].map((layerId, order) => ({ layerId,
    name: layerId, kind: order ? 'transparent' : 'background', order, sourceBounds: { x: 0, y: 0, width: 1, height: 1 } }));
  group.data.config = { ...group.data.config, groupId, sourceAssetId: sourceId, pixelMode: 'generated',
    canvasWidth: 3, canvasHeight: 2, planLayers: plans, layers: [], needsReconfirm: true, layerSelection: { mode: 'whole' } };
  const assets = ['a', 'b', 'c'].map(key => ({ assetId: key.repeat(16), sha256: key.repeat(64), mediaType: 'image/png' as const,
    width: 3, height: 2, byteSize: 42, extension: 'png' as const, label: key, origin: 'imported' as const,
    displayUrl: `novus-asset://project/owner-test/${key.repeat(16)}`, usageCount: 1 }));
  const children = plans.map((plan, index) => {
    const child = createCanvasModuleNode('layer-' + plan.layerId, 'image_layer', { x: 0, y: 0 });
    child.data.config = { ...child.data.config, ...plan, groupId, layerKind: plan.kind, sourceAssetId: sourceId,
      resultAssetId: assets[index + 1]!.assetId, resultWidth: 3, resultHeight: 2, canvasWidth: 3, canvasHeight: 2,
      qualityStatus: 'passed', formatQualityStatus: 'passed', qualityFormatCheckedAssetId: assets[index + 1]!.assetId,
      qualityValidationVersion: 2, status: 'completed', needsReconfirm: true, jobId: 'bound-job-' + plan.layerId };
    return child;
  });
  const project = { ...useAppStore.getState().project, id: 'current-layer-project', nodes: [group, ...children],
    assets, edges: [] };
  useAppStore.setState({ project, projectImages: assets, saveStatus: 'saved' });
  return { project, group, children, sourceId, groupId,
    render: () => render(<ReactFlowProvider><ModuleNodeCard id={group.id} data={group.data} selected={false} /></ReactFlowProvider>) };
}

function activeJob(f: ReturnType<typeof fixture>, status: ActiveStatus, ownership: 'foreign' | 'current' | 'bound-legacy' | 'unbound-legacy') {
  const layer = f.children[1]!;
  const queued = createConfirmedModelJob({ id: ownership === 'unbound-legacy' ? 'unrelated-legacy-job' : String(layer.data.config.jobId),
    kind: 'image', promptNodeId: layer.id, provider: 'comfly', modelRoute: 'local-layer-owner-fixture', modelId: 'local-layer-owner-model',
    displayName: 'Local layer owner fixture',
    conversationId: 'owner-fixture', referenceAssetIds: [f.sourceId], layeringGroupId: f.groupId,
    layeringLayerId: String(layer.data.config.layerId), confirmedAt: '2026-10-07T00:00:00.000Z',
    ...(ownership === 'foreign' ? { projectId: 'foreign-layer-project' }
      : ownership === 'current' ? { projectId: f.project.id }
        : ownership === 'bound-legacy' ? { projectSessionId: 'stale-session-before-reopen' } : {}) });
  if (status === 'queued') return queued;
  const submitting = transitionModelJob(queued, 'submitting');
  return status === 'submitting' ? submitting : transitionModelJob(submitting, 'running');
}

describe('layering workbench active jobs belong to the currently mounted project', () => {
  it.each(activeStatuses)('ignores a foreign %s job even if its group, layer and job IDs are reused', status => {
    const f = fixture(); useAppStore.setState({ modelJobs: [activeJob(f, status, 'foreign')] });
    f.render();
    expect(screen.getByRole('button', { name: reviewButton })).toBeEnabled();
  });

  it.each(activeStatuses)('keeps local review unavailable for a current project %s job', status => {
    const f = fixture(); useAppStore.setState({ modelJobs: [activeJob(f, status, 'current')] });
    f.render();
    expect(screen.getByRole('button', { name: reviewButton })).toBeDisabled();
  });

  it.each(activeStatuses)('keeps a durably bound legacy %s job blocked across its stale session', status => {
    const f = fixture(); useAppStore.setState({ modelJobs: [activeJob(f, status, 'bound-legacy')] });
    f.render();
    expect(screen.getByRole('button', { name: reviewButton })).toBeDisabled();
  });

  it.each(activeStatuses)('ignores an unbound sessionless %s job whose group ID alone matches', status => {
    const f = fixture(); useAppStore.setState({ modelJobs: [activeJob(f, status, 'unbound-legacy')] });
    f.render();
    expect(screen.getByRole('button', { name: reviewButton })).toBeEnabled();
  });

  it('updates review availability when a foreign task snapshot replaces the current task', () => {
    const f = fixture(); useAppStore.setState({ modelJobs: [activeJob(f, 'running', 'current')] });
    f.render();
    expect(screen.getByRole('button', { name: reviewButton })).toBeDisabled();
    act(() => useAppStore.setState({ modelJobs: [activeJob(f, 'running', 'foreign')] }));
    expect(screen.getByRole('button', { name: reviewButton })).toBeEnabled();
  });

  it('can open the local review with a foreign task present without dispatching it', async () => {
    const f = fixture();
    const job = activeJob(f, 'queued', 'foreign');
    useAppStore.setState({ modelJobs: [job] });
    f.render();
    expect(screen.getByRole('button', { name: reviewButton })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: reviewButton }));
    expect(await screen.findByRole('dialog', { name: '\u68c0\u67e5\u5f53\u524d\u5206\u5c42' })).toBeVisible();
    expect(useAppStore.getState().modelJobs).toEqual([job]);
  });

  it('keeps isolated component previews compatible while their source node is not mounted', () => {
    const f = fixture();
    const componentJob = { ...activeJob(f, 'running', 'unbound-legacy'), promptNodeId: f.group.id } as ModelJob;
    useAppStore.setState({ project: { ...f.project, nodes: f.children }, modelJobs: [componentJob] });
    f.render();
    expect(screen.getByRole('button', { name: reviewButton })).toBeDisabled();
  });
});

describe('layer node controls ignore active jobs owned by another project', () => {
  it.each(activeStatuses)('keeps replacement enabled for a foreign %s job with a reused layer job id', status => {
    const f = fixture();
    useAppStore.setState({ modelJobs: [activeJob(f, status, 'foreign')] });
    render(<ReactFlowProvider><ModuleNodeCard id={f.children[1]!.id} data={f.children[1]!.data} selected={false} /></ReactFlowProvider>);
    expect(screen.getByRole('button', { name: replaceButton })).toBeEnabled();
  });

  it.each(activeStatuses)('keeps replacement disabled for a current project %s job', status => {
    const f = fixture();
    useAppStore.setState({ modelJobs: [activeJob(f, status, 'current')] });
    render(<ReactFlowProvider><ModuleNodeCard id={f.children[1]!.id} data={f.children[1]!.data} selected={false} /></ReactFlowProvider>);
    expect(screen.getByRole('button', { name: replaceButton })).toBeDisabled();
  });

  it.each(activeStatuses)('keeps replacement disabled for a durably bound legacy %s job', status => {
    const f = fixture();
    useAppStore.setState({ modelJobs: [activeJob(f, status, 'bound-legacy')] });
    render(<ReactFlowProvider><ModuleNodeCard id={f.children[1]!.id} data={f.children[1]!.data} selected={false} /></ReactFlowProvider>);
    expect(screen.getByRole('button', { name: replaceButton })).toBeDisabled();
  });

  it.each(['failed', 'cancelled'] as const)('does not replace the local status with a foreign %s task', status => {
    const f = fixture();
    const job = transitionModelJob(activeJob(f, 'running', 'foreign'), status, { error: 'foreign provider failure' });
    useAppStore.setState({ modelJobs: [job] });
    render(<ReactFlowProvider><ModuleNodeCard id={f.children[1]!.id} data={f.children[1]!.data} selected={false} /></ReactFlowProvider>);
    expect(screen.getByLabelText('\u753b\u5e03\u56fe\u5c42\uff1aforeground')).toHaveAttribute('data-layer-status', 'completed');
    expect(screen.queryByText('foreign provider failure')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: replaceButton })).toBeEnabled();
  });

  it('keeps an owned active task blocked when a foreign same-id failure precedes it', () => {
    const f = fixture();
    const foreign = transitionModelJob(activeJob(f, 'running', 'foreign'), 'failed', { error: 'foreign provider failure' });
    const local = activeJob(f, 'running', 'current');
    useAppStore.setState({ modelJobs: [foreign, local] });
    render(<ReactFlowProvider><ModuleNodeCard id={f.children[1]!.id} data={f.children[1]!.data} selected={false} /></ReactFlowProvider>);
    expect(screen.getByRole('button', { name: replaceButton })).toBeDisabled();
    expect(screen.queryByText('foreign provider failure')).not.toBeInTheDocument();
  });

  it('ignores a sessionless same-id task without the durable source binding', () => {
    const f = fixture();
    const job = { ...activeJob(f, 'running', 'bound-legacy'), projectSessionId: undefined, referenceAssetIds: ['d'.repeat(16)] };
    useAppStore.setState({ modelJobs: [job] });
    render(<ReactFlowProvider><ModuleNodeCard id={f.children[1]!.id} data={f.children[1]!.data} selected={false} /></ReactFlowProvider>);
    expect(screen.getByRole('button', { name: replaceButton })).toBeEnabled();
  });

  it('updates replacement availability when the task snapshot changes project ownership', () => {
    const f = fixture();
    useAppStore.setState({ modelJobs: [activeJob(f, 'running', 'current')] });
    render(<ReactFlowProvider><ModuleNodeCard id={f.children[1]!.id} data={f.children[1]!.data} selected={false} /></ReactFlowProvider>);
    expect(screen.getByRole('button', { name: replaceButton })).toBeDisabled();
    act(() => useAppStore.setState({ modelJobs: [activeJob(f, 'running', 'foreign')] }));
    expect(screen.getByRole('button', { name: replaceButton })).toBeEnabled();
  });

  it('keeps an isolated layer component preview compatible with its sessionless task', () => {
    const f = fixture();
    const job = { ...activeJob(f, 'running', 'bound-legacy'), projectSessionId: undefined };
    useAppStore.setState({ project: { ...f.project, nodes: [f.group] }, modelJobs: [job] });
    render(<ReactFlowProvider><ModuleNodeCard id={f.children[1]!.id} data={f.children[1]!.data} selected={false} /></ReactFlowProvider>);
    expect(screen.getByRole('button', { name: replaceButton })).toBeDisabled();
  });
});
