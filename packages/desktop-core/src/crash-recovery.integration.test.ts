import { describe, expect, it } from 'vitest';

import { CRASH_POINTS, runCrashScenario, sanitizeChildError } from './test/crash-child';

describe('desktop persistence crash recovery', () => {
  it.each(CRASH_POINTS)(
    'recovers only acknowledged transactions after %s',
    async (point) => {
      const result = await runCrashScenario(point);

      expect(result.recoveredRevision).toBe(result.lastAcknowledgedRevision);
      expect(result.partialTransactionApplied).toBe(false);
      expect(result.recoveredNodeIds).not.toContain('node-unacknowledged');
    },
    20_000,
  );

  it('redacts Windows file URLs from child errors', () => {
    const sanitized = sanitizeChildError('at file:///E:/private/workspace/crash-child.ts:10:2');
    expect(sanitized).not.toContain('private');
    expect(sanitized).toContain('[REDACTED_PATH]');
  });
});
