import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCanvasModuleNode, DEFAULT_MCP_PERMISSION_FLAGS, parseCanvasProject, type CanvasMcpRequest } from '@agent-canvas/domain';
import { createMcpWorkspaceAdapter, type McpWorkspaceSource } from './mcp-workspace-adapter';
import { createMcpConfirmationStore } from './mcp-confirmation-store';
import { mcpUiConfirmationStore } from './mcp-ui-confirmation-store';
import type { LayeringPlan } from './layering-plan';

const assetId = 'a1b2c3d4e5f60718';
const plan: LayeringPlan = { sourceAssetId: assetId, canvasWidth: 24, canvasHeight: 24, pixelMode: 'source', layers: [
  { layerId: 'background', kind: 'background', name: '背景', description: '补全杯子背后', included: true },
  { layerId: 'cup', kind: 'transparent', name: '杯子', description: '仅杯子', included: true, sourceBounds: { x: .1, y: .1, width: .5, height: .5 } },
] };
const analysis = { provider: 'relayme', modelRoute: 'vision-route', mode: 'auto' };

describe('actual MCP layering operation contract', () => {
  let source: McpWorkspaceSource;
  let adapter: ReturnType<typeof createMcpWorkspaceAdapter>;
  let revision: number;
  let now: number;
  let permissions: typeof DEFAULT_MCP_PERMISSION_FLAGS;
  let analyze: ReturnType<typeof vi.fn>;
  let start: ReturnType<typeof vi.fn>;
  let exportPsd: ReturnType<typeof vi.fn>;
  const call = (fields: Record<string, unknown>) => adapter.handle({ tool: 'canvas_run_node', expectedRevision: revision, nodeId: 'source-node', ...fields } as CanvasMcpRequest);
  const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
  async function approve(fields: Record<string, unknown>) {
    const pending = await call(fields);
    expect(pending).toMatchObject({ ok: false, error: { code: 'OPERATION_CONFIRMATION_REQUIRED' } });
    const id = (pending as { error: { details: { requestId: string } } }).error.details.requestId;
    const grant = mcpUiConfirmationStore.confirm(id);
    return call({ ...fields, confirmationToken: grant.token });
  }
  async function analyzed() {
    const result = await approve({ operation: 'analyze_layering', analysis });
    expect(result).toMatchObject({ ok: true, result: { started: true, jobIds: [expect.any(String)] } });
    await settle();
    return (result as { result: { jobIds: string[] } }).result.jobIds[0]!;
  }
  beforeEach(() => {
    revision = 4; now = 10_000;
    permissions = { ...DEFAULT_MCP_PERMISSION_FLAGS, exportFiles: true };
    const node = createCanvasModuleNode('source-node', 'image_input', { x: 0, y: 0 });
    node.data.config.assetId = assetId;
    const project = parseCanvasProject({ version: 1, graphVersion: 2, id: 'project-1', name: 'Layering', assets: [{ assetId, byteSize: 16, extension: 'png', height: 24, label: '原图', mediaType: 'image/png', origin: 'imported', sha256: `${assetId}${'b'.repeat(48)}`, width: 24 }], projectMemory: [], skillPromotionCandidates: [], nodes: [node], edges: [] });
    analyze = vi.fn(async () => plan);
    start = vi.fn(async () => ({ groupNodeId: 'group-node', jobIds: ['background-job', 'cup-job'] }));
    exportPsd = vi.fn(async () => ({ ok: true, saved: true, opened: false }));
    source = { getProject: () => project, getRevision: () => revision, getSelection: () => ({ nodeIds: [], edgeIds: [] }), getJobs: () => [],
      commitProjectTransaction: vi.fn(async () => true), runNode: vi.fn(async () => ({ started: false, jobIds: [] })), cancelJob: vi.fn(async () => undefined), requestMediaImport: () => false,
      layering: { analyze, start, exportPsd },
    } as McpWorkspaceSource;
    let sequence = 0;
    adapter = createMcpWorkspaceAdapter(source, createMcpConfirmationStore({ now: () => now, createToken: () => `layer-grant-${++sequence}` }), { getPermissions: () => permissions });
  });
  afterEach(() => mcpUiConfirmationStore.clear());

  it('discovers typed operations with explicit permissions and source-only formal export', async () => {
    await expect(adapter.handle({ tool: 'canvas_describe_nodes' })).resolves.toMatchObject({ ok: true, result: {
      runOperations: expect.arrayContaining([expect.objectContaining({ operation: 'analyze_layering' }), expect.objectContaining({ operation: 'start_layering' }), expect.objectContaining({ operation: 'export_layered_psd' })]),
    } });
  });
  it('requires a separate Canvas confirmation before analysis dispatch', async () => {
    await call({ operation: 'analyze_layering', analysis });
    expect(analyze).not.toHaveBeenCalled();
    const jobId = await analyzed();
    await expect(adapter.handle({ tool: 'canvas_get_job_status', jobId })).resolves.toMatchObject({ ok: true, result: { status: 'completed', operation: 'analyze_layering', plan } });
    expect(analyze).toHaveBeenCalledTimes(1);
  });
  it('returns a tracked running job immediately while analysis is pending', async () => {
    let resolve!: (value: LayeringPlan) => void;
    analyze.mockImplementationOnce(() => new Promise<LayeringPlan>(done => { resolve = done; }));
    const result = await approve({ operation: 'analyze_layering', analysis });
    const jobId = (result as { result: { jobIds: string[] } }).result.jobIds[0]!;
    await expect(adapter.handle({ tool: 'canvas_get_job_status', jobId })).resolves.toMatchObject({ ok: true, result: { status: 'running' } });
    resolve(plan); await settle();
  });
  it('requires separate batch confirmation and passes only the owned analyzed plan', async () => {
    const analysisJobId = await analyzed();
    const fields = { operation: 'start_layering', layering: { analysisJobId, provider: 'relayme', modelRoute: 'transparent-route', resolution: '2K', layerEdits: [{ layerId: 'cup', name: '原杯子' }] } };
    await call(fields); expect(start).not.toHaveBeenCalled();
    const result = await approve(fields); await settle();
    const jobId = (result as { result: { jobIds: string[] } }).result.jobIds[0]!;
    await expect(adapter.handle({ tool: 'canvas_get_job_status', jobId })).resolves.toMatchObject({ ok: true, result: { status: 'completed', result: { phase: 'dispatched', generationCompleted: false, groupNodeId: 'group-node', jobIds: ['background-job', 'cup-job'] } } });
    expect(start).toHaveBeenCalledWith('source-node', expect.objectContaining({ sourceAssetId: assetId, layers: expect.arrayContaining([expect.objectContaining({ name: '原杯子' })]) }), expect.objectContaining({ modelRoute: 'transparent-route' }));
  });
  it('rejects a caller-created analysis ID and never dispatches generation', async () => {
    await expect(call({ operation: 'start_layering', layering: { analysisJobId: 'invented', provider: 'relayme', modelRoute: 'transparent-route', resolution: '2K' } })).resolves.toMatchObject({ ok: false, error: { code: 'LAYERING_PLAN_UNAVAILABLE' } });
    expect(start).not.toHaveBeenCalled();
  });
  it.each(['revision', 'owner', 'source'] as const)('rejects %s drift after analysis before batch dispatch', async kind => {
    const analysisJobId = await analyzed();
    if (kind === 'revision') revision++;
    if (kind === 'owner') source.getProject().id = 'other-project';
    const node = source.getProject().nodes[0]!;
    if (kind === 'source' && node.type === 'module') node.data.config.assetId = 'replacement';
    await expect(call({ operation: 'start_layering', layering: { analysisJobId, provider: 'relayme', modelRoute: 'transparent-route', resolution: '2K' } })).resolves.toMatchObject({ ok: false, error: { code: 'LAYERING_PLAN_STALE' } });
    expect(start).not.toHaveBeenCalled();
  });
  it('never accepts client quality flags, arbitrary paths, or PSD bytes', async () => {
    await expect(call({ operation: 'export_layered_psd', qualityStatus: 'passed', path: 'C:\\private\\layers.psd', bytes: [1,2,3] })).resolves.toMatchObject({ ok: false, error: { code: 'MCP_INVALID_REQUEST' } });
    expect(exportPsd).not.toHaveBeenCalled();
  });
  it('requires exportFiles and never invokes a save dialog without it', async () => {
    permissions = { ...permissions, exportFiles: false };
    await expect(call({ operation: 'export_layered_psd' })).resolves.toMatchObject({ ok: false, error: { code: 'MCP_PERMISSION_DENIED', details: { permission: 'exportFiles' } } });
    expect(exportPsd).not.toHaveBeenCalled();
  });
  it('reports cancelled saves distinctly and defaults Photoshop opening to false', async () => {
    exportPsd.mockResolvedValueOnce({ ok: false, code: 'cancelled', saved: false, opened: false });
    const result = await approve({ operation: 'export_layered_psd' }); await settle();
    const jobId = (result as { result: { jobIds: string[] } }).result.jobIds[0]!;
    await expect(adapter.handle({ tool: 'canvas_get_job_status', jobId })).resolves.toMatchObject({ ok: true, result: { status: 'cancelled', result: { saved: false, opened: false } } });
    expect(exportPsd).toHaveBeenCalledWith('source-node', false);
  });
  it('rejects expired or replayed confirmations with zero extra dispatch', async () => {
    const fields = { operation: 'analyze_layering', analysis };
    const pending = await call(fields);
    const id = (pending as { error: { details: { requestId: string } } }).error.details.requestId;
    const grant = mcpUiConfirmationStore.confirm(id); now += 300_001;
    await expect(call({ ...fields, confirmationToken: grant.token })).resolves.toMatchObject({ ok: false, error: { code: 'OPERATION_CONFIRMATION_REQUIRED' } });
    expect(analyze).not.toHaveBeenCalled();
    const started = await approve(fields); expect(started.ok).toBe(true);
    await expect(call({ ...fields, confirmationToken: grant.token })).resolves.toMatchObject({ ok: false });
    expect(analyze).toHaveBeenCalledTimes(1);
  });
  it('drops a cancelled analysis result and never makes its plan executable', async () => {
    let resolve!: (value: LayeringPlan) => void;
    analyze.mockImplementationOnce(() => new Promise<LayeringPlan>(done => { resolve = done; }));
    const result = await approve({ operation: 'analyze_layering', analysis });
    const jobId = (result as { result: { jobIds: string[] } }).result.jobIds[0]!;
    await expect(adapter.handle({ tool: 'canvas_cancel_job', jobId })).resolves.toMatchObject({ ok: true });
    resolve(plan); await settle();
    await expect(adapter.handle({ tool: 'canvas_get_job_status', jobId })).resolves.toMatchObject({ ok: true, result: { status: 'cancelled' } });
    await expect(call({ operation: 'start_layering', layering: { analysisJobId: jobId, provider: 'relayme', modelRoute: 'transparent-route', resolution: '2K' } })).resolves.toMatchObject({ ok: false, error: { code: 'LAYERING_PLAN_UNAVAILABLE' } });
  });
  it.each(['analyze_layering', 'start_layering'] as const)('expires %s paid approval after two minutes with zero dispatch', async operation => {
    const fields = operation === 'analyze_layering' ? { operation, analysis } : { operation, layering: { analysisJobId: await analyzed(), provider: 'relayme', modelRoute: 'transparent-route', resolution: '2K' } };
    const pending = await call(fields);
    const id = (pending as { error: { details: { requestId: string } } }).error.details.requestId;
    const grant = mcpUiConfirmationStore.confirm(id);
    analyze.mockClear(); now += 120_001;
    await expect(call({ ...fields, confirmationToken: grant.token })).resolves.toMatchObject({ ok: false, error: { code: 'OPERATION_CONFIRMATION_REQUIRED', details: { reason: 'CONFIRMATION_EXPIRED' } } });
    expect(analyze).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled();
  });
  it('rejects layer edits that convert an analyzed object into a shadow-only mask', async () => {
    analyze.mockResolvedValueOnce({ ...plan, layers: plan.layers.map(layer => layer.layerId === 'cup' ? { ...layer, layerId: 'shadow-cup' } : layer) });
    const analysisJobId = await analyzed();
    await expect(call({ operation: 'start_layering', layering: { analysisJobId, provider: 'relayme', modelRoute: 'transparent-route', resolution: '2K', layerEdits: [{ layerId: 'shadow-cup', name: '杯子投影', description: '仅投影，不含杯子本体' }] } })).resolves.toMatchObject({ ok: false, error: { code: 'LAYERING_PLAN_INVALID' } });
    expect(start).not.toHaveBeenCalled();
  });

  it('rejects object-to-shadow layer edits while retaining the analyzed ordinary object ID', async () => {
    const analysisJobId = await analyzed();
    expect(plan.layers.find(layer => layer.layerId === 'cup')).toMatchObject({ layerId: 'cup', name: '杯子', description: '仅杯子' });
    await expect(call({ operation: 'start_layering', layering: { analysisJobId, provider: 'relayme', modelRoute: 'transparent-route', resolution: '2K',
      layerEdits: [{ layerId: 'cup', name: '杯子投影', description: '仅杯子在台面的投影，不含杯子本体' }] } }))
      .resolves.toMatchObject({ ok: false, error: { code: 'LAYERING_PLAN_INVALID' } });
    expect(start).not.toHaveBeenCalled();
  });
});
