import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const { load } = createRequire(import.meta.url)('js-yaml') as {
  load(source: string): unknown;
};

interface BuilderConfig {
  readonly artifactName?: string;
  readonly directories?: {
    readonly output?: string;
  };
}

function isPathInside(parentPath: string, candidatePath: string): boolean {
  const pathFromParent = relative(parentPath, candidatePath);
  return pathFromParent.length === 0
    || (!pathFromParent.startsWith('..') && !isAbsolute(pathFromParent));
}

describe('desktop packaging boundary', () => {
  it('keeps the 1.6.72 modern installer in its own builder output and excludes legacy output', async () => {
    const modernRoot = join(process.cwd(), 'apps', 'desktop-modern');
    const packageJson = JSON.parse(await readFile(
      join(modernRoot, 'package.json'),
      'utf8',
    )) as { version: string };
    const builderConfig = load(await readFile(
      join(modernRoot, 'electron-builder.yml'),
      'utf8',
    )) as BuilderConfig;

    expect(packageJson.version).toBe('1.6.72');
    expect(builderConfig.directories?.output).toBe('dist-builder/desktop-modern');
    expect(builderConfig.artifactName).toBe('CanvasAtelier-Win10-11-x64-${version}.exe');

    const modernOutputRoot = resolve(modernRoot, builderConfig.directories!.output!);
    const installerPath = resolve(
      modernOutputRoot,
      builderConfig.artifactName!.replace('${version}', packageJson.version),
    );
    const legacyOutputRoot = resolve(process.cwd(), 'apps', 'desktop-legacy', 'dist-builder', 'desktop-legacy');

    expect(modernOutputRoot).toBe(resolve(modernRoot, 'dist-builder', 'desktop-modern'));
    expect(installerPath).toBe(resolve(
      modernRoot,
      'dist-builder',
      'desktop-modern',
      'CanvasAtelier-Win10-11-x64-1.6.72.exe',
    ));
    expect(isPathInside(modernOutputRoot, installerPath)).toBe(true);
    expect(isPathInside(legacyOutputRoot, installerPath)).toBe(false);
  });

  it('excludes bundled workspace dependencies because the desktop entries are self-contained', async () => {
    const builderConfig = await readFile(
      join(process.cwd(), 'apps', 'desktop-modern', 'electron-builder.yml'),
      'utf8',
    );

    expect(builderConfig).toContain('  - "!node_modules/**"');
  });

  it('excludes renderer source maps from the distributable package', async () => {
    const rendererConfig = await readFile(
      join(process.cwd(), 'apps', 'renderer', 'vite.config.ts'),
      'utf8',
    );

    expect(rendererConfig).toContain('sourcemap: false');
  });

  it('removes legacy CanvasForge shortcuts during install so users cannot launch the old UI', async () => {
    const builderConfig = await readFile(
      join(process.cwd(), 'apps', 'desktop-modern', 'electron-builder.yml'),
      'utf8',
    );
    const installerScript = await readFile(
      join(process.cwd(), 'apps', 'desktop-modern', 'build', 'installer.nsh'),
      'utf8',
    );

    expect(builderConfig).toContain('include: build/installer.nsh');
    expect(installerScript).toContain('$DESKTOP\\CanvasForge.lnk');
    expect(installerScript).toContain('$SMPROGRAMS\\CanvasForge.lnk');
    expect(installerScript).toContain('$SMPROGRAMS\\CanvasForge\\CanvasForge.lnk');
    expect(installerScript).not.toContain('provider-credentials');
    expect(installerScript).not.toContain('AppData');
  });

  it('uses the Canvas Atelier window title so the packaged app is not confused with legacy Novus builds', async () => {
    const rendererHtml = await readFile(
      join(process.cwd(), 'apps', 'renderer', 'index.html'),
      'utf8',
    );

    expect(rendererHtml).toContain('<title>Canvas Atelier</title>');
    expect(rendererHtml).not.toContain('<title>Novus Atelier</title>');
  });

  it('hides the native Electron menu bar while retaining the compact window title bar', async () => {
    const desktopMain = await readFile(
      join(process.cwd(), 'apps', 'desktop-modern', 'src', 'main.ts'),
      'utf8',
    );

    expect(desktopMain).toMatch(/new BrowserWindow\(\{[\s\S]*?autoHideMenuBar:\s*true,/u);
  });
});
