import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createMcpRuntimeDescriptor,
  deleteMcpRuntimeFile,
  parseMcpRuntimeFile,
  readMcpRuntimeFile,
  writeMcpRuntimeFile,
} from './mcp-runtime-file.js';

describe('MCP runtime discovery file', () => {
  let root: string;
  let runtimeFilePath: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'canvasforge-mcp-runtime-'));
    runtimeFilePath = join(root, 'mcp', 'runtime-v1.json');
  });

  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });

  it('writes and reads an authenticated random named-pipe descriptor atomically', async () => {
    const descriptor = createMcpRuntimeDescriptor({
      instanceId: 'instance-1',
      processId: process.pid,
      serverVersion: '1.0.0',
      now: new Date('2026-08-07T02:00:00.000Z'),
      randomHex: 'aabbccddeeff0011',
      authToken: 'auth-1234567890',
    });

    await writeMcpRuntimeFile(runtimeFilePath, descriptor);

    await expect(readFile(`${runtimeFilePath}.tmp`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readMcpRuntimeFile(runtimeFilePath, {
      now: new Date('2026-08-07T02:01:00.000Z'),
      isProcessAlive: () => true,
    })).resolves.toEqual(descriptor);
    expect(descriptor.pipeName).toMatch(/^\\\\\.\\pipe\\canvasforge-mcp-instance-1-aabbccddeeff0011$/u);
    expect(JSON.stringify(descriptor)).not.toMatch(/apiKey|authorization|password|provider/iu);
  });

  it('rejects expired descriptors and stale processes', () => {
    const descriptor = createMcpRuntimeDescriptor({
      instanceId: 'instance-2',
      processId: 4242,
      serverVersion: '1.0.0',
      now: new Date('2026-08-07T02:00:00.000Z'),
      randomHex: '1122334455667788',
      authToken: 'auth-abcdefghij',
    });

    expect(() => parseMcpRuntimeFile(descriptor, {
      now: new Date('2026-08-07T02:16:00.000Z'),
      isProcessAlive: () => true,
    })).toThrow('MCP_RUNTIME_EXPIRED');
    expect(() => parseMcpRuntimeFile(descriptor, {
      now: new Date('2026-08-07T02:01:00.000Z'),
      isProcessAlive: () => false,
    })).toThrow('MCP_RUNTIME_STALE_PROCESS');
  });

  it('deletes the discovery file during clean shutdown', async () => {
    const descriptor = createMcpRuntimeDescriptor({ instanceId: 'instance-3', processId: process.pid, serverVersion: '1.0.0' });
    await writeMcpRuntimeFile(runtimeFilePath, descriptor);
    await deleteMcpRuntimeFile(runtimeFilePath);
    await expect(stat(runtimeFilePath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(deleteMcpRuntimeFile(runtimeFilePath)).resolves.toBeUndefined();
  });
});