import { DEFAULT_MCP_PERMISSION_FLAGS, type McpPermissionFlags } from '@agent-canvas/domain';

export const MCP_PERMISSION_STORAGE_KEY = 'agent-canvas:mcp-permissions:v1';

export type McpPermissionUpdate = Partial<McpPermissionFlags>
  | ((current: McpPermissionFlags) => McpPermissionFlags);

type McpPermissionListener = (permissions: McpPermissionFlags) => void;
type McpPermissionStorage = Pick<Storage, 'getItem' | 'setItem'>;

const MCP_PERMISSION_KEYS = Object.freeze([
  'readCanvas',
  'editCanvas',
  'manageCanvas',
  'executeAiGeneration',
  'exportFiles',
  'externalFileAccess',
  'dangerousOperations',
] as const satisfies readonly (keyof McpPermissionFlags)[]);
const permissionKeySet = new Set<string>(MCP_PERMISSION_KEYS);
const listeners = new Set<McpPermissionListener>();
let storageListenerAttached = false;
let volatilePermissions: McpPermissionFlags | null = null;

export function readMcpPermissions(): McpPermissionFlags {
  const storage = resolveLocalStorage();
  if (storage === null) return clonePermissions(volatilePermissions ?? DEFAULT_MCP_PERMISSION_FLAGS);
  try {
    const raw = storage.getItem(MCP_PERMISSION_STORAGE_KEY);
    if (raw === null) return clonePermissions(DEFAULT_MCP_PERMISSION_FLAGS);
    return parsePersistedPermissions(JSON.parse(raw)) ?? clonePermissions(DEFAULT_MCP_PERMISSION_FLAGS);
  } catch {
    return clonePermissions(volatilePermissions ?? DEFAULT_MCP_PERMISSION_FLAGS);
  }
}

export function updateMcpPermissions(update: McpPermissionUpdate): McpPermissionFlags {
  const current = readMcpPermissions();
  const candidate = typeof update === 'function'
    ? update(clonePermissions(current))
    : applyPermissionPatch(current, update);
  const next = parsePersistedPermissions(candidate);
  if (next === null) throw new TypeError('MCP permissions must contain only the supported boolean flags');

  const storage = resolveLocalStorage();
  if (storage === null) {
    volatilePermissions = clonePermissions(next);
  } else {
    try {
      storage.setItem(MCP_PERMISSION_STORAGE_KEY, JSON.stringify(next));
      volatilePermissions = null;
    } catch {
      volatilePermissions = clonePermissions(next);
    }
  }
  notifyListeners(next);
  return clonePermissions(next);
}

export function subscribeMcpPermissions(listener: McpPermissionListener): () => void {
  listeners.add(listener);
  attachStorageListener();
  return () => {
    listeners.delete(listener);
    detachStorageListenerWhenIdle();
  };
}

function applyPermissionPatch(
  current: McpPermissionFlags,
  patch: Partial<McpPermissionFlags>,
): McpPermissionFlags {
  if (!isRecord(patch) || Object.keys(patch).some((key) => (
    !permissionKeySet.has(key) || typeof patch[key as keyof McpPermissionFlags] !== 'boolean'
  ))) {
    throw new TypeError('MCP permission patch contains an unsupported value');
  }
  return { ...current, ...patch };
}

function parsePersistedPermissions(value: unknown): McpPermissionFlags | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== MCP_PERMISSION_KEYS.length || keys.some((key) => !permissionKeySet.has(key))) return null;
  if (MCP_PERMISSION_KEYS.some((key) => typeof value[key] !== 'boolean')) return null;
  return {
    readCanvas: value.readCanvas as boolean,
    editCanvas: value.editCanvas as boolean,
    manageCanvas: value.manageCanvas as boolean,
    executeAiGeneration: value.executeAiGeneration as boolean,
    exportFiles: value.exportFiles as boolean,
    externalFileAccess: value.externalFileAccess as boolean,
    dangerousOperations: value.dangerousOperations as boolean,
  };
}

function clonePermissions(permissions: McpPermissionFlags): McpPermissionFlags {
  return { ...permissions };
}

function resolveLocalStorage(): McpPermissionStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function notifyListeners(permissions: McpPermissionFlags): void {
  for (const listener of listeners) listener(clonePermissions(permissions));
}

function onStorageChanged(event: StorageEvent): void {
  if (event.key !== MCP_PERMISSION_STORAGE_KEY) return;
  volatilePermissions = null;
  notifyListeners(readMcpPermissions());
}

function attachStorageListener(): void {
  if (storageListenerAttached || typeof window === 'undefined') return;
  window.addEventListener('storage', onStorageChanged);
  storageListenerAttached = true;
}

function detachStorageListenerWhenIdle(): void {
  if (!storageListenerAttached || listeners.size > 0 || typeof window === 'undefined') return;
  window.removeEventListener('storage', onStorageChanged);
  storageListenerAttached = false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
