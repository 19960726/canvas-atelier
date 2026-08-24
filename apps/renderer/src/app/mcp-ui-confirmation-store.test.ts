import { describe, expect, it, vi } from 'vitest';

import { createMcpUiConfirmationStore } from './mcp-ui-confirmation-store';

describe('MCP UI confirmation store', () => {
  it('publishes one bounded request, confirms it once, and removes it from the visible queue', () => {
    const confirm = vi.fn(() => ({ token: 'workflow-grant-1', expiresAt: 301_000 }));
    const reject = vi.fn();
    const store = createMcpUiConfirmationStore();
    const listener = vi.fn();
    store.subscribe(listener);

    store.publish({
      id: 'plan-1', kind: 'workflow', title: 'Build product workflow', projectId: 'project-1', expectedRevision: 4,
      mutations: [{ kind: 'move_nodes', positions: [{ nodeId: 'node-1', x: 20, y: 30 }] }],
      paidJobs: [], limitations: [],
    }, { confirm, reject });

    expect(store.getSnapshot()).toHaveLength(1);
    expect(store.confirm('plan-1')).toEqual({ token: 'workflow-grant-1', expiresAt: 301_000 });
    expect(confirm).toHaveBeenCalledOnce();
    expect(store.getSnapshot()).toEqual([]);
    expect(() => store.confirm('plan-1')).toThrow('MCP_UI_CONFIRMATION_NOT_FOUND');
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('rejects a pending paid request without issuing a grant', () => {
    const confirm = vi.fn();
    const reject = vi.fn();
    const store = createMcpUiConfirmationStore();
    store.publish({
      id: 'paid-1', kind: 'paid_job', title: 'Run image generation', projectId: 'project-1', expectedRevision: 4,
      nodeId: 'image-1', jobKind: 'image', modelRoute: 'image-default',
    }, { confirm, reject });

    store.reject('paid-1');
    expect(reject).toHaveBeenCalledOnce();
    expect(confirm).not.toHaveBeenCalled();
    expect(store.getSnapshot()).toEqual([]);
  });
});