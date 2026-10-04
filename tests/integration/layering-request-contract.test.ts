// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createConfirmedModelJob } from '@agent-canvas/domain';
import { analyzeImageLayering } from '../../apps/renderer/src/app/layering-analysis';
import { buildLayeringJobRequests } from '../../apps/renderer/src/app/layering-jobs';
import { confirmLayeringPlan, type LayeringPlan } from '../../apps/renderer/src/app/layering-plan';
import { createDesktopModelJobExecutor } from '../../apps/renderer/src/jobs/desktop-model-executor';
import { executeSkillChat } from '../../packages/desktop-core/src/provider-skill-chat';
import { buildSkillChatSystemInstructions } from '../../packages/desktop-core/src/skill-chat-visual-analysis';
import { createComflyProviderService, createSecureProviderCredentialStore } from '../../packages/desktop-core/src/provider-bridge';
import type { ManagedKnowledgeStore } from '../../packages/desktop-core/src/managed-knowledge-store';
import type { ProviderBridgeProfile } from '../../packages/desktop-core/src/provider-contracts';

const sourceAssetId = 'a'.repeat(16);
const visionProfile: ProviderBridgeProfile = { provider: 'comfly', modelRoute: 'vision/chat', modelId: 'gpt-4o',
  displayName: 'Fixture vision', capabilities: ['chat', 'vision'] };
const imageProfile: ProviderBridgeProfile = { provider: 'comfly', modelRoute: 'fixture-gpt-image', modelId: 'gpt-image-2',
  displayName: 'Fixture image', capabilities: ['image_generation', 'image_edit', 'async_tasks'] };
const plan: LayeringPlan = { sourceAssetId, canvasWidth: 64, canvasHeight: 64, pixelMode: 'source',
  layers: [
    { layerId: 'background', kind: 'background', name: '厨房背景', description: '补全厨房台面', included: true },
    { layerId: 'cup', kind: 'transparent', name: '蓝色杯子', description: '仅杯体，不含手和投影', included: true,
      sourceBounds: { x: .25, y: .25, width: .25, height: .5 } },
    { layerId: 'hand', kind: 'transparent', name: '握杯的手', description: '仅手部，不含杯体', included: true,
      sourceBounds: { x: .125, y: .375, width: .25, height: .25 } },
    { layerId: 'shadow-cup', kind: 'transparent', name: '杯子投影', description: '仅杯子投影，不含杯体', included: true,
      sourceBounds: { x: .25, y: .75, width: .375, height: .125 } },
    { layerId: 'unselected-vase', kind: 'transparent', name: '未选花瓶', description: '保留花瓶', included: false,
      sourceBounds: { x: .75, y: .125, width: .125, height: .5 } },
  ] };
const temporaryRoots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const root of temporaryRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('layering assembled request contracts', () => {
  it('keeps the actual layering analysis system contract in JSON without a competing reverse essay', async () => {
    let system = '';
    await analyzeImageLayering({ sourceAssetId, width: 64, height: 64, profile: visionProfile }, async input => {
      return executeSkillChat({
        request: { ...input, provider: 'comfly', sessionId: 'fixture-layer-analysis' },
        captureRuntimeSnapshot: async () => ({ profiles: [visionProfile] }),
        createClient: () => ({ chat: async request => {
          system = String((request.messages as readonly { content?: unknown }[])[0]?.content);
          return { id: 'fixture-chat', model: 'gpt-4o',
            choices: [{ message: { role: 'assistant', content: JSON.stringify({ layers: plan.layers }) } }] };
        }, responses: vi.fn() }),
        managedKnowledgeStore: {} as ManagedKnowledgeStore,
        managedSkillChatImageResolver: { readManagedSkillChatImages: async () => [
          { bytes: Uint8Array.of(1), mediaType: 'image/png' },
        ] },
      });
    });
    expect(system).not.toContain('按固定结构输出');
    expect(system).not.toContain('最后依次输出中文提示词、英文提示词');
    expect(system).toContain('JSON');
    expect(system).toContain('sourceBounds');
    expect(system).not.toContain('优先完成 options');
  });

  it('keeps reverse workflow JSON separate from ordinary visual chat while retaining evidence rules', async () => {
    const input = { purpose: 'reverse_workflow' as const, agentMode: 'chat' as const, visualAnalysis: true,
      referenceMentions: [{ assetId: sourceAssetId, label: '原图', mention: '@图片1' }] };
    let system = '';
    await executeSkillChat({
      request: { ...input, provider: 'comfly', modelRoute: visionProfile.modelRoute,
        sessionId: 'fixture-reverse-workflow', referenceAssetIds: [sourceAssetId],
        messages: [{ role: 'user', content: '只返回反推工作流 JSON。' }],
        context: { knowledgeBaseIds: [], projectMemoryIds: [] } },
      captureRuntimeSnapshot: async () => ({ profiles: [visionProfile] }),
      createClient: () => ({ chat: async request => {
        system = String((request.messages as readonly { content?: unknown }[])[0]?.content);
        return { id: 'fixture-reverse', model: 'gpt-4o', choices: [{ message: { role: 'assistant', content: '{}' } }] };
      }, responses: vi.fn() }),
      managedKnowledgeStore: {} as ManagedKnowledgeStore,
      managedSkillChatImageResolver: { readManagedSkillChatImages: async () => [
        { bytes: Uint8Array.of(1), mediaType: 'image/png' },
      ] },
    });
    expect(system).not.toContain('按固定结构输出');
    expect(system).toContain('JSON');
    expect(system).toContain('可见');
    expect(buildSkillChatSystemInstructions({ agentMode: 'chat', visualAnalysis: true, referenceMentions: input.referenceMentions }))
      .toContain('中文提示词、英文提示词、负面约束、执行清单');
  });

  it('sends source mattes through the real job-to-transport assembly without a generic preserve-background command', async () => {
    const fixture = await imageTransportFixture();
    const requests = await layerRequests();
    await fixture.executor.submit(createConfirmedModelJob({ ...requests[1]!, confirmedAt: '2026-09-30T00:00:00.000Z',
      conversationId: 'fixture-matte', projectSessionId: 'fixture-session' }));
    const prompt = fixture.prompts[0]!;
    expect(prompt).not.toContain('preserve its composition, camera, lighting, and background');
    expect(prompt).not.toContain('Reference images are attached in the supplied order');
    expect(prompt).not.toContain('Generate exactly the named foreground elements as one pixel layer');
    expect(prompt).toContain('ALPHA MATTE ONLY');
    expect(prompt).toContain('white RGB');
    expect(prompt).toContain('continuous alpha');
    expect(prompt).toContain('64x64');
    expect(prompt).toContain('"x":0.25');
    expect(prompt).toContain('no zoom, crop, centering or enlargement');
    expect(prompt).toContain('Other foreground layers in the confirmed plan');
    expect(prompt).toContain('握杯的手');
    expect(prompt).toContain('未选花瓶');
    expect(prompt).toContain('"included":false');
    expect(prompt).toContain('Holding, touching, or occluding another object does not make that object part of this layer');
    expect(prompt).toContain('Never erase a whole peer sourceBounds rectangle');
    expect(prompt).toContain('Do not copy the carrier object');

    await fixture.executor.submit(createConfirmedModelJob({ ...requests[1]!, id: 'fixture-ordinary-edit',
      layeringGroupId: undefined, layeringLayerId: undefined, layeringOutputContract: undefined, layeringConfirmationDigest: undefined,
      confirmedAt: '2026-09-30T00:00:00.000Z',
      conversationId: 'fixture-normal', projectSessionId: 'fixture-session', prompt: 'Edit only the cup.' }));
    expect(fixture.prompts[1]).toContain('Reference images are attached in the supplied order');
    expect(fixture.prompts[1]).toContain('(1 input)');
    expect(fixture.prompts[1]).not.toContain('@2');
    expect(fixture.prompts[1]).toContain('Edit only the cup.');
    expect(fixture.prompts[1]).not.toContain('authoritative scene');

    await fixture.executor.submit(createConfirmedModelJob({ ...requests[1]!, id: 'fixture-mismatched-layer-binding',
      promptNodeId: 'ordinary-prompt-node', layeringOutputContract: undefined, layeringConfirmationDigest: undefined,
      confirmedAt: '2026-09-30T00:00:00.000Z',
      conversationId: 'fixture-mismatch', projectSessionId: 'fixture-session', prompt: 'Edit only the cup.' }));
    expect(fixture.prompts[2]).toContain('Reference images are attached in the supplied order');
    expect(fixture.prompts[2]).toContain('Edit only the cup.');
  });

  it('binds the complete included foreground removal list and source bounds to the background payload', async () => {
    const fixture = await imageTransportFixture();
    const requests = await layerRequests();
    await fixture.executor.submit(createConfirmedModelJob({ ...requests[0]!, confirmedAt: '2026-09-30T00:00:00.000Z',
      conversationId: 'fixture-background', projectSessionId: 'fixture-session' }));
    const prompt = fixture.prompts[0]!;
    expect(prompt).not.toContain('preserve its composition, camera, lighting, and background');
    expect(prompt).toContain('蓝色杯子');
    expect(prompt).toContain('握杯的手');
    expect(prompt).toContain('杯子投影');
    expect(prompt).toContain('"x":0.25');
    expect(prompt).toContain('64x64');
    expect(prompt).toContain('Preserve every unoccluded source pixel');
    expect(prompt).not.toContain('未选花瓶');
  });
});

async function layerRequests() {
  const confirmation = await confirmLayeringPlan(plan, 'comfly', imageProfile.modelRoute, '1K', '2026-09-30T00:00:00.000Z');
  let index = 0;
  return buildLayeringJobRequests(plan, confirmation, imageProfile, 'fixture-group', [{
    provider: 'comfly', modelRoute: imageProfile.modelRoute, modelId: imageProfile.modelId!,
    source: 'live_alpha_qa', verifiedAt: '2026-09-23T00:00:00.000Z',
    transparentBackground: true, outputFormat: 'png', resolutions: ['1K'],
  }], () => 'fixture-layer-' + index++);
}

async function imageTransportFixture() {
  const appDataRoot = await mkdtemp(join(tmpdir(), 'canvas-layer-contract-'));
  temporaryRoots.push(appDataRoot);
  const credentialStore = createSecureProviderCredentialStore({ appDataRoot, safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: value => Buffer.from(value), decryptString: value => Buffer.from(value).toString('utf8'),
  } });
  await credentialStore.configure({ token: 'fixture-only-local-token' });
  const prompts: string[] = [];
  const service = createComflyProviderService({
    appDataRoot, credentialStore, profiles: [imageProfile],
    fetch: async (_url, init) => {
      const body = init?.body;
      const prompt = typeof body === 'string' ? JSON.parse(body).prompt
        : Buffer.from(body as Uint8Array).toString('utf8').match(/name="prompt"\r\n\r\n([\s\S]*?)\r\n--/u)?.[1];
      if (typeof prompt !== 'string') throw new Error('Missing prompt in fixture image-edit payload');
      prompts.push(prompt);
      return new Response(JSON.stringify({ taskId: 'fixture-task-' + prompts.length, status: 'pending' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
    readManagedGenerationImages: async () => [{ bytes: Uint8Array.of(1), mediaType: 'image/png' }],
  });
  vi.stubGlobal('window', { novusDesktop: { provider: service } });
  vi.stubGlobal('fetch', () => { throw new Error('External requests are forbidden in layering contract regression'); });
  return { executor: createDesktopModelJobExecutor(), prompts };
}
