import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { NodeFileSystem } from './file-system';
import { ProviderActiveStore } from './provider-active-store';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe('ProviderActiveStore', () => {
  it('returns the only safe default when the state file is missing', async () => {
    const root = await createRoot();
    const store = new ProviderActiveStore({ appDataRoot: root });

    await expect(store.getActiveProvider()).resolves.toEqual({ activeProvider: null });
  });

  it.each(['comfly', 'relayme', null] as const)(
    'persists and reloads the legal active provider value %s',
    async (activeProvider) => {
      const root = await createRoot();
      const store = new ProviderActiveStore({ appDataRoot: root });

      await expect(store.setActiveProvider(activeProvider)).resolves.toEqual({ activeProvider });
      await expect(store.getActiveProvider()).resolves.toEqual({ activeProvider });
      await expect(readFile(join(root, 'provider-active.json'), 'utf8'))
        .resolves.toBe(`${JSON.stringify({ activeProvider })}\n`);
    },
  );

  it.each([
    '{not-json',
    JSON.stringify({ activeProvider: 'unknown' }),
    JSON.stringify({ activeProvider: 'relayme', token: 'must-not-be-accepted' }),
  ])('falls back to null for an invalid persisted document', async (serialized) => {
    const root = await createRoot();
    await writeFile(join(root, 'provider-active.json'), serialized, 'utf8');
    const store = new ProviderActiveStore({ appDataRoot: root });

    await expect(store.getActiveProvider()).resolves.toEqual({ activeProvider: null });
  });

  it('commits through a same-directory exclusive temp file and atomic rename', async () => {
    const root = await createRoot();
    const fileSystem = new ObservedNodeFileSystem();
    const store = new ProviderActiveStore({ appDataRoot: root, fileSystem });

    await store.setActiveProvider('relayme');

    const targetPath = join(root, 'provider-active.json');
    expect(fileSystem.renames).toHaveLength(1);
    expect(fileSystem.renames[0]?.destination).toBe(targetPath);
    expect(dirname(fileSystem.renames[0]!.source)).toBe(root);
    expect(fileSystem.renames[0]!.source).toMatch(/\.provider-active\.json\.tmp-[a-f0-9]+$/u);
    expect(fileSystem.opens).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: fileSystem.renames[0]!.source, flags: 'wx' }),
    ]));
    const confinedPrefix = `${resolve(root)}${sep}`;
    expect(fileSystem.opens.every((entry) => resolve(entry.path).startsWith(confinedPrefix))).toBe(true);
  });
});

class ObservedNodeFileSystem extends NodeFileSystem {
  readonly opens: Array<{ readonly path: string; readonly flags: string }> = [];
  readonly renames: Array<{ readonly source: string; readonly destination: string }> = [];

  override async open(path: string, flags: string) {
    this.opens.push({ path, flags });
    return super.open(path, flags);
  }

  override async rename(source: string, destination: string) {
    this.renames.push({ source, destination });
    return super.rename(source, destination);
  }
}

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'provider-active-store-'));
  roots.push(root);
  return root;
}
