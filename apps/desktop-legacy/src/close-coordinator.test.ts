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

    await coordinator.handleCloseFlushAck({ requestId: 'legacy-close-request-1', phase: 'save_started' });
    await coordinator.handleCloseFlushAck({ requestId: 'legacy-close-request-1', phase: 'completed', outcome: 'saved' });
    await closing;

    expect(calls).toEqual(['send:legacy-close-request-1', 'closeAllProjects', 'finalize:saved']);
  });

  it('keeps the window open after a project-close failure and permits a later retry', async () => {
    const closeAllProjects = vi.fn()
      .mockRejectedValueOnce(new Error('project close failed'))
      .mockResolvedValueOnce(undefined);
    const finalizeClose = vi.fn();
    const onCloseBlocked = vi.fn(async () => 'cancel' as const);
    const requestIds = ['legacy-close-request-failed', 'legacy-close-request-retry'];
    const coordinator = createRendererCloseFlushCoordinator({
      closeAllProjects,
      createRequestId: () => requestIds.shift() ?? 'legacy-close-request-fallback',
      finalizeClose,
      onCloseBlocked,
      sendCloseFlushRequest: () => true,
    });

    const failedClose = coordinator.requestClose({ preventDefault: vi.fn() });
    await coordinator.handleCloseFlushAck({
      requestId: 'legacy-close-request-failed',
      phase: 'completed',
      outcome: 'saved',
    });
    await failedClose;

    expect(closeAllProjects).toHaveBeenCalledOnce();
    expect(finalizeClose).not.toHaveBeenCalled();
    expect(onCloseBlocked).toHaveBeenCalledWith('failed');

    const retriedClose = coordinator.requestClose({ preventDefault: vi.fn() });
    await coordinator.handleCloseFlushAck({
      requestId: 'legacy-close-request-retry',
      phase: 'completed',
      outcome: 'saved',
    });
    await retriedClose;

    expect(closeAllProjects).toHaveBeenCalledTimes(2);
    expect(finalizeClose).toHaveBeenCalledOnce();
    expect(finalizeClose).toHaveBeenCalledWith('saved');
  });

  it('wires main window close and before-quit through the renderer close-flush request/ack channels', async () => {
    const source = await readFile(join(process.cwd(), 'apps/desktop-legacy/src/main.ts'), 'utf8');

    expect(source).toContain('createRendererCloseFlushCoordinator');
    expect(source).toContain('BRIDGE_CHANNELS.closeFlushRequest');
    expect(source).toContain('BRIDGE_CHANNELS.closeFlushAck');
    expect(source).toContain('BRIDGE_CHANNELS.closeFlushAborted');
    expect(source).toContain("window.on('close'");
    expect(source).toContain("app.on('before-quit'");
    expect(source).toContain('requestCoordinatedClose');
    expect(source).toContain('onCloseBlocked: showCloseRecoveryChoice');
    expect(source).toContain('onCloseAttemptAborted: resetAbortedCloseAttempt');
    expect(source).toContain('onCloseFlushAckAccepted: recordAcceptedCloseFlushAck');
    expect(source).toContain('onCloseFlushAborted: sendRendererCloseFlushAborted');
    expect(source).toContain('selectCloseFinalizeTarget');
    expect(source).toMatch(/function prepareCoordinatedClose[\s\S]*?hasPendingCloseAttempt\(\)[\s\S]*?selectCloseFinalizeTarget/u);
    expect(source.match(/prepareCoordinatedClose\('window'\)/gu)).toHaveLength(1);
    expect(source).toContain('prepareCoordinatedClose(target);');
    expect(source).toMatch(/function resetAbortedCloseAttempt[\s\S]*?closeFinalizeTarget = 'window';[\s\S]*?closeFlushErrorCode = null;/u);
    expect(source).toMatch(/function sendRendererCloseFlushAborted[\s\S]*?BRIDGE_CHANNELS\.closeFlushAborted/u);
    expect(source).toContain('放弃未保存更改并退出');
    expect(source).not.toContain('关闭未命名工作流');
    expect(source).not.toContain("buttons: ['保存', '不保存', '取消']");
    expect(source).toContain("return 'save';");
    expect(source).not.toContain('const ack = parseCloseFlushAck(payload)');
  });

  it('awaits the durable project close before best-effort service shutdown and resets the retry latch on failure', async () => {
    const source = await readFile(join(process.cwd(), 'apps/desktop-legacy/src/main.ts'), 'utf8');
    const shutdownFunction = source.match(
      /async function runCoordinatedShutdown[\s\S]*?\r?\n\}\r?\n\r?\nfunction finalizeCoordinatedClose/u,
    )?.[0];

    expect(shutdownFunction).toBeDefined();
    expect(shutdownFunction).toMatch(/try\s*\{[\s\S]*await handlers\.closeAllProjects\(\{ flush: reason !== 'discarded' \}\);[\s\S]*await shutdownDesktopServices/u);
    expect(shutdownFunction).toContain('closeAllProjects: () => undefined');
    expect(shutdownFunction).toContain('stopMcpRuntime,');
    expect(shutdownFunction).toMatch(/catch \(error\)\s*\{\s*closeAllStarted = false;\s*throw error;/u);
    expect(shutdownFunction).not.toContain('closeAllProjects: () => handlers.closeAllProjects()');
  });

  it('keeps project image selection and asset resolution in the main process', async () => {
    const source = await readFile(join(process.cwd(), 'apps/desktop-legacy/src/main.ts'), 'utf8');

    expect(source).toContain('protocol.registerSchemesAsPrivileged');
    expect(source).toContain("protocol.registerFileProtocol('novus-asset'");
    expect(source).toContain("protocol.registerFileProtocol('novus-history'");
    expect(source).toContain('handlers.resolveProjectImagePath(request.url)');
    expect(source).toContain('async chooseProjectImage()');
    expect(source).toContain("properties: ['openFile']");
  });
});
