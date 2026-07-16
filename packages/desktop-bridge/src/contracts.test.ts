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
  it('exposes exact modern namespaces without filesystem, process, keychain, or token getters', () => {
    const api = createAgentCanvasApi(vi.fn(async () => undefined) as DesktopBridgeInvoke);

    expect(AGENT_CANVAS_PRELOAD_KEY).toBe('agentCanvas');
    expect(Object.keys(api).sort()).toEqual(['assets', 'project', 'provider', 'secrets', 'skill']);
    expect(Object.keys(api.project).sort()).toEqual(['close', 'commit', 'open', 'recovery', 'restore', 'stable']);
    expect(Object.keys(api.assets).sort()).toEqual(['exportPack', 'importPack']);
    expect(Object.keys(api.provider).sort()).toEqual(['cancelImageJob', 'listProfiles', 'pollImageJob', 'submitImageJob']);
    expect(Object.keys(api.skill).sort()).toEqual([
      'configureKnowledgeBase',
      'getKnowledgeState',
      'reviewSkillCandidate',
      'subscribeKnowledgeState',
      'subscribeKnowledgeSyncStatus',
    ]);
    expect(Object.keys(api.secrets).sort()).toEqual(['configureProvider', 'getProviderStatus', 'unlockProvider']);
    expect(JSON.stringify(Object.keys(api))).not.toMatch(/fs|process|keychain|token|getToken|readFile|providerCredential/i);
  });

  it('maps modern namespaces to the same invoke and subscribe channels as novusDesktop', async () => {
    const invoke = vi.fn(async (channel: string) => ({ channel })) as DesktopBridgeInvoke & ReturnType<typeof vi.fn>;
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
    }
  });
});
