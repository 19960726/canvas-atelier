import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { RecentProjectStore } from './recent-project-store';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe('recent project store', () => {
  it('persists safe summaries, deduplicates by project identity, and sorts most recently opened first', async () => {
    const fixture = await createFixture();
    const firstRoot = await createProjectRoot(fixture.workspaceRoot, 'First Project', 'project-first', true);
    const secondRoot = await createProjectRoot(fixture.workspaceRoot, 'Second Project', 'project-second', true);
    const movedFirstRoot = await createProjectRoot(fixture.workspaceRoot, 'First Project Moved', 'project-first', false);
    const store = new RecentProjectStore({ appDataRoot: fixture.appDataRoot });

    await store.upsert({
      root: firstRoot,
      projectId: 'project-first',
      displayName: 'First Project',
      lastOpenedAt: '2026-08-08T08:00:00.000Z',
      lastSavedAt: '2026-08-08T08:05:00.000Z',
      nodeCount: 3,
      imageCount: 2,
      videoCount: 1,
    });
    await store.upsert({
      root: secondRoot,
      projectId: 'project-second',
      displayName: 'Second Project',
      lastOpenedAt: '2026-08-09T08:00:00.000Z',
      lastSavedAt: '2026-08-09T08:05:00.000Z',
      nodeCount: 8,
      imageCount: 4,
      videoCount: 2,
    });
    await store.upsert({
      root: movedFirstRoot,
      projectId: 'project-first',
      displayName: 'First Project Moved',
      lastOpenedAt: '2026-08-10T08:00:00.000Z',
      lastSavedAt: '2026-08-10T08:05:00.000Z',
      nodeCount: 5,
      imageCount: 3,
      videoCount: 2,
    });

    const summaries = await new RecentProjectStore({ appDataRoot: fixture.appDataRoot }).list();

    expect(summaries.map((summary) => summary.projectId)).toEqual(['project-first', 'project-second']);
    expect(summaries[0]).toMatchObject({
      displayName: 'First Project Moved',
      availability: 'available',
      nodeCount: 5,
      imageCount: 3,
      videoCount: 2,
      previewUrl: null,
    });
    expect(summaries[1]?.previewUrl).toMatch(/^novus-recent-project:\/\/[a-z0-9_-]+\/preview$/u);
    await expect(store.resolvePreviewPath(summaries[1]!.recentProjectId))
      .resolves.toBe(join(secondRoot, 'preview.png'));
    expect(summaries.every((summary) => /^recent_[a-f0-9]{24}$/u.test(summary.recentProjectId))).toBe(true);

    const publicPayload = JSON.stringify(summaries);
    expect(publicPayload).not.toContain(fixture.workspaceRoot);
    expect(publicPayload).not.toContain('project.novus.json');
    expect(publicPayload).not.toMatch(/[A-Za-z]:\\/u);

    const internalIndex = JSON.parse(
      await readFile(join(fixture.appDataRoot, 'recent-projects.index.json'), 'utf8'),
    ) as { entries: Array<{ root: string }> };
    expect(internalIndex.entries.map((entry) => entry.root)).toContain(movedFirstRoot);
    expect(internalIndex.entries.map((entry) => entry.root)).not.toContain(firstRoot);
  });

  it('marks missing projects without deleting the index and removes only the recent entry', async () => {
    const fixture = await createFixture();
    const projectRoot = await createProjectRoot(fixture.workspaceRoot, 'Missing Later', 'project-missing', true);
    const store = new RecentProjectStore({ appDataRoot: fixture.appDataRoot });
    await store.upsert({
      root: projectRoot,
      projectId: 'project-missing',
      displayName: 'Missing Later',
      lastOpenedAt: '2026-08-10T09:00:00.000Z',
      lastSavedAt: '2026-08-10T09:01:00.000Z',
      nodeCount: 1,
      imageCount: 1,
      videoCount: 0,
    });
    await rm(projectRoot, { force: true, recursive: true });

    const [missing] = await store.list();
    expect(missing).toMatchObject({ availability: 'missing', previewUrl: null });
    expect(await store.resolveRoot(missing!.recentProjectId)).toBeNull();

    const remaining = await store.remove(missing!.recentProjectId);
    expect(remaining).toEqual([]);
    expect(await readFile(join(fixture.appDataRoot, 'recent-projects.index.json'), 'utf8')).not.toContain('project-missing');
  });

  it('removes recent entries without deleting managed or external project directories', async () => {
    const fixture = await createFixture();
    const managedRoot = await createProjectRoot(
      join(fixture.appDataRoot, 'projects'),
      'Managed Canvas',
      'project-managed',
      false,
    );
    const externalRoot = await createProjectRoot(
      fixture.workspaceRoot,
      'External Canvas',
      'project-external',
      false,
    );
    const store = new RecentProjectStore({ appDataRoot: fixture.appDataRoot });

    await store.upsert(createEntry(managedRoot, 'project-managed', 'Managed Canvas'));
    await store.upsert(createEntry(externalRoot, 'project-external', 'External Canvas'));
    const summaries = await store.list();

    await store.remove(summaries.find((item) => item.projectId === 'project-managed')!.recentProjectId);
    await expect(access(managedRoot)).resolves.toBeUndefined();

    await store.remove(summaries.find((item) => item.projectId === 'project-external')!.recentProjectId);
    await expect(access(externalRoot)).resolves.toBeUndefined();
    await expect(store.list()).resolves.toEqual([]);
  });
});

function createEntry(root: string, projectId: string, displayName: string) {
  return {
    root,
    projectId,
    displayName,
    lastOpenedAt: '2026-08-10T09:00:00.000Z',
    lastSavedAt: '2026-08-10T09:01:00.000Z',
    nodeCount: 1,
    imageCount: 0,
    videoCount: 0,
  };
}

async function createFixture() {
  const tempRoot = await mkdtemp(join(tmpdir(), 'novus-recent-project-store-'));
  tempRoots.push(tempRoot);
  const appDataRoot = join(tempRoot, 'app-data');
  const workspaceRoot = join(tempRoot, 'projects');
  await mkdir(appDataRoot, { recursive: true });
  await mkdir(workspaceRoot, { recursive: true });
  return { appDataRoot, workspaceRoot };
}

async function createProjectRoot(
  workspaceRoot: string,
  displayName: string,
  projectId: string,
  withPreview: boolean,
): Promise<string> {
  const root = join(workspaceRoot, `${displayName}.novus-project`);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'project.novus.json'), JSON.stringify({ projectId, projectName: displayName }), 'utf8');
  if (withPreview) await writeFile(join(root, 'preview.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  return root;
}
