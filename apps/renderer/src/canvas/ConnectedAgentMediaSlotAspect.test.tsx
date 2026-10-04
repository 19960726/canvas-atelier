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

describe('generation media thumbnails preserve their complete proportions', () => {
  it('fits portrait, landscape and square assets without giving them an equal width', () => {
    render(<ConnectedAgentMediaSlots ariaLabel="Inputs" preserveMediaAspect media={[
      image('portrait', 1200, 1800), image('landscape', 1600, 900), image('square', 900, 900),
    ]} />);
    expect(screen.getByLabelText('Inputs')).toHaveAttribute('data-thumbnail-sizing', 'natural');
    expect(slotSize(1)).toEqual(['36px', '54px']);
    expect(slotSize(2)).toEqual(['96px', '54px']);
    expect(slotSize(3)).toEqual(['54px', '54px']);
  });

  it('uses owned video dimensions for the same complete-image sizing', () => {
    render(<ConnectedAgentMediaSlots ariaLabel="Inputs" preserveMediaAspect media={[
      { edgeId: 'video-edge', kind: 'video', assetId: 'video', label: 'Video', previewUrl: 'novus-video://current/video', width: 1920, height: 1080 },
    ]} />);
    expect(slotSize(1)).toEqual(['96px', '54px']);
    expect(screen.getByLabelText('Video 视频封面')).toHaveAttribute('src', 'novus-video://current/video');
  });

  it('limits an extreme panorama width and reduces its height without stretching it', () => {
    render(<ConnectedAgentMediaSlots ariaLabel="Inputs" preserveMediaAspect media={[image('panorama', 5000, 100)]} />);
    expect(slotSize(1)).toEqual(['162px', '3.24px']);
  });

  it('keeps missing, zero, negative and non-finite metadata in the original pending geometry', () => {
    render(<ConnectedAgentMediaSlots ariaLabel="Inputs" preserveMediaAspect media={[
      image('missing'), image('zero', 0, 100), image('negative', 100, -1), image('invalid', Number.POSITIVE_INFINITY, 100),
    ]} />);
    for (let index = 1; index <= 4; index++) expect(slotSize(index)).toEqual(['', '']);
    expect(screen.getByLabelText('Inputs')).toHaveTextContent('4 / 20');
  });

  it('does not change other Agent trays unless natural sizing is explicitly enabled', () => {
    render(<ConnectedAgentMediaSlots ariaLabel="Agent inputs" media={[image('portrait', 1200, 1800)]} />);
    expect(screen.getByLabelText('Agent inputs')).not.toHaveAttribute('data-thumbnail-sizing');
    expect(slotSize(1)).toEqual(['', '']);
  });

  it('hydrates dimensions without losing an optimistic reorder or its numbered slots', () => {
    const onReorder = vi.fn();
    const { rerender } = render(<ConnectedAgentMediaSlots ariaLabel="Inputs" preserveMediaAspect media={[image('A'), image('B')]} onReorder={onReorder} />);
    fireEvent.click(screen.getByRole('button', { name: 'Move B left' }));
    rerender(<ConnectedAgentMediaSlots ariaLabel="Inputs" preserveMediaAspect media={[image('A', 900, 900), image('B', 1200, 1800)]} onReorder={onReorder} />);
    expect(screen.getByLabelText('Agent media slot 1')).toHaveAttribute('title', '1. B');
    expect(slotSize(1)).toEqual(['36px', '54px']);
    expect(slotSize(2)).toEqual(['54px', '54px']);
    expect(onReorder).toHaveBeenCalledTimes(1);
  });
});
