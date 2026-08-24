import { readFileSync } from 'node:fs';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SettingsDrawer } from './SettingsDrawer';

const originalDesktop = window.novusDesktop;

afterEach(() => {
  cleanup();
  window.novusDesktop = originalDesktop;
  vi.useRealTimers();
});

describe('SettingsDrawer', () => {
  it('exposes the Figma settings heading, close control, and segmented tabs with readable Chinese labels', () => {
    render(<SettingsDrawer providerStatus={null} onClose={vi.fn()} onProviderStatusChange={vi.fn()} />);

    expect(screen.getByTestId('settings-drawer')).toHaveAttribute('data-figma-surface', 'settings');
    expect(screen.getByTestId('settings-drawer-heading')).toHaveTextContent('设置');
    expect(screen.getByTestId('settings-drawer-heading')).toHaveTextContent('Settings');
    expect(screen.getByTestId('settings-drawer-close')).toHaveAccessibleName('关闭设置');
    expect(screen.getByRole('tablist', { name: '设置分类' })).toHaveAttribute('data-figma-tabs', 'segmented');
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'API 与模型', '存储与备份', 'MCP 联动', '同步',
    ]);
    expect(screen.queryByRole('tab', { name: '使用说明' })).not.toBeInTheDocument();
  });

  it('uses four equal shared-theme columns for the four settings tabs', () => {
    const css = readFileSync('apps/renderer/src/styles/figma-hybrid-canvas.css', 'utf8');
    const tabsRule = css.match(/\.workspace--ui-gate \.settings-tabs \{[^}]+\}/u)?.[0];

    expect(tabsRule).toContain('grid-template-columns: repeat(4, minmax(104px, 1fr))');
    expect(tabsRule).not.toContain('repeat(5');
  });

  it('uses a two-provider final layout and compact capability metadata in both themes', () => {
    const css = readFileSync('apps/renderer/src/styles/figma-hybrid-canvas.css', 'utf8');
    const finalContract = css.slice(css.lastIndexOf('/* Dual-provider settings final contract */'));

    expect(finalContract).toContain('grid-template-columns: repeat(2, minmax(0, 1fr))');
    expect(finalContract).toContain('.settings-model-provider');
    expect(finalContract).toContain('.settings-model-constraints');
    expect(finalContract).toContain(":root[data-theme='dark']");
    expect(finalContract).toContain(":root[data-theme='light']");
  });
  it('keeps advanced diagnostics compact instead of inheriting the retired oversized card rules', () => {
    const css = readFileSync('apps/renderer/src/styles/figma-hybrid-canvas.css', 'utf8');
    const finalDiagnostics = css.slice(css.lastIndexOf('/* Final compact diagnostics contract */'));

    expect(finalDiagnostics).toContain('.workspace--ui-gate .settings-status-card');
    expect(finalDiagnostics).toContain('min-height: 0 !important');
    expect(finalDiagnostics).toContain('font-size: 14px !important');
    expect(finalDiagnostics).toContain('align-items: center !important');
  });
  it('uses the compact provider credential layout from the approved settings reference', () => {
    const css = readFileSync('apps/renderer/src/styles/figma-hybrid-canvas.css', 'utf8');
    const contract = css.slice(css.lastIndexOf('/* Final provider credential layout contract */'));

    expect(contract).toContain('.settings-key-heading');
    expect(contract).toContain('grid-template-columns: minmax(0, 1fr) auto');
    expect(contract).toContain('.settings-provider-endpoint');
    expect(contract).toContain('padding: 14px');
    expect(contract).toContain('.settings-key-actions');
    expect(contract).toContain('align-items: center');
  });

  it('keeps long model names readable with a simple checkbox-and-name model row', () => {
    const css = readFileSync('apps/renderer/src/styles/figma-hybrid-canvas.css', 'utf8');
    const contract = css.slice(css.lastIndexOf('/* Final simple model-row contract: checkbox plus model name only. */'));

    expect(contract).toContain('.settings-model-list > article');
    expect(contract).toContain('grid-template-columns: 20px minmax(0, 1fr)');
    expect(contract).toContain('.settings-model-constraints');
    expect(contract).toContain('display: none');
  });
  it('opens the working RelayMe workspace instead of the retired API-key route', async () => {
    window.novusDesktop = {
      provider: {
        getStatus: vi.fn(async ({ provider }: { provider?: 'comfly' | 'relayme' } = {}) => ({ configured: provider === 'relayme', locked: false, encryption: 'safeStorage' as const })),
        listProfiles: vi.fn(async () => []),
      },
    } as unknown as typeof window.novusDesktop;
    render(<SettingsDrawer providerStatus={null} onClose={vi.fn()} onProviderStatusChange={vi.fn()} />);

    fireEvent.click(await screen.findByRole('listitem', { name: /RelayMe/u }));
    const link = screen.getByRole('link', { name: '打开 RelayMe 工作台' });
    expect(link).toHaveAttribute('href', 'https://www.ml.relayme.uk/workflow');
    expect(screen.queryByRole('link', { name: '创建 API Key' })).not.toBeInTheDocument();
  });
  it('renders a compact API and model screen with only populated capability groups', async () => {
    window.novusDesktop = {
      provider: {
        listProfiles: vi.fn(async () => [
          { provider: 'comfly', modelRoute: 'image/generate', displayName: 'Nano Banana Pro', modelId: 'nano-banana-pro', capabilities: ['image_generation'] },
          { provider: 'comfly', modelRoute: 'reverse/vision', displayName: 'Gemini 3.1 Pro', modelId: 'gemini-3.1-pro', capabilities: ['reverse_prompt', 'vision'] },
          { provider: 'comfly', modelRoute: 'chat/general', displayName: 'GPT 4.1', modelId: 'gpt-4.1', capabilities: ['chat'] },
          { provider: 'comfly', modelRoute: 'video/generate', displayName: 'Veo 3 Fast', modelId: 'veo-3-fast', capabilities: ['video_generation'] },
        ]),
      },
    } as unknown as typeof window.novusDesktop;

    render(<SettingsDrawer
      providerStatus={{ configured: true, locked: false, encryption: 'safeStorage' }}
      onClose={vi.fn()}
      onProviderStatusChange={vi.fn()}
    />);

    expect(screen.getByRole('region', { name: 'API 与模型' })).toBeVisible();
    expect(screen.getByRole('list', { name: '模型供应商' })).toBeVisible();
    expect(screen.getByRole('listitem', { name: /Comfly/i })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText('API 服务地址（Base URL）')).toHaveValue('https://ai.comfly.org');
    expect(screen.getByText('用于读取模型目录并发送对话、生图和视频请求；通常无需修改。')).toBeVisible();
    expect(screen.getByRole('button', { name: '配置隐藏密钥' })).toBeVisible();
    expect(screen.getByLabelText('Comfly 凭据摘要')).toHaveTextContent('凭据状态');
    expect(screen.getByLabelText('Comfly 凭据摘要')).toHaveTextContent('已配置');
    expect(screen.getByLabelText('Comfly 凭据摘要')).toHaveTextContent('系统凭据库');
    expect(screen.queryByText('密钥名称')).not.toBeInTheDocument();

    expect(await screen.findByText('模型目录')).toBeVisible();
    expect(screen.getByText('4 个模型 · 4 个启用')).toBeVisible();
    await waitFor(() => expect(screen.getByRole('region', { name: '生图模型' })).toBeVisible());
    expect(screen.getByRole('region', { name: '对话模型' })).toBeVisible();
    expect(screen.getByRole('region', { name: '反推模型' })).toBeVisible();
    expect(screen.getByRole('region', { name: '视频模型' })).toBeVisible();
    expect(screen.getByRole('region', { name: '视觉模型' })).toBeVisible();
    expect(screen.queryByRole('region', { name: '视频理解模型' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('启用 Nano Banana Pro')).toBeChecked();
    expect(screen.getAllByLabelText('启用 Gemini 3.1 Pro')).toHaveLength(2);
    expect(screen.getByLabelText('启用 Veo 3 Fast')).toBeChecked();
    expect(screen.queryByText('CF')).toBeNull();
    expect(screen.queryByText('模型')).not.toBeInTheDocument();
  });

  it('switches between only Comfly and RelayMe and scopes every provider request', async () => {
    const getStatus = vi.fn(async ({ provider }: { provider?: 'comfly' | 'relayme' } = {}) => ({
      configured: provider === 'relayme', locked: false, encryption: 'safeStorage' as const,
    }));
    const listProfiles = vi.fn(async ({ provider }: { provider?: 'comfly' | 'relayme' } = {}) => provider === 'relayme' ? [
      { provider: 'relayme' as const, modelRoute: 'video/generate', displayName: 'Relay Video', modelId: 'relay-video', capabilities: ['video_generation' as const] },
      { provider: 'relayme' as const, modelRoute: 'chat/general', displayName: 'Relay Chat', modelId: 'relay-chat', capabilities: ['chat' as const] },
    ] : [
      { provider: 'comfly' as const, modelRoute: 'image/generate', displayName: 'Comfly Image', modelId: 'comfly-image', capabilities: ['image_generation' as const] },
    ]);
    const checkConnection = vi.fn(async ({ provider }: { provider?: 'comfly' | 'relayme' } = {}) => ({
      checkedAt: '2026-08-08T00:00:00.000Z', status: provider === 'relayme' ? 'connected' as const : 'unconfigured' as const,
    }));
    window.novusDesktop = { provider: { getStatus, listProfiles, checkConnection } } as unknown as typeof window.novusDesktop;

    render(<SettingsDrawer providerStatus={null} onClose={vi.fn()} onProviderStatusChange={vi.fn()} />);

    expect(await screen.findByRole('listitem', { name: /Comfly/u })).toBeEnabled();
    const relayCard = screen.getByRole('listitem', { name: /RelayMe/u });
    expect(relayCard).toBeEnabled();
    expect(screen.queryByRole('listitem', { name: /GLM/u })).toBeNull();
    expect(screen.queryByRole('listitem', { name: /APIYi/u })).toBeNull();
    expect(screen.queryByRole('listitem', { name: /OpenAI/u })).toBeNull();

    fireEvent.click(relayCard);
    await waitFor(() => expect(listProfiles).toHaveBeenCalledWith({ provider: 'relayme' }));
    expect((await screen.findAllByText('Relay Video')).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByLabelText('API 服务地址（Base URL）')).toHaveValue('https://www.ml.relayme.uk/api/ai-tools/v1');

    fireEvent.click(screen.getByRole('button', { name: /检测连接/u }));
    await waitFor(() => expect(checkConnection).toHaveBeenCalledWith({ provider: 'relayme' }));
  });

  it('shows a safe saved-key mask when an already configured provider is reopened', async () => {
    window.novusDesktop = {
      provider: {
        getStatus: vi.fn(async () => ({ configured: true, locked: false, encryption: 'safeStorage' as const })),
        listProfiles: vi.fn(async () => []),
      },
    } as unknown as typeof window.novusDesktop;
    render(<SettingsDrawer
      providerStatus={{ configured: true, locked: false, encryption: 'safeStorage' }}
      onClose={vi.fn()}
      onProviderStatusChange={vi.fn()}
    />);

    fireEvent.click(screen.getByRole('button', { name: '配置隐藏密钥' }));
    const input = screen.getByLabelText('Comfly API 密钥');
    expect(input).toHaveValue('••••••••••••••••');
    expect(screen.getByRole('button', { name: '保存隐藏密钥' })).toBeDisabled();

    fireEvent.focus(input);
    expect(input).toHaveValue('');
  });

  it('locks the API test button while checking and refreshes models after a successful connection', async () => {
    let resolveConnection!: (value: { checkedAt: string; status: 'connected' }) => void;
    const checkConnection = vi.fn(() => new Promise<{ checkedAt: string; status: 'connected' }>((resolve) => { resolveConnection = resolve; }));
    const listProfiles = vi.fn(async () => [
      { provider: 'comfly' as const, modelRoute: 'image/generate', displayName: 'GPT Image 2', modelId: 'gpt-image-2', capabilities: ['image_generation' as const] },
    ]);
    window.novusDesktop = {
      provider: {
        getStatus: vi.fn(async () => ({ configured: true, locked: false, encryption: 'safeStorage' as const })),
        listProfiles,
        checkConnection,
      },
    } as unknown as typeof window.novusDesktop;

    render(<SettingsDrawer providerStatus={{ configured: true, locked: false, encryption: 'safeStorage' }} onClose={vi.fn()} onProviderStatusChange={vi.fn()} />);
    await waitFor(() => expect(listProfiles).toHaveBeenCalledWith({ provider: 'comfly' }));
    listProfiles.mockClear();

    const testButton = screen.getByRole('button', { name: '检测连接' });
    fireEvent.click(testButton);
    expect(checkConnection).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: '检测中…' })).toBeDisabled();

    resolveConnection({ checkedAt: '2026-08-09T00:00:00.000Z', status: 'connected' });
    await waitFor(() => expect(listProfiles).toHaveBeenCalledWith({ provider: 'comfly' }));
    expect(await screen.findByText('连接成功，已同步 1 个模型，但没有模型声明反推能力')).toBeVisible();
    expect(screen.getByRole('button', { name: '检测连接' })).toBeEnabled();
  });
  it('saves the selected RelayMe hidden key through the RelayMe credential vault', async () => {
    const configure = vi.fn(async () => ({ configured: true, locked: false, encryption: 'safeStorage' as const }));
    window.novusDesktop = {
      provider: {
        getStatus: vi.fn(async () => ({ configured: true, locked: false, encryption: 'safeStorage' as const })),
        listProfiles: vi.fn(async () => []),
        configure,
      },
    } as unknown as typeof window.novusDesktop;
    render(<SettingsDrawer providerStatus={null} onClose={vi.fn()} onProviderStatusChange={vi.fn()} />);

    fireEvent.click(await screen.findByRole('listitem', { name: /RelayMe/u }));
    fireEvent.click(screen.getByRole('button', { name: '配置隐藏密钥' }));
    const token = screen.getByLabelText('RelayMe API 密钥');
    expect(token).toHaveAttribute('type', 'password');
    fireEvent.change(token, { target: { value: 'relay-secret' } });
    fireEvent.click(screen.getByRole('button', { name: '保存隐藏密钥' }));

    await waitFor(() => expect(configure).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'relayme', token: 'relay-secret',
    })));
  });
  it('validates a saved RelayMe key before reporting success and synchronizes the verified model count', async () => {
    const configure = vi.fn(async () => ({ configured: true, locked: false, encryption: 'safeStorage' as const }));
    const checkConnection = vi.fn(async () => ({ checkedAt: '2026-08-09T00:00:00.000Z', status: 'connected' as const }));
    const listProfiles = vi.fn(async ({ provider }: { provider?: 'comfly' | 'relayme' } = {}) => provider === 'relayme' ? [
      { provider: 'relayme' as const, modelRoute: 'chat/general', displayName: 'Relay Chat', modelId: 'relay-chat', capabilities: ['chat' as const] },
      { provider: 'relayme' as const, modelRoute: 'video/generate', displayName: 'Relay Video', modelId: 'relay-video', capabilities: ['video_generation' as const] },
    ] : []);
    window.novusDesktop = {
      provider: {
        getStatus: vi.fn(async () => ({ configured: true, locked: false, encryption: 'safeStorage' as const })),
        listProfiles,
        configure,
        checkConnection,
      },
    } as unknown as typeof window.novusDesktop;
    render(<SettingsDrawer providerStatus={null} onClose={vi.fn()} onProviderStatusChange={vi.fn()} />);

    fireEvent.click(await screen.findByRole('listitem', { name: /RelayMe/u }));
    await waitFor(() => expect(listProfiles).toHaveBeenCalledWith({ provider: 'relayme' }));
    listProfiles.mockClear();
    fireEvent.click(screen.getByRole('button', { name: '\u914d\u7f6e\u9690\u85cf\u5bc6\u94a5' }));
    fireEvent.change(screen.getByLabelText('RelayMe API \u5bc6\u94a5'), { target: { value: 'relay-secret' } });
    fireEvent.click(screen.getByRole('button', { name: '\u4fdd\u5b58\u9690\u85cf\u5bc6\u94a5' }));

    await waitFor(() => expect(checkConnection).toHaveBeenCalledWith({ provider: 'relayme' }));
    await waitFor(() => expect(listProfiles).toHaveBeenCalledWith({ provider: 'relayme' }));
    expect(screen.getByRole('status')).toHaveTextContent('RelayMe \u8fde\u63a5\u6210\u529f\uff0c\u5df2\u540c\u6b65 2 \u4e2a\u6a21\u578b\uff0c\u4f46\u6ca1\u6709\u6a21\u578b\u58f0\u660e\u53cd\u63a8\u80fd\u529b');
    expect(screen.getAllByText('Relay Chat').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Relay Video').length).toBeGreaterThanOrEqual(1);
  });

  it('reports an invalid RelayMe key and does not refresh the model catalog after authentication fails', async () => {
    const configure = vi.fn(async () => ({ configured: true, locked: false, encryption: 'safeStorage' as const }));
    const checkConnection = vi.fn(async () => ({ checkedAt: '2026-08-09T00:00:00.000Z', status: 'authentication_failed' as const }));
    const listProfiles = vi.fn(async () => []);
    window.novusDesktop = {
      provider: {
        getStatus: vi.fn(async () => ({ configured: true, locked: false, encryption: 'safeStorage' as const })),
        listProfiles,
        configure,
        checkConnection,
      },
    } as unknown as typeof window.novusDesktop;
    render(<SettingsDrawer providerStatus={null} onClose={vi.fn()} onProviderStatusChange={vi.fn()} />);

    fireEvent.click(await screen.findByRole('listitem', { name: /RelayMe/u }));
    await waitFor(() => expect(listProfiles).toHaveBeenCalledWith({ provider: 'relayme' }));
    listProfiles.mockClear();
    fireEvent.click(screen.getByRole('button', { name: '\u914d\u7f6e\u9690\u85cf\u5bc6\u94a5' }));
    fireEvent.change(screen.getByLabelText('RelayMe API \u5bc6\u94a5'), { target: { value: 'invalid-relay-secret' } });
    fireEvent.click(screen.getByRole('button', { name: '\u4fdd\u5b58\u9690\u85cf\u5bc6\u94a5' }));

    await waitFor(() => expect(checkConnection).toHaveBeenCalledWith({ provider: 'relayme' }));
    expect(listProfiles).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('RelayMe \u5bc6\u94a5\u5df2\u4fdd\u5b58\uff0c\u4f46\u5bc6\u94a5\u65e0\u6548');
  });

  it('keeps the saved RelayMe credential but reports a temporary connection failure without syncing models', async () => {
    const configure = vi.fn(async () => ({ configured: true, locked: false, encryption: 'safeStorage' as const }));
    const checkConnection = vi.fn(async () => ({ checkedAt: '2026-08-09T00:00:00.000Z', status: 'network_unavailable' as const }));
    const listProfiles = vi.fn(async () => []);
    window.novusDesktop = {
      provider: {
        getStatus: vi.fn(async () => ({ configured: true, locked: false, encryption: 'safeStorage' as const })),
        listProfiles,
        configure,
        checkConnection,
      },
    } as unknown as typeof window.novusDesktop;
    render(<SettingsDrawer providerStatus={null} onClose={vi.fn()} onProviderStatusChange={vi.fn()} />);

    fireEvent.click(await screen.findByRole('listitem', { name: /RelayMe/u }));
    await waitFor(() => expect(listProfiles).toHaveBeenCalledWith({ provider: 'relayme' }));
    listProfiles.mockClear();
    fireEvent.click(screen.getByRole('button', { name: '\u914d\u7f6e\u9690\u85cf\u5bc6\u94a5' }));
    fireEvent.change(screen.getByLabelText('RelayMe API \u5bc6\u94a5'), { target: { value: 'relay-secret' } });
    fireEvent.click(screen.getByRole('button', { name: '\u4fdd\u5b58\u9690\u85cf\u5bc6\u94a5' }));

    await waitFor(() => expect(checkConnection).toHaveBeenCalledWith({ provider: 'relayme' }));
    expect(listProfiles).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('RelayMe \u5bc6\u94a5\u5df2\u4fdd\u5b58\uff0c\u4f46\u6682\u65f6\u65e0\u6cd5\u8fde\u63a5');
  });
  it('reports RelayMe service limiting separately from an invalid key and does not sync models', async () => {
    const configure = vi.fn(async () => ({ configured: true, locked: false, encryption: 'safeStorage' as const }));
    const checkConnection = vi.fn(async () => ({ checkedAt: '2026-08-09T00:00:00.000Z', status: 'service_limited' as const }));
    const listProfiles = vi.fn(async () => []);
    window.novusDesktop = {
      provider: {
        getStatus: vi.fn(async () => ({ configured: true, locked: false, encryption: 'safeStorage' as const })),
        listProfiles,
        configure,
        checkConnection,
      },
    } as unknown as typeof window.novusDesktop;
    render(<SettingsDrawer providerStatus={null} onClose={vi.fn()} onProviderStatusChange={vi.fn()} />);

    fireEvent.click(await screen.findByRole('listitem', { name: /RelayMe/u }));
    await waitFor(() => expect(listProfiles).toHaveBeenCalledWith({ provider: 'relayme' }));
    listProfiles.mockClear();
    fireEvent.click(screen.getByRole('button', { name: '\u914d\u7f6e\u9690\u85cf\u5bc6\u94a5' }));
    fireEvent.change(screen.getByLabelText('RelayMe API \u5bc6\u94a5'), { target: { value: 'relay-secret' } });
    fireEvent.click(screen.getByRole('button', { name: '\u4fdd\u5b58\u9690\u85cf\u5bc6\u94a5' }));

    await waitFor(() => expect(checkConnection).toHaveBeenCalledWith({ provider: 'relayme' }));
    expect(listProfiles).not.toHaveBeenCalled();
    expect(screen.getByRole('status')).toHaveTextContent('RelayMe \u5bc6\u94a5\u5df2\u4fdd\u5b58\uff0c\u4f46\u670d\u52a1\u6682\u65f6\u53d7\u9650\uff0c\u8bf7\u7a0d\u540e\u91cd\u8bd5');
  });
  it('uses one Comfly API key for Agent, reverse prompt, image, and video capabilities', async () => {
    const configure = vi.fn(async () => ({ configured: true, locked: false, encryption: 'safeStorage' as const }));
    window.novusDesktop = { provider: { configure } } as unknown as typeof window.novusDesktop;
    render(<SettingsDrawer providerStatus={null} onClose={vi.fn()} onProviderStatusChange={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: '配置隐藏密钥' }));

    expect(screen.getByRole('dialog', { name: '配置隐藏密钥' })).toBeVisible();
    expect(screen.queryByLabelText(/生图 API 密钥/u)).toBeNull();
    expect(screen.queryByLabelText(/反推 API 密钥/u)).toBeNull();
    const token = screen.getByLabelText('Comfly API 密钥');
    expect(token).toHaveAttribute('type', 'password');
    fireEvent.change(token, { target: { value: 'comfly-secret' } });
    fireEvent.click(screen.getByRole('button', { name: '保存隐藏密钥' }));

    await waitFor(() => expect(configure).toHaveBeenCalledWith(expect.objectContaining({ provider: 'comfly', token: 'comfly-secret', baseUrl: 'https://ai.comfly.org' })));
    expect(screen.queryByRole('dialog', { name: '配置隐藏密钥' })).toBeNull();
    expect(screen.getByText('API 密钥已保存到系统安全存储')).toBeVisible();
  });

  it('reveals the real saved key only after the eye button is clicked and hides it again', async () => {
    const revealCredential = vi.fn(async () => ({ token: 'sk-synthetic-visible-key' }));
    window.novusDesktop = {
      provider: {
        getStatus: vi.fn(async () => ({ configured: true, locked: false, encryption: 'safeStorage' as const })),
        listProfiles: vi.fn(async () => []),
        revealCredential,
      },
    } as unknown as typeof window.novusDesktop;
    render(<SettingsDrawer
      providerStatus={{ configured: true, locked: false, encryption: 'safeStorage' }}
      onClose={vi.fn()}
      onProviderStatusChange={vi.fn()}
    />);

    fireEvent.click(screen.getByRole('button', { name: '配置隐藏密钥' }));
    const tokenInput = screen.getByLabelText('Comfly API 密钥');
    expect(tokenInput).toHaveAttribute('type', 'password');
    expect(tokenInput).toHaveValue('••••••••••••••••');

    fireEvent.click(screen.getByRole('button', { name: '显示真实密钥' }));
    await waitFor(() => expect(revealCredential).toHaveBeenCalledWith({ provider: 'comfly' }));
    expect(tokenInput).toHaveAttribute('type', 'text');
    expect(tokenInput).toHaveValue('sk-synthetic-visible-key');

    fireEvent.click(screen.getByRole('button', { name: '隐藏真实密钥' }));
    expect(tokenInput).toHaveAttribute('type', 'password');
    expect(tokenInput).toHaveValue('••••••••••••••••');
  });

  it('clears a revealed key when the dialog closes or the provider changes', async () => {
    window.novusDesktop = {
      provider: {
        getStatus: vi.fn(async () => ({ configured: true, locked: false, encryption: 'safeStorage' as const })),
        listProfiles: vi.fn(async () => []),
        revealCredential: vi.fn(async ({ provider }: { provider?: 'comfly' | 'relayme' } = {}) => ({ token: `sk-${provider}-visible-key` })),
      },
    } as unknown as typeof window.novusDesktop;
    render(<SettingsDrawer
      providerStatus={{ configured: true, locked: false, encryption: 'safeStorage' }}
      onClose={vi.fn()}
      onProviderStatusChange={vi.fn()}
    />);

    fireEvent.click(screen.getByRole('button', { name: '配置隐藏密钥' }));
    fireEvent.click(screen.getByRole('button', { name: '显示真实密钥' }));
    await waitFor(() => expect(screen.getByLabelText('Comfly API 密钥')).toHaveValue('sk-comfly-visible-key'));
    fireEvent.click(screen.getByRole('button', { name: '关闭隐藏密钥配置' }));

    fireEvent.click(screen.getByRole('button', { name: '配置隐藏密钥' }));
    expect(screen.getByLabelText('Comfly API 密钥')).toHaveValue('••••••••••••••••');
    fireEvent.click(screen.getByRole('button', { name: '显示真实密钥' }));
    await waitFor(() => expect(screen.getByLabelText('Comfly API 密钥')).toHaveValue('sk-comfly-visible-key'));
    fireEvent.click(screen.getByRole('listitem', { name: /RelayMe/u }));

    await waitFor(() => expect(screen.queryByRole('dialog', { name: '配置隐藏密钥' })).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: '配置隐藏密钥' }));
    expect(screen.getByLabelText('RelayMe API 密钥')).toHaveValue('••••••••••••••••');
    expect(screen.queryByDisplayValue('sk-comfly-visible-key')).not.toBeInTheDocument();
  });

  it('saves an edited revealed key as the replacement credential', async () => {
    const configure = vi.fn(async () => ({ configured: true, locked: false, encryption: 'safeStorage' as const }));
    window.novusDesktop = {
      provider: {
        configure,
        getStatus: vi.fn(async () => ({ configured: true, locked: false, encryption: 'safeStorage' as const })),
        listProfiles: vi.fn(async () => []),
        revealCredential: vi.fn(async () => ({ token: 'sk-synthetic-old-key' })),
      },
    } as unknown as typeof window.novusDesktop;
    render(<SettingsDrawer
      providerStatus={{ configured: true, locked: false, encryption: 'safeStorage' }}
      onClose={vi.fn()}
      onProviderStatusChange={vi.fn()}
    />);

    fireEvent.click(screen.getByRole('button', { name: '配置隐藏密钥' }));
    fireEvent.click(screen.getByRole('button', { name: '显示真实密钥' }));
    const tokenInput = await screen.findByDisplayValue('sk-synthetic-old-key');
    fireEvent.change(tokenInput, { target: { value: 'sk-synthetic-replacement-key' } });
    fireEvent.click(screen.getByRole('button', { name: '保存隐藏密钥' }));

    await waitFor(() => expect(configure).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'comfly',
      token: 'sk-synthetic-replacement-key',
    })));
    expect(screen.queryByDisplayValue('sk-synthetic-old-key')).not.toBeInTheDocument();
  });

  it('validates a saved Comfly key before synchronizing its dynamic model catalog', async () => {
    const configure = vi.fn(async () => ({ configured: true, locked: false, encryption: 'safeStorage' as const }));
    const checkConnection = vi.fn(async () => ({ checkedAt: '2026-08-09T00:00:00.000Z', status: 'connected' as const }));
    const listProfiles = vi.fn(async ({ provider }: { provider?: 'comfly' | 'relayme' } = {}) => provider === 'comfly' ? [
      { provider: 'comfly' as const, modelRoute: 'comfly-image', displayName: 'Comfly Image', modelId: 'image-model', capabilities: ['image_generation' as const] },
      { provider: 'comfly' as const, modelRoute: 'comfly-video', displayName: 'Comfly Video', modelId: 'video-model', capabilities: ['video_generation' as const] },
    ] : []);
    window.novusDesktop = {
      provider: {
        getStatus: vi.fn(async () => ({ configured: true, locked: false, encryption: 'safeStorage' as const })),
        listProfiles, configure, checkConnection,
      },
    } as unknown as typeof window.novusDesktop;
    render(<SettingsDrawer providerStatus={null} onClose={vi.fn()} onProviderStatusChange={vi.fn()} />);

    await waitFor(() => expect(listProfiles).toHaveBeenCalledWith({ provider: 'comfly' }));
    listProfiles.mockClear();
    fireEvent.click(screen.getByRole('button', { name: '配置隐藏密钥' }));
    fireEvent.change(screen.getByLabelText('Comfly API 密钥'), { target: { value: 'comfly-secret' } });
    fireEvent.click(screen.getByRole('button', { name: '保存隐藏密钥' }));

    await waitFor(() => expect(checkConnection).toHaveBeenCalledWith({ provider: 'comfly' }));
    await waitFor(() => expect(listProfiles).toHaveBeenCalledWith({ provider: 'comfly' }));
    expect(screen.getByRole('status')).toHaveTextContent('Comfly 连接成功，已同步 2 个模型，但没有模型声明反推能力');
  });
  it('shows the working RelayMe workspace entry in the RelayMe credential panel', async () => {
    window.novusDesktop = { provider: { listProfiles: vi.fn(async () => []) } } as unknown as typeof window.novusDesktop;
    render(<SettingsDrawer providerStatus={null} onClose={vi.fn()} onProviderStatusChange={vi.fn()} />);

    fireEvent.click(await screen.findByRole('listitem', { name: /RelayMe/u }));
    const link = screen.getByRole('link', { name: '打开 RelayMe 工作台' });
    expect(link).toHaveAttribute('href', 'https://www.ml.relayme.uk/workflow');
    expect(link).toHaveAttribute('target', '_blank');
  });
  it('shows one settings category at a time instead of stacking every category', () => {
    render(<SettingsDrawer providerStatus={null} onClose={vi.fn()} onProviderStatusChange={vi.fn()} />);

    expect(screen.getByRole('tab', { name: 'API 与模型' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('供应商设置')).toBeVisible();
    expect(screen.queryByText('本地保存')).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: '存储与备份' }));

    expect(screen.getByRole('tab', { name: '存储与备份' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('本地保存')).toBeVisible();
    expect(screen.queryByText('供应商设置')).toBeNull();
  });

  it('loads the desktop cache path and wires open, choose, and reset actions', async () => {
    const storage = {
      getCacheDirectory: vi.fn(async () => ({ path: 'D:\\NovusCache', isDefault: false, available: true, busy: false, error: null })),
      chooseCacheDirectory: vi.fn(async () => ({ path: 'E:\\CustomCache', isDefault: false, available: true, busy: false, error: null })),
      resetCacheDirectory: vi.fn(async () => ({ path: 'C:\\DefaultCache', isDefault: true, available: true, busy: false, error: null })),
      openCacheDirectory: vi.fn(async () => ({ opened: true })),
    };
    window.novusDesktop = { storage } as unknown as typeof window.novusDesktop;

    render(<SettingsDrawer providerStatus={null} onClose={vi.fn()} onProviderStatusChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('tab', { name: '存储与备份' }));

    await waitFor(() => expect(screen.getByLabelText('当前缓存路径')).toHaveValue('D:\\NovusCache'));
    expect(screen.getByText('缓存存储路径')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '打开缓存目录' }));
    await waitFor(() => expect(storage.openCacheDirectory).toHaveBeenCalledOnce());
    fireEvent.click(screen.getByRole('button', { name: '选择自定义缓存路径' }));
    await waitFor(() => expect(storage.chooseCacheDirectory).toHaveBeenCalledOnce());
    expect(screen.getByLabelText('当前缓存路径')).toHaveValue('E:\\CustomCache');
    fireEvent.click(screen.getByRole('button', { name: '恢复默认目录' }));
    await waitFor(() => expect(storage.resetCacheDirectory).toHaveBeenCalledOnce());
    expect(screen.getByLabelText('当前缓存路径')).toHaveValue('C:\\DefaultCache');
  });

  it('keeps the current cache path when directory selection is cancelled', async () => {
    const storage = {
      getCacheDirectory: vi.fn(async () => ({ path: 'D:\\NovusCache', isDefault: false, available: true, busy: false, error: null })),
      chooseCacheDirectory: vi.fn(async () => null),
      resetCacheDirectory: vi.fn(),
      openCacheDirectory: vi.fn(),
    };
    window.novusDesktop = { storage } as unknown as typeof window.novusDesktop;

    render(<SettingsDrawer providerStatus={null} onClose={vi.fn()} onProviderStatusChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('tab', { name: '存储与备份' }));
    await waitFor(() => expect(screen.getByLabelText('当前缓存路径')).toHaveValue('D:\\NovusCache'));
    fireEvent.click(screen.getByRole('button', { name: '选择自定义缓存路径' }));

    await waitFor(() => expect(storage.chooseCacheDirectory).toHaveBeenCalledOnce());
    expect(screen.getByLabelText('当前缓存路径')).toHaveValue('D:\\NovusCache');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('keeps the current cache path and shows choose errors inside the storage card', async () => {
    const storage = {
      getCacheDirectory: vi.fn(async () => ({ path: 'D:\\NovusCache', isDefault: false, available: true, busy: false, error: null })),
      chooseCacheDirectory: vi.fn(async () => { throw new Error('picker failed'); }),
      resetCacheDirectory: vi.fn(),
      openCacheDirectory: vi.fn(),
    };
    window.novusDesktop = { storage } as unknown as typeof window.novusDesktop;

    render(<SettingsDrawer providerStatus={null} onClose={vi.fn()} onProviderStatusChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('tab', { name: '存储与备份' }));
    await waitFor(() => expect(screen.getByLabelText('当前缓存路径')).toHaveValue('D:\\NovusCache'));
    fireEvent.click(screen.getByRole('button', { name: '选择自定义缓存路径' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('无法自定义缓存目录，原目录保持不变。');
    expect(screen.getByLabelText('本地保存')).toContainElement(alert);
    expect(screen.getByLabelText('当前缓存路径')).toHaveValue('D:\\NovusCache');
  });

  it('shows browser mode clearly and disables native cache directory actions', () => {
    window.novusDesktop = undefined;

    render(<SettingsDrawer providerStatus={null} onClose={vi.fn()} onProviderStatusChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('tab', { name: '存储与备份' }));

    expect(screen.getByLabelText('当前缓存路径')).toHaveValue('仅桌面版可选择缓存路径');
    expect(screen.getByRole('button', { name: '打开缓存目录' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '选择自定义缓存路径' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '恢复默认目录' })).toBeDisabled();
  });

  it('renders storage and backup using Figma-style cache cards without the retired capacity preview control', () => {
    render(<SettingsDrawer providerStatus={null} onClose={vi.fn()} onProviderStatusChange={vi.fn()} />);

    fireEvent.click(screen.getByRole('tab', { name: '存储与备份' }));

    expect(screen.getByLabelText('下载输出目录')).toBeVisible();
    expect(screen.getByLabelText('本地保存')).toBeVisible();
    expect(screen.getByTestId('settings-storage-card')).toHaveAttribute('data-figma-layout', 'storage');
    expect(screen.getByRole('button', { name: '清理全部缓存' })).toBeVisible();
    expect(screen.getAllByRole('button', { name: '清理' })).toHaveLength(4);
    expect(screen.queryByRole('button', { name: '10GB 清理预览' })).toBeNull();
  });

  it('uses the Sync tab as the knowledge-base sync UI with the two required project knowledge bases', () => {
    render(<SettingsDrawer
      providerStatus={null}
      knowledgeBases={[
        { knowledgeBaseId: 'scene-skill', displayName: '场景 Skill', activeVersion: 2, activeContentHash: 'hash-a', status: 'active' },
        { knowledgeBaseId: 'ecommerce-detail-knowledge', displayName: '电商详情页知识库', activeVersion: 5, activeContentHash: 'hash-b', status: 'active' },
      ]}
      knowledgeSyncStatuses={[
        { knowledgeBaseId: 'scene-skill', status: 'updated', changedAt: '2026-08-05T00:00:00Z', lastFailure: null },
        { knowledgeBaseId: 'ecommerce-detail-knowledge', status: 'offline', changedAt: '2026-08-05T00:00:00Z', lastFailure: null },
      ]}
      onClose={vi.fn()}
      onProviderStatusChange={vi.fn()}
    />);

    fireEvent.click(screen.getByRole('tab', { name: '同步' }));

    expect(screen.getByTestId('settings-sync-card')).toBeVisible();
    expect(screen.getByText('同步与成长记忆')).toBeVisible();
    expect(screen.getByRole('group', { name: '知识库同步列表' })).toBeVisible();
    expect(screen.getByText('场景 Skill')).toBeVisible();
    expect(screen.getByText('电商详情页知识库')).toBeVisible();
    expect(screen.getByText('v2')).toBeVisible();
    expect(screen.getByText('v5')).toBeVisible();
    expect(screen.getByText('百度网盘同步')).toBeVisible();
    expect(screen.getByText('WebDAV')).toBeVisible();
  });

it('shows live MCP runtime status and separate Codex and WorkBuddy controls', async () => {
    const connect = vi.fn(async (client: 'codex' | 'workbuddy') => ({ client, state: 'connected' as const, toolCount: 14 as const, lastError: null }));
    const disconnect = vi.fn(async (client: 'codex' | 'workbuddy') => ({ client, state: 'unconfigured' as const, toolCount: 0 as const, lastError: null }));
    const testConnection = vi.fn(async (client: 'codex' | 'workbuddy') => ({ client, state: 'connected' as const, toolCount: 14 as const, lastError: null }));
    const copyConfig = vi.fn(async (client: 'codex' | 'workbuddy') => ({ client, config: `${client}-stdio-config` }));
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    window.novusDesktop = {
      mcpRuntime: { getStatus: vi.fn(async () => ({ state: 'running' as const, rendererConnected: true, serverVersion: '1.6.32', toolCount: 14 as const, lastError: null })) },
      mcpIntegration: {
        getStatus: vi.fn(async () => [
          { client: 'codex' as const, state: 'configured' as const, toolCount: 0 as const, lastError: null },
          { client: 'workbuddy' as const, state: 'unconfigured' as const, toolCount: 0 as const, lastError: null },
        ]),
        connect,
        disconnect,
        test: testConnection,
        copyConfig,
      },
    } as unknown as typeof window.novusDesktop;

    render(<SettingsDrawer providerStatus={null} onClose={vi.fn()} onProviderStatusChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('tab', { name: /MCP/u }));

    const server = await screen.findByRole('region', { name: 'CanvasForge MCP server' });
    expect(server).toHaveTextContent('1.6.32');
    expect(server).toHaveTextContent('14');
    expect(screen.getByRole('group', { name: 'Codex MCP client' }).querySelector('[data-mcp-client-state]')).toHaveAttribute('data-mcp-client-state', 'configured');
    expect(screen.getByRole('group', { name: 'WorkBuddy MCP client' }).querySelector('[data-mcp-client-state]')).toHaveAttribute('data-mcp-client-state', 'unconfigured');

    fireEvent.click(screen.getByRole('button', { name: 'Connect WorkBuddy' }));
    expect(screen.getByRole('dialog', { name: 'Confirm WorkBuddy connection' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm WorkBuddy config write' }));
    await waitFor(() => expect(connect).toHaveBeenCalledWith('workbuddy'));

    fireEvent.click(screen.getByRole('button', { name: 'Copy Codex config' }));
    await waitFor(() => expect(copyConfig).toHaveBeenCalledWith('codex'));
    expect(writeText).toHaveBeenCalledWith('codex-stdio-config');

    fireEvent.click(screen.getByRole('button', { name: 'Test Codex connection' }));
    await waitFor(() => expect(testConnection).toHaveBeenCalledWith('codex'));
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect Codex' }));
    await waitFor(() => expect(disconnect).toHaveBeenCalledWith('codex'));
  });

  it('shows desktop-only MCP state in browser mode without active integration controls', () => {
    window.novusDesktop = undefined;
    render(<SettingsDrawer providerStatus={null} onClose={vi.fn()} onProviderStatusChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('tab', { name: /MCP/u }));

    expect(screen.getByTestId('mcp-desktop-only')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Connect Codex' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Connect WorkBuddy' })).toBeDisabled();
  });
it('keeps safe permission defaults and the workflow capability summary below the live MCP clients', () => {
    window.novusDesktop = undefined;
    render(<SettingsDrawer providerStatus={null} onClose={vi.fn()} onProviderStatusChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('tab', { name: /MCP/u }));

    expect(screen.getByTestId('settings-mcp-card')).toBeVisible();
    expect(screen.getByRole('group', { name: 'Codex MCP client' })).toBeVisible();
    expect(screen.getByRole('group', { name: 'WorkBuddy MCP client' })).toBeVisible();
    expect(screen.getByRole('checkbox', { name: '读取画布' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: '编辑画布' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: '管理画布' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: '执行 AI 生成' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: '导出文件' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: '外部文件读写' })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: '危险操作' })).not.toBeChecked();
    expect(screen.getByText('canvasforge.mcp.workflow.v1')).toBeVisible();
  });

  it('copies the executable client config from the trusted desktop bridge without credentials', async () => {
    const config = '[mcp_servers.canvasforge]\ncommand = "CanvasForge.exe"\nargs = ["canvasforge-mcp.cjs"]\n';
    const writeText = vi.fn<(text: string) => Promise<void>>(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    window.novusDesktop = {
      mcpRuntime: { getStatus: vi.fn(async () => ({ state: 'running' as const, rendererConnected: true, serverVersion: '1.6.32', toolCount: 14 as const, lastError: null })) },
      mcpIntegration: {
        getStatus: vi.fn(async () => [
          { client: 'codex' as const, state: 'configured' as const, toolCount: 0 as const, lastError: null },
          { client: 'workbuddy' as const, state: 'unconfigured' as const, toolCount: 0 as const, lastError: null },
        ]),
        connect: vi.fn(), disconnect: vi.fn(), test: vi.fn(),
        copyConfig: vi.fn(async () => ({ client: 'codex' as const, config })),
      },
    } as unknown as typeof window.novusDesktop;

    render(<SettingsDrawer providerStatus={null} onClose={vi.fn()} onProviderStatusChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('tab', { name: /MCP/u }));
    await screen.findByRole('region', { name: 'CanvasForge MCP server' });
    fireEvent.click(screen.getByRole('button', { name: 'Copy Codex config' }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(config));
    expect(config).not.toMatch(/apiKey|token|secret|password|Authorization/i);
  });
  it('checks connection from advanced diagnostics without submitting a paid generation job', async () => {
    const checkConnection = vi.fn(async () => ({ status: 'connected' as const }));
    const submitImageJob = vi.fn();
    window.novusDesktop = {
      provider: {
        checkConnection,
        submitImageJob,
      },
    } as unknown as typeof window.novusDesktop;

    render(<SettingsDrawer
      providerStatus={{ configured: true, locked: false, encryption: 'safeStorage' }}
      onClose={vi.fn()}
      onProviderStatusChange={vi.fn()}
    />);

    fireEvent.click(screen.getByRole('tab', { name: '同步' }));
    fireEvent.click(screen.getByText('高级故障排查'));
    expect(screen.getByRole('region', { name: '连接与恢复' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: '应用更新' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '检查连接' }));

    await waitFor(() => expect(checkConnection).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('连接成功')).toBeVisible();
    expect(submitImageJob).not.toHaveBeenCalled();
  });

  it('checks the mock-only update feed and shows its release announcement without downloading an installer', async () => {
    const check = vi.fn(async () => ({ state: { status: 'available' as const, version: '1.2.0', notes: 'Improved canvas stability.' } }));
    const download = vi.fn();
    window.novusDesktop = {
      updates: { getState: vi.fn(async () => ({ status: 'idle' })), check, download, defer: vi.fn(), retry: vi.fn(), restart: vi.fn() },
    } as unknown as typeof window.novusDesktop;

    render(<SettingsDrawer providerStatus={null} onClose={vi.fn()} onProviderStatusChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('tab', { name: '同步' }));
    fireEvent.click(screen.getByText('高级故障排查'));
    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));

    expect(await screen.findByText('1.2.0')).toBeVisible();
    expect(screen.getByText('Improved canvas stability.')).toBeVisible();
    expect(download).not.toHaveBeenCalled();
  });

  it('saves the selected default image route without resubmitting a credential', async () => {
    const updateProfiles = vi.fn(async () => ({ configured: true, locked: false, encryption: 'safeStorage' as const }));
    window.novusDesktop = { provider: { listProfiles: vi.fn(async () => [{ provider: 'comfly', modelRoute: 'image-default', displayName: 'GPT Image 2', modelId: 'gpt-image-2', capabilities: ['image_generation'] }]), updateProfiles } } as unknown as typeof window.novusDesktop;
    render(<SettingsDrawer providerStatus={{ configured: true, locked: false, encryption: 'safeStorage' }} onClose={vi.fn()} onProviderStatusChange={vi.fn()} />);

    await screen.findByLabelText('启用 GPT Image 2');
    fireEvent.change(screen.getByLabelText('生图默认模型'), { target: { value: 'comfly:image-default' } });
    fireEvent.click(screen.getByRole('button', { name: '保存 Comfly 模型选择' }));

    await waitFor(() => expect(updateProfiles).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'comfly',
      profiles: [expect.objectContaining({ modelRoute: 'image-default', modelId: 'gpt-image-2', capabilities: ['image_generation'] })],
    })));
  });

  it('restores saved default routes into the matching model selectors', async () => {
    window.novusDesktop = {
      provider: {
        listProfiles: vi.fn(async () => [{ provider: 'comfly', modelRoute: 'image-default', displayName: '生图默认模型', modelId: 'gpt-image-2', capabilities: ['image_generation', 'async_tasks'] }]),
      },
    } as unknown as typeof window.novusDesktop;

    render(<SettingsDrawer providerStatus={{ configured: true, locked: false, encryption: 'safeStorage' }} onClose={vi.fn()} onProviderStatusChange={vi.fn()} />);

    await waitFor(() => expect(screen.getByLabelText('生图默认模型')).toHaveValue('comfly:image-default'));
  });
  it('keeps the hidden-key dialog open and shows an actionable error when credential persistence fails', async () => {
    const configure = vi.fn(async () => { throw new Error('credential write failed'); });
    window.novusDesktop = {
      provider: {
        getStatus: vi.fn(async () => ({ configured: false, locked: true, encryption: 'safeStorage' as const })),
        listProfiles: vi.fn(async () => []),
        configure,
      },
    } as unknown as typeof window.novusDesktop;
    render(<SettingsDrawer providerStatus={{ configured: false, locked: true, encryption: 'safeStorage' }} onClose={vi.fn()} onProviderStatusChange={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: '配置隐藏密钥' }));
    fireEvent.change(screen.getByLabelText('Comfly API 密钥'), { target: { value: 'secret-token' } });
    fireEvent.click(screen.getByRole('button', { name: '保存隐藏密钥' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('密钥未保存');
    expect(screen.getByRole('dialog', { name: '配置隐藏密钥' })).toBeVisible();
    expect(screen.getByLabelText('Comfly API 密钥')).toHaveValue('secret-token');
  });

  it('accepts a pasted RelayMe Authorization header without storing a duplicated Bearer prefix', async () => {
    const configure = vi.fn(async () => ({ configured: true, locked: false, encryption: 'safeStorage' as const }));
    window.novusDesktop = {
      provider: {
        configure,
        getStatus: vi.fn(async () => ({ configured: true, locked: false, encryption: 'safeStorage' as const })),
        listProfiles: vi.fn(async () => []),
        checkConnection: vi.fn(async () => ({ status: 'authentication_failed' as const })),
      },
    } as unknown as typeof window.novusDesktop;
    render(<SettingsDrawer providerStatus={null} onClose={vi.fn()} onProviderStatusChange={vi.fn()} />);

    fireEvent.click(await screen.findByRole('listitem', { name: /RelayMe/u }));
    fireEvent.click(screen.getByRole('button', { name: '配置隐藏密钥' }));
    fireEvent.change(screen.getByLabelText('RelayMe API 密钥'), { target: { value: '  Bearer sk_ai_example_key  ' } });
    fireEvent.click(screen.getByRole('button', { name: '保存隐藏密钥' }));

    await waitFor(() => expect(configure).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'relayme',
      token: 'sk_ai_example_key',
    })));
  });
  it.each([
    ['INVALID_REQUEST', '密钥或接口地址格式不正确'],
    ['CREDENTIALS_LOCKED', '系统凭据库暂不可用'],
    ['PROVIDER_UNAVAILABLE', '桌面模型服务不可用'],
  ])('shows a specific safe credential error for %s', async (code, message) => {
    const configure = vi.fn(async () => {
      const error = new Error('redacted provider failure') as Error & { code: string };
      error.code = code;
      throw error;
    });
    window.novusDesktop = {
      provider: {
        getStatus: vi.fn(async () => ({ configured: false, locked: true, encryption: 'safeStorage' as const })),
        listProfiles: vi.fn(async () => []),
        configure,
      },
    } as unknown as typeof window.novusDesktop;
    render(<SettingsDrawer providerStatus={{ configured: false, locked: true, encryption: 'safeStorage' }} onClose={vi.fn()} onProviderStatusChange={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: '配置隐藏密钥' }));
    fireEvent.change(screen.getByLabelText('Comfly API 密钥'), { target: { value: 'secret-token' } });
    fireEvent.click(screen.getByRole('button', { name: '保存隐藏密钥' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(screen.getByLabelText('Comfly API 密钥')).toHaveValue('secret-token');
  });
  it('does not report success until the saved credential can be read back as configured', async () => {
    const configure = vi.fn(async () => ({ configured: true, locked: false, encryption: 'safeStorage' as const }));
    const getStatus = vi.fn(async () => ({ configured: false, locked: true, encryption: 'safeStorage' as const }));
    window.novusDesktop = {
      provider: { getStatus, listProfiles: vi.fn(async () => []), configure },
    } as unknown as typeof window.novusDesktop;
    render(<SettingsDrawer providerStatus={{ configured: false, locked: true, encryption: 'safeStorage' }} onClose={vi.fn()} onProviderStatusChange={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: '配置隐藏密钥' }));
    fireEvent.change(screen.getByLabelText('Comfly API 密钥'), { target: { value: 'secret-token' } });
    fireEvent.click(screen.getByRole('button', { name: '保存隐藏密钥' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('保存后校验失败');
    expect(screen.getByRole('dialog', { name: '配置隐藏密钥' })).toBeVisible();
    expect(screen.getByLabelText('Comfly API 密钥')).toHaveValue('secret-token');
  });

  it('shows a visible desktop bridge error instead of silently ignoring credential save', async () => {
    window.novusDesktop = undefined;
    render(<SettingsDrawer providerStatus={null} onClose={vi.fn()} onProviderStatusChange={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: '配置隐藏密钥' }));
    fireEvent.change(screen.getByLabelText('Comfly API 密钥'), { target: { value: 'secret-token' } });
    fireEvent.click(screen.getByRole('button', { name: '保存隐藏密钥' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('桌面模型服务不可用');
  });
  it('times out a stalled credential save, keeps the token, and prevents duplicate submissions', async () => {
    vi.useFakeTimers();
    const configure = vi.fn(() => new Promise<never>(() => undefined));
    window.novusDesktop = {
      provider: {
        getStatus: vi.fn(async () => ({ configured: true, locked: false, encryption: 'safeStorage' as const })),
        listProfiles: vi.fn(async () => []),
        configure,
      },
    } as unknown as typeof window.novusDesktop;
    render(<SettingsDrawer providerStatus={{ configured: false, locked: false, encryption: 'safeStorage' }} onClose={vi.fn()} onProviderStatusChange={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: '配置隐藏密钥' }));
    fireEvent.change(screen.getByLabelText('Comfly API 密钥'), { target: { value: 'secret-token' } });
    const saveButton = screen.getByRole('button', { name: '保存隐藏密钥' });
    fireEvent.click(saveButton);
    fireEvent.click(saveButton);

    expect(configure).toHaveBeenCalledTimes(1);
    expect(within(screen.getByRole('dialog', { name: '配置隐藏密钥' })).getByRole('button', { name: '正在保存…' })).toBeDisabled();
    await vi.advanceTimersByTimeAsync(12_000);

    expect(screen.getByRole('alert')).toHaveTextContent('保存超时');
    expect(screen.getByRole('dialog', { name: '配置隐藏密钥' })).toBeVisible();
    expect(screen.getByLabelText('Comfly API 密钥')).toHaveValue('secret-token');
    vi.useRealTimers();
  });
  it('offers a local passphrase fallback when system credential encryption is unavailable', async () => {
    const configure = vi.fn(async () => ({ configured: true, locked: false, encryption: 'passphrase' as const }));
    window.novusDesktop = {
      provider: {
        getStatus: vi.fn(async () => ({ configured: false, locked: true, encryption: 'unavailable' as const })),
        listProfiles: vi.fn(async () => []),
        configure,
      },
    } as unknown as typeof window.novusDesktop;
    render(<SettingsDrawer providerStatus={{ configured: false, locked: true, encryption: 'unavailable' }} onClose={vi.fn()} onProviderStatusChange={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: '配置隐藏密钥' }));
    fireEvent.change(screen.getByLabelText('Comfly API 密钥'), { target: { value: 'secret-token' } });
    expect(screen.getByLabelText('本机加密口令')).toBeVisible();
    expect(screen.getByRole('button', { name: '保存隐藏密钥' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('本机加密口令'), { target: { value: 'local-passphrase' } });
    fireEvent.click(screen.getByRole('button', { name: '保存隐藏密钥' }));

    await waitFor(() => expect(configure).toHaveBeenCalledWith(expect.objectContaining({ token: 'secret-token', passphrase: 'local-passphrase' })));
  });
});
