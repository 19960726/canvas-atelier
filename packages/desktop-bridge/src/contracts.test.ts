import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
  AGENT_CANVAS_PRELOAD_KEY,
  createAgentCanvasApi,
  createDesktopPreloadApis,
} from './preload.js';
import type { DesktopBridgeInvoke } from '@agent-canvas/desktop-core/preload-api';
import { AGENT_CANVAS_CHANNELS } from './channels.js';

describe('agentCanvas preload compatibility bridge', () => {
  it('exposes a narrow typed history namespace without filesystem or destination arguments', async () => {
    const invoke = vi.fn(async () => ({ records: [], nextCursor: null, revision: 0, total: 0 })) as DesktopBridgeInvoke & ReturnType<typeof vi.fn>;
    const api = createAgentCanvasApi(invoke) as unknown as Record<string, unknown>;

    expect(api).toHaveProperty('history');
    const history = api.history as Record<string, (...args: unknown[]) => Promise<unknown>> | undefined;
    if (history === undefined) return;
    expect(Object.keys(history).sort()).toEqual([
      'addProjectReferences',
      'compare',
      'copyToProject',
      'exportSelected',
      'getCapacity',
      'getReusableSummary',
      'list',
      'permanentlyDelete',
      'purgeExpired',
      'restore',
      'setFavorite',
      'trash',
    ]);
    const listHistory = history.list;
    const exportHistory = history.exportSelected;
    if (listHistory === undefined || exportHistory === undefined) return;
    await listHistory({ pageSize: 25 });
    await exportHistory({ historyIds: ['history_aaaaaaaaaaaaaaaa'] });
    expect(invoke.mock.calls).toEqual([
      [expect.stringContaining(':history:list'), { pageSize: 25 }],
      [expect.stringContaining(':history:export-selected'), { historyIds: ['history_aaaaaaaaaaaaaaaa'] }],
    ]);
    expect(JSON.stringify(Object.keys(history))).not.toMatch(/path|file|directory|token|network|process|keychain/iu);
  });

  it('exposes exact modern namespaces without filesystem, process, keychain, or token getters', () => {
    const api = createAgentCanvasApi(vi.fn(async () => undefined) as DesktopBridgeInvoke);

    expect(AGENT_CANVAS_PRELOAD_KEY).toBe('agentCanvas');
    expect(Object.keys(api).sort()).toEqual(['assets', 'clipboard', 'history', 'project', 'provider', 'secrets', 'skill']);
    expect(Object.keys(api.clipboard).sort()).toEqual(['pasteImage']);
    expect(Object.keys(api.project).sort()).toEqual(['close', 'commit', 'open', 'recovery', 'restore', 'stable']);
    expect(Object.keys(api.assets).sort()).toEqual(['exportPack', 'importPack']);
    expect(Object.keys(api.provider).sort()).toEqual([
      'ackImageJobTerminal',
      'cancelImageJob',
      'listProfiles',
      'pollImageJob',
      'submitImageJob',
    ]);
    expect(Object.keys(api.skill).sort()).toEqual([
      'configureKnowledgeBase',
      'getKnowledgeState',
      'prepareSkillCandidateReview',
      'reviewSkillCandidate',
      'subscribeKnowledgeState',
      'subscribeKnowledgeSyncStatus',
    ]);
    expect(Object.keys(api.secrets).sort()).toEqual(['configureProvider', 'getProviderStatus', 'unlockProvider']);
    expect(JSON.stringify(Object.keys(api))).not.toMatch(/fs|process|keychain|token|getToken|readFile|providerCredential/i);
  });

  it('keeps close-flush lifecycle on novusDesktop only', () => {
    const send = vi.fn();
    const subscribe = vi.fn((_channel: string, _listener: (payload: unknown) => void) => () => undefined);
    const { novusDesktop, agentCanvas } = createDesktopPreloadApis(
      vi.fn(async () => undefined) as DesktopBridgeInvoke,
      subscribe,
      send,
    );

    expect(Object.keys(novusDesktop.lifecycle).sort()).toEqual([
      'ackCloseFlush',
      'chooseCloseDecision',
      'subscribeCloseFlushRequest',
    ]);
    expect(agentCanvas).not.toHaveProperty('lifecycle');
    expect(novusDesktop.lifecycle.ackCloseFlush({ requestId: 'close-request-123456', phase: 'save_started' })).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('maps modern namespaces to the same invoke and subscribe channels as novusDesktop', async () => {
    const invoke = vi.fn(async (channel: string) => {
      if (Object.values(AGENT_CANVAS_CHANNELS.provider).includes(channel as never)) {
        if (channel === AGENT_CANVAS_CHANNELS.provider.listProfiles) return { ok: true, value: [] };
        if (channel === AGENT_CANVAS_CHANNELS.provider.submitImageJob) {
          return { ok: true, value: { providerTaskId: 'provider-job-1234567890abcdef1234567890abcdef' } };
        }
        if (channel === AGENT_CANVAS_CHANNELS.provider.pollImageJob) return { ok: true, value: { status: 'running' } };
        if (channel === AGENT_CANVAS_CHANNELS.provider.cancelImageJob) return { ok: true, value: { status: 'cancelled' } };
        if (channel === AGENT_CANVAS_CHANNELS.provider.ackImageJobTerminal) return { ok: true, value: { acknowledged: true } };
      }
      if (Object.values(AGENT_CANVAS_CHANNELS.secrets).includes(channel as never)) {
        return { ok: true, value: { configured: true, locked: false, encryption: 'safeStorage' } };
      }
      return { channel };
    }) as DesktopBridgeInvoke & ReturnType<typeof vi.fn>;
    const unsubscribe = vi.fn();
    const subscribe = vi.fn((_channel: string, _listener: (payload: unknown) => void) => unsubscribe);
    const { novusDesktop, agentCanvas } = createDesktopPreloadApis(invoke, subscribe);

    await agentCanvas.project.open({ mode: 'write' });
    await novusDesktop.openProject({ mode: 'write' });
    await agentCanvas.project.stable({ sessionId: 'session-1' });
    await agentCanvas.project.recovery({ sessionId: 'session-1' });
    await agentCanvas.assets.importPack({ mode: 'write' });
    await agentCanvas.assets.exportPack({ sessionId: 'session-1' });
    await agentCanvas.provider.submitImageJob({
      jobId: 'job-1',
      provider: 'comfly',
      modelRoute: 'gpt-image',
      prompt: 'draw',
      conversationId: 'conversation-1',
      referenceAssetIds: [],
    });
    await agentCanvas.provider.ackImageJobTerminal({
      provider: 'comfly',
      providerTaskId: 'provider-job-1234567890abcdef1234567890abcdef',
      status: 'completed',
    });
    await agentCanvas.secrets.configureProvider({ token: 'sk-redacted' });

    const stopSkill = agentCanvas.skill.subscribeKnowledgeState(vi.fn());
    const stopLegacy = novusDesktop.subscribeKnowledgeState(vi.fn());
    stopSkill();
    stopLegacy();

    expect(invoke.mock.calls.map((call) => call[0])).toEqual([
      AGENT_CANVAS_CHANNELS.project.open,
      AGENT_CANVAS_CHANNELS.project.open,
      AGENT_CANVAS_CHANNELS.project.stable,
      AGENT_CANVAS_CHANNELS.project.recovery,
      AGENT_CANVAS_CHANNELS.assets.importPack,
      AGENT_CANVAS_CHANNELS.assets.exportPack,
      AGENT_CANVAS_CHANNELS.provider.submitImageJob,
      AGENT_CANVAS_CHANNELS.provider.ackImageJobTerminal,
      AGENT_CANVAS_CHANNELS.secrets.configureProvider,
    ]);
    expect(subscribe).toHaveBeenCalledWith(AGENT_CANVAS_CHANNELS.skill.knowledgeStateChanged, expect.any(Function));
    expect(unsubscribe).toHaveBeenCalledTimes(2);
  });

  it('keeps desktop-bridge preload-safe and reuses desktop-core contracts', async () => {
    for (const sourcePath of [
      join(process.cwd(), 'packages/desktop-bridge/src/preload.ts'),
      join(process.cwd(), 'packages/desktop-bridge/src/contracts.ts'),
      join(process.cwd(), 'packages/desktop-bridge/src/channels.ts'),
    ]) {
      const source = await readFile(sourcePath, 'utf8');
      expect(source).not.toMatch(/node:fs|node:crypto|provider-bridge|provider-comfly|safeStorage|keychain|process\./u);
    }
  });

  it('requires normal desktop preloads to expose both legacy and agentCanvas keys while safe preload stays recovery-only', async () => {
    for (const preloadPath of [
      join(process.cwd(), 'apps/desktop-modern/src/preload.ts'),
      join(process.cwd(), 'apps/desktop-legacy/src/preload.ts'),
    ]) {
      const source = await readFile(preloadPath, 'utf8');
      expect(source).toContain('DESKTOP_BRIDGE_PRELOAD_KEY');
      expect(source).toContain('AGENT_CANVAS_PRELOAD_KEY');
      expect(source).toContain('createDesktopPreloadApis');
    }

    for (const safePreloadPath of [
      join(process.cwd(), 'apps/desktop-modern/src/safe-preload.ts'),
      join(process.cwd(), 'apps/desktop-legacy/src/safe-preload.ts'),
    ]) {
      const source = await readFile(safePreloadPath, 'utf8');
      expect(source).toContain('createSafeModePreloadApi');
      expect(source).not.toContain('agentCanvas');
      expect(source).not.toContain('provider');
      expect(source).not.toContain('secrets');
      expect(source).not.toContain('subscribeCloseFlushRequest');
      expect(source).not.toContain('ackCloseFlush');
    }
  });
});
