import { describe, expect, it, vi } from 'vitest';
import type { ProviderBridgeProfile } from '@agent-canvas/desktop-core';
import { confirmLayeringPlan, parseLayeringAnalysis } from './layering-plan';
import { buildLayeringJobRequests } from './layering-jobs';
import type { LayeringRouteEvidence } from './layering-route-evidence';

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
