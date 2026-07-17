import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it, vi } from 'vitest';
import { ModuleLibrary, MODULE_DRAG_MIME } from './ModuleLibrary';

describe('ModuleLibrary', () => {
  it('filters by display name and alias and creates by keyboard', () => {
    const onCreate = vi.fn();
    render(<ModuleLibrary onCreate={onCreate} />);

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search modules' }), { target: { value: 'pose' } });

    expect(screen.getByRole('button', { name: 'Add OpenPose' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Add Text Prompt' })).toBeNull();

    fireEvent.keyDown(screen.getByRole('button', { name: 'Add OpenPose' }), { key: 'Enter' });

    expect(onCreate).toHaveBeenCalledWith('openpose');
  });

  it('writes only the module type to the drag payload', () => {
    const setData = vi.fn();
    render(<ModuleLibrary onCreate={vi.fn()} />);

    fireEvent.dragStart(screen.getByRole('button', { name: 'Add Text Prompt' }), {
      dataTransfer: { setData, effectAllowed: 'none' },
    });

    expect(setData).toHaveBeenCalledWith(MODULE_DRAG_MIME, 'text_prompt');
    expect(JSON.stringify(setData.mock.calls)).not.toMatch(/path|token|Authorization|base64/i);
  });
});
