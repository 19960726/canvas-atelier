import { describe, expect, it, vi } from 'vitest';
import type { ComflyChatRequest } from '@agent-canvas/provider-comfly';
import type { ManagedKnowledgeStore } from './managed-knowledge-store.js';
import { executeSkillChat } from './provider-skill-chat.js';

describe('executeSkillChat', () => {
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
    expect(responses).toHaveBeenCalledTimes(1);
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
    }));
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
    }));
  });

  it('sends managed image references through a Codex responses route when discovery omits vision', async () => {
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
        capabilities: ['responses'],
      }] }),
      createClient: () => ({ chat: vi.fn(), responses }),
      managedKnowledgeStore: {} as ManagedKnowledgeStore,
      managedSkillChatImageResolver: { readManagedSkillChatImages: async () => [
        { bytes: Uint8Array.of(1, 2, 3), mediaType: 'image/png' },
      ] },
    })).resolves.toMatchObject({ message: 'Image understood.' });

    expect(responses).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.arrayContaining([
        expect.objectContaining({
          content: expect.arrayContaining([
            expect.objectContaining({
              type: 'image_url',
              image_url: { url: 'data:image/png;base64,AQID' },
            }),
          ]),
        }),
      ]),
    }));
  });
});
