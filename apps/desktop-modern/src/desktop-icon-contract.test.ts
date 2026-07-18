import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const workspaceRoot = process.cwd();
const shells = ['desktop-modern', 'desktop-legacy'] as const;
const requiredFrameSizes = [16, 24, 32, 48, 64, 128, 256] as const;
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('desktop application icon contract', () => {
  it('tracks the full deterministic PNG chain from the single Novus SVG source', async () => {
    const brandRoot = join(workspaceRoot, 'assets', 'brand');
    const generationScript = await readFile(join(workspaceRoot, 'scripts', 'generate-icons.cjs'), 'utf8');
    expect(generationScript).toContain('novus-atelier-icon.svg');

    for (const size of [...requiredFrameSizes, 512]) {
      const png = await readFile(join(brandRoot, 'generated', `novus-atelier-${size}.png`));
      expect(readPngDimensions(png)).toEqual({ height: size, width: size });
    }
    expect(readPngDimensions(await readFile(join(brandRoot, 'novus-atelier-icon.png'))))
      .toEqual({ height: 512, width: 512 });
  });

  it('matches every tracked output to the generated source and output hash manifest', async () => {
    const manifest = JSON.parse(await readFile(
      join(workspaceRoot, 'assets', 'brand', 'generated', 'novus-atelier-icon-manifest.json'),
      'utf8',
    )) as IconManifest;

    expect(manifest.schemaVersion).toBe(1);
    await expectTextHashEntry(manifest.source);
    await expectTextHashEntry(manifest.generator);
    expect(manifest.outputs.map((output) => output.path)).toEqual([
      ...[...requiredFrameSizes, 512].map((size) => `assets/brand/generated/novus-atelier-${size}.png`),
      'assets/brand/novus-atelier-icon.png',
      'apps/desktop-modern/build/icon.ico',
      'apps/desktop-legacy/build/icon.ico',
    ]);
    for (const output of manifest.outputs) await expectHashEntry(output);
  });

  for (const shell of shells) {
    it(`${shell} uses the Novus icon for development windows and packaged Windows builds`, async () => {
      const shellRoot = join(workspaceRoot, 'apps', shell);
      const [mainSource, builderConfig] = await Promise.all([
        readFile(join(shellRoot, 'src', 'main.ts'), 'utf8'),
        readFile(join(shellRoot, 'electron-builder.yml'), 'utf8'),
      ]);

      const iconPath = join(shellRoot, 'build', 'icon.ico');
      await expect(access(iconPath)).resolves.toBeUndefined();
      await expect(access(join(workspaceRoot, 'assets', 'brand', 'novus-atelier-icon.png'))).resolves.toBeUndefined();
      const frames = parsePngBackedIco(await readFile(iconPath));
      for (const size of requiredFrameSizes) {
        expect(frames).toContainEqual({ height: size, width: size });
      }
      expect(mainSource).toContain('const appIconPath = app.isPackaged');
      expect(mainSource).toContain('icon: appIconPath');
      expect(builderConfig).toMatch(/buildResources:\s+build/u);
      expect(builderConfig).toMatch(/win:\s*\r?\n\s+icon:\s+icon\.ico/u);
      expect(builderConfig).toMatch(/from:\s+build\/icon\.ico\s*\r?\n\s+to:\s+icon\.ico/u);
    });
  }
});

function readPngDimensions(buffer: Buffer): { readonly height: number; readonly width: number } {
  expect(buffer.subarray(0, pngSignature.length)).toEqual(pngSignature);
  expect(buffer.subarray(12, 16).toString('ascii')).toBe('IHDR');
  return {
    height: buffer.readUInt32BE(20),
    width: buffer.readUInt32BE(16),
  };
}

function parsePngBackedIco(buffer: Buffer): Array<{ readonly height: number; readonly width: number }> {
  expect(buffer.readUInt16LE(0)).toBe(0);
  expect(buffer.readUInt16LE(2)).toBe(1);
  const entryCount = buffer.readUInt16LE(4);
  expect(entryCount).toBeGreaterThanOrEqual(requiredFrameSizes.length);

  return Array.from({ length: entryCount }, (_, index) => {
    const entryOffset = 6 + index * 16;
    const encodedWidth = buffer.readUInt8(entryOffset);
    const encodedHeight = buffer.readUInt8(entryOffset + 1);
    const width = encodedWidth === 0 ? 256 : encodedWidth;
    const height = encodedHeight === 0 ? 256 : encodedHeight;
    const imageSize = buffer.readUInt32LE(entryOffset + 8);
    const imageOffset = buffer.readUInt32LE(entryOffset + 12);
    expect(buffer.subarray(imageOffset, imageOffset + pngSignature.length)).toEqual(pngSignature);
    expect(readPngDimensions(buffer.subarray(imageOffset, imageOffset + imageSize))).toEqual({ height, width });
    expect(imageOffset + imageSize).toBeLessThanOrEqual(buffer.length);
    return { height, width };
  });
}

interface HashEntry {
  readonly path: string;
  readonly sha256: string;
}

interface IconManifest {
  readonly schemaVersion: 1;
  readonly source: HashEntry;
  readonly generator: HashEntry;
  readonly outputs: readonly HashEntry[];
}

async function expectHashEntry(entry: HashEntry): Promise<void> {
  const buffer = await readFile(join(workspaceRoot, ...entry.path.split('/')));
  expect(createHash('sha256').update(buffer).digest('hex')).toBe(entry.sha256);
}

async function expectTextHashEntry(entry: HashEntry): Promise<void> {
  const source = await readFile(join(workspaceRoot, ...entry.path.split('/')), 'utf8');
  expect(createHash('sha256').update(source.replace(/\r\n/g, '\n')).digest('hex')).toBe(entry.sha256);
}
