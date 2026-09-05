import nodeHttp from 'node:http';
import nodeHttps from 'node:https';
import { writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { win32 } from 'node:path';

export const FORMAL_QA_NETWORK_GUARD_MARKER = 'canvasforge-formal-qa-network-guard-v1';
export const FORMAL_QA_NETWORK_GUARD_STATE_FILE = 'formal-qa-network-guard-state.json';

const BLOCKED_ERROR_MESSAGE = 'FORMAL_QA_NETWORK_BLOCKED: external network is disabled for formal installed-app QA';
const BLOCKED_URL_PATTERNS = ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*', 'ftp://*/*'];

type RequestFunction = (...args: unknown[]) => unknown;

interface MutableRequestModule {
  request?: RequestFunction;
  get?: RequestFunction;
}

interface MutableFetchTarget {
  fetch?: RequestFunction;
  WebSocket?: unknown;
}

interface NodeRequestBlockerTargets {
  http: MutableRequestModule;
  https: MutableRequestModule;
  globalTarget: MutableFetchTarget;
  syncBuiltinESMExports(): void;
}

interface GuardableSession {
  webRequest: {
    onBeforeRequest(
      filter: { urls: string[] },
      listener: (details: unknown, callback: (result: { cancel: boolean }) => void) => void,
    ): void;
  };
}

interface SessionEventSource {
  on(event: 'session-created', listener: (session: GuardableSession) => void): unknown;
}

interface BootstrapApp extends SessionEventSource {
  whenReady(): Promise<unknown>;
}

interface FormalQaDesktopBootstrapDependencies {
  guardDependencies?: FormalQaNetworkGuardDependencies;
  loadElectron(): {
    app: BootstrapApp;
    session: { defaultSession: GuardableSession };
  };
  loadMainModule(): void;
}

export interface FormalQaNetworkGuardState {
  marker: typeof FORMAL_QA_NETWORK_GUARD_MARKER;
  enabled: boolean;
  nodeRequestBlocking: boolean;
  sessionHookInstalled: boolean;
  electronSessionBlocking: boolean;
  guardedSessionCount: number;
  blockedAttemptCount: number;
}

interface FormalQaNetworkGuardDependencies {
  installNodeRequestBlocker?(onBlocked: () => void): void;
  publishState?(state: FormalQaNetworkGuardState): void;
}

export function installNodeRequestBlockerOnTargets(
  targets: NodeRequestBlockerTargets,
  onBlocked: () => void,
): void {
  const blockRequest = (function blockFormalQaNetworkRequest(..._args: unknown[]) {
    try {
      onBlocked();
    } finally {
      throw new Error(BLOCKED_ERROR_MESSAGE);
    }
  }) as RequestFunction;

  if (typeof targets.http.request === 'function') targets.http.request = blockRequest;
  if (typeof targets.http.get === 'function') targets.http.get = blockRequest;
  if (typeof targets.https.request === 'function') targets.https.request = blockRequest;
  if (typeof targets.https.get === 'function') targets.https.get = blockRequest;
  if (typeof targets.globalTarget.fetch === 'function') targets.globalTarget.fetch = blockRequest;
  if (typeof targets.globalTarget.WebSocket === 'function') targets.globalTarget.WebSocket = blockRequest;
  targets.syncBuiltinESMExports();
}

function hasOwnedFormalQaUserDataRoot(environment: Readonly<Record<string, string | undefined>>): boolean {
  const candidate = environment.CANVASFORGE_QA_USER_DATA_ROOT;
  return typeof candidate === 'string'
    && win32.isAbsolute(candidate)
    && win32.basename(win32.normalize(candidate)).toLocaleLowerCase().startsWith('canvasforge-qa-');
}

export function createFormalQaNetworkGuard(
  environment: Readonly<Record<string, string | undefined>>,
  dependencies: FormalQaNetworkGuardDependencies = {},
) {
  const enabled = environment.CANVASFORGE_QA_MODE === '1'
    && environment.CANVASFORGE_FORMAL_QA_OFFLINE === '1'
    && hasOwnedFormalQaUserDataRoot(environment);
  const guardedSessions = new WeakSet<object>();
  let nodeRequestBlocking = false;
  let sessionHookInstalled = false;
  let electronSessionBlocking = false;
  let guardedSessionCount = 0;
  let blockedAttemptCount = 0;

  const readState = (): FormalQaNetworkGuardState => ({
    marker: FORMAL_QA_NETWORK_GUARD_MARKER,
    enabled,
    nodeRequestBlocking,
    sessionHookInstalled,
    electronSessionBlocking,
    guardedSessionCount,
    blockedAttemptCount,
  });
  const publishState = dependencies.publishState ?? ((state: FormalQaNetworkGuardState) => {
    writeFileSync(
      win32.join(environment.CANVASFORGE_QA_USER_DATA_ROOT as string, FORMAL_QA_NETWORK_GUARD_STATE_FILE),
      `${JSON.stringify(state)}\n`,
      { encoding: 'utf8', flag: 'w' },
    );
    (globalThis as Record<string, unknown>).__CANVASFORGE_FORMAL_QA_NETWORK_GUARD__ = { ...state };
  });
  const publish = () => {
    if (enabled) publishState(readState());
  };
  const recordBlockedAttempt = () => {
    blockedAttemptCount += 1;
    publish();
  };

  const installNodeGuard = () => {
    if (!enabled || nodeRequestBlocking) return;
    const install = dependencies.installNodeRequestBlocker ?? ((onBlocked: () => void) => {
      installNodeRequestBlockerOnTargets({
        http: nodeHttp as MutableRequestModule,
        https: nodeHttps as MutableRequestModule,
        globalTarget: globalThis as unknown as MutableFetchTarget,
        syncBuiltinESMExports,
      }, onBlocked);
    });
    install(recordBlockedAttempt);
    nodeRequestBlocking = true;
    publish();
  };

  const guardSession = (electronSession: GuardableSession) => {
    if (!enabled || guardedSessions.has(electronSession)) return;
    electronSession.webRequest.onBeforeRequest(
      { urls: [...BLOCKED_URL_PATTERNS] },
      (_details, callback) => {
        try {
          recordBlockedAttempt();
        } finally {
          callback({ cancel: true });
        }
      },
    );
    guardedSessions.add(electronSession);
    guardedSessionCount += 1;
    electronSessionBlocking = true;
    publish();
  };

  const attachToApp = (app: SessionEventSource) => {
    if (!enabled || sessionHookInstalled) return;
    app.on('session-created', guardSession);
    sessionHookInstalled = true;
    publish();
  };

  return Object.freeze({ installNodeGuard, attachToApp, guardSession, readState });
}

export function bootstrapFormalQaDesktopMain(
  environment: Readonly<Record<string, string | undefined>>,
  dependencies: FormalQaDesktopBootstrapDependencies,
) {
  const guard = createFormalQaNetworkGuard(environment, dependencies.guardDependencies);
  guard.installNodeGuard();

  const electron = dependencies.loadElectron();
  guard.attachToApp(electron.app);
  void electron.app.whenReady().then(
    () => guard.guardSession(electron.session.defaultSession),
    () => undefined,
  );

  dependencies.loadMainModule();
  return guard;
}
