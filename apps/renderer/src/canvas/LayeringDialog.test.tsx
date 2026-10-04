import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderBridgeProfile } from '@agent-canvas/desktop-core';
import type { LayeringConfirmation, LayeringPlan } from '../app/layering-plan';
import type { LayeringRouteEvidence } from '../app/layering-route-evidence';
import type { LayeringDraft } from '../app/layering-draft';
import { LayeringDialog } from './LayeringDialog';

const sourceAsset = {
  assetId: 'source-image-123',
  displayUrl: 'novus-asset://project/source-image-123',
  label: '源图',
  width: 1200,
  height: 900,
};

const analysisProfile: ProviderBridgeProfile = {
  provider: 'comfly', modelRoute: 'vision-model', displayName: '视觉分析模型', modelId: 'vision-model',
  capabilities: ['chat', 'vision'],
};
const gptImageProfile: ProviderBridgeProfile = {
  provider: 'comfly', modelRoute: 'gpt-image-2', displayName: 'GPT Image 2', modelId: 'gpt-image-2',
  capabilities: ['image_generation', 'image_edit', 'async_tasks'],
};
const routeEvidence: LayeringRouteEvidence[] = [{
  provider: 'comfly', modelRoute: 'gpt-image-2', modelId: 'gpt-image-2', source: 'live_alpha_qa',
  verifiedAt: '2026-09-23T00:00:00.000Z', transparentBackground: true, outputFormat: 'png', resolutions: ['1K', '2K'],
}];
const plan: LayeringPlan = {
  sourceAssetId: sourceAsset.assetId, canvasWidth: sourceAsset.width, canvasHeight: sourceAsset.height,
  layers: [
    { layerId: 'background', kind: 'background', name: '背景', description: '完整背景', included: true },
    { layerId: 'product-main', kind: 'transparent', name: '产品本体', description: '产品可见像素，不包含投影。', included: true },
    { layerId: 'prop-vase', kind: 'transparent', name: '左侧玻璃花瓶', description: '花瓶可见像素，不包含投影。', included: true },
  ],
};
afterEach(cleanup);

function renderDialog(analysisPlan: LayeringPlan = plan) {
  const onAnalyze = vi.fn(async (_input: { sourceAssetId: string; provider: ProviderBridgeProfile['provider']; modelRoute: string; width: number; height: number }) => analysisPlan);
  const onCreateGroup = vi.fn(async (_input: { plan: LayeringPlan; confirmation: LayeringConfirmation; groupId: string }) => true);
  const onStart = vi.fn(async (_input: { plan: LayeringPlan; confirmation: LayeringConfirmation; groupId: string }) => true);
  const onClose = vi.fn();
  const view = render(<LayeringDialog
    sourceAsset={sourceAsset}
    profiles={[analysisProfile, gptImageProfile]}
    routeEvidence={routeEvidence}
    onAnalyze={onAnalyze}
    onCreateGroup={onCreateGroup}
    onStart={onStart}
    onClose={onClose}
  />);
  return { onAnalyze, onCreateGroup, onStart, onClose, view };
}

describe('LayeringDialog', () => {
  it('shows the independent color output contract in the actual generation confirmation', async () => {
    const independent = { ...plan, pixelMode: 'source' as const, foregroundOutputContract: 'source-independent-rgba-v2' as const,
      layers: plan.layers.map(layer => layer.kind === 'transparent'
        ? { ...layer, sourceBounds: { x: .2, y: .1, width: .5, height: .6 } } : layer) };
    const callbacks = renderDialog(independent);
    fireEvent.click(screen.getByRole('button', { name: '分析图片' }));
    fireEvent.click(await screen.findByRole('button', { name: '下一步：确认生成' }));
    const review = await screen.findByRole('region', { name: '生成确认摘要' });
    expect(within(review).getByText('独立透明颜色')).toBeInTheDocument();
    expect(callbacks.onStart).not.toHaveBeenCalled();
    expect(callbacks.onCreateGroup).not.toHaveBeenCalled();
  });
  it('keeps source-position controls inside layer fields so plan rows retain their three-column layout', async () => {
    const sourcePlan: LayeringPlan = { ...plan, pixelMode: 'source', layers: plan.layers.map((layer) => layer.layerId === 'product-main'
      ? { ...layer, sourceBounds: { x: 0.25, y: 0.2, width: 0.4, height: 0.6 } }
      : layer) };
    renderDialog(sourcePlan);
    fireEvent.click(screen.getByRole('button', { name: '分析图片' }));
    const list = await screen.findByRole('list', { name: '可编辑分层方案' });
    const row = within(list).getByRole('button', { name: '标注原图位置 产品本体' }).closest('li');
    expect(row).not.toBeNull();
    expect([...row!.children].map((child) => child.className)).toEqual([
      'image-layering-dialog__order', 'image-layering-dialog__layer-fields', 'image-layering-dialog__layer-actions',
    ]);
    expect(within(row!).getByRole('button', { name: '标注原图位置 产品本体' }).closest('.image-layering-dialog__layer-fields')).not.toBeNull();
  });
  it('restores an unfinished region choice without silently switching it to whole image', () => {
    let draft: unknown;
    const props = { sourceAsset, profiles: [analysisProfile, gptImageProfile], routeEvidence,
      onAnalyze: vi.fn(async () => plan), onCreateGroup: vi.fn(async () => true), onStart: vi.fn(async () => true), onClose: vi.fn(),
      onDraftChange: (value: unknown) => { draft = value; } };
    const view = render(<LayeringDialog {...props} />);
    fireEvent.click(screen.getByRole('button', { name: '框选区域' }));
    view.unmount();
    render(<LayeringDialog {...props} initialDraft={draft as never} />);
    expect(screen.getByRole('button', { name: '框选区域' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: '分析图片' })).toBeDisabled();
    expect(props.onAnalyze).not.toHaveBeenCalled();
  });
  it('restores edited descriptions after closing and remounting without charging for another analysis', async () => {
    let draft: unknown;
    const onAnalyze = vi.fn(async () => plan);
    const props = { sourceAsset, profiles: [analysisProfile, gptImageProfile], routeEvidence,
      onAnalyze, onCreateGroup: vi.fn(async () => true), onStart: vi.fn(async () => true), onClose: vi.fn(),
      onDraftChange: (value: unknown) => { draft = value; } };
    const view = render(<LayeringDialog {...props} />);
    fireEvent.click(screen.getByRole('button', { name: '分析图片' }));
    await screen.findByRole('list', { name: '可编辑分层方案' });
    fireEvent.change(screen.getByRole('textbox', { name: '图层说明 产品本体' }), { target: { value: '保留原位置和大小，不含投影' } });
    view.unmount();
    render(<LayeringDialog {...props} initialDraft={draft as never} />);
    expect(screen.getByRole('textbox', { name: '图层说明 产品本体' })).toHaveValue('保留原位置和大小，不含投影');
    expect(onAnalyze).toHaveBeenCalledOnce();
  });
  it('preserves the edited saved plan and submitted group while re-analysis waits or fails, including after reopening', async () => {
    const editedPlan: LayeringPlan = { ...plan, pixelMode: 'source', layers: plan.layers.map(layer => layer.layerId === 'product-main'
      ? { ...layer, description: '只保留产品，不要手部；保持原图位置', sourceBounds: { x: 0.2, y: 0.3, width: 0.4, height: 0.5 } }
      : layer.kind === 'transparent' ? { ...layer, sourceBounds: { x: 0.1, y: 0.2, width: 0.15, height: 0.3 } } : layer) };
    const original: LayeringDraft = { sourceAssetId: sourceAsset.assetId, plan: editedPlan,
      analysisRoute: 'comfly::vision-model', generationRoute: 'comfly::gpt-image-2', resolution: '2K',
      layerCountMode: 'auto', targetLayerCount: 5, selection: { mode: 'whole' }, step: 'review',
      createdGroupId: 'existing-submitted-group', started: true };
    let saved = original;
    const writes: LayeringDraft[] = [];
    let rejectAnalysis!: (error: Error) => void;
    const onAnalyze = vi.fn(() => new Promise<LayeringPlan>((_resolve, reject) => { rejectAnalysis = reject; }));
    const props = { sourceAsset, profiles: [analysisProfile, gptImageProfile], routeEvidence, onAnalyze,
      onCreateGroup: vi.fn(async () => true), onStart: vi.fn(async () => true), onClose: vi.fn(),
      onDraftChange: (value: LayeringDraft) => { saved = value; writes.push(value); } };
    const view = render(<LayeringDialog {...props} initialDraft={original} />);
    fireEvent.click(screen.getByRole('button', { name: '重新分析' }));
    await waitFor(() => expect(onAnalyze).toHaveBeenCalledOnce());
    expect(writes.every(value => value.plan !== null && value.createdGroupId === original.createdGroupId && value.started)).toBe(true);
    expect(screen.getByRole('textbox', { name: '图层说明 产品本体' })).toHaveValue(editedPlan.layers[1]!.description);
    expect(screen.getByRole('textbox', { name: '图层说明 产品本体' })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: '图层名称 产品本体' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '排除图层 产品本体' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: '视觉分析模型' })).toBeDisabled();
    await act(async () => { rejectAnalysis(new Error('本次分析失败')); });
    expect(await screen.findByRole('alert')).toHaveTextContent('本次分析失败');
    expect(saved).toMatchObject({ plan: editedPlan, createdGroupId: original.createdGroupId, started: true, step: 'review' });
    view.unmount();
    render(<LayeringDialog {...props} initialDraft={saved} />);
    expect(screen.getByRole('textbox', { name: '图层说明 产品本体' })).toHaveValue(editedPlan.layers[1]!.description);
    expect(screen.getByRole('button', { name: '该方案已提交，可在画布查看图层' })).toBeDisabled();
    expect(props.onCreateGroup).not.toHaveBeenCalled();
    expect(props.onStart).not.toHaveBeenCalled();
    expect(onAnalyze).toHaveBeenCalledOnce();
  });
  it('replaces an existing plan and clears its submitted group only after a new analysis succeeds', async () => {
    const original: LayeringDraft = { sourceAssetId: sourceAsset.assetId, plan,
      analysisRoute: 'comfly::vision-model', generationRoute: 'comfly::gpt-image-2', resolution: '2K',
      layerCountMode: 'auto', targetLayerCount: 5, selection: { mode: 'whole' }, step: 'review',
      createdGroupId: 'existing-submitted-group', started: true };
    const replacement: LayeringPlan = { ...plan, layers: plan.layers.map(layer => layer.layerId === 'product-main'
      ? { ...layer, name: '新产品本体', description: '新分析的独立产品' } : layer) };
    let saved = original;
    let resolveAnalysis!: (value: LayeringPlan) => void;
    const onAnalyze = vi.fn(() => new Promise<LayeringPlan>(resolve => { resolveAnalysis = resolve; }));
    const onCreateGroup = vi.fn(async () => true), onStart = vi.fn(async () => true);
    render(<LayeringDialog sourceAsset={sourceAsset} profiles={[analysisProfile, gptImageProfile]} routeEvidence={routeEvidence}
      initialDraft={original} onDraftChange={value => { saved = value; }} onAnalyze={onAnalyze}
      onCreateGroup={onCreateGroup} onStart={onStart} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '重新分析' }));
    await waitFor(() => expect(onAnalyze).toHaveBeenCalledOnce());
    expect(saved).toMatchObject({ plan, createdGroupId: original.createdGroupId, started: true, step: 'review' });
    await act(async () => { resolveAnalysis(replacement); });
    expect(await screen.findByRole('textbox', { name: '图层说明 新产品本体' })).toHaveValue('新分析的独立产品');
    expect(saved).toMatchObject({ plan: replacement, createdGroupId: null, started: false, step: 'edit' });
    expect(onCreateGroup).not.toHaveBeenCalled();
    expect(onStart).not.toHaveBeenCalled();
  });
  it('ignores late analysis from a closed dialog so a reopened and edited draft survives another reopen', async () => {
    const original: LayeringDraft = { sourceAssetId: sourceAsset.assetId, plan,
      analysisRoute: 'comfly::vision-model', generationRoute: 'comfly::gpt-image-2', resolution: '2K',
      layerCountMode: 'auto', targetLayerCount: 5, selection: { mode: 'whole' }, step: 'review',
      createdGroupId: 'existing-submitted-group', started: true };
    const latePlan: LayeringPlan = { ...plan, layers: plan.layers.map(layer => layer.layerId === 'product-main'
      ? { ...layer, description: '旧弹窗迟到分析结果' } : layer) };
    let saved = original;
    let resolveAnalysis!: (value: LayeringPlan) => void;
    const onAnalyze = vi.fn(() => new Promise<LayeringPlan>(resolve => { resolveAnalysis = resolve; }));
    const onClose = vi.fn();
    const props = { sourceAsset, profiles: [analysisProfile, gptImageProfile], routeEvidence, onAnalyze,
      onCreateGroup: vi.fn(async () => true), onStart: vi.fn(async () => true), onClose,
      onDraftChange: (value: LayeringDraft) => { saved = value; } };
    const oldView = render(<LayeringDialog {...props} initialDraft={original} />);
    fireEvent.click(screen.getByRole('button', { name: '重新分析' }));
    await waitFor(() => expect(onAnalyze).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: '关闭 AI 图片分层' }));
    expect(onClose).toHaveBeenCalledOnce();
    oldView.unmount();
    const newView = render(<LayeringDialog {...props} initialDraft={saved} />);
    fireEvent.change(screen.getByRole('textbox', { name: '图层说明 产品本体' }), { target: { value: '重开后的最新手工说明' } });
    const latestDraft = saved;
    await act(async () => { resolveAnalysis(latePlan); });
    expect(saved).toEqual(latestDraft);
    expect(screen.getByRole('textbox', { name: '图层说明 产品本体' })).toHaveValue('重开后的最新手工说明');
    newView.unmount();
    render(<LayeringDialog {...props} initialDraft={saved} />);
    expect(screen.getByRole('textbox', { name: '图层说明 产品本体' })).toHaveValue('重开后的最新手工说明');
    expect(onAnalyze).toHaveBeenCalledOnce();
    expect(props.onCreateGroup).not.toHaveBeenCalled();
    expect(props.onStart).not.toHaveBeenCalled();
  });
  it('requires a selection for object mode and sends its target with analysis', async () => {
    const { onAnalyze } = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: '框选物品' }));
    expect(screen.getByRole('button', { name: '分析图片' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '选择整张图片范围' }));
    fireEvent.change(screen.getByRole('textbox', { name: '要提取的内容' }), { target: { value: '只要料理机，不要水果' } });
    fireEvent.click(screen.getByRole('button', { name: '分析图片' }));
    await waitFor(() => expect(onAnalyze).toHaveBeenCalledWith(expect.objectContaining({
      selection: { mode: 'objects', box: { x: 0, y: 0, width: 1, height: 1 }, target: '只要料理机，不要水果' },
    })));
    await screen.findByRole('list', { name: '可编辑分层方案' });
    fireEvent.click(screen.getByRole('button', { name: '框选区域' }));
    expect(screen.queryByRole('list', { name: '可编辑分层方案' })).not.toBeInTheDocument();
  });
  it('does not advertise Flare 4K when the 4K route is not configured', async () => {
    const flare = { ...gptImageProfile, modelRoute: 'comfly-gpt-image-2-5-flare', modelId: 'gpt-image-2.5-flare', displayName: 'GPT Image 2.5 Flare', constraints: { image: { resolutions: ['1K' as const] } } };
    render(<LayeringDialog sourceAsset={sourceAsset} profiles={[analysisProfile, flare]}
      onAnalyze={async () => plan} onCreateGroup={async () => true} onStart={async () => true} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '分析图片' }));
    await screen.findByRole('list', { name: '可编辑分层方案' });
    fireEvent.click(screen.getByRole('button', { name: '下一步：确认生成' }));
    expect(within(screen.getByRole('combobox', { name: '输出分辨率' })).queryByRole('option', { name: '4K' })).not.toBeInTheDocument();
  });
  it('offers Flare 4K from its configured variant and submits that exact route', async () => {
    const onStart = vi.fn(async () => true);
    const flare = { ...gptImageProfile, modelRoute: 'comfly-gpt-image-2-5-flare', modelId: 'gpt-image-2.5-flare', displayName: 'GPT Image 2.5 Flare', constraints: { image: { resolutions: ['1K' as const] } } };
    const flare4k = { ...flare, modelRoute: 'comfly-gpt-image-2-5-flare-4k', modelId: 'gpt-image-2.5-flare-4k', displayName: 'GPT Image 2.5 Flare 4K', constraints: { image: { resolutions: ['4K' as const] } } };
    render(<LayeringDialog sourceAsset={sourceAsset} profiles={[analysisProfile, flare, flare4k]}
      onAnalyze={async () => plan} onCreateGroup={async () => true} onStart={onStart} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '分析图片' }));
    await screen.findByRole('list', { name: '可编辑分层方案' });
    fireEvent.click(screen.getByRole('button', { name: '下一步：确认生成' }));
    const modelSelect = screen.getByRole('combobox', { name: 'GPT 图像模型' });
    expect(within(modelSelect).getAllByRole('option')).toHaveLength(1);
    expect(within(modelSelect).getByRole('option', { name: 'GPT Image 2.5 Flare · comfly' })).toBeInTheDocument();
    expect(within(screen.getByRole('combobox', { name: '输出分辨率' })).getByRole('option', { name: '4K' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: '输出分辨率' })).toHaveValue('4K');
    expect(within(screen.getByRole('region', { name: '生成确认摘要' })).getByText('GPT Image 2.5 Flare')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '确认生成 3 层' }));
    await waitFor(() => expect(onStart).toHaveBeenCalledWith(expect.objectContaining({ confirmation: expect.objectContaining({ modelRoute: 'comfly-gpt-image-2-5-flare-4k', resolution: '4K' }) })));
  });
  it('offers an exact Flare 4K variant when its catalog resolution field is omitted', async () => {
    const flare = { ...gptImageProfile, modelRoute: 'comfly-gpt-image-2-5-flare', modelId: 'gpt-image-2.5-flare', displayName: 'GPT Image 2.5 Flare', constraints: { image: { resolutions: ['1K' as const] } } };
    const flare4k = { ...flare, modelRoute: 'comfly-gpt-image-2-5-flare-4k', modelId: 'gpt-image-2.5-flare-4k', displayName: 'GPT Image 2.5 Flare 4K', constraints: undefined };
    render(<LayeringDialog sourceAsset={sourceAsset} profiles={[analysisProfile, flare, flare4k]}
      onAnalyze={async () => plan} onCreateGroup={async () => true} onStart={async () => true} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '分析图片' }));
    await screen.findByRole('list', { name: '可编辑分层方案' });
    fireEvent.click(screen.getByRole('button', { name: '下一步：确认生成' }));
    expect(within(screen.getByRole('combobox', { name: '输出分辨率' })).getByRole('option', { name: '4K' })).toBeInTheDocument();
  });
  it('keeps review visible while switching model and resolution, and confirms the exact new route', async () => {
    const onStart = vi.fn(async () => true);
    render(<LayeringDialog sourceAsset={sourceAsset} profiles={[analysisProfile, gptImageProfile,
      { ...gptImageProfile, modelRoute: 'gpt-image-2.5-sunburst-4k', modelId: 'gpt-image-2.5-sunburst-4k', displayName: 'GPT Image Sunburst 4K', constraints: { image: { resolutions: ['4K'] } } }]}
      onAnalyze={async () => plan} onCreateGroup={async () => true} onStart={onStart} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '分析图片' }));
    await screen.findByRole('list', { name: '可编辑分层方案' });
    fireEvent.click(screen.getByRole('button', { name: '下一步：确认生成' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'GPT 图像模型' }), { target: { value: 'comfly::gpt-image-2.5-sunburst-4k' } });
    expect(screen.getByRole('region', { name: '生成确认摘要' })).toBeVisible();
    await waitFor(() => expect(screen.getByRole('combobox', { name: '输出分辨率' })).toHaveValue('4K'));
    fireEvent.click(screen.getByRole('button', { name: '确认生成 3 层' }));
    await waitFor(() => expect(onStart).toHaveBeenCalledWith(expect.objectContaining({ confirmation: expect.objectContaining({ modelRoute: 'gpt-image-2.5-sunburst-4k', resolution: '4K' }) })));
  });
  it('separates vision analysis from generation and requires an explicit review before starting GPT jobs', async () => {
    const { onAnalyze, onCreateGroup, onStart } = renderDialog();

    expect(screen.getByRole('dialog', { name: 'AI 图片分层' })).toBeVisible();
    expect(screen.getByRole('img', { name: '分层源图：源图' })).toHaveAttribute('src', sourceAsset.displayUrl);
    fireEvent.click(screen.getByRole('button', { name: '分析图片' }));

    await screen.findByRole('list', { name: '可编辑分层方案' });
    expect(screen.queryByText('图层名称 背景')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: '图层说明 产品本体' })).toHaveValue('产品可见像素，不包含投影。');
    expect(onAnalyze).toHaveBeenCalledWith(expect.objectContaining({
      sourceAssetId: sourceAsset.assetId, provider: 'comfly', modelRoute: 'vision-model', width: 1200, height: 900,
    }));
    expect(onCreateGroup).not.toHaveBeenCalled();
    expect(onStart).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '下一步：确认生成' }));
    expect(screen.getByRole('region', { name: '生成确认摘要' })).toHaveTextContent('GPT Image 2');
    expect(screen.getByRole('region', { name: '生成确认摘要' })).toHaveTextContent('2K');
    expect(screen.getByRole('region', { name: '生成确认摘要' })).toHaveTextContent('3 层');
    fireEvent.click(screen.getByRole('button', { name: '确认生成 3 层' }));

    await waitFor(() => expect(onCreateGroup).toHaveBeenCalledOnce());
    await waitFor(() => expect(onStart).toHaveBeenCalledOnce());
    expect(onCreateGroup.mock.calls[0]?.[0]).toMatchObject({ plan, groupId: expect.any(String) });
    expect(onStart.mock.calls[0]?.[0]).toMatchObject({ plan, groupId: expect.any(String) });
  });

  it('invalidates edited plans but offers configured GPT routes without developer QA evidence', async () => {
    const { onCreateGroup, onStart, view } = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: '分析图片' }));
    const list = await screen.findByRole('list', { name: '可编辑分层方案' });
    fireEvent.click(screen.getByRole('button', { name: '下一步：确认生成' }));
    expect(screen.getByRole('button', { name: '确认生成 3 层' })).toBeEnabled();

    fireEvent.change(within(list).getByRole('textbox', { name: '图层名称 产品本体' }), { target: { value: '主产品' } });
    expect(screen.queryByRole('region', { name: '生成确认摘要' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '下一步：确认生成' })).toBeVisible();
    expect(onCreateGroup).not.toHaveBeenCalled();
    expect(onStart).not.toHaveBeenCalled();

    view.unmount();
    const unverifiedView = render(<LayeringDialog sourceAsset={sourceAsset} profiles={[analysisProfile, gptImageProfile]} onAnalyze={vi.fn(async (_input: { sourceAssetId: string; provider: ProviderBridgeProfile['provider']; modelRoute: string; width: number; height: number }) => plan)} onCreateGroup={vi.fn(async (_input: { plan: LayeringPlan; confirmation: LayeringConfirmation; groupId: string }) => true)} onStart={vi.fn(async (_input: { plan: LayeringPlan; confirmation: LayeringConfirmation; groupId: string }) => true)} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '分析图片' }));
    await screen.findByRole('list', { name: '可编辑分层方案' });
    fireEvent.click(screen.getByRole('button', { name: '下一步：确认生成' }));
    expect(screen.getByRole('combobox', { name: 'GPT 图像模型' })).toBeEnabled();
    expect(screen.getByRole('combobox', { name: 'GPT 图像模型' })).toHaveValue('comfly::gpt-image-2');
    expect(screen.getByRole('button', { name: '确认生成 3 层' })).toBeEnabled();
    unverifiedView.unmount();
  });

  it('reports that a managed source image is required and restores focus after closing', async () => {
    const returnFocus = document.createElement('button');
    returnFocus.textContent = 'open layering';
    document.body.append(returnFocus);
    returnFocus.focus();
    const onClose = vi.fn();
    const view = render(<LayeringDialog sourceAsset={null} profiles={[analysisProfile]} onAnalyze={vi.fn(async (_input: { sourceAssetId: string; provider: ProviderBridgeProfile['provider']; modelRoute: string; width: number; height: number }) => plan)} onCreateGroup={vi.fn(async (_input: { plan: LayeringPlan; confirmation: LayeringConfirmation; groupId: string }) => true)} onStart={vi.fn(async (_input: { plan: LayeringPlan; confirmation: LayeringConfirmation; groupId: string }) => true)} onClose={onClose} />);
    expect(screen.getByText('请先在画布中选择一个可用的项目图片。')).toBeVisible();
    expect(screen.getByRole('button', { name: '分析图片' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '关闭 AI 图片分层' }));
    view.unmount();
    await waitFor(() => expect(returnFocus).toHaveFocus());
    expect(onClose).toHaveBeenCalledOnce();
    returnFocus.remove();
  });

  it('offers intelligent or custom counts before analysis and passes the selected target', async () => {
    const { onAnalyze } = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: '自定义层数' }));
    fireEvent.change(screen.getByRole('slider', { name: '目标图层数' }), { target: { value: '7' } });
    expect(screen.getByText('7 层')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '分析图片' }));
    await waitFor(() => expect(onAnalyze).toHaveBeenCalledWith(expect.objectContaining({ mode: 'custom', targetLayerCount: 7 })));
  });

  it('blocks generic layer names until each foreground identifies a concrete object or shadow', async () => {
    const genericPlan: LayeringPlan = { ...plan, layers: plan.layers.map((layer) => layer.layerId === 'product-main'
      ? { ...layer, name: '主体' }
      : layer) };
    renderDialog(genericPlan);
    fireEvent.click(screen.getByRole('button', { name: '分析图片' }));
    await screen.findByRole('list', { name: '可编辑分层方案' });

    expect(screen.getByRole('alert')).toHaveTextContent('请将通用图层名改成具体产品、摆件或对应阴影名称');
    expect(screen.getByRole('button', { name: '下一步：确认生成' })).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox', { name: '图层名称 主体' }), { target: { value: '蓝色产品本体' } });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '下一步：确认生成' })).toBeEnabled();
  });

  it('lets the user refine layer instructions and carries the edited text into confirmation', async () => {
    const { onCreateGroup } = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: '分析图片' }));
    const list = await screen.findByRole('list', { name: '可编辑分层方案' });
    fireEvent.change(within(list).getByRole('textbox', { name: '图层说明 左侧玻璃花瓶' }), {
      target: { value: '仅保留左侧花瓶玻璃和花枝；花瓶后方的台面属于背景，投影单独一层。' },
    });
    fireEvent.click(screen.getByRole('button', { name: '下一步：确认生成' }));
    fireEvent.click(screen.getByRole('button', { name: '确认生成 3 层' }));

    await waitFor(() => expect(onCreateGroup).toHaveBeenCalledOnce());
    expect(onCreateGroup.mock.calls[0]?.[0].plan.layers[2]?.description)
      .toBe('仅保留左侧花瓶玻璃和花枝；花瓶后方的台面属于背景，投影单独一层。');
  });

  it('returns the review panel to its start after a re-analysis inserts a new plan', async () => {
    renderDialog();
    fireEvent.click(screen.getByRole('button', { name: '分析图片' }));
    await screen.findByRole('list', { name: '可编辑分层方案' });
    const controls = document.querySelector<HTMLElement>('.image-layering-dialog__controls')!;
    controls.scrollTop = 180;

    fireEvent.click(screen.getByRole('button', { name: '重新分析' }));
    await waitFor(() => expect(controls.scrollTop).toBe(0));
  });
});
