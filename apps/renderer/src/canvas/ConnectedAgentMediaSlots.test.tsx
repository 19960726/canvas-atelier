import { readFileSync } from 'node:fs';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectedAgentMediaSlots, type ConnectedAgentMediaSlotItem } from './ConnectedAgentMediaSlots';
import { CONNECTED_MEDIA_DRAG_MIME } from './connected-media-drag';

afterEach(cleanup);

const media: ConnectedAgentMediaSlotItem[] = [
  { edgeId: 'edge-image-a', kind: 'image', assetId: 'image-a', label: 'Image A', previewUrl: 'data:image/png;base64,AA==' },
  { edgeId: 'edge-video-a', kind: 'video', assetId: 'video-a', label: 'Video A', previewUrl: 'blob:video-a' },
  { edgeId: 'edge-image-b', kind: 'image', assetId: 'image-b', label: 'Image B', previewUrl: 'data:image/png;base64,BB==' },
  { edgeId: 'edge-video-b', kind: 'video', assetId: 'video-b', label: 'Video B', previewUrl: 'blob:video-b' },
];

describe('ConnectedAgentMediaSlots', () => {
  it('renders ordered image and video covers with a shared twenty-item counter', () => {
    render(<ConnectedAgentMediaSlots ariaLabel="Agent media slots" media={media} />);

    expect(screen.getByText('4 / 20')).toBeVisible();
    expect(screen.getByRole('img', { name: 'Image A' })).toBeVisible();
    expect(screen.getByLabelText('Video A 视频封面')).toBeVisible();
    expect(screen.getByLabelText('Agent media slot 4')).toHaveTextContent('4');
  });

  it('renders only connected media instead of inventing empty slot thumbnails', () => {
    render(<ConnectedAgentMediaSlots ariaLabel="Agent media slots" media={media} />);

    expect(screen.getAllByLabelText(/Agent media slot \d+$/u)).toHaveLength(4);
    expect(screen.queryByLabelText('Agent media slot 5 empty')).not.toBeInTheDocument();
  });

  it('caps the shared tray at twenty numbered media thumbnails', () => {
    const overflowing = Array.from({ length: 21 }, (_, index): ConnectedAgentMediaSlotItem => ({
      kind: index % 2 === 0 ? 'image' : 'video',
      assetId: `asset-${index + 1}`,
      label: `Asset ${index + 1}`,
      previewUrl: index % 2 === 0 ? `data:image/png;base64,${index}` : `blob:video-${index}`,
    }));

    render(<ConnectedAgentMediaSlots ariaLabel="Agent media slots" media={overflowing} />);

    expect(screen.getByText('20 / 20')).toBeVisible();
    expect(screen.getAllByLabelText(/Agent media slot \d+/u)).toHaveLength(20);
    expect(screen.getByLabelText('Agent media slot 20')).toHaveTextContent('20');
    expect(screen.queryByLabelText('Agent media slot 21')).not.toBeInTheDocument();
  });
  it('allows an arbitrary slot to be dragged to a new position', () => {
    const onReorder = vi.fn();
    render(<ConnectedAgentMediaSlots ariaLabel="Agent media slots" media={media} onReorder={onReorder} />);

    fireEvent.dragStart(screen.getByLabelText('Agent media slot 4'));
    fireEvent.dragOver(screen.getByLabelText('Agent media slot 1'));
    fireEvent.drop(screen.getByLabelText('Agent media slot 1'));

    expect(onReorder).toHaveBeenCalledWith([
      media[3], media[0], media[1], media[2],
    ]);
  });

  it('falls back to pointer drag when Electron does not start native HTML dragging', () => {
    const onReorder = vi.fn();
    render(<ConnectedAgentMediaSlots ariaLabel="Agent media slots" media={media} onReorder={onReorder} />);

    fireEvent.pointerDown(screen.getByLabelText('Agent media slot 4'), { button: 0, pointerId: 7 });
    fireEvent.pointerEnter(screen.getByLabelText('Agent media slot 1'), { pointerId: 7 });
    fireEvent.pointerUp(screen.getByLabelText('Agent media slot 1'), { button: 0, pointerId: 7 });

    expect(onReorder).toHaveBeenCalledWith([media[3], media[0], media[1], media[2]]);
  });

  it('commits only one reorder when pointer and native drag events overlap', () => {
    const onReorder = vi.fn();
    render(<ConnectedAgentMediaSlots ariaLabel="Agent media slots" media={media} onReorder={onReorder} />);
    const source = screen.getByLabelText('Agent media slot 4');
    const target = screen.getByLabelText('Agent media slot 1');
    fireEvent.pointerDown(source, { button: 0, pointerId: 9 });
    fireEvent.pointerEnter(target, { pointerId: 9 });
    fireEvent.dragStart(source, { dataTransfer: { setData: vi.fn(), effectAllowed: 'none' } });
    fireEvent.pointerUp(target, { button: 0, pointerId: 9 });
    fireEvent.dragOver(target);
    fireEvent.drop(target);
    expect(onReorder).toHaveBeenCalledTimes(1);
    expect(onReorder).toHaveBeenLastCalledWith([media[3], media[0], media[1], media[2]]);
  });

  it('keeps the latest local order when several swaps happen before persistence rerenders the parent', () => {
    const onReorder = vi.fn();
    render(<ConnectedAgentMediaSlots ariaLabel="Agent media slots" media={media} onReorder={onReorder} />);

    fireEvent.click(screen.getByRole('button', { name: 'Move Video B left' }));
    fireEvent.click(screen.getByRole('button', { name: 'Move Image B left' }));
    fireEvent.click(screen.getByRole('button', { name: 'Move Video A right' }));

    expect(onReorder).toHaveBeenNthCalledWith(1, [media[0], media[1], media[3], media[2]]);
    expect(onReorder).toHaveBeenNthCalledWith(2, [media[0], media[1], media[2], media[3]]);
    expect(onReorder).toHaveBeenNthCalledWith(3, [media[0], media[2], media[1], media[3]]);
  });

  it('allows slots after the first four to be reordered and keeps their edge identity', () => {
    const onReorder = vi.fn();
    const nineMedia = Array.from({ length: 9 }, (_, index): ConnectedAgentMediaSlotItem => ({
      edgeId: `edge-${index + 1}`,
      kind: 'image',
      assetId: `image-${index + 1}`,
      label: `Image ${index + 1}`,
    }));
    render(<ConnectedAgentMediaSlots ariaLabel="Agent media slots" media={nineMedia} onReorder={onReorder} />);

    fireEvent.dragStart(screen.getByLabelText('Agent media slot 9'));
    fireEvent.dragOver(screen.getByLabelText('Agent media slot 5'));
    fireEvent.drop(screen.getByLabelText('Agent media slot 5'));

    expect(onReorder).toHaveBeenCalledWith([
      ...nineMedia.slice(0, 4), nineMedia[8], ...nineMedia.slice(4, 8),
    ]);
    expect(screen.getByLabelText('Agent media slot 9')).toHaveAttribute('data-slot-index', '9');
  });

  it('moves the twentieth material directly to the first position', () => {
    const onReorder = vi.fn();
    const twentyMedia = Array.from({ length: 20 }, (_, index): ConnectedAgentMediaSlotItem => ({
      edgeId: `edge-${index + 1}`,
      kind: 'image',
      assetId: `image-${index + 1}`,
      label: `Image ${index + 1}`,
    }));
    render(<ConnectedAgentMediaSlots ariaLabel="Agent media slots" media={twentyMedia} onReorder={onReorder} />);

    fireEvent.dragStart(screen.getByLabelText('Agent media slot 20'));
    fireEvent.dragOver(screen.getByLabelText('Agent media slot 1'));
    fireEvent.drop(screen.getByLabelText('Agent media slot 1'));

    expect(onReorder).toHaveBeenCalledWith([twentyMedia[19], ...twentyMedia.slice(0, 19)]);
  });

  it('publishes the existing project asset when a slot is dragged toward the canvas', () => {
    const setData = vi.fn();
    render(<ConnectedAgentMediaSlots ariaLabel="Agent media slots" media={media} onReorder={vi.fn()} />);

    fireEvent.dragStart(screen.getByLabelText('Agent media slot 1'), {
      dataTransfer: { setData, effectAllowed: 'none' },
    });

    expect(setData).toHaveBeenCalledWith(
      CONNECTED_MEDIA_DRAG_MIME,
      expect.stringContaining('"assetId":"image-a"'),
    );
  });

  it('uses the unique connection id when the same asset appears in multiple slots', () => {
    const onReorder = vi.fn();
    const duplicateMedia: ConnectedAgentMediaSlotItem[] = [
      { edgeId: 'edge-a-first', kind: 'image', assetId: 'image-a', label: 'Image A first' },
      { edgeId: 'edge-a-second', kind: 'image', assetId: 'image-a', label: 'Image A second' },
      { edgeId: 'edge-b', kind: 'image', assetId: 'image-b', label: 'Image B' },
    ];
    render(<ConnectedAgentMediaSlots ariaLabel="Agent media slots" media={duplicateMedia} onReorder={onReorder} />);

    fireEvent.dragStart(screen.getByLabelText('Agent media slot 2'));
    fireEvent.drop(screen.getByLabelText('Agent media slot 1'));

    expect(onReorder).toHaveBeenCalledWith([
      duplicateMedia[1], duplicateMedia[0], duplicateMedia[2],
    ]);
  });

  it('shows complete small thumbnails without cropping connected media', () => {
    const css = readFileSync('apps/renderer/src/styles/canvas-layout.css', 'utf8');
    const rule = css.match(/\.workspace--canvas-layout \.module-node__agent-media-slot > :is\(img, video\) \{[^}]+\}/u)?.[0] ?? '';

    expect(rule).toContain('object-fit: contain');
    expect(rule).not.toContain('object-fit: cover');
  });

  it('keeps the 1-20 slot number above every real thumbnail', () => {
    render(<ConnectedAgentMediaSlots ariaLabel="Agent media slots" media={media} />);
    expect(screen.getByLabelText('图槽编号 1')).toHaveClass('connected-agent-media-slots__index');
    expect(screen.getByLabelText('图槽编号 4')).toHaveTextContent('4');

    const css = readFileSync('apps/renderer/src/styles/canvas-layout.css', 'utf8');
    const rules = [...css.matchAll(/\.workspace--canvas-layout \.connected-agent-media-slots__index \{[^}]+\}/gu)];
    const rule = rules[rules.length - 1]?.[0] ?? '';

    expect(rule).toContain('z-index: 7');
    expect(rule).toContain('min-width: 16px');
    expect(rule).toContain('border: 1px solid');
    expect(rule).toContain('color: #fff');
  });

  it('keeps every slot in the scrollable interaction row instead of clipping after slot four', () => {
    const css = readFileSync('apps/renderer/src/styles/canvas-layout.css', 'utf8');
    expect(css).toContain('module-node__agent-media-slot-row');
    expect(css).toContain('width: 100% !important;');
    expect(css).toContain('opacity: 1 !important;');
    expect(css).toContain('overflow-x: auto !important;');
    expect(css).toContain('pointer-events: none !important;');
    expect(css).toMatch(/module-node__agent-media-slot-row::-webkit-scrollbar\s*\{[^}]*height:\s*6px/isu);
  });
  it('marks the tray as overflowing after ten slots so the scrollbar rail is explicit', () => {
    const elevenMedia = Array.from({ length: 11 }, (_, index): ConnectedAgentMediaSlotItem => ({
      edgeId: `edge-${index + 1}`,
      kind: 'image',
      assetId: `image-${index + 1}`,
      label: `Image ${index + 1}`,
    }));
    render(<ConnectedAgentMediaSlots ariaLabel="Agent media slots" slotRowAriaLabel="Scrollable media slots" media={elevenMedia} />);

    const row = screen.getByLabelText('Scrollable media slots');
    expect(row).toHaveAttribute('data-overflow', 'true');
    const css = readFileSync('apps/renderer/src/styles/release-layout-contract.css', 'utf8');
    const contract = css.slice(css.lastIndexOf('/* Ordered reference media'));
    expect(contract).toContain(".connected-agent-media-slots__row[data-overflow='true']");
    expect(contract).toContain('overflow-x: scroll !important');
    expect(contract).toContain('scrollbar-gutter: stable !important');
  });
  it('maps vertical wheel input to horizontal scrolling only when the tray overflows', () => {
    const elevenMedia = Array.from({ length: 11 }, (_, index): ConnectedAgentMediaSlotItem => ({
      edgeId: `edge-wheel-${index + 1}`,
      kind: 'image',
      assetId: `wheel-image-${index + 1}`,
      label: `Wheel image ${index + 1}`,
    }));
    render(<ConnectedAgentMediaSlots ariaLabel="Agent media slots" slotRowAriaLabel="Scrollable media slots" media={elevenMedia} />);

    const row = screen.getByLabelText('Scrollable media slots') as HTMLDivElement;
    Object.defineProperty(row, 'clientWidth', { configurable: true, value: 180 });
    Object.defineProperty(row, 'scrollWidth', { configurable: true, value: 520 });
    Object.defineProperty(row, 'scrollLeft', { configurable: true, writable: true, value: 0 });
    fireEvent.wheel(row, { deltaX: 0, deltaY: 64 });
    expect(row.scrollLeft).toBe(64);
  });
  it('keeps reorder controls inside their own slot hit area', () => {
    const css = readFileSync('apps/renderer/src/styles/release-layout-contract.css', 'utf8');
    const contract = css.slice(css.lastIndexOf('/* FINAL CONNECTED MEDIA REORDER HIT TARGET CONTRACT */'));

    expect(contract).toContain('width: 16px !important');
    expect(contract).toContain('height: 16px !important');
    expect(contract).toContain('z-index: 9 !important');
    expect(contract).toContain('pointer-events: none !important');
    expect(contract).toContain(':focus-within');
  });
  it('supports keyboard reordering without triggering canvas drag', () => {
    const onReorder = vi.fn();
    render(<ConnectedAgentMediaSlots ariaLabel="Agent media slots" media={media} onReorder={onReorder} />);

    fireEvent.click(screen.getByRole('button', { name: 'Move Video B left' }));

    expect(onReorder).toHaveBeenCalledWith([
      media[0], media[1], media[3], media[2],
    ]);
    expect(screen.getByRole('button', { name: 'Move Video B left' })).toHaveClass('nodrag', 'nopan');
  });
});
