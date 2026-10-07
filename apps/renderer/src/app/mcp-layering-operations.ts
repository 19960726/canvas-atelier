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
  analyze(nodeId: string, options: LayeringAnalysisOptions, isCurrentOperation?: () => boolean): Promise<LayeringPlan>;
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
const genericPsdFailure = 'Formal PSD export failed; inspect the canvas quality/position checks and desktop availability.';
const psdFailureMessages = new Map<string, string>([
  ['PSD_EXPORT_GROUP_REQUIRED', '请选择当前项目的分层组后导出 PSD。'],
  ['PSD_EXPORT_UNSUPPORTED_GENERATED_GROUP', '当前分层组不支持正式 PSD 导出，请使用原图像素分层。'],
  ['PSD_EXPORT_RECONFIRM_REQUIRED', '当前分层缺少有效确认，请在画布中逐层检查并重新确认后导出 PSD。'],
  ['PSD_EXPORT_REVIEW_CHANGED', '图层内容或顺序已变更，请重新逐层核验并确认后导出 PSD。'],
  ['PSD_EXPORT_QUALITY_OR_POSITION_NOT_READY', '图层质量或原图位置尚未就绪，请先检查每个图层。'],
  ['PSD_EXPORT_CANVAS_CHANGED', '导出期间画布已变更，请读取当前分层状态后重新导出。'],
  ['PSD_PHOTOSHOP_BRIDGE_UNAVAILABLE', '当前无法连接 Photoshop，请检查桌面应用与 Photoshop 状态。'],
  ['PSD_SAVE_BRIDGE_UNAVAILABLE', '当前桌面保存功能不可用，请在 Canvas Atelier 安装版中导出 PSD。'],
  ['PSD_EXPORT_BACKGROUND_REVIEW_REQUIRED', '背景层尚未完成当前素材的核验，请先检查背景层。'],
  ['PSD_EXPORT_INDEPENDENT_FOREGROUND_REQUIRED', '完整背景补全需要已核验的独立 RGBA 前景，请先本地精修并检查图层。'],
  ['PSD_EXPORT_BACKGROUND_OPACITY_INVALID', '正式 PSD 的背景图层必须完全不透明，请将背景透明度恢复为 100%。'],
  ['invalid_psd', 'PSD 数据未通过格式检查，请重新检查图层后导出。'],
  ['photoshop_not_installed', '未找到 Photoshop，请检查安装状态后再打开 PSD。'],
  ['discovery_failed', '无法确定 Photoshop 安装位置，请检查 Photoshop 状态后重试。'],
  ['cancelled', '已取消 PSD 导出。'],
  ['dialog_failed', 'PSD 保存对话框无法打开，请检查桌面应用状态后重试。'],
  ['save_failed', 'PSD 保存失败，请检查目标位置和写入权限后重试。'],
  ['open_failed', 'Photoshop 打开失败，请检查 Photoshop 状态后重试。'],
]);
// Match only application-owned fixed messages; layer names, paths and provider errors stay private.
const sourcePsdFailureCodes = new Map<string, string>([
  ['完整补全背景需要当前整图分层的确认摘要，请重新检查图层', 'PSD_EXPORT_RECONFIRM_REQUIRED'],
  ['分层方案已变更，请重新确认后再合成 PSD', 'PSD_EXPORT_RECONFIRM_REQUIRED'],
  ['分层确认摘要格式无效，必须是 64 位小写十六进制 digest', 'PSD_EXPORT_RECONFIRM_REQUIRED'],
  ['完整补全背景尚未完成当前背景素材的本地核验，请重新检查背景层', 'PSD_EXPORT_BACKGROUND_REVIEW_REQUIRED'],
  ['完整补全背景需要已核验的独立 RGBA 前景；原图透明蒙版请先本地精修并重新导入检查', 'PSD_EXPORT_INDEPENDENT_FOREGROUND_REQUIRED'],
  ['完整补全背景的图层审核或确认摘要已过期，请重新逐层检查', 'PSD_EXPORT_REVIEW_CHANGED'],
  ['原图分层正式合成需要不透明背景，背景图层透明度必须为 100%', 'PSD_EXPORT_BACKGROUND_OPACITY_INVALID'],
]);
function readSafePsdFailure(message: string | undefined): { code: string; error: string } | undefined {
  if (message === undefined) return undefined;
  const code = sourcePsdFailureCodes.get(message) ?? message;
  const error = psdFailureMessages.get(code);
  return error === undefined ? undefined : { code, error };
}

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
          const result = await source.layering!.analyze(request.nodeId, request.analysis!, () => current(expected) && job.status === 'running');
          if (job.status !== 'running') return;
          if (!current(expected)) throw new Error('Canvas changed during analysis');
          job.plan = clone(normalizeLayeringPlan(result));
          if (job.plan.pixelMode !== 'source') throw new Error('Analysis must produce source-pixel layers');
        } else if (operation === 'start_layering') {
          job.result = { ...await source.layering!.start(request.nodeId, clone(selectedPlan!), request.layering!), phase: 'dispatched', generationCompleted: false };
          if (!(job.result as { jobIds: string[] }).jobIds.length) throw new Error('No image jobs started');
        } else {
          const result = await source.layering!.exportPsd(request.nodeId, request.openPhotoshop === true);
          const failure = readSafePsdFailure(result.code);
          const saved = result.saved === true || result.ok;
          job.result = { saved, opened: result.opened === true, ...(failure ? { code: failure.code } : {}) };
          if (!result.ok) {
            job.status = failure?.code === 'cancelled' ? 'cancelled' : 'failed';
            if (job.status === 'failed') job.error = failure?.code === 'open_failed' && saved
              ? 'PSD 已保存，但 Photoshop 打开失败；请在 Photoshop 中打开已保存的文件。'
              : failure?.error ?? genericPsdFailure;
            return;
          }
        }
        if (job.status === 'running') job.status = 'completed';
      } catch (cause) {
        if (job.status === 'running') {
          job.status = 'failed'; job.plan = undefined;
          const failure = operation === 'export_layered_psd' && cause instanceof Error ? readSafePsdFailure(cause.message) : undefined;
          if (failure) job.result = { code: failure.code, saved: false, opened: false };
          job.error = operation === 'export_layered_psd' ? failure?.error ?? genericPsdFailure : 'Layering operation failed or the project/source changed. Inspect the canvas and analyze again.';
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
