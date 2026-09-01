import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import { createRendererCloseFlushCoordinator } from '@agent-canvas/desktop-core';

describe('modern desktop close coordinator', () => {
  it('prevents the first window close, sends one renderer flush request, then closes projects after ACK', async () => {
    const calls: string[] = [];
    const coordinator = createRendererCloseFlushCoordinator({
      closeAllProjects: vi.fn(async () => {
        calls.push('closeAllProjects');
      }),
      createRequestId: () => 'modern-close-request-1',
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
    expect(calls).toEqual(['send:modern-close-request-1']);

    await coordinator.handleCloseFlushAck({ requestId: 'modern-close-request-1', phase: 'save_started' });
    await coordinator.handleCloseFlushAck({ requestId: 'modern-close-request-1', phase: 'completed', outcome: 'saved' });
    await closing;

    expect(calls).toEqual(['send:modern-close-request-1', 'closeAllProjects', 'finalize:saved']);
  });

  it('wires main window close and before-quit through the renderer close-flush request/ack channels', async () => {
    const source = await readFile(join(process.cwd(), 'apps/desktop-modern/src/main.ts'), 'utf8');

    expect(source).toContain('createRendererCloseFlushCoordinator');
    expect(source).toContain('BRIDGE_CHANNELS.closeFlushRequest');
    expect(source).toContain('BRIDGE_CHANNELS.closeFlushAck');
    expect(source).toContain("window.on('close'");
    expect(source).toContain("app.on('before-quit'");
    expect(source).toContain('requestCoordinatedClose');
    expect(source).toContain('onCloseBlocked: showCloseRecoveryChoice');
    expect(source).toContain('放弃未保存更改并退出');
    expect(source).not.toContain('关闭未命名工作流');
    expect(source).not.toContain("buttons: ['保存', '不保存', '取消']");
    expect(source).toContain("return 'save';");
  });

  it('keeps project image selection and asset resolution in the main process', async () => {
    const source = await readFile(join(process.cwd(), 'apps/desktop-modern/src/main.ts'), 'utf8');

    expect(source).toContain('protocol.registerSchemesAsPrivileged');
    expect(source).toContain("protocol.handle('novus-asset'");
    expect(source).toContain("protocol.handle('novus-history'");
    expect(source).toContain('net.fetch(pathToFileURL(path).toString()');
    expect(source).toContain('resolveProtocolFile(request, handlers.resolveProjectImagePath)');
    expect(source).toContain('async chooseProjectImage()');
    expect(source).toContain("properties: ['openFile']");
  });
});
