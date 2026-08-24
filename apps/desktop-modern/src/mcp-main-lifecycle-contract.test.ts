import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const entryPoints = [
  'apps/desktop-modern/src/main.ts',
  'apps/desktop-legacy/src/main.ts',
] as const;

describe('desktop MCP lifecycle contract', () => {
  for (const entryPoint of entryPoints) {
    it(`${entryPoint} starts the authenticated runtime after the renderer and stops it during shutdown`, async () => {
      const source = await readFile(join(process.cwd(), entryPoint), 'utf8');
      expect(source).toContain('createMcpRendererBridge');
      expect(source).toContain('createMcpRuntimeService');
      expect(source).toContain('createMcpClientConfigManager');
      expect(source).toContain('createMcpStdioHealthCheck');
      expect(source).toContain('healthCheck: createMcpStdioHealthCheck');
      expect(source).toContain('registerMcpClientConfigIpc');
      expect(source).toContain("join(app.getPath('home'), '.codex', 'config.toml')");
      expect(source).toContain("join(app.getPath('home'), '.workbuddy', 'mcp.json')");
      expect(source).toContain('mcpClientConfigRegistration?.dispose()');
      expect(source).toContain("join(app.getPath('appData'), 'CanvasForge', 'mcp', 'runtime-v1.json')");
      expect(source).toMatch(/await createMainWindow\(\);\s*await startMcpRuntime\(\);/u);
      expect(source).toMatch(/async function stopMcpRuntime\(\): Promise<void>/u);
      expect(source).toMatch(/async function runCoordinatedShutdown[\s\S]*await stopMcpRuntime\(\);/u);
      expect(source).toMatch(/async function handleStartupFailure[\s\S]*await stopMcpRuntime\(\);/u);
    });
  }
});