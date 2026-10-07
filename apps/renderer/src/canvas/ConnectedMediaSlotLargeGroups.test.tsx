import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectedAgentMediaSlots, type ConnectedAgentMediaSlotItem } from './ConnectedAgentMediaSlots';

afterEach(cleanup);

const groups = Array.from({ length: 25 }, (_, groupIndex) => Array.from({ length: 4 }, (_, memberIndex): ConnectedAgentMediaSlotItem => ({
  edgeId: `group-edge-${groupIndex}`,
  assetId: `group-${groupIndex}-asset-${memberIndex}`,
  kind: memberIndex % 2 === 0 ? 'image' : 'video',
  label: `Group ${groupIndex + 1} material ${memberIndex + 1}`,
})));
const media = groups.flat();
const slot = (index: number) => screen.getByLabelText(`Agent media slot ${index}`, { exact: true });
const move = (item: ConnectedAgentMediaSlotItem, direction: 'left' | 'right') => screen.getByRole('button', { name: `Move ${item.label} ${direction}` });

function expectDisplayedOrder(expected: readonly ConnectedAgentMediaSlotItem[]) {
  expected.forEach((item, index) => {
    expect(slot(index + 1)).toHaveAttribute('title', `${index + 1}. ${item.label}`);
  });
}

describe('large connected media groups', () => {
  it('retains all hundred references and disables an add action above the execution limit', () => {
    const onAdd = vi.fn();
    render(<ConnectedAgentMediaSlots ariaLabel="Inputs" slotRowAriaLabel="Overflow references" media={media} preserveOverflow onAdd={onAdd} onReorder={vi.fn()} />);

    expect(screen.getByText('100 / 20')).toBeVisible();
    expect(screen.getByLabelText('Inputs')).toHaveAttribute('data-thumbnail-sizing', 'uniform');
    expect(screen.getByLabelText('Overflow references')).toHaveAttribute('data-layout', 'single-row');
    expect(screen.getByLabelText('Overflow references')).toHaveAttribute('data-overflow', 'true');
    expect(screen.getAllByLabelText(/^Agent media slot \d+$/u)).toHaveLength(100);
    expect(screen.getByRole('button', { name: '添加素材' })).toBeDisabled();
    expectDisplayedOrder(media);
  });

  it('moves either end group atomically and updates the disabled boundary tools', () => {
    const onReorder = vi.fn();
    render(<ConnectedAgentMediaSlots ariaLabel="Inputs" media={media} preserveOverflow onReorder={onReorder} />);
    groups[0]!.forEach(item => expect(move(item, 'left')).toBeDisabled());
    groups[24]!.forEach(item => expect(move(item, 'right')).toBeDisabled());

    fireEvent.click(move(groups[0]![2]!, 'right'));
    const movedFirst = [...groups[1]!, ...groups[0]!, ...groups.slice(2).flat()];
    expect(onReorder).toHaveBeenNthCalledWith(1, movedFirst);
    groups[1]!.forEach(item => expect(move(item, 'left')).toBeDisabled());
    groups[0]!.forEach(item => expect(move(item, 'left')).toBeEnabled());
    expectDisplayedOrder(movedFirst);

    fireEvent.click(move(groups[24]![1]!, 'left'));
    const movedLast = [...movedFirst.slice(0, 92), ...groups[24]!, ...groups[23]!];
    expect(onReorder).toHaveBeenNthCalledWith(2, movedLast);
    groups[23]!.forEach(item => expect(move(item, 'right')).toBeDisabled());
    groups[24]!.forEach(item => expect(move(item, 'right')).toBeEnabled());
    expectDisplayedOrder(movedLast);
  });

  it('drags a middle group from any member to the final group without losing another reference', () => {
    const onReorder = vi.fn();
    render(<ConnectedAgentMediaSlots ariaLabel="Inputs" media={media} preserveOverflow onReorder={onReorder} />);
    fireEvent.dragStart(slot(43));
    fireEvent.dragOver(slot(100));
    fireEvent.drop(slot(100));

    const expected = [...groups.slice(0, 10).flat(), ...groups.slice(11).flat(), ...groups[10]!];
    expect(onReorder).toHaveBeenCalledOnce();
    expect(onReorder).toHaveBeenCalledWith(expected);
    expectDisplayedOrder(expected);
    expect(screen.getAllByLabelText(/^Agent media slot \d+$/u)).toHaveLength(100);
    groups[10]!.forEach(item => expect(move(item, 'right')).toBeDisabled());
  });

  it('keeps the current group order through hover updates and presentation hydration', () => {
    const onReorder = vi.fn();
    const { rerender } = render(<ConnectedAgentMediaSlots ariaLabel="Inputs" media={media} preserveOverflow onReorder={onReorder} />);
    fireEvent.pointerDown(slot(43), { button: 0, pointerId: 7 });
    for (const index of [70, 20, 99, 1]) fireEvent.pointerEnter(slot(index), { pointerId: 7 });
    expectDisplayedOrder(media);
    fireEvent.pointerUp(window, { button: 0, pointerId: 7 });
    expect(onReorder).not.toHaveBeenCalled();

    fireEvent.click(move(groups[10]![3]!, 'right'));
    const expected = [...groups.slice(0, 10).flat(), ...groups[11]!, ...groups[10]!, ...groups.slice(12).flat()];
    const hydrated = media.map(item => ({ ...item, label: `${item.label} hydrated`, width: 4096, height: 2160 }));
    rerender(<ConnectedAgentMediaSlots ariaLabel="Inputs" media={hydrated} preserveOverflow onReorder={onReorder} />);
    expectDisplayedOrder(expected.map(item => ({ ...item, label: `${item.label} hydrated` })));
    expect(onReorder).toHaveBeenCalledOnce();
    expect(screen.getByText('100 / 20')).toBeVisible();
  });

  it('retains the existing twenty-reference display limit when overflow preservation is not requested', () => {
    render(<ConnectedAgentMediaSlots ariaLabel="Inputs" media={media} onReorder={vi.fn()} />);
    expect(screen.getAllByLabelText(/^Agent media slot \d+$/u)).toHaveLength(20);
    expect(screen.getByText('20 / 20')).toBeVisible();
    expect(screen.queryByLabelText('Agent media slot 21', { exact: true })).not.toBeInTheDocument();
    expectDisplayedOrder(media.slice(0, 20));
    groups[4]!.forEach(item => expect(move(item, 'right')).toBeDisabled());
  });
});
