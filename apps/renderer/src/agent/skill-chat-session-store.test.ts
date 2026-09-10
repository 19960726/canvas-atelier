import { afterEach, describe, expect, it } from 'vitest';

import {
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
});
