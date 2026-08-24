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
});
