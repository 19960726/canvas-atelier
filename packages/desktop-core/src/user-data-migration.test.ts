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
    await writeFile(join(legacyRoot, 'provider-active.json'), '{"activeProvider":"relayme"}', 'utf8');
    await writeFile(join(legacyRoot, 'provider-credentials.json'), 'legacy-comfly', 'utf8');
    await writeFile(join(legacyRoot, 'provider-configuration.json'), 'legacy-comfly-config', 'utf8');
    await writeFile(join(legacyRoot, 'providers', 'relayme', 'provider-credentials.json'), 'legacy-relayme', 'utf8');
    await writeFile(join(stableRoot, 'provider-credentials.json'), 'current-comfly', 'utf8');

    const result = await migrateLegacyProviderData({ stableRoot, legacyRoots: [legacyRoot] });

    expect(result.copied).toEqual([
      'provider-active.json',
      'provider-configuration.json',
      'providers/relayme/provider-credentials.json',
    ]);
    expect(await readFile(join(stableRoot, 'provider-active.json'), 'utf8')).toBe('{"activeProvider":"relayme"}');
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

  it('migrates generation history when the stable product root is new', async () => {
    const root = await mkdtemp(join(tmpdir(), 'canvasforge-user-data-history-'));
    temporaryRoots.push(root);
    const stableRoot = join(root, 'Canvas Atelier');
    const legacyRoot = join(root, 'CanvasForge');
    await mkdir(stableRoot, { recursive: true });
    await mkdir(join(legacyRoot, 'generation-history', 'originals'), { recursive: true });
    await mkdir(join(legacyRoot, 'generation-history', 'recovery'), { recursive: true });
    await writeFile(
      join(legacyRoot, 'generation-history', '.novus-generation-history-root.json'),
      '{"kind":"novus-generation-history","schemaVersion":1}\n',
      'utf8',
    );
    await writeFile(
      join(legacyRoot, 'generation-history', 'history.index.json'),
      '{"schemaVersion":1,"revision":0,"records":[],"operations":[],"payloadSha256":""}\n',
      'utf8',
    );
    await writeFile(join(legacyRoot, 'generation-history', 'originals', 'legacy.png'), 'legacy-history', 'utf8');

    const result = await migrateLegacyUserData({ stableRoot, legacyRoots: [legacyRoot] });

    expect(result.copied).toContain('generation-history');
    await expect(readFile(join(stableRoot, 'generation-history', 'originals', 'legacy.png'), 'utf8'))
      .resolves.toBe('legacy-history');
    await expect(readFile(join(stableRoot, 'generation-history', '.novus-generation-history-root.json'), 'utf8'))
      .resolves.toContain('novus-generation-history');
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

  it('merges legacy recent projects when a stable recent-project index already exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'canvasforge-user-data-merge-index-'));
    temporaryRoots.push(root);
    const stableRoot = join(root, 'Canvas Atelier');
    const legacyRoot = join(root, 'CanvasForge');
    const stableProjectRoot = join(stableRoot, 'projects', 'stable.novus-project');
    const legacyProjectRoot = join(legacyRoot, 'projects', 'legacy.novus-project');
    await mkdir(stableProjectRoot, { recursive: true });
    await mkdir(legacyProjectRoot, { recursive: true });
    await writeFile(join(stableProjectRoot, 'project.novus.json'), JSON.stringify({ projectId: 'stable-id' }), 'utf8');
    await writeFile(join(legacyProjectRoot, 'project.novus.json'), JSON.stringify({ projectId: 'legacy-id' }), 'utf8');
    const entry = (projectId: string, displayName: string, projectRoot: string) => ({
      recentProjectId: createRecentProjectId(projectRoot),
      projectId,
      displayName,
      lastOpenedAt: '2026-09-10T08:00:00.000Z',
      lastSavedAt: '2026-09-10T08:00:00.000Z',
      root: projectRoot,
      nodeCount: 1,
      imageCount: 0,
      videoCount: 0,
    });
    await writeFile(join(stableRoot, 'recent-projects.index.json'), JSON.stringify({
      schemaVersion: 1,
      entries: [entry('stable-id', 'Stable project', stableProjectRoot)],
    }), 'utf8');
    await writeFile(join(legacyRoot, 'recent-projects.index.json'), JSON.stringify({
      schemaVersion: 1,
      entries: [entry('legacy-id', 'Legacy project', legacyProjectRoot)],
    }), 'utf8');

    await migrateLegacyUserData({ stableRoot, legacyRoots: [legacyRoot] });

    const projects = await new RecentProjectStore({ appDataRoot: stableRoot }).list();
    expect(projects).toEqual(expect.arrayContaining([
      expect.objectContaining({ availability: 'available', projectId: 'stable-id' }),
      expect.objectContaining({ availability: 'available', projectId: 'legacy-id' }),
    ]));
    expect(projects).toHaveLength(2);
  });

  it('replaces an unavailable stable duplicate with the matching available legacy project', async () => {
    const root = await mkdtemp(join(tmpdir(), 'canvasforge-user-data-recover-duplicate-'));
    temporaryRoots.push(root);
    const stableRoot = join(root, 'Canvas Atelier');
    const legacyRoot = join(root, 'CanvasForge');
    const staleProjectRoot = join(root, 'moved-away.novus-project');
    const legacyProjectRoot = join(legacyRoot, 'projects', 'recovered.novus-project');
    const recoveredProjectRoot = join(stableRoot, 'projects', 'recovered.novus-project');
    await mkdir(stableRoot, { recursive: true });
    await mkdir(legacyProjectRoot, { recursive: true });
    await writeFile(join(legacyProjectRoot, 'project.novus.json'), JSON.stringify({ projectId: 'recover-id' }), 'utf8');
    const entry = (projectRoot: string, displayName: string) => ({
      recentProjectId: createRecentProjectId(projectRoot),
      projectId: 'recover-id',
      displayName,
      lastOpenedAt: '2026-09-10T08:00:00.000Z',
      lastSavedAt: '2026-09-10T08:00:00.000Z',
      root: projectRoot,
      nodeCount: 2,
      imageCount: 1,
      videoCount: 0,
    });
    await writeFile(join(stableRoot, 'recent-projects.index.json'), JSON.stringify({
      schemaVersion: 1,
      entries: [entry(staleProjectRoot, 'Unavailable copy')],
    }), 'utf8');
    await writeFile(join(legacyRoot, 'recent-projects.index.json'), JSON.stringify({
      schemaVersion: 1,
      entries: [entry(legacyProjectRoot, 'Recovered copy')],
    }), 'utf8');

    await migrateLegacyUserData({ stableRoot, legacyRoots: [legacyRoot] });

    const projects = await new RecentProjectStore({ appDataRoot: stableRoot }).list();
    expect(projects).toEqual([
      expect.objectContaining({
        availability: 'available',
        projectId: 'recover-id',
        displayName: 'Recovered copy',
        recentProjectId: createRecentProjectId(recoveredProjectRoot),
      }),
    ]);
  });
});
