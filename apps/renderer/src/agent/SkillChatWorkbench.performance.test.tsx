import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SkillChatWorkbench, type SkillChatWorkbenchProps } from './SkillChatWorkbench';
import { createAgentConversation, writeAgentConversationCollection } from './skill-chat-session-store';
import * as creativePlans from './creative-plan';

const projectId = 'agent-input-performance';
const storageKey = `agent-canvas:skill-chat:v2:${projectId}`;
const props: SkillChatWorkbenchProps = {
  projectId,
  profiles: [{
    provider: 'comfly', modelRoute: 'chat/default', modelId: 'local-fixture',
    displayName: 'Local fixture', capabilities: ['chat'],
  }],
  knowledgeBases: [],
  projectMemoryIds: [],
  reverseTimeline: [],
  chat: async () => { throw new Error('Typing must not submit a provider request'); },
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

function saveHistory() {
  const conversations = Array.from({ length: 50 }, (_, conversationIndex) => ({
    ...createAgentConversation(conversationIndex + 1),
    mode: 'chat' as const,
    modelRoute: 'chat/default',
    title: `保存任务 ${conversationIndex}`,
    messages: Array.from({ length: 48 }, (_, messageIndex) => ({
      id: `message-${conversationIndex}-${messageIndex}`,
      role: messageIndex % 2 === 0 ? 'user' as const : 'assistant' as const,
      content: `保存消息 ${conversationIndex}-${messageIndex} ${'构图与灯光。'.repeat(100)}`,
    })),
  }));
  writeAgentConversationCollection(projectId, {
    version: 2,
    activeConversationId: conversations[0]!.id,
    conversations,
  });
  return conversations;
}

function typeIntoComposer(text: string) {
  const editor = screen.getByRole('textbox', { name: '向 Agent 发送消息' });
  editor.focus();
  for (const character of text) {
    editor.append(document.createTextNode(character));
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    fireEvent.input(editor, { inputType: 'insertText', data: character });
  }
  expect(editor).toHaveValue(text);
}

describe('SkillChatWorkbench input performance', () => {
  it('reuses unchanged reference catalogs while typing and updates sent media after a reference refresh', () => {
    const image = {
      get assetId() { return 'a'.repeat(16); },
      label: '产品参考', displayUrl: 'novus-asset://original-reference',
    };
    const referenceImages = [image];
    const conversation = {
      ...createAgentConversation(1), mode: 'chat' as const, modelRoute: 'chat/default',
      messages: [{
        id: 'request', role: 'user' as const, content: '@图片1 检查结构',
        request: {
          modelDisplayName: 'Local fixture', modelRoute: 'chat/default', knowledgeBaseCount: 0,
          projectMemoryCount: 0, references: [{ assetId: image.assetId, label: image.label }],
          status: 'completed' as const,
        },
      }],
    };
    writeAgentConversationCollection(projectId, { version: 2, activeConversationId: conversation.id, conversations: [conversation] });
    const assetIdRead = vi.spyOn(image, 'assetId', 'get');
    const view = render(<SkillChatWorkbench {...props} referenceImages={referenceImages} />);
    const initialReads = assetIdRead.mock.calls.length;

    typeIntoComposer('不改变引用时复用当前素材');
    view.rerender(<SkillChatWorkbench {...props} referenceImages={referenceImages} />);
    expect(assetIdRead.mock.calls.length).toBe(initialReads);
    expect(screen.getByRole('img', { name: '产品参考' })).toHaveAttribute('src', 'novus-asset://original-reference');

    view.rerender(<SkillChatWorkbench {...props} referenceImages={[{ ...image, displayUrl: 'novus-asset://refreshed-reference' }]} />);
    expect(screen.getByRole('img', { name: '产品参考' })).toHaveAttribute('src', 'novus-asset://refreshed-reference');
    expect(screen.getByLabelText('已发送素材')).toHaveTextContent('@图片1');
  });

  it('does not reparse unchanged creative replies while typing and refreshes plans when switching tasks', () => {
    const planText = JSON.stringify({
      summary: '保留产品与背景', observations: [], estimates: [], unknowns: [],
      options: [{ id: 'studio', title: '柔光棚拍', reason: '提高材质辨识度', kind: 'image', prompt: '产品居中，柔和侧光，磨砂材质，背景留白，保留产品结构。' }],
    });
    const conversation = {
      ...createAgentConversation(1), mode: 'original' as const, modelRoute: 'chat/default',
      messages: [
        { id: 'request', role: 'user' as const, content: '请给出产品精修方案' },
        { id: 'reply', role: 'assistant' as const, content: planText },
      ],
    };
    const chatConversation = {
      ...conversation, id: 'conversation-chat', title: '普通对话', mode: 'chat' as const,
    };
    writeAgentConversationCollection(projectId, { version: 2, activeConversationId: conversation.id, conversations: [conversation, chatConversation] });
    const parse = vi.spyOn(creativePlans, 'parseCreativePlan');
    const view = render(<SkillChatWorkbench {...props} />);
    expect(screen.getByRole('button', { name: '选择方案：柔光棚拍' })).toBeVisible();
    const initialParses = parse.mock.calls.length;

    typeIntoComposer('追加细节保持当前方案');
    view.rerender(<SkillChatWorkbench {...props} referenceImages={[]} />);
    expect(parse.mock.calls.length).toBe(initialParses);

    fireEvent.change(screen.getByRole('combobox', { name: 'Codex 任务' }), { target: { value: chatConversation.id } });
    expect(screen.queryByRole('button', { name: '选择方案：柔光棚拍' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: 'Codex 任务' }), { target: { value: conversation.id } });
    expect(screen.getByRole('button', { name: '选择方案：柔光棚拍' })).toBeVisible();
    expect(parse.mock.calls.length).toBeGreaterThan(initialParses);
  });

  it('loads persisted history once and does not reread it for typing or parent rerenders', () => {
    saveHistory();
    const read = vi.spyOn(Storage.prototype, 'getItem');
    const view = render(<SkillChatWorkbench {...props} />);
    const historyReads = () => read.mock.calls.filter(([key]) => key === storageKey).length;
    const mountReads = historyReads();

    typeIntoComposer('逐字输入时不要重新解析所有历史任务');
    view.rerender(<SkillChatWorkbench {...props} referenceImages={[]} />);

    expect(historyReads() - mountReads).toBe(0);
    expect(mountReads).toBe(1);
    expect(within(screen.getByLabelText('对话消息')).getAllByText(/保存消息 0-/u)).toHaveLength(48);
  });

  it('switches saved tasks in memory and reloads the selected history when the workbench reopens', () => {
    const conversations = saveHistory();
    const read = vi.spyOn(Storage.prototype, 'getItem');
    const view = render(<SkillChatWorkbench {...props} />);
    const historyReads = () => read.mock.calls.filter(([key]) => key === storageKey).length;
    const mountReads = historyReads();

    fireEvent.change(screen.getByRole('combobox', { name: 'Codex 任务' }), {
      target: { value: conversations[1]!.id },
    });
    expect(within(screen.getByLabelText('对话消息')).getAllByText(/保存消息 1-/u)).toHaveLength(48);
    expect(historyReads()).toBe(mountReads);
    view.unmount();

    render(<SkillChatWorkbench {...props} />);
    expect(screen.getByRole('combobox', { name: 'Codex 任务' })).toHaveValue(conversations[1]!.id);
    expect(within(screen.getByLabelText('对话消息')).getAllByText(/保存消息 1-/u)).toHaveLength(48);
    expect(historyReads()).toBe(mountReads + 1);
  });
});
