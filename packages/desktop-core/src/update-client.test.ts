import { describe, expect, it } from 'vitest';

import { MockReleaseFeed, UpdateClient } from './update-client.js';

describe('UpdateClient', () => {
  it('accepts only a newer signed stable mock release and moves through download readiness without installing', async () => {
    const client = new UpdateClient({
      currentVersion: '1.4.0',
      feed: new MockReleaseFeed({ channel: 'stable', version: '1.5.0', notes: 'Canvas reliability improvements.', signatureStatus: 'verified' }),
    });

    expect((await client.check()).state).toMatchObject({ status: 'available', version: '1.5.0' });
    expect((await client.download()).state).toMatchObject({ status: 'ready_to_restart', version: '1.5.0', progress: 1 });
    expect(await client.restart()).toMatchObject({ accepted: false, reason: 'REAL_INSTALL_DISABLED' });
  });

  it('reports no update for the installed version and rejects downgrade, non-stable, and unsigned releases', async () => {
    const noUpdate = new UpdateClient({
      currentVersion: '1.4.0',
      feed: new MockReleaseFeed({ channel: 'stable', version: '1.4.0', signatureStatus: 'verified' }),
    });
    expect((await noUpdate.check()).state).toMatchObject({ status: 'idle', message: 'No updates are available.' });

    for (const release of [
      { channel: 'stable' as const, version: '1.3.9', signatureStatus: 'verified' as const },
      { channel: 'beta' as const, version: '1.5.0', signatureStatus: 'verified' as const },
      { channel: 'stable' as const, version: '1.5.0', signatureStatus: 'invalid' as const },
    ]) {
      const client = new UpdateClient({ currentVersion: '1.4.0', feed: new MockReleaseFeed(release) });
      expect((await client.check()).state.status).toBe('error');
      expect((await client.download()).state.status).toBe('error');
    }
  });
});
