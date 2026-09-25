import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it, vi } from 'vitest';
import { ImageLayerNodeWorkbench } from './ImageLayerNodeWorkbench';

describe('ImageLayerNodeWorkbench', () => {
  it('shows independent layer identity, transparent kind and status without a fake preview', () => {
    render(<ImageLayerNodeWorkbench nodeId="layer-a" config={{ name: '产品主体', layerKind: 'transparent', status: 'queued' }} onQualityResult={vi.fn()} onVisibilityChange={vi.fn()} />);
    expect(screen.getByRole('region', { name: '画布图层：产品主体' })).toHaveAttribute('data-layer-status', 'queued');
    expect(screen.getByText('透明层')).toBeVisible();
    expect(screen.getByText('排队中')).toBeVisible();
    expect(screen.queryByRole('img', { name: '产品主体图层预览' })).not.toBeInTheDocument();
  });

  it('offers a compact accessible visibility action', () => {
    const onVisibilityChange = vi.fn();
    render(<ImageLayerNodeWorkbench nodeId="layer-a" config={{ name: '背景', layerKind: 'background', visible: true }} onQualityResult={vi.fn()} onVisibilityChange={onVisibilityChange} />);
    fireEvent.click(screen.getByRole('button', { name: '隐藏图层 背景' }));
    expect(onVisibilityChange).toHaveBeenCalledWith(false);
  });
});
