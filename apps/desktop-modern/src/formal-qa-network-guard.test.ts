import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  FORMAL_QA_NETWORK_GUARD_MARKER,
  createFormalQaNetworkGuard,
  installNodeRequestBlockerOnTargets,
} from './formal-qa-network-guard';
import * as formalQaNetworkGuardModule from './formal-qa-network-guard';

describe('formal QA offline network guard', () => {
  it('does not alter ordinary or non-formal QA runtime behavior', () => {
    let nodeInstallCount = 0;
    let publishedCount = 0;
    const app = new EventEmitter();
    const guard = createFormalQaNetworkGuard({ CANVASFORGE_QA_MODE: '1' }, {
      installNodeRequestBlocker() { nodeInstallCount += 1; },
      publishState() { publishedCount += 1; },
    });

    guard.installNodeGuard();
    guard.attachToApp(app);

    expect(guard.readState()).toMatchObject({ enabled: false, marker: FORMAL_QA_NETWORK_GUARD_MARKER });
    expect(nodeInstallCount).toBe(0);
    expect(publishedCount).toBe(0);
    expect(app.listenerCount('session-created')).toBe(0);
  });

  it('refuses to activate without an absolute owned formal-QA userData root', () => {
    for (const qaRoot of [undefined, 'relative\\canvasforge-qa-profile', String.raw`C:\Temp\ordinary-profile`]) {
      const guard = createFormalQaNetworkGuard({
        CANVASFORGE_QA_MODE: '1',
        CANVASFORGE_FORMAL_QA_OFFLINE: '1',
        CANVASFORGE_QA_USER_DATA_ROOT: qaRoot,
      });
      expect(guard.readState().enabled).toBe(false);
    }
  });

  it('blocks Node HTTP, HTTPS, fetch, and WebSocket entry points without invoking or retaining a secret target', () => {
    let delegateCount = 0;
    const original = (..._args: unknown[]) => {
      delegateCount += 1;
      return 'ordinary-runtime';
    };
    function OriginalWebSocket(_url: string) {
      delegateCount += 1;
    }
    const http = { request: original, get: original };
    const https = { request: original, get: original };
    const globalTarget = {
      fetch: original,
      WebSocket: OriginalWebSocket as unknown as { new(url: string): object },
    };
    let syncCount = 0;
    const blockedTargets: string[] = [];

    installNodeRequestBlockerOnTargets({
      http,
      https,
      globalTarget,
      syncBuiltinESMExports() { syncCount += 1; },
    }, () => { blockedTargets.push('[redacted]'); });

    for (const request of [http.request, http.get, https.request, https.get, globalTarget.fetch]) {
      expect(() => request?.('https://user:password@example.invalid/private?token=secret')).toThrow(/FORMAL_QA_NETWORK_BLOCKED/u);
    }
    expect(() => new globalTarget.WebSocket('wss://user:password@example.invalid/private?token=secret')).toThrow(/FORMAL_QA_NETWORK_BLOCKED/u);
    expect(syncCount).toBe(1);
    expect(delegateCount).toBe(0);
    expect(blockedTargets).toEqual(Array(6).fill('[redacted]'));
  });

  it('guards every Electron session and publishes a fail-closed runtime handshake', () => {
    let nodeBlocker: (() => never) | undefined;
    const published: unknown[] = [];
    const app = new EventEmitter();
    const guard = createFormalQaNetworkGuard({
      CANVASFORGE_QA_MODE: '1',
      CANVASFORGE_FORMAL_QA_OFFLINE: '1',
      CANVASFORGE_QA_USER_DATA_ROOT: String.raw`C:\Temp\canvasforge-qa-installed-formal-catalog-fixture`,
    }, {
      installNodeRequestBlocker(onBlocked) {
        nodeBlocker = () => {
          onBlocked();
          throw new Error('FORMAL_QA_NETWORK_BLOCKED');
        };
      },
      publishState(state) { published.push({ ...state }); },
    });

    guard.installNodeGuard();
    guard.attachToApp(app);
    expect(() => nodeBlocker?.()).toThrow(/FORMAL_QA_NETWORK_BLOCKED/u);

    let beforeRequest: ((details: unknown, callback: (result: { cancel: boolean }) => void) => void) | undefined;
    const electronSession = {
      webRequest: {
        onBeforeRequest(
          filter: { urls: string[] },
          listener: (details: unknown, callback: (result: { cancel: boolean }) => void) => void,
        ) {
          expect(filter.urls).toEqual(expect.arrayContaining(['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*']));
          beforeRequest = listener;
        },
      },
    };
    app.emit('session-created', electronSession);
    let decision: { cancel: boolean } | undefined;
    beforeRequest?.({ url: 'https://example.invalid/private?apiKey=secret' }, (result) => { decision = result; });

    expect(decision).toEqual({ cancel: true });
    expect(guard.readState()).toEqual({
      marker: FORMAL_QA_NETWORK_GUARD_MARKER,
      enabled: true,
      nodeRequestBlocking: true,
      sessionHookInstalled: true,
      electronSessionBlocking: true,
      guardedSessionCount: 1,
      blockedAttemptCount: 2,
    });
    expect(published[published.length - 1]).toEqual(guard.readState());
    expect(JSON.stringify(guard.readState())).not.toMatch(/example\.invalid|apiKey|secret/u);
  });

  it('synchronously persists only the bounded guard state inside the verified QA root', () => {
    const qaRoot = mkdtempSync(join(tmpdir(), 'canvasforge-qa-network-state-'));
    try {
      const app = new EventEmitter();
      const guard = createFormalQaNetworkGuard({
        CANVASFORGE_QA_MODE: '1',
        CANVASFORGE_FORMAL_QA_OFFLINE: '1',
        CANVASFORGE_QA_USER_DATA_ROOT: qaRoot,
      }, {
        installNodeRequestBlocker() {},
      });
      guard.installNodeGuard();
      guard.attachToApp(app);

      let beforeRequest: ((details: unknown, callback: (result: { cancel: boolean }) => void) => void) | undefined;
      app.emit('session-created', {
        webRequest: {
          onBeforeRequest(
            _filter: { urls: string[] },
            listener: (details: unknown, callback: (result: { cancel: boolean }) => void) => void,
          ) {
            beforeRequest = listener;
          },
        },
      });
      beforeRequest?.({
        url: 'https://user:password@example.invalid/private?token=secret',
        requestHeaders: { authorization: 'Bearer raw-secret' },
        uploadData: [{ bytes: Buffer.from('raw-body') }],
      }, () => {});

      const serialized = readFileSync(join(qaRoot, 'formal-qa-network-guard-state.json'), 'utf8');
      const state = JSON.parse(serialized);
      expect(Object.keys(state).sort()).toEqual([
        'blockedAttemptCount',
        'electronSessionBlocking',
        'enabled',
        'guardedSessionCount',
        'marker',
        'nodeRequestBlocking',
        'sessionHookInstalled',
      ]);
      expect(state).toEqual(guard.readState());
      expect(serialized).not.toMatch(/example\.invalid|raw-secret|raw-body|password|requestHeaders|uploadData|url/u);
    } finally {
      rmSync(qaRoot, { recursive: true, force: true });
    }
  });

  it('fails closed during startup when the initial state file cannot be written', () => {
    const missingQaRoot = join(tmpdir(), `canvasforge-qa-missing-parent-${process.pid}`, 'canvasforge-qa-network-state');
    const guard = createFormalQaNetworkGuard({
      CANVASFORGE_QA_MODE: '1',
      CANVASFORGE_FORMAL_QA_OFFLINE: '1',
      CANVASFORGE_QA_USER_DATA_ROOT: missingQaRoot,
    }, {
      installNodeRequestBlocker() {},
    });

    expect(() => guard.installNodeGuard()).toThrow();
  });

  it('updates a captured Node named import before the original delegate can run', () => {
    const child = spawnSync(process.execPath, ['--input-type=module', '--eval', `
      import http, { request as capturedRequest } from 'node:http';
      import { syncBuiltinESMExports } from 'node:module';
      http.request = function blockedRequest() { throw new Error('FORMAL_QA_NETWORK_BLOCKED'); };
      syncBuiltinESMExports();
      if (capturedRequest !== http.request) process.exit(31);
      try {
        capturedRequest();
        process.exit(32);
      } catch (error) {
        if (!String(error?.message).includes('FORMAL_QA_NETWORK_BLOCKED')) process.exit(33);
      }
    `], { encoding: 'utf8' });

    expect(child.status, child.stderr).toBe(0);
  });

  it('bootstraps the Node guard before loading Electron or a side-effecting main module', async () => {
    type Bootstrap = (
      environment: Readonly<Record<string, string | undefined>>,
      dependencies: {
        guardDependencies: {
          installNodeRequestBlocker(onBlocked: () => void): void;
          publishState(state: { blockedAttemptCount: number }): void;
        };
        loadElectron(): {
          app: EventEmitter & { whenReady(): Promise<void> };
          session: { defaultSession: { webRequest: { onBeforeRequest(filter: unknown, listener: unknown): void } } };
        };
        loadMainModule(): void;
      },
    ) => { readState(): { blockedAttemptCount: number } };
    const bootstrapFormalQaDesktopMain = (formalQaNetworkGuardModule as unknown as {
      bootstrapFormalQaDesktopMain?: Bootstrap;
    }).bootstrapFormalQaDesktopMain;
    expect(typeof bootstrapFormalQaDesktopMain).toBe('function');

    const trace: string[] = [];
    let delegateCount = 0;
    const original = (..._args: unknown[]) => { delegateCount += 1; };
    function OriginalWebSocket(_url: string) { delegateCount += 1; }
    const targets = {
      http: { request: original, get: original },
      https: { request: original, get: original },
      globalTarget: {
        fetch: original,
        WebSocket: OriginalWebSocket as unknown as { new(url: string): object },
      },
      syncBuiltinESMExports() {},
    };
    const app = Object.assign(new EventEmitter(), { whenReady: () => Promise.resolve() });
    let defaultSessionGuarded = false;
    const defaultSession = {
      webRequest: {
        onBeforeRequest() { defaultSessionGuarded = true; },
      },
    };
    const published: Array<{ blockedAttemptCount: number }> = [];
    const guard = bootstrapFormalQaDesktopMain?.({
      CANVASFORGE_QA_MODE: '1',
      CANVASFORGE_FORMAL_QA_OFFLINE: '1',
      CANVASFORGE_QA_USER_DATA_ROOT: String.raw`C:\Temp\canvasforge-qa-bootstrap-fixture`,
    }, {
      guardDependencies: {
        installNodeRequestBlocker(onBlocked) {
          trace.push('node-guard');
          installNodeRequestBlockerOnTargets(targets, onBlocked);
        },
        publishState(state) { published.push({ ...state }); },
      },
      loadElectron() {
        trace.push('electron');
        return { app, session: { defaultSession } };
      },
      loadMainModule() {
        trace.push('main-module');
        expect(app.listenerCount('session-created')).toBe(1);
        expect(() => targets.http.request('http://example.invalid/private')).toThrow(/FORMAL_QA_NETWORK_BLOCKED/u);
        expect(() => new targets.globalTarget.WebSocket('wss://example.invalid/private')).toThrow(/FORMAL_QA_NETWORK_BLOCKED/u);
        trace.push('main-module-after-blocked-attempts');
      },
    });

    expect(trace).toEqual(['node-guard', 'electron', 'main-module', 'main-module-after-blocked-attempts']);
    expect(delegateCount).toBe(0);
    expect(guard?.readState().blockedAttemptCount).toBe(2);
    expect(published[published.length - 1]?.blockedAttemptCount).toBe(2);
    await Promise.resolve();
    expect(defaultSessionGuarded).toBe(true);
  });

  it('builds from a guard-only static bootstrap and removes the late duplicate guard from main', async () => {
    const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    const bootstrapSource = await readFile(new URL('./bootstrap.ts', import.meta.url), 'utf8').catch(() => '');
    const mainSource = await readFile(new URL('./main.ts', import.meta.url), 'utf8');
    const staticImports = [...bootstrapSource.matchAll(/^import(?:\s+[^'"\r\n]*?\s+from)?\s*['"]([^'"]+)['"];\s*$/gmu)]
      .map((match) => match[1]);

    expect(packageJson.scripts.build).toContain('esbuild src/bootstrap.ts --bundle');
    expect(packageJson.scripts.build).not.toContain('esbuild src/main.ts --bundle');
    expect(staticImports).toEqual(['./formal-qa-network-guard']);
    expect(bootstrapSource).toContain('bootstrapFormalQaDesktopMain(process.env');
    expect(bootstrapSource).toContain("require('electron')");
    expect(bootstrapSource).toContain("require('./main')");
    expect(mainSource).not.toContain('createFormalQaNetworkGuard');
    expect(mainSource).not.toContain('formalQaNetworkGuard');
  });
});
