import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMcpUiConfirmationStore } from '../app/mcp-ui-confirmation-store';
import { McpWorkflowPlanPreview } from './McpWorkflowPlanPreview';

afterEach(cleanup);

describe('McpWorkflowPlanPreview', () => {
  it('shows a workflow summary and confirms through the shared one-time gate', () => {
    const store = createMcpUiConfirmationStore();
    const confirm = vi.fn(() => ({ token: 'grant-1', expiresAt: 301_000 }));
    store.publish({
      id: 'plan-1', kind: 'workflow', title: 'Build image workflow', projectId: 'project-1', expectedRevision: 4,
      mutations: [
        { kind: 'create_node', nodeId: 'image-2', moduleType: 'image_generation', position: { x: 100, y: 200 } },
        { kind: 'connect_nodes', edgeId: 'edge-2', sourceNodeId: 'prompt-1', sourcePortId: 'prompt', targetNodeId: 'image-2', targetPortId: 'prompt' },
      ],
      paidJobs: [{ nodeId: 'image-2', jobKind: 'image', modelRoute: 'image-default' }],
      limitations: [],
    }, { confirm, reject: vi.fn() });

    render(<McpWorkflowPlanPreview store={store} />);

    expect(screen.getByRole('dialog', { name: 'MCP 工作流确认' })).toHaveTextContent('Build image workflow');
    const dialog = screen.getByRole('dialog', { name: /MCP/u });
    expect(dialog.textContent).toMatch(/2.*1/u);
    fireEvent.click(screen.getByRole('button', { name: '确认 MCP 工作流' }));
    expect(confirm).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog', { name: 'MCP 工作流确认' })).toBeNull();
  });

  it('keeps paid execution as a separate confirmation and supports rejection', () => {
    const store = createMcpUiConfirmationStore();
    const reject = vi.fn();
    store.publish({
      id: 'paid-1', kind: 'paid_job', title: 'Run video generation', projectId: 'project-1', expectedRevision: 4,
      nodeId: 'video-1', jobKind: 'video', modelRoute: 'video-default',
    }, { confirm: vi.fn(() => ({ token: 'paid-grant', expiresAt: 125_000 })), reject });

    render(<McpWorkflowPlanPreview store={store} />);
    expect(screen.getByRole('dialog', { name: 'MCP 付费任务确认' })).toHaveTextContent('video-default');
    fireEvent.click(screen.getByRole('button', { name: '拒绝 MCP 请求' }));
    expect(reject).toHaveBeenCalledOnce();
  });
});