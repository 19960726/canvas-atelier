import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { lookup } from 'node:dns/promises';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage, net, protocol, safeStorage, session, shell } from 'electron';

import { acquireRelayMeWebToken } from './relayme-web-login.js';

import {
  BRIDGE_CHANNELS,
  ApprovedSnapshotOutbox,
  ApprovedSnapshotPullCoordinator,
  KnowledgeRefreshService,
  GenerationHistoryProviderSink,
  GenerationHistoryStore,
  ManagedKnowledgeStore,
  MockReleaseFeed,
  createComflyProviderService,
  createRelayMeProviderService,
  createProviderRegistry,
  createMcpClientConfigManager,
  createMcpStdioHealthCheck,
  createMcpRendererBridge,
  createMcpRuntimeService,
  presentMcpRuntimeStatus,
  createDesktopBridgeHandlers,
  createCacheDirectoryService,
  createNodeCacheDirectoryServiceAdapters,
  createElectronClipboardImageAdapter,
  createElectronClipboardVideoAdapter,
  createElectronNetComflyFetch,
  createElectronTrustedImageDecoder,
  createNodeWindowsPhotoshopSmartObjectAdapter,
  createApprovedSnapshotSyncClientFromEnv,
  createRendererCloseFlushCoordinator,
  createProviderBridgeHandlers,
  createProviderActiveStore,
  isHistoryNetworkPath,
  migrateLegacyUserData,
  createPersistenceError,
  createSecureProviderCredentialStore,
  parseCloseChoiceRequest,
  NodeFileSystem,
  SnapshotScheduler,
  UpdateClient,
  type UpdateDriver,
  type UpdateDriverEvent,
  redactNovusPackDiagnostics,
  registerDesktopBridgeHandlers,
  registerMcpClientConfigIpc,
  registerProviderBridgeHandlers,
  resolveLegacyUserDataRoots,
  resolveStableUserDataRoot,
  startApprovedSnapshotOutboxDrain,
  startConfiguredKnowledgeRefresh,
  shutdownDesktopServices,
  type ApprovedSnapshotOutboxDrainHandle,
  type BridgeDialogAdapter,
  type DesktopBridgeHandlers,
  type RendererCloseFlushCoordinator,
  type McpClientConfigIpcRegistration,
  type McpRendererBridge,
  type McpRuntimeService,
  type SnapshotWorkerInput,
  type SnapshotWorkerOutput,
} from '@agent-canvas/desktop-core';
import { createElectronUpdaterDriver } from './electron-updater-adapter';
import { resolveRendererHtmlPath } from './renderer-path';
import { resolveQaUserDataRoot, shouldShowQaWindow } from './qa-user-data-root';
import { installBrokenPipeExceptionCapture, installBrokenPipeGuard } from './broken-pipe-guard';

installBrokenPipeGuard([process.stdout, process.stderr]);
installBrokenPipeExceptionCapture(process);

if (process.platform === 'win32') {
  app.commandLine.appendSwitch('disable-gpu');
}

const runtimeChannel = 'modern' as const;
const currentDir = __dirname;
const appIconPath = app.isPackaged
  ? join(process.resourcesPath, 'icon.ico')
  : join(currentDir, '..', 'build', 'icon.ico');
const rendererHtmlPath = resolveRendererHtmlPath(currentDir);
const preloadPath = join(currentDir, 'preload.cjs');
const safeModePreloadPath = join(currentDir, 'safe-preload.cjs');
const safeModeHtmlPath = join(currentDir, 'safe-mode.html');
const snapshotWorkerEntryPath = join(currentDir, 'snapshot-worker-entry.cjs');
const mcpBridgeEntryPath = app.isPackaged
  ? join(process.resourcesPath, 'mcp', 'canvasforge-mcp.cjs')
  : join(currentDir, 'mcp', 'canvasforge-mcp.cjs');
const photoshopResourceRoot = app.isPackaged
  ? join(process.resourcesPath, 'photoshop')
  : join(currentDir, 'photoshop');
const photoshopSmartObjectAdapter = createNodeWindowsPhotoshopSmartObjectAdapter({
  platform: process.platform,
  jsxResourcePath: join(photoshopResourceRoot, 'photoshop-place-smart-object.jsx'),
  runnerResourcePath: join(photoshopResourceRoot, 'photoshop-windows-runner.js'),
});
const diagnosticsChannel = 'novus-desktop:safe-mode-failure';
const discoveredUserDataRoot = app.getPath('userData');
const discoveredAppDataRoot = app.getPath('appData');
const qaUserDataRoot = resolveQaUserDataRoot(process.env);
const stableUserDataRoot = qaUserDataRoot ?? resolveStableUserDataRoot(discoveredAppDataRoot);
const legacyUserDataRoots = qaUserDataRoot === null
  ? resolveLegacyUserDataRoots(discoveredAppDataRoot, discoveredUserDataRoot)
  : [];
if (qaUserDataRoot !== null) app.setPath('appData', qaUserDataRoot);
app.setPath('userData', stableUserDataRoot);

if (protocol !== undefined) {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'novus-asset',
      privileges: { secure: true, standard: true, supportFetchAPI: true, stream: true },
    },
    {
      scheme: 'novus-history',
      privileges: { secure: true, standard: true, supportFetchAPI: true, stream: true },
    },    {
      scheme: 'novus-recent-project',
      privileges: { secure: true, standard: true, supportFetchAPI: true, stream: true },
    },
  ]);
}

let mainWindow: BrowserWindow | null = null;
let safeModeLoaded = false;
let desktopHandlers: DesktopBridgeHandlers | null = null;
let approvedSnapshotDrainHandle: ApprovedSnapshotOutboxDrainHandle | null = null;
let approvedSnapshotPullCoordinator: ApprovedSnapshotPullCoordinator | null = null;
let knowledgeRefreshServiceHandle: KnowledgeRefreshService | null = null;
let unsubscribeKnowledgeState: (() => void) | null = null;
let closeAllStarted = false;
let closeCoordinator: RendererCloseFlushCoordinator | null = null;
let allowCoordinatedClose = false;
let closeFinalizeTarget: 'window' | 'app' = 'window';
let rendererLoaded = false;
let updateClient: UpdateClient | null = null;
let mcpRendererBridge: McpRendererBridge | null = null;
let mcpRuntimeService: McpRuntimeService | null = null;
let mcpClientConfigRegistration: McpClientConfigIpcRegistration | null = null;

function createDevelopmentUpdateDriver(): UpdateDriver {
  let listener: ((event: UpdateDriverEvent) => void) | null = null;
  return {
    subscribe(next) { listener = next; return () => { listener = null; }; },
    async checkForUpdates() { listener?.({ type: 'error', message: 'Updates are available only in the packaged app.' }); },
    async downloadUpdate() {},
    quitAndInstall() {},
  };
}

const hasSingleInstanceLock = qaUserDataRoot !== null || app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
}

app.on('second-instance', () => {
  if (mainWindow === null) return;
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.focus();
});

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return;
  await migrateLegacyUserData({
    stableRoot: stableUserDataRoot,
    legacyRoots: legacyUserDataRoots,
  });
  const fileSystem = new NodeFileSystem();
  const appDataRoot = app.getPath('userData');
  const cacheDirectoryService = createCacheDirectoryService(createNodeCacheDirectoryServiceAdapters({
    defaultCacheRoot: join(appDataRoot, 'regenerable-cache'),
    stateFilePath: join(appDataRoot, 'settings', 'cache-directory.json'),
    async chooseDirectory() {
      const result = await dialog.showOpenDialog({
        properties: ['openDirectory', 'createDirectory'],
      });
      return result.canceled ? null : result.filePaths[0] ?? null;
    },
    async openDirectory(path) {
      return (await shell.openPath(path)) === '';
    },
  }));
  const mockUpdateVersion = process.env.NOVUS_MOCK_UPDATE_VERSION;
  updateClient = app.isPackaged
    ? new UpdateClient({ driver: createElectronUpdaterDriver() })
    : mockUpdateVersion !== undefined
      ? new UpdateClient({
          currentVersion: app.getVersion(),
          feed: new MockReleaseFeed({
            channel: 'stable',
            version: mockUpdateVersion,
            notes: process.env.NOVUS_MOCK_UPDATE_NOTES ?? 'Mock update feed is active for local verification only.',
            signatureStatus: 'verified',
          }),
        })
      : new UpdateClient({ driver: createDevelopmentUpdateDriver() });
  updateClient.subscribe((state) => {
    mainWindow?.webContents.send(BRIDGE_CHANNELS.updates.stateChanged, { ...state, currentVersion: app.getVersion() });
  });
  const generationHistoryStore = new GenerationHistoryStore({
    historyRoot: join(appDataRoot, 'generation-history'),
    ownedRoot: appDataRoot,
    fileSystem,
    isNetworkPath: isHistoryNetworkPath,
  });
  const snapshotScheduler = new SnapshotScheduler({
    fileSystem,
    worker: createBundledSnapshotWorkerRunner(snapshotWorkerEntryPath),
  });
  const knowledgeStore = new ManagedKnowledgeStore({
    appDataRoot: app.getPath('userData'),
  });
  const knowledgeRefreshService = new KnowledgeRefreshService({
    store: knowledgeStore,
  });
  knowledgeRefreshServiceHandle = knowledgeRefreshService;
  const approvedSnapshotSyncClient = createApprovedSnapshotSyncClientFromEnv(process.env);
  const approvedSnapshotOutbox = new ApprovedSnapshotOutbox({
    appDataRoot: app.getPath('userData'),
    client: approvedSnapshotSyncClient ?? undefined,
    store: knowledgeStore,
  });
  approvedSnapshotPullCoordinator = new ApprovedSnapshotPullCoordinator({
    appDataRoot: app.getPath('userData'),
    client: approvedSnapshotSyncClient,
    isOnline: () => net.isOnline(),
    store: knowledgeStore,
  });
  const unsubscribeRefreshState = knowledgeRefreshService.subscribe((state) => {
    mainWindow?.webContents.send(BRIDGE_CHANNELS.knowledgeStateChanged, state);
  });
  const unsubscribePullState = approvedSnapshotPullCoordinator.subscribe((state) => {
    mainWindow?.webContents.send(BRIDGE_CHANNELS.knowledgeStateChanged, state);
  });
  const unsubscribePullSyncStatus = approvedSnapshotPullCoordinator.subscribeSyncStatus((status) => {
    mainWindow?.webContents.send(BRIDGE_CHANNELS.knowledgeSyncStatusChanged, status);
  });
  unsubscribeKnowledgeState = () => {
    unsubscribeRefreshState();
    unsubscribePullState();
    unsubscribePullSyncStatus();
  };
  desktopHandlers = createDesktopBridgeHandlers({
    appDataRoot: app.getPath('userData'),
    captureProjectPreview: async () => {
      const window = mainWindow;
      if (window === null || window.isDestroyed() || window.webContents.isDestroyed()) return null;
      const captured = await window.webContents.capturePage();
      if (captured.isEmpty()) return null;
      return captured.resize({ width: 640, quality: 'good' }).toPNG();
    },
    channel: runtimeChannel,
      clipboard: createElectronClipboardImageAdapter(clipboard, { createFromPath: (path) => nativeImage.createFromPath(path) }),
      clipboardVideo: createElectronClipboardVideoAdapter(clipboard),
    dialogs: createDialogAdapter(),
    approvedSnapshotOutbox,
    fileSystem,
    knowledgeConfigurationSync: approvedSnapshotPullCoordinator,
    knowledgeRefreshService,
    knowledgeStore,
    knowledgeSyncStatusProvider: approvedSnapshotPullCoordinator,
    historyIsNetworkPath: isHistoryNetworkPath,
    historyStore: generationHistoryStore,
    photoshopSmartObjectAdapter,
    snapshotScheduler,
  });
  registerProjectImageProtocol(desktopHandlers);
  closeCoordinator = createRendererCloseFlushCoordinator({
    canRequestRendererFlush: canRequestRendererCloseFlush,
    closeAllProjects: runCoordinatedShutdown,
    finalizeClose: finalizeCoordinatedClose,
    onCloseBlocked: showCloseRecoveryChoice,
    sendCloseFlushRequest: sendRendererCloseFlushRequest,
  });
  registerDesktopBridgeHandlers(ipcMain, desktopHandlers);
  ipcMain.handle(BRIDGE_CHANNELS.storage.getCacheDirectory, () => cacheDirectoryService.getCacheDirectory());
  ipcMain.handle(BRIDGE_CHANNELS.storage.chooseCacheDirectory, () => cacheDirectoryService.chooseCacheDirectory());
  ipcMain.handle(BRIDGE_CHANNELS.storage.resetCacheDirectory, () => cacheDirectoryService.resetCacheDirectory());
  ipcMain.handle(BRIDGE_CHANNELS.storage.openCacheDirectory, () => cacheDirectoryService.openCacheDirectory());
  ipcMain.handle(BRIDGE_CHANNELS.updates.getState, () => ({
    ...(updateClient?.getState() ?? { status: 'idle' }),
    currentVersion: app.getVersion(),
  }));
  ipcMain.handle(BRIDGE_CHANNELS.updates.check, () => updateClient!.check());
  ipcMain.handle(BRIDGE_CHANNELS.updates.download, () => updateClient!.download());
  ipcMain.handle(BRIDGE_CHANNELS.updates.defer, () => updateClient!.defer());
  ipcMain.handle(BRIDGE_CHANNELS.updates.retry, () => updateClient!.retry());
  ipcMain.handle(BRIDGE_CHANNELS.updates.restart, () => updateClient!.restart());
  ipcMain.handle(BRIDGE_CHANNELS.closeRequest, async (event) => {
    if (mainWindow === null || event.sender !== mainWindow.webContents || closeCoordinator === null) return;
    await closeCoordinator.requestClose();
  });
  ipcMain.handle(BRIDGE_CHANNELS.closeChoice, async (event, payload) => {
    if (mainWindow === null || event.sender !== mainWindow.webContents) return 'cancel';
    const request = parseCloseChoiceRequest(payload);
    if (request === null || !request.dirty || !request.untitled) return 'cancel';
    return 'save';
  });
  const providerFetch = createElectronNetComflyFetch(net);
  const relayMeNetworkSession = session.fromPartition('relayme-direct-network');
  await relayMeNetworkSession.setProxy({ mode: 'direct' });
  const relayMeWebLoginSession = session.fromPartition('persist:relayme-web-login');
  const relayMeProviderFetch = createElectronNetComflyFetch(net, {
    requestSession: relayMeNetworkSession,
  });
  const generationHistorySink = new GenerationHistoryProviderSink({
    store: generationHistoryStore,
    trustedImageDecoder: createElectronTrustedImageDecoder(nativeImage),
  });
  const providerActiveStore = createProviderActiveStore({ appDataRoot: app.getPath('userData') });
  registerProviderBridgeHandlers(ipcMain, createProviderBridgeHandlers(createProviderRegistry({
    comfly: createComflyProviderService({
      appDataRoot: app.getPath('userData'),
      credentialStore: createSecureProviderCredentialStore({
        appDataRoot: app.getPath('userData'),
        provider: 'comfly',
        safeStorage,
      }),
      fetch: providerFetch,
      discoverModelCatalog: true,
      historySink: generationHistorySink,
      resolveResultHost: async (hostname) => (await lookup(hostname, { all: true, verbatim: true }))
        .map((entry) => entry.address),
      readManagedReverseMedia: desktopHandlers.readManagedReverseMedia,
      readManagedGenerationImages: desktopHandlers.readManagedSkillChatImages,
      readManagedSkillChatImages: desktopHandlers.readManagedSkillChatImages,
      storeGeneratedImage: desktopHandlers.storeGeneratedImage,
      storeGeneratedVideo: desktopHandlers.storeGeneratedVideo,
    }),
    relayme: createRelayMeProviderService({
      appDataRoot: app.getPath('userData'),
      credentialStore: createSecureProviderCredentialStore({
        appDataRoot: app.getPath('userData'),
        provider: 'relayme',
        safeStorage,
      }),
      fetch: relayMeProviderFetch,
      loginWebAccount: () => acquireRelayMeWebToken({
        BrowserWindow,
        parent: mainWindow,
        session: relayMeWebLoginSession,
      }),
      historySink: generationHistorySink,
      resolveResultHost: async (hostname) => (await lookup(hostname, { all: true, verbatim: true }))
        .map((entry) => entry.address),
      readManagedReverseMedia: desktopHandlers.readManagedReverseMedia,
      storeGeneratedImage: desktopHandlers.storeGeneratedImage,
      storeGeneratedVideo: desktopHandlers.storeGeneratedVideo,
    }),
  }), { activeStore: providerActiveStore }), { getTrustedSender: () => mainWindow?.webContents ?? null });
  ipcMain.on(diagnosticsChannel, (_event, message) => {
    void loadSafeMode(redactNovusPackDiagnostics(String(message)));
  });
  ipcMain.on(BRIDGE_CHANNELS.closeFlushAck, (event, payload) => {
    if (mainWindow === null || event.sender !== mainWindow.webContents) return;
    void closeCoordinator?.handleCloseFlushAck(payload);
  });
  const knowledgeBaseIds = await startConfiguredKnowledgeRefresh(knowledgeStore, knowledgeRefreshService);
  await approvedSnapshotPullCoordinator.start(knowledgeBaseIds);
  approvedSnapshotDrainHandle = startApprovedSnapshotOutboxDrain({
    client: approvedSnapshotSyncClient,
    isOnline: () => net.isOnline(),
    outbox: approvedSnapshotOutbox,
  });
  await approvedSnapshotDrainHandle.drainNow();
  await createMainWindow();
  await startMcpRuntime();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createMainWindow();
    }
  });
}).catch((error) => {
  void handleStartupFailure(error);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', (event) => {
  if (allowCoordinatedClose || desktopHandlers === null || closeCoordinator === null) {
    return;
  }
  requestCoordinatedClose(event, 'app');
});

async function startMcpRuntime(): Promise<void> {
  if (mcpRuntimeService !== null || mcpRendererBridge !== null) return;
  let service: McpRuntimeService | null = null;
  const rendererBridge = createMcpRendererBridge({
    ipcMain,
    getRenderer: () => {
      const window = mainWindow;
      if (
        window === null
        || !rendererLoaded
        || safeModeLoaded
        || window.isDestroyed()
        || window.webContents.isCrashed()
        || window.webContents.isDestroyed()
      ) return null;
      return {
        sender: window.webContents,
        isDestroyed: () => window.webContents.isDestroyed(),
        send: (channel, payload) => window.webContents.send(channel, payload),
      };
    },
    getStatus: () => presentMcpRuntimeStatus(service?.getStatus() ?? {
      state: 'stopped', rendererConnected: false, serverVersion: app.getVersion(), toolCount: 14, lastError: null,
    }, isMcpRendererAvailable()),
  });
  service = createMcpRuntimeService({
    runtimeFilePath: join(app.getPath('appData'), 'CanvasForge', 'mcp', 'runtime-v1.json'),
    serverVersion: app.getVersion(),
    forwardRequest: rendererBridge.forwardRequest,
  });
  mcpRendererBridge = rendererBridge;
  mcpRuntimeService = service;
  try {
    await service.start();
    const mcpLaunchSpec = {
      command: process.execPath,
      args: [mcpBridgeEntryPath],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    } as const;
    const manager = createMcpClientConfigManager({
      clientPaths: {
        codex: process.env.CANVASFORGE_CODEX_CONFIG_PATH ?? join(app.getPath('home'), '.codex', 'config.toml'),
        workbuddy: process.env.CANVASFORGE_WORKBUDDY_CONFIG_PATH ?? join(app.getPath('home'), '.workbuddy', 'mcp.json'),
      },
      ...mcpLaunchSpec,
      healthCheck: createMcpStdioHealthCheck(mcpLaunchSpec),
    });
    mcpClientConfigRegistration = registerMcpClientConfigIpc({
      ipcMain,
      manager,
      getTrustedSender: () => {
        const window = mainWindow;
        return window !== null && rendererLoaded && !safeModeLoaded && !window.isDestroyed()
          ? window.webContents
          : null;
      },
    });
  } catch (error) {
    rendererBridge.dispose();
    mcpRendererBridge = null;
    mcpRuntimeService = null;
    throw error;
  }
}

function isMcpRendererAvailable(): boolean {
  const window = mainWindow;
  return window !== null
    && rendererLoaded
    && !safeModeLoaded
    && !window.isDestroyed()
    && !window.webContents.isCrashed()
    && !window.webContents.isDestroyed();
}

async function stopMcpRuntime(): Promise<void> {
  mcpClientConfigRegistration?.dispose();
  mcpClientConfigRegistration = null;
  const rendererBridge = mcpRendererBridge;
  const runtimeService = mcpRuntimeService;
  mcpRendererBridge = null;
  mcpRuntimeService = null;
  rendererBridge?.dispose();
  await runtimeService?.stop();
}
async function createMainWindow(): Promise<void> {
  const window = createDesktopWindow(preloadPath);
  mainWindow = window;
  rendererLoaded = false;

  window.webContents.on('did-fail-load', () => {
    rendererLoaded = false;
    void closeCoordinator?.rendererUnavailable();
    void loadSafeMode('Renderer failed to load. Safe mode is available.');
  });
  window.webContents.on('render-process-gone', () => {
    rendererLoaded = false;
    void closeCoordinator?.rendererUnavailable();
    void loadSafeMode('Renderer process exited unexpectedly. Safe mode is available.');
  });
  window.on('close', (event) => {
    requestCoordinatedClose(event, 'window');
  });
  window.on('closed', () => {
    if (mainWindow === window) {
      mainWindow = null;
      safeModeLoaded = false;
      rendererLoaded = false;
    }
  });

  try {
    await window.loadFile(rendererHtmlPath);
    rendererLoaded = mainWindow === window && !safeModeLoaded;
  } catch (error) {
    rendererLoaded = false;
    await loadSafeMode(
      `Renderer startup failed: ${redactNovusPackDiagnostics(error instanceof Error ? error.message : String(error))}`,
    );
  }
}

function requestCoordinatedClose(event: { preventDefault(): void }, target: 'window' | 'app'): void {
  if (allowCoordinatedClose || desktopHandlers === null || closeCoordinator === null) {
    return;
  }
  if (target === 'app') {
    closeFinalizeTarget = 'app';
  }
  void closeCoordinator.requestClose(event);
}

function canRequestRendererCloseFlush(): boolean {
  const window = mainWindow;
  return window !== null
    && rendererLoaded
    && !safeModeLoaded
    && !window.isDestroyed()
    && !window.webContents.isCrashed();
}

function sendRendererCloseFlushRequest(request: { readonly requestId: string }): boolean {
  if (!canRequestRendererCloseFlush()) return false;
  mainWindow?.webContents.send(BRIDGE_CHANNELS.closeFlushRequest, request);
  return true;
}

async function runCoordinatedShutdown(): Promise<void> {
  if (desktopHandlers === null || closeAllStarted) return;
  closeAllStarted = true;
  const handlers = desktopHandlers;
  await shutdownDesktopServices({
    closeAllProjects: () => handlers.closeAllProjects(),
    stopMcpRuntime,
    stopApprovedSnapshotDrain: () => approvedSnapshotDrainHandle?.stop() ?? Promise.resolve(),
    stopApprovedSnapshotPull: () => approvedSnapshotPullCoordinator?.stop() ?? Promise.resolve(),
    stopKnowledgeRefresh: () => knowledgeRefreshServiceHandle?.stop() ?? Promise.resolve(),
    unsubscribeKnowledgeState: () => {
      try {
        unsubscribeKnowledgeState?.();
      } finally {
        approvedSnapshotDrainHandle = null;
        approvedSnapshotPullCoordinator = null;
        knowledgeRefreshServiceHandle = null;
        unsubscribeKnowledgeState = null;
      }
    },
    quit: () => undefined,
  });
}

function finalizeCoordinatedClose(): void {
  allowCoordinatedClose = true;
  if (closeFinalizeTarget === 'app') {
    app.quit();
    return;
  }
  if (mainWindow !== null && !mainWindow.isDestroyed()) {
    mainWindow.destroy();
  }
}

async function showCloseRecoveryChoice(
  reason: 'failed' | 'timeout' | 'unavailable',
): Promise<'cancel' | 'discard'> {
  const reasonLabel = reason === 'timeout'
    ? '保存超时'
    : reason === 'unavailable'
      ? '画布暂时无法响应'
      : '保存失败';
  const options = {
    type: 'warning' as const,
    buttons: ['取消', '放弃未保存更改并退出'],
    cancelId: 0,
    defaultId: 0,
    detail: `${reasonLabel}。已成功保存的项目不会被删除；如果继续退出，只会放弃本次未保存的更改。`,
    message: '当前画布无法完成保存',
    noLink: true,
    title: '退出 Canvas Atelier',
  };
  const result = mainWindow !== null && !mainWindow.isDestroyed()
    ? await dialog.showMessageBox(mainWindow, options)
    : await dialog.showMessageBox(options);
  return result.response === 1 ? 'discard' : 'cancel';
}

function createDesktopWindow(preload: string): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 720,
    show: false,
    autoHideMenuBar: true,
    icon: appIconPath,
    backgroundColor: '#0a0d14',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload,
      sandbox: process.platform !== 'win32',
    },
  });

  window.once('ready-to-show', () => {
    if (shouldShowQaWindow(process.env)) window.show();
  });

  window.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('novus-safe-mode:')) {
      return;
    }
    event.preventDefault();
    void handleSafeModeCommand(url.slice('novus-safe-mode:'.length));
  });

  return window;
}

async function loadSafeMode(reason: string): Promise<void> {
  if (mainWindow === null || safeModeLoaded) {
    return;
  }

  const previousWindow = mainWindow;
  safeModeLoaded = true;
  rendererLoaded = false;
  const safeWindow = createDesktopWindow(safeModePreloadPath);
  mainWindow = safeWindow;
  safeWindow.on('close', (event) => {
    requestCoordinatedClose(event, 'window');
  });
  safeWindow.on('closed', () => {
    if (mainWindow === safeWindow) {
      mainWindow = null;
      safeModeLoaded = false;
    }
  });
  previousWindow.destroy();
  await safeWindow.loadFile(safeModeHtmlPath, {
    query: {
      reason: redactNovusPackDiagnostics(reason),
    },
  });
}

async function handleStartupFailure(error: unknown): Promise<void> {
  await stopMcpRuntime();
  const message = `Desktop startup failed: ${redactNovusPackDiagnostics(
    error instanceof Error ? error.stack ?? error.message : String(error),
  )}`;
  console.error(message);

  if (mainWindow !== null && !mainWindow.isDestroyed() && !safeModeLoaded) {
    try {
      await loadSafeMode(message);
      return;
    } catch (safeModeError) {
      console.error(
        `Desktop startup safe mode failed: ${redactNovusPackDiagnostics(
          safeModeError instanceof Error ? safeModeError.stack ?? safeModeError.message : String(safeModeError),
        )}`,
      );
    }
  }

  app.exit(1);
}

async function handleSafeModeCommand(command: string): Promise<void> {
  switch (command) {
    case 'clear-cache': {
      const sessionData = app.getPath('sessionData');
      await rm(sessionData, { force: true, recursive: true });
      await mkdir(sessionData, { recursive: true });
      return;
    }
    case 'export-diagnostics': {
      const diagnostics = [
        `timestamp=${new Date().toISOString()}`,
        `runtime=${runtimeChannel}`,
        `electron=${process.versions.electron ?? 'unknown'}`,
        `chrome=${process.versions.chrome ?? 'unknown'}`,
        `node=${process.versions.node}`,
        `userData=${redactNovusPackDiagnostics(app.getPath('userData'))}`,
      ].join('\n');
      const save = await dialog.showSaveDialog({
        defaultPath: join(app.getPath('documents'), 'novus-diagnostics.txt'),
        title: 'Export redacted diagnostics',
      });
      if (!save.canceled && save.filePath) {
        await writeFile(save.filePath, `${diagnostics}\n`, 'utf8');
      }
      return;
    }
    case 'reveal-support': {
      await shell.openPath(app.getPath('userData'));
      return;
    }
    default:
      return;
  }
}

function createDialogAdapter(): BridgeDialogAdapter {
  return {
    async chooseCreateProjectRoot(project) {
      const safeName = project.name.trim().replace(/[<>:"/\\|?*\u0000-\u001f]+/gu, ' ').replace(/\s+/gu, ' ').trim() || '未命名画布';
      const result = await dialog.showSaveDialog({
        defaultPath: join(app.getPath('documents'), `${safeName}.novus-project`),
        title: '保存画布项目',
      });
      return result.canceled || !result.filePath ? null : result.filePath;
    },
    async chooseHistoryExportDirectory(files) {
      const result = await dialog.showOpenDialog({
        defaultPath: app.getPath('documents'),
        properties: ['openDirectory', 'createDirectory'],
        title: `Export ${files.length} history image${files.length === 1 ? '' : 's'}`,
      });
      return result.canceled ? null : result.filePaths[0] ?? null;
    },
    async chooseImportDestination() {
      const result = await dialog.showSaveDialog({
        defaultPath: join(app.getPath('documents'), 'Imported Project.novus-project'),
        title: 'Choose imported project folder',
      });
      return result.canceled || !result.filePath ? null : result.filePath;
    },
    async chooseImportPackSource() {
      const result = await dialog.showOpenDialog({
        filters: [{ name: 'Novus Pack', extensions: ['novuspack', 'zip'] }],
        properties: ['openFile'],
        title: 'Choose Novus package',
      });
      return result.canceled ? null : result.filePaths[0] ?? null;
    },
    async chooseKnowledgeRoot(request) {
      const result = await dialog.showOpenDialog({
        properties: ['openDirectory'],
        title: `Choose knowledge folder for ${request.displayName}`,
      });
      return result.canceled ? null : result.filePaths[0] ?? null;
    },
    async choosePackExportPath(session) {
      const result = await dialog.showSaveDialog({
        defaultPath: join(app.getPath('documents'), `${session.projectName}.novuspack`),
        filters: [{ name: 'Novus Pack', extensions: ['novuspack'] }],
        title: 'Export Novus package',
      });
      return result.canceled || !result.filePath ? null : result.filePath;
    },
      async chooseProjectImage() {
      const result = await dialog.showOpenDialog({
        filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }],
        properties: ['openFile'],
        title: 'Import project image',
      });
      return result.canceled ? null : result.filePaths[0] ?? null;
      },
      async chooseProjectVideo() {
        const result = await dialog.showOpenDialog({
          filters: [{ name: 'MP4 Video', extensions: ['mp4'] }],
          properties: ['openFile'],
          title: 'Import project video',
        });
        return result.canceled ? null : result.filePaths[0] ?? null;
      },
    async chooseProjectRoot(request) {
      const result = await dialog.showOpenDialog({
        properties: ['openDirectory'],
        title: request.mode === 'write' ? 'Open project' : 'Open project read-only',
      });
      return result.canceled ? null : result.filePaths[0] ?? null;
    },
  };
}

function registerProjectImageProtocol(handlers: DesktopBridgeHandlers): void {
  protocol.handle('novus-asset', (request) => resolveProtocolFile(request, handlers.resolveProjectImagePath));
  protocol.handle('novus-history', (request) => resolveProtocolFile(request, handlers.resolveGenerationHistoryImagePath));
  protocol.handle('novus-recent-project', (request) => resolveProtocolFile(request, handlers.resolveRecentProjectPreviewPath));
}

async function resolveProtocolFile(
  request: Request,
  resolvePath: (url: string) => Promise<string | null>,
): Promise<Response> {
  try {
    const path = await resolvePath(request.url);
    if (path === null) return new Response(null, { status: 404 });
    return net.fetch(pathToFileURL(path).toString(), { headers: request.headers });
  } catch {
    return new Response(null, { status: 404 });
  }
}

function createBundledSnapshotWorkerRunner(
  workerEntryPath: string,
): (input: SnapshotWorkerInput) => Promise<SnapshotWorkerOutput> {
  return (input) => new Promise<SnapshotWorkerOutput>((resolve, reject) => {
    const worker = new Worker(pathToFileURL(workerEntryPath));
    let settled = false;

    const settle = (callback: () => void) => {
      if (settled) {
        return;
      }

      settled = true;
      callback();
      void Promise.resolve(worker.terminate()).catch(() => undefined);
    };

    worker.once('message', (message) => {
      settle(() => {
        if (isWorkerSuccessMessage(message)) {
          resolve(message.output);
          return;
        }

        if (isWorkerFailureMessage(message)) {
          reject(createPersistenceError(
            'CORRUPT_SNAPSHOT',
            false,
            `Snapshot worker failed: ${message.error}`,
          ));
          return;
        }

        reject(createPersistenceError(
          'CORRUPT_SNAPSHOT',
          false,
          'Snapshot worker returned an invalid response',
        ));
      });
    });
    worker.once('error', (workerError) => {
      settle(() => reject(workerError));
    });
    worker.once('exit', (code) => {
      if (code !== 0) {
        settle(() => reject(createPersistenceError(
          'CORRUPT_SNAPSHOT',
          false,
          `Snapshot worker exited with code ${code}`,
        )));
      }
    });
    worker.postMessage(input);
  });
}

function isWorkerSuccessMessage(
  message: unknown,
): message is { readonly ok: true; readonly output: SnapshotWorkerOutput } {
  return isPlainRecord(message) && message.ok === true && isPlainRecord(message.output);
}

function isWorkerFailureMessage(
  message: unknown,
): message is { readonly ok: false; readonly error: string } {
  return isPlainRecord(message) && message.ok === false && typeof message.error === 'string';
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}
