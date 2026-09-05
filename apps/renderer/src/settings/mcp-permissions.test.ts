import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_MCP_PERMISSION_FLAGS } from '@agent-canvas/domain';
import {
  MCP_PERMISSION_STORAGE_KEY,
  readMcpPermissions,
  subscribeMcpPermissions,
  updateMcpPermissions,
} from './mcp-permissions';

describe('MCP permission preferences', () => {
  beforeEach(() => {
    localStorage.removeItem(MCP_PERMISSION_STORAGE_KEY);
  });

  afterEach(() => {
    localStorage.removeItem(MCP_PERMISSION_STORAGE_KEY);
  });

  it('uses safe defaults unless localStorage contains the exact boolean permission shape', () => {
    expect(readMcpPermissions()).toEqual(DEFAULT_MCP_PERMISSION_FLAGS);
    expect(readMcpPermissions()).not.toBe(DEFAULT_MCP_PERMISSION_FLAGS);

    for (const invalid of [
      '{broken',
      'null',
      '[]',
      JSON.stringify({ ...DEFAULT_MCP_PERMISSION_FLAGS, readCanvas: 'yes' }),
      JSON.stringify({ ...DEFAULT_MCP_PERMISSION_FLAGS, unexpected: true }),
      JSON.stringify({ readCanvas: true }),
    ]) {
      localStorage.setItem(MCP_PERMISSION_STORAGE_KEY, invalid);
      expect(readMcpPermissions()).toEqual(DEFAULT_MCP_PERMISSION_FLAGS);
    }

    const persisted = { ...DEFAULT_MCP_PERMISSION_FLAGS, externalFileAccess: true };
    localStorage.setItem(MCP_PERMISSION_STORAGE_KEY, JSON.stringify(persisted));
    expect(readMcpPermissions()).toEqual(persisted);
  });

  it('persists validated updates and notifies same-window subscribers', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeMcpPermissions(listener);

    const next = updateMcpPermissions((current) => ({
      ...current,
      executeAiGeneration: false,
    }));

    expect(next.executeAiGeneration).toBe(false);
    expect(readMcpPermissions()).toEqual(next);
    expect(JSON.parse(localStorage.getItem(MCP_PERMISSION_STORAGE_KEY) ?? 'null')).toEqual(next);
    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenLastCalledWith(next);

    unsubscribe();
    updateMcpPermissions({ readCanvas: false });
    expect(listener).toHaveBeenCalledOnce();
  });

  it('rejects invalid runtime patches without overwriting the last valid permissions', () => {
    const saved = updateMcpPermissions({ dangerousOperations: true });

    expect(() => updateMcpPermissions({ unknownPermission: true } as never)).toThrow(TypeError);
    expect(() => updateMcpPermissions({ readCanvas: 'yes' } as never)).toThrow(TypeError);
    expect(readMcpPermissions()).toEqual(saved);
  });

  it('notifies subscribers when another renderer context changes the storage entry', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeMcpPermissions(listener);
    const external = { ...DEFAULT_MCP_PERMISSION_FLAGS, editCanvas: false };
    localStorage.setItem(MCP_PERMISSION_STORAGE_KEY, JSON.stringify(external));

    window.dispatchEvent(new StorageEvent('storage', {
      key: MCP_PERMISSION_STORAGE_KEY,
      newValue: JSON.stringify(external),
      storageArea: localStorage,
    }));

    expect(listener).toHaveBeenCalledWith(external);
    unsubscribe();
  });
});
