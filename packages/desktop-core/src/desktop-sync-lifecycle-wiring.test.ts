import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe.each(['desktop-legacy', 'desktop-modern'])('%s sync lifecycle wiring', (shell) => {
  it('forwards the pull coordinator sync status on the narrow bridge channel', async () => {
    const source = await readFile(resolve(process.cwd(), 'apps', shell, 'src', 'main.ts'), 'utf8');
    expect(source).toContain('subscribeSyncStatus');
    expect(source).toContain('BRIDGE_CHANNELS.knowledgeSyncStatusChanged');
  });
});