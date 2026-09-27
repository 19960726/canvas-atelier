import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, expect, it, vi } from 'vitest';
import { SourceLayerAlignment } from './SourceLayerAlignment';
afterEach(cleanup);
it('opens correction outside the scaled node and returns focus after Escape', () => {
  const view = render(<SourceLayerAlignment sourceUrl="source" width={100} height={200}
    layers={[{ layerId: 'cup', name: '杯身', bounds: undefined }]} onApply={async () => {}} />);
  const trigger = screen.getByRole('button', { name: '按原图位置校正图层' });
  trigger.focus();
  fireEvent.click(trigger);
  const dialog = screen.getByRole('dialog', { name: '校正位置' });
  expect(dialog).toHaveAttribute('aria-modal', 'true');
  expect(view.container).not.toContainElement(dialog);
  fireEvent.keyDown(dialog, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(trigger).toHaveFocus();
});
it('requires original placement for every layer and only applies local bounds', async () => {
  const onApply = vi.fn(async () => {});
  render(<SourceLayerAlignment sourceUrl="source" width={100} height={100} layers={[
    { layerId: 'fruit', name: '水果', bounds: undefined },
  ]} onApply={onApply} />);
  fireEvent.click(screen.getByRole('button', { name: '按原图位置校正图层' }));
  expect(screen.getByRole('button', { name: '应用原图像素' })).toBeDisabled();
  expect(onApply).not.toHaveBeenCalled();
});
it('retains errors when a local bounds save fails', async () => {
  const bounds = { x: .1, y: .2, width: .3, height: .4 };
  const onApply = vi.fn(async () => { throw new Error('位置保存失败'); });
  render(<SourceLayerAlignment sourceUrl="source" width={100} height={100} layers={[{ layerId: 'fruit', name: '水果', bounds }]} onApply={onApply} />);
  fireEvent.click(screen.getByRole('button', { name: '按原图位置校正图层' }));
  fireEvent.click(screen.getByRole('button', { name: '应用原图像素' }));
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('位置保存失败'));
  expect(onApply).toHaveBeenCalledWith({ fruit: bounds });
});
