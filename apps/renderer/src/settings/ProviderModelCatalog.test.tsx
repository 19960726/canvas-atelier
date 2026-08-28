import { cleanup, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it } from 'vitest';

import { ProviderModelCatalog } from './ProviderModelCatalog';

afterEach(cleanup);

describe('ProviderModelCatalog', () => {
  it('uses one compact empty state instead of six empty capability cards', () => {
    render(<ProviderModelCatalog profiles={[]} onConfigure={() => undefined} onRetry={() => undefined} />);

    expect(screen.getByRole('region', { name: '模型目录为空' })).toBeVisible();
    expect(screen.getByRole('button', { name: '配置模型密钥' })).toBeVisible();
    expect(screen.getByRole('button', { name: '重新检测模型' })).toBeVisible();
    expect(screen.queryAllByText(/当前供应商目录没有明确声明可用的/u)).toHaveLength(0);
    expect(screen.queryByRole('region', { name: '生图模型' })).not.toBeInTheDocument();
  });

  it('renders each model row as only a checkbox and the model name', () => {
    render(<ProviderModelCatalog profiles={[
      { provider: 'comfly', modelRoute: 'image/edit', displayName: 'Seedream V5 Pro', modelId: 'seedream-v5-pro', capabilities: ['image_generation'], constraints: { image: { resolutions: ['2K', '4K'], outputCounts: [1, 2, 3, 4] } } },
    ]} />);

    const imageGroup = screen.getByRole('region', { name: '生图模型' });
    const modelRow = within(imageGroup).getByRole('listitem');
    expect(modelRow).toHaveTextContent('Seedream V5 Pro');
    expect(within(modelRow).queryByText('模型')).not.toBeInTheDocument();
    expect(within(modelRow).queryByText('2K / 4K')).not.toBeInTheDocument();
    expect(within(modelRow).queryByText('1/2/3/4 张')).not.toBeInTheDocument();
  });

  it('renders canvas-style capability cards with a default model badge', () => {
    const profile = { provider: 'relayme' as const, modelRoute: 'image/generate', displayName: 'GPT Image 2', modelId: 'gpt-image-2', capabilities: ['image_generation' as const] };
    render(<ProviderModelCatalog profiles={[profile]} defaultProfileKeys={{ image_generation: 'relayme:image/generate' }} />);

    const group = screen.getByRole('region', { name: '生图模型' });
    expect(group).toHaveAttribute('data-capability', 'image_generation');
    expect(within(group).getByText('IMG')).toBeVisible();
    expect(within(group).getByText('默认')).toBeVisible();
  });

  it('renders a repeated visible model name only once inside each capability group', () => {
    render(<ProviderModelCatalog profiles={[
      { provider: 'comfly', modelRoute: 'image/stable', displayName: 'Nano Banana 2', capabilities: ['image_generation'] },
      { provider: 'relayme', modelRoute: 'image/alias', displayName: 'Nano Banana 2', capabilities: ['image_generation'] },
    ]} />);

    const imageGroup = screen.getByRole('region', { name: '生图模型' });
    expect(within(imageGroup).getAllByText('Nano Banana 2')).toHaveLength(1);
  });
  it('classifies models from declared capabilities and shows model-only labels', () => {
    render(<ProviderModelCatalog profiles={[
      { provider: 'comfly', modelRoute: 'image/edit', displayName: 'Comfly Image', modelId: 'image-a', capabilities: ['image_generation'], constraints: { image: { resolutions: ['1K', '2K', '4K'] } } },
      { provider: 'relayme', modelRoute: 'video/generate', displayName: 'Relay Video', modelId: 'video-a', capabilities: ['video_generation'], constraints: { video: { aspectRatios: ['16:9', '9:16'], outputCounts: [1, 2] } } },
      { provider: 'relayme', modelRoute: 'chat/general', displayName: 'Relay Chat', modelId: 'chat-a', capabilities: ['chat'] },
      { provider: 'comfly', modelRoute: 'reverse/vision', displayName: 'Comfly Reverse', modelId: 'reverse-a', capabilities: ['reverse_prompt', 'vision'] },
      { provider: 'relayme', modelRoute: 'understand/video', displayName: 'Relay Video Understanding', modelId: 'video-understanding-a', capabilities: ['chat', 'video_understanding'] },
      { provider: 'relayme', modelRoute: 'misleading-name', displayName: 'Gemini Video Vision', modelId: 'text-only', capabilities: ['chat'], capabilityStatus: 'incomplete' },
    ]} />);

    const image = screen.getByRole('region', { name: '生图模型' });
    const video = screen.getByRole('region', { name: '视频模型' });
    const chat = screen.getByRole('region', { name: '对话模型' });
    const reverse = screen.getByRole('region', { name: '反推模型' });
    const vision = screen.getByRole('region', { name: '视觉模型' });
    const videoUnderstanding = screen.getByRole('region', { name: '视频理解模型' });

    expect(within(image).getByText('Comfly Image')).toBeVisible();
    expect(within(video).getByText('Relay Video')).toBeVisible();
    expect(within(chat).getByText('Relay Chat')).toBeVisible();
    expect(within(chat).getByText('Gemini Video Vision')).toBeVisible();
    expect(within(reverse).getByText('Comfly Reverse')).toBeVisible();
    expect(within(vision).getByText('Comfly Reverse')).toBeVisible();
    expect(within(videoUnderstanding).getByText('Relay Video Understanding')).toBeVisible();
    expect(within(video).queryByText('Gemini Video Vision')).toBeNull();
    expect(within(reverse).queryByText('Gemini Video Vision')).toBeNull();
    expect(screen.queryByText('RelayMe')).not.toBeInTheDocument();
    expect(screen.queryByText('Comfly')).not.toBeInTheDocument();
    expect(screen.queryByText(/RelayMe ·|Comfly ·/u)).not.toBeInTheDocument();
    expect(screen.queryByText('2K / 4K')).not.toBeInTheDocument();
    expect(screen.queryByText('能力信息不完整')).not.toBeInTheDocument();
  });
});
