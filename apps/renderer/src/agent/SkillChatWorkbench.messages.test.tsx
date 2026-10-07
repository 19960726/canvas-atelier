import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SkillChatWorkbench, type SkillChatWorkbenchProps } from './SkillChatWorkbench';
import { createAgentConversation, writeAgentConversationCollection } from './skill-chat-session-store';

const projectId = 'agent-message-interactions';
const props: SkillChatWorkbenchProps = {
  projectId, profiles: [{ provider: 'comfly', modelRoute: 'chat/default', modelId: 'fixture', displayName: 'Local fixture', capabilities: ['chat'] }],
  knowledgeBases: [], projectMemoryIds: [], reverseTimeline: [],
  chat: async () => { throw new Error('Message interactions must not submit requests'); },
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

function saveMessages(content: string, resultNodeId?: string) {
  const conversation = { ...createAgentConversation(1), id: 'messages', mode: 'chat' as const, modelRoute: 'chat/default', messages: [
    { id: 'user', role: 'user' as const, content: '保留 **原样文字** 与产品结构' },
    { id: resultNodeId ? `canvas-result:${resultNodeId}` : 'reply', role: 'assistant' as const, content },
  ] };
  writeAgentConversationCollection(projectId, { version: 2, activeConversationId: conversation.id, conversations: [conversation] });
}

describe('Agent message interactions', () => {
  it('follows a newly visible or resized stream but preserves the position while reading history', async () => {
    const resizeCallbacks: (() => void)[] = [];
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { resizeCallbacks.push(callback); }
      observe() {}
      disconnect() {}
    });
    saveMessages('窗口展开后应显示最新回复');
    render(<SkillChatWorkbench {...props} />);
    const stream = screen.getByLabelText('Agent 消息流');
    await new Promise(resolve => window.requestAnimationFrame(resolve));
    Object.defineProperties(stream, { scrollHeight: { configurable: true, value: 1400 }, clientHeight: { configurable: true, value: 400 } });
    resizeCallbacks.forEach(callback => callback());
    await waitFor(() => expect(stream.scrollTop).toBe(1400));
    stream.scrollTop = 120;
    fireEvent.scroll(stream);
    Object.defineProperty(stream, 'scrollHeight', { configurable: true, value: 2000 });
    resizeCallbacks.forEach(callback => callback());
    await new Promise(resolve => window.requestAnimationFrame(resolve));
    expect(stream.scrollTop).toBe(120);
  });

  it('returns to latest without intermediate smooth frames interrupting subsequent replies', async () => {
    const nodeId = 'latest-result';
    saveMessages('等待结果', nodeId);
    const targets = [{ kind: 'image_generation' as const, nodeId, label: '结果', selected: false }];
    const view = render(<SkillChatWorkbench {...props} canvasActionTargets={targets} canvasActionResults={[{ nodeId, status: 'running', assetIds: [] }]} />);
    const stream = screen.getByLabelText('Agent 消息流');
    Object.defineProperties(stream, { scrollHeight: { configurable: true, value: 1400 }, clientHeight: { configurable: true, value: 400 } });
    Object.defineProperty(stream, 'scrollTo', { configurable: true, value: (options: ScrollToOptions) => {
      stream.scrollTop = options.behavior === 'smooth' ? 300 : 1000;
      fireEvent.scroll(stream);
    } });
    stream.scrollTop = 120;
    fireEvent.scroll(stream);
    fireEvent.click(screen.getByRole('button', { name: '回到最新消息' }));
    view.rerender(<SkillChatWorkbench {...props} canvasActionTargets={targets} canvasActionResults={[{ nodeId, status: 'completed', assetIds: [] }]} />);
    await waitFor(() => expect(screen.getByText('任务结束，但未收到可展示的结果。')).toBeVisible());
    expect(screen.queryByRole('button', { name: '回到最新消息' })).not.toBeInTheDocument();
  });

  it('copies the complete original reply, confirms success, and keeps the draft and requests unchanged', async () => {
    const content = '## 完整分析\n\n保留 **产品轮廓**。\n\n- 金属材质\n- 四个角度';
    saveMessages(content);
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const chat = vi.fn();
    render(<SkillChatWorkbench {...props} chat={chat} />);
    fireEvent.change(screen.getByTestId('agent-composer-input'), { target: { value: '继续优化手部' } });
    fireEvent.click(within(screen.getByLabelText('对话消息')).getByRole('button', { name: '复制回复' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('已复制'));
    expect(writeText).toHaveBeenCalledExactlyOnceWith(content);
    expect(screen.getByTestId('agent-composer-input')).toHaveValue('继续优化手部');
    expect(chat).not.toHaveBeenCalled();
  });

  it('reports clipboard rejection without a false success', async () => {
    saveMessages('完整回复');
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } });
    render(<SkillChatWorkbench {...props} />);
    fireEvent.click(screen.getByRole('button', { name: '复制回复' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('复制失败'));
    expect(screen.queryByText('已复制', { exact: true })).not.toBeInTheDocument();
  });

  it('renders assistant headings and lists while preserving literal user text and blocking remote images and raw HTML', () => {
    saveMessages('## 检查结果\n\n- **保留结构**\n- 检查透明边缘\n\n![tracking](https://example.test/tracker.png)\n\n<script>alert(1)</script>\n\n[unsafe](javascript:alert%281%29)');
    render(<SkillChatWorkbench {...props} />);
    expect(screen.getByRole('heading', { name: '检查结果' })).toBeVisible();
    expect(within(screen.getByLabelText('对话消息')).getAllByRole('listitem')).toHaveLength(2);
    expect(within(screen.getByLabelText('对话消息')).getByText('保留 **原样文字** 与产品结构')).toBeVisible();
    expect(document.querySelector('script')).toBeNull();
    expect(document.querySelector('img[src*="tracker"]')).toBeNull();
    expect(document.querySelector('a[href^="javascript:"]')).toBeNull();
  });

  it('preserves history position when an asynchronous result arrives and lets the user return to latest', async () => {
    const nodeId = 'result-scroll';
    saveMessages('等待画布任务', nodeId);
    const targets = [{ kind: 'image_generation' as const, nodeId, label: '结果', selected: false }];
    const view = render(<SkillChatWorkbench {...props} canvasActionTargets={targets} canvasActionResults={[{ nodeId, status: 'running', assetIds: [] }]} />);
    const stream = screen.getByLabelText('Agent 消息流');
    Object.defineProperties(stream, { scrollHeight: { configurable: true, value: 1400 }, clientHeight: { configurable: true, value: 400 } });
    const scrollTo = vi.fn();
    Object.defineProperty(stream, 'scrollTo', { configurable: true, value: scrollTo });
    stream.scrollTop = 120;
    fireEvent.scroll(stream);
    view.rerender(<SkillChatWorkbench {...props} canvasActionTargets={targets} canvasActionResults={[{ nodeId, status: 'completed', assetIds: [] }]} />);
    await waitFor(() => expect(screen.getByText('任务结束，但未收到可展示的结果。')).toBeVisible());
    await new Promise(resolve => window.requestAnimationFrame(resolve));
    expect(stream.scrollTop).toBe(120);
    expect(scrollTo).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '回到最新消息' }));
    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 1400 }));
  });
});
