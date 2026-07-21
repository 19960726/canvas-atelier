import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { lookup } from 'node:dns/promises';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage, net, protocol, safeStorage, shell } from 'electron';

import {
  BRIDGE_CHANNELS,
  ApprovedSnapshotOutbox,
  ApprovedSnapshotPullCoordinator,
  KnowledgeRefreshService,
  GenerationHistoryProviderSink,
  GenerationHistoryStore,
  ManagedKnowledgeStore,
  createComflyProviderService,
  createDesktopBridgeHandlers,
  createElectronClipboardImageAdapter,
  createElectronClipboardVideoAdapter,
  createElectronNetComflyFetch,
  createElectronTrustedImageDecoder,
  createApprovedSnapshotSyncClientFromEnv,
  createRendererCloseFlushCoordinator,
  createProviderBridgeHandlers,
  isHistoryNetworkPath,
  createPersistenceError,
  createSecureProviderCredentialStore,
  parseCloseChoiceRequest,
  NodeFileSystem,
  SnapshotScheduler,
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
  type SnapshotWorkerInput,
  type SnapshotWorkerOutput,
} from '@agent-canvas/desktop-core';
import { resolveRendererHtmlPath } from './renderer-path';

const runtimeChannel = 'modern' as const;
const currentDir = __dirname;
const appIconPath = app.isPackaged
  ? join(process.resourcesPath, 'icon.ico')
  : join(currentDir, '..', 'build', 'icon.ico');
const rendererHtmlPath = resolveRendererHtmlPath(currentDir);
const preloadPath = join(currentDir, 'preload.js');
const safeModePreloadPath = join(currentDir, 'safe-preload.js');
const safeModeHtmlPath = join(currentDir, 'safe-mode.html');
const snapshotWorkerEntryPath = join(currentDir, 'snapshot-worker-entry.cjs');
const diagnosticsChannel = 'novus-desktop:safe-mode-failure';

if (protocol !== undefined) {
  protocol.registerSchemesAsPrivileged([{
    scheme: 'novus-asset',
    privileges: { secure: true, standard: true },
  }]);
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
  const fileSystem = new NodeFileSystem();
  const appDataRoot = app.getPath('userData');
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
    channel: runtimeChannel,
      clipboard: createElectronClipboardImageAdapter(clipboard),
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
    snapshotScheduler,
  });
  registerProjectImageProtocol(desktopHandlers);
  closeCoordinator = createRendererCloseFlushCoordinator({
    canRequestRendererFlush: canRequestRendererCloseFlush,
    closeAllProjects: runCoordinatedShutdown,
    finalizeClose: finalizeCoordinatedClose,
    sendCloseFlushRequest: sendRendererCloseFlushRequest,
  });
  registerDesktopBridgeHandlers(ipcMain, desktopHandlers);
  ipcMain.handle(BRIDGE_CHANNELS.closeChoice, async (event, payload) => {
    if (mainWindow === null || event.sender !== mainWindow.webContents) return 'cancel';
    const request = parseCloseChoiceRequest(payload);
    if (request === null || !request.dirty || !request.untitled) return 'cancel';
    const result = await dialog.showMessageBox(mainWindow, {
      buttons: ['保存', '不保存', '取消'],
      cancelId: 2,
      defaultId: 0,
      detail: '保存会通过现有受限项目边界完成；不保存将关闭当前未命名工作流。',
      message: `是否保存“${request.projectName}”？`,
      noLink: true,
      title: '关闭未命名工作流',
      type: 'question',
    });
    return result.response === 0 ? 'save' : result.response === 1 ? 'discard' : 'cancel';
  });
  registerProviderBridgeHandlers(ipcMain, createProviderBridgeHandlers(createComflyProviderService({
    appDataRoot: app.getPath('userData'),
    credentialStore: createSecureProviderCredentialStore({
      appDataRoot: app.getPath('userData'),
      safeStorage,
    }),
    fetch: createElectronNetComflyFetch(net),
    historySink: new GenerationHistoryProviderSink({
      store: generationHistoryStore,
      trustedImageDecoder: createElectronTrustedImageDecoder(nativeImage),
    }),
    resolveResultHost: async (hostname) => (await lookup(hostname, { all: true, verbatim: true }))
      .map((entry) => entry.address),
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
    icon: appIconPath,
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

async function handleStartupFailure(error: unknown): Promise<void> {
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
  protocol.registerFileProtocol('novus-asset', (request, callback) => {
    void handlers.resolveProjectImagePath(request.url)
      .then((path) => callback(path === null ? { error: -6 } : { path }))
      .catch(() => callback({ error: -6 }));
  });
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
