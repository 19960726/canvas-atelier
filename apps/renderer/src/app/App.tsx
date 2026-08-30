import { Component, useEffect, type ErrorInfo, type ReactNode } from 'react';
import { CanvasWorkspace } from '../canvas/CanvasWorkspace';
import { useAppStore } from './app-store';
import { getMcpCanvasSelection, resetMcpCanvasSelection } from './mcp-canvas-selection';
import { createMcpWorkspaceAdapter, type McpWorkspaceAdapter } from './mcp-workspace-adapter';
import { mcpUiConfirmationStore } from './mcp-ui-confirmation-store';

let hydrationStarted = false;
let closeFlushUnsubscribe: (() => void) | null = null;
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
    void hydratePersistence();
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

    closeFlushUnsubscribe = lifecycle.subscribeCloseFlushRequest(async (request) => {
      try {
        const state = useAppStore.getState();
        if (state.projectLifecycle === 'untitled' && state.saveStatus === 'saved') {
          lifecycle.ackCloseFlush({ requestId: request.requestId, phase: 'save_started' });
          lifecycle.ackCloseFlush({ requestId: request.requestId, phase: 'completed', outcome: 'saved' });
          return;
        }
        lifecycle.ackCloseFlush({ requestId: request.requestId, phase: 'save_started' });
        const saved = await state.closePersistence();
        lifecycle.ackCloseFlush({
          requestId: request.requestId,
          phase: 'completed',
          outcome: saved ? 'saved' : 'failed',
        });
      } catch {
        lifecycle.ackCloseFlush({ requestId: request.requestId, phase: 'completed', outcome: 'failed' });
      }
    });
  }, []);

  useEffect(() => {
    if (mcpRuntimeUnsubscribe !== null) return;
    const runtime = window.novusDesktop?.mcpRuntime;
    if (runtime === undefined) return;
    const adapter = getMcpWorkspaceAdapter();
    mcpRuntimeUnsubscribe = runtime.onRequest(async ({ requestId, request }) => {
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
      if (event.defaultPrevented || (!event.ctrlKey && !event.metaKey) || event.altKey || event.key.toLowerCase() !== 'z') return;
      if (event.repeat || isEditableShortcutTarget(event.target)) return;
      event.preventDefault();
      void useAppStore.getState().undo();
    };
    const handleBlur = () => {
      void flushProjectSave('blur');
    };
    const handleClose = () => {
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
  mcpWorkspaceAdapter = createMcpWorkspaceAdapter({
    getProject: () => useAppStore.getState().project,
    getRevision: () => useAppStore.getState().desktopRevision,
    getSelection: getMcpCanvasSelection,
    getJobs: () => useAppStore.getState().modelJobs.map((job) => ({
      id: job.id,
      nodeId: job.promptNodeId,
      status: job.status,
      ...(job.progress === undefined ? {} : { progress: job.progress }),
    })),
    commitProjectTransaction: (transaction) => useAppStore.getState().commitProjectTransaction(transaction, { kind: 'agent' }),
    runNode: runMcpCanvasNode,
    cancelJob: (jobId) => useAppStore.getState().cancelModelJob(jobId),
    requestMediaImport: requestMcpMediaImport,
  });
  return mcpWorkspaceAdapter;
}

async function runMcpCanvasNode(nodeId: string): Promise<boolean> {
  const state = useAppStore.getState();
  const node = state.project.nodes.find((candidate) => candidate.id === nodeId && candidate.type === 'module');
  if (node?.type !== 'module') return false;
  const config = node.data.config;
  if (node.data.moduleType === 'image_generation') {
    const prompt = readConfigString(config, 'prompt');
    if (!prompt) return false;
    return state.runImageGenerationNode(nodeId, {
      prompt,
      modelRoute: readConfigString(config, 'modelRoute') || undefined,
      aspectRatio: readConfigString(config, 'aspectRatio') || undefined,
      resolution: readConfigString(config, 'resolution') || undefined,
      outputCount: readOutputCount(config.outputCount),
      referenceAssetIds: readStringList(config.referenceAssetIds),
    });
  }
  if (node.data.moduleType === 'video_generation') {
    const prompt = readConfigString(config, 'prompt');
    if (!prompt) return false;
    return state.runVideoPreviewNode(nodeId, {
      prompt,
      referenceAssetIds: readStringList(config.referenceAssetIds),
      modelRoute: readConfigString(config, 'modelRoute') || undefined,
      aspectRatio: readConfigString(config, 'aspectRatio') || '16:9',
      keyframe: readConfigString(config, 'keyframe') || 'first-frame',
      durationSeconds: readPositiveNumber(config.durationSeconds, 5),
      resolution: readConfigString(config, 'resolution') || '1080p',
      outputCount: readOutputCount(config.outputCount) ?? 1,
      audioEnabled: config.audioEnabled === true,
    });
  }
  if (node.data.moduleType === 'reverse_agent') {
    try {
      await state.runReverseAgentNode(nodeId);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

function requestMcpMediaImport(kind: 'image' | 'video', position: { readonly x: number; readonly y: number }): Promise<void> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = kind === 'image' ? 'image/*' : 'video/*';
    input.onchange = () => {
      const file = input.files?.[0];
      if (file === undefined) { resolve(); return; }
      void useAppStore.getState().importDroppedMedia(file, position).finally(resolve);
    };
    input.click();
  });
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
