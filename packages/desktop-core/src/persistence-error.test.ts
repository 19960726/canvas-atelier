import { describe, expect, it } from 'vitest';

import { normalizePersistenceError } from './journal-writer';

describe('persistence error normalization', () => {
  it.each([
    ['ENOSPC', 'DISK_FULL', true],
    ['EACCES', 'PERMISSION_DENIED', true],
    ['EPERM', 'PERMISSION_DENIED', true],
    ['EROFS', 'READ_ONLY_VOLUME', false],
  ] as const)('maps %s to a typed sanitized error', (errno, code, retryable) => {
    const privatePath = ['C:', 'Users', 'Private', 'Novus', 'project.novus.json']
      .join(String.fromCharCode(92));
    const authorizationHeader = ['Author', 'ization:', ' Bearer ', 'secret'].join('');
    const source = Object.assign(
      new Error(`write failed at ${privatePath} ${authorizationHeader}`),
      { code: errno, path: privatePath },
    );

    const error = normalizePersistenceError(source, 'Project durable write failed');

    expect(error).toMatchObject({ code, retryable });
    expect(error.message).toMatch(/^Project durable write failed:/u);
    expect(JSON.stringify(error)).not.toContain(privatePath);
    expect(JSON.stringify(error)).not.toContain(authorizationHeader);
  });

  it('maps unknown filesystem failures to a generic typed sanitized error', () => {
    const privatePath = ['D:', 'Private', 'Novus', 'project.novus.json']
      .join(String.fromCharCode(92));
    const source = Object.assign(new Error(`unexpected I/O failure at ${privatePath}`), {
      code: 'EIO',
      path: privatePath,
    });

    const error = normalizePersistenceError(source, 'Project durable write failed');

    expect(error).toMatchObject({ code: 'DURABLE_WRITE_FAILED', retryable: true });
    expect(error.message).toBe('Project durable write failed: durable storage operation failed');
    expect(JSON.stringify(error)).not.toContain(privatePath);
  });
});
