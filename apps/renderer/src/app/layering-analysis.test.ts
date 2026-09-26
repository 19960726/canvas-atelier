import { describe, expect, it, vi } from 'vitest';
import type { ProviderBridgeProfile, ChatSkillBridgeResult } from '@agent-canvas/desktop-core';
import type { SkillChatRequest } from './desktop-persistence';
import { analyzeImageLayering } from './layering-analysis';

const profile: ProviderBridgeProfile = {
  provider: 'comfly', modelRoute: 'vision-route', displayName: 'Vision model', modelId: 'gemini-3.1-pro-preview',
  capabilities: ['chat', 'vision'], capabilityStatus: 'complete', enabled: true,
};
const planReply = JSON.stringify({ layers: [
  { layerId: 'background', kind: 'background', name: '背景', description: '补全背景', included: true },
  { layerId: 'product-main', kind: 'transparent', name: '产品本体', description: '保留产品外形、材质和原图位置，不包含阴影。', included: true },
  { layerId: 'prop-vase', kind: 'transparent', name: '左侧玻璃花瓶', description: '仅花瓶像素，位于产品后方。', included: true },
  { layerId: 'shadow-product', kind: 'transparent', name: '产品接触阴影', description: '仅产品与台面接触处的阴影，不包含产品像素。', included: true },
  { layerId: 'shadow-vase', kind: 'transparent', name: '花瓶投影', description: '仅花瓶投在背景上的投影，不包含花瓶像素。', included: true },
] });

describe('analyzeImageLayering', () => {
  it('carries a selected object and its bounds into analysis and the editable plan', async () => {
    const selection = { mode: 'objects' as const, box: { x: .25, y: .5, width: .25, height: .25 }, target: '红色料理机' };
    const chatSkill = vi.fn(async (_request: SkillChatRequest): Promise<ChatSkillBridgeResult> => ({ message: planReply, modelRoute: 'vision-route', sources: [] }));
    const plan = await analyzeImageLayering({ sourceAssetId: 'source', width: 1200, height: 1600, profile, selection }, chatSkill);
    expect(plan.selection).toEqual(selection);
    const prompt = chatSkill.mock.calls[0]![0].messages[0]!.content;
    expect(prompt).toContain('红色料理机');
    expect(prompt).toContain('300,800');
    expect(prompt).toContain('框外');
  });
  it('makes one managed-image vision chat call and returns only a validated plan', async () => {
    const chatSkill = vi.fn(async (_request: SkillChatRequest): Promise<ChatSkillBridgeResult> => ({
      message: planReply, modelRoute: 'vision-route', sources: [],
    }));
    const plan = await analyzeImageLayering({ sourceAssetId: 'asset-source', width: 1024, height: 768, profile }, chatSkill);

    expect(chatSkill).toHaveBeenCalledOnce();
    expect(chatSkill).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'comfly', modelRoute: 'vision-route', agentMode: 'chat', visualAnalysis: true,
      referenceAssetIds: ['asset-source'],
      referenceMentions: [{ assetId: 'asset-source', label: '原图', mention: '@图片1' }],
      context: { knowledgeBaseIds: [], projectMemoryIds: [] },
      messages: [expect.objectContaining({ role: 'user', content: expect.stringContaining('JSON') })],
    }));
    expect(plan.sourceAssetId).toBe('asset-source');
    expect(plan.layers.map((layer) => layer.layerId)).toEqual(['background', 'product-main', 'prop-vase', 'shadow-product', 'shadow-vase']);
    const instruction = chatSkill.mock.calls[0]?.[0].messages[0]?.content ?? '';
    expect(instruction).toContain('每件清晰可辨的摆件、道具和装饰物各自单独成层');
    expect(instruction).toContain('接触阴影、投影分别单独成层');
    expect(instruction).toContain('不得只命名为“主体”“细节”');
    expect(instruction).toContain('海报或信息图');
    expect(instruction).toContain('标题、说明文字、图表');
    expect(instruction).toContain('蒸汽、发光和热效');
    expect(instruction).toContain('文字仍是原图像素');
  });

  it.each([
    ['no vision capability', { ...profile, capabilities: ['chat'] }],
    ['incomplete catalog profile', { ...profile, capabilityStatus: 'incomplete' }],
    ['disabled profile', { ...profile, enabled: false }],
    ['a profile without a model route', { ...profile, modelRoute: '' }],
  ])('blocks %s before making a bridge call', async (_label, candidate) => {
    const chatSkill = vi.fn();
    await expect(analyzeImageLayering({ sourceAssetId: 'asset-source', width: 1024, height: 768, profile: candidate as ProviderBridgeProfile }, chatSkill))
      .rejects.toThrow();
    expect(chatSkill).not.toHaveBeenCalled();
  });

  it('rejects malformed output and provider errors without returning a partial plan', async () => {
    const malformed = vi.fn(async (): Promise<ChatSkillBridgeResult> => ({ message: 'Plan: ' + planReply, modelRoute: 'vision-route', sources: [] }));
    await expect(analyzeImageLayering({ sourceAssetId: 'asset-source', width: 1024, height: 768, profile }, malformed))
      .rejects.toThrow(/JSON/u);
    expect(malformed).toHaveBeenCalledOnce();

    const failed = vi.fn(async () => { throw new Error('provider offline'); });
    await expect(analyzeImageLayering({ sourceAssetId: 'asset-source', width: 1024, height: 768, profile }, failed))
      .rejects.toThrow('provider offline');
    expect(failed).toHaveBeenCalledOnce();
  });

  it('requests an exact custom layer count and rejects a mismatched analysis reply', async () => {
    const chatSkill = vi.fn(async (_request: SkillChatRequest): Promise<ChatSkillBridgeResult> => ({
      message: planReply, modelRoute: 'vision-route', sources: [],
    }));
    await expect(analyzeImageLayering({ sourceAssetId: 'asset-source', width: 1024, height: 768, profile,
      mode: 'custom', targetLayerCount: 4 }, chatSkill)).rejects.toThrow(/目标层数提高到 5 层/u);
    expect(chatSkill).toHaveBeenCalledOnce();
    expect(chatSkill.mock.calls[0]?.[0].messages[0]?.content).toContain('语义分层需要超过自定义目标时');
  });

  it('does not invent empty or duplicate layers when the scene has fewer semantic layers than requested', async () => {
    const chatSkill = vi.fn(async (_request: SkillChatRequest): Promise<ChatSkillBridgeResult> => ({
      message: planReply, modelRoute: 'vision-route', sources: [],
    }));
    await expect(analyzeImageLayering({ sourceAssetId: 'asset-source', width: 1024, height: 768, profile,
      mode: 'custom', targetLayerCount: 6 }, chatSkill)).rejects.toThrow(/降低目标层数/u);
    expect(chatSkill).toHaveBeenCalledOnce();
  });
});
