import { describe, expect, it, vi } from 'vitest';

import type { NewApiFetchInit } from './newapi-client';
import type { NewApiModelProfile } from './newapi-model-catalog';
import type { ProviderBridgeProfile } from './provider-contracts';
import { createNewApiProviderService } from './newapi-provider-service';

const cachedRoute: NewApiModelProfile = {
  provider: 'julun', modelRoute: 'julun-existing-dynamic-route', displayName: 'Existing MiniMax', modelId: 'minimax_h3',
  capabilities: ['video_generation', 'async_tasks'], capabilityStatus: 'complete',
  constraints: { video: {
    aspectRatios: ['9:16'], resolutions: ['768p'],
    duration: { mode: 'options', defaultValue: 15, options: [15] }, outputCounts: [1],
  } },
};

function fixture(profile: NewApiModelProfile = cachedRoute, responses?: readonly unknown[]) {
  const snapshot: { baseUrl: string; profiles: readonly ProviderBridgeProfile[] } = { baseUrl: 'https://julun.cc/v1', profiles: [profile] };
  let hasPersistedConfiguration = true;
  const read = vi.fn(async (fallback: typeof snapshot) => hasPersistedConfiguration ? snapshot : fallback);
  const write = vi.fn(async (next: typeof snapshot) => {
    hasPersistedConfiguration = true;
    snapshot.baseUrl = next.baseUrl;
    snapshot.profiles = [...next.profiles];
  });
  const calls: Array<{ url: string; init?: NewApiFetchInit }> = [];
  const queue = responses === undefined ? undefined : [...responses];
  const getPrimaryToken = vi.fn(async () => 'fixture-credential');
  const readReferenceImage = vi.fn(async () => ({ bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]), mediaType: 'image/png' as const }));
  const options: Parameters<typeof createNewApiProviderService>[0] = {
    provider: 'julun', configurationStore: { read, write },
    credentialStore: {
      configure: async () => undefined, unlock: async () => undefined,
      getStatus: async () => ({ configured: true, locked: false, encryption: 'safeStorage' as const }), getPrimaryToken,
    },
    fetch: async (url, init) => {
      calls.push({ url, init });
      const result = queue === undefined ? { id: 'fixture-video-task', status: 'queued' } : queue.shift();
      return { ok: true, status: 200, json: async () => result };
    },
    readReferenceImage,
  };
  const service = createNewApiProviderService(options);
  return { service, calls, write, snapshot, getPrimaryToken, readReferenceImage,
    restart: () => createNewApiProviderService(options),
    omitPersistedConfiguration: () => { hasPersistedConfiguration = false; } };
}

describe('Julun public catalog previews and supported video requests', () => {
  it('shows uncached exact-ID seeds disabled without changing selected routes or writing configuration', async () => {
    const context = fixture();
    const listed = await context.service.listProfiles();

    expect(listed[0]).toEqual({ ...cachedRoute, constraints: { video: {
      aspectRatios: ['16:9', '9:16'], resolutions: ['480p', '768p'],
      duration: { mode: 'range', defaultValue: 10, min: 5, max: 15, step: 1 }, outputCounts: [1],
    } } });
    expect(listed.filter(profile => profile.modelId === 'minimax_h3')).toHaveLength(1);
    expect(listed).toContainEqual(expect.objectContaining({
      modelId: 'sd2-mini', capabilityStatus: 'incomplete', enabled: false,
    }));
    expect(context.snapshot.profiles).toEqual([cachedRoute]);
    expect(context.write).not.toHaveBeenCalled();
    expect(context.calls).toEqual([]);
    expect(context.getPrimaryToken).not.toHaveBeenCalled();
  });

  it('preserves a cached explicit disabled flag while showing the new disabled previews', async () => {
    const context = fixture({ ...cachedRoute, enabled: false } as NewApiModelProfile);
    expect((await context.service.listProfiles())[0]).toMatchObject({
      modelId: 'minimax_h3', modelRoute: cachedRoute.modelRoute, enabled: false,
    });
    expect(context.write).not.toHaveBeenCalled();
  });

  it('rejects a new submit through an explicitly disabled complete cached route before any POST', async () => {
    const context = fixture({ ...cachedRoute, enabled: false } as NewApiModelProfile);
    await expect(context.service.submitVideoJob({
      provider: 'julun', modelRoute: cachedRoute.modelRoute, prompt: 'orbit', sessionId: 'session-fixture', referenceAssetIds: [],
    })).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' });
    expect(context.calls).toEqual([]);
    expect(context.getPrimaryToken).not.toHaveBeenCalled();
  });

  it('does not select or enable an explicitly disabled cached route when refreshing the account catalog', async () => {
    const context = fixture({ ...cachedRoute, modelId: 'Q10-SD2.5 全参', enabled: false } as NewApiModelProfile, [
      { data: [{ id: 'Q10-SD2.5 全参' }] },
      { data: [{ model_name: 'Q10-SD2.5 全参', supported_endpoint_types: ['openai-video'] }] },
    ]);
    expect(await context.service.refreshCatalog()).toContainEqual(expect.objectContaining({
      modelId: 'Q10-SD2.5 全参', modelRoute: cachedRoute.modelRoute, capabilityStatus: 'complete', enabled: false,
    }));
    expect(context.write).toHaveBeenCalledWith({ baseUrl: 'https://julun.cc/v1', profiles: [expect.objectContaining({
      modelId: 'Q10-SD2.5 全参', modelRoute: cachedRoute.modelRoute, enabled: false,
    })] });
    expect(context.calls.map(call => call.url)).toEqual(['https://julun.cc/v1/models', 'https://julun.cc/api/pricing']);
  });

  it('keeps disabled identities and their order through two persisted refreshes and a service restart', async () => {
    const responses = [
      { data: [{ id: 'minimax_h3' }, { id: 'Q10-SD2.5 全参' }] },
      { data: [
        { model_name: 'minimax_h3', supported_endpoint_types: ['openai-video'] },
        { model_name: 'Q10-SD2.5 全参', supported_endpoint_types: ['openai-video'] },
      ] },
    ];
    const context = fixture(cachedRoute, [...responses, ...responses, ...responses]);
    context.snapshot.profiles = [
      { ...cachedRoute, modelId: 'Q10-SD2.5 全参', enabled: false },
      { ...cachedRoute, modelRoute: 'julun-minimax-h3', enabled: false },
    ];
    const identities = context.snapshot.profiles.map(profile => [profile.modelId, profile.modelRoute]);
    await context.service.refreshCatalog();
    await context.service.refreshCatalog();
    const restarted = context.restart();
    expect(await restarted.refreshCatalog()).toEqual(expect.arrayContaining([
      expect.objectContaining({ modelId: 'Q10-SD2.5 全参', enabled: false }),
      expect.objectContaining({ modelId: 'minimax_h3', enabled: false }),
    ]));
    expect(context.snapshot.profiles.map(profile => [profile.modelId, profile.modelRoute])).toEqual(identities);
    expect(context.snapshot.profiles.every(profile => profile.enabled === false)).toBe(true);
    await expect(restarted.submitVideoJob({
      provider: 'julun', modelRoute: cachedRoute.modelRoute, prompt: 'orbit', sessionId: 'session-fixture', referenceAssetIds: [],
    })).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' });
    expect(context.calls.every(call => call.init?.method !== 'POST')).toBe(true);
  });

  it('lets an explicit selection enable a cached disabled route and keeps disable-all after refresh and restart', async () => {
    const responses = [
      { data: [{ id: 'minimax_h3' }] },
      { data: [{ model_name: 'minimax_h3', supported_endpoint_types: ['openai-video'] }] },
    ];
    const context = fixture({ ...cachedRoute, enabled: false } as NewApiModelProfile, [
      { id: 'explicitly-enabled-video', status: 'queued' }, ...responses, ...responses,
    ]);
    await context.service.updateProfiles!({ provider: 'julun', profiles: [cachedRoute] });
    expect(context.snapshot.profiles[0]).toMatchObject({ modelId: 'minimax_h3', enabled: true });
    await expect(context.service.submitVideoJob({
      provider: 'julun', modelRoute: cachedRoute.modelRoute, prompt: 'orbit', sessionId: 'session-fixture', referenceAssetIds: [],
    })).resolves.toMatchObject({ providerTaskId: expect.stringMatching(/^provider-job-/u) });
    await context.service.updateProfiles!({ provider: 'julun', profiles: [] });
    expect(context.snapshot.profiles).toEqual([expect.objectContaining({
      modelId: 'minimax_h3', modelRoute: cachedRoute.modelRoute, enabled: false,
    })]);
    await context.service.refreshCatalog();
    const restarted = context.restart();
    await restarted.refreshCatalog();
    expect((await restarted.listProfiles()).find(profile => profile.modelId === 'minimax_h3')).toMatchObject({ enabled: false });
    await expect(restarted.submitVideoJob({
      provider: 'julun', modelRoute: cachedRoute.modelRoute, prompt: 'orbit', sessionId: 'session-fixture', referenceAssetIds: [],
    })).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' });
    expect(context.calls.filter(call => call.init?.method === 'POST')).toHaveLength(1);
  });

  it('does not infer an empty persisted Julun selection as permission to enable every authenticated model', async () => {
    const responses = [
      { data: [{ id: 'minimax_h3' }] },
      { data: [{ model_name: 'minimax_h3', supported_endpoint_types: ['openai-video'] }] },
    ];
    const context = fixture(cachedRoute, [...responses, ...responses]);
    context.snapshot.profiles = [];
    expect(await context.service.refreshCatalog()).toContainEqual(expect.objectContaining({ enabled: false }));
    expect(await context.restart().refreshCatalog()).toContainEqual(expect.objectContaining({ enabled: false }));
    expect(context.calls.every(call => call.init?.method !== 'POST')).toBe(true);
  });

  it('keeps uncached fallback models disabled until the user explicitly selects an authenticated route', async () => {
    const context = fixture(cachedRoute, [
      { data: [{ id: 'minimax_h3' }] },
      { data: [{ model_name: 'minimax_h3', supported_endpoint_types: ['openai-video'] }] },
    ]);
    context.omitPersistedConfiguration();
    expect((await context.service.listProfiles()).every(profile => 'enabled' in profile && profile.enabled === false)).toBe(true);
    expect(await context.service.refreshCatalog()).toContainEqual(expect.objectContaining({ modelId: 'minimax_h3', enabled: false }));
    expect((await context.restart().listProfiles()).every(profile => 'enabled' in profile && profile.enabled === false)).toBe(true);
    expect(context.calls.every(call => call.init?.method !== 'POST')).toBe(true);
  });

  it('preserves selected route order when the account pricing response lists the models in a different order', async () => {
    const context = fixture(cachedRoute, [
      { data: [{ id: 'minimax_h3' }, { id: 'Q10-SD2.5 全参' }] },
      { data: [
        { model_name: 'minimax_h3', supported_endpoint_types: ['openai-video'] },
        { model_name: 'Q10-SD2.5 全参', supported_endpoint_types: ['openai-video'] },
      ] },
    ]);
    context.snapshot.profiles = [
      { ...cachedRoute, modelId: 'Q10-SD2.5 全参', modelRoute: 'julun-preserved-q10-route' },
      { ...cachedRoute, modelRoute: 'julun-minimax-h3' },
    ];
    await context.service.refreshCatalog();
    expect(context.write).toHaveBeenCalledWith(expect.objectContaining({ profiles: [
      expect.objectContaining({ modelId: 'Q10-SD2.5 全参', modelRoute: 'julun-preserved-q10-route' }),
      expect.objectContaining({ modelId: 'minimax_h3', modelRoute: 'julun-minimax-h3' }),
    ] }));
  });

  it.each(['vendor-video-unknown', 'seedance-2.0-fast-deal', 'grok-imagine-video-1.5-preview', 'sd2.0-720', 'seedance-2.0-deal'])(
    'downgrades an unknown or historical cached complete route %s and blocks new submissions', async modelId => {
    const context = fixture({ ...cachedRoute, modelId });
    expect((await context.service.listProfiles())[0]).toMatchObject({ modelId, capabilityStatus: 'incomplete' });
    await expect(context.service.submitVideoJob({
      provider: 'julun', modelRoute: cachedRoute.modelRoute, prompt: 'orbit', sessionId: 'session-fixture', referenceAssetIds: [],
    })).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' });
    expect(context.calls).toEqual([]);
    expect(context.getPrimaryToken).not.toHaveBeenCalled();
  });

  it('normalizes the real seven cached generic video profiles without writing or changing their identity and selection', async () => {
    const oldVideo = {
      aspectRatios: ['16:9' as const], resolutions: ['720p' as const],
      duration: { mode: 'options' as const, defaultValue: 10, options: [5, 10] }, outputCounts: [1 as const],
    };
    const modelIds = ['minimax-h3 768p', 'grok-imagine-video-1.5（按次）', 'sd2.5', 'minimax_h3', 'sd2-mini',
      'Minimax-H3-768p-933-10s-15s', 'minimax-h3 2k'];
    const stored = modelIds.map((modelId, index) => ({
      ...cachedRoute, modelId, modelRoute: `julun-cached-${index}`, constraints: { video: oldVideo },
    }));
    const context = fixture();
    context.snapshot.profiles = structuredClone(stored);
    const listed = (await context.service.listProfiles()).slice(0, 7);

    expect(listed.map(profile => [profile.modelId, profile.modelRoute])).toEqual(modelIds.map((id, index) => [id, `julun-cached-${index}`]));
    expect(listed.map(profile => profile.capabilityStatus)).toEqual(['incomplete', 'complete', 'incomplete', 'complete', 'incomplete', 'complete', 'incomplete']);
    expect(listed.map(profile => profile.constraints!.video!.resolutions)).toEqual([
      ['768p'], ['480p', '720p'], ['720p'], ['480p', '768p'], ['480p', '720p'], ['768p'], ['2K'],
    ]);
    expect(listed.map(profile => profile.constraints!.video!.duration)).toEqual([
      { mode: 'range', defaultValue: 10, min: 10, max: 15, step: 1 },
      { mode: 'range', defaultValue: 10, min: 6, max: 15, step: 1 },
      { mode: 'range', defaultValue: 10, min: 4, max: 30, step: 1 },
      { mode: 'range', defaultValue: 10, min: 5, max: 15, step: 1 },
      { mode: 'range', defaultValue: 10, min: 5, max: 12, step: 1 },
      { mode: 'range', defaultValue: 10, min: 10, max: 15, step: 1 },
      { mode: 'range', defaultValue: 10, min: 10, max: 15, step: 1 },
    ]);
    expect(listed[0]!.constraints!.video!.aspectRatios).toBeUndefined();
    expect(context.snapshot.profiles).toEqual(stored);
    expect(context.write).not.toHaveBeenCalled();
    expect(context.calls).toEqual([]);
    expect(context.getPrimaryToken).not.toHaveBeenCalled();
  });

  it('does not promote an unverified public preview to runnable merely because its parameter evidence is complete', async () => {
    const context = fixture({ ...cachedRoute, modelId: 'Q10-SD2.5 全参', capabilityStatus: 'incomplete' });
    expect((await context.service.listProfiles())[0]).toMatchObject({ modelId: 'Q10-SD2.5 全参', capabilityStatus: 'incomplete' });
    await expect(context.service.submitVideoJob({
      provider: 'julun', modelRoute: cachedRoute.modelRoute, prompt: 'orbit', sessionId: 'session-fixture', referenceAssetIds: [],
    })).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' });
    expect(context.calls).toEqual([]);
  });

  it('does not replace a cached route when a newly visible builtin seed uses that route', async () => {
    const context = fixture({ ...cachedRoute, modelRoute: 'julun-sd2-mini' });
    const listed = await context.service.listProfiles();
    expect(listed[0]).toMatchObject({ modelId: 'minimax_h3', modelRoute: 'julun-sd2-mini' });
    expect(listed.find(profile => profile.modelId === 'sd2-mini')!.modelRoute).not.toBe('julun-sd2-mini');
    expect(new Set(listed.map(profile => profile.modelRoute)).size).toBe(listed.length);
    expect(context.calls).toEqual([]);
  });

  it('keeps newly authenticated complete models disabled and preserves the selected dynamic route', async () => {
    const context = fixture({ ...cachedRoute, modelId: 'Q10-SD2.5 全参' }, [
      { data: [{ id: 'minimax_h3' }, { id: 'Q10-SD2.5 全参' }] },
      { data: [
        { model_name: 'minimax_h3', supported_endpoint_types: ['openai-video'] },
        { model_name: 'Q10-SD2.5 全参', supported_endpoint_types: ['openai-video'] },
      ] },
    ]);
    const refreshed = await context.service.refreshCatalog();
    expect(refreshed).toContainEqual(expect.objectContaining({
      modelId: 'Q10-SD2.5 全参', modelRoute: cachedRoute.modelRoute, capabilityStatus: 'complete', enabled: true,
    }));
    expect(refreshed).toContainEqual(expect.objectContaining({
      modelId: 'minimax_h3', capabilityStatus: 'complete', enabled: false,
    }));
    expect(context.calls.map(call => call.url)).toEqual(['https://julun.cc/v1/models', 'https://julun.cc/api/pricing']);
    expect(context.write).toHaveBeenCalledWith(expect.objectContaining({ profiles: expect.arrayContaining([
      expect.objectContaining({ modelId: 'Q10-SD2.5 全参', modelRoute: cachedRoute.modelRoute }),
      expect.objectContaining({ modelId: 'minimax_h3', enabled: false }),
    ]) }));
  });

  it('sends the selected model parameters and one managed image using the documented multipart fields', async () => {
    const context = fixture();
    await context.service.submitVideoJob({
      provider: 'julun', modelRoute: cachedRoute.modelRoute, prompt: 'keep product shape',
      sessionId: 'session-fixture', referenceAssetIds: ['0123456789abcdef'],
      aspectRatio: '9:16', resolution: '768p', durationSeconds: 15,
    });

    expect(context.calls).toHaveLength(1);
    expect(context.calls[0]!.url).toBe('https://julun.cc/v1/videos');
    const multipart = Buffer.from(context.calls[0]!.init!.body as Uint8Array).toString('utf8');
    expect(multipart).toContain('name="model"\r\n\r\nminimax_h3');
    expect(multipart).toContain('name="duration"\r\n\r\n15');
    expect(multipart).toContain('name="width"\r\n\r\n768');
    expect(multipart).toContain('name="height"\r\n\r\n1365');
    expect(multipart).toContain('name="image"\r\n\r\ndata:image/png;base64,iVBORw==');
    expect(multipart).not.toContain('name="input_reference"');
    expect(multipart).not.toContain('name="video"');
    expect(multipart).not.toContain('name="audio"');
    expect(context.readReferenceImage).toHaveBeenCalledWith('session-fixture', '0123456789abcdef');
  });

  it.each([
    { aspectRatio: '1:1' as const },
    { resolution: '1080p' as const },
    { durationSeconds: 30 },
    { durationSeconds: 2.5 },
  ])('rejects an unsupported model parameter before reading media or submitting: %j', async (parameters) => {
    const context = fixture();
    await expect(context.service.submitVideoJob({
      provider: 'julun', modelRoute: cachedRoute.modelRoute, prompt: 'orbit',
      sessionId: 'session-fixture', referenceAssetIds: ['0123456789abcdef'], ...parameters,
    })).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' });
    expect(context.calls).toEqual([]);
    expect(context.getPrimaryToken).not.toHaveBeenCalled();
    expect(context.readReferenceImage).not.toHaveBeenCalled();
  });

  it('uses the public default grid when the cached profile has no parameter defaults', async () => {
    const context = fixture({ ...cachedRoute, constraints: undefined });
    await context.service.submitVideoJob({
      provider: 'julun', modelRoute: cachedRoute.modelRoute, prompt: 'orbit',
      sessionId: 'session-fixture', referenceAssetIds: [],
    });
    const multipart = Buffer.from(context.calls[0]!.init!.body as Uint8Array).toString('utf8');
    expect(multipart).toContain('name="duration"\r\n\r\n10');
    expect(multipart).toContain('name="width"\r\n\r\n854');
    expect(multipart).toContain('name="height"\r\n\r\n480');
  });

  it('checks the public duration step even without cached duration restrictions', async () => {
    const context = fixture({ ...cachedRoute, constraints: undefined });
    await expect(context.service.submitVideoJob({
      provider: 'julun', modelRoute: cachedRoute.modelRoute, prompt: 'orbit',
      sessionId: 'session-fixture', referenceAssetIds: [], durationSeconds: 6.5,
    })).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' });
    expect(context.calls).toEqual([]);
    expect(context.getPrimaryToken).not.toHaveBeenCalled();
  });

  it('submits the explicitly documented 21:9 H3 grid without dropping the selected ratio', async () => {
    const context = fixture({ ...cachedRoute, modelId: 'Minimax-H3-768p-933-10s-15s', constraints: undefined });
    await context.service.submitVideoJob({
      provider: 'julun', modelRoute: cachedRoute.modelRoute, prompt: 'wide scene',
      sessionId: 'session-fixture', referenceAssetIds: [], aspectRatio: '21:9', resolution: '768p', durationSeconds: 12,
    });
    const multipart = Buffer.from(context.calls[0]!.init!.body as Uint8Array).toString('utf8');
    expect(multipart).toContain('name="width"\r\n\r\n1792');
    expect(multipart).toContain('name="height"\r\n\r\n768');
    expect(multipart).toContain('name="duration"\r\n\r\n12');
  });

  it.each(['wan-3.0-c2', 'seedance-2.0-c2', 'seedance-2.0-fast-c2', 'video-editing'])(
    'does not submit the cached complete route %s without its required protocol evidence', async modelId => {
    const context = fixture({ ...cachedRoute, modelId, constraints: undefined });
    await expect(context.service.submitVideoJob({
      provider: 'julun', modelRoute: cachedRoute.modelRoute, prompt: 'orbit',
      sessionId: 'session-fixture', referenceAssetIds: [],
    })).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' });
    expect(context.calls).toEqual([]);
    expect(context.getPrimaryToken).not.toHaveBeenCalled();
  });
});
