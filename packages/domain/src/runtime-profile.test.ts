import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

interface RuntimeProfileShape {
  readonly id: 'modern' | 'legacy-win7';
  readonly thumbnailEdge: number;
  readonly disableShadowsWhileInteracting: boolean;
  readonly providerPollConcurrency: number;
  readonly imageDecodeConcurrency: number;
  readonly targetFps: number;
}

describe('runtime profile domain contract', () => {
  it('requires a dedicated runtime-profile module and index export for shell-safe profile lookup', async () => {
    const runtimeProfilePath = join(process.cwd(), 'packages/domain/src/runtime-profile.ts');
    const indexPath = join(process.cwd(), 'packages/domain/src/index.ts');
    const runtimeProfileExists = await fileExists(runtimeProfilePath);

    expect(runtimeProfileExists).toBe(true);
    if (!runtimeProfileExists) return;

    const source = await importModule<{ RUNTIME_PROFILES: Record<string, RuntimeProfileShape> }>(runtimeProfilePath);
    expect(Object.keys(source.RUNTIME_PROFILES).sort()).toEqual(['legacy-win7', 'modern']);

    const indexSource = await import('node:fs/promises').then(({ readFile }) => readFile(indexPath, 'utf8'));
    expect(indexSource).toContain("from './runtime-profile'");
  });

  it('uses 72px legacy thumbnails and 96px modern thumbnails with frozen readonly values for concurrency, fps, and interaction shadows', async () => {
    const runtimeProfilePath = join(process.cwd(), 'packages/domain/src/runtime-profile.ts');
    const runtimeProfileExists = await fileExists(runtimeProfilePath);

    expect(runtimeProfileExists).toBe(true);
    if (!runtimeProfileExists) return;

    const module = await importModule<{
      readonly RUNTIME_PROFILES: Readonly<Record<'modern' | 'legacy-win7', RuntimeProfileShape>>;
      readonly getRuntimeProfile: (id: 'modern' | 'legacy-win7') => RuntimeProfileShape;
    }>(runtimeProfilePath);
    const legacy = module.getRuntimeProfile('legacy-win7');
    const modern = module.getRuntimeProfile('modern');

    expect(Object.keys(module.RUNTIME_PROFILES).sort()).toEqual(['legacy-win7', 'modern']);
    expect(legacy).toBe(module.RUNTIME_PROFILES['legacy-win7']);
    expect(modern).toBe(module.RUNTIME_PROFILES.modern);
    expect(legacy).toMatchObject({
      id: 'legacy-win7',
      thumbnailEdge: 72,
      disableShadowsWhileInteracting: true,
      providerPollConcurrency: 2,
      imageDecodeConcurrency: 1,
      targetFps: 30,
    });
    expect(modern).toMatchObject({
      id: 'modern',
      thumbnailEdge: 96,
      disableShadowsWhileInteracting: false,
      providerPollConcurrency: 4,
      imageDecodeConcurrency: 2,
      targetFps: 60,
    });
    expect(Object.isFrozen(module.RUNTIME_PROFILES)).toBe(true);
    expect(Object.isFrozen(legacy)).toBe(true);
    expect(Object.isFrozen(modern)).toBe(true);
    expect(() => {
      (legacy as { id: string }).id = 'modern';
    }).toThrow(TypeError);
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

async function importModule<TModule>(path: string): Promise<TModule> {
  return import(pathToFileURL(path).href) as Promise<TModule>;
}
