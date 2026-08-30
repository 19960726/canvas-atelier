export interface DesktopShutdownServices {
  readonly closeAllProjects: () => void | Promise<void>;
  readonly stopMcpRuntime?: () => void | Promise<void>;
  readonly stopApprovedSnapshotDrain: () => void | Promise<void>;
  readonly stopApprovedSnapshotPull: () => void | Promise<void>;
  readonly stopKnowledgeRefresh: () => void | Promise<void>;
  readonly unsubscribeKnowledgeState: () => void;
  readonly quit: () => void;
}

export interface DesktopShutdownOptions {
  readonly timeoutMs?: number;
}

const DEFAULT_DESKTOP_SHUTDOWN_TIMEOUT_MS = 3_000;

export async function shutdownDesktopServices(
  services: DesktopShutdownServices,
  options: DesktopShutdownOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_DESKTOP_SHUTDOWN_TIMEOUT_MS;
  try {
    await settleWithin([
      Promise.resolve().then(services.closeAllProjects),
    ], timeoutMs);
    await settleWithin([
      ...(services.stopMcpRuntime === undefined ? [] : [Promise.resolve().then(services.stopMcpRuntime)]),
      Promise.resolve().then(services.stopApprovedSnapshotDrain),
      Promise.resolve().then(services.stopApprovedSnapshotPull),
      Promise.resolve().then(services.stopKnowledgeRefresh),
    ], timeoutMs);
  } finally {
    try {
      services.unsubscribeKnowledgeState();
    } catch {
      // Shutdown must continue to the final quit boundary.
    } finally {
      services.quit();
    }
  }
}

async function settleWithin(operations: readonly Promise<unknown>[], timeoutMs: number): Promise<void> {
  if (operations.length === 0) return;
  const settled = Promise.allSettled(operations).then(() => undefined);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    await settled;
    return;
  }
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    settled,
    new Promise<void>((resolve) => {
      timeoutHandle = setTimeout(resolve, timeoutMs);
    }),
  ]);
  if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
}
