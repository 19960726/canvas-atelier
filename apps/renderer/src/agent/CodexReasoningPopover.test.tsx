import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CodexReasoningEffort } from '@agent-canvas/desktop-core';
import { CodexReasoningPopover } from './CodexReasoningPopover';

afterEach(cleanup);

function Control({ efforts, defaultValue = 'medium' }: { efforts: readonly CodexReasoningEffort[]; defaultValue?: CodexReasoningEffort }) {
  const [value, setValue] = useState<CodexReasoningEffort>('medium');
  return <CodexReasoningPopover modelLabel="GPT-6 Astra" efforts={efforts} value={value} defaultValue={defaultValue}
    onChange={setValue} open onToggle={vi.fn()} onClose={vi.fn()} onSelectModel={vi.fn()} />;
}

describe('CodexReasoningPopover', () => {
  it('orders a sparse catalog and keeps Max distinct from Ultra', () => {
    render(<Control efforts={['ultra', 'max', 'low', 'xhigh', 'high', 'medium', 'ultra']} />);
    const slider = screen.getByRole('slider');
    expect(slider).toHaveAttribute('max', '5');
    fireEvent.change(slider, { target: { value: '3' } });
    expect(slider).toHaveAttribute('aria-valuetext', '极高');
    fireEvent.change(slider, { target: { value: '4' } });
    expect(slider).toHaveAttribute('aria-valuetext', 'Max');
    fireEvent.change(slider, { target: { value: '5' } });
    expect(slider).toHaveAttribute('aria-valuetext', 'Ultra');
    fireEvent.click(screen.getByRole('button', { name: '恢复默认思考能力' }));
    expect(slider).toHaveAttribute('aria-valuetext', '中');
  });

  it('disables unavailable or single-level catalogs without making up selectable stops', () => {
    const view = render(<Control efforts={[]} />);
    expect(screen.getByRole('button', { name: '思考能力：不可用' })).toBeDisabled();
    expect(screen.getByRole('slider')).toBeDisabled();
    expect(screen.getByRole('button', { name: '恢复默认思考能力' })).toBeDisabled();
    view.rerender(<Control efforts={['high']} />);
    expect(screen.getByRole('slider')).toBeDisabled();
    expect(screen.getByRole('slider')).toHaveAttribute('aria-valuetext', '高');
  });
});
