import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { app, BrowserWindow, dialog, ipcMain, net, safeStorage, shell } from 'electron';

import {
  BRIDGE_CHANNELS,
  ApprovedSnapshotOutbox,
  ApprovedSnapshotPullCoordinator,
  KnowledgeRefreshService,
  ManagedKnowledgeStore,
  createComflyProviderService,
  createDesktopBridgeHandlers,
  createElectronNetComflyFetch,
  createApprovedSnapshotSyncClientFromEnv,
  createRendererCloseFlushCoordinator,
  createProviderBridgeHandlers,
  createSecureProviderCredentialStore,
  redactNovusPackDiagnostics,
  registerDesktopBridgeHandlers,
  registerProviderBridgeHandlers,
  startApprovedSnapshotOutboxDrain,
  startConfiguredKnowledgeRefresh,
  shutdownDesktopServices,
  type ApprovedSnapshotOutboxDrainHandle,
  type BridgeDialogAdapter,
  type DesktopBridgeHandlers,
  type RendererCloseFlushCoordinator,
} from '@agent-canvas/desktop-core';
import { resolveRendererHtmlPath } from './renderer-path';

const runtimeChannel = 'modern' as const;
const currentDir = dirname(fileURLToPath(import.meta.url));
const rendererHtmlPath = resolveRendererHtmlPath(currentDir);
const preloadPath = join(currentDir, 'preload.js');
const safeModePreloadPath = join(currentDir, 'safe-preload.js');
const safeModeHtmlPath = join(currentDir, 'safe-mode.html');
const diagnosticsChannel = 'novus-desktop:safe-mode-failure';

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

const hasSingleInstanceLock = app.requestSingleInstanceLock();
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
    channel: runtimeChannel,
    dialogs: createDialogAdapter(),
    approvedSnapshotOutbox,
    knowledgeConfigurationSync: approvedSnapshotPullCoordinator,
    knowledgeRefreshService,
    knowledgeStore,
    knowledgeSyncStatusProvider: approvedSnapshotPullCoordinator,
  });
  closeCoordinator = createRendererCloseFlushCoordinator({
    canRequestRendererFlush: canRequestRendererCloseFlush,
    closeAllProjects: runCoordinatedShutdown,
    finalizeClose: finalizeCoordinatedClose,
    sendCloseFlushRequest: sendRendererCloseFlushRequest,
  });
  registerDesktopBridgeHandlers(ipcMain, desktopHandlers);
  registerProviderBridgeHandlers(ipcMain, createProviderBridgeHandlers(createComflyProviderService({
    appDataRoot: app.getPath('userData'),
    credentialStore: createSecureProviderCredentialStore({
      appDataRoot: app.getPath('userData'),
      safeStorage,
    }),
    fetch: createElectronNetComflyFetch(net),
  })));
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

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createMainWindow();
    }
  });
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

function createDesktopWindow(preload: string): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 720,
    show: false,
    backgroundColor: '#0a0d14',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload,
      sandbox: true,
    },
  });

  window.once('ready-to-show', () => {
    window.show();
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
    async chooseProjectRoot(request) {
      const result = await dialog.showOpenDialog({
        properties: ['openDirectory'],
        title: request.mode === 'write' ? 'Open project' : 'Open project read-only',
      });
      return result.canceled ? null : result.filePaths[0] ?? null;
    },
  };
}
