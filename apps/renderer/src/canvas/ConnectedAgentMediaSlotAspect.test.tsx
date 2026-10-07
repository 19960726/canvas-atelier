import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectedAgentMediaSlots, type ConnectedAgentMediaSlotItem } from './ConnectedAgentMediaSlots';

afterEach(cleanup);

const image = (assetId: string, width?: number, height?: number): ConnectedAgentMediaSlotItem => ({
  edgeId: `edge-${assetId}`, kind: 'image', assetId, label: assetId,
  previewUrl: `novus-asset://current/${assetId}`, width, height,
});

function slotSize(index: number) {
  const element = screen.getByLabelText(`Agent media slot ${index}`);
  return [element.style.getPropertyValue('--media-slot-width'), element.style.getPropertyValue('--media-slot-height')];
}

describe('connected media use uniform frames and preserve complete images', () => {
  it('uses the same frame for portrait, landscape and square assets', () => {
    render(<ConnectedAgentMediaSlots ariaLabel="Inputs" media={[
      image('portrait', 1200, 1800), image('landscape', 1600, 900), image('square', 900, 900),
    ]} />);
    expect(screen.getByLabelText('Inputs')).toHaveAttribute('data-thumbnail-sizing', 'uniform');
    for (let index = 1; index <= 3; index++) expect(slotSize(index)).toEqual(['', '']);
  });

  it('does not resize a video frame from its owned dimensions', () => {
    render(<ConnectedAgentMediaSlots ariaLabel="Inputs" media={[
      { edgeId: 'video-edge', kind: 'video', assetId: 'video', label: 'Video', previewUrl: 'novus-video://current/video', width: 1920, height: 1080 },
    ]} />);
    expect(screen.getByLabelText('Inputs')).toHaveAttribute('data-thumbnail-sizing', 'uniform');
    expect(slotSize(1)).toEqual(['', '']);
    expect(screen.getByLabelText('Video 视频封面')).toHaveAttribute('src', 'novus-video://current/video');
  });

  it('keeps extreme panoramas and tall images in the same interaction frame', () => {
    render(<ConnectedAgentMediaSlots ariaLabel="Inputs" media={[image('panorama', 5000, 100), image('tall', 100, 5000)]} />);
    expect(screen.getByLabelText('Inputs')).toHaveAttribute('data-thumbnail-sizing', 'uniform');
    expect(slotSize(1)).toEqual(['', '']);
    expect(slotSize(2)).toEqual(['', '']);
  });

  it('keeps missing, zero, negative and non-finite metadata in the original pending geometry', () => {
    render(<ConnectedAgentMediaSlots ariaLabel="Inputs" media={[
      image('missing'), image('zero', 0, 100), image('negative', 100, -1), image('invalid', Number.POSITIVE_INFINITY, 100),
    ]} />);
    for (let index = 1; index <= 4; index++) expect(slotSize(index)).toEqual(['', '']);
    expect(screen.getByLabelText('Inputs')).toHaveTextContent('4 / 20');
  });

  it('uses uniform frames for Agent trays by default', () => {
    render(<ConnectedAgentMediaSlots ariaLabel="Agent inputs" media={[image('portrait', 1200, 1800)]} />);
    expect(screen.getByLabelText('Agent inputs')).toHaveAttribute('data-thumbnail-sizing', 'uniform');
    expect(slotSize(1)).toEqual(['', '']);
  });

  it('keeps twenty mixed references in one ordered scroll lane', () => {
    const media = Array.from({ length: 20 }, (_, index) => image(`reference-${index + 1}`, index % 2 ? 1600 : 1200, index % 2 ? 900 : 1800));
    render(<ConnectedAgentMediaSlots ariaLabel="Agent inputs" slotRowAriaLabel="Ordered references" media={media} />);
    expect(screen.getByLabelText('Ordered references')).toHaveAttribute('data-layout', 'single-row');
    expect(screen.getByLabelText('Agent media slot 20')).toHaveAttribute('title', '20. reference-20');
    expect(slotSize(1)).toEqual(['', '']);
    expect(slotSize(20)).toEqual(['', '']);
  });

  it('hydrates dimensions without losing an optimistic reorder or its numbered slots', () => {
    const onReorder = vi.fn();
    const { rerender } = render(<ConnectedAgentMediaSlots ariaLabel="Inputs" media={[image('A'), image('B')]} onReorder={onReorder} />);
    fireEvent.click(screen.getByRole('button', { name: 'Move B left' }));
    rerender(<ConnectedAgentMediaSlots ariaLabel="Inputs" media={[image('A', 900, 900), image('B', 1200, 1800)]} onReorder={onReorder} />);
    expect(screen.getByLabelText('Agent media slot 1')).toHaveAttribute('title', '1. B');
    expect(slotSize(1)).toEqual(['', '']);
    expect(slotSize(2)).toEqual(['', '']);
    expect(onReorder).toHaveBeenCalledTimes(1);
  });
});
