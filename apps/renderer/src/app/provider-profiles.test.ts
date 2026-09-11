import { describe, expect, it, vi } from 'vitest';
import type { ProviderBridgeProfile } from '@agent-canvas/desktop-core';

import { buildCanvasProviderRouteSets, filterProviderCatalogProfiles, listActiveProviderProfiles, listAllProviderProfiles, listRunnableProviderProfiles, listAgentChatProfiles, listCodexAgentProfiles, selectFirstProfileForCapability, selectGenerationProviderProfile, selectProviderProfile, selectReverseProviderProfile } from './provider-profiles';
import { PROVIDER_MODEL_DEFAULTS_STORAGE_KEY, writeProviderModelDefaults } from '../settings/provider-model-defaults';
import { defaultGenerationPreferences, resolveGenerationPreference } from '../agent/generation-preferences';

type ProviderId = 'comfly' | 'relayme' | 'julun' | '4dai';

describe('active provider model boundary', () => {
  const profiles = [
    { provider: 'comfly' as const, modelRoute: 'comfly/chat', displayName: 'Comfly Chat', capabilities: ['chat' as const] },
    { provider: 'relayme' as const, modelRoute: 'relay/chat', displayName: 'Relay Chat', capabilities: ['chat' as const] },
    { provider: 'relayme' as const, modelRoute: 'relay/image', displayName: 'Relay Image', capabilities: ['image_generation' as const] },
  ];

  it('returns only the active provider inventory and nothing when no provider is active', () => {
    expect(listActiveProviderProfiles(profiles, 'relayme').map((profile) => profile.modelRoute)).toEqual([
      'relay/chat',
      'relay/image',
    ]);
    expect(listActiveProviderProfiles(profiles, null)).toEqual([]);
  });

  it('selects the first model by declared capability rather than model-name heuristics', () => {
    expect(selectFirstProfileForCapability(profiles, 'image_generation')).toEqual(
      expect.objectContaining({ provider: 'relayme', modelRoute: 'relay/image' }),
    );
    expect(selectFirstProfileForCapability(profiles, 'video_generation')).toBeUndefined();
  });
});

describe('canvas provider route sets', () => {
  it('uses the saved provider default for Canvas and Agent execution after family sorting', () => {
    const profiles: ProviderBridgeProfile[] = [{
      provider: 'comfly',
      modelRoute: 'comfly-gpt-image-2',
      modelId: 'gpt-image-2',
      displayName: 'GPT Image 2',
      capabilities: ['image_generation'],
      capabilityStatus: 'complete',
    }, {
      provider: 'comfly',
      modelRoute: 'comfly-studio-image',
      modelId: 'studio-image',
      displayName: 'Studio Image',
      capabilities: ['image_generation'],
      capabilityStatus: 'complete',
    }];
    localStorage.removeItem(PROVIDER_MODEL_DEFAULTS_STORAGE_KEY);
    writeProviderModelDefaults('comfly', { image_generation: 'comfly-studio-image' });
    try {
      expect(buildCanvasProviderRouteSets(profiles).imageGeneration[0]?.modelRoute).toBe('comfly-studio-image');
      expect(selectGenerationProviderProfile(profiles, {}, 'image_generation')?.modelRoute).toBe('comfly-studio-image');
      expect(resolveGenerationPreference('image', defaultGenerationPreferences(), profiles).profile.modelRoute)
        .toBe('comfly-studio-image');
    } finally {
      localStorage.removeItem(PROVIDER_MODEL_DEFAULTS_STORAGE_KEY);
    }
  });

  it('keeps the preferred provider ahead of globally pinned model families', () => {
    const routes = buildCanvasProviderRouteSets([{
      provider: '4dai',
      modelRoute: '4dai-gpt-image-1-5',
      modelId: 'gpt-image-1.5',
      displayName: 'GPT Image 1.5',
      capabilities: ['image_generation'],
      capabilityStatus: 'complete',
    }, {
      provider: 'comfly',
      modelRoute: 'comfly-gpt-image-2',
      modelId: 'gpt-image-2',
      displayName: 'GPT Image 2',
      capabilities: ['image_generation'],
      capabilityStatus: 'complete',
    }]);

    expect(routes.imageGeneration.map((profile) => profile.modelRoute)).toEqual([
      '4dai-gpt-image-1-5',
      'comfly-gpt-image-2',
    ]);
  });

  it('keeps visual reverse routes even when a provider also advertises generation capabilities', () => {
    const routes = buildCanvasProviderRouteSets([
      {
        provider: 'relayme',
        modelRoute: 'relay/vision-plus',
        modelId: 'vision-plus',
        displayName: 'Vision Plus',
        capabilities: ['chat', 'vision', 'reverse_prompt', 'image_generation'],
      },
    ]);

    expect(routes.reversePrompt).toEqual([
      expect.objectContaining({ modelRoute: 'relay/vision-plus' }),
    ]);
  });

  it('keeps a RelayMe dialogue reverse route visible when vision metadata is absent', () => {
    const routes = buildCanvasProviderRouteSets([{
      provider: 'relayme', modelRoute: 'relayme/dialogue-default', modelId: 'dialogue-default',
      displayName: 'Dialogue Default', capabilities: ['chat', 'reverse_prompt'], capabilityStatus: 'complete',
    }]);

    expect(routes.reversePrompt).toEqual([
      expect.objectContaining({ provider: 'relayme', modelRoute: 'relayme/dialogue-default' }),
    ]);
  });

  it('uses vision-capable dialogue models for reverse analysis even without a derived reverse tag', () => {
    const routes = buildCanvasProviderRouteSets([{
      provider: 'comfly', modelRoute: 'comfly/vision-chat', modelId: 'vision-chat', displayName: 'Vision Chat',
      capabilities: ['chat', 'vision'],
    }]);

    expect(routes.reversePrompt).toEqual([
      expect.objectContaining({ modelRoute: 'comfly/vision-chat' }),
    ]);
  });

  it('does not expose vision-only routes that cannot receive a dialogue request', () => {
    const routes = buildCanvasProviderRouteSets([{
      provider: 'comfly', modelRoute: 'comfly/vision-only', modelId: 'vision-only', displayName: 'Vision Only',
      capabilities: ['vision'],
    }]);

    expect(routes.reversePrompt).toEqual([]);
  });

  it('exposes reverse routes only when the implemented transport can receive the image dialogue', () => {
    const routes = buildCanvasProviderRouteSets([{
      provider: 'comfly', modelRoute: 'comfly/responses-vision', modelId: 'responses-vision', displayName: 'Responses Vision',
      capabilities: ['responses', 'vision', 'reverse_prompt'],
    }, {
      provider: '4dai', modelRoute: '4dai/chat-vision', modelId: 'chat-vision', displayName: 'Chat Vision',
      capabilities: ['chat', 'vision', 'reverse_prompt'],
    }, {
      provider: 'comfly', modelRoute: 'comfly/gemini-native', modelId: 'gemini-native', displayName: 'Gemini Native',
      capabilities: ['gemini_native', 'reverse_prompt'],
    }]);

    const reverseRoutes = routes.reversePrompt.map((profile) => profile.modelRoute);
    expect(reverseRoutes).toHaveLength(2);
    expect(reverseRoutes).toEqual(expect.arrayContaining([
      '4dai/chat-vision',
      'comfly/gemini-native',
    ]));
    expect(reverseRoutes).not.toContain('comfly/responses-vision');
  });

  it('does not replace an explicitly selected unsupported reverse route with another model from the same provider', () => {
    const profiles: ProviderBridgeProfile[] = [{
      provider: '4dai', modelRoute: '4dai/responses-vision', modelId: 'responses-vision', displayName: 'Responses Vision',
      capabilities: ['responses', 'vision', 'reverse_prompt'],
    }, {
      provider: '4dai', modelRoute: '4dai/chat-vision', modelId: 'chat-vision', displayName: 'Chat Vision',
      capabilities: ['chat', 'vision', 'reverse_prompt'],
    }];

    expect(selectReverseProviderProfile(profiles, {
      provider: '4dai',
      modelRoute: '4dai/responses-vision',
    })).toBeUndefined();
  });

  it('builds reverse routes from the supplied dialogue catalog', () => {
    const routes = buildCanvasProviderRouteSets([
      {
        provider: 'relayme', modelRoute: 'relay/image-only', modelId: 'image-only', displayName: 'Nano Banana Pro',
        capabilities: ['image_generation'],
      },
    ], [
      {
        provider: 'comfly', modelRoute: 'comfly/vision-chat', modelId: 'vision-chat', displayName: 'Vision Chat',
        capabilities: ['chat', 'vision'],
      },
    ]);

    expect(routes.imageGeneration).toEqual([
      expect.objectContaining({ modelRoute: 'relay/image-only' }),
    ]);
    expect(routes.reversePrompt).toEqual([
      expect.objectContaining({ modelRoute: 'comfly/vision-chat' }),
    ]);
  });

  it('keeps the same visible generation model once per provider', () => {
    const routes = buildCanvasProviderRouteSets([
      {
        provider: 'comfly',
        modelRoute: 'comfly-nano-banana-pro-2k',
        modelId: 'nano-banana-pro',
        displayName: 'Nano Banana Pro',
        capabilities: ['image_generation'],
      },
      {
        provider: 'relayme',
        modelRoute: 'relayme-gemini-3-pro-image-preview',
        modelId: 'gemini-3-pro-image-preview',
        displayName: 'Nano Banana Pro',
        capabilities: ['image_generation', 'async_tasks'],
      },
    ]);

    expect(routes.imageGeneration).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'comfly', modelRoute: 'comfly-nano-banana-pro-2k' }),
      expect.objectContaining({ provider: 'relayme', modelRoute: 'relayme-gemini-3-pro-image-preview' }),
    ]));
    expect(routes.imageGeneration).toHaveLength(2);
  });

  it('never exposes incomplete provider profiles as runnable canvas routes', () => {
    const routes = buildCanvasProviderRouteSets([
      {
        provider: 'relayme',
        modelRoute: 'relayme-gemini-3-pro-image-preview',
        modelId: 'gemini-3-pro-image-preview',
        displayName: 'Nano Banana Pro',
        capabilities: ['image_generation'],
        capabilityStatus: 'incomplete',
      },
      {
        provider: 'relayme',
        modelRoute: 'relayme-gpt-image-2',
        modelId: 'gpt-image-2',
        displayName: 'GPT Image 2',
        capabilities: ['image_generation', 'async_tasks'],
        capabilityStatus: 'complete',
      },
      {
        provider: 'relayme',
        modelRoute: 'relayme-text-only',
        modelId: 'text-only',
        displayName: 'Text only',
        capabilities: ['reverse_prompt'],
        capabilityStatus: 'incomplete',
      },
    ]);

    expect(routes.imageGeneration.map((profile) => profile.modelRoute)).toEqual(['relayme-gpt-image-2']);
    expect(routes.reversePrompt).toEqual([]);
  });

  it('never exposes a provider-disabled profile as a runnable canvas route', () => {
    const routes = buildCanvasProviderRouteSets([{
      provider: '4dai',
      modelRoute: '4dai-disabled-image',
      displayName: 'Disabled Image',
      capabilities: ['image_generation'],
      capabilityStatus: 'complete',
      enabled: false,
    }], [], ['4dai-disabled-image']);

    expect(routes.imageGeneration).toEqual([]);
  });

  it('reduces the shared catalog before it is passed into every canvas node', () => {
    const profiles: ProviderBridgeProfile[] = [...Array.from({ length: 200 }, (_, index) => ({
      provider: 'comfly' as const,
      modelRoute: `chat/gpt-5.4-thinking-${index}`,
      displayName: 'GPT-5.4 thinking',
      modelId: `gpt-5.4-thinking-${index}`,
      capabilities: ['chat' as const, 'reverse_prompt' as const],
    })),
      { provider: 'comfly' as const, modelRoute: 'image/gpt-image-2', displayName: 'GPT Image 2', modelId: 'gpt-image-2', capabilities: ['image_generation' as const] },
      { provider: 'comfly' as const, modelRoute: 'video/veo-3.1-fast', displayName: 'Veo 3.1 Fast', modelId: 'veo-3.1-fast', capabilities: ['video_generation' as const] },
    ];

    const routes = buildCanvasProviderRouteSets(profiles);

    expect(routes.imageGeneration).toHaveLength(1);
    expect(routes.videoGeneration).toHaveLength(1);
    expect(routes.reversePrompt.length).toBeLessThan(20);
  });

  it('keeps Reverse Agent routes scoped to the active canvas provider by default', () => {
    const activeRelayMeProfiles: ProviderBridgeProfile[] = [{
      provider: 'relayme',
      modelRoute: 'relayme-gemini-vision',
      modelId: 'gemini-vision',
      displayName: 'Gemini Vision',
      capabilities: ['chat', 'vision', 'reverse_prompt'],
    }];
    const routes = buildCanvasProviderRouteSets(activeRelayMeProfiles);

    expect(routes.reversePrompt).toEqual([
      expect.objectContaining({ provider: 'relayme', modelRoute: 'relayme-gemini-vision' }),
    ]);
    expect(routes.reversePrompt.some((profile) => profile.provider === 'comfly')).toBe(false);
  });

  it('routes the 2026-09-04 Comfly additions only into compatible canvas nodes', () => {
    const imageProfiles: ProviderBridgeProfile[] = [
      { provider: 'comfly', modelRoute: 'comfly-grok-imagine-image-2-0', modelId: 'grok-imagine-image-2.0', displayName: 'grok-imagine-image-2.0', capabilities: ['image_generation', 'image_edit'], capabilityStatus: 'complete' },
      ...['nano-banana-2', 'nano-banana-2-2k', 'nano-banana-2-4k'].map((modelId) => ({
        provider: 'comfly' as const,
        modelRoute: `comfly-${modelId}`,
        modelId,
        displayName: modelId,
        capabilities: ['image_generation' as const, 'image_edit' as const, 'chat' as const],
        capabilityStatus: 'complete' as const,
      })),
    ];
    const videoProfiles: ProviderBridgeProfile[] = ['grok-imagine-video-1.5', 'wan3.0-video', 'wan3.0-video-prime'].map((modelId) => ({
      provider: 'comfly',
      modelRoute: `comfly-${modelId.replace(/\./g, '-')}`,
      modelId,
      displayName: modelId,
      capabilities: ['video_generation', 'async_tasks'],
      capabilityStatus: 'complete',
    }));
    const reverseProfiles: ProviderBridgeProfile[] = [
      'deepseek-v4-flash',
      'deepseek-v4-flash-vision-exp',
      'deepseek-v4-pro',
      'gemini-3.7-flash',
      'gemini-3.7-flash-thinking-high',
      'gemini-3.7-flash-thinking-low',
      'gemini-3.7-flash-thinking-medium',
      'gemini-3.8-flash',
      'gemini-3.8-flash-thinking-high',
      'gemini-3.8-flash-thinking-low',
      'gemini-3.8-flash-thinking-medium',
      'glm-5.3-flash',
      'grok-4.6',
      'qwen3.8-max',
    ].map((modelId) => ({
      provider: 'comfly',
      modelRoute: `comfly-${modelId.replace(/\./g, '-')}`,
      modelId,
      displayName: modelId,
      capabilities: ['chat', 'vision', 'reverse_prompt'],
      capabilityStatus: 'complete',
    }));
    const conflictingImageMetadata: ProviderBridgeProfile[] = [{
      provider: 'comfly',
      modelRoute: 'comfly-gemini-3-1-flash-lite-image',
      modelId: 'gemini-3.1-flash-lite-image',
      displayName: 'gemini-3.1-flash-lite-image',
      capabilities: ['chat', 'async_tasks'],
      capabilityStatus: 'complete',
    }, {
      provider: 'comfly',
      modelRoute: 'comfly-volcv-v1',
      modelId: 'volcv-v1',
      displayName: 'volcv-v1',
      capabilities: ['async_tasks'],
      capabilityStatus: 'complete',
    }];

    const routes = buildCanvasProviderRouteSets([
      ...imageProfiles,
      ...videoProfiles,
      ...reverseProfiles,
      ...conflictingImageMetadata,
    ]);

    expect(routes.imageGeneration.map((profile) => profile.modelId).sort()).toEqual([
      'grok-imagine-image-2.0',
      'nano-banana-2',
    ]);
    expect(routes.videoGeneration.map((profile) => profile.modelId).sort()).toEqual([
      'grok-imagine-video-1.5',
      'wan3.0-video',
      'wan3.0-video-prime',
    ]);
    expect(routes.reversePrompt.map((profile) => profile.modelId).sort()).toEqual([
      'deepseek-v4-flash',
      'deepseek-v4-flash-vision-exp',
      'deepseek-v4-pro',
      'gemini-3.7-flash',
      'gemini-3.8-flash',
      'glm-5.3-flash',
      'grok-4.6',
      'qwen3.8-max',
    ]);
    const generationRouteIds = [...routes.imageGeneration, ...routes.videoGeneration]
      .map((profile) => profile.modelId);
    expect(generationRouteIds).not.toEqual(expect.arrayContaining([
      'gemini-3.1-flash-lite-image',
      'volcv-v1',
    ]));
  });
});

describe('provider-local generation profile resolution', () => {
  const profiles: ProviderBridgeProfile[] = [{
    provider: 'comfly',
    modelRoute: 'comfly-nano-banana-pro-2k',
    modelId: 'nano-banana-pro',
    displayName: 'Nano Banana Pro',
    capabilities: ['image_generation'],
  }, {
    provider: 'relayme',
    modelRoute: 'relayme-gemini-3-pro-image-preview',
    modelId: 'gemini-3-pro-image-preview',
    displayName: 'Nano Banana Pro',
    capabilities: ['image_generation', 'async_tasks'],
  }];

  it('repairs a foreign route only through one same-provider visible model', () => {
    expect(selectGenerationProviderProfile(profiles, {
      provider: 'relayme',
      modelRoute: 'comfly-nano-banana-pro-2k',
      modelDisplayName: 'Nano Banana Pro',
    }, 'image_generation')).toMatchObject({
      provider: 'relayme',
      modelRoute: 'relayme-gemini-3-pro-image-preview',
    });
  });

  it('rejects ambiguous or unnamed cross-provider route repair', () => {
    const ambiguous = [...profiles, {
      provider: 'relayme' as const,
      modelRoute: 'relayme-nano-banana-pro-alternate',
      modelId: 'nano-banana-pro-alternate',
      displayName: 'Nano Banana Pro',
      capabilities: ['image_generation' as const],
    }];

    expect(selectGenerationProviderProfile(ambiguous, {
      provider: 'relayme',
      modelRoute: 'comfly-nano-banana-pro-2k',
      modelDisplayName: 'Nano Banana Pro',
    }, 'image_generation')).toBeUndefined();
    expect(selectGenerationProviderProfile(profiles, {
      provider: 'relayme',
      modelRoute: 'comfly-unknown-image',
    }, 'image_generation')).toBeUndefined();
  });
});

describe('listAllProviderProfiles', () => {
  it('loads only the active provider when isolating the visible runnable catalog', async () => {
    const listProfiles = vi.fn(async ({ provider }: { provider?: ProviderId } = {}) => [{
      provider: provider ?? 'comfly', modelRoute: `${provider}-image`, displayName: `${provider} image`, capabilities: ['image_generation' as const],
    }]);
    const profiles = await listRunnableProviderProfiles({
      listProfiles,
      getActiveProvider: vi.fn(async () => ({ activeProvider: 'comfly' as const })),
    }, { activeProviderOnly: true });

    expect(profiles).toEqual([
      expect.objectContaining({ provider: 'comfly', modelRoute: 'comfly-image' }),
    ]);
    expect(listProfiles).toHaveBeenCalledTimes(1);
    expect(listProfiles).toHaveBeenCalledWith({ provider: 'comfly' });
  });

  it('keeps configured runnable catalogs when the active-provider preference cannot be read', async () => {
    const statuses: Record<ProviderId, { configured: boolean; locked: boolean }> = {
      comfly: { configured: true, locked: false },
      relayme: { configured: true, locked: false },
      julun: { configured: true, locked: false },
      '4dai': { configured: true, locked: false },
    };

    await expect(listRunnableProviderProfiles({
      listProfiles: vi.fn(async ({ provider }: { provider?: ProviderId } = {}) => [{
        provider: provider!,
        modelRoute: `${provider}/runnable`,
        displayName: `${provider} runnable`,
        capabilities: [provider === 'julun' ? 'video_generation' as const : 'image_generation' as const],
        capabilityStatus: 'complete' as const,
      }]),
      getStatus: vi.fn(async ({ provider }: { provider?: ProviderId } = {}) => ({
        ...statuses[provider!],
        encryption: 'safeStorage' as const,
      })),
      getActiveProvider: vi.fn(async () => { throw new Error('active provider preference unavailable'); }),
    })).resolves.toHaveLength(4);
  });

  it('excludes incomplete provider profiles from runnable canvas routes', async () => {
    const listProfiles = vi.fn(async () => [{
      provider: 'relayme' as const,
      modelRoute: 'relayme-legacy-image',
      displayName: 'Nano Banana 2',
      capabilities: ['image_generation' as const],
      capabilityStatus: 'incomplete' as const,
    }, {
      provider: 'relayme' as const,
      modelRoute: 'relayme-workflow-image',
      displayName: 'Nano Banana 2',
      capabilities: ['image_generation' as const, 'async_tasks' as const],
      capabilityStatus: 'complete' as const,
    }]);

    await expect(listRunnableProviderProfiles({
      listProfiles,
      getActiveProvider: vi.fn(async () => ({ activeProvider: 'relayme' as const })),
    })).resolves.toEqual([
      expect.objectContaining({ modelRoute: 'relayme-workflow-image', capabilityStatus: 'complete' }),
    ]);
  });
  it('excludes protocol-pending chat routes from Agent execution', async () => {
    await expect(listRunnableProviderProfiles({
      listProfiles: vi.fn(async () => [{
        provider: 'relayme' as const,
        modelRoute: 'relayme-gemini-chat',
        displayName: 'RENA F',
        capabilities: ['chat' as const],
        capabilityStatus: 'incomplete' as const,
      }]),
      getActiveProvider: vi.fn(async () => ({ activeProvider: 'relayme' as const })),
    })).resolves.toEqual([]);
  });

  it('admits routes only from configured and unlocked providers', async () => {
    const statuses: Record<ProviderId, { configured: boolean; locked: boolean }> = {
      comfly: { configured: true, locked: false },
      relayme: { configured: false, locked: false },
      julun: { configured: true, locked: true },
      '4dai': { configured: true, locked: false },
    };
    const profiles = await listRunnableProviderProfiles({
      listProfiles: vi.fn(async ({ provider }: { provider?: ProviderId } = {}) => [{
        provider: provider!,
        modelRoute: `${provider}/model`,
        displayName: 'Shared Model',
        capabilities: [provider === 'julun' ? 'video_generation' as const : 'image_generation' as const],
        capabilityStatus: 'complete' as const,
      }]),
      getStatus: vi.fn(async ({ provider }: { provider?: ProviderId } = {}) => ({
        ...statuses[provider!],
        encryption: 'safeStorage' as const,
      })),
      getActiveProvider: vi.fn(async () => ({ activeProvider: 'relayme' as const })),
    });

    expect(profiles.map((profile) => `${profile.provider}:${profile.modelRoute}`)).toHaveLength(2);
    expect(profiles.map((profile) => `${profile.provider}:${profile.modelRoute}`)).toEqual(expect.arrayContaining([
      '4dai:4dai/model',
      'comfly:comfly/model',
    ]));
  });

  it('keeps successfully loaded catalogs when a provider status is temporarily unavailable', async () => {
    const profiles = await listRunnableProviderProfiles({
      listProfiles: vi.fn(async ({ provider }: { provider?: ProviderId } = {}) => [{
        provider: provider!,
        modelRoute: `${provider}/model`,
        displayName: `${provider} model`,
        capabilities: [provider === 'julun' ? 'video_generation' as const : 'image_generation' as const],
        capabilityStatus: 'complete' as const,
      }]),
      getStatus: vi.fn(async ({ provider }: { provider?: ProviderId } = {}) => {
        if (provider === 'relayme') throw new Error('status temporarily unavailable');
        if (provider === 'julun') return { configured: false, locked: false };
        if (provider === '4dai') return { configured: true, locked: true };
        return undefined;
      }) as never,
    });

    expect(profiles.map((profile) => profile.provider)).toEqual(['comfly', 'relayme']);
  });

  it('can include a configured locked catalog when durable Agent jobs must survive until unlock', async () => {
    const profiles = await listRunnableProviderProfiles({
      listProfiles: vi.fn(async ({ provider }: { provider?: ProviderId } = {}) => [{
        provider: provider!,
        modelRoute: `${provider}/model`,
        displayName: `${provider} model`,
        capabilities: ['image_generation' as const],
        capabilityStatus: 'complete' as const,
      }]),
      getStatus: vi.fn(async ({ provider }: { provider?: ProviderId } = {}) => ({
        configured: provider !== 'relayme',
        locked: provider === 'julun',
      })),
    }, { includeLocked: true });

    expect(profiles.map((profile) => profile.provider)).toEqual(expect.arrayContaining(['comfly', 'julun', '4dai']));
    expect(profiles.map((profile) => profile.provider)).not.toContain('relayme');
  });
  it('queries all four providers explicitly and keeps every available catalog', async () => {
    const listProfiles = vi.fn(async ({ provider }: { provider?: ProviderId } = {}) => [{
      provider: provider ?? 'comfly',
      modelRoute: `${provider}/model`,
      displayName: `${provider} model`,
      modelId: `${provider}-model`,
      capabilities: [provider === 'julun' ? 'video_generation' as const : 'image_generation' as const],
    }]);

    const profiles = await listAllProviderProfiles({ listProfiles });
    expect(profiles).toHaveLength(4);
    expect(profiles).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'comfly', modelId: 'comfly-model' }),
      expect.objectContaining({ provider: 'relayme', modelId: 'relayme-model' }),
      expect.objectContaining({ provider: 'julun', modelId: 'julun-model' }),
      expect.objectContaining({ provider: '4dai', modelId: '4dai-model' }),
    ]));
    expect(listProfiles).toHaveBeenNthCalledWith(1, { provider: 'comfly' });
    expect(listProfiles).toHaveBeenNthCalledWith(2, { provider: 'relayme' });
    expect(listProfiles).toHaveBeenNthCalledWith(3, { provider: 'julun' });
    expect(listProfiles).toHaveBeenNthCalledWith(4, { provider: '4dai' });
  });

  it('shows one route for equal normalized names in the same provider and capability group', async () => {
    const listProfiles = vi.fn(async ({ provider }: { provider?: ProviderId } = {}) =>
      provider === 'relayme' ? [] : [{
        provider: 'comfly' as const,
        modelRoute: 'comfly-nano-banana-2',
        modelId: 'nano-banana-2',
        displayName: 'Nano Banana 2',
        capabilities: ['image_generation' as const, 'image_edit' as const],
        capabilityStatus: 'complete' as const,
      }, {
        provider: 'comfly' as const,
        modelRoute: 'comfly-nano-banana-2-preview',
        modelId: 'nano-banana-2-preview',
        displayName: ' nano  banana  2 ',
        capabilities: ['image_generation' as const, 'image_edit' as const],
        capabilityStatus: 'incomplete' as const,
      }]);

    const profiles = await listAllProviderProfiles({ listProfiles });

    expect(profiles.filter((item) => item.displayName === 'Nano Banana 2')).toHaveLength(1);
    expect(profiles[0]?.modelRoute).toBe('comfly-nano-banana-2');
  });

  it('keeps same-name profiles once per provider and resolves a discarded preview route', async () => {
    const listProfiles = vi.fn(async ({ provider }: { provider?: ProviderId } = {}) => provider === 'relayme'
      ? [{
        provider: 'relayme' as const,
        modelRoute: 'relayme-nano-banana-2',
        modelId: 'nano-banana-2-relay',
        displayName: 'Nano Banana 2',
        capabilities: ['image_generation' as const],
      }]
      : [{
        provider: 'comfly' as const,
        modelRoute: 'comfly-nano-banana-2',
        modelId: 'nano-banana-2',
        displayName: 'Nano Banana 2',
        capabilities: ['image_generation' as const],
        capabilityStatus: 'complete' as const,
      }, {
        provider: 'comfly' as const,
        modelRoute: 'comfly-nano-banana-2-preview',
        modelId: 'nano-banana-2-preview',
        displayName: 'Nano Banana 2',
        capabilities: ['image_generation' as const],
        capabilityStatus: 'incomplete' as const,
      }]);

    const profiles = await listAllProviderProfiles({ listProfiles });

    expect(profiles.filter((item) => item.displayName === 'Nano Banana 2')).toHaveLength(2);
    expect(profiles.filter((item) => item.provider === 'comfly')).toHaveLength(1);
    expect(profiles.filter((item) => item.provider === 'relayme')).toHaveLength(1);
    expect(selectProviderProfile(profiles, 'comfly-nano-banana-2-preview', 'image_generation')).toEqual(
      expect.objectContaining({ provider: 'comfly', modelRoute: 'comfly-nano-banana-2' }),
    );
    expect(selectProviderProfile(profiles, 'nano-banana-2-preview', 'image_generation')).toEqual(
      expect.objectContaining({ provider: 'comfly', modelRoute: 'comfly-nano-banana-2' }),
    );
  });

  it('publishes 4D Nano Banana 2 and Pro without leaking same-name routes across providers', () => {
    const routes = buildCanvasProviderRouteSets([
      {
        provider: 'comfly' as const,
        modelRoute: 'comfly-gemini-3-1-flash-image-preview',
        modelId: 'gemini-3.1-flash-image-preview',
        displayName: 'gemini-3.1-flash-image-preview',
        capabilities: ['image_generation' as const, 'image_edit' as const],
        capabilityStatus: 'complete' as const,
      },
      {
        provider: '4dai' as const,
        modelRoute: '4dai-gemini-3-1-flash-image-preview',
        modelId: 'gemini-3.1-flash-image-preview',
        displayName: 'gemini-3.1-flash-image-preview',
        capabilities: ['image_generation' as const, 'image_edit' as const],
        capabilityStatus: 'complete' as const,
        constraints: { image: {
          aspectRatios: ['1:1' as const, '16:9' as const],
          resolutions: ['1K' as const, '2K' as const, '4K' as const],
          outputCounts: [1 as const],
        } },
      },
      {
        provider: '4dai' as const,
        modelRoute: '4dai-gemini-3-pro-image-preview',
        modelId: 'gemini-3-pro-image-preview',
        displayName: 'gemini-3-pro-image-preview',
        capabilities: ['image_generation' as const, 'image_edit' as const],
        capabilityStatus: 'complete' as const,
        constraints: { image: {
          aspectRatios: ['1:1' as const, '16:9' as const],
          resolutions: ['1K' as const, '2K' as const, '4K' as const],
          outputCounts: [1 as const],
        } },
      },
      {
        provider: '4dai' as const,
        modelRoute: '4dai-gemini-3-pro-image-preview-4k',
        modelId: 'gemini-3-pro-image-preview-4k',
        displayName: 'gemini-3-pro-image-preview-4k',
        capabilities: ['image_generation' as const],
        capabilityStatus: 'incomplete' as const,
      },
    ]);

    expect(routes.imageGeneration).toEqual(expect.arrayContaining([
      expect.objectContaining({
        provider: 'comfly', modelRoute: 'comfly-gemini-3-1-flash-image-preview', displayName: 'Nano Banana 2',
      }),
      expect.objectContaining({
        provider: '4dai', modelRoute: '4dai-gemini-3-1-flash-image-preview', displayName: 'Nano Banana 2',
      }),
      expect.objectContaining({
        provider: '4dai', modelRoute: '4dai-gemini-3-pro-image-preview', displayName: 'Nano Banana Pro',
      }),
    ]));
    expect(routes.imageGeneration).toHaveLength(3);
    expect(routes.imageGeneration.some((profile) => profile.modelRoute.endsWith('preview-4k'))).toBe(false);
  });

  it('isolates aliases by capability group when discarded model ids collide', async () => {
    const listProfiles = vi.fn(async ({ provider }: { provider?: ProviderId } = {}) => provider === 'relayme' ? [] : [
      { provider: 'comfly' as const, modelRoute: 'image/stable', modelId: 'image-stable', displayName: 'Shared Model', capabilities: ['image_generation' as const] },
      { provider: 'comfly' as const, modelRoute: 'image/preview', modelId: 'legacy-shared', displayName: 'Shared Model', capabilities: ['image_generation' as const] },
      { provider: 'comfly' as const, modelRoute: 'image-chat/stable', modelId: 'image-chat-stable', displayName: 'Shared Model', capabilities: ['image_generation' as const, 'chat' as const] },
      { provider: 'comfly' as const, modelRoute: 'image-chat/preview', modelId: 'legacy-shared', displayName: 'Shared Model', capabilities: ['image_generation' as const, 'chat' as const] },
    ]);

    const profiles = await listAllProviderProfiles({ listProfiles });
    const imageProfiles = profiles.filter((profile) => profile.modelRoute.startsWith('image/') && !profile.modelRoute.startsWith('image-chat/'));
    const imageChatProfiles = profiles.filter((profile) => profile.modelRoute.startsWith('image-chat/'));

    expect(selectProviderProfile(imageProfiles, 'legacy-shared', 'image_generation')).toEqual(
      expect.objectContaining({ modelRoute: 'image/stable' }),
    );
    expect(selectProviderProfile(imageChatProfiles, 'legacy-shared', 'image_generation')).toEqual(
      expect.objectContaining({ modelRoute: 'image-chat/stable' }),
    );
  });

  it('selects colliding aliases by the requested capability group in a full catalog', async () => {
    let reverseOrder = false;
    const profiles = [
      { provider: 'comfly' as const, modelRoute: 'image/stable', modelId: 'image-stable', displayName: 'Shared Model', capabilities: ['image_generation' as const], capabilityStatus: 'complete' as const },
      { provider: 'comfly' as const, modelRoute: 'image/preview', modelId: 'legacy-shared', displayName: 'Shared Model', capabilities: ['image_generation' as const], capabilityStatus: 'incomplete' as const },
      { provider: 'comfly' as const, modelRoute: 'image-chat/stable', modelId: 'image-chat-stable', displayName: 'Shared Model', capabilities: ['image_generation' as const, 'chat' as const], capabilityStatus: 'complete' as const },
      { provider: 'comfly' as const, modelRoute: 'image-chat/preview', modelId: 'legacy-shared', displayName: 'Shared Model', capabilities: ['image_generation' as const, 'chat' as const], capabilityStatus: 'incomplete' as const },
    ];
    const listProfiles = vi.fn(async ({ provider }: { provider?: ProviderId } = {}) => {
      if (provider === 'relayme') return [];
      return reverseOrder ? [...profiles].reverse() : profiles;
    });

    const assertFullCatalogSelection = async () => {
      const catalog = await listAllProviderProfiles({ listProfiles });
      expect(selectProviderProfile(catalog, 'legacy-shared', 'image_generation')).toEqual(
        expect.objectContaining({ modelRoute: 'image/stable' }),
      );
      expect(selectProviderProfile(catalog, 'legacy-shared', 'chat')).toEqual(
        expect.objectContaining({ modelRoute: 'image-chat/stable' }),
      );
    };

    await assertFullCatalogSelection();
    reverseOrder = true;
    await assertFullCatalogSelection();
  });

  it('prefers complete stable routes over preview and minimal variants within a provider', async () => {
    const listProfiles = vi.fn(async ({ provider }: { provider?: ProviderId } = {}) => provider === 'relayme' ? [] : [
      { provider: 'comfly' as const, modelRoute: 'comfly/model-minimal', displayName: 'Model', capabilities: ['chat' as const], capabilityStatus: 'complete' as const },
      { provider: 'comfly' as const, modelRoute: 'comfly/model-preview', displayName: 'Model', capabilities: ['chat' as const], capabilityStatus: 'complete' as const },
      { provider: 'comfly' as const, modelRoute: 'comfly/model', displayName: 'Model', capabilities: ['chat' as const], capabilityStatus: 'incomplete' as const },
      { provider: 'comfly' as const, modelRoute: 'comfly/model-stable', displayName: 'Model', capabilities: ['chat' as const], capabilityStatus: 'complete' as const },
    ]);

    const profiles = await listAllProviderProfiles({ listProfiles });

    expect(profiles).toHaveLength(1);
    expect(profiles[0]?.modelRoute).toBe('comfly/model-stable');
  });

  it('checks preview and minimal priority only in modelRoute', async () => {
    const listProfiles = vi.fn(async ({ provider }: { provider?: ProviderId } = {}) => provider === 'relayme' ? [] : [
      { provider: 'comfly' as const, modelRoute: 'comfly/model-z', modelId: 'model-preview-minimal', displayName: 'Model preview minimal', capabilities: ['chat' as const], capabilityStatus: 'complete' as const },
      { provider: 'comfly' as const, modelRoute: 'comfly/model-a-preview-minimal', modelId: 'model-z', displayName: 'Model preview minimal', capabilities: ['chat' as const], capabilityStatus: 'complete' as const },
    ]);

    const profiles = await listAllProviderProfiles({ listProfiles });

    expect(profiles).toHaveLength(1);
    expect(profiles[0]?.modelRoute).toBe('comfly/model-z');
  });

describe('listAgentChatProfiles', () => {
  it('excludes generation routes that were broadly tagged as chat and keeps real language or vision models', () => {
    const profiles = [
      { provider: 'comfly' as const, modelRoute: 'nano-banana-2', displayName: 'Nano Banana 2', modelId: 'nano-banana-2', capabilities: ['image_generation' as const, 'chat' as const] },
      { provider: 'comfly' as const, modelRoute: 'dall-e-3', displayName: 'dall-e-3', modelId: 'dall-e-3', capabilities: ['image_generation' as const, 'chat' as const] },
      { provider: 'comfly' as const, modelRoute: 'flux-pro', displayName: 'flux-pro', modelId: 'flux-pro', capabilities: ['image_generation' as const, 'chat' as const] },
      { provider: 'comfly' as const, modelRoute: 'gpt-4o-mini', displayName: 'GPT-4o mini', modelId: 'gpt-4o-mini', capabilities: ['chat' as const] },
      { provider: 'comfly' as const, modelRoute: 'gemini-vision', displayName: 'Gemini Vision', modelId: 'gemini-vision', capabilities: ['chat' as const, 'vision' as const] },
    ];

    expect(listAgentChatProfiles(profiles).map((profile) => profile.modelId)).toEqual([
      'gpt-4o-mini',
      'gemini-vision',
    ]);
  });

  it('fails closed for explicit media-output families mislabeled as chat-only', () => {
    const mediaOutputModelIds = [
      'gemini-3-pro-image-4k',
      'gemini-3.1-flash-image-4k',
      'gpt-4-dalle',
      'gpt-4o-image-vip',
      'qwen-image-edit-max',
      'qwen-image-edit-plus',
      'qwen-image-max',
      'qwen-image-plus-2026-01-09',
      'qwen-mt-image',
      'seedream-3.0',
      'volcv-dalle',
      'grok-imagine-video-1.5',
      'hailuo-video',
      'kling-advanced-lip-sync',
      'kling-meta-human',
      'pixverse-video-v1',
      'sora-2-pro',
      'veo3.1-fast-4K',
      'veo3.1-components',
      'video-style-transform',
      'videoretalk',
    ] as const;
    const profiles = [
      ...mediaOutputModelIds.map((modelId) => ({
        provider: 'comfly' as const,
        modelRoute: `comfly-${modelId.replace(/\./gu, '-')}`,
        displayName: modelId,
        modelId,
        capabilities: ['chat' as const],
      })),
      { provider: 'comfly' as const, modelRoute: 'comfly-gemini-3-1-flash-lite', displayName: 'Gemini 3.1 Flash Lite', modelId: 'gemini-3.1-flash-lite', capabilities: ['chat' as const, 'vision' as const] },
      { provider: 'comfly' as const, modelRoute: 'comfly-gpt-4o', displayName: 'GPT-4o', modelId: 'gpt-4o', capabilities: ['chat' as const, 'vision' as const] },
      { provider: 'comfly' as const, modelRoute: 'comfly-qwen-vl-max', displayName: 'Qwen VL Max', modelId: 'qwen-vl-max', capabilities: ['chat' as const, 'vision' as const] },
      { provider: 'comfly' as const, modelRoute: 'comfly-chat-fast-video', displayName: 'Chat Fast Video', modelId: 'chat_fast_video', capabilities: ['chat' as const] },
    ];

    expect(listAgentChatProfiles(profiles).map((profile) => profile.modelId)).toEqual([
      'gemini-3.1-flash-lite',
      'gpt-4o',
      'qwen-vl-max',
      'chat_fast_video',
    ]);
    expect(buildCanvasProviderRouteSets(profiles).storyboard.map((profile) => profile.modelId)).toEqual([
      'chat_fast_video',
      'gemini-3.1-flash-lite',
      'gpt-4o',
      'qwen-vl-max',
    ]);
  });

  it('keeps only the first Agent chat route when visible model names match across providers', () => {
    const profiles = [
      { provider: 'comfly' as const, modelRoute: 'comfly/gemini-3.1-pro', displayName: 'Gemini 3.1 Pro', capabilities: ['chat' as const, 'vision' as const] },
      { provider: 'relayme' as const, modelRoute: 'relayme/gemini-3.1-pro', displayName: 'Gemini 3.1 Pro', capabilities: ['chat' as const, 'vision' as const] },
    ];

    expect(listAgentChatProfiles(profiles).map((profile) => profile.provider)).toEqual(['comfly']);
  });

  it('keeps every Codex route available for Agent chat model switching', () => {
    const profiles = [
      { provider: 'comfly' as const, modelRoute: 'chat/gpt-5.3-codex-low', displayName: 'gpt-5.3-codex', modelId: 'gpt-5.3-codex-low', capabilities: ['chat' as const] },
      { provider: 'comfly' as const, modelRoute: 'chat/gpt-5.3-codex-medium', displayName: 'gpt-5.3-codex', modelId: 'gpt-5.3-codex-medium', capabilities: ['chat' as const] },
      { provider: 'comfly' as const, modelRoute: 'chat/gpt-5.3-codex-high', displayName: 'gpt-5.3-codex', modelId: 'gpt-5.3-codex-high', capabilities: ['chat' as const] },
    ];

    expect(listAgentChatProfiles(profiles).map((profile) => profile.modelRoute)).toEqual([
      'chat/gpt-5.3-codex-low',
      'chat/gpt-5.3-codex-medium',
      'chat/gpt-5.3-codex-high',
    ]);
  });

  it('treats every current GPT-5.6 reasoning tier as a Codex Agent model', () => {
    const profiles = [
      { provider: 'comfly' as const, modelRoute: 'openai/gpt-5.6-sol', displayName: 'GPT-5.6 Sol', modelId: 'gpt-5.6-sol', capabilities: ['responses' as const] },
      { provider: 'comfly' as const, modelRoute: 'openai/gpt-5.6-terra', displayName: 'GPT-5.6 Terra', modelId: 'gpt-5.6-terra', capabilities: ['responses' as const] },
      { provider: 'comfly' as const, modelRoute: 'openai/gpt-5.6-luna', displayName: 'GPT-5.6 Luna', modelId: 'gpt-5.6-luna', capabilities: ['responses' as const] },
      { provider: 'comfly' as const, modelRoute: 'chat/gemini', displayName: 'Gemini', modelId: 'gemini', capabilities: ['chat' as const] },
    ];

    expect(listCodexAgentProfiles(profiles).map((profile) => profile.modelId)).toEqual([
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
    ]);
  });

  it('never presents a RelayMe chat route as a Codex model', () => {
    const profiles = [
      { provider: 'relayme' as const, modelRoute: 'relayme-renaf', displayName: 'RENAF', modelId: 'renaf', capabilities: ['chat' as const] },
      { provider: 'comfly' as const, modelRoute: 'openai/gpt-5.6-terra', displayName: 'GPT-5.6 Terra', modelId: 'gpt-5.6-terra', capabilities: ['responses' as const] },
    ];

    expect(listCodexAgentProfiles(profiles).map((profile) => profile.modelId)).toEqual(['gpt-5.6-terra']);
  });
});

describe('filterProviderCatalogProfiles', () => {
  it('keeps GPT Image 2 and audited GPT Image 2.5 routes distinct', () => {
    const profiles: ProviderBridgeProfile[] = [{
      provider: 'comfly',
      modelRoute: 'comfly-gpt-image-2-5-flare',
      displayName: 'gpt-image-2.5-flare',
      modelId: 'gpt-image-2.5-flare',
      capabilities: ['image_generation', 'image_edit'],
      capabilityStatus: 'complete',
      constraints: { image: { resolutions: ['1K'] } },
    }, {
      provider: 'comfly',
      modelRoute: 'comfly-gpt-image-2-5-flare-4k',
      displayName: 'gpt-image-2.5-flare-4k',
      modelId: 'gpt-image-2.5-flare-4k',
      capabilities: ['image_generation', 'image_edit'],
      capabilityStatus: 'complete',
      constraints: { image: { resolutions: ['4K'] } },
    }, {
      provider: 'comfly',
      modelRoute: 'comfly-gpt-image-2',
      displayName: 'gpt-image-2',
      modelId: 'gpt-image-2',
      capabilities: ['image_generation', 'image_edit'],
      capabilityStatus: 'complete',
      constraints: { image: { resolutions: ['2K', '4K'] } },
    }];

    expect(buildCanvasProviderRouteSets(profiles).imageGeneration).toEqual(expect.arrayContaining([
      expect.objectContaining({ modelRoute: 'comfly-gpt-image-2', displayName: 'GPT Image 2' }),
      expect.objectContaining({ modelRoute: 'comfly-gpt-image-2-5-flare', displayName: 'GPT Image 2.5 Flare' }),
      expect.objectContaining({ modelRoute: 'comfly-gpt-image-2-5-flare-4k', displayName: 'GPT Image 2.5 Flare 4K' }),
    ]));
    expect(buildCanvasProviderRouteSets(profiles).imageGeneration).toHaveLength(3);
  });

  it('does not collapse Comfly GPT Image 2.5 Flare and Sunburst resolution routes', () => {
    const profiles: ProviderBridgeProfile[] = [
      ...['', '-2k', '-4k'].map((suffix) => ({
        provider: 'comfly' as const,
        modelRoute: `comfly-gpt-image-2-5-flare${suffix}`,
        displayName: `gpt-image-2.5-flare${suffix}`,
        modelId: `gpt-image-2.5-flare${suffix}`,
        capabilities: ['image_generation' as const, 'image_edit' as const],
        capabilityStatus: 'complete' as const,
      })),
      ...['', '-2k', '-4k'].map((suffix) => ({
        provider: 'comfly' as const,
        modelRoute: `comfly-gpt-image-2-5-sunburst${suffix}`,
        displayName: `gpt-image-2.5-sunburst${suffix}`,
        modelId: `gpt-image-2.5-sunburst${suffix}`,
        capabilities: ['image_generation' as const, 'image_edit' as const],
        capabilityStatus: 'complete' as const,
      })),
    ];

    const filtered = filterProviderCatalogProfiles(profiles);
    expect(filtered).toHaveLength(6);
    expect(filtered.map((profile) => profile.modelRoute)).toEqual(expect.arrayContaining(
      profiles.map((profile) => profile.modelRoute),
    ));
    expect(filtered.map((profile) => profile.displayName)).toEqual(expect.arrayContaining([
      'GPT Image 2.5 Flare',
      'GPT Image 2.5 Flare 2K',
      'GPT Image 2.5 Flare 4K',
      'GPT Image 2.5 Sunburst',
      'GPT Image 2.5 Sunburst 2K',
      'GPT Image 2.5 Sunburst 4K',
    ]));
  });

  it('keeps supported user-facing models, removes action routes, compresses variants, and pins common generation models', () => {
    const profiles = [
      { provider: 'comfly' as const, modelRoute: 'openai/gpt-image-2', displayName: 'gpt-image-2', modelId: 'gpt-image-2', capabilities: ['image_generation' as const] },
      { provider: 'comfly' as const, modelRoute: 'google/gemini-3.1-flash-image-preview', displayName: 'gemini-3.1-flash-image-preview', modelId: 'gemini-3.1-flash-image-preview', capabilities: ['image_generation' as const] },
      { provider: 'comfly' as const, modelRoute: 'google/nano-banana-pro', displayName: 'nano-banana-pro', modelId: 'nano-banana-pro', capabilities: ['image_generation' as const] },
      { provider: 'comfly' as const, modelRoute: 'video/seedance-2.0-pro', displayName: 'Seedance 2.0 Pro', modelId: 'seedance-2.0-pro', capabilities: ['video_generation' as const] },
      { provider: 'comfly' as const, modelRoute: 'video/seedance-2.5', displayName: 'Seedance 2.5', modelId: 'seedance-2.5', capabilities: ['video_generation' as const] },
      { provider: 'comfly' as const, modelRoute: 'chat/gpt-5.4', displayName: 'GPT-5.4', modelId: 'gpt-5.4', capabilities: ['chat' as const] },
      { provider: 'comfly' as const, modelRoute: 'chat/gpt-5.4-2026-03-05', displayName: 'GPT-5.4 2026-03-05', modelId: 'gpt-5.4-2026-03-05', capabilities: ['chat' as const] },
      { provider: 'comfly' as const, modelRoute: 'chat/gpt-5.4-thinking-high', displayName: 'GPT-5.4 thinking high', modelId: 'gpt-5.4-thinking-high', capabilities: ['chat' as const] },
      { provider: 'comfly' as const, modelRoute: 'midjourney/upload', displayName: 'Midjourney Upload', modelId: 'midjourney-upload', capabilities: ['image_generation' as const] },
      { provider: 'comfly' as const, modelRoute: 'mj_fast_upscale_4x', displayName: 'mj_fast_upscale_4x', modelId: 'mj_fast_upscale_4x', capabilities: ['image_generation' as const] },
      { provider: 'comfly' as const, modelRoute: 'image/seedream-v5-pro', displayName: 'seedream-v5-pro', modelId: 'seedream-v5-pro', capabilities: ['image_generation' as const] },
      { provider: 'comfly' as const, modelRoute: 'video/veo-3.1-fast', displayName: 'veo-3.1-fast', modelId: 'veo-3.1-fast', capabilities: ['video_generation' as const] },
      { provider: 'comfly' as const, modelRoute: 'voices/custom-voices', displayName: 'Custom Voices', modelId: 'custom-voices', capabilities: ['chat' as const] },
      { provider: 'comfly' as const, modelRoute: 'audio/tts', displayName: 'TTS', modelId: 'tts-1', capabilities: [] },
    ];

    const filtered = filterProviderCatalogProfiles(profiles);

    expect(filtered.slice(0, 5).map((profile) => profile.displayName)).toEqual([
      'GPT Image 2',
      'Nano Banana 2',
      'Nano Banana Pro',
      'Seedance 2.0 Pro',
      'Seedance 2.5',
    ]);
    expect(filtered.filter((profile) => profile.displayName.startsWith('GPT-5.4'))).toHaveLength(1);
    expect(filtered.map((profile) => profile.modelId)).not.toEqual(expect.arrayContaining([
      'midjourney-upload',
      'mj_fast_upscale_4x',
      'custom-voices',
      'tts-1',
    ]));
    expect(filtered.map((profile) => profile.displayName)).toEqual(expect.arrayContaining([
      'Seedream 5 Pro',
      'Veo 3.1 Fast',
    ]));
  });
});

  it('keeps the available provider catalog when the other provider is unconfigured', async () => {
    const listProfiles = vi.fn(async ({ provider }: { provider?: ProviderId } = {}) => {
      if (provider === 'relayme') throw new Error('RelayMe 未配置');
      return [{ provider: 'comfly' as const, modelRoute: 'chat/general', displayName: 'Comfly Chat', modelId: 'comfly-chat', capabilities: ['chat' as const] }];
    });

    await expect(listAllProviderProfiles({ listProfiles })).resolves.toEqual([
      expect.objectContaining({ provider: 'comfly', modelId: 'comfly-chat' }),
    ]);
  });

  it('selects the provider owning the requested route only when the capability is explicit', () => {
    const profiles = [
      { provider: 'comfly' as const, modelRoute: 'reverse/vision', displayName: 'Comfly Reverse', modelId: 'comfly-reverse', capabilities: ['reverse_prompt' as const, 'vision' as const] },
      { provider: 'relayme' as const, modelRoute: 'chat/text', displayName: 'Relay Text', modelId: 'relay-text', capabilities: ['chat' as const] },
      { provider: 'relayme' as const, modelRoute: 'video/generate', displayName: 'Relay Video', modelId: 'relay-video', capabilities: ['video_generation' as const] },
    ];

    expect(selectProviderProfile(profiles, 'video/generate', 'video_generation')).toEqual(expect.objectContaining({ provider: 'relayme' }));
    expect(selectProviderProfile(profiles, 'chat/text', 'reverse_prompt')).toBeUndefined();
    expect(selectProviderProfile(profiles, 'reverse/vision', 'reverse_prompt')).toEqual(expect.objectContaining({ provider: 'comfly' }));
  });

  it('keeps same-name models once for Comfly and once for RelayMe', async () => {
    const listProfiles = vi.fn(async ({ provider }: { provider?: ProviderId } = {}) => (
      provider === 'julun' || provider === '4dai' ? [] : [{
      provider: provider ?? 'comfly',
      modelRoute: provider === 'relayme' ? 'relayme/gpt-image-2' : 'comfly/gpt-image-2',
      displayName: provider === 'relayme' ? 'GPT Image 2' : 'gpt-image-2',
      modelId: 'gpt-image-2',
      capabilities: ['image_generation' as const],
    }]
    ));

    const profiles = await listAllProviderProfiles({ listProfiles });

    expect(profiles.filter((profile) => profile.modelId === 'gpt-image-2')).toHaveLength(2);
    expect(profiles).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'comfly', modelRoute: 'comfly/gpt-image-2', displayName: 'GPT Image 2' }),
      expect.objectContaining({ provider: 'relayme', modelRoute: 'relayme/gpt-image-2', displayName: 'GPT Image 2' }),
    ]));
  });

  it('keeps matching video and reverse models once per provider when metadata differs', async () => {
    const listProfiles = vi.fn(async ({ provider }: { provider?: ProviderId } = {}) => provider === 'relayme' ? [
      { provider: 'relayme' as const, modelRoute: 'relay/seedance-2', displayName: 'Seedance 2.0', modelId: 'seedance-2.0', capabilities: ['video_generation' as const, 'async_tasks' as const] },
      { provider: 'relayme' as const, modelRoute: 'relay/reverse-vision', displayName: 'Reverse Vision', modelId: 'reverse-vision', capabilities: ['reverse_prompt' as const, 'vision' as const] },
    ] : [
      { provider: 'comfly' as const, modelRoute: 'comfly/seedance-2', displayName: 'Seedance 2.0', modelId: 'seedance-2.0', capabilities: ['video_generation' as const] },
      { provider: 'comfly' as const, modelRoute: 'comfly/reverse-vision', displayName: 'Reverse Vision', modelId: 'reverse-vision', capabilities: ['reverse_prompt' as const] },
    ]);

    const profiles = await listAllProviderProfiles({ listProfiles });

    expect(profiles.filter((profile) => profile.modelId === 'seedance-2.0')).toHaveLength(2);
    expect(profiles.filter((profile) => profile.modelId === 'reverse-vision')).toHaveLength(2);
    expect(profiles.filter((profile) => profile.modelId === 'seedance-2.0').map((profile) => profile.provider)).toEqual(['comfly', 'relayme']);
    expect(profiles.filter((profile) => profile.modelId === 'reverse-vision').map((profile) => profile.provider)).toEqual(['comfly', 'relayme']);
  });
  it('keeps only Nano Banana 2 and Nano Banana Pro from Google image models and pins common models first', async () => {
    const listProfiles = vi.fn(async ({ provider }: { provider?: ProviderId } = {}) => provider === 'relayme' ? [] : [
      { provider: 'comfly' as const, modelRoute: 'flux/pro', displayName: 'Flux Pro', modelId: 'flux-pro', capabilities: ['image_generation' as const] },
      { provider: 'comfly' as const, modelRoute: 'google/imagen-4', displayName: 'Imagen 4', modelId: 'imagen-4', capabilities: ['image_generation' as const] },
      { provider: 'comfly' as const, modelRoute: 'google/nano-banana', displayName: 'Nano Banana', modelId: 'nano-banana', capabilities: ['image_generation' as const] },
      { provider: 'comfly' as const, modelRoute: 'google/nano-banana-pro', displayName: 'nano-banana-pro', modelId: 'nano-banana-pro', capabilities: ['image_generation' as const] },
      { provider: 'comfly' as const, modelRoute: 'google/gemini-3.1-flash-image-preview', displayName: 'gemini-3.1-flash-image-preview', modelId: 'gemini-3.1-flash-image-preview', capabilities: ['image_generation' as const] },
      { provider: 'comfly' as const, modelRoute: 'openai/gpt-image-2', displayName: 'gpt-image-2', modelId: 'gpt-image-2', capabilities: ['image_generation' as const] },
    ]);

    const profiles = await listAllProviderProfiles({ listProfiles });
    const images = profiles.filter((profile) => profile.capabilities.includes('image_generation'));

    expect(images.slice(0, 3).map((profile) => profile.displayName)).toEqual([
      'GPT Image 2',
      'Nano Banana 2',
      'Nano Banana Pro',
    ]);
    expect(images.map((profile) => profile.modelId)).not.toContain('imagen-4');
    expect(images.map((profile) => profile.modelId)).not.toContain('nano-banana');
    expect(images.map((profile) => profile.displayName)).toContain('Flux Pro');
  });

  it('merges all four persisted catalogs across configured and locked status combinations', async () => {
    const listProfiles = vi.fn(async ({ provider }: { provider?: ProviderId } = {}) => ([{
      provider: provider ?? 'comfly',
      modelRoute: `${provider}/gpt-image-2`,
      displayName: 'GPT Image 2',
      modelId: 'gpt-image-2',
      capabilities: ['image_generation' as const],
    }]));
    const getStatus = vi.fn(async ({ provider }: { provider?: ProviderId } = {}) => ({
      configured: provider === 'relayme' || provider === 'julun' || provider === '4dai',
      locked: provider === 'julun',
      encryption: 'safeStorage' as const,
    }));

    const profiles = await listAllProviderProfiles({ listProfiles, getStatus });

    expect(profiles.filter((profile) => profile.modelId === 'gpt-image-2')).toHaveLength(4);
    expect(profiles).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'comfly', modelRoute: 'comfly/gpt-image-2' }),
      expect.objectContaining({ provider: 'relayme', modelRoute: 'relayme/gpt-image-2' }),
      expect.objectContaining({ provider: 'julun', modelRoute: 'julun/gpt-image-2' }),
      expect.objectContaining({ provider: '4dai', modelRoute: '4dai/gpt-image-2' }),
    ]));
    expect(getStatus).toHaveBeenCalledTimes(4);
    expect(getStatus).toHaveBeenNthCalledWith(1, { provider: 'comfly' });
    expect(getStatus).toHaveBeenNthCalledWith(2, { provider: 'relayme' });
    expect(getStatus).toHaveBeenNthCalledWith(3, { provider: 'julun' });
    expect(getStatus).toHaveBeenNthCalledWith(4, { provider: '4dai' });
  });});
