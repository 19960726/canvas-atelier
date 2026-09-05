import { beforeEach, describe, expect, it, vi } from 'vitest';

import { applyProjectTransaction, createCanvasModuleNode, DEFAULT_MCP_PERMISSION_FLAGS, parseCanvasProject, type CanvasProject, type ProjectTransaction } from '@agent-canvas/domain';
import { createMcpConfirmationStore } from './mcp-confirmation-store';
import { createMcpWorkspaceAdapter, type McpWorkspaceSource } from './mcp-workspace-adapter';
import { mcpUiConfirmationStore } from './mcp-ui-confirmation-store';

describe('MCP workspace adapter', () => {
  let revision: number;
  let project: CanvasProject;
  let source: McpWorkspaceSource;
  let adapter: ReturnType<typeof createMcpWorkspaceAdapter>;
  let tokenSequence: number;
  let selection: { nodeIds: string[]; edgeIds: string[] };

  beforeEach(() => {
    mcpUiConfirmationStore.clear();
    revision = 4;
    tokenSequence = 0;
    selection = { nodeIds: ['image-1'], edgeIds: [] };
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
      getSelection: () => selection,
      getJobs: () => [{
        id: 'job-1', nodeId: 'image-1', status: 'completed', progress: 1,
        provider: 'relayme', modelRoute: 'relayme-image', displayName: 'RelayMe Image',
        resultAssetIds: ['asset-result-1'], resultNodeId: 'image-1',
      }],
      commitProjectTransaction: vi.fn(async (transaction: ProjectTransaction) => {
        project = applyProjectTransaction(project, transaction);
        revision += 1;
        return true;
      }),
      runNode: vi.fn(async () => ({ started: true, jobIds: ['job-started-1'] })) as unknown as McpWorkspaceSource['runNode'],
      cancelJob: vi.fn(async () => undefined),
      requestMediaImport: vi.fn(async () => undefined),
    };
    adapter = createMcpWorkspaceAdapter(source, createMcpConfirmationStore({
      now: () => 10_000,
      createToken: () => `mcp-grant-${++tokenSequence}`,
    }), { getPermissions: () => ({ ...DEFAULT_MCP_PERMISSION_FLAGS, dangerousOperations: true, externalFileAccess: true }) });
  });

  it('enforces persisted MCP capability switches at the adapter boundary', async () => {
    const permissions = { ...DEFAULT_MCP_PERMISSION_FLAGS, editCanvas: false, executeAiGeneration: false, dangerousOperations: false, externalFileAccess: false };
    adapter = createMcpWorkspaceAdapter(source, createMcpConfirmationStore({
      now: () => 10_000,
      createToken: () => `mcp-denied-${++tokenSequence}`,
    }), { getPermissions: () => permissions });

    await expect(adapter.handle({ tool: 'canvas_read_workflow' })).resolves.toMatchObject({ ok: true });
    await expect(adapter.handle({ tool: 'canvas_create_node', expectedRevision: 4, moduleType: 'text_prompt', position: { x: 1, y: 1 } })).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'MCP_PERMISSION_DENIED',
        message: "MCP permission 'editCanvas' is disabled in Canvas Atelier settings.",
        details: { permission: 'editCanvas' },
      },
    });
    await expect(adapter.handle({ tool: 'canvas_run_node', expectedRevision: 4, nodeId: 'image-1' })).resolves.toMatchObject({ ok: false, error: { code: 'MCP_PERMISSION_DENIED', details: { permission: 'executeAiGeneration' } } });
    await expect(adapter.handle({ tool: 'canvas_import_media', expectedRevision: 4, mediaKind: 'image', position: { x: 1, y: 1 } })).resolves.toMatchObject({ ok: false, error: { code: 'MCP_PERMISSION_DENIED', details: { permission: 'externalFileAccess' } } });
  });

  it('requires edit permission before opening the media picker', async () => {
    adapter = createMcpWorkspaceAdapter(source, createMcpConfirmationStore(), {
      getPermissions: () => ({ ...DEFAULT_MCP_PERMISSION_FLAGS, editCanvas: false, externalFileAccess: true }),
    });

    await expect(adapter.handle({
      tool: 'canvas_import_media', expectedRevision: 4, mediaKind: 'image', position: { x: 1, y: 1 },
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'MCP_PERMISSION_DENIED', details: { permission: 'editCanvas' } },
    });
    expect(source.requestMediaImport).not.toHaveBeenCalled();
  });

  it('requires dangerous permission before exposing a deletion plan', async () => {
    adapter = createMcpWorkspaceAdapter(source, createMcpConfirmationStore({ now: () => 10_000, createToken: () => `mcp-danger-${++tokenSequence}` }), { getPermissions: () => ({ ...DEFAULT_MCP_PERMISSION_FLAGS, dangerousOperations: false }) });
    await expect(adapter.handle({ tool: 'canvas_delete_selection', expectedRevision: 4 })).resolves.toMatchObject({ ok: false, error: { code: 'MCP_PERMISSION_DENIED', details: { permission: 'dangerousOperations' } } });
  });

  it('describes real node definitions and reads a bounded public workflow snapshot', async () => {
    const definitions = await adapter.handle({ tool: 'canvas_describe_nodes' });
    const snapshot = await adapter.handle({ tool: 'canvas_read_workflow' });
    const selection = await adapter.handle({ tool: 'canvas_get_selection' });
    const job = await adapter.handle({ tool: 'canvas_get_job_status', jobId: 'job-1' });
    const missingJob = await adapter.handle({ tool: 'canvas_get_job_status', jobId: 'missing-job' });

    expect(definitions).toMatchObject({ ok: true, result: { toolCount: 14, modules: expect.arrayContaining([expect.objectContaining({ type: 'image_generation', ports: expect.any(Array) })]) } });
    expect(snapshot).toMatchObject({ ok: true, result: { protocol: 'canvasforge.mcp.snapshot.v1', projectId: 'project-1', revision: 4, nodes: [expect.anything(), expect.objectContaining({ id: 'image-1', moduleType: 'image_generation', config: { prompt: 'Studio product image', modelRoute: 'image-default', resolution: '2K' } })] } });
    expect(JSON.stringify(snapshot)).not.toMatch(/apiKey|authorization|C:\\|file:\/\/|base64/iu);
    expect(selection).toEqual({ ok: true, result: { nodeIds: ['image-1'], edgeIds: [] } });
    expect(job).toMatchObject({
      ok: true,
      result: {
        id: 'job-1', status: 'completed', provider: 'relayme', modelRoute: 'relayme-image',
        resultAssetIds: ['asset-result-1'], resultNodeId: 'image-1',
      },
    });
    expect(missingJob).toMatchObject({
      ok: false,
      error: { code: 'JOB_NOT_FOUND', message: 'Managed Canvas Atelier job was not found.' },
    });
  });

  it('reports cancellation success only after the managed job is observably cancelled', async () => {
    let status = 'running';
    source = {
      ...source,
      getJobs: () => [{ id: 'job-cancel', nodeId: 'image-1', status }],
      cancelJob: vi.fn(async () => { status = 'cancelled'; }),
    };
    adapter = createMcpWorkspaceAdapter(source, createMcpConfirmationStore(), {
      getPermissions: () => DEFAULT_MCP_PERMISSION_FLAGS,
    });

    await expect(adapter.handle({ tool: 'canvas_cancel_job', jobId: 'job-cancel' })).resolves.toEqual({
      ok: true,
      result: { cancelled: true, jobId: 'job-cancel' },
    });
  });

  it('fails closed when a provider cancellation resolves but the managed job is not observably cancelled', async () => {
    for (const status of ['failed', 'running', 'completed', 'provider-private-status']) {
      source = {
        ...source,
        getJobs: () => [{ id: 'job-cancel', nodeId: 'image-1', status }],
        cancelJob: vi.fn(async () => undefined),
      };
      adapter = createMcpWorkspaceAdapter(source, createMcpConfirmationStore(), {
        getPermissions: () => DEFAULT_MCP_PERMISSION_FLAGS,
      });

      const response = await adapter.handle({ tool: 'canvas_cancel_job', jobId: 'job-cancel' });
      expect(response).toMatchObject({
        ok: false,
        error: {
          code: status === 'failed' ? 'JOB_CANCEL_FAILED' : 'JOB_CANCEL_UNCONFIRMED',
          details: { jobId: 'job-cancel', status: status === 'provider-private-status' ? 'unknown' : status },
        },
      });
      expect(JSON.stringify(response)).not.toContain('"cancelled":true');
      expect(JSON.stringify(response)).not.toContain('provider-private-status');
    }

    let reads = 0;
    source = {
      ...source,
      getJobs: () => reads++ === 0 ? [{ id: 'job-cancel', nodeId: 'image-1', status: 'running' }] : [],
      cancelJob: vi.fn(async () => undefined),
    };
    adapter = createMcpWorkspaceAdapter(source, createMcpConfirmationStore(), {
      getPermissions: () => DEFAULT_MCP_PERMISSION_FLAGS,
    });
    await expect(adapter.handle({ tool: 'canvas_cancel_job', jobId: 'job-cancel' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'JOB_CANCEL_UNCONFIRMED', details: { jobId: 'job-cancel', status: 'unknown' } },
    });
  });

  it('never exposes provider credentials when cancellation throws', async () => {
    for (const privateMessage of [
      'Authorization: Bearer sk-super-secret-token',
      'token=sk-live-secret-value',
      'x-api-key: private-provider-key',
    ]) {
      source = {
        ...source,
        getJobs: () => [{ id: 'job-cancel', nodeId: 'image-1', status: 'running' }],
        cancelJob: vi.fn(async () => { throw new Error(privateMessage); }),
      };
      adapter = createMcpWorkspaceAdapter(source, createMcpConfirmationStore(), {
        getPermissions: () => DEFAULT_MCP_PERMISSION_FLAGS,
      });

      const response = await adapter.handle({ tool: 'canvas_cancel_job', jobId: 'job-cancel' });
      expect(response).toEqual({
        ok: false,
        error: { code: 'MCP_WORKSPACE_ERROR', message: 'Canvas Atelier rejected the workspace operation.' },
      });
      expect(JSON.stringify(response)).not.toMatch(/secret|private-provider|authorization|api-key|token=/iu);
    }
  });

  it('returns generated node and edge ids from direct mutations', async () => {
    const created = await adapter.handle({
      tool: 'canvas_create_node', expectedRevision: 4, moduleType: 'reverse_agent', position: { x: 30, y: 50 },
    });
    expect(created).toMatchObject({ ok: true, result: { applied: true, revision: 5, nodeId: expect.any(String) } });
    const nodeId = readResultString(created, 'nodeId');

    const connected = await adapter.handle({
      tool: 'canvas_connect_nodes', expectedRevision: 5,
      sourceNodeId: 'prompt-1', sourcePortId: 'prompt', targetNodeId: nodeId, targetPortId: 'task',
    });
    expect(connected).toMatchObject({ ok: true, result: { applied: true, revision: 6, edgeId: expect.any(String) } });
    expect(project.edges.some((edge) => edge.id === readResultString(connected, 'edgeId'))).toBe(true);
  });

  it('rejects movement of a locked node instead of silently reporting success', async () => {
    project = parseCanvasProject({
      ...project,
      nodes: project.nodes.map((node) => node.id === 'prompt-1' ? { ...node, locked: true } : node),
    });

    await expect(adapter.handle({
      tool: 'canvas_move_nodes', expectedRevision: 4, positions: [{ nodeId: 'prompt-1', x: 200, y: 200 }],
    })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_WORKFLOW' } });
    expect(source.commitProjectTransaction).not.toHaveBeenCalled();
  });

  it('turns the current node and edge selection into a confirmable deletion plan', async () => {
    selection = { nodeIds: ['image-1'], edgeIds: ['edge-1'] };
    const response = await adapter.handle({ tool: 'canvas_delete_selection', expectedRevision: 4 });

    expect(response).toMatchObject({
      ok: true,
      result: {
        confirmationRequired: true,
        mutations: expect.arrayContaining([
          { kind: 'delete_nodes', nodeIds: ['image-1'] },
          { kind: 'delete_edges', edgeIds: ['edge-1'] },
        ]),
      },
    });
  });

  it('describes how every node can be used and whether MCP can run it', async () => {
    const definitions = await adapter.handle({ tool: 'canvas_describe_nodes' });
    expect(definitions).toMatchObject({
      ok: true,
      result: {
        modules: expect.arrayContaining([expect.objectContaining({
          type: 'image_generation', purpose: expect.any(String), usage: expect.any(String),
          limitations: expect.any(String), recommendedDownstreamModuleTypes: expect.any(Array),
          defaultConfig: expect.any(Object), mcpRunnable: true,
        }), expect.objectContaining({ type: 'image_editor', mcpRunnable: false })]),
      },
    });
  });

  it('returns immediately after opening the in-app media picker', async () => {
    source.requestMediaImport = vi.fn(() => new Promise<void>(() => undefined));

    await expect(adapter.handle({
      tool: 'canvas_import_media', expectedRevision: 4, mediaKind: 'video', position: { x: 120, y: 240 },
    })).resolves.toMatchObject({ ok: true, result: { pickerOpened: true, mediaKind: 'video' } });
  });

  it('does not advertise an execution path for module types without a real runner', async () => {
    const editor = createCanvasModuleNode('editor-1', 'image_editor', { x: 640, y: 0 });
    project = parseCanvasProject({ ...project, nodes: [...project.nodes, editor] });

    await expect(adapter.handle({
      tool: 'canvas_run_node', expectedRevision: 4, nodeId: 'editor-1',
    })).resolves.toMatchObject({ ok: false, error: { code: 'NODE_NOT_EXECUTABLE' } });
    expect(mcpUiConfirmationStore.getSnapshot()).toEqual([]);
  });

  it('plans without mutating and applies only after a one-time UI confirmation', async () => {
    const mutations = [{ kind: 'move_nodes' as const, positions: [{ nodeId: 'image-1', x: 520, y: 120 }] }];
    const plan = await adapter.handle({ tool: 'canvas_plan_workflow', expectedRevision: 4, workflowIntent: 'Move the image node', mutations });
    expect(plan).toMatchObject({ ok: true, result: { confirmationRequired: true, expectedRevision: 4, mutations } });
    expect(project.nodes.find((node) => node.id === 'image-1')?.position).toEqual({ x: 320, y: 0 });

    const planId = readResultString(plan, 'planId');
    await expect(adapter.handle({ tool: 'canvas_apply_workflow', expectedRevision: 4, planId, confirmationToken: 'missing' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'CONFIRMATION_REQUIRED', message: 'Confirm this exact workflow plan inside Canvas Atelier.' },
    });
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
    expect(first).toMatchObject({
      ok: false,
      error: { code: 'PAID_CONFIRMATION_REQUIRED', message: 'Confirm the paid model job inside Canvas Atelier.' },
    });
    const requestId = readErrorDetailString(first, 'requestId');
    const grant = adapter.confirmPaidJob(requestId);
    await expect(adapter.handle({ tool: 'canvas_run_node', expectedRevision: 4, nodeId: 'image-1', confirmationToken: grant.token })).resolves.toMatchObject({ ok: true, result: { started: true, jobIds: ['job-started-1'] } });
    expect(source.runNode).toHaveBeenCalledWith('image-1');
  });

  it('returns a one-time paid approval code after Canvas Atelier confirmation and accepts it on the final retry', async () => {
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
      result: { started: true, nodeId: 'image-1', jobKind: 'image', jobIds: ['job-started-1'] },
    });
    expect(source.runNode).toHaveBeenCalledOnce();
    expect(mcpUiConfirmationStore.getSnapshot()).toEqual([]);
  });
  it('opens the Canvas Atelier picker instead of accepting a path from MCP', async () => {
    await expect(adapter.handle({ tool: 'canvas_import_media', expectedRevision: 4, mediaKind: 'video', position: { x: 120, y: 240 } })).resolves.toMatchObject({ ok: true, result: { pickerOpened: true } });
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
