import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProviderBridgeProfile } from '@agent-canvas/desktop-core';
import type { LayeringConfirmation, LayeringPlan } from '../app/layering-plan';
import type { LayeringRouteEvidence } from '../app/layering-route-evidence';
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
