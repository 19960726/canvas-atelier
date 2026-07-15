export interface DesktopShutdownServices {
  readonly closeAllProjects: () => void | Promise<void>;
  readonly stopApprovedSnapshotDrain: () => void | Promise<void>;
  readonly stopApprovedSnapshotPull: () => void | Promise<void>;
  readonly stopKnowledgeRefresh: () => void | Promise<void>;
  readonly unsubscribeKnowledgeState: () => void;
  readonly quit: () => void;
}

export async function shutdownDesktopServices(services: DesktopShutdownServices): Promise<void> {
  try {
    await Promise.allSettled([
      Promise.resolve().then(services.closeAllProjects),
    ]);
    await Promise.allSettled([
      Promise.resolve().then(services.stopApprovedSnapshotDrain),
      Promise.resolve().then(services.stopApprovedSnapshotPull),
      Promise.resolve().then(services.stopKnowledgeRefresh),
    ]);
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