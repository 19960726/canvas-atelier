import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CODEX_ASTRA_PROFILE, type ChatSkillBridgeResult } from '@agent-canvas/desktop-core';
import { SkillChatWorkbench } from './SkillChatWorkbench';
import { createAgentConversation, readAgentConversationCollection, writeAgentConversationCollection } from './skill-chat-session-store';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe('SkillChatWorkbench cancellation ownership', () => {
  it('keeps sending locked when the old reply arrives before its cancellation settles', async () => {
    const reply = deferred<ChatSkillBridgeResult>();
    const cancellation = deferred<boolean>();
    render(<SkillChatWorkbench
      projectId="cancel-still-pending"
      profiles={[]}
      codexProfiles={[{ ...CODEX_ASTRA_PROFILE, supportedReasoningEfforts: ['medium'], defaultReasoningEffort: 'medium' }]}
      knowledgeBases={[]} projectMemoryIds={[]} reverseTimeline={[]}
      chat={() => reply.promise} cancelChat={() => cancellation.promise}
    />);
    fireEvent.change(screen.getByTestId('agent-composer-input'), { target: { value: '原请求' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    fireEvent.click(screen.getByRole('button', { name: '停止 Codex 分析' }));
    await act(async () => { reply.resolve({ message: '取消前迟到的回复', modelRoute: CODEX_ASTRA_PROFILE.modelRoute, sources: [] }); });
    fireEvent.change(screen.getByLabelText('Agent 模式'), { target: { value: 'chat' } });
    fireEvent.change(screen.getByLabelText('Agent 模式'), { target: { value: 'codex' } });
    fireEvent.change(screen.getByTestId('agent-composer-input'), { target: { value: '下一次请求' } });
    expect(screen.queryByText('取消前迟到的回复')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled();
    await act(async () => { cancellation.resolve(true); });
    expect(screen.getByRole('button', { name: '发送' })).toBeEnabled();
  });

  it.each(['stop', 'mode', 'new-task'] as const)('keeps task B running when an earlier %s cancellation settles after B sends', async (cancelAction) => {
    const firstReply = deferred<ChatSkillBridgeResult>();
    const secondReply = deferred<ChatSkillBridgeResult>();
    const lateCancellation = deferred<boolean>();
    const switchCancellation = deferred<boolean>();
    const chat = vi.fn().mockImplementationOnce(() => firstReply.promise).mockImplementationOnce(() => secondReply.promise);
    const cancelChat = vi.fn().mockResolvedValue(true)
      .mockImplementationOnce(() => lateCancellation.promise)
      .mockImplementationOnce(() => switchCancellation.promise);
    const first = { ...createAgentConversation(1), title: '任务 A', modelRoute: CODEX_ASTRA_PROFILE.modelRoute };
    const second = { ...createAgentConversation(2), title: '任务 B', modelRoute: CODEX_ASTRA_PROFILE.modelRoute };
    writeAgentConversationCollection('cancel-ownership', {
      version: 2, activeConversationId: first.id, conversations: [first, second],
    });
    render(<SkillChatWorkbench
      projectId="cancel-ownership"
      profiles={[]}
      codexProfiles={[{ ...CODEX_ASTRA_PROFILE, supportedReasoningEfforts: ['medium'], defaultReasoningEffort: 'medium' }]}
      knowledgeBases={[]} projectMemoryIds={[]} reverseTimeline={[]}
      chat={chat} cancelChat={cancelChat}
    />);

    fireEvent.change(screen.getByTestId('agent-composer-input'), { target: { value: '任务 A 的请求' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(chat).toHaveBeenCalledOnce();
    if (cancelAction === 'stop') fireEvent.click(screen.getByRole('button', { name: '停止 Codex 分析' }));
    else if (cancelAction === 'mode') fireEvent.change(screen.getByLabelText('Agent 模式'), { target: { value: 'chat' } });
    else fireEvent.click(screen.getByRole('button', { name: '新建任务' }));
    fireEvent.click(screen.getByRole('button', { name: '历史对话' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: '历史对话' })).getByRole('button', { name: /任务 B/u }));
    fireEvent.change(screen.getByTestId('agent-composer-input'), { target: { value: '任务 B 的请求' } });
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled();
    expect(cancelChat).toHaveBeenCalledTimes(2);
    expect(cancelChat.mock.calls[0]![0]).toBe(cancelChat.mock.calls[1]![0]);

    await act(async () => { switchCancellation.resolve(true); });
    expect(screen.getByRole('button', { name: '发送' })).toBeEnabled();
    const cancelledFirst = readAgentConversationCollection('cancel-ownership').conversations.find((item) => item.id === first.id)!;
    expect(cancelledFirst.messages[0]!.request?.status).toBe('error');
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(chat).toHaveBeenCalledTimes(2);
    fireEvent.change(screen.getByTestId('agent-composer-input'), { target: { value: '等待 B 完成后再发送' } });

    await act(async () => { lateCancellation.resolve(true); });
    expect(screen.getByLabelText('Agent 正在分析')).toBeVisible();
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled();
    const activeAfterOldCancel = readAgentConversationCollection('cancel-ownership').conversations.find((item) => item.id === second.id)!;
    expect(activeAfterOldCancel.messages[0]!.request?.status).toBe('sending');

    await act(async () => { firstReply.resolve({ message: 'A 的迟到结果', modelRoute: CODEX_ASTRA_PROFILE.modelRoute, sources: [] }); });
    expect(screen.queryByText('A 的迟到结果')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Agent 正在分析')).toBeVisible();
    await act(async () => { secondReply.resolve({ message: 'B 的有效结果', modelRoute: CODEX_ASTRA_PROFILE.modelRoute, sources: [] }); });
    expect(screen.getByText('B 的有效结果')).toBeVisible();
    expect(screen.queryByLabelText('Agent 正在分析')).not.toBeInTheDocument();
    const completed = readAgentConversationCollection('cancel-ownership').conversations.find((item) => item.id === second.id)!;
    expect(completed.messages[0]!.request?.status).toBe('completed');
  });

  it.each(['mode', 'thread', 'new-task'] as const)('settles the original request after %s cancellation without losing its content', async (cancelAction) => {
    const reply = deferred<ChatSkillBridgeResult>();
    const cancellation = deferred<boolean>();
    const first = { ...createAgentConversation(1), title: '原任务', modelRoute: CODEX_ASTRA_PROFILE.modelRoute };
    const second = { ...createAgentConversation(2), title: '下一任务', modelRoute: CODEX_ASTRA_PROFILE.modelRoute };
    writeAgentConversationCollection('interrupted-request', { version: 2, activeConversationId: first.id, conversations: [first, second] });
    render(<SkillChatWorkbench projectId="interrupted-request" profiles={[]}
      codexProfiles={[{ ...CODEX_ASTRA_PROFILE, supportedReasoningEfforts: ['medium'], defaultReasoningEffort: 'medium' }]}
      knowledgeBases={[]} projectMemoryIds={[]} reverseTimeline={[]}
      chat={() => reply.promise} cancelChat={() => cancellation.promise} />);
    fireEvent.change(screen.getByTestId('agent-composer-input'), { target: { value: '保留完整原请求' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    const sent = readAgentConversationCollection('interrupted-request').conversations[0]!.messages[0]!;
    if (cancelAction === 'mode') fireEvent.change(screen.getByLabelText('Agent 模式'), { target: { value: 'chat' } });
    else if (cancelAction === 'new-task') fireEvent.click(screen.getByRole('button', { name: '新建任务' }));
    else {
      fireEvent.click(screen.getByRole('button', { name: '历史对话' }));
      fireEvent.click(within(screen.getByRole('dialog', { name: '历史对话' })).getByRole('button', { name: /下一任务/u }));
    }
    await act(async () => { cancellation.resolve(true); });
    expect(screen.queryByLabelText('Agent 正在分析')).not.toBeInTheDocument();
    const interrupted = readAgentConversationCollection('interrupted-request').conversations.find((item) => item.id === first.id)!.messages;
    expect(interrupted).toHaveLength(1);
    expect(interrupted[0]).toMatchObject({ id: sent.id, content: sent.content, request: { status: 'error' } });
    await act(async () => { reply.resolve({ message: '过期结果', modelRoute: CODEX_ASTRA_PROFILE.modelRoute, sources: [] }); });
    expect(screen.queryByText('过期结果')).not.toBeInTheDocument();
    expect(readAgentConversationCollection('interrupted-request').conversations.find((item) => item.id === first.id)!.messages).toHaveLength(1);
  });

  it('recovers stored sending requests after reopening without automatically submitting them', () => {
    const first = { ...createAgentConversation(1), modelRoute: CODEX_ASTRA_PROFILE.modelRoute, messages: [{
      id: 'interrupted-first', role: 'user' as const, mode: 'codex' as const, content: '未完成的原任务',
      request: { modelDisplayName: 'Codex', modelRoute: CODEX_ASTRA_PROFILE.modelRoute,
        knowledgeBaseCount: 0, projectMemoryCount: 0, references: [], status: 'sending' as const },
    }] };
    const second = { ...first, id: 'stored-other-task', title: '历史未完成任务', messages: [{ ...first.messages[0]!, id: 'interrupted-second' }] };
    writeAgentConversationCollection('restart-interrupted', { version: 2, activeConversationId: first.id, conversations: [first, second] });
    const chat = vi.fn(async () => ({ message: '不应调用', modelRoute: CODEX_ASTRA_PROFILE.modelRoute, sources: [] }));
    render(<SkillChatWorkbench projectId="restart-interrupted" profiles={[]}
      codexProfiles={[{ ...CODEX_ASTRA_PROFILE, supportedReasoningEfforts: ['medium'], defaultReasoningEffort: 'medium' }]}
      knowledgeBases={[]} projectMemoryIds={[]} reverseTimeline={[]} chat={chat} cancelChat={async () => true} />);
    expect(chat).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Agent 正在分析')).not.toBeInTheDocument();
    for (const conversation of readAgentConversationCollection('restart-interrupted').conversations) {
      expect(conversation.messages[0]).toMatchObject({ content: '未完成的原任务', request: { status: 'error' } });
    }
  });

  it('closes history and restores trigger focus after selecting the active task', () => {
    render(<SkillChatWorkbench projectId="active-menu-item" profiles={[]}
      codexProfiles={[{ ...CODEX_ASTRA_PROFILE, supportedReasoningEfforts: ['medium'], defaultReasoningEffort: 'medium' }]}
      knowledgeBases={[]} projectMemoryIds={[]} reverseTimeline={[]}
      chat={async () => ({ message: '不应调用', modelRoute: CODEX_ASTRA_PROFILE.modelRoute, sources: [] })} />);
    const trigger = screen.getByRole('button', { name: '历史对话' });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('dialog', { name: '历史对话' }).querySelector<HTMLButtonElement>('[aria-current="true"]')!);
    expect(screen.queryByRole('dialog', { name: '历史对话' })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});
