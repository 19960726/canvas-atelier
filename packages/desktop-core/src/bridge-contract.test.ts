import { describe, expect, it, vi } from 'vitest';

import type { CommitRequest } from './contracts';
import { createDesktopBridgeHandlers } from './bridge-handlers';
import { createPreloadApi, type DesktopBridgeInvoke } from './preload-api';

describe('desktop bridge contract', () => {
  it('does not expose arbitrary filesystem methods', () => {
    const mockInvoke = vi.fn(async () => undefined) as DesktopBridgeInvoke;

    expect(Object.keys(createPreloadApi(mockInvoke)).sort()).toEqual([
      'closeProject',
      'commit',
      'createStablePoint',
      'exportPack',
      'getRecoveryPlan',
      'importPack',
      'openProject',
      'restore',
    ]);
  });

  it('rejects commits outside the active session', async () => {
    const handlers = createDesktopBridgeHandlers({
      repository: {
        close: vi.fn(async () => undefined),
      },
    });

    const request: CommitRequest & { readonly sessionId: string } = {
      baseRevision: 0,
      kind: 'canvas',
      projectId: 'project-1',
      sessionId: 'session-1',
      transaction: {
        id: 'tx-1',
        label: 'create prompt-1',
        operations: [
          {
            kind: 'canvas',
            operation: {
              kind: 'create_node',
              node: {
                id: 'prompt-1',
                type: 'prompt',
                position: { x: 0, y: 0 },
                data: { prompt: 'Prompt 1', requirementIds: [] },
              },
            },
          },
        ],
      },
    };

    await expect(
      handlers.commit({}, { ...request, sessionId: 'unknown' }),
    ).rejects.toMatchObject({ code: 'INVALID_SESSION' });
  });
});
