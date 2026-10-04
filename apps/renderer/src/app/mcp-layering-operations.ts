import { redactMcpValue, type CanvasMcpRequest, type CanvasMcpResponse, type CanvasProject, type McpPermissionFlags } from '@agent-canvas/domain';
import { normalizeLayeringPlan, type LayeringPlan } from './layering-plan';
import { readLayeringSelection } from './layering-selection';
import type { McpConfirmationGrant, McpConfirmationStore } from './mcp-confirmation-store';
import { mcpUiConfirmationStore } from './mcp-ui-confirmation-store';
import { isShadowOnlyLayer } from './shadow-layer-role';

type RunRequest = Extract<CanvasMcpRequest, { tool: 'canvas_run_node' }>;
export type LayeringAnalysisOptions = NonNullable<RunRequest['analysis']>;
export type LayeringStartOptions = NonNullable<RunRequest['layering']>;
export interface McpLayeringCallbacks {
  validateSource?(nodeId: string): void;
  analyze(nodeId: string, options: LayeringAnalysisOptions): Promise<LayeringPlan>;
  start(nodeId: string, plan: LayeringPlan, options: LayeringStartOptions): Promise<{ readonly groupNodeId: string; readonly jobIds: readonly string[] }>;
  exportPsd(nodeId: string, openPhotoshop: boolean): Promise<{ readonly ok: boolean; readonly code?: string; readonly saved?: boolean; readonly opened?: boolean }>;
}
type Owner = { projectId: string; revision: number; projectState: string };
type Pending = Owner & { id: string; requestState: string; subjectState: string; createdAt: number; grant?: McpConfirmationGrant };
type Job = Owner & { id: string; createdAt: number; nodeId: string; operation: NonNullable<RunRequest['operation']>; status: 'running' | 'completed' | 'failed' | 'cancelled'; plan?: LayeringPlan; result?: unknown; error?: string };
let sequence = 0;
const id = (prefix: string) => `${prefix}-${Date.now()}-${++sequence}`;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const ok = (result: unknown): CanvasMcpResponse => ({ ok: true, result: redactMcpValue(result) });
const fail = (code: string, message: string, details?: unknown): CanvasMcpResponse => ({ ok: false, error: { code, message, ...(details === undefined ? {} : { details: redactMcpValue(details) }) } });

/** Plans are held by this canvas runtime, never accepted as caller-issued result/quality claims. */
export function createMcpLayeringOperations(source: { getProject(): CanvasProject; getRevision(): number; layering?: McpLayeringCallbacks }, confirmations: McpConfirmationStore) {
  const pending = new Map<string, Pending>();
  const jobs = new Map<string, Job>();
  const owner = (): Owner => ({ projectId: source.getProject().id, revision: source.getRevision(), projectState: JSON.stringify(source.getProject()) });
  const current = (value: Owner, now = owner()) => now.projectId === value.projectId && now.revision === value.revision && now.projectState === value.projectState;
  function cleanup(now: Owner) {
    const timestamp = Date.now();
    for (const [key, value] of pending) if (!current(value, now) || timestamp - value.createdAt > 5 * 60_000) { pending.delete(key); mcpUiConfirmationStore.dismiss(key); }
    for (const [key, value] of jobs) if (value.status !== 'running' && timestamp - value.createdAt > 30 * 60_000) jobs.delete(key);
    if (jobs.size >= 64) for (const [key, value] of jobs) { if (value.status !== 'running') jobs.delete(key); if (jobs.size < 64) break; }
  }
  function getJob(jobId: string): CanvasMcpResponse | undefined {
    const job = jobs.get(jobId);
    if (!job || job.projectId !== source.getProject().id) return undefined;
    return ok({ id: job.id, nodeId: job.nodeId, operation: job.operation, status: job.status, ...(job.plan ? { plan: job.plan } : {}), ...(job.result === undefined ? {} : { result: job.result }), ...(job.error ? { error: job.error } : {}) });
  }
  async function handle(request: RunRequest, permissions: McpPermissionFlags): Promise<CanvasMcpResponse> {
    const operation = request.operation!;
    const required: (keyof McpPermissionFlags)[] = operation === 'export_layered_psd' ? ['readCanvas', 'exportFiles'] : operation === 'start_layering' ? ['readCanvas', 'editCanvas', 'executeAiGeneration'] : ['readCanvas', 'executeAiGeneration'];
    for (const permission of required) if (permissions[permission] !== true) return fail('MCP_PERMISSION_DENIED', `MCP permission '${permission}' is disabled in Canvas Atelier settings.`, { permission, tool: request.tool });
    if (!source.layering) return fail('LAYERING_UNAVAILABLE', 'This canvas runtime has no layering/export bridge.');
    const expected = owner();
    cleanup(expected);
    if (request.expectedRevision !== source.getRevision()) return fail('PROJECT_REVISION_CONFLICT', 'Canvas changed; read the workflow again.', { currentRevision: source.getRevision() });
    if (!source.getProject().nodes.some(node => node.id === request.nodeId && node.type === 'module')) return fail('NODE_NOT_FOUND', 'Canvas module node was not found.');
    if (operation !== 'export_layered_psd' && source.layering.validateSource) {
      try { source.layering.validateSource(request.nodeId); } catch (cause) {
        return fail(cause instanceof Error && /^LAYERING_SOURCE_[A-Z_]+$/u.test(cause.message) ? cause.message : 'LAYERING_SOURCE_UNAVAILABLE', 'Choose a current owned image input or a single generated result. For a batch, select the intended result in an image input first.');
      }
    }
    let selectedPlan: LayeringPlan | undefined;
    if (operation === 'analyze_layering') {
      if (!request.analysis || request.layering || request.openPhotoshop !== undefined) return fail('MCP_INVALID_REQUEST', 'Analysis requires only typed analysis options.');
      try { readLayeringSelection(request.analysis.selection); } catch { return fail('MCP_INVALID_REQUEST', 'The analysis selection is invalid.'); }
      if (request.analysis.mode === 'custom' && request.analysis.targetLayerCount === undefined) return fail('MCP_INVALID_REQUEST', 'Custom analysis requires targetLayerCount.');
    } else if (operation === 'start_layering') {
      if (!request.layering || request.analysis || request.openPhotoshop !== undefined) return fail('MCP_INVALID_REQUEST', 'Generation requires only typed layering options.');
      const analyzed = jobs.get(request.layering.analysisJobId);
      if (!analyzed?.plan || analyzed.operation !== 'analyze_layering' || analyzed.status !== 'completed' || analyzed.nodeId !== request.nodeId) return fail('LAYERING_PLAN_UNAVAILABLE', 'Use a completed analysis job for this exact source node.');
      if (!current(analyzed, expected)) return fail('LAYERING_PLAN_STALE', 'The project, source, or revision changed after analysis. Analyze again before generation.');
      try {
        const edits = request.layering.layerEdits ?? [];
        if (new Set(edits.map(edit => edit.layerId)).size !== edits.length || edits.some(edit => !analyzed.plan!.layers.some(layer => layer.layerId === edit.layerId))) throw new Error('Unknown or repeated layer edit');
        selectedPlan = normalizeLayeringPlan({ ...analyzed.plan, layers: analyzed.plan.layers.map(layer => ({ ...layer, ...edits.find(edit => edit.layerId === layer.layerId) })) });
        // A rename must not turn an object mask into a shadow mask or remove its formal position contract.
        for (const layer of selectedPlan.layers) {
          if (layer.kind === 'transparent' && layer.included && !layer.sourceBounds) throw new Error('Included foreground needs sourceBounds');
          const original = analyzed.plan.layers.find(item => item.layerId === layer.layerId)!;
          if (isShadowOnlyLayer({ ...original }) !== isShadowOnlyLayer({ ...layer })) throw new Error('Protected shadow identity cannot change');
        }
      } catch { return fail('LAYERING_PLAN_INVALID', 'Layer edits must preserve unique identities, an included background, foreground bounds and at least one foreground.'); }
    } else if (request.analysis || request.layering) return fail('MCP_INVALID_REQUEST', 'PSD export accepts only nodeId and optional openPhotoshop.');
    const { confirmationToken: _approval, ...exactRequest } = request;
    const requestState = JSON.stringify(exactRequest);
    const outputCount = operation === 'start_layering' ? selectedPlan!.layers.filter(layer => layer.included).length : 1;
    const subjectState = JSON.stringify({ request: exactRequest, plan: selectedPlan, sourceProjectState: expected.projectState, outputCount });
    let matching = [...pending.values()].find(item => current(item, expected) && item.requestState === requestState && item.subjectState === subjectState);
    if (!request.confirmationToken) {
      if (!matching) {
        if (pending.size >= 64 || jobs.size >= 64) return fail('LAYERING_RUNTIME_BUSY', 'Too many active layering requests; finish or cancel existing work first.');
        matching = { ...expected, id: id('mcp-layer-confirm'), requestState, subjectState, createdAt: Date.now() }; pending.set(matching.id, matching);
        const requestId = matching.id;
        const details = operation === 'analyze_layering'
          ? [`原图节点：${request.nodeId}`, `单次图像分析：${request.analysis!.provider} · ${request.analysis!.modelRoute}`, '仅分析并返回待审核方案；不会生成图层。']
          : operation === 'start_layering'
            ? [`原图节点：${request.nodeId}`, `${request.layering!.provider} · ${request.layering!.modelRoute} · ${request.layering!.resolution}`, `本次生成 ${selectedPlan!.layers.filter(layer => layer.included).length} 张图层；可能消耗额度。`, ...selectedPlan!.layers.filter(layer => layer.included).map(layer => `${layer.name}：${layer.description}；范围 ${JSON.stringify(layer.sourceBounds ?? '完整背景')}`)]
            : [`分层组：${request.nodeId}`, '重新检查正式图层质量及像素，仅通过后打开保存对话框。', request.openPhotoshop === true ? '保存后明确在 Photoshop 中打开新文档。' : '只保存 PSD，不启动 Photoshop。'];
        mcpUiConfirmationStore.publish({ id: requestId, kind: 'layering_operation', operation, title: operation === 'analyze_layering' ? '确认图片分层分析' : operation === 'start_layering' ? '确认分层生成' : '确认正式 PSD 导出', projectId: expected.projectId, expectedRevision: expected.revision, details }, {
          confirm: () => {
            const item = pending.get(requestId); if (!item || !current(item)) throw new Error('LAYERING_CONFIRMATION_STALE');
            const subject = { planId: item.id, projectId: item.projectId, expectedRevision: item.revision, mutationHash: item.subjectState };
            item.grant ??= operation === 'export_layered_psd' ? confirmations.issueWorkflow(subject) : confirmations.issueLayeringPaid({ ...subject, operation, outputCount }); return item.grant;
          }, reject: () => { pending.delete(requestId); },
        });
      }
      return fail('OPERATION_CONFIRMATION_REQUIRED', 'Confirm this exact operation inside Canvas Atelier, retry unchanged to read approvalCode, then submit that one-time code.', { requestId: matching.id, operation, confirmationRequired: !matching.grant, ...(matching.grant ? { approvalCode: matching.grant.token, confirmationExpiresAt: matching.grant.expiresAt } : {}) });
    }
    if (!matching) return fail('OPERATION_CONFIRMATION_REQUIRED', 'This operation has no current matching confirmation.');
    const subject = { token: request.confirmationToken, planId: matching.id, projectId: matching.projectId, expectedRevision: matching.revision, mutationHash: matching.subjectState };
    const consumed = operation === 'export_layered_psd' ? confirmations.consumeWorkflow(subject) : confirmations.consumeLayeringPaid({ ...subject, operation, outputCount });
    if (!consumed.ok) { pending.delete(matching.id); mcpUiConfirmationStore.dismiss(matching.id); return fail('OPERATION_CONFIRMATION_REQUIRED', 'Confirm this exact operation again.', { reason: consumed.code }); }
    pending.delete(matching.id); mcpUiConfirmationStore.dismiss(matching.id);
    const job: Job = { ...expected, id: id('mcp-layer-job'), createdAt: Date.now(), nodeId: request.nodeId, operation, status: 'running' }; jobs.set(job.id, job);
    // Do not hold the 15-second MCP request open for model work or a native save dialog.
    void (async () => {
      try {
        if (!current(expected) || job.status !== 'running') throw new Error('Canvas changed before dispatch');
        if (operation === 'analyze_layering') {
          const result = await source.layering!.analyze(request.nodeId, request.analysis!);
          if (job.status !== 'running') return;
          if (!current(expected)) throw new Error('Canvas changed during analysis');
          job.plan = clone(normalizeLayeringPlan(result));
          if (job.plan.pixelMode !== 'source') throw new Error('Analysis must produce source-pixel layers');
        } else if (operation === 'start_layering') {
          job.result = { ...await source.layering!.start(request.nodeId, clone(selectedPlan!), request.layering!), phase: 'dispatched', generationCompleted: false };
          if (!(job.result as { jobIds: string[] }).jobIds.length) throw new Error('No image jobs started');
        } else {
          const result = await source.layering!.exportPsd(request.nodeId, request.openPhotoshop === true);
          job.result = { saved: result.saved === true || result.ok, opened: result.opened === true, ...(result.code ? { code: result.code } : {}) };
          if (!result.ok) { job.status = result.code === 'cancelled' ? 'cancelled' : 'failed'; return; }
        }
        if (job.status === 'running') job.status = 'completed';
      } catch (cause) {
        if (job.status === 'running') {
          job.status = 'failed'; job.plan = undefined;
          if (cause instanceof Error && /^PSD_[A-Z_]+$/u.test(cause.message)) job.result = { code: cause.message, saved: false, opened: false };
          job.error = operation === 'export_layered_psd' ? 'Formal PSD export failed; inspect the canvas quality/position checks and desktop availability.' : 'Layering operation failed or the project/source changed. Inspect the canvas and analyze again.';
        }
      }
    })();
    return ok({ started: true, operation, nodeId: request.nodeId, jobIds: [job.id] });
  }
  return { handle, getJob,
    cancel(jobId: string): CanvasMcpResponse | undefined {
      const job = jobs.get(jobId); if (!job || job.projectId !== source.getProject().id) return undefined;
      // Analysis has no abort-capable store API. Discard its eventual plan without claiming provider cancellation.
      if (job.operation !== 'analyze_layering' || job.status !== 'running') return fail('JOB_CANCEL_UNSUPPORTED', 'Use the image job IDs to cancel generation; native export dialogs must be cancelled inside Canvas.');
      job.status = 'cancelled'; job.plan = undefined; return ok({ cancelled: true, jobId, scope: 'discard_analysis_result', providerCancellationConfirmed: false });
    },
    invalidateProject(projectId: string) {
      for (const [key, value] of pending) if (value.projectId === projectId) { pending.delete(key); mcpUiConfirmationStore.dismiss(key); }
      for (const [key, value] of jobs) if (value.projectId === projectId) { value.status = 'cancelled'; jobs.delete(key); }
    },
  };
}
