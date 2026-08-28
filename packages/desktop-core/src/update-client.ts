export type UpdateStatus = 'idle' | 'checking' | 'available' | 'downloading' | 'ready_to_restart' | 'error';

export interface MockRelease {
  readonly channel: 'stable' | 'beta';
  readonly version: string;
  readonly notes?: string;
  readonly signatureStatus: 'verified' | 'invalid';
}

export interface UpdateState {
  readonly status: UpdateStatus;
  readonly version?: string;
  readonly notes?: string;
  readonly progress?: number;
  readonly message?: string;
}

export interface UpdateCheckResult {
  readonly state: UpdateState;
}

export interface UpdateRestartResult {
  readonly accepted: boolean;
  readonly reason?: 'REAL_INSTALL_DISABLED' | 'UPDATE_NOT_DOWNLOADED';
}

export type UpdateDriverEvent =
  | { readonly type: 'checking' }
  | { readonly type: 'available'; readonly version: string; readonly notes?: string }
  | { readonly type: 'not-available' }
  | { readonly type: 'download-progress'; readonly percent: number }
  | { readonly type: 'downloaded'; readonly version: string; readonly notes?: string }
  | { readonly type: 'error'; readonly message: string };

export interface UpdateDriver {
  subscribe(listener: (event: UpdateDriverEvent) => void): () => void;
  checkForUpdates(): Promise<void>;
  downloadUpdate(): Promise<void>;
  quitAndInstall(): void;
}

export interface UpdateFeed {
  read(): Promise<MockRelease>;
}

/** Development/test feed only. It never makes an HTTP request. */
export class MockReleaseFeed implements UpdateFeed {
  constructor(private readonly release: MockRelease) {}

  async read(): Promise<MockRelease> {
    return { ...this.release };
  }
}

export class UpdateClient {
  private state: UpdateState = { status: 'idle' };
  private availableRelease: MockRelease | null = null;
  private readonly listeners = new Set<(state: UpdateState) => void>();

  private readonly driver: UpdateDriver | null;

  constructor(private readonly options: (
    { readonly currentVersion: string; readonly feed: UpdateFeed }
    | { readonly driver: UpdateDriver }
  )) {
    this.driver = 'driver' in options ? options.driver : null;
    this.driver?.subscribe((event) => this.acceptDriverEvent(event));
  }

  getState(): UpdateState {
    return { ...this.state };
  }

  subscribe(listener: (state: UpdateState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async check(): Promise<UpdateCheckResult> {
    this.availableRelease = null;
    this.setState({ status: 'checking' });
    if (this.driver !== null) {
      try {
        await this.driver.checkForUpdates();
      } catch {
        this.setState({ status: 'error', message: 'Unable to check for updates.' });
      }
      return { state: this.getState() };
    }
    try {
      if (!('feed' in this.options)) return { state: this.getState() };
      const release = await this.options.feed.read();
      const comparison = compareVersions(release.version, this.options.currentVersion);
      if (comparison === 0 && release.channel === 'stable' && release.signatureStatus === 'verified') {
        this.setState({ status: 'idle', message: 'No updates are available.' });
        return { state: this.getState() };
      }
      const invalidReason = validateRelease(this.options.currentVersion, release);
      if (invalidReason !== null) {
        this.setState({ status: 'error', message: invalidReason });
        return { state: this.getState() };
      }
      this.availableRelease = release;
      this.setState({ status: 'available', version: release.version, notes: release.notes ?? '' });
      return { state: this.getState() };
    } catch {
      this.setState({ status: 'error', message: 'Unable to reach the configured update feed.' });
      return { state: this.getState() };
    }
  }

  async download(): Promise<UpdateCheckResult> {
    if (this.driver !== null) {
      if (this.state.status !== 'available') return { state: this.getState() };
      const { version, notes } = this.state;
      this.setState({ status: 'downloading', version, notes, progress: 0 });
      try {
        await this.driver.downloadUpdate();
      } catch {
        this.setState({ status: 'error', message: 'Unable to download the update.' });
      }
      return { state: this.getState() };
    }
    if (this.availableRelease === null) return { state: this.getState() };
    this.setState({ status: 'downloading', version: this.availableRelease.version, notes: this.availableRelease.notes ?? '', progress: 0 });
    // Mock-only: transition deterministically without creating files or reaching the network.
    this.setState({ status: 'ready_to_restart', version: this.availableRelease.version, notes: this.availableRelease.notes ?? '', progress: 1 });
    return { state: this.getState() };
  }

  defer(): UpdateCheckResult {
    this.availableRelease = null;
    this.setState({ status: 'idle', message: 'Update deferred.' });
    return { state: this.getState() };
  }

  async retry(): Promise<UpdateCheckResult> {
    return this.check();
  }

  async restart(): Promise<UpdateRestartResult> {
    if (this.driver !== null) {
      if (this.state.status !== 'ready_to_restart') return { accepted: false, reason: 'UPDATE_NOT_DOWNLOADED' };
      this.driver.quitAndInstall();
      return { accepted: true };
    }
    return { accepted: false, reason: 'REAL_INSTALL_DISABLED' };
  }

  private acceptDriverEvent(event: UpdateDriverEvent): void {
    if (event.type === 'checking') {
      if (this.state.status !== 'checking') this.setState({ status: 'checking' });
      return;
    }
    if (event.type === 'available') this.setState({ status: 'available', version: event.version, notes: event.notes ?? '' });
    else if (event.type === 'not-available') this.setState({ status: 'idle', message: 'No updates are available.' });
    else if (event.type === 'download-progress') this.setState({
      ...this.state,
      status: 'downloading',
      progress: Math.max(0, Math.min(1, event.percent / 100)),
    });
    else if (event.type === 'downloaded') this.setState({
      status: 'ready_to_restart', version: event.version, notes: event.notes ?? '', progress: 1,
    });
    else this.setState({ status: 'error', message: event.message.slice(0, 180) || 'Update failed.' });
  }

  private setState(state: UpdateState): void {
    this.state = state;
    const snapshot = this.getState();
    this.listeners.forEach((listener) => listener(snapshot));
  }
}

function validateRelease(currentVersion: string, release: MockRelease): string | null {
  if (release.channel !== 'stable') return 'Only stable releases are accepted.';
  if (release.signatureStatus !== 'verified') return 'The update signature could not be verified.';
  const comparison = compareVersions(release.version, currentVersion);
  if (comparison === null) return 'The update version is invalid.';
  if (comparison <= 0) return 'The update is not newer than the installed version.';
  return null;
}

function compareVersions(left: string, right: string): number | null {
  const leftParts = parseVersion(left);
  const rightParts = parseVersion(right);
  if (leftParts === null || rightParts === null) return null;
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index]! !== rightParts[index]!) return leftParts[index]! - rightParts[index]!;
  }
  return 0;
}

function parseVersion(value: string): readonly number[] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(value);
  return match === null ? null : match.slice(1).map(Number);
}
