import { access, readFile } from 'node:fs/promises';
import { join, normalize, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

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
    expect(legacyPreloadSource).toContain("@agent-canvas/domain");
    expect(legacyPreloadSource).not.toMatch(/process\.env|contextBridge\.exposeInMainWorld\([^)]*process/u);
    expect(modernPreloadSource).toContain("agentCanvasRuntimeProfile");
    expect(modernPreloadSource).toContain("getRuntimeProfile('modern')");
    expect(modernPreloadSource).toContain("@agent-canvas/domain");
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

  it('requires desktop manifests and lockfile to declare the explicit domain dependency used by preload', async () => {
    for (const packagePath of [
      join(process.cwd(), 'apps/desktop-legacy/package.json'),
      join(process.cwd(), 'apps/desktop-modern/package.json'),
    ]) {
      const packageJson = JSON.parse(await readFile(packagePath, 'utf8')) as {
        dependencies?: Record<string, string>;
      };
      expect(packageJson.dependencies?.['@agent-canvas/domain']).toBe('file:../../packages/domain');
    }

    const lockfile = JSON.parse(await readFile(join(process.cwd(), 'package-lock.json'), 'utf8')) as {
      packages?: Record<string, { dependencies?: Record<string, string> }>;
    };
    expect(lockfile.packages?.['apps/desktop-legacy']?.dependencies?.['@agent-canvas/domain']).toBe('file:../../packages/domain');
    expect(lockfile.packages?.['apps/desktop-modern']?.dependencies?.['@agent-canvas/domain']).toBe('file:../../packages/domain');
  });

  it('requires CSP coverage and a builder layout that places the renderer html exactly where packaged main resolves it', async () => {
    const rendererHtml = await readFile(join(process.cwd(), 'apps/renderer/index.html'), 'utf8');
    expect(rendererHtml).toMatch(/Content-Security-Policy/i);

    await expectShellLayout({
      artifactName: 'AgentCanvas-Win7-x64-${version}.exe',
      builderPath: join(process.cwd(), 'apps/desktop-legacy/electron-builder.yml'),
      mainPath: join(process.cwd(), 'apps/desktop-legacy/src/main.ts'),
      rendererPathHelperPath: join(process.cwd(), 'apps/desktop-legacy/src/renderer-path.ts'),
      output: 'dist-builder/desktop-legacy',
      packageDir: join(process.cwd(), 'apps/desktop-legacy'),
    });
    await expectShellLayout({
      artifactName: 'AgentCanvas-Win10-11-x64-${version}.exe',
      builderPath: join(process.cwd(), 'apps/desktop-modern/electron-builder.yml'),
      mainPath: join(process.cwd(), 'apps/desktop-modern/src/main.ts'),
      rendererPathHelperPath: join(process.cwd(), 'apps/desktop-modern/src/renderer-path.ts'),
      output: 'dist-builder/desktop-modern',
      packageDir: join(process.cwd(), 'apps/desktop-modern'),
    });
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

async function expectShellLayout(input: {
  artifactName: string;
  builderPath: string;
  mainPath: string;
  rendererPathHelperPath: string;
  output: string;
  packageDir: string;
}): Promise<void> {
  expect(await fileExists(input.builderPath)).toBe(true);
  if (!(await fileExists(input.builderPath))) return;
  expect(await fileExists(input.rendererPathHelperPath)).toBe(true);
  if (!(await fileExists(input.rendererPathHelperPath))) return;

  const builder = parseSimpleYaml(await readFile(input.builderPath, 'utf8'));
  expect(readYamlString(builder, 'artifactName')).toBe(input.artifactName);
  expect(readYamlString(builder, 'directories.output')).toBe(input.output);
  expect(readYamlStringArray(builder, 'files')).toContain('dist/**');
  expect(readYamlString(builder, 'extraResources.from')).toBe('../renderer/dist');
  expect(readYamlString(builder, 'extraResources.to')).toBe('renderer/dist');

  const mainSource = await readFile(input.mainPath, 'utf8');
  expect(mainSource).toContain("from './renderer-path'");
  expect(mainSource).toContain('resolveRendererHtmlPath(currentDir)');

  const helperModule = await import(pathToFileURL(input.rendererPathHelperPath).href) as {
    resolveRendererHtmlPath?: (currentDir: string) => string;
  };
  const currentDir = resolve(input.packageDir, 'dist');
  const packagedRendererPath = helperModule.resolveRendererHtmlPath?.(currentDir);
  expect(packagedRendererPath).toBe(normalize(resolve(currentDir, '../../renderer/dist/index.html')));

  const packagedResourcesRoot = normalize(resolve(currentDir, '..', '..'));
  const packagedExtraResourcePath = normalize(
    resolve(packagedResourcesRoot, readYamlString(builder, 'extraResources.to'), 'index.html'),
  );
  expect(packagedExtraResourcePath).toBe(normalize(resolve(currentDir, '../../renderer/dist/index.html')));
}

function parseSimpleYaml(source: string): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  const lines = source.split(/\r?\n/u);
  let currentSection: string | null = null;
  let currentNested: string | null = null;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\t/g, '    ');
    if (line.trim().length === 0 || line.trimStart().startsWith('#')) continue;

    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();
    if (trimmed.startsWith('- ')) {
      const key = currentNested ? `${currentSection}.${currentNested}` : currentSection;
      if (!key) continue;
      const existing = (result[key] ??= []);
      if (Array.isArray(existing)) {
        existing.push(trimmed.slice(2));
      }
      continue;
    }

    const separator = trimmed.indexOf(':');
    const key = separator < 0 ? trimmed : trimmed.slice(0, separator).trim();
    const value = separator < 0 ? '' : trimmed.slice(separator + 1).trim();
    if (indent === 0) {
      currentSection = key;
      currentNested = null;
      if (value.length > 0) {
        result[key] = value;
      }
      continue;
    }

    if (indent === 2 && currentSection) {
      currentNested = key;
      if (value.length > 0) {
        result[`${currentSection}.${key}`] = value;
      }
    }
  }

  return result;
}

function readYamlString(
  record: Record<string, string | string[]>,
  key: string,
): string {
  const value = record[key];
  expect(typeof value).toBe('string');
  return value as string;
}

function readYamlStringArray(
  record: Record<string, string | string[]>,
  key: string,
): string[] {
  const value = record[key];
  expect(Array.isArray(value)).toBe(true);
  return value as string[];
}
