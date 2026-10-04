import { describe, expect, it } from 'vitest';
import { applyProjectTransaction, createCanvasModuleNode, parseCanvasProject } from '@agent-canvas/domain';
import type { ProviderBridgeProfile } from '@agent-canvas/desktop-core';
import { analyzeImageLayering } from './layering-analysis';
import { restoreLayeringDraft } from './layering-draft';
import { buildLayeringGraphTransaction, isLayeringPlanBoundToGroup } from './layering-graph';
import { buildLayeringJobRequests } from './layering-jobs';
import { confirmLayeringPlan, matchesLayeringConfirmation, normalizeLayeringPlan, type LayeringPlan } from './layering-plan';
import type { LayeringRouteEvidence } from './layering-route-evidence';

const sourceAssetId = 'a1b2c3d4e5f60718';
const analysisProfile: ProviderBridgeProfile = { provider: 'comfly', modelRoute: 'vision', modelId: 'vision',
  displayName: 'Vision', capabilities: ['chat', 'vision'], capabilityStatus: 'complete' };
const imageProfile: ProviderBridgeProfile = { provider: 'comfly', modelRoute: 'comfly-gpt-image-2', modelId: 'gpt-image-2',
  displayName: 'GPT Image 2', capabilities: ['image_generation', 'image_edit', 'async_tasks'], capabilityStatus: 'complete' };
const evidence: LayeringRouteEvidence[] = [{ provider: 'comfly', modelRoute: imageProfile.modelRoute, modelId: imageProfile.modelId!,
  source: 'live_alpha_qa', verifiedAt: '2026-09-23T06:00:00.000Z', transparentBackground: true, outputFormat: 'png', resolutions: ['2K'], independentRgba: true }];
const layers = [
  { layerId: 'background', kind: 'background' as const, name: '厨房背景', description: '补全移除物体后的厨房', included: true, elementIds: ['scene'] },
  { layerId: 'hands', kind: 'transparent' as const, name: '人物手部与衣袖', description: '只包含手部与衣袖，不包含所持杯盖',
    included: true, sourceBounds: { x: 0, y: 0, width: .5, height: .8 }, elementIds: ['hands'] },
  { layerId: 'lid', kind: 'transparent' as const, name: '杯盖组件', description: '仅杯盖，不含人物手部',
    included: false, sourceBounds: { x: .1, y: .1, width: .4, height: .3 }, elementIds: ['lid'] },
];
const elements = [
  { elementId: 'scene', name: '厨房场景', layerId: 'background', kind: 'object' as const },
  { elementId: 'hands', name: '人物手部与衣袖', layerId: 'hands', kind: 'object' as const },
  { elementId: 'lid', name: '杯盖组件', layerId: 'lid', kind: 'object' as const },
];
const analyzedReply = JSON.stringify({ layers, elements });
const legacyPlan: LayeringPlan = { sourceAssetId, canvasWidth: 2196, canvasHeight: 2196, pixelMode: 'source', layers, elements };
const independentPlan = { ...legacyPlan, foregroundOutputContract: 'source-independent-rgba-v2' as const };
const confirmedAt = '2026-10-03T12:00:00.000Z';
const confirm = (plan: LayeringPlan) => confirmLayeringPlan(plan, 'comfly', imageProfile.modelRoute, '2K', confirmedAt);

describe('explicit independent RGBA layering route', () => {
  it('uses independent foreground output for a new successful analysis without submitting image jobs', async () => {
    let calls = 0;
    const plan = await analyzeImageLayering({ sourceAssetId, width: 2196, height: 2196, profile: analysisProfile,
      }, async request => {
      calls += 1;
      expect(request.purpose).toBe('image_layering_analysis');
      return { message: analyzedReply, modelRoute: 'vision', sources: [] };
    });
    expect(calls).toBe(1);
    expect(plan).toMatchObject({ pixelMode: 'source', foregroundOutputContract: 'source-independent-rgba-v2' });
  });

  it('keeps the representation decision independent from vision-route evidence', async () => {
    const plan = await analyzeImageLayering({ sourceAssetId, width: 2196, height: 2196, profile: analysisProfile }, async () => ({
      message: analyzedReply, modelRoute: 'vision', sources: [],
    }));
    expect(plan).toMatchObject({ pixelMode: 'source' });
    expect(plan).toHaveProperty('foregroundOutputContract', 'source-independent-rgba-v2');
  });

  it('requests true foreground colors and continuous transparency with peer exclusion', async () => {
    const confirmation = await confirm(independentPlan);
    const requests = await buildLayeringJobRequests(independentPlan, confirmation, imageProfile, 'independent', evidence, () => crypto.randomUUID());
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({ layeringOutputContract: 'opaque-background-v2' });
    expect(requests[1]).toMatchObject({ layeringOutputContract: 'source-independent-rgba-v2', imageBackground: 'transparent',
      imageOutputFormat: 'png', referenceAssetIds: [sourceAssetId], layeringConfirmationDigest: confirmation.digest });
    expect(requests[1]!.prompt).toContain('independent foreground RGB');
    expect(requests[1]!.prompt).toContain('continuous alpha');
    expect(requests[1]!.prompt).toContain('"included":false');
    expect(requests[1]!.prompt).toContain('Holding, touching, or occluding');
    expect(requests[1]!.prompt).toContain('Owned element registry');
    expect(requests[1]!.prompt).toContain('Forbidden element registry');
    expect(requests[0]!.prompt).toContain('ownership registry is authoritative');
    expect(requests[1]!.prompt).toContain('Do not complete hidden foreground parts');
    expect(requests[1]!.prompt).not.toContain('OUTPUT AN ALPHA MATTE ONLY');
    expect(requests[1]!.prompt).not.toContain('white RGB');
  });

  it('requires a fresh confirmation when the foreground representation changes', async () => {
    const confirmation = await confirm(independentPlan);
    await expect(matchesLayeringConfirmation(confirmation, independentPlan, 'comfly', imageProfile.modelRoute, '2K')).resolves.toBe(true);
    await expect(matchesLayeringConfirmation(confirmation, legacyPlan, 'comfly', imageProfile.modelRoute, '2K')).resolves.toBe(false);
    await expect(buildLayeringJobRequests(legacyPlan, confirmation, imageProfile, 'changed', evidence, () => crypto.randomUUID())).rejects.toThrow(/confirmation/u);
  });

  it('preserves the explicit contract through planned graph serialization and fallback draft recovery', async () => {
    const source = createCanvasModuleNode('source', 'image_input', { x: 120, y: 180 });
    source.data.config.assetId = sourceAssetId;
    const project = parseCanvasProject({ version: 1, id: 'independent-project', name: 'Independent', nodes: [source], edges: [],
      assets: [{ assetId: sourceAssetId, byteSize: 16, extension: 'png', height: 2196, width: 2196, label: '原图', mediaType: 'image/png',
        origin: 'imported', sha256: `${sourceAssetId}${'b'.repeat(48)}` }], projectMemory: [], skillPromotionCandidates: [] });
    const confirmation = await confirm(independentPlan);
    const next = parseCanvasProject(JSON.parse(JSON.stringify(applyProjectTransaction(project,
      buildLayeringGraphTransaction(project, independentPlan, confirmation, 'independent')))));
    const group = next.nodes.find(node => node.id === 'image-layering-independent')!;
    expect(group).toMatchObject({ data: { config: { pixelMode: 'source', foregroundOutputContract: 'source-independent-rgba-v2' } } });
    expect(next.nodes.find(node => node.id === 'image-layer-independent-hands')).toMatchObject({ data: { config: {
      layeringOutputContract: 'source-independent-rgba-v2', maskSpace: 'source', status: 'planned',
    } } });
    const recovered = restoreLayeringDraft(sourceAssetId, {}, next.nodes);
    expect(recovered?.plan).toMatchObject({ foregroundOutputContract: 'source-independent-rgba-v2', pixelMode: 'source' });
    expect(recovered?.started).toBe(false);
  });

  it('preserves a saved draft contract instead of stripping it during reopening', () => {
    const draft = { sourceAssetId, plan: independentPlan, analysisRoute: 'comfly::vision', generationRoute: '', resolution: '4K',
      layerCountMode: 'auto', targetLayerCount: 5, selection: { mode: 'whole' }, step: 'edit', createdGroupId: null, started: false };
    expect(restoreLayeringDraft(sourceAssetId, { layeringDrafts: { [sourceAssetId]: draft } }, [])?.plan)
      .toMatchObject({ foregroundOutputContract: 'source-independent-rgba-v2' });
  });

  it('keeps existing source drafts on the original matte contract', async () => {
    const requests = await buildLayeringJobRequests(legacyPlan, await confirm(legacyPlan), imageProfile, 'legacy', evidence, () => crypto.randomUUID());
    expect(requests[1]).toMatchObject({ layeringOutputContract: 'source-alpha-matte-v1' });
    expect(requests[1]!.prompt).toContain('OUTPUT AN ALPHA MATTE ONLY');
    expect(normalizeLayeringPlan(legacyPlan)).not.toHaveProperty('foregroundOutputContract');
  });

  it('rejects a new independent contract without the original coordinate and validation mode', () => {
    const { pixelMode: _pixelMode, ...withoutSource } = independentPlan;
    expect(() => normalizeLayeringPlan(withoutSource)).toThrow();
  });

  it.each([
    { name: 'allows legacy children without contract fields', backgroundContract: undefined, foregroundContract: undefined,
      staleChildDigest: false, staleGroupDigest: false, expected: true },
    { name: 'allows existing opaque background and v1 foreground contracts', backgroundContract: 'opaque-background-v2', foregroundContract: 'source-alpha-matte-v1',
      staleChildDigest: false, staleGroupDigest: false, expected: true },
    { name: 'rejects an independent foreground inside a legacy graph', backgroundContract: undefined, foregroundContract: 'source-independent-rgba-v2',
      staleChildDigest: false, staleGroupDigest: false, expected: false },
    { name: 'rejects a matte contract on the background', backgroundContract: 'source-alpha-matte-v1', foregroundContract: undefined,
      staleChildDigest: false, staleGroupDigest: false, expected: false },
    { name: 'rejects an independent foreground contract on the background', backgroundContract: 'source-independent-rgba-v2', foregroundContract: undefined,
      staleChildDigest: false, staleGroupDigest: false, expected: false },
    { name: 'rejects an opaque background contract on the foreground', backgroundContract: undefined, foregroundContract: 'opaque-background-v2',
      staleChildDigest: false, staleGroupDigest: false, expected: false },
    { name: 'rejects a mismatched child confirmation digest', backgroundContract: undefined, foregroundContract: undefined,
      staleChildDigest: true, staleGroupDigest: false, expected: false },
    { name: 'rejects a mismatched group confirmation digest', backgroundContract: undefined, foregroundContract: undefined,
      staleChildDigest: false, staleGroupDigest: true, expected: false },
  ])('$name', async ({ backgroundContract, foregroundContract, staleChildDigest, staleGroupDigest, expected }) => {
    const source = createCanvasModuleNode('legacy-source', 'image_input', { x: 120, y: 180 });
    source.data.config.assetId = sourceAssetId;
    const project = parseCanvasProject({ version: 1, id: 'legacy-contract-project', name: 'Legacy contract', nodes: [source], edges: [],
      assets: [{ assetId: sourceAssetId, byteSize: 16, extension: 'png', height: 2196, width: 2196, label: '原图', mediaType: 'image/png',
        origin: 'imported', sha256: `${sourceAssetId}${'b'.repeat(48)}` }], projectMemory: [], skillPromotionCandidates: [] });
    const confirmation = await confirm(legacyPlan);
    const saved = applyProjectTransaction(project, buildLayeringGraphTransaction(project, legacyPlan, confirmation, 'legacy-contract'));
    for (const node of saved.nodes) {
      if (node.type !== 'module' || node.data.config.groupId !== 'legacy-contract') continue;
      if (node.data.moduleType === 'image_layering') {
        if (staleGroupDigest) node.data.config.layeringConfirmationDigest = 'f'.repeat(64);
        continue;
      }
      if (node.data.moduleType !== 'image_layer') continue;
      const contract = node.data.config.layerKind === 'background' ? backgroundContract : foregroundContract;
      if (contract !== undefined) node.data.config.layeringOutputContract = contract;
      if (staleChildDigest && node.data.config.layerKind !== 'background') node.data.config.layeringConfirmationDigest = 'f'.repeat(64);
    }
    expect(isLayeringPlanBoundToGroup(saved, legacyPlan, confirmation, 'legacy-contract')).toBe(expected);
  });
});
