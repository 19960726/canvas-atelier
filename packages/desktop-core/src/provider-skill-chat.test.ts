import { describe, expect, it, vi } from 'vitest';
import type { ComflyChatRequest } from '@agent-canvas/provider-comfly';
import type { ManagedKnowledgeStore } from './managed-knowledge-store.js';
import { executeSkillChat } from './provider-skill-chat.js';

describe('executeSkillChat', () => {
  it.each([
    'gemini-3-pro-image-4k',
    'gemini-3.1-flash-image-4k',
    'gemini-3.1-flash-lite-image',
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
  ])('rejects a chat-only media-output route before calling the provider: %s', async (modelId) => {
    const chat = vi.fn(async () => ({
      id: 'unexpected-image-chat',
      model: modelId,
      choices: [{ message: { role: 'assistant', content: 'must not be accepted' } }],
    }));

    await expect(executeSkillChat({
      request: {
        provider: 'comfly',
        modelRoute: `comfly-${modelId.replace(/\./gu, '-')}`,
        messages: [{ role: 'user', content: 'Plan an image.' }],
        context: { knowledgeBaseIds: [], projectMemoryIds: [] },
      },
      captureRuntimeSnapshot: async () => ({ profiles: [{
        provider: 'comfly' as const,
        modelRoute: `comfly-${modelId.replace(/\./gu, '-')}`,
        modelId,
        displayName: modelId,
        capabilities: ['chat' as const],
      }] }),
      createClient: () => ({ chat, responses: vi.fn() }),
      managedKnowledgeStore: {} as ManagedKnowledgeStore,
    })).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });

    expect(chat).not.toHaveBeenCalled();
  });

  it.each([
    'gpt-4o',
    'qwen-vl-max',
    'chat_fast_video',
  ])('keeps a non-output dialogue model routable when its name contains related words: %s', async (modelId) => {
    const chat = vi.fn(async () => ({
      id: 'expected-chat',
      model: modelId,
      choices: [{ message: { role: 'assistant', content: 'accepted' } }],
    }));

    await expect(executeSkillChat({
      request: {
        provider: 'comfly',
        modelRoute: `comfly-${modelId.replace(/[._]/gu, '-')}`,
        messages: [{ role: 'user', content: 'Discuss a plan.' }],
        context: { knowledgeBaseIds: [], projectMemoryIds: [] },
      },
      captureRuntimeSnapshot: async () => ({ profiles: [{
        provider: 'comfly' as const,
        modelRoute: `comfly-${modelId.replace(/[._]/gu, '-')}`,
        modelId,
        displayName: modelId,
        capabilities: ['chat' as const],
      }] }),
      createClient: () => ({ chat, responses: vi.fn() }),
      managedKnowledgeStore: {} as ManagedKnowledgeStore,
    })).resolves.toMatchObject({ message: 'accepted' });

    expect(chat).toHaveBeenCalledTimes(1);
  });

  it('rejects a generation profile that is also broadly tagged as chat', async () => {
    const chat = vi.fn();

    await expect(executeSkillChat({
      request: {
        provider: 'comfly',
        modelRoute: 'comfly-image-chat',
        messages: [{ role: 'user', content: 'Plan an image.' }],
        context: { knowledgeBaseIds: [], projectMemoryIds: [] },
      },
      captureRuntimeSnapshot: async () => ({ profiles: [{
        provider: 'comfly' as const,
        modelRoute: 'comfly-image-chat',
        modelId: 'image-chat',
        displayName: 'Image chat',
        capabilities: ['chat' as const, 'image_generation' as const],
      }] }),
      createClient: () => ({ chat, responses: vi.fn() }),
      managedKnowledgeStore: {} as ManagedKnowledgeStore,
    })).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });

    expect(chat).not.toHaveBeenCalled();
  });

  it('passes the ordered structured visual-analysis contract to the provider system message', async () => {
    const chat = vi.fn(async (request: ComflyChatRequest) => ({
      id: 'chat-visual-analysis-1',
      model: 'vision/chat',
      choices: [{ message: { role: 'assistant', content: '结构化反推结果' } }],
      request,
    }));
    await executeSkillChat({
      request: {
        provider: 'comfly',
        modelRoute: 'vision/chat',
        sessionId: 'desktop-session-1',
        referenceAssetIds: ['a'.repeat(16), 'b'.repeat(16)],
        referenceMentions: [
          { assetId: 'a'.repeat(16), label: '产品参考', mention: '@图片1' },
          { assetId: 'b'.repeat(16), label: '场景参考', mention: '@图片2' },
        ],
        agentMode: 'codex',
        reverseAnalysisDepth: 'fast',
        visualAnalysis: true,
        messages: [{ role: 'user', content: '反推这两张图片' }],
        context: { knowledgeBaseIds: [], projectMemoryIds: [] },
      },
      captureRuntimeSnapshot: async () => ({ profiles: [{
        provider: 'comfly', modelRoute: 'vision/chat', modelId: 'vision-chat', displayName: 'Vision chat', capabilities: ['chat', 'vision'],
      }] }),
      createClient: () => ({ chat, responses: vi.fn() }),
      managedKnowledgeStore: {} as ManagedKnowledgeStore,
      managedSkillChatImageResolver: { readManagedSkillChatImages: async () => [
        { bytes: Uint8Array.of(1), mediaType: 'image/png' },
        { bytes: Uint8Array.of(2), mediaType: 'image/png' },
      ] },
    });

    const submittedMessages = chat.mock.calls[0]?.[0].messages as Array<{ readonly content?: unknown }>;
    const system = submittedMessages[0]?.content;
    expect(String(system)).toContain('@图片1（产品参考）');
    expect(String(system)).toContain('@图片2（场景参考）');
    expect(String(system)).toContain('中文提示词、英文提示词、负面约束、执行清单');
    expect(chat).toHaveBeenCalledWith(expect.objectContaining({ max_tokens: 4_096 }), 180_000);
  });

  it('uses the Gemini-native endpoint for a visual Agent request when the catalog declares it', async () => {
    const chat = vi.fn();
    const generateGeminiContent = vi.fn(async () => ({
      candidates: [{ finishReason: 'STOP', content: { role: 'model', parts: [{ text: '原生多图分析结果' }] } }],
    }));

    await expect(executeSkillChat({
      request: {
        provider: 'comfly',
        modelRoute: 'comfly-gemini-3-1-pro-preview-customtools',
        sessionId: 'desktop-session-native',
        referenceAssetIds: ['a'.repeat(16)],
        referenceMentions: [{ assetId: 'a'.repeat(16), label: '参考图', mention: '@图片1' }],
        agentMode: 'original',
        reverseAnalysisDepth: 'fast',
        visualAnalysis: true,
        messages: [{ role: 'user', content: '分析 @图片1' }],
        context: { knowledgeBaseIds: [], projectMemoryIds: [] },
      },
      captureRuntimeSnapshot: async () => ({ profiles: [{
        provider: 'comfly',
        modelRoute: 'comfly-gemini-3-1-pro-preview-customtools',
        modelId: 'gemini-3.1-pro-preview-customtools',
        displayName: 'Gemini 3.1 Pro Preview Customtools',
        capabilities: ['chat', 'vision', 'reverse_prompt', 'gemini_native'],
      }] }),
      createClient: () => ({ chat, responses: vi.fn(), generateGeminiContent }),
      managedKnowledgeStore: {} as ManagedKnowledgeStore,
      managedSkillChatImageResolver: { readManagedSkillChatImages: async () => [
        { bytes: Uint8Array.of(1, 2, 3), mediaType: 'image/png' },
      ] },
    })).resolves.toMatchObject({ message: '原生多图分析结果' });

    expect(generateGeminiContent).toHaveBeenCalledWith(expect.objectContaining({
      model: 'gemini-3.1-pro-preview-customtools',
      generationConfig: { maxOutputTokens: 4_096 },
      systemInstruction: { parts: [expect.objectContaining({ text: expect.stringContaining('中文提示词') })] },
      contents: [expect.objectContaining({
        role: 'user',
        parts: expect.arrayContaining([
          { text: '分析 @图片1' },
          { inlineData: { mimeType: 'image/png', data: 'AQID' } },
        ]),
      })],
    }), 180_000);
    expect(chat).not.toHaveBeenCalled();
  });

  it('uses the real responses endpoint for a responses-only profile', async () => {
    const responses = vi.fn(async () => ({
      id: 'response-1',
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'Use a tighter crop.' }] }],
    }));
    const chat = vi.fn();
    const result = await executeSkillChat({
      request: {
        provider: 'comfly',
        modelRoute: 'responses/creative',
        messages: [{ role: 'user', content: 'Suggest a crop.' }],
        context: { knowledgeBaseIds: [], projectMemoryIds: [] },
      },
      captureRuntimeSnapshot: async () => ({
        profiles: [{
          provider: 'comfly',
          modelRoute: 'responses/creative',
          modelId: 'responses-creative',
          displayName: 'Responses creative',
          capabilities: ['responses'],
        }],
      }),
      createClient: () => ({ chat, responses }),
      managedKnowledgeStore: {} as ManagedKnowledgeStore,
    });

    expect(result.message).toBe('Use a tighter crop.');
    expect(responses).toHaveBeenCalledWith(expect.any(Object), 180_000);
    expect(chat).not.toHaveBeenCalled();
  });

  it('passes the selected Codex reasoning effort to a chat-completions model request', async () => {
    const chat = vi.fn(async (request: ComflyChatRequest) => ({
      id: 'chat-codex-reasoning-1',
      model: 'gpt-5.6-sol',
      choices: [{ message: { role: 'assistant', content: 'Deep plan.' } }],
      request,
    }));

    await executeSkillChat({
      request: {
        provider: 'comfly',
        modelRoute: 'comfly-gpt-5-6-sol',
        agentMode: 'codex',
        reasoningEffort: 'high',
        messages: [{ role: 'user', content: 'Plan the canvas workflow.' }],
        context: { knowledgeBaseIds: [], projectMemoryIds: [] },
      },
      captureRuntimeSnapshot: async () => ({ profiles: [{
        provider: 'comfly',
        modelRoute: 'comfly-gpt-5-6-sol',
        modelId: 'gpt-5.6-sol',
        displayName: 'gpt-5.6-sol',
        capabilities: ['chat'],
      }] }),
      createClient: () => ({ chat, responses: vi.fn() }),
      managedKnowledgeStore: {} as ManagedKnowledgeStore,
    });

    expect(chat).toHaveBeenCalledWith(expect.objectContaining({
      model: 'gpt-5.6-sol',
      reasoning_effort: 'high',
    }), 180_000);
  });

  it('passes the selected Codex reasoning effort to a Responses API request', async () => {
    const responses = vi.fn(async () => ({
      id: 'response-codex-reasoning-1',
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'Deep plan.' }] }],
    }));

    await executeSkillChat({
      request: {
        provider: 'comfly',
        modelRoute: 'responses/codex',
        agentMode: 'codex',
        reasoningEffort: 'high',
        messages: [{ role: 'user', content: 'Plan the canvas workflow.' }],
        context: { knowledgeBaseIds: [], projectMemoryIds: [] },
      },
      captureRuntimeSnapshot: async () => ({ profiles: [{
        provider: 'comfly',
        modelRoute: 'responses/codex',
        modelId: 'gpt-5.6-sol',
        displayName: 'gpt-5.6-sol',
        capabilities: ['responses'],
      }] }),
      createClient: () => ({ chat: vi.fn(), responses }),
      managedKnowledgeStore: {} as ManagedKnowledgeStore,
    });

    expect(responses).toHaveBeenCalledWith(expect.objectContaining({
      model: 'gpt-5.6-sol',
      reasoning: { effort: 'high' },
    }), 180_000);
  });

  it('maps ordinary chat reasoning through a profile-declared chat-completions protocol', async () => {
    const chat = vi.fn(async () => ({
      id: 'chat-ordinary-reasoning-1',
      model: 'gpt-reasoning',
      choices: [{ message: { role: 'assistant', content: 'Reasoned answer.' } }],
    }));
    await executeSkillChat({
      request: {
        provider: 'comfly', modelRoute: 'chat/reasoning', agentMode: 'chat', reasoningEffort: 'high',
        messages: [{ role: 'user', content: 'Compare options.' }], context: { knowledgeBaseIds: [], projectMemoryIds: [] },
      },
      captureRuntimeSnapshot: async () => ({ profiles: [{
        provider: 'comfly', modelRoute: 'chat/reasoning', modelId: 'gpt-reasoning', displayName: 'Reasoning chat', capabilities: ['chat'],
        reasoning: { efforts: ['low', 'medium', 'high'], defaultEffort: 'medium', protocol: 'chat_completions' },
      }] }),
      createClient: () => ({ chat, responses: vi.fn() }),
      managedKnowledgeStore: {} as ManagedKnowledgeStore,
    });
    expect(chat).toHaveBeenCalledWith(expect.objectContaining({ reasoning_effort: 'high' }), 180_000);
  });

  it('maps creative Agent reasoning through a profile-declared Responses protocol', async () => {
    const responses = vi.fn(async () => ({
      id: 'responses-original-reasoning-1',
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'Creative answer.' }] }],
    }));
    await executeSkillChat({
      request: {
        provider: 'comfly', modelRoute: 'responses/creative', agentMode: 'original', reasoningEffort: 'low',
        messages: [{ role: 'user', content: 'Draft a concept.' }], context: { knowledgeBaseIds: [], projectMemoryIds: [] },
      },
      captureRuntimeSnapshot: async () => ({ profiles: [{
        provider: 'comfly', modelRoute: 'responses/creative', modelId: 'creative-responses', displayName: 'Creative responses', capabilities: ['responses'],
        reasoning: { efforts: ['low', 'medium', 'high'], defaultEffort: 'medium', protocol: 'responses' },
      }] }),
      createClient: () => ({ chat: vi.fn(), responses }),
      managedKnowledgeStore: {} as ManagedKnowledgeStore,
    });
    expect(responses).toHaveBeenCalledWith(expect.objectContaining({ reasoning: { effort: 'low' } }), 180_000);
  });

  it('sends managed image references through an explicitly visual Responses route using Responses content parts', async () => {
    const responses = vi.fn(async () => ({
      id: 'response-codex-image-1',
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'Image understood.' }] }],
    }));

    await expect(executeSkillChat({
      request: {
        provider: 'comfly',
        modelRoute: 'responses/codex',
        sessionId: 'desktop-session-codex',
        agentMode: 'codex',
        referenceAssetIds: ['a'.repeat(16)],
        messages: [{ role: 'user', content: 'Inspect @图片1.' }],
        context: { knowledgeBaseIds: [], projectMemoryIds: [] },
      },
      captureRuntimeSnapshot: async () => ({ profiles: [{
        provider: 'comfly',
        modelRoute: 'responses/codex',
        modelId: 'codex-responses',
        displayName: 'Codex responses',
        capabilities: ['responses', 'vision'],
      }] }),
      createClient: () => ({ chat: vi.fn(), responses }),
      managedKnowledgeStore: {} as ManagedKnowledgeStore,
      managedSkillChatImageResolver: { readManagedSkillChatImages: async () => [
        { bytes: Uint8Array.of(1, 2, 3), mediaType: 'image/png' },
      ] },
    })).resolves.toMatchObject({ message: 'Image understood.' });

    expect(responses).toHaveBeenCalledWith(expect.objectContaining({
      max_output_tokens: 8_192,
      input: expect.arrayContaining([
        expect.objectContaining({
          content: expect.arrayContaining([
            expect.objectContaining({
              type: 'input_image',
              image_url: 'data:image/png;base64,AQID',
            }),
            expect.objectContaining({ type: 'input_text', text: 'Inspect @图片1.' }),
          ]),
        }),
      ]),
    }), 360_000);
  });

  it('rejects managed images for a Codex Responses route without an explicit vision capability', async () => {
    const responses = vi.fn();
    const readManagedSkillChatImages = vi.fn();

    await expect(executeSkillChat({
      request: {
        provider: 'comfly',
        modelRoute: 'responses/text-only',
        sessionId: 'desktop-session-text-only',
        agentMode: 'codex',
        referenceAssetIds: ['a'.repeat(16)],
        messages: [{ role: 'user', content: 'Inspect @图片1.' }],
        context: { knowledgeBaseIds: [], projectMemoryIds: [] },
      },
      captureRuntimeSnapshot: async () => ({ profiles: [{
        provider: 'comfly',
        modelRoute: 'responses/text-only',
        modelId: 'responses-text-only',
        displayName: 'Responses text only',
        capabilities: ['responses'],
      }] }),
      createClient: () => ({ chat: vi.fn(), responses }),
      managedKnowledgeStore: {} as ManagedKnowledgeStore,
      managedSkillChatImageResolver: { readManagedSkillChatImages },
    })).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });

    expect(readManagedSkillChatImages).not.toHaveBeenCalled();
    expect(responses).not.toHaveBeenCalled();
  });
});
