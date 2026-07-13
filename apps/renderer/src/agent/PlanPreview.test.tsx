import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentCanvasPlan } from '@agent-canvas/domain';
import { PlanPreview } from './PlanPreview';

const plan: AgentCanvasPlan = {
  id: 'plan-1',
  state: 'waiting_for_confirmation',
  transaction: {
    id: 'tx-1',
    label: 'Agent 创建方案',
    operations: [{
      kind: 'create_node',
      node: {
        id: 'review-1',
        type: 'review',
        position: { x: 320, y: 220 },
        data: { keep: ['产品身份'], change: ['背景'], never: ['修改 Logo'] },
      },
    }],
  },
  requestedCapabilities: ['model_execution'],
  confirmations: {},
  conflicts: [],
  modelRoute: 'comfly/image',
  jobCount: 1,
};

afterEach(() => cleanup());

describe('PlanPreview', () => {
  it('shows operations, model route, and explicit model confirmation', () => {
    const onConfirm = vi.fn();
    render(<PlanPreview plan={plan} onConfirm={onConfirm} onCancel={() => {}} />);

    expect(screen.getByText('创建审核节点')).toBeInTheDocument();
    expect(screen.getByText('comfly/image')).toBeInTheDocument();
    expect(screen.getByText('1 个模型任务')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('确认模型执行'));
    fireEvent.click(screen.getByRole('button', { name: '确认执行' }));
    expect(onConfirm).toHaveBeenCalledWith({ models: true, deleteNodes: false, skillWriteback: false });
  });

  it('cancels the proposed plan without applying it', () => {
    const onCancel = vi.fn();
    render(<PlanPreview plan={plan} onConfirm={() => {}} onCancel={onCancel} />);

    fireEvent.click(screen.getByRole('button', { name: '取消方案' }));
    expect(onCancel).toHaveBeenCalledOnce();
  });
  it('shows separate approvals for deletion and Skill writeback', () => {
    const onConfirm = vi.fn();
    render(<PlanPreview plan={{ ...plan, requestedCapabilities: ['delete_nodes', 'skill_writeback'] }} onConfirm={onConfirm} onCancel={() => {}} />);

    expect(screen.getByRole('button', { name: '确认执行' })).toBeDisabled();
    fireEvent.click(screen.getByLabelText('确认删除节点'));
    fireEvent.click(screen.getByLabelText('确认 Skill 写回'));
    fireEvent.click(screen.getByRole('button', { name: '确认执行' }));

    expect(onConfirm).toHaveBeenCalledWith({ models: false, deleteNodes: true, skillWriteback: true });
  });
  it('shows deletion approval when the transaction contains delete_node even if capability metadata is missing', () => {
    render(<PlanPreview plan={{
      ...plan,
      requestedCapabilities: [],
      transaction: { id: 'delete-tx', label: '删除', operations: [{ kind: 'delete_node', nodeId: 'old-node' }] },
    }} onConfirm={() => {}} onCancel={() => {}} />);

    expect(screen.getByLabelText('确认删除节点')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '确认执行' })).toBeDisabled();
  });
  it('resets approvals when a different plan replaces the current plan', () => {
    const { rerender } = render(<PlanPreview plan={plan} onConfirm={() => {}} onCancel={() => {}} />);
    fireEvent.click(screen.getByLabelText('确认模型执行'));
    expect(screen.getByLabelText('确认模型执行')).toBeChecked();

    rerender(<PlanPreview plan={{ ...plan, id: 'plan-2' }} onConfirm={() => {}} onCancel={() => {}} />);
    expect(screen.getByLabelText('确认模型执行')).not.toBeChecked();
  });

  it('shows deletion approval for delete_edge operations', () => {
    render(<PlanPreview plan={{ ...plan, requestedCapabilities: [], transaction: { id: 'edge-delete', label: '删除连线', operations: [{ kind: 'delete_edge', edgeId: 'edge-1' }] } }} onConfirm={() => {}} onCancel={() => {}} />);
    expect(screen.getByLabelText('确认删除节点')).toBeInTheDocument();
  });
});