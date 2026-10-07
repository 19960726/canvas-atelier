import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { NodeFileSystem } from './file-system.js';
import { createProviderPendingMediaStore } from './provider-pending-media.js';
import type { ProviderTaskMappingRecord } from './provider-task-ledger.js';

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('paid provider media staging integrity', () => {
  it.each(['manifest', 'media'] as const)('treats a tampered %s path as a terminal uncertain result', async (target) => {
    const appDataRoot = await mkdtemp(join(tmpdir(), 'provider-pending-media-path-'));
    temporaryRoots.push(appDataRoot);
    const publicTaskId = `provider-job-${'a'.repeat(32)}`;
    const tamperedPath = join(appDataRoot, `provider-pending-media-${publicTaskId}${target === 'manifest' ? '.json' : '-0.bin'}`);
    let tampered = false;
    class TamperAwareFileSystem extends NodeFileSystem {
      override async lstat(path: string) {
        const stat = await super.lstat(path);
        return tampered && path === tamperedPath ? Object.assign(stat, { isSymbolicLink: () => true }) : stat;
      }
    }
    const store = createProviderPendingMediaStore({
      appDataRoot,
      fileSystem: new TamperAwareFileSystem(),
      secretSupplier: async () => ({ primary: 'fixture-mapping-secret', fallback: [] }),
    });
    const record: ProviderTaskMappingRecord = {
      provider: 'comfly', kind: 'video', publicTaskId, rawTaskId: 'paid-video-task',
      state: 'running', createdAt: '2026-09-28T08:00:00.000Z', updatedAt: '2026-09-28T08:00:00.000Z',
    };
    const bytes = Uint8Array.from([0, 0, 0, 12, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
    const entry = await store.writeItem(record, 0, bytes);
    await store.seal(record, [entry]);
    const manifest = await store.read(record);
    expect(manifest).not.toBeNull();

    tampered = true;
    const read = target === 'manifest' ? store.read(record) : store.readItem(manifest!, 0);
    await expect(read).rejects.toMatchObject({
      code: 'PROVIDER_INVALID_RESPONSE', retryable: false, message: expect.stringContaining('提交状态不确定'),
    });
  });
});
