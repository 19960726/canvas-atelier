import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe.each(['desktop-legacy', 'desktop-modern'])('%s sync lifecycle wiring', (shell) => {
  it('forwards events and hydrates retained pull status through the narrow bridge', async () => {
    const source = await readFile(resolve(process.cwd(), 'apps', shell, 'src', 'main.ts'), 'utf8');
    expect(source).toContain('subscribeSyncStatus');
    expect(source).toContain('BRIDGE_CHANNELS.knowledgeSyncStatusChanged');
    expect(source).toContain('knowledgeSyncStatusProvider: approvedSnapshotPullCoordinator');
    expect(source).toContain('knowledgeConfigurationSync: approvedSnapshotPullCoordinator');
    expect(source.indexOf('await approvedSnapshotPullCoordinator.start'))
      .toBeLessThan(source.indexOf('await createMainWindow'));
  });

  it('routes teardown through rejection-isolated shutdown that always quits', async () => {
    const source = await readFile(resolve(process.cwd(), 'apps', shell, 'src', 'main.ts'), 'utf8');
    expect(source).toContain('shutdownDesktopServices');
    expect(source).toContain('stopApprovedSnapshotDrain');
    expect(source).toContain('stopApprovedSnapshotPull');
    expect(source).toContain('stopKnowledgeRefresh');
  });
});
