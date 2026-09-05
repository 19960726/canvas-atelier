import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveMcpRuntimeFilePath } from './runtime-path.js';

describe('Canvas Atelier MCP runtime discovery path', () => {
  it('uses the Canvas Atelier application data root when no explicit runtime path is provided', () => {
    expect(resolveMcpRuntimeFilePath({ APPDATA: 'C:\\Users\\demo\\AppData\\Roaming' })).toBe(
      join('C:\\Users\\demo\\AppData\\Roaming', 'Canvas Atelier', 'mcp', 'runtime-modern-v1.json'),
    );
  });

  it('keeps the legacy runtime environment override for installed-client compatibility', () => {
    expect(resolveMcpRuntimeFilePath({
      APPDATA: 'C:\\Users\\demo\\AppData\\Roaming',
      CANVASFORGE_MCP_RUNTIME_FILE: 'D:\\runtime\\runtime-modern-v1.json',
    })).toBe('D:\\runtime\\runtime-modern-v1.json');
  });

  it('never falls back to the legacy CanvasForge application data path', () => {
    expect(resolveMcpRuntimeFilePath({ APPDATA: 'C:\\Users\\demo\\AppData\\Roaming' })).not.toContain('CanvasForge');
  });
});
