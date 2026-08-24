import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  migrateLegacyUserData,
  migrateLegacyProviderData,
  resolveLegacyUserDataRoots,
  resolveStableUserDataRoot,
} from './user-data-migration.js';
import { createRecentProjectId } from './recent-project-store.js';
import { RecentProjectStore } from './recent-project-store.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('stable desktop user data', () => {
  it('uses one product-independent directory for reinstall and upgrades', () => {
    expect(resolveStableUserDataRoot('C:\\Users\\demo\\AppData\\Roaming'))
      .toBe('C:\\Users\\demo\\AppData\\Roaming\\Canvas Atelier');

    expect(resolveLegacyUserDataRoots('C:\\Users\\demo\\AppData\\Roaming', 'C:\\old-product'))
      .toEqual([
        'C:\\old-product',
        'C:\\Users\\demo\\AppData\\Roaming\\CanvasForge',
        'C:\\Users\\demo\\AppData\\Roaming\\@agent-canvas\\desktop-modern',
        'C:\\Users\\demo\\AppData\\Roaming\\@agent-canvas\\desktop-legacy',
      ]);
  });

  it('migrates both provider credentials without overwriting an existing stable credential', async () => {
    const root = await mkdtemp(join(tmpdir(), 'canvasforge-user-data-'));
    temporaryRoots.push(root);
    const stableRoot = join(root, 'CanvasForge');
    const legacyRoot = join(root, 'Canvas Atelier');

    await mkdir(join(legacyRoot, 'providers', 'relayme'), { recursive: true });
    await mkdir(stableRoot, { recursive: true });
    await writeFile(join(legacyRoot, 'provider-credentials.json'), 'legacy-comfly', 'utf8');
    await writeFile(join(legacyRoot, 'provider-configuration.json'), 'legacy-comfly-config', 'utf8');
    await writeFile(join(legacyRoot, 'providers', 'relayme', 'provider-credentials.json'), 'legacy-relayme', 'utf8');
    await writeFile(join(stableRoot, 'provider-credentials.json'), 'current-comfly', 'utf8');

    const result = await migrateLegacyProviderData({ stableRoot, legacyRoots: [legacyRoot] });

    expect(result.copied).toEqual([
      'provider-configuration.json',
      'providers/relayme/provider-credentials.json',
    ]);
    expect(await readFile(join(stableRoot, 'provider-credentials.json'), 'utf8')).toBe('current-comfly');
    expect(await readFile(join(stableRoot, 'provider-configuration.json'), 'utf8')).toBe('legacy-comfly-config');
    expect(await readFile(join(stableRoot, 'providers', 'relayme', 'provider-credentials.json'), 'utf8')).toBe('legacy-relayme');
  });

  it('migrates the recent-project index and managed projects without overwriting stable data', async () => {
    const root = await mkdtemp(join(tmpdir(), 'canvasforge-user-data-'));
    temporaryRoots.push(root);
    const stableRoot = join(root, 'CanvasForge');
    const legacyRoot = join(root, 'Canvas Atelier');

    await mkdir(join(legacyRoot, 'projects', 'legacy-project.novus-project', 'snapshots'), { recursive: true });
    await mkdir(join(stableRoot, 'projects', 'stable-project.novus-project'), { recursive: true });
    await writeFile(join(legacyRoot, 'recent-projects.index.json'), '{"entries":["legacy"]}', 'utf8');
    await writeFile(
      join(legacyRoot, 'projects', 'legacy-project.novus-project', 'project.json'),
      '{"name":"Legacy project"}',
      'utf8',
    );
    await writeFile(
      join(legacyRoot, 'projects', 'legacy-project.novus-project', 'snapshots', 'stable.json'),
      '{"revision":3}',
      'utf8',
    );
    await writeFile(join(stableRoot, 'recent-projects.index.json'), '{"entries":["stable"]}', 'utf8');
    await writeFile(
      join(stableRoot, 'projects', 'stable-project.novus-project', 'project.json'),
      '{"name":"Stable project"}',
      'utf8',
    );

    const result = await migrateLegacyUserData({ stableRoot, legacyRoots: [legacyRoot] });

    expect(result.copied).toContain('projects/legacy-project.novus-project');
    expect(result.copied).not.toContain('recent-projects.index.json');
    expect(await readFile(join(stableRoot, 'recent-projects.index.json'), 'utf8')).toBe('{"entries":["stable"]}');
    expect(await readFile(
      join(stableRoot, 'projects', 'legacy-project.novus-project', 'project.json'),
      'utf8',
    )).toBe('{"name":"Legacy project"}');
    expect(await readFile(
      join(stableRoot, 'projects', 'legacy-project.novus-project', 'snapshots', 'stable.json'),
      'utf8',
    )).toBe('{"revision":3}');
    expect(await readFile(
      join(stableRoot, 'projects', 'stable-project.novus-project', 'project.json'),
      'utf8',
    )).toBe('{"name":"Stable project"}');
  });

  it('rebases recent-project roots to the stable project directory after migration', async () => {
    const root = await mkdtemp(join(tmpdir(), 'canvasforge-user-data-rebase-'));
    temporaryRoots.push(root);
    const stableRoot = join(root, 'CanvasForge');
    const legacyRoot = join(root, '@agent-canvas', 'desktop-modern');
    const projectName = 'legacy-project.novus-project';
    const legacyProjectRoot = join(legacyRoot, 'projects', projectName);
    const stableProjectRoot = join(stableRoot, 'projects', projectName);
    await mkdir(legacyProjectRoot, { recursive: true });
    await writeFile(join(legacyProjectRoot, 'project.novus.json'), JSON.stringify({ projectId: 'legacy-id' }), 'utf8');
    await mkdir(stableRoot, { recursive: true });
    await writeFile(join(stableRoot, 'recent-projects.index.json'), JSON.stringify({
      schemaVersion: 1,
      entries: [{
        recentProjectId: 'recent_aaaaaaaaaaaaaaaaaaaaaaaa',
        projectId: 'legacy-id',
        displayName: 'Legacy project',
        lastOpenedAt: '2026-08-13T00:00:00.000Z',
        lastSavedAt: '2026-08-13T00:00:00.000Z',
        root: legacyProjectRoot,
        nodeCount: 1,
        imageCount: 0,
        videoCount: 0,
      }],
    }), 'utf8');

    await migrateLegacyUserData({ stableRoot, legacyRoots: [legacyRoot] });

    const index = JSON.parse(await readFile(join(stableRoot, 'recent-projects.index.json'), 'utf8')) as {
      entries: Array<{ recentProjectId: string; root: string }>;
    };
    expect(index.entries[0]?.root).toBe(stableProjectRoot);
    expect(index.entries[0]?.recentProjectId).toBe(createRecentProjectId(stableProjectRoot));
    await expect(new RecentProjectStore({ appDataRoot: stableRoot }).list()).resolves.toEqual([
      expect.objectContaining({ availability: 'available', projectId: 'legacy-id' }),
    ]);
  });
});
