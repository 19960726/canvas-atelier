import { Component, useEffect, type ErrorInfo, type ReactNode } from 'react';
import { normalizeImageOutputFormat, normalizeImageBackground, type CanvasModuleNode } from '@agent-canvas/domain';
import type { ProviderBridgeProfile } from '@agent-canvas/desktop-core';
import { CanvasWorkspace } from '../canvas/CanvasWorkspace';
import { useAppStore } from './app-store';
import { getActiveProjectSessionId } from './desktop-persistence';
import { getMcpCanvasSelection, resetMcpCanvasSelection } from './mcp-canvas-selection';
import {
  createMcpWorkspaceAdapter,
  type McpPaidJobExecutionRoute,
  type McpWorkspaceAdapter,
  type McpWorkspaceJobSummary,
  type McpPaidJobRoute,
  type McpWorkspaceRunResult,
} from './mcp-workspace-adapter';
import { mcpUiConfirmationStore } from './mcp-ui-confirmation-store';
import { readMcpPermissions } from '../settings/mcp-permissions';
import { filterModelJobsForProject } from '../jobs/project-model-jobs';
import { normalizeImageQuality } from './image-generation-quality';
import { listRunnableProviderProfiles, selectGenerationProviderProfile, selectReverseProviderProfile } from './provider-profiles';

let hydrationStarted = false;
let hydrationReady: Promise<void> | null = null;
let closeFlushAbortedUnsubscribe: (() => void) | null = null;
let closeFlushUnsubscribe: (() => void) | null = null;
let nativeCloseFlushRequestId: string | null = null;
let mcpRuntimeUnsubscribe: (() => void) | null = null;
let mcpWorkspaceAdapter: McpWorkspaceAdapter | null = null;
let activeMcpProjectId: string | null = null;

export function App() {
  const flushProjectSave = useAppStore((state) => state.flushProjectSave);
  const hydratePersistence = useAppStore((state) => state.hydratePersistence);
  const initializeKnowledge = useAppStore((state) => state.initializeKnowledge);
  const projectId = useAppStore((state) => state.project.id);

  useEffect(() => {
    if (hydrationStarted) return;
    hydrationStarted = true;
    hydrationReady = hydratePersistence().then(() => undefined).catch(() => undefined);
    void initializeKnowledge();
  }, [hydratePersistence, initializeKnowledge]);

  useEffect(() => {
    const previousProjectId = activeMcpProjectId;
    activeMcpProjectId = projectId;
    if (previousProjectId === null || previousProjectId === projectId) return;
    getMcpWorkspaceAdapter().invalidateProject(previousProjectId);
    mcpUiConfirmationStore.clear();
  }, [projectId]);
  useEffect(() => {
    if (closeFlushUnsubscribe !== null) return;
    const lifecycle = window.novusDesktop?.lifecycle;
    if (lifecycle === undefined) return;

    closeFlushAbortedUnsubscribe = lifecycle.subscribeCloseFlushAborted((event) => {
      if (nativeCloseFlushRequestId === event.requestId) {
        nativeCloseFlushRequestId = null;
      }
    });
    closeFlushUnsubscribe = lifecycle.subscribeCloseFlushRequest(async (request) => {
      nativeCloseFlushRequestId = request.requestId;
      try {
        // A native close request must be acknowledged before waiting for
        // hydration. This pauses the native delivery watchdog while the
        // renderer swaps its temporary project for the durable one.
        lifecycle.ackCloseFlush({ requestId: request.requestId, phase: 'decision_requested' });
        // A close request can arrive while the initial durable-project
        // hydration is still replacing the temporary untitled/read-only
        // state. Waiting here prevents that transient state from being
        // mistaken for a failed save and avoids a spurious recovery dialog.
        await hydrationReady;
        lifecycle.ackCloseFlush({ requestId: request.requestId, phase: 'save_started' });
        const state = useAppStore.getState();
        if (isPristineUntitledProject(state)) {
          lifecycle.ackCloseFlush({ requestId: request.requestId, phase: 'completed', outcome: 'saved' });
          return;
        }
        // The main process owns the final session release. Renderer-side
        // preparation only flushes durable state, so a successful ACK cannot
        // race with a second close call or strand an open project session.
        const saved = await state.preparePersistenceForClose();
        const completedState = useAppStore.getState();
        lifecycle.ackCloseFlush({
          requestId: request.requestId,
          phase: 'completed',
          outcome: saved ? 'saved' : 'failed',
          ...(saved || completedState.saveErrorCode === null ? {} : { errorCode: completedState.saveErrorCode }),
        });
      } catch {
        lifecycle.ackCloseFlush({ requestId: request.requestId, phase: 'completed', outcome: 'failed', errorCode: 'CLOSE_SAVE_EXCEPTION' });
      }
    });
  }, []);

  useEffect(() => {
    if (mcpRuntimeUnsubscribe !== null) return;
    const runtime = window.novusDesktop?.mcpRuntime;
    if (runtime === undefined) return;
    const adapter = getMcpWorkspaceAdapter();
    mcpRuntimeUnsubscribe = runtime.onRequest(async ({ requestId, request }) => {
      // Do not accept MCP mutations while the desktop session is still being
      // hydrated. During that window the renderer has an untitled/read-only
      // project and durable writes are rejected as DURABLE_WRITE_FAILED.
      await hydrationReady;
      const response = await adapter.handle(request);
      runtime.respond({ requestId, response });
    });
  }, []);
  useEffect(() => {
    const handleSaveShortcut = (event: KeyboardEvent) => {
      if ((!event.ctrlKey && !event.metaKey) || event.altKey || event.key.toLowerCase() !== 's') return;
      event.preventDefault();
      if (event.repeat) return;
      void useAppStore.getState().saveProjectExplicitly();
    };
    const handleUndoShortcut = (event: KeyboardEvent) => {
      const standardUndo = (event.ctrlKey || event.metaKey) && !event.altKey;
      const alternateUndo = event.altKey && !event.ctrlKey && !event.metaKey;
      if (event.defaultPrevented || (!standardUndo && !alternateUndo) || event.shiftKey || event.key.toLowerCase() !== 'z') return;
      if (event.repeat || isEditableShortcutTarget(event.target)) return;
      event.preventDefault();
      void useAppStore.getState().undo();
    };
    const handleBlur = () => {
      if (nativeCloseFlushRequestId !== null) return;
      void flushProjectSave('blur');
    };
    const handleClose = () => {
      if (window.novusDesktop?.lifecycle !== undefined) return;
      void flushProjectSave('close');
    };
    window.addEventListener('blur', handleBlur);
    window.addEventListener('keydown', handleSaveShortcut);
    window.addEventListener('keydown', handleUndoShortcut);
    window.addEventListener('beforeunload', handleClose);
    window.addEventListener('pagehide', handleClose);
    return () => {
      window.removeEventListener('blur', handleBlur);
      window.removeEventListener('keydown', handleSaveShortcut);
      window.removeEventListener('keydown', handleUndoShortcut);
      window.removeEventListener('beforeunload', handleClose);
      window.removeEventListener('pagehide', handleClose);
    };
  }, [flushProjectSave]);

  return (
    <RendererErrorBoundary>
      <CanvasWorkspace />
    </RendererErrorBoundary>
  );
}

function isPristineUntitledProject(state: ReturnType<typeof useAppStore.getState>): boolean {
  return state.projectLifecycle === 'untitled'
    && state.project.name === '未命名画布'
    && state.project.nodes.length === 0
    && state.project.edges.length === 0
    && state.project.projectMemory.length === 0
    && state.project.skillPromotionCandidates.length === 0
    && state.projectImages.length === 0
    && state.projectVideos.length === 0
    && state.undoStack.length === 0
    && !state.recoveryRequired;
}

function isEditableShortcutTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('input, textarea, select, [contenteditable="true"], [contenteditable="plaintext-only"]') !== null;
}

interface RendererErrorBoundaryState {
  readonly failed: boolean;
  readonly summary: string;
}

class RendererErrorBoundary extends Component<
  { readonly children: ReactNode },
  RendererErrorBoundaryState
> {
  state: RendererErrorBoundaryState = { failed: false, summary: '' };

  static getDerivedStateFromError(error: unknown): RendererErrorBoundaryState {
    return { failed: true, summary: sanitizeRendererError(error) };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Canvas renderer failed', error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="renderer-failure" role="alert">
        <section className="renderer-failure__panel">
          <h1>界面启动失败</h1>
          <p>画布界面遇到异常。重新加载不会删除已保存的项目。</p>
          <p className="renderer-failure__summary"><strong>错误原因：</strong>{this.state.summary}</p>
          <button type="button" onClick={() => window.location.reload()}>重新加载</button>
        </section>
      </main>
    );
  }
}

function sanitizeRendererError(error: unknown): string {
  const rawMessage = error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : '未知渲染错误';
  const sanitized = rawMessage
    .replace(/\bhttps?:\/\/[^\s"'<>]+/gi, '[链接]')
    .replace(/\b(?:Bearer\s+)?(?:sk|pk|rk|api)[-_][A-Za-z0-9_-]{12,}\b/gi, '[密钥]')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[敏感信息]')
    .replace(/(?:[A-Za-z]:\\|\\\\)(?:[^\\/:*?"<>|\r\n]+\\)*[^\\/:*?"<>|\r\n]*?\.(?:asar|json|jsx?|tsx?|html?|css|map|png|jpe?g|webp|gif|mp4|mov|webm|txt|log|db|sqlite|exe|dll)\b/gi, '[本地路径]')
    .replace(/(?:[A-Za-z]:\\|\\\\)(?:[^\\/:*?"<>|\r\n]+\\)+(?:[^\\/:*?"<>|\s\r\n]+)?/g, '[本地路径]')
    .replace(/\s+/g, ' ')
    .trim();
  return (sanitized || '未知渲染错误').slice(0, 320);
}

export function resetAppHydrationForTests(): void {
  hydrationStarted = false;
  hydrationReady = null;
  nativeCloseFlushRequestId = null;
  closeFlushAbortedUnsubscribe?.();
  closeFlushAbortedUnsubscribe = null;
  closeFlushUnsubscribe?.();
  closeFlushUnsubscribe = null;
  mcpRuntimeUnsubscribe?.();
  mcpRuntimeUnsubscribe = null;
  mcpWorkspaceAdapter = null;
  activeMcpProjectId = null;
  mcpUiConfirmationStore.clear();
  resetMcpCanvasSelection();
}

function getMcpWorkspaceAdapter(): McpWorkspaceAdapter {
  if (mcpWorkspaceAdapter !== null) return mcpWorkspaceAdapter;
  const providerBridgeAvailable = window.novusDesktop?.provider !== undefined;
  mcpWorkspaceAdapter = createMcpWorkspaceAdapter({
    getProject: () => useAppStore.getState().project,
    getRevision: () => useAppStore.getState().desktopRevision,
    getSelection: getMcpCanvasSelection,
    getJobs: listMcpWorkspaceJobs,
    commitProjectTransaction: (transaction) => useAppStore.getState().commitProjectTransaction(transaction, { kind: 'agent' }),
    ...(providerBridgeAvailable ? { resolvePaidJobRoute: resolveMcpPaidJobRoute } : {}),
    runNode: runMcpCanvasNode,
    cancelJob: cancelMcpCanvasJob,
    requestMediaImport: requestMcpMediaImport,
  }, undefined, { getPermissions: readMcpPermissions });
  return mcpWorkspaceAdapter;
}

export async function resolveMcpPaidJobRoute(node: CanvasModuleNode): Promise<McpPaidJobRoute | undefined> {
  const bridge = window.novusDesktop?.provider;
  if (bridge === undefined) return undefined;
  const profiles = await listRunnableProviderProfiles(bridge);
  const provider = readMcpGenerationProvider(node.data.config.providerDisplayName);
  const modelRoute = readConfigString(node.data.config, 'modelRoute') || undefined;
  const modelDisplayName = readConfigString(node.data.config, 'modelDisplayName')
    || readConfigString(node.data.config, 'routeDisplayName')
    || undefined;

  if (node.data.moduleType === 'image_generation' || node.data.moduleType === 'video_generation') {
    const profile = selectGenerationProviderProfile(profiles, {
      provider,
      modelRoute,
      modelDisplayName,
    }, node.data.moduleType);
    return profile === undefined ? undefined : { provider: profile.provider, modelRoute: profile.modelRoute };
  }
  if (node.data.moduleType !== 'reverse_agent') return undefined;

  const profile = selectReverseProviderProfile(profiles, { provider, modelRoute });
  return profile === undefined ? undefined : { provider: profile.provider, modelRoute: profile.modelRoute };
}

function readMcpGenerationProvider(value: unknown): ProviderBridgeProfile['provider'] | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLocaleLowerCase();
  return normalized === 'comfly' || normalized === 'relayme' || normalized === 'julun' || normalized === '4dai'
    ? normalized
    : undefined;
}

export function listMcpWorkspaceJobs(): McpWorkspaceJobSummary[] {
  const state = useAppStore.getState();
  const projectModelJobs = filterModelJobsForProject(state.modelJobs, state.project, getActiveProjectSessionId());
  const modelJobs: McpWorkspaceJobSummary[] = projectModelJobs.map((job) => ({
    id: job.id,
    nodeId: job.promptNodeId,
    status: job.status,
    kind: job.kind,
    ...(job.progress === undefined ? {} : { progress: job.progress }),
    ...(job.provider === undefined ? {} : { provider: job.provider }),
    ...(job.modelRoute === undefined ? {} : { modelRoute: job.modelRoute }),
    ...(job.displayName === undefined ? {} : { displayName: job.displayName }),
    ...(job.error === undefined ? {} : { error: job.error }),
    ...(job.resultAssetId === undefined ? {} : { resultAssetId: job.resultAssetId }),
    ...(job.resultAssetIds === undefined ? {} : { resultAssetIds: [...job.resultAssetIds] }),
    ...(job.resultNodeId === undefined ? {} : { resultNodeId: job.resultNodeId }),
  }));
  const reverseJobs: McpWorkspaceJobSummary[] = state.project.nodes.flatMap((node) => {
    if (node.type !== 'module' || node.data.moduleType !== 'reverse_agent') return [];
    const runId = readConfigString(node.data.config, 'reverseAgentRunId');
    if (!runId) return [];
    const runState = readConfigString(node.data.config, 'reverseAgentRunState') || node.data.execution.state;
    return [{
      id: runId,
      nodeId: node.id,
      kind: 'reverse' as const,
      status: runState,
      ...(readConfigString(node.data.config, 'modelRoute') ? { modelRoute: readConfigString(node.data.config, 'modelRoute') } : {}),
      displayName: 'Agent 反推',
      ...(readConfigString(node.data.config, 'reverseAgentError') ? { error: readConfigString(node.data.config, 'reverseAgentError') } : {}),
      ...((runState === 'completed' || runState === 'failed' || runState === 'cancelled') ? { resultNodeId: node.id } : {}),
    }];
  });
  return [...modelJobs, ...reverseJobs];
}

export async function runMcpCanvasNode(
  nodeId: string,
  executionRoute?: McpPaidJobExecutionRoute,
): Promise<McpWorkspaceRunResult> {
  const state = useAppStore.getState();
  if (executionRoute !== undefined && (
    state.project.id !== executionRoute.projectId
    || state.desktopRevision !== executionRoute.expectedRevision
  )) {
    throw new Error('Canvas changed after the paid model route was confirmed');
  }
  const node = state.project.nodes.find((candidate) => candidate.id === nodeId && candidate.type === 'module');
  if (node?.type !== 'module') return { started: false, jobIds: [] };
  const config = node.data.config;
  if (node.data.moduleType === 'image_generation') {
    const prompt = readConfigString(config, 'prompt');
    if (!prompt) return { started: false, jobIds: [] };
    const before = new Set(state.modelJobs.map((job) => job.id));
    const started = await state.runImageGenerationNode(nodeId, {
      prompt,
      modelRoute: executionRoute?.modelRoute ?? (readConfigString(config, 'modelRoute') || undefined),
      aspectRatio: readConfigString(config, 'aspectRatio') || undefined,
      resolution: readConfigString(config, 'resolution') || undefined,
      ...(normalizeImageQuality(config.imageQuality) === undefined
        ? {}
        : { imageQuality: normalizeImageQuality(config.imageQuality) }),
      imageOutputFormat: normalizeImageOutputFormat(config.imageOutputFormat),
      imageBackground: normalizeImageBackground(config.imageBackground),
      outputCount: config.outputCount === 9 ? 9 : readOutputCount(config.outputCount),
      referenceAssetIds: readStringList(config.referenceAssetIds),
      ...(executionRoute === undefined ? {} : { executionRoute }),
    });
    return started
      ? { started: true, jobIds: newlyCreatedJobIds(nodeId, before) }
      : { started: false, jobIds: [] };
  }
  if (node.data.moduleType === 'video_generation') {
    const prompt = readConfigString(config, 'prompt');
    if (!prompt) return { started: false, jobIds: [] };
    const before = new Set(state.modelJobs.map((job) => job.id));
    const started = await state.runVideoPreviewNode(nodeId, {
      prompt,
      referenceAssetIds: readStringList(config.referenceAssetIds),
      modelRoute: executionRoute?.modelRoute ?? (readConfigString(config, 'modelRoute') || undefined),
      aspectRatio: readConfigString(config, 'aspectRatio') || '16:9',
      keyframe: readConfigString(config, 'keyframe') || 'first-frame',
      durationSeconds: readPositiveNumber(config.durationSeconds, 5),
      resolution: readConfigString(config, 'resolution') || '1080p',
      outputCount: readOutputCount(config.outputCount) ?? 1,
      audioEnabled: config.audioEnabled === true,
      ...(executionRoute === undefined ? {} : { executionRoute }),
    });
    return started
      ? { started: true, jobIds: newlyCreatedJobIds(nodeId, before) }
      : { started: false, jobIds: [] };
  }
  if (node.data.moduleType === 'reverse_agent') {
    const startingProjectId = state.project.id;
    const previousRunId = readConfigString(config, 'reverseAgentRunId');
    let rejected = false;
    void state.runReverseAgentNode(nodeId, undefined, executionRoute).catch(() => { rejected = true; });
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const currentState = useAppStore.getState();
      if (currentState.project.id !== startingProjectId) {
        return { started: false, jobIds: [] };
      }
      const current = currentState.project.nodes.find((candidate) => candidate.id === nodeId && candidate.type === 'module');
      const runId = current?.type === 'module' ? readConfigString(current.data.config, 'reverseAgentRunId') : '';
      const runState = current?.type === 'module' ? readConfigString(current.data.config, 'reverseAgentRunState') : '';
      if (current?.type === 'module'
        && current.data.moduleType === 'reverse_agent'
        && runId
        && runId !== previousRunId
        && (runState === 'running'
          || runState === 'completed'
          || runState === 'failed'
          || runState === 'cancelled')) {
        return { started: true, jobIds: [runId] };
      }
      if (rejected) return { started: false, jobIds: [] };
      await delay(25);
    }
    return { started: false, jobIds: [] };
  }
  return { started: false, jobIds: [] };
}

export async function cancelMcpCanvasJob(jobId: string): Promise<void> {
  const reverseNode = useAppStore.getState().project.nodes.find((node) => (
    node.type === 'module'
    && node.data.moduleType === 'reverse_agent'
    && readConfigString(node.data.config, 'reverseAgentRunId') === jobId
  ));
  if (reverseNode?.type === 'module') {
    if (!await useAppStore.getState().cancelReverseAgentNode(reverseNode.id)) throw new Error('Reverse Agent job could not be cancelled.');
    return;
  }
  if (!listMcpWorkspaceJobs().some((job) => job.id === jobId && job.kind !== 'reverse')) {
    throw new Error('Model job not found in the active canvas.');
  }
  await useAppStore.getState().cancelModelJob(jobId);
}

function newlyCreatedJobIds(nodeId: string, before: ReadonlySet<string>): string[] {
  return useAppStore.getState().modelJobs
    .filter((job) => job.promptNodeId === nodeId && !before.has(job.id))
    .map((job) => job.id);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function requestMcpMediaImport(kind: 'image' | 'video', position: { readonly x: number; readonly y: number }): Promise<boolean> {
  if (!await waitForInteractiveDocument(750)) return false;
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = kind === 'image' ? 'image/*' : 'video/*';
  input.hidden = true;
  const removeInput = () => input.remove();
  input.onchange = () => {
    const file = input.files?.[0];
    if (file === undefined) { removeInput(); return; }
    void useAppStore.getState().importDroppedMedia(file, position).finally(removeInput);
  };
  input.addEventListener('cancel', removeInput, { once: true });
  document.body.append(input);
  try {
    input.click();
    return true;
  } catch {
    removeInput();
    return false;
  }
}

async function waitForInteractiveDocument(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (document.visibilityState !== 'visible' || !document.hasFocus()) {
    if (Date.now() >= deadline) return false;
    await delay(25);
  }
  return true;
}

function readConfigString(config: Readonly<Record<string, unknown>>, key: string): string {
  const value = config[key];
  return typeof value === 'string' ? value.trim() : '';
}

function readStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0).slice(0, 20) : [];
}

function readOutputCount(value: unknown): 1 | 2 | 3 | 4 | undefined {
  return value === 1 || value === 2 || value === 3 || value === 4 ? value : undefined;
}

function readPositiveNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}
