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
});
