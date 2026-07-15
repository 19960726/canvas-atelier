import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OrderedReference } from '@agent-canvas/domain';
import { ImageMentionComposer } from './ImageMentionComposer';

afterEach(() => cleanup());

const duplicateLabels: OrderedReference[] = [
  { assetId: 'product', label: 'Hero image', role: 'product_identity', position: 0 },
  { assetId: 'scene', label: 'Hero image', role: 'scene_composition', position: 1 },
];

describe('ImageMentionComposer', () => {
  it('adds a structured citation and disambiguates duplicate labels', () => {
    const onChange = vi.fn();
    render(<ImageMentionComposer references={duplicateLabels} value={{ text: '', citations: [] }} onChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: 'Mention image' }));

    expect(screen.getByText('Hero image (product)')).toBeVisible();
    expect(screen.getByText('Hero image (scene)')).toBeVisible();
    fireEvent.click(screen.getByText('Hero image (scene)'));

    expect(onChange).toHaveBeenCalledWith({
      text: '@Hero image',
      citations: [{ assetId: 'scene', label: 'Hero image' }],
    });
  });

  it('does not duplicate an asset citation and drops citations removed from text', () => {
    const onChange = vi.fn();
    const view = render(<ImageMentionComposer
      references={duplicateLabels}
      value={{ text: '@Hero image', citations: [{ assetId: 'scene', label: 'Hero image' }] }}
      onChange={onChange}
    />);

    fireEvent.click(screen.getByRole('button', { name: 'Mention image' }));
    fireEvent.click(screen.getByText('Hero image (scene)'));
    expect(onChange).not.toHaveBeenCalled();

    view.rerender(<ImageMentionComposer
      references={duplicateLabels}
      value={{ text: '@Hero image', citations: [{ assetId: 'scene', label: 'Hero image' }, { assetId: 'unknown', label: 'Unknown' }] }}
      onChange={onChange}
    />);
    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: 'Use a clean layout' } });

    expect(onChange).toHaveBeenLastCalledWith({ text: 'Use a clean layout', citations: [] });
  });

  it('removes a citation when a mention is edited into a longer partial token', () => {
    const onChange = vi.fn();
    render(<ImageMentionComposer
      references={duplicateLabels}
      value={{ text: '@Hero image', citations: [{ assetId: 'scene', label: 'Hero image' }] }}
      onChange={onChange}
    />);

    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: '@Hero image2' } });

    expect(onChange).toHaveBeenCalledWith({ text: '@Hero image2', citations: [] });
  });

  it('keeps only as many duplicate-label citations as explicit token occurrences', () => {
    const onChange = vi.fn();
    render(<ImageMentionComposer
      references={duplicateLabels}
      value={{
        text: '@Hero image @Hero image',
        citations: [
          { assetId: 'product', label: 'Hero image' },
          { assetId: 'scene', label: 'Hero image' },
        ],
      }}
      onChange={onChange}
    />);

    fireEvent.change(screen.getByRole('textbox', { name: 'Message' }), { target: { value: '@Hero image' } });

    expect(onChange).toHaveBeenCalledWith({
      text: '@Hero image',
      citations: [{ assetId: 'product', label: 'Hero image' }],
    });
  });
});
