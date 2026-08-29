import { describe, expect, it, vi } from 'vitest';
import type { ProviderBridgeProfile } from '@agent-canvas/desktop-core';

import { buildCanvasProviderRouteSets, filterProviderCatalogProfiles, listActiveProviderProfiles, listAllProviderProfiles, listRunnableProviderProfiles, listAgentChatProfiles, listCodexAgentProfiles, selectFirstProfileForCapability, selectProviderProfile } from './provider-profiles';

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
});

describe('listAllProviderProfiles', () => {
  it('uses only the active provider catalog for runnable canvas routes', async () => {
    const listProfiles = vi.fn(async ({ provider }: { provider?: 'comfly' | 'relayme' } = {}) => [{
      provider: provider ?? 'comfly', modelRoute: `${provider}-image`, displayName: `${provider} image`, capabilities: ['image_generation' as const],
    }]);
    await expect(listRunnableProviderProfiles({
      listProfiles,
      getActiveProvider: vi.fn(async () => ({ activeProvider: 'comfly' as const })),
    })).resolves.toEqual([expect.objectContaining({ provider: 'comfly', modelRoute: 'comfly-image' })]);
    expect(listProfiles).toHaveBeenCalledTimes(1);
    expect(listProfiles).toHaveBeenCalledWith({ provider: 'comfly' });
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
  it('queries Comfly and RelayMe explicitly and keeps both provider catalogs', async () => {
    const listProfiles = vi.fn(async ({ provider }: { provider?: 'comfly' | 'relayme' } = {}) => provider === 'relayme' ? [
      { provider: 'relayme' as const, modelRoute: 'video/generate', displayName: 'Relay Video', modelId: 'relay-video', capabilities: ['video_generation' as const] },
    ] : [
      { provider: 'comfly' as const, modelRoute: 'image/generate', displayName: 'Comfly Image', modelId: 'comfly-image', capabilities: ['image_generation' as const] },
    ]);

    await expect(listAllProviderProfiles({ listProfiles })).resolves.toEqual([
      expect.objectContaining({ provider: 'comfly', modelId: 'comfly-image' }),
      expect.objectContaining({ provider: 'relayme', modelId: 'relay-video' }),
    ]);
    expect(listProfiles).toHaveBeenNthCalledWith(1, { provider: 'comfly' });
    expect(listProfiles).toHaveBeenNthCalledWith(2, { provider: 'relayme' });
  });

  it('shows one route for equal normalized names in the same provider and capability group', async () => {
    const listProfiles = vi.fn(async ({ provider }: { provider?: 'comfly' | 'relayme' } = {}) =>
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
    const listProfiles = vi.fn(async ({ provider }: { provider?: 'comfly' | 'relayme' } = {}) => provider === 'relayme'
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

  it('isolates aliases by capability group when discarded model ids collide', async () => {
    const listProfiles = vi.fn(async ({ provider }: { provider?: 'comfly' | 'relayme' } = {}) => provider === 'relayme' ? [] : [
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
    const listProfiles = vi.fn(async ({ provider }: { provider?: 'comfly' | 'relayme' } = {}) => {
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
    const listProfiles = vi.fn(async ({ provider }: { provider?: 'comfly' | 'relayme' } = {}) => provider === 'relayme' ? [] : [
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
    const listProfiles = vi.fn(async ({ provider }: { provider?: 'comfly' | 'relayme' } = {}) => provider === 'relayme' ? [] : [
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

  it('shows one Agent chat option when providers expose the same visible model name', () => {
    const profiles = [
      { provider: 'comfly' as const, modelRoute: 'comfly/gemini-3.1-pro', displayName: 'Gemini 3.1 Pro', capabilities: ['chat' as const, 'vision' as const] },
      { provider: 'relayme' as const, modelRoute: 'relayme/gemini-3.1-pro', displayName: 'Gemini 3.1 Pro', capabilities: ['chat' as const, 'vision' as const] },
    ];

    expect(listAgentChatProfiles(profiles)).toHaveLength(1);
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
});

describe('filterProviderCatalogProfiles', () => {
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
    const listProfiles = vi.fn(async ({ provider }: { provider?: 'comfly' | 'relayme' } = {}) => {
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
    const listProfiles = vi.fn(async ({ provider }: { provider?: 'comfly' | 'relayme' } = {}) => [{
      provider: provider ?? 'comfly',
      modelRoute: provider === 'relayme' ? 'relayme/gpt-image-2' : 'comfly/gpt-image-2',
      displayName: provider === 'relayme' ? 'GPT Image 2' : 'gpt-image-2',
      modelId: 'gpt-image-2',
      capabilities: ['image_generation' as const],
    }]);

    const profiles = await listAllProviderProfiles({ listProfiles });

    expect(profiles.filter((profile) => profile.modelId === 'gpt-image-2')).toHaveLength(2);
    expect(profiles).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'comfly', modelRoute: 'comfly/gpt-image-2', displayName: 'GPT Image 2' }),
      expect.objectContaining({ provider: 'relayme', modelRoute: 'relayme/gpt-image-2', displayName: 'GPT Image 2' }),
    ]));
  });

  it('keeps matching video and reverse models once per provider when metadata differs', async () => {
    const listProfiles = vi.fn(async ({ provider }: { provider?: 'comfly' | 'relayme' } = {}) => provider === 'relayme' ? [
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
    const listProfiles = vi.fn(async ({ provider }: { provider?: 'comfly' | 'relayme' } = {}) => provider === 'relayme' ? [] : [
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

  it('keeps configured and unconfigured providers when their visible names match', async () => {
    const listProfiles = vi.fn(async ({ provider }: { provider?: 'comfly' | 'relayme' } = {}) => [{
      provider: provider ?? 'comfly',
      modelRoute: provider === 'relayme' ? 'relayme/gpt-image-2' : 'comfly/gpt-image-2',
      displayName: 'GPT Image 2',
      modelId: 'gpt-image-2',
      capabilities: ['image_generation' as const],
    }]);
    const getStatus = vi.fn(async ({ provider }: { provider?: 'comfly' | 'relayme' } = {}) => ({
      configured: provider === 'relayme',
      locked: false,
      encryption: 'safeStorage' as const,
    }));

    const profiles = await listAllProviderProfiles({ listProfiles, getStatus });

    expect(profiles.filter((profile) => profile.modelId === 'gpt-image-2')).toHaveLength(2);
    expect(profiles).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider: 'comfly', modelRoute: 'comfly/gpt-image-2' }),
      expect.objectContaining({ provider: 'relayme', modelRoute: 'relayme/gpt-image-2' }),
    ]));
  });});
