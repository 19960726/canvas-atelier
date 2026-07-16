import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('runtime profile shell and config contract', () => {
  it('requires a preload-safe renderer runtime-profile helper and typed consumers for concurrency, fps, thumbnails, and interaction shadows', async () => {
    const runtimeProfileHelperPath = join(process.cwd(), 'apps/renderer/src/app/runtime-profile.ts');
    const helperExists = await fileExists(runtimeProfileHelperPath);

    expect(helperExists).toBe(true);
    if (!helperExists) return;

    const runtimeProfileHelper = await readFile(runtimeProfileHelperPath, 'utf8');
    expect(runtimeProfileHelper).toContain('agentCanvasRuntimeProfile');
    expect(runtimeProfileHelper).toContain("'legacy-win7'");
    expect(runtimeProfileHelper).toContain("'modern'");
    expect(runtimeProfileHelper).not.toMatch(/process\.|process\s*:|env\.|import\.meta\.env|ipcRenderer/u);

    const appStoreSource = await readFile(join(process.cwd(), 'apps/renderer/src/app/app-store.ts'), 'utf8');
    expect(appStoreSource).toContain('providerPollConcurrency');
    expect(appStoreSource).toContain('imageDecodeConcurrency');

    const canvasWorkspaceSource = await readFile(join(process.cwd(), 'apps/renderer/src/canvas/CanvasWorkspace.tsx'), 'utf8');
    expect(canvasWorkspaceSource).toContain('runtimeProfile');
    expect(canvasWorkspaceSource).toContain('thumbnailEdge');

    const placementBoardSource = await readFile(join(process.cwd(), 'apps/renderer/src/placement/PlacementBoard.tsx'), 'utf8');
    expect(placementBoardSource).toContain('targetFps');
    expect(placementBoardSource).toContain('disableShadowsWhileInteracting');

    const referenceOrderListSource = await readFile(join(process.cwd(), 'apps/renderer/src/references/ReferenceOrderList.tsx'), 'utf8');
    expect(referenceOrderListSource).toContain('thumbnailEdge');
  });

  it('pins each shell to its exact runtime profile without widening preload access or weakening Electron isolation', async () => {
    const legacyPreloadSource = await readFile(join(process.cwd(), 'apps/desktop-legacy/src/preload.ts'), 'utf8');
    const modernPreloadSource = await readFile(join(process.cwd(), 'apps/desktop-modern/src/preload.ts'), 'utf8');

    expect(legacyPreloadSource).toContain("agentCanvasRuntimeProfile");
    expect(legacyPreloadSource).toContain("getRuntimeProfile('legacy-win7')");
    expect(legacyPreloadSource).not.toMatch(/process\.env|contextBridge\.exposeInMainWorld\([^)]*process/u);
    expect(modernPreloadSource).toContain("agentCanvasRuntimeProfile");
    expect(modernPreloadSource).toContain("getRuntimeProfile('modern')");
    expect(modernPreloadSource).not.toMatch(/process\.env|contextBridge\.exposeInMainWorld\([^)]*process/u);

    for (const mainPath of [
      join(process.cwd(), 'apps/desktop-legacy/src/main.ts'),
      join(process.cwd(), 'apps/desktop-modern/src/main.ts'),
    ]) {
      const source = await readFile(mainPath, 'utf8');
      expect(source).toContain('contextIsolation: true');
      expect(source).toContain('nodeIntegration: false');
      expect(source).toContain('sandbox: true');
      expect(source).not.toMatch(/enableRemoteModule|@electron\/remote|electron\/remote/u);
    }
  });

  it('requires CSP coverage in renderer html and split electron-builder artifacts without running pack', async () => {
    const rendererHtml = await readFile(join(process.cwd(), 'apps/renderer/index.html'), 'utf8');
    expect(rendererHtml).toMatch(/Content-Security-Policy/i);

    const legacyBuilderPath = join(process.cwd(), 'apps/desktop-legacy/electron-builder.yml');
    const modernBuilderPath = join(process.cwd(), 'apps/desktop-modern/electron-builder.yml');
    const legacyBuilderExists = await fileExists(legacyBuilderPath);
    const modernBuilderExists = await fileExists(modernBuilderPath);

    expect(legacyBuilderExists).toBe(true);
    expect(modernBuilderExists).toBe(true);
    if (!legacyBuilderExists || !modernBuilderExists) return;

    const legacyBuilder = await readFile(legacyBuilderPath, 'utf8');
    const modernBuilder = await readFile(modernBuilderPath, 'utf8');

    expect(legacyBuilder).toContain('artifactName: AgentCanvas-Win7-x64-${version}.exe');
    expect(legacyBuilder).toContain('output: dist-builder/desktop-legacy');
    expect(modernBuilder).toContain('artifactName: AgentCanvas-Win10-11-x64-${version}.exe');
    expect(modernBuilder).toContain('output: dist-builder/desktop-modern');
  });
});

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
