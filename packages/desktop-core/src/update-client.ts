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
  readonly accepted: false;
  readonly reason: 'REAL_INSTALL_DISABLED';
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

  constructor(private readonly options: { readonly currentVersion: string; readonly feed: UpdateFeed }) {}

  getState(): UpdateState {
    return { ...this.state };
  }

  async check(): Promise<UpdateCheckResult> {
    this.availableRelease = null;
    this.state = { status: 'checking' };
    try {
      const release = await this.options.feed.read();
      const comparison = compareVersions(release.version, this.options.currentVersion);
      if (comparison === 0 && release.channel === 'stable' && release.signatureStatus === 'verified') {
        this.state = { status: 'idle', message: 'No updates are available.' };
        return { state: this.getState() };
      }
      const invalidReason = validateRelease(this.options.currentVersion, release);
      if (invalidReason !== null) {
        this.state = { status: 'error', message: invalidReason };
        return { state: this.getState() };
      }
      this.availableRelease = release;
      this.state = { status: 'available', version: release.version, notes: release.notes ?? '' };
      return { state: this.getState() };
    } catch {
      this.state = { status: 'error', message: 'Unable to reach the configured update feed.' };
      return { state: this.getState() };
    }
  }

  async download(): Promise<UpdateCheckResult> {
    if (this.availableRelease === null) return { state: this.getState() };
    this.state = { status: 'downloading', version: this.availableRelease.version, notes: this.availableRelease.notes ?? '', progress: 0 };
    // Mock-only: transition deterministically without creating files or reaching the network.
    this.state = { status: 'ready_to_restart', version: this.availableRelease.version, notes: this.availableRelease.notes ?? '', progress: 1 };
    return { state: this.getState() };
  }

  defer(): UpdateCheckResult {
    this.availableRelease = null;
    this.state = { status: 'idle', message: 'Update deferred.' };
    return { state: this.getState() };
  }

  async retry(): Promise<UpdateCheckResult> {
    return this.check();
  }

  async restart(): Promise<UpdateRestartResult> {
    return { accepted: false, reason: 'REAL_INSTALL_DISABLED' };
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
