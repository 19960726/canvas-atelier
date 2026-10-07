import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderBridgeProfile } from '@agent-canvas/desktop-core';
import type { LayeringDraft } from '../app/layering-draft';
import type { LayeringPlan } from '../app/layering-plan';
import type { LayeringRouteEvidence } from '../app/layering-route-evidence';
import { LayeringDialog, type LayeringDialogProps } from './LayeringDialog';

const sourceAsset = { assetId: 'a'.repeat(16), displayUrl: 'novus-asset://project/session/source',
  label: 'Source fixture', width: 24, height: 24, sha256: 'a'.repeat(64) };
const profiles: ProviderBridgeProfile[] = [
  { provider: 'comfly', modelRoute: 'fixture-vision', modelId: 'fixture-vision', displayName: 'Vision fixture', capabilities: ['vision'] },
  { provider: 'comfly', modelRoute: 'gpt-image-2', modelId: 'gpt-image-2', displayName: 'GPT Image 2',
    capabilities: ['image_generation', 'image_edit', 'async_tasks'] },
];
const routeEvidence: LayeringRouteEvidence[] = [{ provider: 'comfly', modelRoute: 'gpt-image-2', modelId: 'gpt-image-2',
  source: 'live_alpha_qa', verifiedAt: '2026-10-06T04:00:00.000Z', transparentBackground: true,
  outputFormat: 'png', resolutions: ['1K'] }];
const plan: LayeringPlan = { sourceAssetId: sourceAsset.assetId, canvasWidth: 24, canvasHeight: 24, pixelMode: 'source', layers: [
  { layerId: 'background', kind: 'background', name: 'Background', description: 'Complete background', included: true },
  { layerId: 'cup', kind: 'transparent', name: 'Cup', description: 'Only cup pixels', included: true,
    sourceBounds: { x: .1, y: .1, width: .5, height: .5 } },
] };
const initialDraft: LayeringDraft = { sourceAssetId: sourceAsset.assetId, plan, analysisRoute: 'comfly::fixture-vision',
  generationRoute: 'comfly::gpt-image-2', resolution: '1K', layerCountMode: 'auto', targetLayerCount: 2,
  selection: { mode: 'whole' }, step: 'review', createdGroupId: null, started: false };

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('LayeringDialog generation lifecycle', () => {
  it.each(['close-button', 'escape', 'backdrop', 'unmount'] as const)
  ('stops before creating any group after %s while the real confirmation SHA waits', async closeMode => {
    const f = fixture();
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    const entered = deferred<void>(), release = deferred<void>();
    vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(async (algorithm, data) => {
      const value = await digest(algorithm, data);
      entered.resolve();
      await release.promise;
      return value;
    });
    fireEvent.click(screen.getByRole('button', { name: '确认生成 2 层' }));
    await entered.promise;
    f.close(closeMode);
    const writes = f.onDraftChange.mock.calls.length;
    await act(async () => { release.resolve(); });

    expect(f.onCreateGroup).not.toHaveBeenCalled();
    expect(f.onStart).not.toHaveBeenCalled();
    expect(f.onDraftChange).toHaveBeenCalledTimes(writes);
    expect(f.onClose).toHaveBeenCalledTimes(closeMode === 'unmount' ? 0 : 1);
  });

  it.each(['asset', 'same-asset-checksum'] as const)
  ('does not apply a confirmed old plan after its %s identity changes during SHA', async change => {
    const f = fixture();
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    const entered = deferred<void>(), release = deferred<void>();
    vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(async (algorithm, data) => {
      const value = await digest(algorithm, data);
      entered.resolve(); await release.promise; return value;
    });
    fireEvent.click(screen.getByRole('button', { name: '确认生成 2 层' }));
    await entered.promise;
    f.view.rerender(<LayeringDialog {...f.props} sourceAsset={change === 'asset'
      ? { ...sourceAsset, assetId: 'b'.repeat(16) }
      : { ...sourceAsset, sha256: 'b'.repeat(64) }} />);
    await act(async () => { release.resolve(); });

    expect(f.onCreateGroup).not.toHaveBeenCalled();
    expect(f.onStart).not.toHaveBeenCalled();
    expect(f.onClose).not.toHaveBeenCalled();
    expect(f.onDraftChange.mock.calls.some(([value]) => value.started)).toBe(false);
  });

  it('keeps a created group without starting it when the dialog closes while graph persistence waits', async () => {
    const f = fixture(), entered = deferred<void>(), release = deferred<void>();
    f.onCreateGroup.mockImplementationOnce(async () => { entered.resolve(); await release.promise; return true; });
    fireEvent.click(screen.getByRole('button', { name: '确认生成 2 层' }));
    await entered.promise;
    f.close('close-button');
    f.view.unmount();
    const writes = f.onDraftChange.mock.calls.length;
    await act(async () => { release.resolve(); });

    expect(f.onCreateGroup).toHaveBeenCalledOnce();
    expect(f.onStart).not.toHaveBeenCalled();
    expect(f.onDraftChange).toHaveBeenCalledTimes(writes);
    expect(f.onClose).toHaveBeenCalledOnce();
  });

  it('passes a live execution guard so graph creation can refuse a dialog closed inside its own wait', async () => {
    const f = fixture(), entered = deferred<void>(), release = deferred<void>();
    const graphWrites = vi.fn();
    f.onCreateGroup.mockImplementationOnce(async input => {
      entered.resolve(); await release.promise;
      const guard = (input as typeof input & { executionGuard?: () => boolean }).executionGuard;
      if (guard && !guard()) return false;
      graphWrites(); return true;
    });
    fireEvent.click(screen.getByRole('button', { name: '确认生成 2 层' }));
    await entered.promise;
    f.close('close-button');
    await act(async () => { release.resolve(); });

    expect(graphWrites).not.toHaveBeenCalled();
    expect(f.onCreateGroup).toHaveBeenCalledWith(expect.objectContaining({ executionGuard: expect.any(Function) }));
    expect(f.onStart).not.toHaveBeenCalled();
  });

  it('passes a live execution guard so closing during start preparation cannot dispatch a task', async () => {
    const f = fixture(), entered = deferred<void>(), release = deferred<void>();
    const dispatch = vi.fn();
    f.onStart.mockImplementationOnce(async input => {
      entered.resolve(); await release.promise;
      const guard = (input as typeof input & { executionGuard?: () => boolean }).executionGuard;
      if (guard && !guard()) return false;
      dispatch(); return true;
    });
    fireEvent.click(screen.getByRole('button', { name: '确认生成 2 层' }));
    await entered.promise;
    f.close('close-button');
    f.view.unmount();
    await act(async () => { release.resolve(); });

    expect(f.onCreateGroup).toHaveBeenCalledOnce();
    expect(f.onStart).toHaveBeenCalledWith(expect.objectContaining({ executionGuard: expect.any(Function) }));
    expect(dispatch).not.toHaveBeenCalled();
    expect(f.onClose).toHaveBeenCalledOnce();
  });

  it('retains a legally dispatched task without updating a closed dialog or its reopened draft', async () => {
    const f = fixture(), entered = deferred<void>(), release = deferred<void>();
    const dispatch = vi.fn();
    f.onStart.mockImplementationOnce(async () => { dispatch(); entered.resolve(); await release.promise; return true; });
    fireEvent.click(screen.getByRole('button', { name: '确认生成 2 层' }));
    await entered.promise;
    f.close('close-button');
    f.view.unmount();
    const reopened = fixture();
    const oldWrites = f.onDraftChange.mock.calls.length;
    const newWrites = reopened.onDraftChange.mock.calls.length;
    await act(async () => { release.resolve(); });

    expect(dispatch).toHaveBeenCalledOnce();
    expect(f.onStart).toHaveBeenCalledOnce();
    expect(f.onClose).toHaveBeenCalledOnce();
    expect(f.onDraftChange).toHaveBeenCalledTimes(oldWrites);
    expect(reopened.onDraftChange).toHaveBeenCalledTimes(newWrites);
    expect(reopened.onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '确认生成 2 层' })).toBeEnabled();
  });
});

function fixture() {
  const onAnalyze = vi.fn<LayeringDialogProps['onAnalyze']>(async () => plan);
  const onCreateGroup = vi.fn<LayeringDialogProps['onCreateGroup']>(async () => true);
  const onStart = vi.fn<LayeringDialogProps['onStart']>(async () => true);
  const onClose = vi.fn(), onDraftChange = vi.fn<(draft: LayeringDraft) => void>();
  const props = { sourceAsset, profiles, routeEvidence, initialDraft, onAnalyze, onCreateGroup, onStart, onClose, onDraftChange };
  const view = render(<LayeringDialog {...props} />);
  const close = (mode: 'close-button' | 'escape' | 'backdrop' | 'unmount') => {
    if (mode === 'unmount') view.unmount();
    else if (mode === 'escape') fireEvent.keyDown(window, { key: 'Escape' });
    else if (mode === 'backdrop') fireEvent.mouseDown(document.querySelector('.image-layering-dialog-backdrop')!);
    else fireEvent.click(screen.getByRole('button', { name: '关闭 AI 图片分层' }));
  };
  return { props, view, onAnalyze, onCreateGroup, onStart, onClose, onDraftChange, close };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
