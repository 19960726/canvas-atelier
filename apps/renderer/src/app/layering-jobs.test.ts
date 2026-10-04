import { describe, expect, it, vi } from 'vitest';
import type { ProviderBridgeProfile } from '@agent-canvas/desktop-core';
import { confirmLayeringPlan, parseLayeringAnalysis } from './layering-plan';
import { buildLayeringJobRequests } from './layering-jobs';
import type { LayeringRouteEvidence } from './layering-route-evidence';
import { compatibleLayerDimensions } from './layering-selection';
import { mapComflyGptImageExactSize } from '../../../../packages/provider-comfly/src/client';

const planReply = JSON.stringify({ layers: [
  { layerId: 'background', kind: 'background', name: '背景', description: '还原浅色厨房台面', included: true },
  { layerId: 'product-main', kind: 'transparent', name: '蓝色产品本体', description: '保留产品与完整轮廓，不包含阴影。', included: true },
  { layerId: 'prop-vase', kind: 'transparent', name: '左侧玻璃花瓶', description: '仅花瓶像素，不包含花瓶投影。', included: true },
  { layerId: 'shadow-product', kind: 'transparent', name: '产品接触阴影', description: '仅产品下方接触阴影，不包含产品像素。', included: true },
  { layerId: 'shadow-vase', kind: 'transparent', name: '花瓶投影', description: '仅花瓶投影，不包含花瓶像素。', included: true },
  { layerId: 'slogan', kind: 'transparent', name: '包装文字标记', description: '单独保留包装上的文字区域', included: false },
] });
const imageProfile: ProviderBridgeProfile = {
  provider: 'comfly', modelRoute: 'comfly-gpt-image-2', modelId: 'gpt-image-2', displayName: 'GPT Image 2',
  capabilities: ['image_generation', 'image_edit', 'async_tasks'], capabilityStatus: 'complete',
};
const routeEvidence: LayeringRouteEvidence = {
  provider: 'comfly', modelRoute: 'comfly-gpt-image-2', modelId: 'gpt-image-2', source: 'live_alpha_qa',
  verifiedAt: '2026-09-23T06:00:00.000Z', transparentBackground: true, outputFormat: 'png', resolutions: ['1K', '2K'],
};

describe('confirmed GPT layering requests', () => {
  it('gives a held-object matte the confirmed peer ownership, including unselected peers', async () => {
    const plan = { ...parseLayeringAnalysis(JSON.stringify({ layers: [
      { layerId: 'background', kind: 'background', name: '厨房背景', description: '补全厨房', included: true },
      { layerId: 'hands', kind: 'transparent', name: '人物手部与衣袖',
        description: '白色衣袖、拿杯盖的手指以及握持保温杯的右手与手臂', included: true,
        sourceBounds: { x: 0, y: 0, width: .56, height: .78 } },
      { layerId: 'lid', kind: 'transparent', name: '便携杯盖组件', description: '灰色杯盖和橙色提手，不含手部',
        included: true, sourceBounds: { x: .14, y: .05, width: .38, height: .36 } },
      { layerId: 'body', kind: 'transparent', name: '保温杯杯身', description: '金属杯身和底座，不含手部',
        included: false, sourceBounds: { x: .28, y: .23, width: .55, height: .77 } },
    ] }), 'source-asset', 2196, 2196), pixelMode: 'source' as const };
    const confirmation = await confirmLayeringPlan(plan, 'comfly', imageProfile.modelRoute, '2K', '2026-09-23T06:05:00.000Z');
    const requests = await buildLayeringJobRequests(plan, confirmation, imageProfile, 'held-objects', [routeEvidence], () => crypto.randomUUID());
    const prompt = requests.find(request => request.layeringLayerId === 'hands')!.prompt;
    const peerLine = prompt.split('\n').find(line => line.startsWith('Other foreground layers in the confirmed plan: '));
    expect(peerLine).toBeDefined();
    const peers = JSON.parse(peerLine!.slice('Other foreground layers in the confirmed plan: '.length));
    expect(peers).toEqual(plan.layers.slice(2).map(layer => ({ layerId: layer.layerId, name: layer.name,
      instructions: layer.description, included: layer.included, sourceBounds: layer.sourceBounds })));
    expect(prompt).toContain('Holding, touching, or occluding another object does not make that object part of this layer');
    expect(prompt).toContain('Do not complete hidden foreground parts');
    expect(prompt).toContain('Never erase a whole peer sourceBounds rectangle');
    expect(prompt).toContain('Do not copy the carrier object');
    expect(requests.map(request => request.layeringLayerId)).toEqual(['background', 'hands', 'lid']);
    expect(requests[0]!.prompt).not.toContain('Other foreground layers in the confirmed plan');
    expect(requests[0]!.prompt).not.toContain('保温杯杯身');
  });

  it('uses one confirmed plan snapshot even if the input changes during async confirmation hashing', async () => {
    const parsed = parseLayeringAnalysis(planReply, 'source-asset', 1200, 1600);
    const plan = { ...parsed, pixelMode: 'source' as const, layers: parsed.layers.map(layer => ({ ...layer,
      sourceBounds: { x: .25, y: .25, width: .5, height: .5 } })) };
    const confirmation = await confirmLayeringPlan(plan, 'comfly', imageProfile.modelRoute, '2K', '2026-09-23T06:05:00.000Z');
    const makeId = vi.fn(() => crypto.randomUUID());
    const pending = buildLayeringJobRequests(plan, confirmation, imageProfile, 'snapshot', [routeEvidence], makeId);
    plan.layers[2]!.description = 'unconfirmed object replacement';
    plan.layers[2]!.sourceBounds.x = .1;
    const requests = await pending;
    expect(requests.every(request => !request.prompt.includes('unconfirmed object replacement'))).toBe(true);
    expect(requests.find(request => request.layeringLayerId === 'prop-vase')!.prompt).toContain('仅花瓶像素');
    expect(requests.find(request => request.layeringLayerId === 'prop-vase')!.prompt).toContain('"x":0.25');
    await expect(buildLayeringJobRequests(plan, confirmation, imageProfile, 'snapshot', [routeEvidence], makeId)).rejects.toThrow(/confirmation/u);
    expect(makeId).toHaveBeenCalledTimes(5);
  });

  it('keeps the checked route and output tier when the caller mutates them during hashing', async () => {
    const plan = parseLayeringAnalysis(planReply, 'source-asset', 1200, 1600);
    const profile = { ...imageProfile };
    const checked = await confirmLayeringPlan(plan, 'comfly', profile.modelRoute, '2K', '2026-09-23T06:05:00.000Z');
    const confirmation = { ...checked, layerIds: [...checked.layerIds] };
    const evidence = [{ ...routeEvidence, resolutions: [...routeEvidence.resolutions] }];
    const pending = buildLayeringJobRequests(plan, confirmation, profile, 'checked-route', evidence, () => crypto.randomUUID());
    profile.modelRoute = 'unconfirmed-route';
    profile.modelId = 'unconfirmed-model';
    confirmation.resolution = '1K';
    evidence[0]!.resolutions.splice(0);
    const requests = await pending;
    expect(requests.every(request => request.modelRoute === imageProfile.modelRoute
      && request.modelId === imageProfile.modelId && request.resolution === '2K')).toBe(true);
  });

  it.each(['relayme', '4dai'] as const)('rejects unsupported %s managed-source editing before creating jobs even with alpha evidence', async provider => {
    const plan = parseLayeringAnalysis(planReply, 'source-asset', 2196, 2196);
    const profile: ProviderBridgeProfile = { ...imageProfile, provider, modelRoute: `qa-${provider}-gpt-image-2` };
    const evidence: LayeringRouteEvidence = { ...routeEvidence, provider, modelRoute: profile.modelRoute };
    const confirmation = await confirmLayeringPlan(plan, provider, profile.modelRoute, '2K', '2026-09-23T06:05:00.000Z');
    const makeId = vi.fn(() => 'must-not-be-created');

    await expect(buildLayeringJobRequests(plan, confirmation, profile, 'unsupported-source-edit', [evidence], makeId))
      .rejects.toThrow(/受管原图分层编辑传输/u);
    expect(makeId).not.toHaveBeenCalled();
  });

  it('accepts a source that is compatible only with actual Comfly 2K rounding', async () => {
    const plan = parseLayeringAnalysis(planReply, 'source-asset', 1348, 2048);
    const profile: ProviderBridgeProfile = { ...imageProfile,
      constraints: { image: { aspectRatios: ['2:3'], resolutions: ['2K'] } } };
    const confirmation = await confirmLayeringPlan(plan, 'comfly', profile.modelRoute, '2K', '2026-09-23T06:05:00.000Z');
    const makeId = vi.fn(() => crypto.randomUUID());
    const size = mapComflyGptImageExactSize('2K', '2:3');
    expect(size).toBe('1360x2048');
    const [outputWidth, outputHeight] = size.split('x').map(Number);
    expect(compatibleLayerDimensions(outputWidth!, outputHeight!, 1348, 2048)).toBe(true);

    const requests = await buildLayeringJobRequests(plan, confirmation, profile, 'actual-rounded-compatible', [routeEvidence], makeId);
    expect(requests).toHaveLength(5);
    expect(requests.every(request => request.aspectRatio === '2:3' && request.resolution === '2K')).toBe(true);
    expect(makeId).toHaveBeenCalledTimes(5);
  });

  it('rejects a source incompatible with actual Comfly 2K rounding before creating any layer job', async () => {
    const plan = parseLayeringAnalysis(planReply, 'source-asset', 1378, 2048);
    const profile: ProviderBridgeProfile = { ...imageProfile,
      constraints: { image: { aspectRatios: ['2:3'], resolutions: ['2K'] } } };
    const confirmation = await confirmLayeringPlan(plan, 'comfly', profile.modelRoute, '2K', '2026-09-23T06:05:00.000Z');
    const makeId = vi.fn(() => 'must-not-be-created');
    const size = mapComflyGptImageExactSize('2K', '2:3');
    expect(size).toBe('1360x2048');
    const [outputWidth, outputHeight] = size.split('x').map(Number);
    expect(compatibleLayerDimensions(outputWidth!, outputHeight!, 1378, 2048)).toBe(false);

    await expect(buildLayeringJobRequests(plan, confirmation, profile, 'actual-rounded-incompatible', [routeEvidence], makeId))
      .rejects.toThrow(/1378[x×]2048.*2:3/u);
    expect(makeId).not.toHaveBeenCalled();
  });

  it('rejects an unrepresentable source aspect before creating any layer job', async () => {
    const parsed = parseLayeringAnalysis(planReply, 'source-asset', 1000, 719);
    const plan = { ...parsed, pixelMode: 'source' as const, layers: parsed.layers.map(layer => ({ ...layer,
      sourceBounds: { x: .25, y: .25, width: .5, height: .5 } })) };
    const confirmation = await confirmLayeringPlan(plan, 'comfly', imageProfile.modelRoute, '2K', '2026-09-23T06:05:00.000Z');
    const makeId = vi.fn(() => 'must-not-be-created');

    // A standard 4:3 response cannot pass the existing source-coordinate check.
    expect(compatibleLayerDimensions(2048, 1536, 1000, 719)).toBe(false);
    await expect(buildLayeringJobRequests(plan, confirmation, imageProfile, 'incompatible-aspect', [routeEvidence], makeId))
      .rejects.toThrow(/1000[x×]719.*4:3/u);
    expect(makeId).not.toHaveBeenCalled();
  });

  it('rejects a source aspect unavailable on the selected route before creating any layer job', async () => {
    const plan = parseLayeringAnalysis(planReply, 'source-asset', 600, 900);
    const profile: ProviderBridgeProfile = { ...imageProfile,
      constraints: { image: { aspectRatios: ['1:1', '16:9'], resolutions: ['2K'] } } };
    const confirmation = await confirmLayeringPlan(plan, 'comfly', profile.modelRoute, '2K', '2026-09-23T06:05:00.000Z');
    const makeId = vi.fn(() => 'must-not-be-created');

    await expect(buildLayeringJobRequests(plan, confirmation, profile, 'unavailable-aspect', [routeEvidence], makeId))
      .rejects.toThrow(/600[x×]900.*1:1.*16:9/u);
    expect(makeId).not.toHaveBeenCalled();
  });

  it('preserves a supported rounded 2:3 tier and legacy plans without source bounds', async () => {
    const plan = parseLayeringAnalysis(planReply, 'source-asset', 1365, 2048);
    const profile: ProviderBridgeProfile = { ...imageProfile,
      constraints: { image: { aspectRatios: ['1:1', '2:3', '3:2'], resolutions: ['2K'] } } };
    const confirmation = await confirmLayeringPlan(plan, 'comfly', profile.modelRoute, '2K', '2026-09-23T06:05:00.000Z');
    const makeId = vi.fn(() => crypto.randomUUID());

    expect(compatibleLayerDimensions(1365, 2048, 600, 900)).toBe(true);
    const requests = await buildLayeringJobRequests(plan, confirmation, profile, 'legacy-portrait', [routeEvidence], makeId);
    expect(requests).toHaveLength(5);
    expect(requests.every(request => request.aspectRatio === '2:3' && request.resolution === '2K')).toBe(true);
    expect(requests[0]).toMatchObject({ imageBackground: 'opaque', imageOutputFormat: 'png', imageQuality: 'high' });
    expect(requests[1]).toMatchObject({ imageBackground: 'transparent', referenceAssetIds: ['source-asset'] });
    expect(requests[1]!.prompt).toContain('Generate exactly the named foreground elements');
    expect(requests[1]!.prompt).not.toContain('OUTPUT AN ALPHA MATTE ONLY');
    expect(requests[1]!.prompt).not.toContain('Other foreground layers in the confirmed plan');
    expect(makeId).toHaveBeenCalledTimes(5);
  });

  it('requests continuous source-coordinate mattes, including glass and soft shadows', async () => {
    const parsed = parseLayeringAnalysis(planReply, 'source-asset', 1200, 1600);
    const plan = { ...parsed, pixelMode: 'source' as const, layers: parsed.layers.map(layer => ({ ...layer,
      sourceBounds: { x: .25, y: .25, width: .5, height: .5 } })) };
    const confirmation = await confirmLayeringPlan(plan, 'comfly', imageProfile.modelRoute, '2K', '2026-09-23T06:05:00.000Z');
    const requests = await buildLayeringJobRequests(plan, confirmation, imageProfile, 'matte', [routeEvidence], () => crypto.randomUUID());
    expect(requests[1]!.prompt).toContain('continuous alpha');
    expect(requests[1]!.prompt).toContain('glass');
    expect(requests[0]!.prompt).toContain('Preserve every unoccluded');
  });
  it('binds scope to confirmation and every layer request, rejecting a moved selection', async () => {
    const plan = { ...parseLayeringAnalysis(planReply, 'source-asset', 1200, 1600),
      selection: { mode: 'objects' as const, box: { x: .25, y: .5, width: .25, height: .25 }, target: '红色料理机' } };
    const confirmation = await confirmLayeringPlan(plan, 'comfly', imageProfile.modelRoute, '2K', '2026-09-23T06:05:00.000Z');
    const requests = await buildLayeringJobRequests(plan, confirmation, imageProfile, 'scope', [routeEvidence], () => crypto.randomUUID());
    expect(requests.every(request => request.prompt.includes('红色料理机') && request.prompt.includes('300,800'))).toBe(true);
    await expect(buildLayeringJobRequests({ ...plan, selection: { ...plan.selection, box: { ...plan.selection.box, x: .5 } } },
      confirmation, imageProfile, 'scope', [routeEvidence], () => crypto.randomUUID())).rejects.toThrow(/confirmation/u);
  });
  it('creates one ordered edit request per included layer using the exact source and alpha settings', async () => {
    const plan = parseLayeringAnalysis(planReply, 'source-asset', 1024, 768);
    const confirmation = await confirmLayeringPlan(plan, 'comfly', imageProfile.modelRoute, '2K', '2026-09-23T06:05:00.000Z');
    const makeId = vi.fn().mockReturnValueOnce('job-background').mockReturnValueOnce('job-product')
      .mockReturnValueOnce('job-vase').mockReturnValueOnce('job-product-shadow').mockReturnValueOnce('job-vase-shadow');

    const requests = await buildLayeringJobRequests(plan, confirmation, imageProfile, 'group-1', [routeEvidence], makeId);

    expect(requests).toHaveLength(5);
    expect(requests.map((request) => request.layeringLayerId)).toEqual([
      'background', 'product-main', 'prop-vase', 'shadow-product', 'shadow-vase',
    ]);
    expect(requests[0]).toMatchObject({ id: 'job-background', promptNodeId: 'image-layer-group-1-background', imageBackground: 'opaque' });
    expect(requests[1]).toMatchObject({ id: 'job-product', promptNodeId: 'image-layer-group-1-product-main', imageBackground: 'transparent' });
    expect(requests[0]).toMatchObject({ layeringOutputContract: 'opaque-background-v2', layeringConfirmationDigest: confirmation.digest });
    expect(requests[1]).toMatchObject({ layeringOutputContract: 'source-alpha-matte-v1', layeringConfirmationDigest: confirmation.digest });
    expect(requests.every((request) => request.aspectRatio === '4:3' && request.imageQuality === 'high')).toBe(true);
    expect(requests[2]).toMatchObject({ id: 'job-vase', promptNodeId: 'image-layer-group-1-prop-vase', imageBackground: 'transparent' });
    expect(requests[3]?.prompt).toContain('仅产品下方接触阴影，不包含产品像素');
    expect(requests[3]?.prompt).toContain('For a shadow-only layer, generate only the named shadow pixels; do not redraw the associated product or prop.');
    expect(requests[4]?.prompt).toContain('仅花瓶投影，不包含花瓶像素');
    expect(makeId).toHaveBeenCalledTimes(5);
  });

  it('keeps a portrait source at its native aspect and requests highest quality 4K output', async () => {
    const plan = parseLayeringAnalysis(planReply, 'source-asset', 2480, 3312);
    const profile = { ...imageProfile, modelRoute: 'comfly-gpt-image-2-5-flare-4k', modelId: 'gpt-image-2.5-flare-4k' };
    const evidence = [{ ...routeEvidence, modelRoute: profile.modelRoute, modelId: profile.modelId, resolutions: ['4K'] as const }];
    const confirmation = await confirmLayeringPlan(plan, 'comfly', profile.modelRoute, '4K', '2026-09-23T06:05:00.000Z');
    const requests = await buildLayeringJobRequests(plan, confirmation, profile, 'portrait', evidence, () => crypto.randomUUID());
    expect(requests[0]).toMatchObject({ aspectRatio: '3:4', resolution: '4K', imageQuality: 'high' });
  });

  it('rejects unsupported transports, stale plans, and resolutions outside the route contract', async () => {
    const plan = parseLayeringAnalysis(planReply, 'source-asset', 1024, 768);
    const confirmation = await confirmLayeringPlan(plan, 'comfly', imageProfile.modelRoute, '4K', '2026-09-23T06:05:00.000Z');
    const makeId = vi.fn(() => 'must-not-be-created');

    await expect(buildLayeringJobRequests(plan, confirmation, imageProfile, 'group-1', [], makeId)).rejects.toThrow(/4K/u);
    await expect(buildLayeringJobRequests({ ...plan, sourceAssetId: 'changed-source' }, confirmation, imageProfile, 'group-1', [routeEvidence], makeId)).rejects.toThrow(/confirmation/u);
    await expect(buildLayeringJobRequests(plan, confirmation, imageProfile, 'group-1', [routeEvidence], makeId)).rejects.toThrow(/4K/u);
    expect(makeId).not.toHaveBeenCalled();
  });
});
