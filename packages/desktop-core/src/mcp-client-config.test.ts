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
      command: 'C:\\Program Files\\Canvas Atelier\\Canvas Atelier.exe',
      args: ['resources\\mcp\\canvasforge-mcp.cjs'],
      env: { ELECTRON_RUN_AS_NODE: '1' },
      now: () => new Date('2026-08-07T03:04:05.000Z'),
      healthCheck,
    });
  }

  it('merges and disconnects only the WorkBuddy canvas_atelier server while preserving a legacy CanvasForge entry', async () => {
    const legacyBackupPath = join(root, 'workbuddy-config.json.canvasforge-backup-20260801-010203');
    await writeFile(legacyBackupPath, 'legacy-backup-bytes', 'utf8');
    await writeFile(workbuddyPath, JSON.stringify({
      connectorProxy: { enabled: true },
      mcpServers: {
        canvasforge: { command: 'D:\\CanvasForge\\CanvasForge.exe', args: ['legacy-bridge.cjs'] },
        existing_mcp: { url: 'https://existing.example.test/mcp' },
        existing: { command: 'existing.exe', args: ['--safe'] },
      },
      theme: 'dark',
    }, null, 2), 'utf8');
    const manager = createManager();

    const connected = await manager.connect('workbuddy');
    const merged = JSON.parse(await readFile(workbuddyPath, 'utf8'));
    expect(connected).toMatchObject({ client: 'workbuddy', state: 'connected', toolCount: 14 });
    expect(merged.connectorProxy).toEqual({ enabled: true });
    expect(merged.mcpServers.existing_mcp).toEqual({ url: 'https://existing.example.test/mcp' });
    expect(merged.mcpServers.existing).toEqual({ command: 'existing.exe', args: ['--safe'] });
    expect(merged.mcpServers.canvasforge).toEqual({ command: 'D:\\CanvasForge\\CanvasForge.exe', args: ['legacy-bridge.cjs'] });
    expect(merged.mcpServers.canvas_atelier).toEqual({
      command: 'C:\\Program Files\\Canvas Atelier\\Canvas Atelier.exe',
      args: ['resources\\mcp\\canvasforge-mcp.cjs'],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    });
    expect(await readdir(root)).toContain('workbuddy-config.json.canvas-atelier-backup-20260807-030405');

    await manager.disconnect('workbuddy');
    const disconnected = JSON.parse(await readFile(workbuddyPath, 'utf8'));
    expect(disconnected.mcpServers.canvas_atelier).toBeUndefined();
    expect(disconnected.mcpServers.canvasforge).toEqual({ command: 'D:\\CanvasForge\\CanvasForge.exe', args: ['legacy-bridge.cjs'] });
    expect(disconnected.mcpServers.existing_mcp).toBeDefined();
    expect(disconnected.connectorProxy).toEqual({ enabled: true });
    await expect(readFile(legacyBackupPath, 'utf8')).resolves.toBe('legacy-backup-bytes');
  });

  it('backs up malformed WorkBuddy JSON without replacing the original bytes', async () => {
    const original = '{ "mcpServers": { broken json';
    await writeFile(workbuddyPath, original, 'utf8');
    const manager = createManager();

    await expect(manager.connect('workbuddy')).rejects.toThrow('MCP_CONFIG_PARSE_FAILED');
    await expect(readFile(workbuddyPath, 'utf8')).resolves.toBe(original);
    expect(await readdir(root)).toContain('workbuddy-config.json.canvas-atelier-backup-20260807-030405');
  });

  it.each([
    ['an array', []],
    ['a scalar', 'do-not-overwrite'],
  ])('backs up but does not overwrite WorkBuddy when mcpServers is %s', async (_label, mcpServers) => {
    const original = JSON.stringify({ mcpServers, preserve: true }, null, 2);
    await writeFile(workbuddyPath, original, 'utf8');
    const manager = createManager();

    await expect(manager.connect('workbuddy')).rejects.toThrow('MCP_CONFIG_PARSE_FAILED');
    await expect(readFile(workbuddyPath, 'utf8')).resolves.toBe(original);
    expect(await readdir(root)).toContain('workbuddy-config.json.canvas-atelier-backup-20260807-030405');
  });

  it('appends and replaces only the Codex canvas_atelier TOML section while preserving all other bytes', async () => {
    const original = [
      '# keep this comment',
      'model = "gpt-5"',
      '',
      '[mcp_servers.existing_mcp]',
      'url = "https://existing.example.test/mcp"',
      '',
    ].join('\n');
    await writeFile(codexPath, original, 'utf8');
    const manager = createManager();

    await manager.connect('codex');
    const first = await readFile(codexPath, 'utf8');
    expect(first.startsWith(original)).toBe(true);
    expect(first).toContain('[mcp_servers.canvas_atelier]');
    expect(first).toContain('command = "C:\\\\Program Files\\\\Canvas Atelier\\\\Canvas Atelier.exe"');
    expect(first).toContain('args = ["resources\\\\mcp\\\\canvasforge-mcp.cjs"]');
    expect(first).toContain('env = { ELECTRON_RUN_AS_NODE = "1" }');

    await manager.connect('codex');
    const second = await readFile(codexPath, 'utf8');
    expect(second.match(/\[mcp_servers\.canvas_atelier\]/gu)).toHaveLength(1);
    expect(second).toContain('# keep this comment');
    expect(second).toContain('[mcp_servers.existing_mcp]');
    const backups = (await readdir(root)).filter((name) => name.startsWith('codex-config.toml.canvas-atelier-backup-'));
    expect(backups).toHaveLength(2);
    await expect(Promise.all(backups.map((name) => readFile(join(root, name), 'utf8')))).resolves.toEqual(expect.arrayContaining([
      original,
      first,
    ]));

    await manager.disconnect('codex');
    expect(await readFile(codexPath, 'utf8')).toBe(original);
  });

  it('recognizes a quoted Codex server key and preserves a following array table byte-for-byte', async () => {
    const prefix = '# preserve prefix\r\nmodel = "gpt-6-astra"\r\n\r\n';
    const arrayTable = '[[rules.allow]]\r\npath = "E:\\\\work"\r\n\r\n';
    const original = [
      prefix,
      '[mcp_servers."canvas_atelier"]\r\n',
      'command = "C:\\\\Program Files\\\\Canvas Atelier\\\\Canvas Atelier.exe"\r\n',
      'args = ["resources\\\\mcp\\\\canvasforge-mcp.cjs"]\r\n',
      'env = { ELECTRON_RUN_AS_NODE = "1" }\r\n',
      '\r\n',
      arrayTable,
    ].join('');
    await writeFile(codexPath, original, 'utf8');
    const manager = createManager();

    await expect(manager.getStatus('codex')).resolves.toMatchObject({ state: 'configured', lastError: null });
    await manager.connect('codex');
    const merged = await readFile(codexPath, 'utf8');

    expect(merged.startsWith(prefix)).toBe(true);
    expect(merged).not.toContain('[mcp_servers."canvas_atelier"]');
    expect(merged.match(/\[mcp_servers\.canvas_atelier\]/gu)).toHaveLength(1);
    expect(merged.endsWith(arrayTable)).toBe(true);
    expect(merged.match(/\[\[rules\.allow\]\]/gu)).toHaveLength(1);
  });

  it('replaces and disconnects the complete Canvas Atelier subtree without leaving a nested env table', async () => {
    const prefix = '# preserve before target\nmodel = "gpt-6-astra"\n\n';
    const unrelated = '[[rules.allow]]\npath = "E:\\\\work"\n\n';
    const original = [
      prefix,
      '[mcp_servers.canvas_atelier]\n',
      'command = "C:\\\\Old\\\\Canvas Atelier.exe"\n',
      'args = ["old-bridge.cjs"]\n\n',
      '[mcp_servers.canvas_atelier.env]\n',
      'ELECTRON_RUN_AS_NODE = "1"\n\n',
      unrelated,
    ].join('');
    await writeFile(codexPath, original, 'utf8');
    const manager = createManager();

    await manager.connect('codex');
    const connected = await readFile(codexPath, 'utf8');
    expect(connected).not.toContain('[mcp_servers.canvas_atelier.env]');
    expect(connected.match(/\[mcp_servers\.canvas_atelier\]/gu)).toHaveLength(1);
    expect(connected.startsWith(prefix)).toBe(true);
    expect(connected.endsWith(unrelated)).toBe(true);

    await manager.disconnect('codex');
    await expect(readFile(codexPath, 'utf8')).resolves.toBe(`${prefix}${unrelated}`);
  });

  it('replaces and disconnects dotted Canvas Atelier assignments without creating duplicate TOML keys', async () => {
    const prefix = '# preserve dotted config\nmodel = "gpt-6-astra"\n';
    const suffix = 'mcp_servers.existing.command = "existing.exe"\n';
    const original = [
      prefix,
      'mcp_servers.canvas_atelier.command = "C:\\\\Old\\\\Canvas Atelier.exe"\n',
      'mcp_servers.canvas_atelier.args = ["old-bridge.cjs"]\n',
      'mcp_servers.canvas_atelier.env = { ELECTRON_RUN_AS_NODE = "1" }\n',
      suffix,
    ].join('');
    await writeFile(codexPath, original, 'utf8');
    const manager = createManager();

    await manager.connect('codex');
    const connected = await readFile(codexPath, 'utf8');
    expect(connected).not.toContain('mcp_servers.canvas_atelier.command =');
    expect(connected.match(/\[mcp_servers\.canvas_atelier\]/gu)).toHaveLength(1);
    expect(connected.startsWith(prefix)).toBe(true);
    expect(connected).toContain(suffix);
    expect(connected.indexOf(suffix)).toBeLessThan(connected.indexOf('[mcp_servers.canvas_atelier]'));

    await manager.disconnect('codex');
    await expect(readFile(codexPath, 'utf8')).resolves.toBe(`${prefix}${suffix}`);
  });

  it('accepts and preserves a valid multiline basic string with quote characters at both boundaries', async () => {
    const original = 'banner = """"This," she said, "works.""""\n';
    await writeFile(codexPath, original, 'utf8');
    const manager = createManager();

    await expect(manager.connect('codex')).resolves.toMatchObject({ state: 'connected' });
    await expect(readFile(codexPath, 'utf8')).resolves.toSatisfy((text: string) => text.startsWith(original));
  });

  it('serializes concurrent mutations of the same client config', async () => {
    let releaseFirstHealth: (() => void) | undefined;
    const firstHealthGate = new Promise<void>((resolve) => { releaseFirstHealth = resolve; });
    let healthCalls = 0;
    const healthCheck = vi.fn(async () => {
      healthCalls += 1;
      if (healthCalls === 1) await firstHealthGate;
      return { connected: true, toolCount: 14 as const };
    });
    const manager = createManager(healthCheck);

    const first = manager.connect('codex');
    while (healthCalls === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    const second = manager.connect('codex');
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(healthCheck).toHaveBeenCalledTimes(1);
    releaseFirstHealth?.();
    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ state: 'connected' }),
      expect.objectContaining({ state: 'connected' }),
    ]);
    const connected = await readFile(codexPath, 'utf8');
    expect(connected.match(/\[mcp_servers\.canvas_atelier\]/gu)).toHaveLength(1);
  });

  it.each([
    ['unterminated string', 'model = "unterminated\n'],
    ['unterminated table header', '[mcp_servers.canvas_atelier\ncommand = "broken"\n'],
    ['unterminated array', 'features = ["one", "two"\n'],
    ['invalid scalar token', 'model = ???\n'],
    ['trailing scalar garbage', 'model = "gpt-6-astra" garbage\n'],
    ['array item without a comma', 'features = ["one" "two"]\n'],
    ['invalid multiline basic string escape', 'message = """bad \\q escape"""\n'],
  ])('backs up but never writes clearly malformed Codex TOML: %s', async (_label, original) => {
    const healthCheck = vi.fn(async () => ({ connected: true, toolCount: 14 as const }));
    await writeFile(codexPath, original, 'utf8');
    const manager = createManager(healthCheck);

    await expect(manager.connect('codex')).rejects.toThrow('MCP_CONFIG_PARSE_FAILED');
    await expect(readFile(codexPath, 'utf8')).resolves.toBe(original);
    const backups = (await readdir(root)).filter((name) => name.startsWith('codex-config.toml.canvas-atelier-backup-'));
    expect(backups).toHaveLength(1);
    await expect(readFile(join(root, backups[0]!), 'utf8')).resolves.toBe(original);
    expect(healthCheck).not.toHaveBeenCalled();
  });

  it('rejects duplicate Codex canvas_atelier sections without changing the config', async () => {
    const original = '[mcp_servers.canvas_atelier]\ncommand = "one"\n\n[mcp_servers.canvas_atelier]\ncommand = "two"\n';
    await writeFile(codexPath, original, 'utf8');
    const manager = createManager();

    await expect(manager.connect('codex')).rejects.toThrow('MCP_CONFIG_DUPLICATE_SECTION');
    await expect(readFile(codexPath, 'utf8')).resolves.toBe(original);
  });

  it('rolls back the exact original config when the post-write health check fails', async () => {
    const original = JSON.stringify({ mcpServers: { existing_mcp: { command: 'existing-mcp.exe' } } }, null, 2);
    await writeFile(workbuddyPath, original, 'utf8');
    const manager = createManager(vi.fn(async () => { throw new Error('health failed'); }));

    await expect(manager.connect('workbuddy')).rejects.toThrow('MCP_CONFIG_HEALTH_CHECK_FAILED');
    await expect(readFile(workbuddyPath, 'utf8')).resolves.toBe(original);
  });

  it('does not report a client as connected when the Canvas Atelier entry is not configured', async () => {
    const healthCheck = vi.fn(async () => ({ connected: true, toolCount: 14 as const }));
    const manager = createManager(healthCheck);

    await expect(manager.test('codex')).resolves.toEqual({
      client: 'codex',
      state: 'unconfigured',
      toolCount: 0,
      lastError: null,
    });
    await expect(manager.test('workbuddy')).resolves.toEqual({
      client: 'workbuddy',
      state: 'unconfigured',
      toolCount: 0,
      lastError: null,
    });
    expect(healthCheck).not.toHaveBeenCalled();
  });

  it('rejects a stale client entry before running the bundled bridge health check', async () => {
    const healthCheck = vi.fn(async () => ({ connected: true, toolCount: 14 as const }));
    await writeFile(codexPath, [
      '[mcp_servers.canvas_atelier]',
      'command = "D:\\\\OldCanvasAtelier\\\\Canvas Atelier.exe"',
      'args = ["old-bridge.cjs"]',
      'env = { ELECTRON_RUN_AS_NODE = "1" }',
      '',
    ].join('\n'), 'utf8');
    await writeFile(workbuddyPath, JSON.stringify({
      mcpServers: {
        canvas_atelier: {
          command: 'D:\\OldCanvasAtelier\\Canvas Atelier.exe',
          args: ['old-bridge.cjs'],
          env: { ELECTRON_RUN_AS_NODE: '1' },
        },
      },
    }), 'utf8');
    const manager = createManager(healthCheck);

    await expect(manager.getStatus('codex')).resolves.toEqual({
      client: 'codex',
      state: 'connection_failed',
      toolCount: 0,
      lastError: 'MCP_CONFIG_MISMATCH',
    });
    await expect(manager.getStatus('workbuddy')).resolves.toEqual({
      client: 'workbuddy',
      state: 'connection_failed',
      toolCount: 0,
      lastError: 'MCP_CONFIG_MISMATCH',
    });
    await expect(manager.test('codex')).resolves.toEqual({
      client: 'codex',
      state: 'connection_failed',
      toolCount: 0,
      lastError: 'MCP_CONFIG_MISMATCH',
    });
    await expect(manager.test('workbuddy')).resolves.toEqual({
      client: 'workbuddy',
      state: 'connection_failed',
      toolCount: 0,
      lastError: 'MCP_CONFIG_MISMATCH',
    });
    expect(healthCheck).not.toHaveBeenCalled();
  });

  it('rejects a disabled WorkBuddy entry even when its launch fields match exactly', async () => {
    const healthCheck = vi.fn(async () => ({ connected: true, toolCount: 14 as const }));
    await writeFile(workbuddyPath, JSON.stringify({
      mcpServers: {
        canvas_atelier: {
          command: 'C:\\Program Files\\Canvas Atelier\\Canvas Atelier.exe',
          args: ['resources\\mcp\\canvasforge-mcp.cjs'],
          env: { ELECTRON_RUN_AS_NODE: '1' },
          disabled: true,
        },
      },
    }), 'utf8');
    const manager = createManager(healthCheck);

    await expect(manager.getStatus('workbuddy')).resolves.toMatchObject({
      state: 'connection_failed', lastError: 'MCP_CONFIG_MISMATCH',
    });
    await expect(manager.test('workbuddy')).resolves.toMatchObject({
      state: 'connection_failed', lastError: 'MCP_CONFIG_MISMATCH',
    });
    expect(healthCheck).not.toHaveBeenCalled();
  });

  it('returns executable client-specific config text without runtime credentials', () => {
    const manager = createManager();
    expect(manager.copyConfig('codex')).toContain('[mcp_servers.canvas_atelier]');
    expect(manager.copyConfig('workbuddy')).toContain('"canvas_atelier"');
    expect(`${manager.copyConfig('codex')}\n${manager.copyConfig('workbuddy')}`).not.toMatch(/authToken|pipeName|apiKey|authorization/iu);
  });
});
