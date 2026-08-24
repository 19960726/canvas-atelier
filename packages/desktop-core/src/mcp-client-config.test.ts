import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMcpClientConfigManager } from './mcp-client-config';

describe('MCP client configuration manager', () => {
  let root: string;
  let codexPath: string;
  let workbuddyPath: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'canvasforge-mcp-config-'));
    codexPath = join(root, 'codex-config.toml');
    workbuddyPath = join(root, 'workbuddy-config.json');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  function createManager(healthCheck = vi.fn(async () => ({ connected: true, toolCount: 14 as const }))) {
    return createMcpClientConfigManager({
      clientPaths: { codex: codexPath, workbuddy: workbuddyPath },
      command: 'C:\\Program Files\\CanvasForge\\CanvasForge.exe',
      args: ['resources\\mcp\\canvasforge-mcp.cjs'],
      env: { ELECTRON_RUN_AS_NODE: '1' },
      now: () => new Date('2026-08-07T03:04:05.000Z'),
      healthCheck,
    });
  }

  it('merges and disconnects only the WorkBuddy canvasforge server while keeping unrelated entries', async () => {
    await writeFile(workbuddyPath, JSON.stringify({
      connectorProxy: { enabled: true },
      mcpServers: {
        figma: { url: 'https://figma.example.test/mcp' },
        existing: { command: 'existing.exe', args: ['--safe'] },
      },
      theme: 'dark',
    }, null, 2), 'utf8');
    const manager = createManager();

    const connected = await manager.connect('workbuddy');
    const merged = JSON.parse(await readFile(workbuddyPath, 'utf8'));
    expect(connected).toMatchObject({ client: 'workbuddy', state: 'connected', toolCount: 14 });
    expect(merged.connectorProxy).toEqual({ enabled: true });
    expect(merged.mcpServers.figma).toEqual({ url: 'https://figma.example.test/mcp' });
    expect(merged.mcpServers.existing).toEqual({ command: 'existing.exe', args: ['--safe'] });
    expect(merged.mcpServers.canvasforge).toEqual({
      command: 'C:\\Program Files\\CanvasForge\\CanvasForge.exe',
      args: ['resources\\mcp\\canvasforge-mcp.cjs'],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    });
    expect(await readdir(root)).toContain('workbuddy-config.json.canvasforge-backup-20260807-030405');

    await manager.disconnect('workbuddy');
    const disconnected = JSON.parse(await readFile(workbuddyPath, 'utf8'));
    expect(disconnected.mcpServers.canvasforge).toBeUndefined();
    expect(disconnected.mcpServers.figma).toBeDefined();
    expect(disconnected.connectorProxy).toEqual({ enabled: true });
  });

  it('backs up malformed WorkBuddy JSON without replacing the original bytes', async () => {
    const original = '{ "mcpServers": { broken json';
    await writeFile(workbuddyPath, original, 'utf8');
    const manager = createManager();

    await expect(manager.connect('workbuddy')).rejects.toThrow('MCP_CONFIG_PARSE_FAILED');
    await expect(readFile(workbuddyPath, 'utf8')).resolves.toBe(original);
    expect(await readdir(root)).toContain('workbuddy-config.json.canvasforge-backup-20260807-030405');
  });

  it('appends and replaces only the Codex canvasforge TOML section while preserving all other bytes', async () => {
    const original = [
      '# keep this comment',
      'model = "gpt-5"',
      '',
      '[mcp_servers.figma]',
      'url = "https://figma.example.test/mcp"',
      '',
    ].join('\n');
    await writeFile(codexPath, original, 'utf8');
    const manager = createManager();

    await manager.connect('codex');
    const first = await readFile(codexPath, 'utf8');
    expect(first.startsWith(original)).toBe(true);
    expect(first).toContain('[mcp_servers.canvasforge]');
    expect(first).toContain('command = "C:\\\\Program Files\\\\CanvasForge\\\\CanvasForge.exe"');
    expect(first).toContain('args = ["resources\\\\mcp\\\\canvasforge-mcp.cjs"]');
    expect(first).toContain('env = { ELECTRON_RUN_AS_NODE = "1" }');

    await manager.connect('codex');
    const second = await readFile(codexPath, 'utf8');
    expect(second.match(/\[mcp_servers\.canvasforge\]/gu)).toHaveLength(1);
    expect(second).toContain('# keep this comment');
    expect(second).toContain('[mcp_servers.figma]');

    await manager.disconnect('codex');
    expect(await readFile(codexPath, 'utf8')).toBe(original);
  });

  it('rejects duplicate Codex canvasforge sections without changing the config', async () => {
    const original = '[mcp_servers.canvasforge]\ncommand = "one"\n\n[mcp_servers.canvasforge]\ncommand = "two"\n';
    await writeFile(codexPath, original, 'utf8');
    const manager = createManager();

    await expect(manager.connect('codex')).rejects.toThrow('MCP_CONFIG_DUPLICATE_SECTION');
    await expect(readFile(codexPath, 'utf8')).resolves.toBe(original);
  });

  it('rolls back the exact original config when the post-write health check fails', async () => {
    const original = JSON.stringify({ mcpServers: { figma: { command: 'figma.exe' } } }, null, 2);
    await writeFile(workbuddyPath, original, 'utf8');
    const manager = createManager(vi.fn(async () => { throw new Error('health failed'); }));

    await expect(manager.connect('workbuddy')).rejects.toThrow('MCP_CONFIG_HEALTH_CHECK_FAILED');
    await expect(readFile(workbuddyPath, 'utf8')).resolves.toBe(original);
  });

  it('returns executable client-specific config text without runtime credentials', () => {
    const manager = createManager();
    expect(manager.copyConfig('codex')).toContain('[mcp_servers.canvasforge]');
    expect(manager.copyConfig('workbuddy')).toContain('"canvasforge"');
    expect(`${manager.copyConfig('codex')}\n${manager.copyConfig('workbuddy')}`).not.toMatch(/authToken|pipeName|apiKey|authorization/iu);
  });
});