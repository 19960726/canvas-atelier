import { readFileSync } from 'node:fs';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
  it('exposes the Canvas settings heading, close control, and segmented tabs with readable Chinese labels', () => {
    render(<SettingsDrawer providerStatus={null} onClose={vi.fn()} onProviderStatusChange={vi.fn()} />);

    expect(screen.getByTestId('settings-drawer')).toHaveAttribute('data-canvas-surface', 'settings');
    expect(screen.getByTestId('settings-drawer-heading')).toHaveTextContent('设置');
    expect(screen.getByTestId('settings-drawer-heading')).toHaveTextContent('Settings');
    expect(screen.getByTestId('settings-drawer-close')).toHaveAccessibleName('关闭设置');
    expect(screen.getByRole('tablist', { name: '设置分类' })).toHaveAttribute('data-canvas-tabs', 'segmented');
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'API 与模型', '存储与备份', 'MCP 联动', '同步',
    ]);
    expect(screen.queryByRole('tab', { name: '使用说明' })).not.toBeInTheDocument();
  });

  it('uses four equal shared-theme columns for the four settings tabs', () => {
    const css = readFileSync('apps/renderer/src/styles/canvas-layout.css', 'utf8');
    const tabsRule = css.match(/\.workspace--canvas-layout \.settings-tabs \{[^}]+\}/u)?.[0];

    expect(tabsRule).toContain('grid-template-columns: repeat(4, minmax(104px, 1fr))');
    expect(tabsRule).not.toContain('repeat(5');
  });

  it('uses a two-provider final layout and compact capability metadata in both themes', () => {
    const css = readFileSync('apps/renderer/src/styles/canvas-layout.css', 'utf8');
    const finalContract = css.slice(css.lastIndexOf('/* Dual-provider settings final contract */'));

    expect(finalContract).toContain('grid-template-columns: repeat(2, minmax(0, 1fr))');
    expect(finalContract).toContain('.settings-model-provider');
    expect(finalContract).toContain('.settings-model-constraints');
    expect(finalContract).toContain(":root[data-theme='dark']");
    expect(finalContract).toContain(":root[data-theme='light']");
  });
  it('keeps advanced diagnostics compact instead of inheriting the retired oversized card rules', () => {
    const css = readFileSync('apps/renderer/src/styles/canvas-layout.css', 'utf8');
    const finalDiagnostics = css.slice(css.lastIndexOf('/* Final compact diagnostics contract */'));

    expect(finalDiagnostics).toContain('.workspace--canvas-layout .settings-status-card');
    expect(finalDiagnostics).toContain('min-height: 0 !important');
    expect(finalDiagnostics).toContain('font-size: 14px !important');
    expect(finalDiagnostics).toContain('align-items: center !important');
  });
  it('uses the compact provider credential layout from the approved settings reference', () => {
    const css = readFileSync('apps/renderer/src/styles/canvas-layout.css', 'utf8');
    const contract = css.slice(css.lastIndexOf('/* Final provider credential layout contract */'));

    expect(contract).toContain('.settings-key-heading');
    expect(contract).toContain('grid-template-columns: minmax(0, 1fr) auto');
    expect(contract).toContain('.settings-provider-endpoint');
    expect(contract).toContain('padding: 14px');
    expect(contract).toContain('.settings-key-actions');
    expect(contract).toContain('align-items: center');
  });

  it('keeps RelayMe compatibility actions horizontal instead of collapsing the copy into a narrow column', () => {
    const css = readFileSync('apps/renderer/src/styles/release-layout-contract.css', 'utf8');
    const contract = css.slice(css.lastIndexOf('/* FINAL PROVIDER COMPATIBILITY ACTIONS CONTRACT */'));

    expect(contract).toContain('.settings-key-actions');
    expect(contract).toContain('grid-template-columns: minmax(0, 1fr) !important');
    expect(contract).toContain('.settings-provider-compatibility');
    expect(contract).toContain('white-space: nowrap');
    expect(contract).toContain('flex-wrap: wrap');
  });

  it('keeps long model names readable with a simple checkbox-and-name model row', () => {
    const css = readFileSync('apps/renderer/src/styles/canvas-layout.css', 'utf8');
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
    const link = screen.getByRole('link', { name: '打开 RelayMe 网站' });
    expect(link).toHaveAttribute('href', 'https://www.ml.relayme.uk/');
    expect(screen.queryByRole('link', { name: '创建 API Key' })).not.toBeInTheDocument();
    expect(screen.queryByText('高级兼容方式')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '配置隐藏密钥' })).not.toBeInTheDocument();
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
    expect(screen.getByRole('tablist', { name: '模型能力分类' })).toBeVisible();
    expect(screen.queryByRole('region', { name: '对话模型' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: '视频理解模型' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('启用 Nano Banana Pro')).toBeChecked();
    fireEvent.click(screen.getByRole('tab', { name: /对话模型/u }));
    expect(screen.getByRole('region', { name: '对话模型' })).toBeVisible();
    expect(screen.getByLabelText('启用 GPT 4.1')).toBeChecked();
    fireEvent.click(screen.getByRole('tab', { name: /反推模型/u }));
    expect(screen.getByRole('region', { name: '反推模型' })).toBeVisible();
    expect(screen.getByLabelText('启用 Gemini 3.1 Pro')).toBeChecked();
    fireEvent.click(screen.getByRole('tab', { name: /视频模型/u }));
    expect(screen.getByRole('region', { name: '视频模型' })).toBeVisible();
    expect(screen.getByLabelText('启用 Veo 3 Fast')).toBeChecked();
    fireEvent.click(screen.getByRole('tab', { name: /视觉模型/u }));
    expect(screen.getByRole('region', { name: '视觉模型' })).toBeVisible();
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

  it('notifies the canvas after switching the durable active provider', async () => {
    const getActiveProvider = vi.fn(async () => ({ activeProvider: 'comfly' as const }));
    const setActiveProvider = vi.fn(async ({ activeProvider }: { activeProvider: 'comfly' | 'relayme' }) => ({ activeProvider }));
    const getStatus = vi.fn(async () => ({ configured: true, locked: false, encryption: 'safeStorage' as const }));
    const listProfiles = vi.fn(async ({ provider }: { provider?: 'comfly' | 'relayme' } = {}) => provider === 'relayme'
      ? [{ provider: 'relayme' as const, modelRoute: 'relayme/vision', displayName: 'Relay Vision', modelId: 'relayme-vision', capabilities: ['chat' as const, 'vision' as const, 'reverse_prompt' as const] }]
      : [{ provider: 'comfly' as const, modelRoute: 'comfly/vision', displayName: 'Comfly Vision', modelId: 'comfly-vision', capabilities: ['chat' as const, 'vision' as const, 'reverse_prompt' as const] }]);
    const changedProviders: string[] = [];
    const onCatalogChanged = (event: Event) => {
      const provider = (event as CustomEvent<{ provider?: unknown }>).detail?.provider;
      if (typeof provider === 'string') changedProviders.push(provider);
    };
    window.addEventListener('novus:provider-catalog-changed', onCatalogChanged);
    window.novusDesktop = { provider: { getActiveProvider, setActiveProvider, getStatus, listProfiles } } as unknown as typeof window.novusDesktop;

    try {
      render(<SettingsDrawer providerStatus={null} onClose={vi.fn()} onProviderStatusChange={vi.fn()} />);
      fireEvent.click(await screen.findByRole('listitem', { name: /RelayMe/u }));

      await waitFor(() => expect(setActiveProvider).toHaveBeenCalledWith({ activeProvider: 'relayme' }));
      expect(changedProviders).toContain('relayme');
    } finally {
      window.removeEventListener('novus:provider-catalog-changed', onCatalogChanged);
    }
  });

  it('notifies the canvas after RelayMe logout clears the active provider', async () => {
    const getActiveProvider = vi.fn(async () => ({ activeProvider: 'relayme' as const }));
    const logoutRelayMe = vi.fn(async () => ({ activeProvider: null }));
    const getStatus = vi.fn(async ({ provider }: { provider?: 'comfly' | 'relayme' } = {}) => ({
      configured: provider === 'relayme', locked: false, encryption: 'safeStorage' as const,
    }));
    const listProfiles = vi.fn(async ({ provider }: { provider?: 'comfly' | 'relayme' } = {}) => provider === 'relayme'
      ? [{ provider: 'relayme' as const, modelRoute: 'relayme/vision', displayName: 'Relay Vision', modelId: 'relayme-vision', capabilities: ['chat' as const, 'vision' as const, 'reverse_prompt' as const] }]
      : []);
    const changedProviders: unknown[] = [];
    const onCatalogChanged = (event: Event) => {
      changedProviders.push((event as CustomEvent<{ provider?: unknown }>).detail?.provider);
    };
    window.addEventListener('novus:provider-catalog-changed', onCatalogChanged);
    window.novusDesktop = { provider: { getActiveProvider, logoutRelayMe, getStatus, listProfiles } } as unknown as typeof window.novusDesktop;

    try {
      render(<SettingsDrawer providerStatus={null} onClose={vi.fn()} onProviderStatusChange={vi.fn()} />);
      await waitFor(() => expect(screen.getByRole('button', { name: '退出 RelayMe' })).toBeVisible());
      fireEvent.click(screen.getByRole('button', { name: '退出 RelayMe' }));

      await waitFor(() => expect(logoutRelayMe).toHaveBeenCalledTimes(1));
      expect(changedProviders).toContain(null);
    } finally {
      window.removeEventListener('novus:provider-catalog-changed', onCatalogChanged);
    }
  });

  it('organizes the API tab as a layered workbench with chat adaptation guidance', async () => {
    render(<SettingsDrawer providerStatus={{ configured: true, locked: false, encryption: 'safeStorage' }} onClose={vi.fn()} onProviderStatusChange={vi.fn()} />);
    expect(screen.getByTestId('settings-api-status-layer')).toBeInTheDocument();
    expect(screen.getByTestId('settings-provider-layer')).toBeInTheDocument();
    expect(screen.getByTestId('settings-model-layer')).toBeInTheDocument();
    expect(screen.getByTestId('settings-diagnostics-layer')).toBeInTheDocument();
    expect(screen.getByText(/对话模型适配/u)).toBeVisible();
  });

  it('marks storage, MCP, and sync surfaces as layered workbench sections', async () => {
    render(<SettingsDrawer providerStatus={{ configured: true, locked: false, encryption: 'safeStorage' }} onClose={vi.fn()} onProviderStatusChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('tab', { name: '存储与备份' }));
    expect(screen.getByTestId('settings-storage-directory-layer')).toBeInTheDocument();
    expect(screen.getByTestId('settings-storage-local-layer')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'MCP 联动' }));
    expect(screen.getByTestId('settings-mcp-card')).toHaveClass('settings-layer');
    fireEvent.click(screen.getByRole('tab', { name: '同步' }));
    expect(screen.getByTestId('settings-sync-card')).toHaveClass('settings-layer');
    expect(screen.getByTestId('settings-sync-diagnostics-layer')).toHaveClass('settings-layer');
  });

  it('logs into RelayMe with account credentials, activates it, and clears the password on close', async () => {
    const getActiveProvider = vi.fn(async () => ({ activeProvider: null }));
    const setActiveProvider = vi.fn(async ({ activeProvider }: { activeProvider: 'comfly' | 'relayme' }) => ({ activeProvider }));
    const loginRelayMe = vi.fn(async ({ username, password }: { username: string; password: string }) => {
      expect(username).toBe('artist@example.test');
      expect(password).toBe('not-a-real-password');
      return { activeProvider: 'relayme' as const };
    });
    const getStatus = vi.fn(async ({ provider }: { provider?: 'comfly' | 'relayme' } = {}) => ({
      configured: provider === 'relayme',
      locked: false,
      encryption: 'safeStorage' as const,
    }));
    const listProfiles = vi.fn(async ({ provider }: { provider?: 'comfly' | 'relayme' } = {}) => provider === 'relayme'
      ? [{ provider: 'relayme' as const, modelRoute: 'chat/general', displayName: 'Relay Chat', modelId: 'relay-chat', capabilities: ['chat' as const] }]
      : []);
    window.novusDesktop = {
      provider: { getActiveProvider, setActiveProvider, loginRelayMe, getStatus, listProfiles },
    } as unknown as typeof window.novusDesktop;

    render(<SettingsDrawer providerStatus={null} onClose={vi.fn()} onProviderStatusChange={vi.fn()} />);

    fireEvent.click(await screen.findByRole('listitem', { name: /RelayMe/u }));
    fireEvent.click(within(screen.getByTestId('settings-provider-layer')).getByRole('button', { name: '重新登录 RelayMe' }));
    const dialog = screen.getByRole('dialog', { name: '登录 RelayMe' });
    fireEvent.change(within(dialog).getByLabelText('RelayMe 账号'), { target: { value: 'artist@example.test' } });
    fireEvent.change(within(dialog).getByLabelText('RelayMe 密码'), { target: { value: 'not-a-real-password' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '使用账号密码登录' }));

    await waitFor(() => expect(loginRelayMe).toHaveBeenCalledWith({
      username: 'artist@example.test',
      password: 'not-a-real-password',
    }));
    await waitFor(() => expect(screen.getByRole('listitem', { name: /RelayMe/u })).toHaveAttribute('aria-pressed', 'true'));
    expect(screen.queryByRole('dialog', { name: '登录 RelayMe' })).not.toBeInTheDocument();
    expect((await screen.findAllByText('Relay Chat')).length).toBeGreaterThanOrEqual(1);
    expect(listProfiles).toHaveBeenCalledWith({ provider: 'relayme' });

    fireEvent.click(within(screen.getByTestId('settings-provider-layer')).getByRole('button', { name: '重新登录 RelayMe' }));
    const reopenedDialog = screen.getByRole('dialog', { name: '登录 RelayMe' });
    expect(within(reopenedDialog).getByLabelText('RelayMe 密码')).toHaveValue('');
    fireEvent.click(within(reopenedDialog).getByRole('button', { name: '取消' }));
    expect(screen.queryByRole('dialog', { name: '登录 RelayMe' })).not.toBeInTheDocument();
  });

  it('keeps RelayMe login failures visible inside the dialog and releases the controls', async () => {
    const loginError = {
      code: 'PROVIDER_ERROR',
      message: 'RelayMe username or password is invalid',
      retryable: false,
    };
    const loginRelayMe = vi.fn(async () => Promise.reject(loginError));
    window.novusDesktop = {
      provider: {
        getActiveProvider: vi.fn(async () => ({ activeProvider: null })),
        setActiveProvider: vi.fn(),
        loginRelayMe,
        getStatus: vi.fn(async () => ({ configured: false, locked: false, encryption: 'safeStorage' as const })),
        listProfiles: vi.fn(async () => []),
      },
    } as unknown as typeof window.novusDesktop;

    render(<SettingsDrawer providerStatus={null} onClose={vi.fn()} onProviderStatusChange={vi.fn()} />);
    fireEvent.click(await screen.findByRole('listitem', { name: /RelayMe/u }));
    const dialog = screen.getByRole('dialog', { name: '登录 RelayMe' });
    fireEvent.change(within(dialog).getByLabelText('RelayMe 账号'), { target: { value: 'artist@example.test' } });
    fireEvent.change(within(dialog).getByLabelText('RelayMe 密码'), { target: { value: 'not-a-real-password' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '使用账号密码登录' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('RelayMe 账号或密码错误');
    expect(within(dialog).getByLabelText('RelayMe 密码')).toHaveValue('');
    expect(within(dialog).getByRole('button', { name: '取消' })).toBeEnabled();
    expect(within(dialog).getByRole('button', { name: '使用账号密码登录' })).toBeDisabled();
  });

  it('does not misreport a post-login model catalog failure as a password error', async () => {
    const loginRelayMe = vi.fn(async () => Promise.reject({
      code: 'PROVIDER_ERROR',
      message: 'RelayMe 登录成功，但模型目录读取失败，请稍后重试',
      retryable: true,
    }));
    window.novusDesktop = {
      provider: {
        getActiveProvider: vi.fn(async () => ({ activeProvider: null })),
        setActiveProvider: vi.fn(),
        loginRelayMe,
        getStatus: vi.fn(async () => ({ configured: false, locked: false, encryption: 'safeStorage' as const })),
        listProfiles: vi.fn(async () => []),
      },
    } as unknown as typeof window.novusDesktop;

    render(<SettingsDrawer providerStatus={null} onClose={vi.fn()} onProviderStatusChange={vi.fn()} />);
    fireEvent.click(await screen.findByRole('listitem', { name: /RelayMe/u }));
    const dialog = screen.getByRole('dialog', { name: '登录 RelayMe' });
    fireEvent.change(within(dialog).getByLabelText('RelayMe 账号'), { target: { value: 'artist@example.test' } });
    fireEvent.change(within(dialog).getByLabelText('RelayMe 密码'), { target: { value: 'not-a-real-password' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '使用账号密码登录' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('RelayMe 登录成功，但模型目录读取失败，请稍后重试');
    expect(within(dialog).getByRole('alert')).not.toHaveTextContent('密码错误');
  });

  it('times out an unresponsive RelayMe login and lets the user retry or cancel', async () => {
    vi.useFakeTimers();
    const loginRelayMe = vi.fn(() => new Promise<never>(() => undefined));
    window.novusDesktop = {
      provider: {
        getActiveProvider: vi.fn(async () => ({ activeProvider: null })),
        setActiveProvider: vi.fn(),
        loginRelayMe,
        getStatus: vi.fn(async () => ({ configured: false, locked: false, encryption: 'safeStorage' as const })),
        listProfiles: vi.fn(async () => []),
      },
    } as unknown as typeof window.novusDesktop;

    render(<SettingsDrawer providerStatus={null} onClose={vi.fn()} onProviderStatusChange={vi.fn()} />);
    await vi.advanceTimersByTimeAsync(0);
    fireEvent.click(screen.getByRole('listitem', { name: /RelayMe/u }));
    const dialog = screen.getByRole('dialog', { name: '登录 RelayMe' });
    fireEvent.change(within(dialog).getByLabelText('RelayMe 账号'), { target: { value: 'artist@example.test' } });
    fireEvent.change(within(dialog).getByLabelText('RelayMe 密码'), { target: { value: 'not-a-real-password' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '使用账号密码登录' }));
    expect(within(dialog).getByRole('button', { name: '账号密码登录中…' })).toBeDisabled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(35_000);
    });

    expect(within(dialog).getByRole('alert')).toHaveTextContent('RelayMe 登录超时，请检查网络后重试');
    expect(within(dialog).getByRole('button', { name: '取消' })).toBeEnabled();
  });

  it('uses RelayMe web login as the primary action and refreshes the verified model catalog', async () => {
    const loginRelayMeWeb = vi.fn(async () => ({ activeProvider: 'relayme' as const }));
    const relayProfiles = [
      { provider: 'relayme' as const, modelRoute: 'image/gpt-image-2', displayName: 'Relay Image', modelId: 'gpt-image-2', capabilities: ['image_generation' as const] },
      { provider: 'relayme' as const, modelRoute: 'video/kling-v3', displayName: 'Relay Video', modelId: 'kling-v3', capabilities: ['video_generation' as const] },
    ];
    const listProfiles = vi.fn(async ({ provider }: { provider?: 'comfly' | 'relayme' } = {}) => provider === 'relayme' ? relayProfiles : []);
    const getStatus = vi.fn(async ({ provider }: { provider?: 'comfly' | 'relayme' } = {}) => ({
      configured: provider === 'relayme', locked: false, encryption: 'safeStorage' as const,
    }));
    window.novusDesktop = {
      provider: {
        getActiveProvider: vi.fn(async () => ({ activeProvider: null })),
        setActiveProvider: vi.fn(async ({ activeProvider }: { activeProvider: 'comfly' | 'relayme' }) => ({ activeProvider })), loginRelayMeWeb, getStatus, listProfiles,
      },
    } as unknown as typeof window.novusDesktop;

    render(<SettingsDrawer providerStatus={null} onClose={vi.fn()} onProviderStatusChange={vi.fn()} />);
    fireEvent.click(await screen.findByRole('listitem', { name: /RelayMe/u }));
    fireEvent.click(within(screen.getByTestId('settings-provider-layer')).getByRole('button', { name: '重新登录 RelayMe' }));
    const dialog = screen.getByRole('dialog', { name: '登录 RelayMe' });
    fireEvent.click(within(dialog).getByRole('button', { name: '使用 RelayMe 网页登录' }));

    await waitFor(() => expect(loginRelayMeWeb).toHaveBeenCalledWith());
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '登录 RelayMe' })).not.toBeInTheDocument());
    expect(screen.getByRole('status')).toHaveTextContent('RelayMe 网页登录成功，API 已自动连接，已加载 2 个模型');
    expect((await screen.findAllByText('GPT Image 2')).length).toBeGreaterThanOrEqual(1);
    expect(listProfiles).toHaveBeenCalledWith({ provider: 'relayme' });
  });

  it('labels an already configured RelayMe account as re-login', async () => {
    window.novusDesktop = {
      provider: {
        getActiveProvider: vi.fn(async () => ({ activeProvider: 'relayme' as const })),
        setActiveProvider: vi.fn(async ({ activeProvider }: { activeProvider: 'comfly' | 'relayme' }) => ({ activeProvider })),
        getStatus: vi.fn(async ({ provider }: { provider?: 'comfly' | 'relayme' } = {}) => ({
          configured: provider === 'relayme', locked: false, encryption: 'safeStorage' as const,
        })),
        listProfiles: vi.fn(async () => []),
        loginRelayMeWeb: vi.fn(async () => ({ activeProvider: 'relayme' as const })),
      },
    } as unknown as typeof window.novusDesktop;

    render(<SettingsDrawer providerStatus={{ configured: true, locked: false, encryption: 'safeStorage' }} onClose={vi.fn()} onProviderStatusChange={vi.fn()} />);
    await screen.findByRole('listitem', { name: /RelayMe/u });
    expect(within(screen.getByTestId('settings-provider-layer')).getByRole('button', { name: '重新登录 RelayMe' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '登录 RelayMe' })).not.toBeInTheDocument();
  });

  it.each([
    ['WEB_LOGIN_CANCELLED', '已取消 RelayMe 网页登录'],
    ['WEB_LOGIN_TIMEOUT', 'RelayMe 网页登录超时，请重新打开登录'],
    ['CREDENTIALS_LOCKED', 'RelayMe 网页登录已失效，请重新登录'],
  ])('shows a precise %s web-login result without reporting a password error', async (code, expectedMessage) => {
    window.novusDesktop = {
      provider: {
        getActiveProvider: vi.fn(async () => ({ activeProvider: null })),
        setActiveProvider: vi.fn(async ({ activeProvider }: { activeProvider: 'comfly' | 'relayme' }) => ({ activeProvider })),
        loginRelayMeWeb: vi.fn(async () => Promise.reject({ code, message: 'sanitized', retryable: false })),
        getStatus: vi.fn(async () => ({ configured: false, locked: false, encryption: 'safeStorage' as const })),
        listProfiles: vi.fn(async () => []),
      },
    } as unknown as typeof window.novusDesktop;

    render(<SettingsDrawer providerStatus={null} onClose={vi.fn()} onProviderStatusChange={vi.fn()} />);
    fireEvent.click(await screen.findByRole('listitem', { name: /RelayMe/u }));
    fireEvent.click(screen.getByRole('button', { name: '登录 RelayMe' }));
    const dialog = screen.getByRole('dialog', { name: '登录 RelayMe' });
    fireEvent.click(within(dialog).getByRole('button', { name: '使用 RelayMe 网页登录' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(expectedMessage);
    expect(within(dialog).getByRole('alert')).not.toHaveTextContent('密码');
    expect(within(dialog).getByRole('button', { name: '使用 RelayMe 网页登录' })).toBeEnabled();
  });

  it('marks a saved RelayMe credential with no usable models as waiting for verification', async () => {
    window.novusDesktop = {
      provider: {
        getActiveProvider: vi.fn(async () => ({ activeProvider: 'relayme' as const })),
        setActiveProvider: vi.fn(),
        loginRelayMeWeb: vi.fn(),
        getStatus: vi.fn(async () => ({ configured: true, locked: false, encryption: 'safeStorage' as const })),
        listProfiles: vi.fn(async () => []),
      },
    } as unknown as typeof window.novusDesktop;

    render(<SettingsDrawer providerStatus={null} onClose={vi.fn()} onProviderStatusChange={vi.fn()} />);

    const relayMeCard = await screen.findByRole('listitem', { name: /RelayMe/u });
    await waitFor(() => expect(relayMeCard).toHaveAccessibleName('RelayMe · 凭据待重新验证'));
    expect(screen.getByLabelText('RelayMe 凭据摘要')).toHaveTextContent('凭据待重新验证');
  });

  it('does not show inactive provider models when the active-provider bridge is available', async () => {
    const getActiveProvider = vi.fn(async () => ({ activeProvider: 'comfly' as const }));
    const listProfiles = vi.fn(async ({ provider }: { provider?: 'comfly' | 'relayme' } = {}) => [
      { provider: 'comfly' as const, modelRoute: 'chat/comfly', displayName: 'Comfly Chat', modelId: 'comfly-chat', capabilities: ['chat' as const] },
      ...(provider === 'relayme'
        ? [{ provider: 'relayme' as const, modelRoute: 'chat/relay', displayName: 'Relay Chat', modelId: 'relay-chat', capabilities: ['chat' as const] }]
        : []),
    ]);
    window.novusDesktop = {
      provider: { getActiveProvider, setActiveProvider: vi.fn(), getStatus: vi.fn(async () => ({ configured: true, locked: false, encryption: 'safeStorage' as const })), listProfiles },
    } as unknown as typeof window.novusDesktop;

    render(<SettingsDrawer providerStatus={{ configured: true, locked: false, encryption: 'safeStorage' }} onClose={vi.fn()} onProviderStatusChange={vi.fn()} />);

    expect((await screen.findAllByText('Comfly Chat')).length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText('Relay Chat')).not.toBeInTheDocument();
    expect(listProfiles).toHaveBeenCalledWith({ provider: 'comfly' });
  });

  it('clears the previous provider catalog while a newly activated provider is still loading', async () => {
    let rejectRelayProfiles!: (error: Error) => void;
    const relayProfiles = new Promise<never>((_resolve, reject) => { rejectRelayProfiles = reject; });
    const getActiveProvider = vi.fn(async () => ({ activeProvider: 'comfly' as const }));
    const setActiveProvider = vi.fn(async () => ({ activeProvider: 'relayme' as const }));
    const listProfiles = vi.fn(({ provider }: { provider?: 'comfly' | 'relayme' } = {}) => provider === 'relayme'
      ? relayProfiles
      : Promise.resolve([{
        provider: 'comfly' as const,
        modelRoute: 'comfly-image',
        displayName: 'Comfly Previous Model',
        modelId: 'comfly-image',
        capabilities: ['image_generation' as const],
      }]));
    window.novusDesktop = {
      provider: {
        getActiveProvider,
        setActiveProvider,
        getStatus: vi.fn(async () => ({ configured: true, locked: false, encryption: 'safeStorage' as const })),
        listProfiles,
      },
    } as unknown as typeof window.novusDesktop;

    render(<SettingsDrawer providerStatus={{ configured: true, locked: false, encryption: 'safeStorage' }} onClose={vi.fn()} onProviderStatusChange={vi.fn()} />);
    expect((await screen.findAllByText('Comfly Previous Model')).length).toBeGreaterThanOrEqual(1);

    fireEvent.click(screen.getByRole('listitem', { name: /RelayMe/u }));
    await waitFor(() => expect(listProfiles).toHaveBeenCalledWith({ provider: 'relayme' }));

    expect(screen.queryAllByText('Comfly Previous Model')).toHaveLength(0);
    expect(screen.getByText('当前供应商尚未加载模型')).toBeVisible();
    rejectRelayProfiles(new Error('temporary RelayMe catalog failure'));
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

  it('reports a stalled provider check as a timeout instead of falsely claiming the network is unavailable', async () => {
    vi.useFakeTimers();
    window.novusDesktop = {
      provider: {
        getStatus: vi.fn(async () => ({ configured: true, locked: false, encryption: 'safeStorage' as const })),
        listProfiles: vi.fn(async () => []),
        checkConnection: vi.fn(() => new Promise<never>(() => undefined)),
      },
    } as unknown as typeof window.novusDesktop;

    render(<SettingsDrawer providerStatus={{ configured: true, locked: false, encryption: 'safeStorage' }} onClose={vi.fn()} onProviderStatusChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: '检测连接' }));
    await vi.advanceTimersByTimeAsync(35_000);

    expect(screen.getAllByText('连接检测超时').length).toBeGreaterThan(0);
    expect(screen.queryByText('网络不可用')).not.toBeInTheDocument();
    vi.useRealTimers();
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
    expect(screen.queryByRole('button', { name: '配置隐藏密钥' })).not.toBeInTheDocument();
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
    const link = screen.getByRole('link', { name: '打开 RelayMe 网站' });
    expect(link).toHaveAttribute('href', 'https://www.ml.relayme.uk/');
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

  it('renders storage and backup using Canvas-style cache cards without the retired capacity preview control', () => {
    render(<SettingsDrawer providerStatus={null} onClose={vi.fn()} onProviderStatusChange={vi.fn()} />);

    fireEvent.click(screen.getByRole('tab', { name: '存储与备份' }));

    expect(screen.getByLabelText('下载输出目录')).toBeVisible();
    expect(screen.getByLabelText('本地保存')).toBeVisible();
    expect(screen.getByRole('button', { name: '刷新' }).querySelector(':scope > .settings-action-content')).not.toBeNull();
    expect(screen.getByTestId('settings-storage-card')).toHaveAttribute('data-canvas-layout', 'storage');
    expect(screen.getByRole('button', { name: '清理全部缓存' })).toBeVisible();
    expect(screen.getAllByRole('button', { name: '清理' })).toHaveLength(4);
    expect(screen.queryByRole('button', { name: '10GB 清理预览' })).toBeNull();
  });

  it('uses the final shared button contract for cache and update actions', () => {
    const css = readFileSync('apps/renderer/src/styles/release-layout-contract.css', 'utf8');
    const contract = css.slice(css.lastIndexOf('/* FINAL SETTINGS BUTTON CONTRACT */'));

    expect(contract).toContain('.settings-cache-action');
    expect(contract).toContain('.settings-cache-primary-action');
    expect(contract).toContain('.settings-cache-item-action');
    expect(contract).toContain('.settings-update-action');
    expect(contract).toContain('.settings-connection-check');
    expect(contract).toContain('.settings-storage-refresh');
    expect(contract).toContain('height: 34px !important');
    expect(contract).toContain('min-height: 34px !important');
    expect(contract).toContain('flex-direction: row !important');
    expect(contract).toContain('flex: 0 0 auto !important');
    expect(contract).toContain(':hover:not(:disabled)');
  });

  it('gives the update announcement actions a clear canvas-style layout', () => {
    const css = readFileSync('apps/renderer/src/styles/release-layout-contract.css', 'utf8');
    const contract = css.slice(css.lastIndexOf('/* UPDATE ANNOUNCEMENT CARD */'));

    expect(contract).toContain('.settings-update-dialog__actions');
    expect(contract).toContain('gap: 12px !important');
    expect(contract).toContain('min-width: 112px !important');
    expect(contract).toContain('justify-content: flex-start !important');
  });

  it('keeps the settings drawer opaque so the canvas minimap cannot bleed through it', () => {
    const css = readFileSync('apps/renderer/src/styles/release-layout-contract.css', 'utf8');
    const contract = css.slice(css.lastIndexOf('/* FINAL SETTINGS DRAWER OCCLUSION CONTRACT */'));

    expect(contract).toContain('.workspace--canvas-layout .settings-drawer');
    expect(contract).toContain('background: var(--gate-card) !important');
    expect(contract).toContain('backdrop-filter: none !important');
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

    const server = await screen.findByRole('region', { name: 'Canvas Atelier MCP server' });
    expect(server).toHaveTextContent('1.6.32');
    expect(server).toHaveTextContent('14');
    expect(screen.getByRole('group', { name: 'Codex MCP client' }).querySelector('[data-mcp-client-state]')).toHaveAttribute('data-mcp-client-state', 'configured');
    expect(screen.getByRole('group', { name: 'WorkBuddy MCP client' }).querySelector('[data-mcp-client-state]')).toHaveAttribute('data-mcp-client-state', 'unconfigured');

    fireEvent.click(screen.getByRole('button', { name: 'Connect WorkBuddy' }));
    const confirmation = screen.getByRole('dialog', { name: 'Confirm WorkBuddy connection' });
    expect(confirmation).toBeVisible();
    expect(confirmation).toHaveTextContent('只写入 Canvas Atelier 这一项');
    expect(confirmation).toHaveTextContent('canvas_atelier');
    expect(confirmation).not.toHaveTextContent(/CanvasForge|canvasforge/u);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm WorkBuddy config write' }));
    await waitFor(() => expect(connect).toHaveBeenCalledWith('workbuddy'));
    const workBuddyClient = screen.getByRole('group', { name: 'WorkBuddy MCP client' });
    expect(workBuddyClient.querySelector('[data-mcp-client-state]')).toHaveTextContent('配置匹配 · 桥接可用');
    expect(workBuddyClient).not.toHaveTextContent('已连接');
    expect(screen.getByText('WorkBuddy 配置与当前安装版匹配，14 个工具桥接可用；这不代表已打开的客户端已重载配置。')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Copy Codex config' }));
    await waitFor(() => expect(copyConfig).toHaveBeenCalledWith('codex'));
    expect(writeText).toHaveBeenCalledWith('codex-stdio-config');

    fireEvent.click(screen.getByRole('button', { name: 'Test Codex connection' }));
    await waitFor(() => expect(testConnection).toHaveBeenCalledWith('codex'));
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect Codex' }));
    await waitFor(() => expect(disconnect).toHaveBeenCalledWith('codex'));
  });

  it('warns that a matching WorkBuddy config still needs trust approval and a client reload', async () => {
    window.novusDesktop = {
      mcpRuntime: { getStatus: vi.fn(async () => ({ state: 'running' as const, rendererConnected: true, serverVersion: '1.6.100', toolCount: 14 as const, lastError: null })) },
      mcpIntegration: {
        getStatus: vi.fn(async () => [
          { client: 'codex' as const, state: 'configured' as const, toolCount: 0 as const, lastError: null },
          { client: 'workbuddy' as const, state: 'connected' as const, toolCount: 14 as const, lastError: null },
        ]),
        connect: vi.fn(), disconnect: vi.fn(), test: vi.fn(), copyConfig: vi.fn(),
      },
    } as unknown as typeof window.novusDesktop;

    render(<SettingsDrawer providerStatus={null} onClose={vi.fn()} onProviderStatusChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('tab', { name: /MCP/u }));

    const workBuddyClient = await screen.findByRole('group', { name: 'WorkBuddy MCP client' });
    expect(workBuddyClient.querySelector('[data-mcp-client-state]')).toHaveTextContent('配置匹配 · 桥接可用');
    expect(screen.getByTestId('mcp-workbuddy-trust-hint')).toHaveTextContent('配置匹配不等于 WorkBuddy 已加载');
    expect(screen.getByTestId('mcp-workbuddy-trust-hint')).toHaveTextContent(/Trust|信任/u);
    expect(screen.getByTestId('mcp-workbuddy-trust-hint')).toHaveTextContent(/刷新或重启 WorkBuddy/u);
  });

  it('explains how to repair a stale MCP client entry instead of calling it connected', async () => {
    const testConnection = vi.fn(async () => ({
      client: 'codex' as const,
      state: 'connection_failed' as const,
      toolCount: 0 as const,
      lastError: 'MCP_CONFIG_MISMATCH',
    }));
    window.novusDesktop = {
      mcpRuntime: { getStatus: vi.fn(async () => ({ state: 'running' as const, rendererConnected: true, serverVersion: '1.6.100', toolCount: 14 as const, lastError: null })) },
      mcpIntegration: {
        getStatus: vi.fn(async () => [
          { client: 'codex' as const, state: 'configured' as const, toolCount: 0 as const, lastError: null },
          { client: 'workbuddy' as const, state: 'unconfigured' as const, toolCount: 0 as const, lastError: null },
        ]),
        connect: vi.fn(), disconnect: vi.fn(), test: testConnection, copyConfig: vi.fn(),
      },
    } as unknown as typeof window.novusDesktop;

    render(<SettingsDrawer providerStatus={null} onClose={vi.fn()} onProviderStatusChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('tab', { name: /MCP/u }));
    await screen.findByRole('region', { name: 'Canvas Atelier MCP server' });
    fireEvent.click(screen.getByRole('button', { name: 'Test Codex connection' }));

    expect(await screen.findByText('Codex 配置与当前安装版不一致，请点击连接重新写入。')).toBeVisible();
    expect(screen.getByRole('group', { name: 'Codex MCP client' }).querySelector('[data-mcp-client-state]'))
      .toHaveAttribute('data-mcp-client-state', 'connection_failed');
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
    expect(screen.getByText('本机工作流协议 v1')).toBeVisible();
    expect(screen.getByTestId('settings-mcp-card')).not.toHaveTextContent(/CanvasForge|canvasforge/u);
  });

  it('persists MCP permission changes across settings drawer remounts', () => {
    const storageKey = 'agent-canvas:mcp-permissions:v1';
    localStorage.removeItem(storageKey);
    window.novusDesktop = undefined;
    const first = render(<SettingsDrawer providerStatus={null} onClose={vi.fn()} onProviderStatusChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('tab', { name: /MCP/u }));
    fireEvent.click(screen.getByRole('checkbox', { name: '外部文件读写' }));
    expect(screen.getByRole('checkbox', { name: '外部文件读写' })).toBeChecked();

    first.unmount();
    render(<SettingsDrawer providerStatus={null} onClose={vi.fn()} onProviderStatusChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('tab', { name: /MCP/u }));

    expect(screen.getByRole('checkbox', { name: '外部文件读写' })).toBeChecked();
    localStorage.removeItem(storageKey);
  });

  it('describes only implemented MCP permissions and marks reserved capabilities honestly', () => {
    window.novusDesktop = undefined;
    render(<SettingsDrawer providerStatus={null} onClose={vi.fn()} onProviderStatusChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('tab', { name: /MCP/u }));

    expect(screen.getByText('预留权限；当前 MCP 没有新建、切换、重命名或复制整张画布的工具。')).toBeVisible();
    expect(screen.getByText('预留权限；当前 MCP 没有导出文件工具。')).toBeVisible();
    expect(screen.getByText('只能打开 Canvas Atelier 自己的图片或视频选择器；MCP 不能读写任意外部路径。')).toBeVisible();
    expect(screen.queryByText('允许访问项目外部文件，默认关闭。')).not.toBeInTheDocument();
  });

  it('copies the executable client config from the trusted desktop bridge without credentials', async () => {
    const config = '[mcp_servers.canvas_atelier]\ncommand = "Canvas Atelier.exe"\nargs = ["canvasforge-mcp.cjs"]\n';
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
    await screen.findByRole('region', { name: 'Canvas Atelier MCP server' });
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
    expect(screen.getByRole('button', { name: '检查连接' }).querySelector(':scope > .settings-action-content')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Check for updates' }).querySelector(':scope > .settings-action-content')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '检查连接' }));

    await waitFor(() => expect(checkConnection).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('连接成功')).toBeVisible();
    expect(submitImageJob).not.toHaveBeenCalled();
  });

  it('subscribes to updater events and requires explicit download and restart actions', async () => {
    let publishUpdate: ((state: import('@agent-canvas/desktop-core').UpdateState) => void) | undefined;
    const unsubscribe = vi.fn();
    const subscribeState = vi.fn((listener: (state: import('@agent-canvas/desktop-core').UpdateState) => void) => {
      publishUpdate = listener;
      return unsubscribe;
    });
    const check = vi.fn(async () => ({ state: { status: 'checking' as const } }));
    const download = vi.fn(async () => ({ state: { status: 'downloading' as const, version: '1.6.63', progress: 0 } }));
    const restart = vi.fn(async () => ({ accepted: true as const }));
    window.novusDesktop = {
      updates: { getState: vi.fn(async () => ({ status: 'idle', currentVersion: '1.6.72' })), subscribeState, check, download, defer: vi.fn(), retry: vi.fn(), restart },
    } as unknown as typeof window.novusDesktop;

    const rendered = render(<SettingsDrawer providerStatus={null} onClose={vi.fn()} onProviderStatusChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('tab', { name: '同步' }));
    fireEvent.click(screen.getByText('高级故障排查'));
    expect(await screen.findByText('v1.6.72')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Check for updates' }));

    expect(await screen.findByRole('dialog', { name: '应用更新' })).toBeVisible();
    expect(screen.getByText('正在检查更新…')).toBeVisible();

    await waitFor(() => expect(subscribeState).toHaveBeenCalledTimes(1));
    publishUpdate?.({ status: 'available', version: '1.6.63', notes: 'Improved canvas stability.' });
    expect(await screen.findByRole('dialog', { name: '应用更新' })).toBeVisible();
    expect(screen.getByText('发现新版本 1.6.63')).toBeVisible();
    expect(screen.getByText('Improved canvas stability.')).toBeVisible();
    const updateDialog = screen.getByRole('dialog', { name: '应用更新' });
    expect(within(updateDialog).getByText('桌面版本更新')).toBeVisible();
    expect(within(updateDialog).getByText('v1.6.63')).toBeVisible();
    expect(within(updateDialog).getByRole('region', { name: '更新说明' })).toHaveTextContent('本次更新');
    expect(within(updateDialog).getByText('更新内容')).toBeVisible();
    expect(download).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '下载更新' }));
    await waitFor(() => expect(download).toHaveBeenCalledTimes(1));

    publishUpdate?.({ status: 'downloading', version: '1.6.63', progress: 0.42 });
    expect(await screen.findByText('下载进度 42%')).toBeVisible();
    publishUpdate?.({ status: 'ready_to_restart', version: '1.6.63', progress: 1 });
    expect(await screen.findByRole('button', { name: '重启并安装' })).toBeVisible();
    expect(restart).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '重启并安装' }));
    await waitFor(() => expect(restart).toHaveBeenCalledTimes(1));

    rendered.unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
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
