import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { ReactFlowProvider } from '@xyflow/react';
import { createCanvasModuleNode, type ModelJob } from '@agent-canvas/domain';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetAppStoreForTests, useAppStore } from '../app/app-store';
import { ModuleNodeCard } from './ModuleNodeCard';
import { imageColorCorrectionFilter, type ImageColorCorrection } from '../app/image-color-correction';

const prompt = '保留原始机位与比例；人物分开处理，完整提示词在运行中仍可查看。';
const image = {
  assetId: '0123456789abcdef', byteSize: 42,
  displayUrl: 'novus-asset://project/session/0123456789abcdef',
  extension: 'png' as const, width: 1200, height: 800, label: '上一张结果',
  mediaType: 'image/png' as const, origin: 'generated' as const,
  sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', usageCount: 1,
};
const referenceImage = {
  ...image, assetId: 'fedcba9876543210',
  displayUrl: 'novus-asset://project/session/fedcba9876543210',
  label: '原始参考素材', origin: 'imported' as const,
};
const previousVideo = { ...image, assetId: 'abcdef0123456789', displayUrl: 'novus-asset://project/session/abcdef0123456789',
  extension: 'mp4' as const, label: '上一段视频', mediaType: 'video/mp4' as const, durationMs: 4000, origin: 'imported' as const };

beforeEach(() => {
  resetAppStoreForTests();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-30T08:00:12.000Z'));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function renderRunningNode(kind: 'image' | 'video', status: ModelJob['status'], withPreviousResult = false, withReference = false,
  extraConfig: Record<string, unknown> = {}) {
  const moduleType = kind === 'image' ? 'image_generation' : 'video_generation';
  const node = createCanvasModuleNode(`running-${kind}`, moduleType, { x: 0, y: 0 });
  node.data.config = {
    ...node.data.config, prompt, modelRoute: 'qa-model',
    ...(withPreviousResult ? { resultState: 'fresh', ...(kind === 'image' ? { resultAssetIds: [image.assetId] }
      : { videoResults: [{ assetId: previousVideo.assetId, mediaType: 'video/mp4', durationMs: 4000, posterAssetId: image.assetId }] }) } : {}),
    ...extraConfig,
  };
  const job: ModelJob = {
    id: `${kind}-task`, kind, modelId: 'qa-model', promptNodeId: node.id,
    status, prompt, retryCount: 0, referenceAssetIds: withReference ? [referenceImage.assetId] : [],
    createdAt: '2026-09-30T08:00:00.000Z', startedAt: '2026-09-30T08:00:00.000Z',
    providerTaskId: status === 'running' ? 'qa-upstream-task' : undefined,
    projectId: useAppStore.getState().project.id,
  };
  useAppStore.setState(state => ({
    project: { ...state.project, nodes: [node], assets: withPreviousResult ? [image, ...(kind === 'video' ? [previousVideo] : [])] : [] }, modelJobs: [job],
    projectImages: [...(withPreviousResult ? [image] : []), ...(withReference ? [referenceImage] : [])],
    projectVideos: kind === 'video' && withPreviousResult ? [previousVideo] : [],
  }));
  const rendered = render(<ReactFlowProvider><ModuleNodeCard id={node.id} data={node.data} selected={false} /></ReactFlowProvider>);
  fireEvent.click(screen.getByRole('button', {
    name: kind === 'image' ? 'Open image generation editor' : 'Open video generation editor',
  }));
  return { node, job, ...rendered };
}

describe('generation progress inside the existing node preview', () => {
  it.each([
    ['image', 'queued', '等待提交'],
    ['image', 'submitting', '正在提交任务'],
    ['image', 'running', '正在生成'],
    ['video', 'queued', '等待提交'],
    ['video', 'submitting', '正在提交任务'],
    ['video', 'running', '正在生成视频'],
  ] as const)('shows the actual %s %s stage while retaining the full prompt and stop action', (kind, status, label) => {
    renderRunningNode(kind, status);
    const progress = screen.getByRole('status', { name: kind === 'image' ? '图片生成进度' : '视频生成进度' });
    expect(progress).toHaveTextContent(label);
    expect(progress).not.toHaveTextContent(/\d+%|预计|保存结果|上传素材/u);
    expect(screen.getByRole('textbox', {
      name: kind === 'image' ? 'Image generation prompt' : 'Video preview prompt',
    })).toHaveValue(prompt);
    expect(screen.getByRole('button', { name: '停止生成' })).toBeEnabled();
    if (kind === 'video') expect(screen.queryByText('生成的视频将在这里显示')).not.toBeInTheDocument();
  });

  it('keeps the previous image available while a new task is running', () => {
    renderRunningNode('image', 'running', true);
    const preview = screen.getByRole('button', { name: 'Generated image 1; double click to preview' });
    expect(preview.querySelector('img')).toHaveAttribute('src', image.displayUrl);
    expect(screen.getByRole('status', { name: '图片生成进度' })).toHaveTextContent('正在生成');
    expect(screen.getByText('上一张结果保留')).toBeInTheDocument();
  });

  it('hydrates the managed previous preview with that asset’s own custom color correction while current results are pending', () => {
    const correction: ImageColorCorrection = { version: 2, mode: 'custom', contrast: 95,
      saturation: 108, temperature: 12, tint: -4, brightness: 103 };
    renderRunningNode('image', 'running', true, false, { resultState: 'pending', resultAssetIds: [],
      previousResultAssetIds: [image.assetId], imageColorCorrections: { [image.assetId]: correction } });
    const preview = screen.getByRole('img', { name: 'Generated image 1' });
    expect(preview).toHaveAttribute('src', image.displayUrl);
    expect(preview.style.filter).toBe(imageColorCorrectionFilter(correction, 'image-color-correction-running-image-0'));
    expect(screen.getByRole('status', { name: '图片生成进度' })).toHaveTextContent('上一张结果保留');
    const storedNode = useAppStore.getState().project.nodes[0];
    if (storedNode?.type !== 'module') throw new Error('Missing module fixture');
    expect(storedNode.data.config).toMatchObject({ resultState: 'pending', resultAssetIds: [] });
  });

  it('hydrates a legacy correction onto the previous asset when pending current IDs are empty', () => {
    const correction: ImageColorCorrection = { version: 2, mode: 'custom', contrast: 95,
      saturation: 108, temperature: 12, tint: -4, brightness: 103 };
    renderRunningNode('image', 'running', true, false, { resultState: 'pending', resultAssetIds: [],
      previousResultAssetIds: [image.assetId], colorCorrection: correction });
    const preview = screen.getByRole('img', { name: 'Generated image 1' });
    expect(preview).toHaveAttribute('src', image.displayUrl);
    expect(preview.style.filter).toBe(imageColorCorrectionFilter(correction, 'image-color-correction-running-image-0'));
  });

  it.each(['image', 'video'] as const)('sizes the single %s previous result from its own dimensions without decorative copies', kind => {
    renderRunningNode(kind, 'running', true, true);
    const card = screen.getByTestId('module-node-card');
    expect(card).toHaveAttribute('data-preview-sizing', 'media');
    expect(Number.parseFloat(card.style.getPropertyValue('--generation-preview-height'))).toBeCloseTo(676 * image.height / image.width);
    expect(document.querySelector('.module-node__running-result-fill')).toBeNull();
    expect(screen.queryByRole('img', { name: '本次任务参考素材' })).not.toBeInTheDocument();
  });

  it('keeps elapsed time updating separately and removes the running preview after cancellation', () => {
    const { job } = renderRunningNode('video', 'running');
    expect(screen.getByRole('status', { name: '视频生成进度' })).toHaveTextContent('正在生成视频');
    const timing = screen.getByLabelText('Video generation task timing');
    expect(timing).toHaveTextContent('生成中 · 12秒');
    act(() => vi.advanceTimersByTime(2_000));
    expect(timing).toHaveTextContent('生成中 · 14秒');
    act(() => useAppStore.setState({ modelJobs: [{ ...job, status: 'cancelled', updatedAt: '2026-09-30T08:00:14.000Z' }] }));
    expect(screen.queryByRole('status', { name: '视频生成进度' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Video generation task timing')).toHaveTextContent('已取消 · 14秒');
    expect(screen.getByRole('button', { name: '生成视频' })).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(2_000));
    expect(screen.getByLabelText('Video generation task timing')).toHaveTextContent('已取消 · 14秒');
  });

  it.each(['image', 'video'] as const)('labels the actual %s job reference in the running preview', kind => {
    renderRunningNode(kind, 'running', false, true);
    const progress = screen.getByRole('status', { name: kind === 'image' ? '图片生成进度' : '视频生成进度' });
    expect(progress).toHaveTextContent('参考素材');
    expect(screen.getByRole('img', { name: '本次任务参考素材' })).toHaveAttribute('src', referenceImage.displayUrl);
    const card = screen.getByTestId('module-node-card');
    expect(card).toHaveAttribute('data-preview-sizing', 'media');
    expect(Number.parseFloat(card.style.getPropertyValue('--generation-preview-height'))).toBeCloseTo(676 * referenceImage.height / referenceImage.width);
    expect(document.querySelector('.module-node__running-reference-fill')).toBeNull();
  });

  it('never overlays a job reference over an existing generated result', () => {
    renderRunningNode('image', 'running', true, true);
    const preview = screen.getByRole('button', { name: 'Generated image 1; double click to preview' });
    expect(preview.querySelector('img')).toHaveAttribute('src', image.displayUrl);
    expect(screen.queryByRole('img', { name: '本次任务参考素材' })).not.toBeInTheDocument();
    expect(screen.getByRole('status', { name: '图片生成进度' })).toHaveTextContent('上一张结果保留');
  });

  it.each(['image', 'video'] as const)('does not substitute an unsafe %s job reference URL', kind => {
    renderRunningNode(kind, 'running', false, true);
    act(() => useAppStore.setState({
      projectImages: [{ ...referenceImage, displayUrl: 'https://external.invalid/untracked.png' }],
    }));
    expect(screen.getByRole('status', { name: kind === 'image' ? '图片生成进度' : '视频生成进度' })).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: '本次任务参考素材' })).not.toBeInTheDocument();
    expect(screen.getByTestId('module-node-card')).not.toHaveAttribute('data-preview-sizing');
  });

  it.each(['image', 'video'] as const)('updates the %s preview for portrait dimensions and actual decoded media without clamping the ratio', kind => {
    renderRunningNode(kind, 'running', false, true);
    const card = screen.getByTestId('module-node-card');
    act(() => useAppStore.setState({ projectImages: [{ ...referenceImage, width: 900, height: 1600 }] }));
    expect(Number.parseFloat(card.style.getPropertyValue('--generation-preview-height'))).toBeCloseTo(676 * 1600 / 900);
    const reference = screen.getByRole('img', { name: '本次任务参考素材' });
    Object.defineProperties(reference, { naturalWidth: { value: 1000 }, naturalHeight: { value: 2200 } });
    fireEvent.load(reference);
    expect(Number.parseFloat(card.style.getPropertyValue('--generation-preview-height'))).toBeCloseTo(676 * 2200 / 1000);
    expect(card.style.getPropertyValue('--generation-preview-aspect-ratio')).toBe('1000 / 2200');
  });

  it.each(['image', 'video'] as const)('clears decoded %s reference dimensions after cancellation when the legacy asset metadata is missing', kind => {
    const { job } = renderRunningNode(kind, 'running', false, true);
    act(() => useAppStore.setState({ projectImages: [{ ...referenceImage, width: null, height: null }] }));
    const reference = screen.getByRole('img', { name: '本次任务参考素材' });
    Object.defineProperties(reference, { naturalWidth: { value: 900 }, naturalHeight: { value: 1600 } });
    fireEvent.load(reference);
    expect(screen.getByTestId('module-node-card')).toHaveAttribute('data-preview-sizing', 'media');
    act(() => useAppStore.setState({ modelJobs: [{ ...job, status: 'cancelled' }] }));
    expect(screen.getByTestId('module-node-card')).not.toHaveAttribute('data-preview-sizing');
  });

  it('clears a decoded portrait result size when switching to a multi-image gallery with missing dimensions', () => {
    const { node, rerender } = renderRunningNode('image', 'running', true);
    const assets = [{ ...image, width: null, height: null }, { ...referenceImage, width: null, height: null }];
    act(() => useAppStore.setState(state => ({ project: { ...state.project, assets }, projectImages: assets })));
    const preview = screen.getByRole('img', { name: 'Generated image 1' });
    Object.defineProperties(preview, { naturalWidth: { value: 900 }, naturalHeight: { value: 1600 } });
    fireEvent.load(preview);
    expect(screen.getByTestId('module-node-card')).toHaveAttribute('data-preview-sizing', 'media');
    node.data = { ...node.data, config: { ...node.data.config, resultAssetIds: assets.map(asset => asset.assetId) } };
    rerender(<ReactFlowProvider><ModuleNodeCard id={node.id} data={node.data} selected={false} /></ReactFlowProvider>);
    expect(screen.getByRole('img', { name: 'Generated image 2' })).toBeInTheDocument();
    expect(screen.getByTestId('module-node-card')).not.toHaveAttribute('data-preview-sizing');
  });

  it('resets decoded size before displaying a different result whose metadata also has no dimensions', () => {
    const { node, rerender } = renderRunningNode('image', 'running', true);
    const assets = [{ ...image, width: null, height: null }, { ...referenceImage, width: null, height: null }];
    act(() => useAppStore.setState(state => ({ project: { ...state.project, assets }, projectImages: assets })));
    const preview = screen.getByRole('img', { name: 'Generated image 1' });
    Object.defineProperties(preview, { naturalWidth: { value: 900 }, naturalHeight: { value: 1600 } });
    fireEvent.load(preview);
    expect(screen.getByTestId('module-node-card')).toHaveAttribute('data-preview-sizing', 'media');
    node.data = { ...node.data, config: { ...node.data.config, resultAssetIds: [referenceImage.assetId] } };
    rerender(<ReactFlowProvider><ModuleNodeCard id={node.id} data={node.data} selected={false} /></ReactFlowProvider>);
    expect(screen.getByRole('img', { name: 'Generated image 1' })).toHaveAttribute('src', referenceImage.displayUrl);
    expect(screen.getByTestId('module-node-card')).not.toHaveAttribute('data-preview-sizing');
  });
});
