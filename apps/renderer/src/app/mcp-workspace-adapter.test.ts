import { beforeEach, describe, expect, it, vi } from 'vitest';

import { applyProjectTransaction, createCanvasModuleNode, parseCanvasProject, type CanvasProject, type ProjectTransaction } from '@agent-canvas/domain';
import { createMcpConfirmationStore } from './mcp-confirmation-store';
import { createMcpWorkspaceAdapter, type McpWorkspaceSource } from './mcp-workspace-adapter';
import { mcpUiConfirmationStore } from './mcp-ui-confirmation-store';

describe('MCP workspace adapter', () => {
  let revision: number;
  let project: CanvasProject;
  let source: McpWorkspaceSource;
  let adapter: ReturnType<typeof createMcpWorkspaceAdapter>;
  let tokenSequence: number;

  beforeEach(() => {
    revision = 4;
    tokenSequence = 0;
    const prompt = createCanvasModuleNode('prompt-1', 'text_prompt', { x: 0, y: 0 });
    prompt.data.config = { prompt: 'Studio product image' };
    const generator = createCanvasModuleNode('image-1', 'image_generation', { x: 320, y: 0 });
    generator.data.config = { prompt: 'Studio product image', modelRoute: 'image-default', resolution: '2K' };
    project = parseCanvasProject({
      version: 1, graphVersion: 2, id: 'project-1', name: 'MCP Test', assets: [], projectMemory: [], skillPromotionCandidates: [],
      nodes: [prompt, generator],
      edges: [{ id: 'edge-1', source: 'prompt-1', sourcePortId: 'prompt', target: 'image-1', targetPortId: 'prompt', order: 0 }],
    });
    source = {
      getProject: () => project,
      getRevision: () => revision,
      getSelection: () => ({ nodeIds: ['image-1'], edgeIds: [] }),
      getJobs: () => [{ id: 'job-1', nodeId: 'image-1', status: 'running', progress: 0.5 }],
      commitProjectTransaction: vi.fn(async (transaction: ProjectTransaction) => {
        project = applyProjectTransaction(project, transaction);
        revision += 1;
        return true;
      }),
      runNode: vi.fn(async () => true),
      cancelJob: vi.fn(async () => undefined),
      requestMediaImport: vi.fn(async () => undefined),
    };
    adapter = createMcpWorkspaceAdapter(source, createMcpConfirmationStore({
      now: () => 10_000,
      createToken: () => `mcp-grant-${++tokenSequence}`,
    }));
  });

  it('describes real node definitions and reads a bounded public workflow snapshot', async () => {
    const definitions = await adapter.handle({ tool: 'canvas_describe_nodes' });
    const snapshot = await adapter.handle({ tool: 'canvas_read_workflow' });
    const selection = await adapter.handle({ tool: 'canvas_get_selection' });
    const job = await adapter.handle({ tool: 'canvas_get_job_status', jobId: 'job-1' });

    expect(definitions).toMatchObject({ ok: true, result: { toolCount: 14, modules: expect.arrayContaining([expect.objectContaining({ type: 'image_generation', ports: expect.any(Array) })]) } });
    expect(snapshot).toMatchObject({ ok: true, result: { protocol: 'canvasforge.mcp.snapshot.v1', projectId: 'project-1', revision: 4, nodes: [expect.anything(), expect.objectContaining({ id: 'image-1', moduleType: 'image_generation', config: { prompt: 'Studio product image', modelRoute: 'image-default', resolution: '2K' } })] } });
    expect(JSON.stringify(snapshot)).not.toMatch(/apiKey|authorization|C:\\|file:\/\/|base64/iu);
    expect(selection).toEqual({ ok: true, result: { nodeIds: ['image-1'], edgeIds: [] } });
    expect(job).toMatchObject({ ok: true, result: { id: 'job-1', status: 'running' } });
  });

  it('plans without mutating and applies only after a one-time UI confirmation', async () => {
    const mutations = [{ kind: 'move_nodes' as const, positions: [{ nodeId: 'image-1', x: 520, y: 120 }] }];
    const plan = await adapter.handle({ tool: 'canvas_plan_workflow', expectedRevision: 4, workflowIntent: 'Move the image node', mutations });
    expect(plan).toMatchObject({ ok: true, result: { confirmationRequired: true, expectedRevision: 4, mutations } });
    expect(project.nodes.find((node) => node.id === 'image-1')?.position).toEqual({ x: 320, y: 0 });

    const planId = readResultString(plan, 'planId');
    await expect(adapter.handle({ tool: 'canvas_apply_workflow', expectedRevision: 4, planId, confirmationToken: 'missing' })).resolves.toMatchObject({ ok: false, error: { code: 'CONFIRMATION_REQUIRED' } });
    const grant = adapter.confirmPlan(planId);
    await expect(adapter.handle({ tool: 'canvas_apply_workflow', expectedRevision: 4, planId, confirmationToken: grant.token })).resolves.toMatchObject({ ok: true, result: { revision: 5 } });
    expect(project.nodes.find((node) => node.id === 'image-1')?.position).toEqual({ x: 520, y: 120 });
    await expect(adapter.handle({ tool: 'canvas_apply_workflow', expectedRevision: 4, planId, confirmationToken: grant.token })).resolves.toMatchObject({ ok: false, error: { code: 'PROJECT_REVISION_CONFLICT' } });
  });

it('returns the one-time workflow token when the approved plan is retried exactly', async () => {
    const request = {
      tool: 'canvas_plan_workflow' as const,
      expectedRevision: 4,
      workflowIntent: 'Move the image node',
      mutations: [{ kind: 'move_nodes' as const, positions: [{ nodeId: 'image-1', x: 520, y: 120 }] }],
    };
    const first = await adapter.handle(request);
    const planId = readResultString(first, 'planId');
    adapter.confirmPlan(planId);

    const approved = await adapter.handle(request);
    expect(approved).toMatchObject({
      ok: true,
      result: { planId, confirmationRequired: false, approvalCode: 'mcp-grant-1' },
    });
  });
  it('rejects stale revisions and incompatible planned ports before persistence', async () => {
    await expect(adapter.handle({ tool: 'canvas_create_node', expectedRevision: 3, moduleType: 'text_prompt', position: { x: 20, y: 20 } })).resolves.toMatchObject({ ok: false, error: { code: 'PROJECT_REVISION_CONFLICT' } });
    await expect(adapter.handle({
      tool: 'canvas_plan_workflow', expectedRevision: 4, workflowIntent: 'Bad connection',
      mutations: [{ kind: 'connect_nodes', edgeId: 'bad-edge', sourceNodeId: 'image-1', sourcePortId: 'result', targetNodeId: 'prompt-1', targetPortId: 'prompt' }],
    })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_WORKFLOW' } });
    expect(source.commitProjectTransaction).not.toHaveBeenCalled();
  });

  it('requires separate paid confirmation before running image, video, or reverse nodes', async () => {
    const first = await adapter.handle({ tool: 'canvas_run_node', expectedRevision: 4, nodeId: 'image-1' });
    expect(first).toMatchObject({ ok: false, error: { code: 'PAID_CONFIRMATION_REQUIRED' } });
    const requestId = readErrorDetailString(first, 'requestId');
    const grant = adapter.confirmPaidJob(requestId);
    await expect(adapter.handle({ tool: 'canvas_run_node', expectedRevision: 4, nodeId: 'image-1', confirmationToken: grant.token })).resolves.toMatchObject({ ok: true, result: { started: true } });
    expect(source.runNode).toHaveBeenCalledWith('image-1');
  });

  it('returns a one-time paid approval code after CanvasForge confirmation and accepts it on the final retry', async () => {
    const request = { tool: 'canvas_run_node' as const, expectedRevision: 4, nodeId: 'image-1' };
    const first = await adapter.handle(request);
    const requestId = readErrorDetailString(first, 'requestId');
    expect(first).toMatchObject({
      ok: false,
      error: { code: 'PAID_CONFIRMATION_REQUIRED', details: { confirmationRequired: true, requestId } },
    });

    expect(mcpUiConfirmationStore.getSnapshot()).toEqual([
      expect.objectContaining({ id: requestId, kind: 'paid_job', nodeId: 'image-1' }),
    ]);
    mcpUiConfirmationStore.confirm(requestId);

    const approvedRetry = await adapter.handle(request);
    expect(approvedRetry).toMatchObject({
      ok: false,
      error: {
        code: 'PAID_CONFIRMATION_REQUIRED',
        details: { confirmationRequired: false, requestId, approvalCode: 'mcp-grant-1' },
      },
    });
    const approvalCode = readErrorDetailString(approvedRetry, 'approvalCode');

    await expect(adapter.handle({ ...request, confirmationToken: approvalCode })).resolves.toMatchObject({
      ok: true,
      result: { started: true, nodeId: 'image-1', jobKind: 'image' },
    });
    expect(source.runNode).toHaveBeenCalledOnce();
    expect(mcpUiConfirmationStore.getSnapshot()).toEqual([]);
  });
  it('opens the CanvasForge picker instead of accepting a path from MCP', async () => {
    await expect(adapter.handle({ tool: 'canvas_import_media', expectedRevision: 4, mediaKind: 'video', position: { x: 120, y: 240 } })).resolves.toMatchObject({ ok: false, error: { code: 'FILE_SELECTION_REQUIRED' } });
    expect(source.requestMediaImport).toHaveBeenCalledWith('video', { x: 120, y: 240 });
  });
});

function readResultString(response: Awaited<ReturnType<ReturnType<typeof createMcpWorkspaceAdapter>['handle']>>, key: string): string {
  if (!response.ok || typeof response.result !== 'object' || response.result === null) throw new Error('Missing result');
  const value = (response.result as Record<string, unknown>)[key];
  if (typeof value !== 'string') throw new Error(`Missing ${key}`);
  return value;
}

function readErrorDetailString(response: Awaited<ReturnType<ReturnType<typeof createMcpWorkspaceAdapter>['handle']>>, key: string): string {
  if (response.ok || typeof response.error.details !== 'object' || response.error.details === null) throw new Error('Missing error details');
  const value = (response.error.details as Record<string, unknown>)[key];
  if (typeof value !== 'string') throw new Error(`Missing ${key}`);
  return value;
}