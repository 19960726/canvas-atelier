import { parseCanvasProject, type CanvasProject } from '@agent-canvas/domain';

export const PROJECT_STORAGE_KEY = 'novus-atelier:current-project:v1';
export interface PersistedProjectSnapshot {
  id: string;
  project: CanvasProject;
}

export interface PersistedProjectBundle {
  schemaVersion: 2;
  current: CanvasProject;
  snapshots: PersistedProjectSnapshot[];
}

export function loadPersistedProjectBundle(storage = getStorage()): PersistedProjectBundle | null {
  if (!storage) return null;
  const raw = storage.getItem(PROJECT_STORAGE_KEY);
  if (!raw) return null;
  try {
    const input = JSON.parse(raw) as Partial<PersistedProjectBundle>;
    if (![1, 2].includes(input.schemaVersion as number) || !input.current || !Array.isArray(input.snapshots)) return null;
    const current = parseCanvasProject(input.current);
    const snapshots = input.snapshots.flatMap((snapshot) => {
      try {
        return [{ id: requireId(snapshot.id), project: parseCanvasProject(snapshot.project) }];
      } catch {
        return [];
      }
    });
    return { schemaVersion: 2, current, snapshots };
  } catch {
    return null;
  }
}

export function persistProjectTransition(
  before: CanvasProject,
  after: CanvasProject,
  snapshotIds: { beforeId: string; afterId: string },
  storage = getStorage(),
): boolean {
  if (!storage) return false;
  try {
    const existing = loadPersistedProjectBundle(storage);
    const snapshots = existing?.current.id === after.id ? existing.snapshots : [];
    const nextSnapshots = [
      ...snapshots.filter((snapshot) => snapshot.id !== snapshotIds.beforeId && snapshot.id !== snapshotIds.afterId),
      { id: snapshotIds.beforeId, project: parseCanvasProject(before) },
      { id: snapshotIds.afterId, project: parseCanvasProject(after) },
    ];
    const bundle: PersistedProjectBundle = {
      schemaVersion: 2,
      current: parseCanvasProject(after),
      snapshots: nextSnapshots,
    };
    storage.setItem(PROJECT_STORAGE_KEY, JSON.stringify(bundle));
    return true;
  } catch {
    return false;
  }
}

export function persistCurrentProject(project: CanvasProject, storage = getStorage()): boolean {
  if (!storage) return false;
  try {
    const current = parseCanvasProject(project);
    const existing = loadPersistedProjectBundle(storage);
    const bundle: PersistedProjectBundle = {
      schemaVersion: 2,
      current,
      snapshots: existing?.current.id === current.id ? existing.snapshots : [],
    };
    storage.setItem(PROJECT_STORAGE_KEY, JSON.stringify(bundle));
    return true;
  } catch {
    return false;
  }
}

function getStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function requireId(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error('invalid snapshot id');
  return value;
}