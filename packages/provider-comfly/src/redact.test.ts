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

  it('redacts JSON-style credential fields in string provider logs', () => {
    const redacted = redactProviderLog([
      '{"apiKey":"camel-secret"}',
      '{"api_key":"snake-secret"}',
      '{"token":"token-secret"}',
      '{"secret":"plain-secret"}',
      '{"password":"password-secret"}',
    ].join('\n'));

    expect(redacted).toContain('[redacted-key]');
    expect(redacted).not.toContain('camel-secret');
    expect(redacted).not.toContain('snake-secret');
    expect(redacted).not.toContain('token-secret');
    expect(redacted).not.toContain('plain-secret');
    expect(redacted).not.toContain('password-secret');
  });

  it('redacts JSON-style credential fields after stringifying provider objects', () => {
    const redacted = redactProviderLog({
      error: {
        apiKey: 'object-secret',
        api_key: 'object-snake-secret',
        token: 'object-token-secret',
      },
      message: 'failed',
    });

    expect(redacted).toContain('[redacted-key]');
    expect(redacted).toContain('failed');
    expect(redacted).not.toContain('object-secret');
    expect(redacted).not.toContain('object-snake-secret');
    expect(redacted).not.toContain('object-token-secret');
  });

  it('redacts slash-style Windows absolute paths', () => {
    const redacted = redactProviderLog('failed to read C:/Users/alice/secret.png');

    expect(redacted).toContain('[redacted-path]');
    expect(redacted).not.toContain('alice');
    expect(redacted).not.toContain('secret.png');
  });
});
