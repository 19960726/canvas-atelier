import { beforeEach, describe, expect, it } from 'vitest';
import { createStarterProject } from './app-store';
import { PROJECT_STORAGE_KEY, loadPersistedProjectBundle } from './project-persistence';

describe('project persistence recovery', () => {
  beforeEach(() => localStorage.clear());

  it('recovers a valid current project even when an old snapshot is corrupt', () => {
    localStorage.setItem(PROJECT_STORAGE_KEY, JSON.stringify({
      schemaVersion: 1,
      current: createStarterProject(),
      snapshots: [{ id: 'broken-snapshot', project: { invalid: true } }],
    }));

    expect(loadPersistedProjectBundle()).toMatchObject({
      current: { id: 'local-project' },
      snapshots: [],
    });
  });
});