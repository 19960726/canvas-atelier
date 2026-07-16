import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import { createRendererCloseFlushCoordinator } from '@agent-canvas/desktop-core';

describe('legacy desktop close coordinator', () => {
  it('prevents the first window close, sends one renderer flush request, then closes projects after ACK', async () => {
    const calls: string[] = [];
    const coordinator = createRendererCloseFlushCoordinator({
      closeAllProjects: vi.fn(async () => {
        calls.push('closeAllProjects');
      }),
      createRequestId: () => 'legacy-close-request-1',
      finalizeClose: vi.fn((reason) => {
        calls.push(`finalize:${reason}`);
      }),
      sendCloseFlushRequest: vi.fn((request) => {
        calls.push(`send:${request.requestId}`);
        return true;
      }),
    });
    const closeEvent = { preventDefault: vi.fn() };

    const closing = coordinator.requestClose(closeEvent);
    const duplicate = coordinator.requestClose({ preventDefault: vi.fn() });

    expect(duplicate).toBe(closing);
    expect(closeEvent.preventDefault).toHaveBeenCalledOnce();
    expect(calls).toEqual(['send:legacy-close-request-1']);

    await coordinator.handleCloseFlushAck({ requestId: 'legacy-close-request-1', ok: true });
    await closing;

    expect(calls).toEqual(['send:legacy-close-request-1', 'closeAllProjects', 'finalize:ack']);
  });

  it('wires main window close and before-quit through the renderer close-flush request/ack channels', async () => {
    const source = await readFile(join(process.cwd(), 'apps/desktop-legacy/src/main.ts'), 'utf8');

    expect(source).toContain('createRendererCloseFlushCoordinator');
    expect(source).toContain('BRIDGE_CHANNELS.closeFlushRequest');
    expect(source).toContain('BRIDGE_CHANNELS.closeFlushAck');
    expect(source).toContain("window.on('close'");
    expect(source).toContain("app.on('before-quit'");
    expect(source).toContain('requestCoordinatedClose');
  });
});
