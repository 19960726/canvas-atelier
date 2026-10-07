import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProviderModelCatalog, ProviderModelDefaults, type CatalogCapability, type ProviderModelCatalogProps } from './ProviderModelCatalog';

afterEach(cleanup);

describe('ProviderModelCatalog', () => {
  it('can hide its default selector while keeping family enable actions available', () => {
    const profile = { provider: 'comfly' as const, modelRoute: 'image/gpt-2', displayName: 'GPT Image 2', capabilities: ['image_generation' as const] };
    const onToggleFamily = vi.fn();
    render(<ProviderModelCatalog profiles={[profile]} defaultProfileKeys={{ image_generation: 'comfly:image/gpt-2' }} showDefaultSelection={false} showSummary={false} onToggleFamily={onToggleFamily} onDefaultProfileChange={() => undefined} />);

    expect(screen.queryByRole('combobox', { name: '生图默认模型' })).not.toBeInTheDocument();
    expect(screen.queryByText('模型目录')).not.toBeInTheDocument();
    expect(screen.getByText('当前默认模型')).toBeVisible();
    fireEvent.click(screen.getByRole('checkbox', { name: '启用 GPT Image 2' }));
    expect(onToggleFamily).toHaveBeenCalledWith([profile], false);
  });
  it('shows provider aliases with the same friendly image name as one selectable series', () => {
    const profiles = [
      { provider: 'comfly' as const, modelRoute: 'banana', modelId: 'nano-banana-2', displayName: 'Nano Banana 2', capabilities: ['image_generation' as const] },
      { provider: 'comfly' as const, modelRoute: 'gemini', modelId: 'gemini-3.1-flash-image-preview', displayName: 'Nano Banana 2', capabilities: ['image_generation' as const] },
    ];
    const onToggleFamily = vi.fn();
    render(<ProviderModelCatalog profiles={profiles} onToggleFamily={onToggleFamily} />);
    const group = screen.getByRole('region', { name: '生图模型' });
    expect(within(group).getAllByRole('listitem')).toHaveLength(1);
    fireEvent.click(within(group).getByRole('checkbox', { name: '启用 Nano Banana 2' }));
    expect(onToggleFamily).toHaveBeenCalledWith(profiles, false);
  });
  it('shows image resolution variants once and enables the whole family', () => {
    const onToggleFamily = vi.fn();
    const profiles = [
      { provider: 'comfly' as const, modelRoute: 'flare', modelId: 'gpt-image-2.5-flare', displayName: 'GPT Image 2.5 Flare', capabilities: ['image_generation' as const] },
      { provider: 'comfly' as const, modelRoute: 'flare-2k', modelId: 'gpt-image-2.5-flare-2k', displayName: 'GPT Image 2.5 Flare 2K', capabilities: ['image_generation' as const] },
      { provider: 'comfly' as const, modelRoute: 'flare-4k', modelId: 'gpt-image-2.5-flare-4k', displayName: 'GPT Image 2.5 Flare 4K', capabilities: ['image_generation' as const] },
    ];
    render(<ProviderModelCatalog profiles={profiles} enabledProfileKeys={profiles.map((profile) => `comfly:${profile.modelRoute}`)} defaultProfileKeys={{ image_generation: 'comfly:flare-4k' }} onToggleFamily={onToggleFamily} onDefaultProfileChange={() => undefined} />);
    const group = screen.getByRole('region', { name: '生图模型' });
    expect(within(group).getAllByRole('listitem')).toHaveLength(1);
    expect(within(within(group).getByRole('listitem')).getByText('GPT Image 2.5 Flare')).toBeVisible();
    expect(within(group).queryByText('GPT Image 2.5 Flare 4K')).not.toBeInTheDocument();
    expect(within(group).getByRole('combobox', { name: '生图默认模型' })).toHaveValue('comfly:flare');
    fireEvent.click(within(group).getByRole('checkbox', { name: '启用 GPT Image 2.5 Flare' }));
    expect(onToggleFamily).toHaveBeenCalledWith(profiles, false);
  });
  it('filters a long model list by name without hiding the selected default route', () => {
    render(<ProviderModelCatalog profiles={[
      { provider: 'comfly', modelRoute: 'image/gpt-2', displayName: 'GPT Image 2', capabilities: ['image_generation'] },
      { provider: 'comfly', modelRoute: 'image/banana', displayName: 'Nano Banana 2', capabilities: ['image_generation'] },
    ]} defaultProfileKeys={{ image_generation: 'comfly:image/gpt-2' }} onDefaultProfileChange={() => undefined} />);
    fireEvent.change(screen.getByRole('searchbox', { name: '搜索当前分类模型' }), { target: { value: 'banana' } });
    const group = screen.getByRole('region', { name: '生图模型' });
    expect(within(group).getAllByRole('listitem')).toHaveLength(1);
    expect(within(within(group).getByRole('listitem')).getByText('Nano Banana 2')).toBeVisible();
    expect(within(group).getByRole('combobox', { name: '生图默认模型' })).toHaveValue('comfly:image/gpt-2');
  });
  it('uses a compact capability tab bar and renders one model workspace at a time', () => {
    render(<ProviderModelCatalog profiles={[
      { provider: 'comfly', modelRoute: 'image/gpt-image-2', displayName: 'GPT Image 2', capabilities: ['image_generation'] },
      { provider: 'comfly', modelRoute: 'video/veo-3.1', displayName: 'Veo 3.1', capabilities: ['video_generation'] },
    ]} />);

    const tabs = screen.getByRole('tablist', { name: '模型能力分类' });
    expect(within(tabs).getByRole('tab', { name: /生图模型/u })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('region', { name: '生图模型' })).toBeVisible();
    expect(screen.queryByRole('region', { name: '视频模型' })).not.toBeInTheDocument();

    fireEvent.click(within(tabs).getByRole('tab', { name: /视频模型/u }));
    expect(screen.getByRole('region', { name: '视频模型' })).toBeVisible();
    expect(screen.queryByRole('region', { name: '生图模型' })).not.toBeInTheDocument();
  });
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
    expect(screen.getByRole('tab', { name: /生图模型/u })).toHaveAttribute('aria-selected', 'true');
    expect(within(group).getByText('默认')).toBeVisible();
  });

  it('shows incomplete generation routes as protocol-pending and prevents enabling or defaulting them', () => {
    const verified = {
      provider: '4dai' as const,
      modelRoute: 'image/gpt-image-1.5',
      displayName: 'GPT Image 1.5',
      modelId: 'gpt-image-1.5',
      capabilities: ['image_generation' as const],
      capabilityStatus: 'complete' as const,
    };
    const pending = {
      provider: '4dai' as const,
      modelRoute: 'openai/gpt-image-2-4k',
      displayName: 'GPT Image 2 4K',
      modelId: 'gpt-image-2-4k',
      capabilities: ['image_generation' as const],
      capabilityStatus: 'incomplete' as const,
    };
    render(<ProviderModelCatalog
      profiles={[verified, pending]}
      enabledProfileKeys={[
        '4dai:image/gpt-image-1.5',
        '4dai:openai/gpt-image-2-4k',
      ]}
      onToggleProfile={() => undefined}
      onDefaultProfileChange={() => undefined}
    />);

    const group = screen.getByRole('region', { name: '生图模型' });
    const pendingRow = within(group).getAllByRole('listitem')
      .find((row) => within(row).queryByText('GPT Image 2') !== null);
    expect(pendingRow).toBeDefined();
    expect(within(pendingRow!).getByText('协议待验证')).toBeVisible();
    expect(within(pendingRow!).getByRole('checkbox', { name: '启用 GPT Image 2' })).toBeDisabled();
    expect(within(group).getByText('2 个可用 · 1 个已启用')).toBeVisible();

    const defaultSelect = within(group).getByRole('combobox', { name: '生图默认模型' });
    expect(within(defaultSelect).getByRole('option', { name: 'GPT Image 1.5' })).toBeVisible();
    expect(within(defaultSelect).queryByRole('option', { name: 'GPT Image 2' })).not.toBeInTheDocument();
  });

  it('keeps equal visible names isolated when profiles from different providers are supplied', () => {
    render(<ProviderModelCatalog profiles={[
      { provider: 'comfly', modelRoute: 'image/stable', displayName: 'Nano Banana 2', capabilities: ['image_generation'] },
      { provider: 'relayme', modelRoute: 'image/alias', displayName: 'Nano Banana 2', capabilities: ['image_generation'] },
    ]} />);

    const imageGroup = screen.getByRole('region', { name: '生图模型' });
    expect(within(imageGroup).getAllByText('Nano Banana 2')).toHaveLength(2);
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

    const selectGroup = (label: string) => {
      fireEvent.click(screen.getByRole('tab', { name: new RegExp(label, 'u') }));
      return screen.getByRole('region', { name: label });
    };
    const image = selectGroup('生图模型');
    expect(within(image).getByText('Comfly Image')).toBeVisible();
    const video = selectGroup('视频模型');
    expect(within(video).getByText('Relay Video')).toBeVisible();
    const chat = selectGroup('对话模型');
    expect(within(chat).getByText('Relay Chat')).toBeVisible();
    expect(within(chat).getByText('Gemini Video Vision')).toBeVisible();
    const reverse = selectGroup('反推模型');
    expect(within(reverse).getByText('Comfly Reverse')).toBeVisible();
    const vision = selectGroup('视觉模型');
    expect(within(vision).getByText('Comfly Reverse')).toBeVisible();
    const videoUnderstanding = selectGroup('视频理解模型');
    expect(within(videoUnderstanding).getByText('Relay Video Understanding')).toBeVisible();
    expect(screen.queryByText('RelayMe')).not.toBeInTheDocument();
    expect(screen.queryByText('Comfly')).not.toBeInTheDocument();
    expect(screen.queryByText(/RelayMe ·|Comfly ·/u)).not.toBeInTheDocument();
    expect(screen.queryByText('2K / 4K')).not.toBeInTheDocument();
    expect(screen.queryByText('能力信息不完整')).not.toBeInTheDocument();
  });
});

type DefaultsProps = Pick<ProviderModelCatalogProps, 'profiles' | 'enabledProfileKeys' | 'defaultProfileKeys' | 'onDefaultProfileChange'>;

function renderDefaults(props: DefaultsProps) {
  expect(ProviderModelDefaults).toBeTypeOf('function');
  return render(<ProviderModelDefaults {...props} />);
}

const defaultCapabilities = [
  { capability: 'image_generation', ariaLabel: '生图默认模型', label: '图片生成' },
  { capability: 'video_generation', ariaLabel: '视频默认模型', label: '视频生成' },
  { capability: 'chat', ariaLabel: '对话默认模型', label: '对话' },
  { capability: 'reverse_prompt', ariaLabel: '反推默认模型', label: '反推' },
  { capability: 'vision', ariaLabel: '视觉默认模型', label: '视觉分析' },
  { capability: 'video_understanding', ariaLabel: '视频理解默认模型', label: '视频理解' },
] as const;

describe('ProviderModelDefaults', () => {
  it('keeps all six capability defaults available independently of the catalog tab', () => {
    const capabilities: CatalogCapability[] = ['image_generation', 'video_generation', 'chat', 'reverse_prompt', 'vision', 'video_understanding'];
    renderDefaults({
      profiles: [{ provider: 'comfly', modelRoute: 'all-capabilities', displayName: 'Available Model', capabilities }],
      defaultProfileKeys: { chat: 'comfly:all-capabilities' },
      onDefaultProfileChange: () => undefined,
    });

    expect(screen.getAllByRole('combobox')).toHaveLength(6);
    for (const group of defaultCapabilities) {
      expect(screen.getByText(group.label)).toBeVisible();
      const selector = screen.getByRole('combobox', { name: group.ariaLabel });
      expect(selector).toBeEnabled();
      expect(selector).toHaveValue(group.capability === 'chat' ? 'comfly:all-capabilities' : '');
    }
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
  });

  it.each(defaultCapabilities)('sends only the $capability selection to the existing default callback', ({ capability, ariaLabel }) => {
    const onDefaultProfileChange = vi.fn();
    renderDefaults({
      profiles: [{ provider: 'comfly', modelRoute: 'selected-route', displayName: 'Selected Model', capabilities: [capability] }],
      onDefaultProfileChange,
    });

    fireEvent.change(screen.getByRole('combobox', { name: ariaLabel }), { target: { value: 'comfly:selected-route' } });
    expect(onDefaultProfileChange).toHaveBeenCalledExactlyOnceWith(capability, 'comfly:selected-route');
  });

  it('shows one image family and resolves a saved resolution alias to that family', () => {
    renderDefaults({
      profiles: [
        { provider: 'comfly', modelRoute: 'flare', modelId: 'gpt-image-2.5-flare', displayName: 'GPT Image 2.5 Flare', capabilities: ['image_generation'] },
        { provider: 'comfly', modelRoute: 'flare-4k', modelId: 'gpt-image-2.5-flare-4k', displayName: 'GPT Image 2.5 Flare 4K', capabilities: ['image_generation'] },
      ],
      defaultProfileKeys: { image_generation: 'comfly:flare-4k' },
      onDefaultProfileChange: () => undefined,
    });

    const selector = screen.getByRole('combobox', { name: '生图默认模型' });
    expect(selector).toHaveValue('comfly:flare');
    expect(within(selector).getAllByRole('option')).toHaveLength(2);
    expect(within(selector).getByRole('option', { name: 'GPT Image 2.5 Flare' })).toBeVisible();
    expect(within(selector).queryByRole('option', { name: 'GPT Image 2.5 Flare 4K' })).not.toBeInTheDocument();
  });

  it.each(['comfly:flare', 'comfly:flare-2k', 'comfly:flare-4k'])('uses an enabled runnable alias for saved %s when other family routes are disabled or incomplete', (savedDefaultKey) => {
    const onDefaultProfileChange = vi.fn();
    renderDefaults({
      profiles: [
        { provider: 'comfly', modelRoute: 'flare', modelId: 'gpt-image-2.5-flare', displayName: 'GPT Image 2.5 Flare', capabilities: ['image_generation'], enabled: false },
        { provider: 'comfly', modelRoute: 'flare-2k', modelId: 'gpt-image-2.5-flare-2k', displayName: 'GPT Image 2.5 Flare 2K', capabilities: ['image_generation'], capabilityStatus: 'incomplete' },
        { provider: 'comfly', modelRoute: 'flare-4k', modelId: 'gpt-image-2.5-flare-4k', displayName: 'GPT Image 2.5 Flare 4K', capabilities: ['image_generation'] },
      ],
      enabledProfileKeys: ['comfly:flare-2k', 'comfly:flare-4k'],
      defaultProfileKeys: { image_generation: savedDefaultKey },
      onDefaultProfileChange,
    });

    const selector = screen.getByRole('combobox', { name: '生图默认模型' });
    expect(selector).toBeEnabled();
    expect(selector).toHaveValue('comfly:flare-4k');
    expect(within(selector).getAllByRole('option').map((option) => (option as HTMLOptionElement).value)).toEqual(['', 'comfly:flare-4k']);
    fireEvent.change(selector, { target: { value: 'comfly:flare-4k' } });
    expect(onDefaultProfileChange).toHaveBeenCalledExactlyOnceWith('image_generation', 'comfly:flare-4k');
  });

  it('does not display stale disabled or incomplete defaults as selected models', () => {
    renderDefaults({
      profiles: [
        { provider: 'comfly', modelRoute: 'chat/disabled', displayName: 'Disabled Chat', capabilities: ['chat'], enabled: false },
        { provider: 'comfly', modelRoute: 'chat/available', displayName: 'Available Chat', capabilities: ['chat'] },
        { provider: 'comfly', modelRoute: 'vision/pending', displayName: 'Pending Vision', capabilities: ['vision'], capabilityStatus: 'incomplete' },
        { provider: 'comfly', modelRoute: 'vision/available', displayName: 'Available Vision', capabilities: ['vision'] },
      ],
      defaultProfileKeys: { chat: 'comfly:chat/disabled', vision: 'comfly:vision/pending' },
      onDefaultProfileChange: () => undefined,
    });

    const chat = screen.getByRole('combobox', { name: '对话默认模型' });
    const vision = screen.getByRole('combobox', { name: '视觉默认模型' });
    expect(chat).toHaveValue('');
    expect(vision).toHaveValue('');
    expect(within(chat).queryByRole('option', { name: 'Disabled Chat' })).not.toBeInTheDocument();
    expect(within(vision).queryByRole('option', { name: 'Pending Vision' })).not.toBeInTheDocument();
  });

  it('disables all six selectors with an honest hint when the provider has no models', () => {
    renderDefaults({ profiles: [], onDefaultProfileChange: () => undefined });

    expect(screen.getAllByRole('combobox')).toHaveLength(6);
    for (const selector of screen.getAllByRole('combobox')) {
      expect(selector).toBeDisabled();
      expect(within(selector).getByRole('option', { name: '暂无已启用的可用模型' })).toBeVisible();
    }
  });

  it('uses explicit enabled keys even when a disabled profile flag differs from the saved selection', () => {
    const profiles = [{ provider: 'comfly' as const, modelRoute: 'chat/available', displayName: 'Available Chat', capabilities: ['chat' as const], enabled: false }];
    const rendered = renderDefaults({ profiles, enabledProfileKeys: ['comfly:chat/available'], onDefaultProfileChange: () => undefined });
    expect(screen.getByRole('combobox', { name: '对话默认模型' })).toBeEnabled();

    rendered.rerender(<ProviderModelDefaults profiles={profiles} enabledProfileKeys={[]} onDefaultProfileChange={() => undefined} />);
    const selector = screen.getByRole('combobox', { name: '对话默认模型' });
    expect(selector).toBeDisabled();
    expect(within(selector).queryByRole('option', { name: 'Available Chat' })).not.toBeInTheDocument();
  });
});
