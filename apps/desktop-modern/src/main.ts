import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';

import {
  createDesktopBridgeHandlers,
  redactNovusPackDiagnostics,
  registerDesktopBridgeHandlers,
  type BridgeDialogAdapter,
} from '@agent-canvas/desktop-core';

const runtimeChannel = 'modern' as const;
const currentDir = dirname(fileURLToPath(import.meta.url));
const rendererHtmlPath = resolve(currentDir, '../../renderer/dist/index.html');
const preloadPath = join(currentDir, 'preload.js');
const safeModeHtmlPath = join(currentDir, 'safe-mode.html');
const diagnosticsChannel = 'novus-desktop:safe-mode-failure';

let mainWindow: BrowserWindow | null = null;
let safeModeLoaded = false;

app.whenReady().then(async () => {
  registerDesktopBridgeHandlers(
    ipcMain,
    createDesktopBridgeHandlers({
      appDataRoot: app.getPath('userData'),
      channel: runtimeChannel,
      dialogs: createDialogAdapter(),
    }),
  );
  ipcMain.on(diagnosticsChannel, (_event, message) => {
    void loadSafeMode(redactNovusPackDiagnostics(String(message)));
  });

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

async function createMainWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1100,
    minHeight: 720,
    show: false,
    backgroundColor: '#0a0d14',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: preloadPath,
      sandbox: true,
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  mainWindow.webContents.on('did-fail-load', () => {
    void loadSafeMode('Renderer failed to load. Safe mode is available.');
  });
  mainWindow.webContents.on('render-process-gone', () => {
    void loadSafeMode('Renderer process exited unexpectedly. Safe mode is available.');
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('novus-safe-mode:')) {
      return;
    }
    event.preventDefault();
    void handleSafeModeCommand(url.slice('novus-safe-mode:'.length));
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
    safeModeLoaded = false;
  });

  try {
    await mainWindow.loadFile(rendererHtmlPath);
  } catch (error) {
    await loadSafeMode(
      `Renderer startup failed: ${redactNovusPackDiagnostics(error instanceof Error ? error.message : String(error))}`,
    );
  }
}

async function loadSafeMode(reason: string): Promise<void> {
  if (mainWindow === null || safeModeLoaded) {
    return;
  }

  safeModeLoaded = true;
  await mainWindow.loadFile(safeModeHtmlPath, {
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
