import { render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createStarterProject,
  replaceProjectPersistenceClientForTests,
  resetAppStoreForTests,
  useAppStore,
} from './app-store';
import type { ProjectPersistenceClient } from './desktop-persistence';
import { App, resetAppHydrationForTests } from './App';

describe('App persistence hydration', () => {
  beforeEach(() => {
    delete window.novusDesktop;
    localStorage.clear();
    resetAppHydrationForTests();
    replaceProjectPersistenceClientForTests(createHydrationClient());
    resetAppStoreForTests();
  });

  it('hydrates the renderer from the persistence client on startup', async () => {
    const desktopProject = { ...createStarterProject(), name: 'Desktop Hydrated Project' };
    const hydrate = vi.fn(async () => ({
      availableSnapshotIds: ['desktop-after'],
      mode: 'desktop' as const,
      project: desktopProject,
      revision: 8,
      saveStatus: 'saved' as const,
    }));
    replaceProjectPersistenceClientForTests(createHydrationClient({ hydrate }));

    render(<App />);

    await waitFor(() => expect(hydrate).toHaveBeenCalledTimes(1));
    expect(useAppStore.getState()).toMatchObject({
      availableSnapshotIds: ['desktop-after'],
      desktopRevision: 8,
      persistenceMode: 'desktop',
      project: { name: 'Desktop Hydrated Project' },
      saveStatus: 'saved',
    });
    expect(screen.getByText('Desktop Hydrated Project')).toBeInTheDocument();
  });
});

function createHydrationClient(overrides: Partial<ProjectPersistenceClient> = {}): ProjectPersistenceClient {
  return {
    close: overrides.close ?? (async () => {}),
    commit: overrides.commit ?? (async ({ nextProject }) => ({
      ok: true,
      project: nextProject,
      revision: 1,
    })),
    hydrate: overrides.hydrate ?? (async () => ({
      availableSnapshotIds: [],
      mode: 'browser',
      project: createStarterProject(),
      revision: 0,
      saveStatus: 'pending',
    })),
    restore: overrides.restore ?? (async () => ({
      availableSnapshotIds: [],
      project: createStarterProject(),
      revision: 0,
      saveStatus: 'saved',
    })),
    stablePoint: overrides.stablePoint ?? (async () => ({
      availableSnapshotIds: [],
      project: createStarterProject(),
      revision: 0,
    })),
  };
}
