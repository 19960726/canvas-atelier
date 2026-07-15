import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { app, BrowserWindow, dialog, ipcMain, net, shell } from 'electron';

import {
  BRIDGE_CHANNELS,
  ApprovedSnapshotOutbox,
  ApprovedSnapshotPullCoordinator,
  KnowledgeRefreshService,
  ManagedKnowledgeStore,
  createDesktopBridgeHandlers,
  createApprovedSnapshotSyncClientFromEnv,
  redactNovusPackDiagnostics,
  registerDesktopBridgeHandlers,
  startApprovedSnapshotOutboxDrain,
  startConfiguredKnowledgeRefresh,
  type ApprovedSnapshotOutboxDrainHandle,
  type BridgeDialogAdapter,
  type DesktopBridgeHandlers,
} from '@agent-canvas/desktop-core';

const runtimeChannel = 'legacy' as const;
const currentDir = dirname(fileURLToPath(import.meta.url));
const rendererHtmlPath = resolve(currentDir, '../../renderer/dist/index.html');
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

app.whenReady().then(async () => {
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
    knowledgeRefreshService,
    knowledgeStore,
  });
  registerDesktopBridgeHandlers(ipcMain, desktopHandlers);
  ipcMain.on(diagnosticsChannel, (_event, message) => {
    void loadSafeMode(redactNovusPackDiagnostics(String(message)));
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
  if (desktopHandlers === null || closeAllStarted) {
    return;
  }

  event.preventDefault();
  closeAllStarted = true;
  const handlers = desktopHandlers;
  void (async () => {
    try {
      await handlers.closeAllProjects();
    } finally {
      await Promise.all([
        approvedSnapshotDrainHandle?.stop(),
        approvedSnapshotPullCoordinator?.stop(),
        knowledgeRefreshServiceHandle?.stop(),
      ]);
      approvedSnapshotDrainHandle = null;
      approvedSnapshotPullCoordinator = null;
      knowledgeRefreshServiceHandle = null;
      unsubscribeKnowledgeState?.();
      unsubscribeKnowledgeState = null;
      app.quit();
    }
  })();
});

async function createMainWindow(): Promise<void> {
  const window = createDesktopWindow(preloadPath);
  mainWindow = window;

  window.webContents.on('did-fail-load', () => {
    void loadSafeMode('Renderer failed to load. Safe mode is available.');
  });
  window.webContents.on('render-process-gone', () => {
    void loadSafeMode('Renderer process exited unexpectedly. Safe mode is available.');
  });
  window.on('closed', () => {
    if (mainWindow === window) {
      mainWindow = null;
      safeModeLoaded = false;
    }
  });

  try {
    await window.loadFile(rendererHtmlPath);
  } catch (error) {
    await loadSafeMode(
      `Renderer startup failed: ${redactNovusPackDiagnostics(error instanceof Error ? error.message : String(error))}`,
    );
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
  const safeWindow = createDesktopWindow(safeModePreloadPath);
  mainWindow = safeWindow;
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
