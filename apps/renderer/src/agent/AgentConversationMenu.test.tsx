import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, expect, it, vi } from 'vitest';
import { AgentConversationMenu } from './AgentConversationMenu';
import { createAgentConversation } from './skill-chat-session-store';

afterEach(cleanup);

it('keeps an older active task visible and makes every stored task reachable through more conversations', () => {
  const conversations = Array.from({ length: 7 }, (_, index) => ({
    ...createAgentConversation(Date.now() - index * 60_000), id: `conversation-${index}`, title: `任务 ${index}`,
  }));
  const select = vi.fn();
  render(<AgentConversationMenu conversations={conversations} activeId="conversation-6" onSelect={select} onCreate={vi.fn()} onClose={vi.fn()} />);
  const menu = screen.getByRole('dialog', { name: '历史对话' });
  expect(menu.querySelector('[aria-current="true"]')).toHaveTextContent('任务 6');
  expect(screen.queryByRole('button', { name: /任务 3/u })).not.toBeInTheDocument();
  fireEvent.click(within(menu).getByRole('button', { name: '更多对话 · 4' }));
  for (const conversation of conversations) expect(within(menu).getByRole('button', { name: new RegExp(conversation.title, 'u') })).toBeVisible();
  fireEvent.click(within(menu).getByRole('button', { name: /任务 3/u }));
  expect(select).toHaveBeenCalledWith('conversation-3');
  fireEvent.click(within(menu).getByRole('button', { name: '收起对话' }));
  expect(menu.querySelector('[aria-current="true"]')).toHaveTextContent('任务 6');
  expect(conversations.map(conversation => conversation.id)).toEqual(Array.from({ length: 7 }, (_, index) => `conversation-${index}`));
});
