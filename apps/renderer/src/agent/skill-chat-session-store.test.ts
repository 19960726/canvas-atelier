import { afterEach, describe, expect, it } from 'vitest';

import {
  addAgentConversation,
  createAgentConversation,
  deriveAgentConversationTitle,
  readAgentConversationCollection,
  writeAgentConversationCollection,
} from './skill-chat-session-store';

afterEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe('skill chat conversation storage', () => {
  it('keeps conversations isolated by project and restores the active task', () => {
    const first = {
      ...createAgentConversation(100),
      id: 'conversation-project-a',
      title: '项目 A 任务',
    };
    const second = {
      ...createAgentConversation(200),
      id: 'conversation-project-a-2',
      title: '项目 A 第二个任务',
    };

    writeAgentConversationCollection('project-a', {
      version: 2,
      activeConversationId: second.id,
      conversations: [first, second],
    });

    expect(readAgentConversationCollection('project-a', 300)).toMatchObject({
      activeConversationId: second.id,
      conversations: [
        { id: first.id, title: '项目 A 任务' },
        { id: second.id, title: '项目 A 第二个任务' },
      ],
    });
    const otherProject = readAgentConversationCollection('project-b', 300);
    expect(otherProject.conversations).toHaveLength(1);
    expect(otherProject.conversations[0]?.id).not.toBe(first.id);
  });

  it('migrates the legacy per-project session without losing messages or route context', () => {
    window.sessionStorage.setItem('agent-canvas:skill-chat:legacy', JSON.stringify({
      version: 1,
      modelRoute: 'codex/gpt-5.6-luna/medium',
      knowledgeBaseIds: ['scene-skill'],
      projectMemoryIds: ['memory-1'],
      messages: [{ id: 'm1', role: 'user', content: '旧消息' }],
    }));

    const migrated = readAgentConversationCollection('legacy', 500);

    expect(migrated.version).toBe(2);
    expect(migrated.conversations[0]).toMatchObject({
      modelRoute: 'codex/gpt-5.6-luna/medium',
      knowledgeBaseIds: ['scene-skill'],
      projectMemoryIds: ['memory-1'],
      messages: [{ id: 'm1', role: 'user', content: '旧消息' }],
    });
    expect(window.localStorage.getItem('agent-canvas:skill-chat:v2:legacy')).not.toBeNull();
  });

  it('falls back to a safe empty task when persisted data is corrupt', () => {
    window.localStorage.setItem('agent-canvas:skill-chat:v2:broken', '{not-json');

    const restored = readAgentConversationCollection('broken', 700);

    expect(restored.conversations).toHaveLength(1);
    expect(restored.activeConversationId).toBe(restored.conversations[0]?.id);
    expect(restored.conversations[0]?.messages).toEqual([]);
  });

  it('derives a compact title from the first visible user message', () => {
    expect(deriveAgentConversationTitle('  为 产品   创建一个高级电商场景，并保留主体材质  '))
      .toBe('为 产品 创建一个高级电商场景，并保');
    expect(deriveAgentConversationTitle('   ')).toBe('新任务');
  });

  it('preserves each submitted reverse depth independently of the current conversation setting', () => {
    const conversation = {
      ...createAgentConversation(950), reverseAnalysisDepth: 'fast' as const,
      messages: [{ id: 'deep-request', role: 'user' as const, content: '反推素材', request: {
        modelDisplayName: 'Vision', modelRoute: 'vision', knowledgeBaseCount: 0,
        projectMemoryCount: 0, references: [], status: 'completed' as const,
        visualAnalysis: true, reverseAnalysisDepth: 'deep' as const,
      } }],
    };
    writeAgentConversationCollection('depth-snapshot', {
      version: 2, activeConversationId: conversation.id, conversations: [conversation],
    });
    const restored = readAgentConversationCollection('depth-snapshot').conversations[0]!;
    expect(restored.reverseAnalysisDepth).toBe('fast');
    expect(restored.messages[0]!.request).toMatchObject({ reverseAnalysisDepth: 'deep' });
  });

  it('persists reasoning independently for chat, creative Agent, and Codex plus reverse depth', () => {
    const conversation = {
      ...createAgentConversation(900),
      reasoningEfforts: { chat: 'low' as const, original: 'high' as const, codex: 'max' as const },
      reverseAnalysisDepth: 'deep' as const,
    };
    writeAgentConversationCollection('astra', {
      version: 2,
      activeConversationId: conversation.id,
      conversations: [conversation],
    });

    expect(readAgentConversationCollection('astra', 901).conversations[0]).toMatchObject({
      reasoningEfforts: { chat: 'low', original: 'high', codex: 'max' },
      reverseAnalysisDepth: 'deep',
    });
  });

  it('migrates an old v2 single reasoning value only into its saved mode', () => {
    const conversation = { ...createAgentConversation(910), id: 'legacy-ultra', reasoningEffort: 'ultra' };
    delete (conversation as { reasoningEfforts?: unknown }).reasoningEfforts;
    delete (conversation as { reverseAnalysisDepth?: unknown }).reverseAnalysisDepth;
    window.localStorage.setItem('agent-canvas:skill-chat:v2:astra-migration', JSON.stringify({
      version: 2,
      activeConversationId: conversation.id,
      conversations: [conversation],
    }));

    expect(readAgentConversationCollection('astra-migration', 911).conversations[0]).toMatchObject({
      id: 'legacy-ultra',
      reasoningEfforts: { chat: 'medium', original: 'medium', codex: 'ultra' },
      reverseAnalysisDepth: 'standard',
    });
  });

  it('persists message modes and assigns legacy messages to their saved conversation mode', () => {
    const conversation = {
      ...createAgentConversation(920),
      id: 'mode-aware-history',
      mode: 'original' as const,
      messages: [
        { id: 'creative-user', role: 'user' as const, content: '生成产品方案' },
        { id: 'codex-user', role: 'user' as const, content: '检查画布', mode: 'codex' as const },
      ],
    };
    window.localStorage.setItem('agent-canvas:skill-chat:v2:mode-history', JSON.stringify({
      version: 2,
      activeConversationId: conversation.id,
      conversations: [conversation],
    }));

    expect(readAgentConversationCollection('mode-history', 921).conversations[0]?.messages).toEqual([
      { id: 'creative-user', role: 'user', content: '生成产品方案', mode: 'original' },
      { id: 'codex-user', role: 'user', content: '检查画布', mode: 'codex' },
    ]);
  });

  it('persists the selected generation kind with a creative request across an app restart', () => {
    const conversation = {
      ...createAgentConversation(930),
      id: 'generation-kind-history',
      mode: 'original' as const,
      messages: [{
        id: 'creative-image-request',
        role: 'user' as const,
        content: '精修产品，其他不要改变',
        mode: 'original' as const,
        request: {
          modelDisplayName: 'Vision chat',
          modelRoute: 'chat/vision',
          knowledgeBaseCount: 0,
          knowledgeBaseIds: [],
          projectMemoryCount: 0,
          references: [{ assetId: 'product-reference', label: '产品参考' }],
          status: 'completed' as const,
          generationKind: 'image' as const,
        },
      }],
    };
    writeAgentConversationCollection('generation-kind', {
      version: 2,
      activeConversationId: conversation.id,
      conversations: [conversation],
    });

    expect(readAgentConversationCollection('generation-kind', 931).conversations[0]?.messages[0]?.request)
      .toMatchObject({ generationKind: 'image', references: [{ assetId: 'product-reference' }] });
  });

  it('keeps the newest 48 messages instead of replacing a long conversation with a blank task', () => {
    const conversation = {
      ...createAgentConversation(940),
      id: 'long-conversation',
      title: '长对话仍可恢复',
      messages: Array.from({ length: 52 }, (_, index) => ({
        id: `message-${index + 1}`,
        role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
        content: `消息 ${index + 1}`,
        mode: 'codex' as const,
      })),
    };

    writeAgentConversationCollection('long-conversation', {
      version: 2,
      activeConversationId: conversation.id,
      conversations: [conversation],
    });

    const restored = readAgentConversationCollection('long-conversation', 941);
    expect(restored.activeConversationId).toBe(conversation.id);
    expect(restored.conversations[0]).toMatchObject({ id: conversation.id, title: '长对话仍可恢复' });
    expect(restored.conversations[0]?.messages).toHaveLength(48);
    expect(restored.conversations[0]?.messages[0]?.id).toBe('message-5');
    const restoredMessages = restored.conversations[0]?.messages ?? [];
    expect(restoredMessages[restoredMessages.length - 1]?.id).toBe('message-52');
  });

  it('preserves durable canvas-result markers while pruning a long conversation', () => {
    const resultNodeId = 'agent-image-result-that-must-survive';
    const conversation = {
      ...createAgentConversation(950),
      id: 'long-conversation-with-result',
      messages: [
        {
          id: `canvas-result:${resultNodeId}`,
          role: 'assistant' as const,
          content: '生成已完成，1 个结果已回写画布节点。',
          mode: 'codex' as const,
          canvasNodeLabel: '图片 · 红色破壁机主图',
        },
        ...Array.from({ length: 52 }, (_, index) => ({
          id: `later-message-${index + 1}`,
          role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
          content: `后续消息 ${index + 1}`,
          mode: 'codex' as const,
        })),
      ],
    };

    writeAgentConversationCollection('long-conversation-result', {
      version: 2,
      activeConversationId: conversation.id,
      conversations: [conversation],
    });

    const restoredMessages = readAgentConversationCollection('long-conversation-result', 951)
      .conversations[0]?.messages ?? [];
    expect(restoredMessages).toHaveLength(48);
    expect(restoredMessages.find((message) => message.id === `canvas-result:${resultNodeId}`))
      .toMatchObject({ canvasNodeLabel: '图片 · 红色破壁机主图' });
    expect(restoredMessages[restoredMessages.length - 1]?.id).toBe('later-message-52');
  });

  it('keeps the latest complete exchange when many canvas-result markers fill the history', () => {
    const conversation = {
      ...createAgentConversation(960),
      id: 'marker-heavy-conversation',
      messages: [
        ...Array.from({ length: 48 }, (_, index) => ({
          id: `canvas-result:generated-node-${index + 1}`,
          role: 'assistant' as const,
          content: `节点 ${index + 1} 已完成。`,
          mode: 'codex' as const,
          canvasNodeLabel: `方案 ${index + 1}`,
        })),
        { id: 'latest-user', role: 'user' as const, content: '继续调整最后一张图', mode: 'codex' as const },
        { id: 'latest-assistant', role: 'assistant' as const, content: '我会先分析再给出方案。', mode: 'codex' as const },
      ],
    };

    writeAgentConversationCollection('marker-heavy', {
      version: 2,
      activeConversationId: conversation.id,
      conversations: [conversation],
    });

    const restored = readAgentConversationCollection('marker-heavy', 961).conversations[0]?.messages ?? [];
    expect(restored).toHaveLength(48);
    expect(restored.slice(-2).map((message) => message.id)).toEqual(['latest-user', 'latest-assistant']);
  });

  it('keeps the newest task plus the 49 most recently used tasks at the collection limit', () => {
    const conversations = Array.from({ length: 50 }, (_, index) => ({
      ...createAgentConversation(1_000 + index),
      id: `conversation-${index + 1}`,
      title: `任务 ${index + 1}`,
      updatedAt: 1_000 + index,
    }));
    const created = { ...createAgentConversation(2_000), id: 'conversation-51', title: '任务 51' };

    const next = addAgentConversation({
      version: 2,
      activeConversationId: conversations[49]!.id,
      conversations,
    }, created);
    writeAgentConversationCollection('fifty-one-tasks', next);
    const restored = readAgentConversationCollection('fifty-one-tasks', 2_001);

    expect(restored.activeConversationId).toBe(created.id);
    expect(restored.conversations).toHaveLength(50);
    expect(restored.conversations.some((conversation) => conversation.id === 'conversation-1')).toBe(false);
    expect(restored.conversations.some((conversation) => conversation.id === 'conversation-2')).toBe(true);
    expect(restored.conversations.some((conversation) => conversation.id === created.id)).toBe(true);
  });

  it('redacts a protected link from one message without erasing the task collection', () => {
    const linked = {
      ...createAgentConversation(3_000),
      id: 'conversation-with-link',
      title: deriveAgentConversationTitle('请分析 https://example.com/reference'),
      messages: [
        { id: 'link-user', role: 'user' as const, content: '请分析 https://example.com/reference', mode: 'chat' as const },
        { id: 'link-assistant', role: 'assistant' as const, content: '可以查看 https://example.com/result', mode: 'chat' as const },
      ],
    };
    const other = { ...createAgentConversation(3_100), id: 'conversation-safe', title: '另一个安全任务' };

    writeAgentConversationCollection('protected-message', {
      version: 2,
      activeConversationId: linked.id,
      conversations: [linked, other],
    });
    const restored = readAgentConversationCollection('protected-message', 3_200);

    expect(restored.activeConversationId).toBe(linked.id);
    expect(restored.conversations).toHaveLength(2);
    expect(restored.conversations.find((conversation) => conversation.id === linked.id)?.title).toBe('请分析 [链接已省略]');
    expect(restored.conversations.find((conversation) => conversation.id === linked.id)?.messages).toEqual([
      expect.objectContaining({ id: 'link-user', content: '请分析 [链接已省略]' }),
      expect.objectContaining({ id: 'link-assistant', content: '可以查看 [链接已省略]' }),
    ]);
  });
});
