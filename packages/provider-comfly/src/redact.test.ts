import { describe, expect, it } from 'vitest';
import { redactProviderLog } from './redact';

describe('redactProviderLog', () => {
  it('redacts authorization, api keys, file paths, and inline image bodies', () => {
    const raw = [
      'Authorization: Bearer secret-token',
      'api_key=abc123-secret',
      'file:///E:/画布项目/demo/project.novus.json',
      'C:\\Users\\alice\\secret\\scene.png',
      'data:image/png;base64,QUJDREVGR0g=',
    ].join('\n');

    const redacted = redactProviderLog(raw);

    expect(redacted).toContain('[redacted-auth]');
    expect(redacted).toContain('[redacted-key]');
    expect(redacted).toContain('[redacted-path]');
    expect(redacted).toContain('[redacted-image]');
    expect(redacted).not.toContain('secret-token');
    expect(redacted).not.toContain('alice');
    expect(redacted).not.toContain('data:image/png;base64');
  });

  it('redacts long raw base64 blobs even when they are not data URLs', () => {
    const raw = Buffer.alloc(72, 7).toString('base64');
    expect(redactProviderLog(raw)).toBe('[redacted-base64]');
  });
});
