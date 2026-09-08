import { describe, expect, it } from 'vitest';

import {
  capturePersistenceIpcResult,
  decodePersistenceIpcResult,
  unwrapPersistenceIpcResult,
} from './persistence-ipc-envelope';

describe('persistence IPC envelope', () => {
  it('preserves a typed disk-full failure across Electron structured cloning', async () => {
    const envelope = await capturePersistenceIpcResult(async () => {
      throw Object.assign(new Error('private native path'), { code: 'DISK_FULL', retryable: true });
    });
    const cloned = structuredClone(envelope);

    expect(() => unwrapPersistenceIpcResult(cloned)).toThrowError(
      expect.objectContaining({ code: 'DISK_FULL', retryable: true }),
    );
    expect(JSON.stringify(cloned)).not.toContain('private native path');
    expect(decodePersistenceIpcResult(cloned)).toEqual({
      error: { code: 'DISK_FULL', retryable: true },
      ok: false,
    });
  });

  it('passes successful commit acknowledgements through the envelope', async () => {
    const ack = { committedBytes: 12, revision: 4, sequence: 4 };
    const envelope = await capturePersistenceIpcResult(async () => ack);

    expect(unwrapPersistenceIpcResult(structuredClone(envelope))).toEqual(ack);
  });

  it('fails closed when the IPC payload is malformed or the code is unknown', async () => {
    const envelope = await capturePersistenceIpcResult(async () => {
      throw Object.assign(new Error('unexpected'), { code: 'SOMETHING_PRIVATE', retryable: false });
    });

    expect(() => unwrapPersistenceIpcResult(envelope)).toThrowError(
      expect.objectContaining({ code: 'DURABLE_WRITE_FAILED', retryable: false }),
    );
    expect(() => unwrapPersistenceIpcResult({ ok: true })).toThrowError(
      expect.objectContaining({ code: 'INVALID_REQUEST', retryable: false }),
    );
  });
});
