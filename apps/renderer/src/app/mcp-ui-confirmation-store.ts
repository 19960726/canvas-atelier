import type { CanvasWorkflowMutation } from '@agent-canvas/domain';
import type { McpConfirmationGrant } from './mcp-confirmation-store';

export type McpUiConfirmationRequest = {
  readonly id: string;
  readonly projectId: string;
  readonly expectedRevision: number;
  readonly title: string;
} & (
  | {
    readonly kind: 'workflow';
    readonly mutations: readonly CanvasWorkflowMutation[];
    readonly paidJobs: readonly { readonly nodeId: string; readonly jobKind: 'image' | 'video' | 'reverse'; readonly modelRoute: string }[];
    readonly limitations: readonly string[];
  }
  | {
    readonly kind: 'paid_job';
    readonly nodeId: string;
    readonly jobKind: 'image' | 'video' | 'reverse';
    readonly modelRoute: string;
  }
);

type ConfirmationHandlers = {
  readonly confirm: () => McpConfirmationGrant;
  readonly reject: () => void;
};

export interface McpUiConfirmationStore {
  getSnapshot(): readonly McpUiConfirmationRequest[];
  subscribe(listener: () => void): () => void;
  publish(request: McpUiConfirmationRequest, handlers: ConfirmationHandlers): void;
  confirm(id: string): McpConfirmationGrant;
  reject(id: string): void;
  dismiss(id: string): void;
  clear(): void;
}

export function createMcpUiConfirmationStore(): McpUiConfirmationStore {
  let requests: readonly McpUiConfirmationRequest[] = [];
  const handlers = new Map<string, ConfirmationHandlers>();
  const listeners = new Set<() => void>();
  const emit = () => { for (const listener of listeners) listener(); };
  const remove = (id: string) => {
    if (!handlers.has(id)) return false;
    handlers.delete(id);
    requests = requests.filter((request) => request.id !== id);
    emit();
    return true;
  };

  return {
    getSnapshot: () => requests,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    publish(request, nextHandlers) {
      const exists = handlers.has(request.id);
      handlers.set(request.id, nextHandlers);
      requests = exists
        ? requests.map((item) => item.id === request.id ? cloneRequest(request) : item)
        : [...requests, cloneRequest(request)];
      emit();
    },
    confirm(id) {
      const entry = handlers.get(id);
      if (!entry) throw new Error('MCP_UI_CONFIRMATION_NOT_FOUND');
      remove(id);
      return entry.confirm();
    },
    reject(id) {
      const entry = handlers.get(id);
      if (!entry) throw new Error('MCP_UI_CONFIRMATION_NOT_FOUND');
      remove(id);
      entry.reject();
    },
    dismiss(id) { remove(id); },
    clear() {
      if (requests.length === 0 && handlers.size === 0) return;
      requests = [];
      handlers.clear();
      emit();
    },
  };
}

export const mcpUiConfirmationStore = createMcpUiConfirmationStore();

function cloneRequest(request: McpUiConfirmationRequest): McpUiConfirmationRequest {
  return JSON.parse(JSON.stringify(request)) as McpUiConfirmationRequest;
}