import { getCanvasModuleDefinition, type CanvasModuleType } from '@agent-canvas/domain';

const MODULE_PREFERENCES_KEY = 'novus-atelier:module-preferences:v1';
const MAX_RECENTS = 8;

export interface ModulePreferences {
  readonly favorites: readonly CanvasModuleType[];
  readonly recents: readonly CanvasModuleType[];
}

export function readModulePreferences(storage = getStorage()): ModulePreferences {
  if (storage === null) return { favorites: [], recents: [] };
  try {
    const raw = storage.getItem(MODULE_PREFERENCES_KEY);
    if (raw === null) return { favorites: [], recents: [] };
    const parsed = JSON.parse(raw) as { favorites?: unknown; recents?: unknown };
    return {
      favorites: readModuleTypes(parsed.favorites),
      recents: readModuleTypes(parsed.recents).slice(0, MAX_RECENTS),
    };
  } catch {
    return { favorites: [], recents: [] };
  }
}
export function toggleModuleFavorite(type: CanvasModuleType, storage = getStorage()): ModulePreferences {
  const current = readModulePreferences(storage);
  const favorites = current.favorites.includes(type)
    ? current.favorites.filter((candidate) => candidate !== type)
    : [...current.favorites, type];
  return writeModulePreferences({ favorites, recents: current.recents }, storage);
}

export function recordRecentModule(type: CanvasModuleType, storage = getStorage()): ModulePreferences {
  const current = readModulePreferences(storage);
  return writeModulePreferences({
    favorites: current.favorites,
    recents: [type, ...current.recents.filter((candidate) => candidate !== type)].slice(0, MAX_RECENTS),
  }, storage);
}

function writeModulePreferences(preferences: ModulePreferences, storage: Storage | null): ModulePreferences {
  const normalized = {
    favorites: [...new Set(preferences.favorites)],
    recents: [...new Set(preferences.recents)].slice(0, MAX_RECENTS),
  } satisfies ModulePreferences;
  try {
    storage?.setItem(MODULE_PREFERENCES_KEY, JSON.stringify(normalized));
  } catch {
    // Device settings are best-effort and never block canvas work.
  }
  return normalized;
}

function readModuleTypes(value: unknown): CanvasModuleType[] {
  if (!Array.isArray(value)) return [];
  const result: CanvasModuleType[] = [];
  for (const candidate of value) {
    if (typeof candidate !== 'string') continue;
    try {
      const type = getCanvasModuleDefinition(candidate as CanvasModuleType).type;
      if (!result.includes(type)) result.push(type);
    } catch {
      // Ignore stale or unrecognized device-local identifiers.
    }
  }
  return result;
}

function getStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}
