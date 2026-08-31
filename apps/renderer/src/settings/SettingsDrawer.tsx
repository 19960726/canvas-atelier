import { useEffect, useRef, useState } from 'react';
import { Cable, Check, Copy, Database, Eye, EyeOff, KeyRound, Layers3, Link2, RefreshCw, ShieldCheck, X } from 'lucide-react';
import { createCodexWorkflowContract, DEFAULT_MCP_PERMISSION_FLAGS, type McpPermissionFlags } from '@agent-canvas/domain';
import type { ThemePreference } from '../theme/theme';
import type {
  GenerationHistoryCapacityBridgeResult,
  ProviderBridgeProfile,
  ProviderConfigurationStatus,
  UpdateState,
} from '@agent-canvas/desktop-core';
import { ProviderModelCatalog, createProviderProfileKey, type CatalogCapability } from './ProviderModelCatalog';
import { ProviderOperationTimeoutError, withProviderOperationTimeout } from './provider-operation-timeout';
import { filterProviderCatalogProfiles, listActiveProviderProfiles, selectFirstProfileForCapability } from '../app/provider-profiles';

type ProviderBridgeProvider = ProviderBridgeProfile['provider'];

interface SettingsDrawerProps {
  providerStatus: ProviderConfigurationStatus | null;
  theme?: ThemePreference;
  knowledgeBases?: readonly {
    knowledgeBaseId: string;
    displayName: string | null;
    activeVersion: number | null;
    activeContentHash: string | null;
    status: string;
  }[];
  knowledgeSyncStatuses?: readonly {
    knowledgeBaseId: string;
    status: 'syncing' | 'updated' | 'offline' | 'conflict';
    changedAt: string;
    lastFailure: { reason: string; failedAt: string } | null;
  }[];
  onConfigureKnowledgeBase?: (knowledgeBaseId: string, displayName: string) => Promise<void>;
  onRefreshKnowledge?: () => Promise<void>;
  onClose: () => void;
  onProviderStatusChange: (status: ProviderConfigurationStatus) => void;
}

const EMPTY_KNOWLEDGE_BASES: NonNullable<SettingsDrawerProps['knowledgeBases']> = [];
const EMPTY_KNOWLEDGE_SYNC_STATUSES: NonNullable<SettingsDrawerProps['knowledgeSyncStatuses']> = [];
const REQUIRED_KNOWLEDGE_BASES = [
  { knowledgeBaseId: 'scene-skill', displayName: '场景 Skill', description: '产品场景、构图、材质与灯光规则' },
  { knowledgeBaseId: 'ecommerce-detail-knowledge', displayName: '电商详情页知识库', description: '详情页结构、卖点表达与视觉规范' },
] as const;

type ConnectionStatus = 'unconfigured' | 'connected' | 'authentication_failed' | 'network_unavailable' | 'service_limited' | 'connection_timeout';
const PROVIDER_CONNECTION_CHECK_TIMEOUT_MS = 35_000;
const RELAYME_LOGIN_TIMEOUT_MS = 35_000;
type DesktopMcpIntegration = NonNullable<typeof window.novusDesktop>['mcpIntegration'];
type DesktopMcpRuntime = NonNullable<typeof window.novusDesktop>['mcpRuntime'];
type McpClientId = Parameters<DesktopMcpIntegration['connect']>[0];
type McpClientStatus = Awaited<ReturnType<DesktopMcpIntegration['connect']>>;
type McpRuntimePublicStatus = Awaited<ReturnType<DesktopMcpRuntime['getStatus']>>;
type SettingsTab = 'api' | 'storage' | 'mcp' | 'sync';
type CacheAction = 'choose' | 'open' | 'reset' | null;
type CacheDirectoryState = {
  readonly path: string;
  readonly isDefault: boolean;
  readonly available: boolean;
  readonly busy: boolean;
  readonly error: string | null;
};
type SettingsStorageBridge = {
  getCacheDirectory(): Promise<CacheDirectoryState>;
  chooseCacheDirectory(): Promise<CacheDirectoryState | null>;
  resetCacheDirectory(): Promise<CacheDirectoryState>;
  openCacheDirectory(): Promise<{ opened: boolean }>;
};
type McpPermissionKey = keyof McpPermissionFlags;

const CREDENTIAL_SAVE_ERROR_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  INVALID_REQUEST: '密钥或接口地址格式不正确',
  CREDENTIALS_LOCKED: '系统凭据库暂不可用',
  PROVIDER_UNAVAILABLE: '桌面模型服务不可用',
});
const SAVED_CREDENTIAL_MASK = '••••••••••••••••';

function credentialSaveErrorMessage(error: unknown): string | null {
  if (error === null || typeof error !== 'object' || !('code' in error)) return null;
  const code = (error as { readonly code?: unknown }).code;
  return typeof code === 'string' ? CREDENTIAL_SAVE_ERROR_MESSAGES[code] ?? null : null;
}

function relayMeLoginErrorMessage(error: unknown): string {
  if (error instanceof ProviderOperationTimeoutError) {
    return 'RelayMe 登录超时，请检查网络后重试';
  }
  const code = error !== null && typeof error === 'object' && 'code' in error
    ? (error as { readonly code?: unknown }).code
    : null;
  if (code === 'INVALID_CREDENTIALS') return 'RelayMe 账号或密码错误';
  if (code === 'ACCOUNT_RESTRICTED') return 'RelayMe 账号已受限，请前往工作台确认账号状态';
  if (code === 'NETWORK_ERROR') return 'RelayMe 登录网络请求失败，请检查网络后重试';
  if (code === 'SERVICE_UNAVAILABLE') return 'RelayMe 登录服务暂时不可用，请稍后重试';
  const detail = error instanceof Error
    ? error.message
    : error !== null && typeof error === 'object' && 'message' in error && typeof (error as { readonly message?: unknown }).message === 'string'
      ? (error as { readonly message: string }).message
      : '';
  if (/username or password is invalid|账号或密码错误/iu.test(detail)) return 'RelayMe 账号或密码错误';
  if (/登录成功.*模型目录.*失败/iu.test(detail)) return 'RelayMe 登录成功，但模型目录读取失败，请稍后重试';
  if (/login response did not include a token|登录响应.*令牌/iu.test(detail)) return 'RelayMe 登录响应缺少有效令牌，请联系 RelayMe 检查接口';
  if (/login response is invalid|登录响应.*无效/iu.test(detail)) return 'RelayMe 登录响应格式无效，请稍后重试';
  if (code === 'CREDENTIALS_LOCKED') return 'RelayMe 登录已失效，请重新登录';
  if (code === 'PROVIDER_ERROR') return 'RelayMe 登录网络或服务请求失败，请稍后重试';
  if (code === 'PROVIDER_UNAVAILABLE') return 'RelayMe 登录服务暂时不可用，请稍后重试';
  return 'RelayMe 登录失败，请检查网络连接或服务状态';
}

function relayMeWebLoginErrorMessage(error: unknown): string {
  if (error instanceof ProviderOperationTimeoutError) {
    return 'RelayMe 网页登录超时，请重新打开登录';
  }
  const code = error !== null && typeof error === 'object' && 'code' in error
    ? (error as { readonly code?: unknown }).code
    : null;
  if (code === 'WEB_LOGIN_CANCELLED') return '已取消 RelayMe 网页登录';
  if (code === 'WEB_LOGIN_TIMEOUT') return 'RelayMe 网页登录超时，请重新打开登录';
  if (code === 'CREDENTIALS_LOCKED' || code === 'PROVIDER_INVALID_RESPONSE') return 'RelayMe 网页登录已失效，请重新登录';
  const detail = error instanceof Error
    ? error.message
    : error !== null && typeof error === 'object' && 'message' in error && typeof (error as { readonly message?: unknown }).message === 'string'
      ? (error as { readonly message: string }).message
      : '';
  if (/没有可用模型|模型目录读取失败/iu.test(detail)) return detail;
  if (code === 'PROVIDER_UNAVAILABLE') return 'RelayMe 网页登录服务暂时不可用，请稍后重试';
  return 'RelayMe 网页登录失败，请稍后重试';
}

const MCP_PERMISSION_ITEMS: readonly {
  readonly key: McpPermissionKey;
  readonly label: string;
  readonly description: string;
  readonly tone?: 'danger';
}[] = Object.freeze([
  { key: 'readCanvas', label: '读取画布', description: '读取当前画布、节点、连线、选中项和工作流能力。' },
  { key: 'editCanvas', label: '编辑画布', description: '创建和修改节点、连线、分组，并执行事务式写入。' },
  { key: 'manageCanvas', label: '管理画布', description: '新建、切换、重命名、复制画布，并定位指定节点。' },
  { key: 'executeAiGeneration', label: '执行 AI 生成', description: '允许工作流触发生图、分析等会消耗模型额度的任务。' },
  { key: 'exportFiles', label: '导出文件', description: '读取或导出生图结果、工作流和运行归档。' },
  { key: 'externalFileAccess', label: '外部文件读写', description: '允许访问项目外部文件，默认关闭。' },
  { key: 'dangerousOperations', label: '危险操作', description: '允许删除、覆盖已有内容和恢复旧快照，默认关闭。', tone: 'danger' },
]);

export function SettingsDrawer({
  providerStatus,
  knowledgeBases = EMPTY_KNOWLEDGE_BASES,
  knowledgeSyncStatuses = EMPTY_KNOWLEDGE_SYNC_STATUSES,
  onConfigureKnowledgeBase,
  onRefreshKnowledge,
  onClose,
  onProviderStatusChange,
}: SettingsDrawerProps) {
  const [baseUrl, setBaseUrl] = useState(() => providerBaseUrlPlaceholder('comfly'));
  const [hiddenKeysOpen, setHiddenKeysOpen] = useState(false);
  const [providerToken, setProviderToken] = useState('');
  const [credentialRevealed, setCredentialRevealed] = useState(false);
  const [revealingCredential, setRevealingCredential] = useState(false);
  const credentialRevealRequest = useRef(0);

  const [passphrase, setPassphrase] = useState('');
  const [hiddenKeyError, setHiddenKeyError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [connectionState, setConnectionState] = useState<'idle' | 'checking' | ConnectionStatus>('idle');
  const [capacity, setCapacity] = useState<GenerationHistoryCapacityBridgeResult | null>(null);
  const [selectedProvider, setSelectedProvider] = useState<ProviderBridgeProvider>('comfly');
  const [activeProvider, setActiveProvider] = useState<ProviderBridgeProvider | null>(null);
  const [loadingActiveProvider, setLoadingActiveProvider] = useState(false);
  const [relayMeLoginOpen, setRelayMeLoginOpen] = useState(false);
  const [relayMeUsername, setRelayMeUsername] = useState('');
  const [relayMePassword, setRelayMePassword] = useState('');
  const [relayMeLoginBusy, setRelayMeLoginBusy] = useState(false);
  const [relayMeLoginError, setRelayMeLoginError] = useState<string | null>(null);
  const [providerStatuses, setProviderStatuses] = useState<Record<ProviderBridgeProvider, ProviderConfigurationStatus | null>>({
    comfly: providerStatus,
    relayme: null,
  });
  const [providerProfiles, setProviderProfiles] = useState<ProviderBridgeProfile[]>([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [enabledProfileKeys, setEnabledProfileKeys] = useState<string[]>([]);
  const [defaultProfileKeys, setDefaultProfileKeys] = useState<Partial<Record<CatalogCapability, string>>>({});
  const providerSelectionRequest = useRef(0);

  const [savingDefaults, setSavingDefaults] = useState(false);
  const [cleaningStorage, setCleaningStorage] = useState(false);
  const [cacheDirectory, setCacheDirectory] = useState<CacheDirectoryState | null>(null);
  const [cacheAction, setCacheAction] = useState<CacheAction>(null);
  const [cacheError, setCacheError] = useState<string | null>(null);
  const [selectedKnowledgeBaseIds, setSelectedKnowledgeBaseIds] = useState<string[]>([]);
const [mcpPermissions, setMcpPermissions] = useState<McpPermissionFlags>(DEFAULT_MCP_PERMISSION_FLAGS);
  const [mcpRuntimeStatus, setMcpRuntimeStatus] = useState<McpRuntimePublicStatus | null>(null);
  const [mcpClientStatuses, setMcpClientStatuses] = useState<readonly McpClientStatus[]>([]);
  const [mcpBusyClient, setMcpBusyClient] = useState<McpClientId | null>(null);
  const [mcpError, setMcpError] = useState<string | null>(null);
  const [pendingMcpConnect, setPendingMcpConnect] = useState<McpClientId | null>(null);
  const [autoSaveCanvas, setAutoSaveCanvas] = useState(true);
  const [canvasNavigatorEnabled, setCanvasNavigatorEnabled] = useState(true);
  const [webWindowEnabled, setWebWindowEnabled] = useState(true);
  const [syncingKnowledgeBaseId, setSyncingKnowledgeBaseId] = useState<string | null>(null);
  const [syncingAllKnowledge, setSyncingAllKnowledge] = useState(false);
  const availableKnowledgeBases = knowledgeBases ?? EMPTY_KNOWLEDGE_BASES;
  const bridge = window.novusDesktop as (NonNullable<typeof window.novusDesktop> & {
    storage?: SettingsStorageBridge;
  }) | undefined;
  const [updateState, setUpdateState] = useState<UpdateState>({ status: 'idle' });
  const [updateDialogOpen, setUpdateDialogOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<SettingsTab>('api');
  const codexWorkflowContract = createCodexWorkflowContract();
  const provider = bridge?.provider;
  const selectedProviderStatus = providerStatuses[selectedProvider] ?? (selectedProvider === 'comfly' ? providerStatus : null);
  const modelRefreshRequest = useRef(0);
  const hasActiveProviderApi = Boolean(provider?.getActiveProvider && provider?.setActiveProvider);
  const effectiveActiveProvider = hasActiveProviderApi ? activeProvider : selectedProvider;
  const catalogProvider = effectiveActiveProvider;
  const relayMeNeedsVerification = selectedProvider === 'relayme'
    && selectedProviderStatus?.configured === true
    && effectiveActiveProvider === 'relayme'
    && !loadingModels
    && providerProfiles.length === 0;

  const refreshAvailableModels = async (providerId: ProviderBridgeProvider = selectedProvider): Promise<{ ok: true; count: number; reverseCount: number } | { ok: false }> => {
    if (!provider?.listProfiles) return { ok: false };
    const requestId = ++modelRefreshRequest.current;
    setLoadingModels(true);
    try {
      const profiles = await provider.listProfiles({ provider: providerId });
      if (requestId !== modelRefreshRequest.current || providerId !== catalogProvider) return { ok: false };
      const scoped = filterProviderCatalogProfiles(listActiveProviderProfiles(profiles, catalogProvider));
      setProviderProfiles(scoped);
      setEnabledProfileKeys(scoped.map(createProviderProfileKey));
      setDefaultProfileKeys(createDefaultProfileSelection(scoped));
      return { ok: true, count: scoped.length, reverseCount: scoped.filter(isRunnableReverseProfile).length };
    } catch {
      if (requestId !== modelRefreshRequest.current || providerId !== catalogProvider) return { ok: false };
      // A catalog refresh is allowed to fail transiently (network, provider
      // throttling, or a short-lived API outage). Do not erase the last usable
      // model inventory and turn every generation rail into "未配置模型".
      return { ok: false };
    } finally {
      if (requestId === modelRefreshRequest.current) setLoadingModels(false);
    }
  };
  const saveDefaultModels = async () => {
    if (!provider?.updateProfiles || savingDefaults) return;
    const enabled = providerProfiles.filter((profile) => enabledProfileKeys.includes(createProviderProfileKey(profile)));
    if (!enabled.length) return;
    const providerId = catalogProvider ?? selectedProvider;
    setSavingDefaults(true);
    try {
      const status = await provider.updateProfiles({ provider: providerId, profiles: enabled });
      setProviderStatuses((current) => ({ ...current, [providerId]: status }));
      onProviderStatusChange(status);
      setMessage(`已保存 ${enabled.length} 个 ${formatProviderName(providerId)} 模型`);
    } catch {
      setMessage('模型选择保存失败，请检查当前供应商连接状态');
    } finally {
      setSavingDefaults(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    bridge?.history?.getCapacity()
      .then((result) => {
        if (!cancelled) setCapacity(result);
      })
      .catch(() => {
        if (!cancelled) setCapacity(null);
      });
    return () => {
      cancelled = true;
    };
  }, [bridge?.history]);

  useEffect(() => {
    let cancelled = false;
    if (!bridge?.storage) {
      setCacheDirectory(null);
      setCacheError(null);
      return () => { cancelled = true; };
    }
    void bridge.storage.getCacheDirectory()
      .then((state) => {
        if (cancelled) return;
        setCacheDirectory(state);
        setCacheError(state.error);
      })
      .catch(() => {
        if (!cancelled) setCacheError('无法读取缓存目录，请重试。');
      });
    return () => { cancelled = true; };
  }, [bridge?.storage]);

  useEffect(() => {
    const updates = bridge?.updates;
    if (!updates) return undefined;
    let cancelled = false;
    updates.getState()
      .then((state) => { if (!cancelled) setUpdateState(state); })
      .catch(() => { if (!cancelled) setUpdateState({ status: 'error', message: 'Update status is unavailable.' }); });
    const unsubscribe = updates.subscribeState?.((state) => {
      if (!cancelled) setUpdateState(state);
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [bridge?.updates]);

  useEffect(() => {
    if (updateState.status === 'checking'
      || updateState.status === 'available'
      || updateState.status === 'downloading'
      || updateState.status === 'ready_to_restart'
      || updateState.status === 'error') {
      setUpdateDialogOpen(true);
    }
  }, [updateState.status]);
  useEffect(() => {
    if (activeTab !== 'mcp') return;
    let cancelled = false;
    const refreshMcpStatus = async () => {
      if (!bridge?.mcpRuntime || !bridge.mcpIntegration) {
        if (!cancelled) {
          setMcpRuntimeStatus(null);
          setMcpClientStatuses([]);
        }
        return;
      }
      try {
        const [runtimeStatus, clientStatuses] = await Promise.all([
          bridge.mcpRuntime.getStatus(),
          bridge.mcpIntegration.getStatus(),
        ]);
        if (!cancelled) {
          setMcpRuntimeStatus(runtimeStatus);
          setMcpClientStatuses(clientStatuses);
          setMcpError(null);
        }
      } catch {
        if (!cancelled) setMcpError('MCP_STATUS_UNAVAILABLE');
      }
    };
    void refreshMcpStatus();
    const intervalId = window.setInterval(() => { void refreshMcpStatus(); }, 4_000);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [activeTab, bridge?.mcpIntegration, bridge?.mcpRuntime]);

  useEffect(() => {
    setProviderStatuses((current) => ({ ...current, comfly: providerStatus ?? current.comfly ?? null }));
  }, [providerStatus]);

  useEffect(() => {
    if (!provider?.getActiveProvider) {
      setActiveProvider(null);
      return;
    }
    let cancelled = false;
    setLoadingActiveProvider(true);
    const selectionRequestAtStart = providerSelectionRequest.current;
    void provider.getActiveProvider()
      .then((state) => {
        if (cancelled) return;
        if (providerSelectionRequest.current !== selectionRequestAtStart) return;
        setActiveProvider(state.activeProvider);
        if (state.activeProvider !== null) setSelectedProvider(state.activeProvider);
      })
      .catch(() => {
        if (!cancelled) setActiveProvider(null);
      })
      .finally(() => {
        if (!cancelled) setLoadingActiveProvider(false);
      });
    return () => { cancelled = true; };
  }, [provider?.getActiveProvider]);

  useEffect(() => {
    if (!provider?.getStatus) return;
    let cancelled = false;
    void Promise.all((['comfly', 'relayme'] as const).map(async (providerId) => {
      try {
        const status = await provider.getStatus({ provider: providerId });
        if (!cancelled) setProviderStatuses((current) => ({ ...current, [providerId]: status }));
      } catch {
        if (!cancelled) setProviderStatuses((current) => ({ ...current, [providerId]: current[providerId] ?? null }));
      }
    }));
    return () => { cancelled = true; };
  }, [provider?.getStatus]);

  useEffect(() => {
    setConnectionState('idle');
    setBaseUrl(providerBaseUrlPlaceholder(selectedProvider));
    setHiddenKeysOpen(false);
    setProviderToken('');
    setCredentialRevealed(false);
    setRevealingCredential(false);
    credentialRevealRequest.current += 1;
    if (!provider?.listProfiles || catalogProvider === null) {
      setProviderProfiles([]);
      setEnabledProfileKeys([]);
      setDefaultProfileKeys({});
      return;
    }
    setProviderProfiles([]);
    setEnabledProfileKeys([]);
    setDefaultProfileKeys({});
    let cancelled = false;
    setLoadingModels(true);
    void provider.listProfiles({ provider: catalogProvider })
      .then((profiles) => {
        if (cancelled) return;
        const scoped = filterProviderCatalogProfiles(listActiveProviderProfiles(profiles, catalogProvider));
        setProviderProfiles(scoped);
        setEnabledProfileKeys(scoped.map(createProviderProfileKey));
        setDefaultProfileKeys(createDefaultProfileSelection(scoped));
      })
      .catch(() => {
        // Keep the newly selected provider empty instead of showing another
        // provider's stale inventory. Retry can populate it when reachable.
      })
      .finally(() => { if (!cancelled) setLoadingModels(false); });
    return () => { cancelled = true; };
  }, [provider?.listProfiles, catalogProvider]);

  useEffect(() => () => {
    credentialRevealRequest.current += 1;
  }, []);

  useEffect(() => {
    setSelectedKnowledgeBaseIds((current) => current.filter((id) => availableKnowledgeBases.some((base) => base.knowledgeBaseId === id)));
  }, [availableKnowledgeBases]);

  const saveHiddenKeys = async () => {
    if (saving) return;
    const normalizedToken = normalizeProviderToken(providerToken);
    if (normalizedToken.length === 0 || normalizedToken === SAVED_CREDENTIAL_MASK) return;
    if (!provider?.configure) {
      setHiddenKeyError('桌面模型服务不可用，无法保存密钥。请重新启动桌面版后重试。');
      return;
    }
    const providerId = selectedProvider;
    const providerName = formatProviderName(providerId);
    setSaving(true);
    setMessage(null);
    setHiddenKeyError(null);
    try {
      const configuredStatus = await withProviderOperationTimeout(provider.configure({
        provider: providerId,
        token: normalizedToken,
        ...(baseUrl.trim().length > 0 ? { baseUrl: baseUrl.trim() } : {}),
        ...(passphrase.length > 0 ? { passphrase } : {}),
      }), 12_000);
      const persistedStatus = provider.getStatus
        ? await withProviderOperationTimeout(provider.getStatus({ provider: providerId }), 6_000)
        : configuredStatus;
      if (!persistedStatus.configured) throw new Error('CREDENTIAL_NOT_PERSISTED');

      setProviderToken('');
      setCredentialRevealed(false);
      setRevealingCredential(false);
      credentialRevealRequest.current += 1;
      setPassphrase('');
      setHiddenKeysOpen(false);
      setProviderStatuses((current) => ({ ...current, [providerId]: persistedStatus }));
      onProviderStatusChange(persistedStatus);
      globalThis.dispatchEvent(new CustomEvent('novus:provider-catalog-changed', { detail: { provider: providerId } }));

      if (!provider.checkConnection) {
        setMessage('API 密钥已保存到系统安全存储');
        await refreshAvailableModels(providerId);
        return;
      }

      setConnectionState('checking');
      let connectionStatus: ConnectionStatus;
      try {
        connectionStatus = (await withProviderOperationTimeout(provider.checkConnection({ provider: providerId }), PROVIDER_CONNECTION_CHECK_TIMEOUT_MS)).status;
      } catch (error) {
        connectionStatus = error instanceof ProviderOperationTimeoutError ? 'connection_timeout' : 'network_unavailable';
      }
      setConnectionState(connectionStatus);

      if (connectionStatus === 'connected') {
        const refreshResult = await refreshAvailableModels(providerId);
        setMessage(refreshResult.ok
          ? refreshResult.reverseCount > 0
            ? `${providerName} 密钥验证成功，已同步 ${refreshResult.count} 个模型，其中 ${refreshResult.reverseCount} 个支持反推（未执行付费生成测试）`
            : `${providerName} 连接成功，已同步 ${refreshResult.count} 个模型，但没有模型声明反推能力`
          : `${providerName} 密钥验证成功，但模型目录同步失败，请重试`);
        return;
      }

      if (connectionStatus === 'authentication_failed') {
        setProviderProfiles([]);
        setEnabledProfileKeys([]);
        setDefaultProfileKeys({});
        setMessage(`${providerName} 密钥已保存，但密钥无效或不属于当前供应商`);
        return;
      }

      if (connectionStatus === 'service_limited') {
        setMessage(`${providerName} 密钥已保存，但服务暂时受限，请稍后重试`);
        return;
      }
      if (connectionStatus === 'connection_timeout') {
        setMessage(`${providerName} 密钥已保存，但连接检测超时，请稍后重试`);
        return;
      }
      setMessage(`${providerName} 密钥已保存，但暂时无法连接`);
    } catch (error) {
      if (error instanceof ProviderOperationTimeoutError) {
        setHiddenKeyError('密钥保存超时，未确认写入成功。输入内容已保留，请重试。');
      } else if (error instanceof Error && error.message === 'CREDENTIAL_NOT_PERSISTED') {
        setHiddenKeyError('密钥保存后校验失败，安全存储没有返回已配置状态。输入内容已保留。');
      } else {
        setHiddenKeyError(credentialSaveErrorMessage(error)
          ?? '密钥未保存。请检查密钥；如果系统凭据库不可用，请填写本机加密口令后重试。');
      }
      setMessage(`${providerName} 保存失败，请检查密钥或本机安全存储状态`);
    } finally {
      setSaving(false);
    }
  };
  const openHiddenKeys = () => {
    credentialRevealRequest.current += 1;
    setHiddenKeyError(null);
    setCredentialRevealed(false);
    setRevealingCredential(false);
    setProviderToken(selectedProviderStatus?.configured ? SAVED_CREDENTIAL_MASK : '');
    setHiddenKeysOpen(true);
  };
  const closeHiddenKeys = () => {
    credentialRevealRequest.current += 1;
    setProviderToken('');
    setPassphrase('');
    setCredentialRevealed(false);
    setRevealingCredential(false);
    setHiddenKeysOpen(false);
  };
  const closeSettings = () => {
    closeHiddenKeys();
    closeRelayMeLogin();
    onClose();
  };
  const openRelayMeLogin = () => {
    setRelayMeLoginError(null);
    setRelayMeLoginOpen(true);
  };
  const selectActiveProvider = async (providerId: ProviderBridgeProvider) => {
    providerSelectionRequest.current += 1;
    setMessage(null);
    setSelectedProvider(providerId);
    setBaseUrl(providerBaseUrlPlaceholder(providerId));
    if (!hasActiveProviderApi || !provider?.setActiveProvider) return;
    if (providerId === 'relayme' && !providerStatuses.relayme?.configured) {
      openRelayMeLogin();
      return;
    }
    setLoadingActiveProvider(true);
    try {
      const state = await provider.setActiveProvider({ activeProvider: providerId });
      setActiveProvider(state.activeProvider);
      setSelectedProvider(state.activeProvider ?? providerId);
      setMessage(`${formatProviderName(providerId)} 已切换为当前活动供应商`);
    } catch {
      setMessage(`${formatProviderName(providerId)} 切换失败，请检查供应商配置`);
    } finally {
      setLoadingActiveProvider(false);
    }
  };
  const closeRelayMeLogin = () => {
    setRelayMePassword('');
    setRelayMeUsername('');
    setRelayMeLoginError(null);
    setRelayMeLoginBusy(false);
    setRelayMeLoginOpen(false);
  };
  const completeRelayMeLogin = async (
    state: { readonly activeProvider: ProviderBridgeProvider | null },
    successLabel: '账号密码' | '网页',
  ) => {
    setActiveProvider(state.activeProvider);
    setSelectedProvider('relayme');
    if (provider?.getStatus) {
      const status = await provider.getStatus({ provider: 'relayme' });
      setProviderStatuses((current) => ({ ...current, relayme: status }));
    }
    let modelCount = 0;
    if (provider?.listProfiles) {
      const profiles = await provider.listProfiles({ provider: 'relayme' });
      const scoped = filterProviderCatalogProfiles(listActiveProviderProfiles(profiles, 'relayme'));
      setProviderProfiles(scoped);
      setEnabledProfileKeys(scoped.map(createProviderProfileKey));
      setDefaultProfileKeys(createDefaultProfileSelection(scoped));
      modelCount = scoped.length;
    }
    setMessage(successLabel === '网页'
      ? `RelayMe 网页登录成功，已加载 ${modelCount} 个模型`
      : 'RelayMe 登录成功，已切换为当前活动供应商');
    globalThis.dispatchEvent(new CustomEvent('novus:provider-catalog-changed', { detail: { provider: 'relayme' } }));
    setRelayMeLoginOpen(false);
    setRelayMeUsername('');
  };
  const submitRelayMeLogin = async () => {
    if (!provider?.loginRelayMe || relayMeLoginBusy) return;
    const username = relayMeUsername.trim();
    if (username.length === 0 || relayMePassword.length === 0) return;
    setRelayMeLoginBusy(true);
    setRelayMeLoginError(null);
    setMessage(null);
    try {
      const state = await withProviderOperationTimeout(
        provider.loginRelayMe({ username, password: relayMePassword }),
        RELAYME_LOGIN_TIMEOUT_MS,
      );
      await completeRelayMeLogin(state, '账号密码');
    } catch (error) {
      const errorMessage = relayMeLoginErrorMessage(error);
      setRelayMeLoginError(errorMessage);
      setMessage(errorMessage);
    } finally {
      setRelayMePassword('');
      setRelayMeLoginBusy(false);
    }
  };
  const submitRelayMeWebLogin = async () => {
    if (!provider?.loginRelayMeWeb || relayMeLoginBusy) return;
    setRelayMeLoginBusy(true);
    setRelayMeLoginError(null);
    setMessage(null);
    try {
      const state = await withProviderOperationTimeout(
        provider.loginRelayMeWeb(),
        RELAYME_LOGIN_TIMEOUT_MS,
      );
      await completeRelayMeLogin(state, '网页');
    } catch (error) {
      const errorMessage = relayMeWebLoginErrorMessage(error);
      setRelayMeLoginError(errorMessage);
      setMessage(errorMessage);
    } finally {
      setRelayMePassword('');
      setRelayMeLoginBusy(false);
    }
  };
  const logoutRelayMe = async () => {
    if (!provider?.logoutRelayMe || relayMeLoginBusy) return;
    setRelayMeLoginBusy(true);
    try {
      const state = await provider.logoutRelayMe();
      setActiveProvider(state.activeProvider);
      if (state.activeProvider === null) setSelectedProvider('comfly');
      if (provider.getStatus) {
        const status = await provider.getStatus({ provider: 'relayme' });
        setProviderStatuses((current) => ({ ...current, relayme: status }));
      }
      setMessage('RelayMe 已退出登录');
    } catch {
      setMessage('RelayMe 退出登录失败，请稍后重试');
    } finally {
      setRelayMeLoginBusy(false);
    }
  };
  const toggleCredentialReveal = async () => {
    if (saving || revealingCredential) return;
    if (credentialRevealed) {
      credentialRevealRequest.current += 1;
      setProviderToken(SAVED_CREDENTIAL_MASK);
      setCredentialRevealed(false);
      return;
    }
    if (!provider?.revealCredential || !selectedProviderStatus?.configured) {
      setHiddenKeyError('当前供应商没有可显示的已保存密钥。');
      return;
    }
    const requestId = credentialRevealRequest.current + 1;
    credentialRevealRequest.current = requestId;
    setHiddenKeyError(null);
    setRevealingCredential(true);
    try {
      const result = await withProviderOperationTimeout(
        provider.revealCredential({ provider: selectedProvider }),
        6_000,
      );
      if (credentialRevealRequest.current !== requestId) return;
      setProviderToken(result.token);
      setCredentialRevealed(true);
    } catch (error) {
      if (credentialRevealRequest.current !== requestId) return;
      setProviderToken(SAVED_CREDENTIAL_MASK);
      setCredentialRevealed(false);
      setHiddenKeyError(credentialSaveErrorMessage(error) ?? '无法读取已保存密钥，请确认系统凭据库已解锁。');
    } finally {
      if (credentialRevealRequest.current === requestId) setRevealingCredential(false);
    }
  };
  const saveEndpoint = async () => {
    if (!provider || !selectedProviderStatus?.configured || saving || baseUrl.trim().length === 0) return;
    setSaving(true);
    setMessage(null);
    try {
      const status = await provider.configure({ provider: selectedProvider, baseUrl: baseUrl.trim() });
      setProviderStatuses((current) => ({ ...current, [selectedProvider]: status }));
      onProviderStatusChange(status);
      setMessage(`${formatProviderName(selectedProvider)} API 接口地址已保存`);
    } catch {
      setMessage('接口地址保存失败，请先确保当前供应商凭据已配置且可解锁');
    } finally {
      setSaving(false);
    }
  };

  const unlockProvider = async () => {
    if (!provider || passphrase.length === 0 || saving) return;
    setSaving(true);
    setMessage(null);
    try {
      const status = await provider.unlock({ provider: selectedProvider, passphrase });
      setPassphrase('');
      setProviderStatuses((current) => ({ ...current, [selectedProvider]: status }));
      onProviderStatusChange(status);
      setMessage(`${formatProviderName(selectedProvider)} 模型服务已解锁`);
    } catch {
      setMessage('解锁失败，请检查本机保护密码');
    } finally {
      setSaving(false);
    }
  };

  const checkProviderConnection = async () => {
    if (!provider?.checkConnection || connectionState === 'checking') return;
    const providerId = selectedProvider;
    const providerName = formatProviderName(providerId);
    setConnectionState('checking');
    setMessage(null);
    try {
      const result = await withProviderOperationTimeout(provider.checkConnection({ provider: providerId }), PROVIDER_CONNECTION_CHECK_TIMEOUT_MS);
      setConnectionState(result.status);
      if (result.status === 'connected') {
        const refreshResult = await refreshAvailableModels(providerId);
        setMessage(refreshResult.ok
          ? refreshResult.reverseCount > 0
            ? `连接成功，已同步 ${refreshResult.count} 个模型，其中 ${refreshResult.reverseCount} 个支持反推（未执行付费生成测试）`
            : `连接成功，已同步 ${refreshResult.count} 个模型，但没有模型声明反推能力`
          : `${providerName} 连接成功，但模型目录同步失败，请重试`);
        return;
      }
      if (result.status === 'authentication_failed') {
        setMessage(`${providerName} 密钥无效，请重新配置隐藏密钥`);
        return;
      }
      if (result.status === 'service_limited') {
        setMessage(`${providerName} 服务暂时受限，请稍后重试`);
        return;
      }
      if (result.status === 'unconfigured') {
        setMessage(`${providerName} 尚未配置密钥`);
        return;
      }
      setMessage(`${providerName} 暂时无法连接，请检查网络和接口地址`);
    } catch (error) {
      setConnectionState(error instanceof ProviderOperationTimeoutError ? 'connection_timeout' : 'network_unavailable');
      setMessage(error instanceof ProviderOperationTimeoutError
        ? `${providerName} 连接检测超时，请稍后重试`
        : `${providerName} 暂时无法连接，请检查网络和接口地址`);
    }
  };

  const checkForUpdates = async () => {
    if (!bridge?.updates || updateState.status === 'checking' || updateState.status === 'downloading') return;
    setUpdateState({ status: 'checking' });
    try {
      setUpdateState((await bridge.updates.check()).state);
    } catch {
      setUpdateState({ status: 'error', message: 'Update check failed.' });
    }
  };

  const downloadUpdate = async () => {
    if (!bridge?.updates || updateState.status !== 'available') return;
    try {
      setUpdateState((await bridge.updates.download()).state);
    } catch {
      setUpdateState({ status: 'error', message: 'Update download failed.' });
    }
  };

  const retryUpdate = async () => {
    if (!bridge?.updates) return;
    try {
      setUpdateState((await bridge.updates.retry()).state);
    } catch {
      setUpdateState({ status: 'error', message: 'Update check failed.' });
    }
  };

  const restartForUpdate = async () => {
    if (!bridge?.updates || updateState.status !== 'ready_to_restart') return;
    try {
      const result = await bridge.updates.restart();
      if (!result.accepted) setUpdateState({ status: 'error', message: 'Update is not ready to install.' });
    } catch {
      setUpdateState({ status: 'error', message: 'Update restart failed.' });
    }
  };

const updateMcpClientStatus = (status: McpClientStatus) => {
    setMcpClientStatuses((current) => [
      ...current.filter((item) => item.client !== status.client),
      status,
    ]);
  };

  const runMcpClientAction = async (client: McpClientId, action: 'connect' | 'test' | 'disconnect') => {
    if (!bridge?.mcpIntegration || mcpBusyClient !== null) return;
    setMcpBusyClient(client);
    setMcpError(null);
    try {
      const status = await bridge.mcpIntegration[action](client);
      updateMcpClientStatus(status);
      setMessage(`${formatMcpClientName(client)} · ${formatMcpClientState(status.state)}`);
    } catch {
      setMcpError(`${formatMcpClientName(client)}_MCP_${action.toUpperCase()}_FAILED`);
    } finally {
      setMcpBusyClient(null);
      setPendingMcpConnect(null);
    }
  };

  const copyMcpConfig = async (client: McpClientId) => {
    if (!bridge?.mcpIntegration || mcpBusyClient !== null) return;
    setMcpBusyClient(client);
    setMcpError(null);
    try {
      const result = await bridge.mcpIntegration.copyConfig(client);
      await navigator.clipboard?.writeText(result.config);
      setMessage(`${formatMcpClientName(client)} MCP 配置已复制`);
    } catch {
      setMcpError(`${formatMcpClientName(client)}_MCP_COPY_FAILED`);
    } finally {
      setMcpBusyClient(null);
    }
  };
  const toggleMcpPermission = (key: McpPermissionKey) => {
    setMcpPermissions((current) => ({ ...current, [key]: !current[key] }));
  };

  const knowledgeSyncItems = REQUIRED_KNOWLEDGE_BASES.map((required) => ({
    ...required,
    state: availableKnowledgeBases.find((base) => base.knowledgeBaseId === required.knowledgeBaseId),
    sync: knowledgeSyncStatuses.find((status) => status.knowledgeBaseId === required.knowledgeBaseId),
  }));

  const syncKnowledgeBase = async (knowledgeBaseId: string, displayName: string) => {
    if (syncingKnowledgeBaseId !== null || syncingAllKnowledge) return;
    setSyncingKnowledgeBaseId(knowledgeBaseId);
    setMessage(null);
    try {
      await onConfigureKnowledgeBase?.(knowledgeBaseId, displayName);
      await onRefreshKnowledge?.();
      setMessage(`${displayName} 已完成本机同步检查`);
    } catch {
      setMessage(`${displayName} 同步失败，请检查桌面连接与网络状态`);
    } finally {
      setSyncingKnowledgeBaseId(null);
    }
  };

  const syncAllKnowledge = async () => {
    if (syncingAllKnowledge || syncingKnowledgeBaseId !== null) return;
    setSyncingAllKnowledge(true);
    setMessage(null);
    try {
      for (const item of REQUIRED_KNOWLEDGE_BASES) {
        await onConfigureKnowledgeBase?.(item.knowledgeBaseId, item.displayName);
      }
      await onRefreshKnowledge?.();
      setMessage('两个知识库已完成本机同步检查');
    } catch {
      setMessage('知识库同步失败，请检查桌面连接与网络状态');
    } finally {
      setSyncingAllKnowledge(false);
    }
  };
  const runCacheAction = async (action: Exclude<CacheAction, null>) => {
    if (!bridge?.storage || cacheAction !== null) return;
    setCacheAction(action);
    setCacheError(null);
    setMessage(null);
    try {
      if (action === 'open') {
        const result = await bridge.storage.openCacheDirectory();
        if (!result.opened) setCacheError('无法打开缓存目录，请检查目录是否可用。');
        else setMessage('已打开缓存目录');
        return;
      }
      const nextState = action === 'choose'
        ? await bridge.storage.chooseCacheDirectory()
        : await bridge.storage.resetCacheDirectory();
      if (nextState !== null) {
        setCacheDirectory(nextState);
        setCacheError(nextState.error);
        if (!nextState.error) {
          setMessage(action === 'choose' ? '已切换自定义缓存目录' : '已恢复默认缓存目录');
        }
      }
    } catch {
      setCacheError(action === 'choose'
        ? '无法自定义缓存目录，原目录保持不变。'
        : action === 'reset'
          ? '无法恢复默认缓存目录，原目录保持不变。'
          : '无法打开缓存目录，请检查目录是否可用。');
    } finally {
      setCacheAction(null);
    }
  };

  const cleanUnusedMedia = async () => {
    if (!bridge?.history?.purgeExpired || cleaningStorage) return;
    if (typeof window !== 'undefined' && !window.confirm('将清理回收站中已过期且未被项目引用的媒体缓存，是否继续？')) return;
    setCleaningStorage(true);
    setMessage(null);
    try {
      const result = await bridge.history.purgeExpired({ operationId: `settings-cleanup-${Date.now()}` });
      setCapacity(await bridge.history.getCapacity());
      setMessage(`已清理 ${result.purgedIds.length} 个未使用媒体项`);
    } catch {
      setMessage('清理失败，媒体仍保留在本地存储中');
    } finally {
      setCleaningStorage(false);
    }
  };

  const cacheControlsDisabled = !bridge?.storage || cacheAction !== null || cacheDirectory?.busy === true;
  return <>
    <aside className="settings-drawer" aria-label="设置 / Settings" data-figma-surface="settings" data-testid="settings-drawer">
      <header className="settings-drawer__header">
        <div data-testid="settings-drawer-heading">
          <strong>设置</strong>
          <span>Settings</span>
        </div>
        <button className="icon-button" type="button" data-testid="settings-drawer-close" aria-label="关闭设置" title="关闭设置" onClick={closeSettings}>
          <X size={16} />
        </button>
      </header>
      <div className="settings-tabs" role="tablist" aria-label="设置分类" data-figma-tabs="segmented">
        {([
          ['api', 'API 与模型'],
          ['storage', '存储与备份'],
          ['mcp', 'MCP 联动'],
          ['sync', '同步'],
        ] as const).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={activeTab === id}
            className={activeTab === id ? 'is-active' : undefined}
            onClick={() => setActiveTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="settings-drawer__body">
        {activeTab === 'api' && <>
        <section className="settings-section settings-provider-overview settings-layer" aria-labelledby="provider-settings-title" data-testid="settings-api-status-layer">
          <header>
            <span><KeyRound size={16} /></span>
            <div><strong id="provider-settings-title">API 与模型</strong><small>Comfly + RelayMe provider routing</small></div>
            <b data-provider-state={selectedProviderStatus?.configured ? 'configured' : 'missing'}>{selectedProviderStatus?.configured ? `${formatProviderName(selectedProvider)} 已启用` : `${formatProviderName(selectedProvider)} 未配置`}</b>
          </header>
          <p>Comfly 使用 API 密钥；RelayMe 使用账号登录令牌。连接检测、模型目录与实际生成能力会分别验证。</p>
        </section>

        <section className="settings-section settings-provider-panel settings-layer" aria-label="供应商设置" data-testid="settings-provider-layer">
          <header className="settings-subsection-heading">
            <div><strong>供应商设置</strong><small>选择供应商后，只编辑当前供应商的连接、密钥和模型。</small></div>
          </header>
          <div className="settings-provider-grid" role="list" aria-label="模型供应商">
            {(['comfly', 'relayme'] as const).map((providerId) => {
              const active = effectiveActiveProvider === providerId;
              const count = active ? providerProfiles.length : null;
              const status = providerStatuses[providerId];
              const summary = active && providerId === 'relayme' && status?.configured && !loadingModels && count === 0
                ? '凭据待重新验证'
                : count === null ? (status?.configured ? '已配置' : '未配置') : `${count} 个模型`;
              return <button
                key={providerId}
                type="button"
                role="listitem"
                aria-label={`${formatProviderName(providerId)} · ${summary}`}
                aria-pressed={active}
                className={active ? 'is-active' : undefined}
                disabled={loadingActiveProvider && activeProvider !== null}
                onClick={() => { void selectActiveProvider(providerId); }}
              >
                <i>{providerId === 'comfly' ? 'CO' : 'RM'}</i>
                <span><strong>{formatProviderName(providerId)}</strong><small>{summary}</small></span>
              </button>;
            })}
          </div>
          <div className="settings-key-heading">
            <div><strong>{formatProviderName(selectedProvider)} {selectedProvider === 'relayme' ? '账号连接' : '密钥管理'}</strong><small>{selectedProvider === 'relayme' ? '登录令牌仅进入桌面安全凭据库，不接受独立 API 密钥。' : '密钥仅进入桌面安全凭据库，不写入渲染端或项目文件。'}</small></div>
            <div>
              <span data-connection-state={connectionState}>{connectionLabel(connectionState)}</span>
              <button className="settings-section__secondary settings-connection-check settings-tool-action" type="button" disabled={!provider?.checkConnection || connectionState === 'checking'} onClick={() => { void checkProviderConnection(); }}>
                <RefreshCw size={14} className={connectionState === 'checking' ? 'is-spinning' : undefined} />{connectionState === 'checking' ? '检测中…' : '检测连接'}
              </button>
            </div>
          </div>
          <label className="settings-provider-endpoint">
            <span>API 服务地址（Base URL）</span>
            <input type="url" autoComplete="url" aria-label="API 服务地址（Base URL）" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} />
            <small>用于读取模型目录并发送对话、生图和视频请求；通常无需修改。</small>
            <button type="button" className="settings-endpoint-reset" onClick={() => setBaseUrl(providerBaseUrlPlaceholder(selectedProvider))}>恢复默认地址</button>
          </label>
          <div className="settings-credential-summary" aria-label={`${formatProviderName(selectedProvider)} 凭据摘要`}>
            <div><span>凭据状态</span><strong>{relayMeNeedsVerification ? '凭据待重新验证' : selectedProviderStatus?.configured ? '已配置' : '未配置'}</strong></div>
            <div><span>安全存储</span><strong>系统凭据库</strong></div>
          </div>
          <div className="settings-key-actions">
            <div>
              <strong>{selectedProvider === 'relayme' ? '账号登录，统一调用 RelayMe 模型' : '一把密钥，统一调用全部模型'}</strong>
              <small>{selectedProvider === 'relayme' ? '画布只使用 RelayMe 账号登录令牌，不接受独立 API 密钥。' : 'Agent 对话、语言反推、生图和视频共用当前供应商密钥。'}</small>
              <small className="settings-chat-adaptation">对话模型适配：画布会按“对话模型”默认项路由到当前供应商。</small>
              {selectedProvider === 'relayme' && <small className="settings-capability-note">连接检测只验证账号与模型目录；请在模型目录确认“生图”能力后再生成。</small>}
            </div>
            <div>
              {selectedProvider === 'relayme' && <a className="settings-provider-key-link" href="https://www.ml.relayme.uk/" target="_blank" rel="noreferrer">打开 RelayMe 网站</a>}
              {selectedProvider === 'relayme' && (provider?.loginRelayMeWeb || provider?.loginRelayMe) && <button className="settings-section__primary" type="button" onClick={openRelayMeLogin} disabled={relayMeLoginBusy}>登录 RelayMe</button>}
              {selectedProvider === 'relayme' && provider?.logoutRelayMe && selectedProviderStatus?.configured && effectiveActiveProvider === 'relayme' && <button className="settings-section__secondary" type="button" onClick={() => { void logoutRelayMe(); }} disabled={relayMeLoginBusy}>退出 RelayMe</button>}
              {selectedProvider !== 'relayme' && <button className="settings-section__secondary" type="button" onClick={openHiddenKeys}>配置隐藏密钥</button>}
            </div>
          </div>
          <button className="settings-section__primary" type="button" disabled={!provider || !selectedProviderStatus?.configured || saving || baseUrl.trim().length === 0} onClick={() => { void saveEndpoint(); }}>{saving ? '正在保存…' : '保存接口设置'}</button>
          {message && <p role="status">{message}</p>}
        </section>

        <div className="settings-layer settings-model-layer" data-testid="settings-model-layer">
          <ProviderModelCatalog
            profiles={providerProfiles}
            enabledProfileKeys={enabledProfileKeys}
            defaultProfileKeys={defaultProfileKeys}
            onConfigure={selectedProvider === 'relayme' ? openRelayMeLogin : openHiddenKeys}
            configureLabel={selectedProvider === 'relayme' ? '重新登录 RelayMe' : '配置模型密钥'}
            onRetry={() => { void refreshAvailableModels(catalogProvider ?? selectedProvider); }}
            onToggleProfile={(profile) => {
              const key = createProviderProfileKey(profile);
              setEnabledProfileKeys((current) => current.includes(key) ? current.filter((item) => item !== key) : [...current, key]);
            }}
            onDefaultProfileChange={(capability, profileKey) => setDefaultProfileKeys((current) => ({ ...current, [capability]: profileKey }))}
          />
        </div>
        <button className="settings-section__primary settings-model-save" type="button" disabled={!provider?.updateProfiles || savingDefaults || providerProfiles.length === 0} onClick={() => { void saveDefaultModels(); }}>{savingDefaults ? '保存中…' : `保存 ${formatProviderName(catalogProvider ?? selectedProvider)} 模型选择`}</button>
        <section className="settings-section settings-layer settings-diagnostics-layer" aria-label="诊断与更新" data-testid="settings-diagnostics-layer">
          <header><span><RefreshCw size={16} /></span><div><strong>诊断与更新</strong><small>快速确认连接、模型目录和桌面版本状态</small></div></header>
          <div className="settings-diagnostics-summary"><span data-connection-state={connectionState}>{connectionLabel(connectionState)}</span><span>{providerProfiles.length ? `${providerProfiles.length} 个模型已加载` : '模型目录待同步'}</span></div>
          <button className="settings-section__secondary" type="button" onClick={() => setActiveTab('sync')}>打开同步与应用更新</button>
        </section>
        </>}        {activeTab === 'storage' && <>
        <section className="settings-section settings-download-directory settings-layer" aria-label="下载输出目录" data-testid="settings-storage-directory-layer">
          <header><div><strong>下载输出目录</strong><small>固定目录开启后直接写入该目录；关闭后每次下载都会询问保存位置。</small></div><label className="settings-inline-switch"><input type="checkbox" aria-label="固定下载输出目录" /><i /></label></header>
          <input aria-label="当前下载输出目录" value="系统下载目录" readOnly />
          <div className="settings-directory-actions">
            <button className="settings-section__secondary" type="button" disabled>打开下载目录</button>
            <button className="settings-section__secondary" type="button" disabled>自定义下载目录</button>
            <button className="settings-section__secondary" type="button">使用系统下载目录</button>
          </div>
        </section>

        <section className="settings-section settings-local-storage settings-layer" aria-label="本地保存" data-testid="settings-storage-local-layer">
          <header><span><Database size={16} /></span><div><strong>本地保存</strong><small>查看本机占用空间、下载位置和可再生成缓存。</small></div><button className="settings-section__secondary settings-storage-refresh" type="button" disabled={!bridge?.history} onClick={() => { void bridge?.history?.getCapacity().then(setCapacity); }}><span className="settings-action-content"><RefreshCw size={14} />刷新</span></button></header>
          <label className="settings-cache-directory-field">
            <span>缓存存储路径</span>
            <input aria-label="当前缓存路径" value={cacheDirectory?.path ?? (bridge?.storage ? '正在读取…' : '仅桌面版可选择缓存路径')} readOnly />
            <small className="settings-cache-directory-hint">桌面版可自由选择缓存文件夹；取消选择或迁移失败时会保留原路径。</small>
          </label>
          <div className="settings-directory-actions settings-cache-directory-actions">
            <button className="settings-section__secondary settings-cache-action" type="button" disabled={cacheControlsDisabled} onClick={() => { void runCacheAction('open'); }}>{cacheAction === 'open' ? '打开中…' : '打开缓存目录'}</button>
            <button className="settings-section__secondary settings-cache-action" type="button" disabled={cacheControlsDisabled} onClick={() => { void runCacheAction('choose'); }}>{cacheAction === 'choose' ? '迁移中…' : '选择自定义缓存路径'}</button>
            <button className="settings-section__secondary settings-cache-action" type="button" disabled={cacheControlsDisabled || cacheDirectory?.isDefault === true} onClick={() => { void runCacheAction('reset'); }}>{cacheAction === 'reset' ? '恢复中…' : '恢复默认目录'}</button>
          </div>
          {cacheError && <p className="settings-cache-directory-error" role="alert">{cacheError}</p>}
          <div className="settings-storage-stat-grid">
            <article><span>画布原图</span><strong>{capacity ? formatBytes(capacity.activeBytes) : '—'}</strong><small>{capacity ? `${capacity.activeCount} 个文件` : '桌面服务连接后显示'}</small></article>
            <article><span>作品输出</span><strong>{capacity ? formatBytes(capacity.activeBytes) : '—'}</strong><small>{capacity ? `${capacity.activeCount} 个文件` : '桌面服务连接后显示'}</small></article>
            <article><span>运行缓存</span><strong>{capacity ? formatBytes(capacity.trashBytes) : '—'}</strong><small>可清理，不影响作品</small></article>
          </div>
        </section>

        <section className="settings-section settings-clearable-cache settings-layer" aria-label="可清理缓存" data-testid="settings-storage-card" data-figma-layout="storage">
          <header><div><strong>可清理缓存</strong><small>只清理可再生成缓存，不删除作品或画布原图。</small></div><button className="settings-danger-button settings-cache-primary-action" type="button" disabled={!capacity || cleaningStorage} onClick={() => { void cleanUnusedMedia(); }}>{cleaningStorage ? '清理中…' : '清理全部缓存'}</button></header>
          <div className="settings-cache-grid">
            {[
              ['输入缓存', '0 B', '0 个文件'],
              ['缩略图缓存', capacity ? formatBytes(capacity.trashBytes) : '—', capacity ? `${capacity.trashCount} 个文件` : '桌面服务连接后显示'],
              ['浏览器缓存', '0 B', '页面运行产生，可再生成'],
              ['会话缓存', capacity ? formatBytes(capacity.activeBytes) : '—', '当前运行产生，可再生成'],
            ].map(([label, size, summary]) => <article key={label}><span>{label}</span><strong>{size}</strong><small>{summary}</small><button className="settings-cache-item-action" type="button" disabled={!capacity || cleaningStorage} onClick={() => { void cleanUnusedMedia(); }}>{cleaningStorage ? '清理中…' : '清理'}</button></article>)}
          </div>
          {message && <p role="status">{message}</p>}
        </section>
        </>}
{activeTab === 'mcp' && (
          <section className="settings-section settings-section--mcp settings-layer" aria-labelledby="mcp-settings-title" data-testid="settings-mcp-card">
            <header>
              <span><Cable size={16} /></span>
              <div>
                <strong id="mcp-settings-title">MCP 联动</strong>
                <small>Codex / WorkBuddy</small>
              </div>
              <b data-provider-state={mcpRuntimeStatus?.state === 'running' ? 'configured' : 'missing'}>
                {formatMcpRuntimeState(mcpRuntimeStatus?.state)}
              </b>
            </header>
            <p>让 Codex 与 WorkBuddy 读取节点能力、规划工作流，并在 CanvasForge 内完成确认后写入画布。</p>

            <article className="settings-mcp-server" role="region" aria-label="CanvasForge MCP server">
              <div className="settings-mcp-server__identity">
                <i data-mcp-runtime-state={mcpRuntimeStatus?.state ?? 'desktop-only'}><Cable size={15} /></i>
                <span><strong>CanvasForge MCP</strong><small>canvasforge · stdio</small></span>
              </div>
              {bridge?.mcpRuntime ? (
                <dl>
                  <div><dt>服务</dt><dd>{formatMcpRuntimeState(mcpRuntimeStatus?.state)}</dd></div>
                  <div><dt>版本</dt><dd>{mcpRuntimeStatus?.serverVersion ?? '—'}</dd></div>
                  <div><dt>工具</dt><dd>{mcpRuntimeStatus?.toolCount ?? 14}</dd></div>
                  <div><dt>画布</dt><dd>{mcpRuntimeStatus?.rendererConnected ? '已连接' : '等待画布'}</dd></div>
                </dl>
              ) : <p className="settings-mcp-desktop-only" data-testid="mcp-desktop-only">仅桌面版可配置 MCP 客户端</p>}
            </article>

            <div className="settings-mcp-client-list" aria-label="MCP 客户端列表">
              {(['codex', 'workbuddy'] as const).map((client) => {
                const clientName = formatMcpClientName(client);
                const status = mcpClientStatuses.find((item) => item.client === client);
                const busy = mcpBusyClient === client;
                const desktopAvailable = Boolean(bridge?.mcpIntegration);
                return <article key={client} className="settings-mcp-client" role="group" aria-label={`${clientName} MCP client`}>
                  <div className="settings-mcp-client__identity">
                    <i>{client === 'codex' ? 'CX' : 'WB'}</i>
                    <span><strong>{clientName}</strong><small>{client === 'codex' ? 'OpenAI Codex' : 'WorkBuddy desktop'}</small></span>
                  </div>
                  <span className="settings-mcp-client__state" data-mcp-client-state={status?.state ?? 'unconfigured'}>
                    {formatMcpClientState(status?.state)}
                  </span>
                  <div className="settings-mcp-client__actions">
                    <button type="button" aria-label={`Connect ${clientName}`} disabled={!desktopAvailable || busy} onClick={() => setPendingMcpConnect(client)}><Link2 size={13} />连接</button>
                    <button type="button" aria-label={`Copy ${clientName} config`} disabled={!desktopAvailable || busy} onClick={() => { void copyMcpConfig(client); }}><Copy size={13} />复制配置</button>
                    <button type="button" aria-label={`Test ${clientName} connection`} disabled={!desktopAvailable || busy} onClick={() => { void runMcpClientAction(client, 'test'); }}><RefreshCw size={13} className={busy ? 'is-spinning' : undefined} />测试</button>
                    <button type="button" aria-label={`Disconnect ${clientName}`} disabled={!desktopAvailable || busy || !status || status.state === 'unconfigured'} onClick={() => { void runMcpClientAction(client, 'disconnect'); }}><X size={13} />断开</button>
                  </div>
                </article>;
              })}
            </div>

            {pendingMcpConnect && <div className="settings-mcp-connect-confirmation" role="dialog" aria-modal="true" aria-label={`Confirm ${formatMcpClientName(pendingMcpConnect)} connection`}>
              <div><strong>连接 {formatMcpClientName(pendingMcpConnect)}</strong><p>只写入 CanvasForge 这一项；现有 MCP 配置会保留，并在修改前创建时间戳备份。</p></div>
              <dl>
                <div><dt>服务名</dt><dd>canvasforge</dd></div>
                <div><dt>传输</dt><dd>stdio</dd></div>
                <div><dt>工具</dt><dd>14</dd></div>
                <div><dt>授权</dt><dd>工作流写入与付费任务分别确认</dd></div>
              </dl>
              <div>
                <button type="button" className="settings-section__secondary" onClick={() => setPendingMcpConnect(null)}>取消</button>
                <button type="button" className="settings-section__primary" aria-label={`Confirm ${formatMcpClientName(pendingMcpConnect)} config write`} onClick={() => { void runMcpClientAction(pendingMcpConnect, 'connect'); }}>确认写入</button>
              </div>
            </div>}

            {mcpError && <p className="settings-mcp-error" role="alert">{formatMcpError(mcpError)}</p>}
            <section className="settings-mcp-permissions" aria-labelledby="mcp-permissions-title">
              <header>
                <ShieldCheck size={15} />
                <div>
                  <strong id="mcp-permissions-title">MCP 权限中心</strong>
                  <small>读取与规划默认开启；实际修改工作流和付费生成仍需在画布中分别确认。</small>
                </div>
              </header>
              <div className="settings-mcp-permission-grid">
                {MCP_PERMISSION_ITEMS.map((item) => (
                  <label key={item.key} className={item.tone === 'danger' ? 'settings-mcp-permission settings-mcp-permission--danger' : 'settings-mcp-permission'}>
                    <span><strong>{item.label}</strong><small>{item.description}</small></span>
                    <input type="checkbox" aria-label={item.label} checked={mcpPermissions[item.key]} onChange={() => toggleMcpPermission(item.key)} />
                    <i aria-hidden="true"><Check size={13} /></i>
                  </label>
                ))}
              </div>
            </section>
            <dl className="settings-mcp-contract-summary" aria-label="Codex 节点能力摘要">
              <div><dt>协议</dt><dd>{codexWorkflowContract.protocol}</dd></div>
              <div><dt>节点能力</dt><dd>{codexWorkflowContract.modules.length} 个模块</dd></div>
              <div><dt>执行规则</dt><dd>生成工作流先预览确认</dd></div>
            </dl>
            {message && <p role="status">{message}</p>}
          </section>
        )}
        {activeTab === 'sync' && <>
        <section className="settings-section settings-sync-panel settings-layer" aria-labelledby="knowledge-sync-title" data-testid="settings-sync-card">
          <header><span><RefreshCw size={16} /></span><div><strong id="knowledge-sync-title">同步与成长记忆</strong><small>Knowledge sync across devices</small></div><b data-provider-state="configured">已开启</b></header>
          <p>离线时先存本机；恢复网络后同步知识库版本与成长记忆。</p>
          <article className="settings-sync-primary">
            <header><i /><strong>Canvas 同步（推荐）</strong><span>已开启</span></header>
            <p>使用同步 ID 和恢复密钥跨设备保存知识库状态，不上传模型密钥。</p>
            <small>最近状态 · {knowledgeSyncItems.some((item) => item.sync?.status === 'syncing') ? '同步中' : '本机已检查'}</small>
            <button type="button" disabled={!onRefreshKnowledge || syncingAllKnowledge} onClick={() => { void syncAllKnowledge(); }}>{syncingAllKnowledge ? '同步中…' : '立即同步全部'}</button>
          </article>
          <div className="settings-sync-knowledge-list" role="group" aria-label="知识库同步列表">
            {knowledgeSyncItems.map((item) => <article key={item.knowledgeBaseId}>
              <div><i data-sync-state={item.sync?.status ?? 'offline'} /><span><strong>{item.displayName}</strong><small>{item.description}</small></span></div>
              <div><span>{formatKnowledgeSyncState(item.state?.status, item.sync?.status)}</span><small>{item.state?.activeVersion ? `v${item.state.activeVersion}` : '待建立版本'}</small></div>
              <button type="button" disabled={!onConfigureKnowledgeBase || syncingAllKnowledge || syncingKnowledgeBaseId !== null} onClick={() => { void syncKnowledgeBase(item.knowledgeBaseId, item.displayName); }}>{syncingKnowledgeBaseId === item.knowledgeBaseId ? '同步中…' : '同步'}</button>
            </article>)}
          </div>
          <span className="settings-sync-subtitle">其他同步方式</span>
          <div className="settings-sync-methods">
            <button type="button"><i className="is-local" /><span><strong>仅本机保存</strong><small>无需网络，数据只保留在此设备</small></span><b>›</b></button>
            <button type="button" disabled><i /><span><strong>百度网盘同步</strong><small>使用已登录的百度网盘客户端同步</small></span><b>›</b></button>
            <button type="button" disabled><i /><span><strong>WebDAV</strong><small>连接 NAS、坚果云或自建存储</small></span><b>›</b></button>
          </div>
          <p className="settings-sync-warning">恢复密钥仅由你保管；遗失后无法恢复云端数据。</p>
          {message && <p role="status">{message}</p>}
        </section>

        <details className="settings-advanced-diagnostics settings-layer" data-testid="settings-sync-diagnostics-layer">
          <summary>高级故障排查</summary>
          <section className="settings-diagnostics-grid" aria-label="高级诊断">
            <article className="settings-status-card settings-tool-card" role="region" aria-label="连接与恢复" data-tool-tone="security">
              <header><span><ShieldCheck size={16} /></span><div><strong>连接与恢复</strong><small>仅在桌面安全存储或模型连接异常时使用</small></div></header>
              <p>{formatEncryption(selectedProviderStatus)}</p>
              <label><span>本机保护密码</span><input type="password" autoComplete="new-password" aria-label="本机保护密码" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} /></label>
              <div className="settings-connection-row"><button className="settings-section__secondary settings-connection-check settings-tool-action" type="button" disabled={!provider?.checkConnection || connectionState === 'checking'} onClick={() => { void checkProviderConnection(); }}><span className="settings-action-content"><RefreshCw size={14} className={connectionState === 'checking' ? 'is-spinning' : undefined} />{connectionState === 'checking' ? '检查中…' : '检查连接'}</span></button><span data-connection-state={connectionState}>{connectionLabel(connectionState)}</span></div>
              {selectedProviderStatus?.configured && selectedProviderStatus.locked && <button className="settings-section__secondary" type="button" disabled={!provider || passphrase.length === 0 || saving} onClick={() => { void unlockProvider(); }}>{saving ? '正在解锁…' : '解锁模型服务'}</button>}
            </article>
            <article className="settings-status-card settings-tool-card" role="region" aria-label="应用更新" data-tool-tone="update">
              <header><span><RefreshCw size={16} /></span><div><strong>应用更新</strong><small>桌面更新状态</small></div></header>
              <p>检查版本、安全修复和模型适配更新，不会影响当前画布内容。</p>
              <div className="settings-tool-card__status"><span>当前版本</span><strong>{updateState.currentVersion ? `v${updateState.currentVersion}` : '读取中'}</strong></div>
              <div className="settings-tool-card__status"><span>更新状态</span><strong>{updateState.status === 'idle' ? '等待检查' : updateState.status === 'checking' ? '正在检查' : updateState.status === 'downloading' ? '正在下载' : updateState.status === 'ready_to_restart' ? '准备安装' : updateState.status === 'error' ? '检查失败' : '发现新版本'}</strong></div>
              <button className="settings-section__secondary settings-update-action settings-tool-action" type="button" aria-label="Check for updates" disabled={!bridge?.updates || updateState.status === 'checking' || updateState.status === 'downloading'} onClick={() => { void checkForUpdates(); }}><span className="settings-action-content"><RefreshCw size={14} className={updateState.status === 'checking' ? 'is-spinning' : undefined} />{updateState.status === 'checking' ? '检查中…' : '检查更新'}</span></button>
              {updateState.status === 'idle' && updateState.message === 'No updates are available.' && <p role="status">当前已是最新版本</p>}
            </article>
          </section>
        </details>
        </>}
      </div>
      </aside>
      {updateDialogOpen && <div className="settings-hidden-key-backdrop" role="presentation" onMouseDown={() => setUpdateDialogOpen(false)}>
        <section
          className="settings-hidden-key-dialog"
          role="dialog"
          aria-modal="true"
          aria-label="应用更新"
          onMouseDown={(event) => event.stopPropagation()}
        >
          <header className="settings-update-dialog__hero">
            <span className="settings-update-dialog__icon" aria-hidden="true"><RefreshCw size={20} /></span>
            <div>
              <small>桌面版本更新</small>
              <strong>应用更新</strong>
              {updateState.status === 'checking' && <p>正在检查更新…</p>}
              {updateState.status === 'available' && <p>发现新版本 {updateState.version ?? ''}</p>}
              {updateState.status === 'downloading' && <p>正在下载 {updateState.version ?? '新版本'}</p>}
              {updateState.status === 'ready_to_restart' && <p>版本 {updateState.version ?? ''} 已准备好</p>}
              {updateState.status === 'error' && <p>更新暂时不可用</p>}
            </div>
            {updateState.version && <b className="settings-update-dialog__version">v{updateState.version}</b>}
            <button type="button" className="icon-button" aria-label="关闭更新弹窗" onClick={() => setUpdateDialogOpen(false)}><X size={16} /></button>
          </header>
          <section className="settings-update-dialog__notes" role="region" aria-label="更新说明">
            <header><strong>更新内容</strong><span>本次更新</span></header>
            <p>{updateState.notes || '暂无详细更新说明。'}</p>
          </section>
          {updateState.status === 'downloading' && <div className="settings-update-progress">
            <progress aria-label="更新下载进度" max={1} value={updateState.progress ?? 0} />
            <span>下载进度 {Math.round((updateState.progress ?? 0) * 100)}%</span>
          </div>}
          {updateState.status === 'error' && <p role="alert">更新检查失败，请检查网络后重试。</p>}
          <div className="settings-update-dialog__actions">
            {updateState.status === 'available' && <button type="button" className="settings-section__primary" aria-label="下载更新" onClick={() => { void downloadUpdate(); }}>下载更新</button>}
            {updateState.status === 'ready_to_restart' && <button type="button" className="settings-section__primary" aria-label="重启并安装" onClick={() => { void restartForUpdate(); }}>重启并安装</button>}
            {updateState.status === 'error' && <button type="button" className="settings-section__primary" aria-label="重新检查更新" onClick={() => { void retryUpdate(); }}>重新检查</button>}
            <button type="button" className="settings-section__secondary" onClick={() => setUpdateDialogOpen(false)}>
              {updateState.status === 'ready_to_restart' ? '稍后安装' : '稍后'}
            </button>
          </div>
        </section>
      </div>}
      {relayMeLoginOpen && <div className="settings-hidden-key-backdrop" role="presentation" onMouseDown={() => { if (!relayMeLoginBusy) closeRelayMeLogin(); }}>
      <form
        className="settings-hidden-key-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="登录 RelayMe"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => { event.preventDefault(); void submitRelayMeLogin(); }}
      >
        <header>
          <div><strong>登录 RelayMe</strong><p>推荐使用官网网页登录，登录成功后自动读取你的模型目录。</p></div>
          <button type="button" className="icon-button" aria-label="关闭 RelayMe 登录" onClick={closeRelayMeLogin} disabled={relayMeLoginBusy}><X size={16} /></button>
        </header>
        <div className="settings-hidden-key-dialog__fields">
          {provider?.loginRelayMeWeb && <button className="settings-section__primary" type="button" onClick={() => { void submitRelayMeWebLogin(); }} disabled={relayMeLoginBusy}>{relayMeLoginBusy ? '等待网页登录…' : '使用 RelayMe 网页登录'}</button>}
          {provider?.loginRelayMe && <p>或使用账号密码登录</p>}
          {provider?.loginRelayMe && <label><span>RelayMe 账号</span><input type="text" autoComplete="username" aria-label="RelayMe 账号" value={relayMeUsername} disabled={relayMeLoginBusy} onChange={(event) => { setRelayMeUsername(event.target.value); setRelayMeLoginError(null); }} /></label>}
          {provider?.loginRelayMe && <label><span>RelayMe 密码</span><input type="password" autoComplete="current-password" aria-label="RelayMe 密码" value={relayMePassword} disabled={relayMeLoginBusy} onChange={(event) => { setRelayMePassword(event.target.value); setRelayMeLoginError(null); }} /></label>}
          {relayMeLoginError && <p className="settings-hidden-key-dialog__error" role="alert">{relayMeLoginError}</p>}
          <div className="settings-provider-auth-links">
            <a href="https://www.ml.relayme.uk/" target="_blank" rel="noreferrer">注册 RelayMe 账号</a>
            <a href="https://www.ml.relayme.uk/" target="_blank" rel="noreferrer">找回密码</a>
          </div>
        </div>
        <div className="settings-dialog-actions">
          <button className="settings-section__secondary" type="button" onClick={closeRelayMeLogin} disabled={relayMeLoginBusy}>取消</button>
          {provider?.loginRelayMe && <button className="settings-section__secondary" type="submit" disabled={relayMeLoginBusy || relayMeUsername.trim().length === 0 || relayMePassword.length === 0}>{relayMeLoginBusy ? '账号密码登录中…' : '使用账号密码登录'}</button>}
        </div>
      </form>
    </div>}
    {hiddenKeysOpen && <div className="settings-hidden-key-backdrop" role="presentation" onMouseDown={() => { if (!saving) closeHiddenKeys(); }}>
      <form
        className="settings-hidden-key-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="配置隐藏密钥"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => { event.preventDefault(); void saveHiddenKeys(); }}
      >
        <header>
          <div><strong>配置隐藏密钥</strong><p>密钥仅在本机安全存储，平时不会显示在设置页。</p></div>
          <button type="button" className="icon-button" aria-label="关闭隐藏密钥配置" onClick={closeHiddenKeys} disabled={saving}><X size={16} /></button>
        </header>
        <div className="settings-hidden-key-dialog__fields">
          <label>
            <span>{formatProviderName(selectedProvider)} API 密钥</span>
            <div className="settings-secret-input">
              <input type={credentialRevealed ? 'text' : 'password'} autoComplete="new-password" aria-label={`${formatProviderName(selectedProvider)} API 密钥`} value={providerToken} onFocus={() => { if (providerToken === SAVED_CREDENTIAL_MASK) setProviderToken(''); }} onChange={(event) => setProviderToken(event.target.value)} />
              {selectedProviderStatus?.configured && <button
                type="button"
                className="icon-button settings-secret-input__toggle"
                aria-label={credentialRevealed ? '隐藏真实密钥' : '显示真实密钥'}
                title={credentialRevealed ? '隐藏真实密钥' : '显示真实密钥'}
                disabled={saving || revealingCredential}
                onClick={() => { void toggleCredentialReveal(); }}
              >
                {credentialRevealed ? <EyeOff size={17} /> : <Eye size={17} />}
              </button>}
            </div>
            <small>这一把密钥统一用于 Agent 对话、语言反推、生图和视频；不会写入画布项目文件。</small>
          </label>
          {selectedProviderStatus?.encryption === 'unavailable' && <label>
            <span>本机加密口令</span>
            <input type="password" autoComplete="new-password" aria-label="本机加密口令" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} />
            <small>当前系统凭据加密不可用。该口令只用于本机加密 API 密钥，不会发送到模型网站。</small>
          </label>}
          {hiddenKeyError && <p className="settings-hidden-key-dialog__error" role="alert">{hiddenKeyError}</p>}
        </div>
        <button
          className="settings-section__primary"
          type="submit"
          disabled={saving || providerToken.trim().length === 0 || providerToken === SAVED_CREDENTIAL_MASK || (selectedProviderStatus?.encryption === 'unavailable' && passphrase.length === 0)}
        >
          {saving ? '正在保存…' : '保存隐藏密钥'}
        </button>
      </form>
    </div>}
  </>;
}

function formatProviderName(provider: ProviderBridgeProvider): 'Comfly' | 'RelayMe' {
  return provider === 'relayme' ? 'RelayMe' : 'Comfly';
}

function providerBaseUrlPlaceholder(provider: ProviderBridgeProvider): string {
  return provider === 'relayme'
    ? 'https://www.ml.relayme.uk/api/ai-tools/v1'
    : 'https://ai.comfly.org';
}

function normalizeProviderToken(value: string): string {
  return value.trim().replace(/^Bearer\s+/iu, '').trim();
}

function isRunnableReverseProfile(profile: ProviderBridgeProfile): boolean {
  return profile.capabilities.includes('reverse_prompt') && (
    profile.capabilities.includes('gemini_native')
    || (profile.capabilities.includes('chat') && profile.capabilities.includes('vision'))
  );
}

function createDefaultProfileSelection(profiles: readonly ProviderBridgeProfile[]): Partial<Record<CatalogCapability, string>> {
  const result: Partial<Record<CatalogCapability, string>> = {};
  for (const capability of ['image_generation', 'video_generation', 'chat', 'reverse_prompt', 'vision', 'video_understanding'] as const) {
    const explicitDefaultRoute = `${capability === 'image_generation' ? 'image' : capability === 'video_generation' ? 'video' : capability === 'reverse_prompt' ? 'reverse' : 'chat'}-default`;
    const selected = profiles.find((profile) => profile.capabilities.includes(capability) && profile.modelRoute === explicitDefaultRoute)
      ?? selectFirstProfileForCapability(profiles, capability);
    if (selected) result[capability] = createProviderProfileKey(selected);
  }
  return result;
}
function formatKnowledgeSyncState(baseStatus: string | undefined, syncStatus: 'syncing' | 'updated' | 'offline' | 'conflict' | undefined): string {
  if (syncStatus === 'syncing') return '同步中';
  if (syncStatus === 'conflict') return '需要处理冲突';
  if (syncStatus === 'offline') return baseStatus === 'active' ? '离线 · 本机可用' : '等待连接';
  if (syncStatus === 'updated') return '已同步';
  return baseStatus === 'active' ? '本机已启用' : '待同步';
}
function formatEncryption(status: ProviderConfigurationStatus | null): string {
  if (!status) return '桌面安全存储不可用';
  if (status.encryption === 'safeStorage') return '由操作系统安全存储加密';
  if (status.encryption === 'passphrase') return status.locked ? '需要本机保护密码解锁' : '已使用本机保护密码加密';
  return '当前系统不支持凭据存储';
}

function connectionLabel(state: 'idle' | 'checking' | ConnectionStatus): string {
  return ({
    idle: '未检查',
    checking: '检查中',
    unconfigured: '未配置',
    connected: '连接成功',
    authentication_failed: '认证失败',
    network_unavailable: '网络不可用',
    service_limited: '服务受限',
    connection_timeout: '连接检测超时',
  })[state];
}

function formatMcpClientName(client: McpClientId): 'Codex' | 'WorkBuddy' {
  return client === 'codex' ? 'Codex' : 'WorkBuddy';
}

function formatMcpClientState(state: McpClientStatus['state'] | undefined): string {
  return ({
    unconfigured: '未配置',
    configured: '已配置',
    connected: '已连接',
    connection_failed: '连接失败',
  })[state ?? 'unconfigured'];
}

function formatMcpRuntimeState(state: McpRuntimePublicStatus['state'] | undefined): string {
  return ({
    stopped: '已停止',
    waiting_for_canvas: '等待画布',
    running: '运行中',
    error: '异常',
  })[state ?? 'stopped'];
}

function formatMcpError(error: string): string {
  if (error === 'MCP_STATUS_UNAVAILABLE') return '无法读取 MCP 状态，请确认正在使用桌面版。';
  if (error.includes('COPY_FAILED')) return '复制配置失败，请检查系统剪贴板权限。';
  if (error.includes('CONNECT_FAILED')) return '连接失败，原配置已自动恢复。';
  if (error.includes('DISCONNECT_FAILED')) return '断开失败，现有配置保持不变。';
  return '连接测试失败，请确认 CanvasForge 画布已打开。';
}
function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / (1024 ** index)).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}
