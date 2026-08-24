import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it, vi } from 'vitest';
import { AspectRatioPopover, ClarityPopover } from './GenerationParameterPopover';

describe('GenerationParameterPopover', () => {
  it('opens the image ratio choices as an in-node two-column icon menu and closes on outside input', () => {
    const onChange = vi.fn();
    render(<div><AspectRatioPopover ariaLabel="Image generation aspect ratio" value="3:4" options={['AUTO', '1:1', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9']} onChange={onChange} /></div>);

    const trigger = screen.getByRole('button', { name: 'Image generation aspect ratio' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(trigger);

    const menu = screen.getByRole('menu', { name: 'Image generation aspect ratio options' });
    expect(menu).toHaveAttribute('data-layout', 'ratio-grid');
    expect(screen.getAllByRole('menuitemradio')).toHaveLength(8);
    expect(screen.getByRole('menuitemradio', { name: '3:4' })).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(screen.getByRole('menuitemradio', { name: '16:9' }));
    expect(onChange).toHaveBeenCalledWith('16:9');
    expect(screen.queryByRole('menu', { name: 'Image generation aspect ratio options' })).toBeNull();

    fireEvent.click(trigger);
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('menu', { name: 'Image generation aspect ratio options' })).toBeNull();
  });

  it('opens image clarity as a compact 2K 4K list with a selected check', () => {
    const onChange = vi.fn();
    render(<ClarityPopover ariaLabel="Image generation resolution" value="4K" options={['2K', '4K']} onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: 'Image generation resolution' }));
    const menu = screen.getByRole('menu', { name: 'Image generation resolution options' });
    expect(menu).toHaveAttribute('data-layout', 'clarity-list');
    expect(screen.getByRole('menuitemradio', { name: '4K' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('generation-option-check')).toBeVisible();

    fireEvent.click(screen.getByRole('menuitemradio', { name: '2K' }));
    expect(onChange).toHaveBeenCalledWith('2K');
  });

  it('uses the same controls for video ratio and clarity', () => {
    render(<>
      <AspectRatioPopover ariaLabel="Video preview aspect ratio" value="AUTO" options={['AUTO', '1:1', '16:9']} onChange={vi.fn()} />
      <ClarityPopover ariaLabel="Video preview resolution" value="720p" options={['480p', '720p', '1080p']} onChange={vi.fn()} />
    </>);

    expect(screen.getByRole('button', { name: 'Video preview aspect ratio' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Video preview resolution' })).toHaveTextContent('720P');
  });
});
