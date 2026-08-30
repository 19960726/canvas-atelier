import { readFileSync } from 'node:fs';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatSkillBridgeResult, ProviderBridgeProfile } from '@agent-canvas/desktop-core';
import type { KnowledgeBaseStateSummary } from '@agent-canvas/skill-store';
import { resolveClipboardPasteAction, SkillChatWorkbench, type SkillChatRequest } from './SkillChatWorkbench';
import { createAgentConversation, writeAgentConversationCollection } from './skill-chat-session-store';

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  window.localStorage.clear();
  vi.useRealTimers();
});

const profiles: ProviderBridgeProfile[] = [
  {
    provider: 'comfly',
    modelRoute: 'chat/creative',
    modelId: 'codex-creative-chat',
    displayName: 'Creative chat',
    capabilities: ['chat'],
  },
  {
    provider: 'comfly',
    modelRoute: 'image/only',
    modelId: 'image-only',
    displayName: 'Image only',
    capabilities: ['image_generation'],
  },
];

const knowledgeBases: KnowledgeBaseStateSummary[] = [{
  schemaVersion: 1,
  knowledgeBaseId: 'scene-skill',
  displayName: '场景 Skill',
  status: 'active',
  activeVersion: 3,
  activeContentHash: 'a'.repeat(64),
  versionCount: 3,
  versions: [],
  lastFailure: null,
  lastRollbackAt: null,
}];

function workbench(overrides: Partial<React.ComponentProps<typeof SkillChatWorkbench>> = {}) {
  return <SkillChatWorkbench
    projectId="project-a"
    profiles={profiles}
    knowledgeBases={knowledgeBases}
    projectMemoryIds={['memory-style']}
    chat={async () => ({
      message: 'Use a clean studio-lighting hierarchy.',
      modelRoute: 'chat/creative',
      sources: [{ knowledgeBaseId: 'scene-skill', version: 3, displayName: '场景 Skill' }],
    })}
    reverseTimeline={[]}
    {...overrides}
  />;
}

function renderWorkbench(overrides: Partial<React.ComponentProps<typeof SkillChatWorkbench>> = {}) {
  return render(workbench(overrides));
}

describe('SkillChatWorkbench', () => {
  it('keeps clipboard events inside the Agent workbench', () => {
    const outerCopy = vi.fn();
    const outerCut = vi.fn();
    const outerPaste = vi.fn();
    render(
      <div onCopy={outerCopy} onCut={outerCut} onPaste={outerPaste}>
        {workbench()}
      </div>,
    );

    fireEvent.copy(screen.getByLabelText('Agent 消息流'));
    fireEvent.cut(screen.getByLabelText('Agent 消息流'));
    fireEvent.paste(screen.getByTestId('agent-composer-input'), {
      clipboardData: { files: [], items: [], getData: () => '内容', types: ['text/plain'] },
    });

    expect(outerCopy).not.toHaveBeenCalled();
    expect(outerCut).not.toHaveBeenCalled();
    expect(outerPaste).not.toHaveBeenCalled();
  });

  it('does not rewrite conversation state when equivalent project memory arrays are recreated', async () => {
    const write = vi.spyOn(Storage.prototype, 'setItem');
    const view = renderWorkbench();
    await act(async () => undefined);
    const baselineWrites = write.mock.calls.length;

    view.rerender(workbench({ projectMemoryIds: ['memory-style'] }));
    await act(async () => undefined);

    expect(write.mock.calls.length).toBe(baselineWrites);
  });

  it.each([
    ['CREDENTIALS_LOCKED', '模型密钥不可用，请在设置中重新配置。'],
    ['PROVIDER_UNAVAILABLE', '模型服务暂时不可用，请检查网络或连接设置。'],
    ['CAPABILITY_UNSUPPORTED', '当前模型不支持该素材或任务，请切换模型。'],
    ['PROVIDER_INVALID_RESPONSE', '模型返回内容无效，请重试或切换模型。'],
  ])('shows a safe actionable message for Agent error %s', async (code, expectedMessage) => {
    const chat = vi.fn().mockRejectedValue({
      code,
      message: 'https://private.example/v1 token=secret C:\\private\\provider.json',
      retryable: true,
    });
    renderWorkbench({ chat });

    fireEvent.change(screen.getByTestId('agent-composer-input'), { target: { value: '分析这个方案' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(expectedMessage));
    expect(screen.getByRole('alert')).not.toHaveTextContent('private.example');
    expect(screen.getByRole('alert')).not.toHaveTextContent('secret');
    expect(screen.getByTestId('agent-composer-input')).toHaveValue('分析这个方案');
    expect(screen.getByRole('button', { name: '发送' })).toBeEnabled();
  });

  it('times out a stalled Agent request and restores the composer for retry', async () => {
    vi.useFakeTimers();
    const chat = vi.fn(() => new Promise<ChatSkillBridgeResult>(() => undefined));
    renderWorkbench({ chat });

    fireEvent.change(screen.getByTestId('agent-composer-input'), { target: { value: '继续分析' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    expect(screen.getByRole('alert')).toHaveTextContent('请求超时，请检查网络后重试。');
    expect(screen.getByTestId('agent-composer-input')).toHaveValue('继续分析');
    expect(screen.getByRole('button', { name: '发送' })).toBeEnabled();
  });

  it('does not send an unsynchronized knowledge base that would break Agent chat', async () => {
    const chat = vi.fn(async () => ({ message: '可以正常对话', modelRoute: 'chat/creative', sources: [] }));
    renderWorkbench({ knowledgeBases: [], chat });

    fireEvent.click(screen.getByTestId('knowledge-base-trigger'));
    const library = screen.getByRole('dialog', { name: '选择知识库' });
    const unavailableKnowledge = within(library).getByText('场景 Skill').closest('button');
    expect(unavailableKnowledge).toBeEnabled();
    fireEvent.click(unavailableKnowledge!);

    fireEvent.change(screen.getByTestId('agent-composer-input'), { target: { value: '不使用未同步知识库聊天' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    await waitFor(() => expect(chat).toHaveBeenCalledWith(expect.objectContaining({
      context: expect.objectContaining({ knowledgeBaseIds: [] }),
    })));
    expect(await screen.findByText('可以正常对话')).toBeVisible();
  });

  it('allows text chat on a vision-capable responses route', async () => {
    const chat = vi.fn(async () => ({ message: '视觉模型也可以正常聊天', modelRoute: 'responses/vision', sources: [] }));
    renderWorkbench({
      profiles: [{
        provider: 'comfly',
        modelRoute: 'responses/vision',
        modelId: 'vision-responses',
        displayName: 'Vision Responses',
        capabilities: ['responses', 'vision'],
      }],
      chat,
    });
    fireEvent.click(screen.getByRole('tab', { name: '对话' }));
    fireEvent.change(screen.getByTestId('agent-composer-input'), { target: { value: '你好' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    await waitFor(() => expect(chat).toHaveBeenCalledOnce());
    expect(await screen.findByText('视觉模型也可以正常聊天')).toBeVisible();
  });
  it('centers the single send glyph without a translated tail or generated counter', () => {
    const css = readFileSync('apps/renderer/src/styles/figma-hybrid-canvas.css', 'utf8');
    const iconRule = css.match(/\.workspace--ui-gate \.agent-panel--skill-chat \.skill-chat-workbench__composer-footer > button svg \{[^}]+\}/u)?.[0] ?? '';

    expect(iconRule).toContain('transform: none');
    const submitAfterRule = css.match(/\.workspace--ui-gate \.agent-panel--skill-chat \.skill-chat-workbench__composer-footer > button\[type='submit'\]::after \{[^}]+\}/u)?.[0] ?? '';
    expect(submitAfterRule).toContain('content: none');
  });
  it('places the final scoped Codex Agent contract after every legacy Agent rule', () => {
    const css = readFileSync('apps/renderer/src/styles/app.css', 'utf8');
    const marker = css.lastIndexOf('FINAL CODEX AGENT CONTRACT');
    expect(marker).toBeGreaterThan(css.lastIndexOf('.agent-panel .skill-chat-workbench__composer'));
    expect(css.slice(marker)).toMatch(/agent-panel--skill-chat[\s\S]*grid-template-rows:\s*76px minmax\(0, 1fr\) auto/u);
  });
  it('keeps the Agent composer discoverable for keyboard and visual automation', () => {
    renderWorkbench();

    expect(screen.getByTestId('agent-composer-input')).toHaveAttribute('aria-label', '向 Agent 发送消息');
  });

  it('uses icon-only Figma tools without showing the removed image-reference button by default', () => {
    const { container } = renderWorkbench();

    const tools = Array.from(container.querySelectorAll('.skill-chat-workbench__tool'));
    expect(tools).toHaveLength(3);
    for (const tool of tools) {
      expect(tool.textContent?.trim()).toBe('');
      expect(tool.querySelector('svg')).not.toBeNull();
    }
  });

  it('keeps knowledge and model selection anchored to the composer footer', () => {
    const { container } = renderWorkbench();

    expect(container.querySelector('.skill-chat-workbench__header-actions')).toBeVisible();
    const footer = container.querySelector('.skill-chat-workbench__composer-footer');
    expect(footer).not.toBeNull();
    const knowledgeTrigger = within(footer as HTMLElement).getByTestId('knowledge-base-trigger');
    const modelTrigger = within(footer as HTMLElement).getByTestId('agent-model-trigger');
    expect(knowledgeTrigger).toBeVisible();
    expect(modelTrigger).toBeVisible();

    fireEvent.click(knowledgeTrigger);
    const knowledgeDialog = container.querySelector('.skill-chat-workbench__sheet--library');
    expect(knowledgeDialog).toHaveAttribute('data-anchor', 'composer-footer');
    fireEvent.click((knowledgeDialog as HTMLElement).querySelector('header button')!);

    fireEvent.click(modelTrigger);
    const modelDialog = container.querySelector('.skill-chat-workbench__sheet:not(.skill-chat-workbench__sheet--library)');
    expect(modelDialog).toHaveAttribute('data-anchor', 'composer-footer');
  });
  it('keeps the Figma image-reference affordance hidden until the user types @', () => {
    renderWorkbench();

    expect(screen.queryByTestId('agent-image-reference-affordance')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '寮曠敤鍥剧墖' })).not.toBeInTheDocument();
    expect(screen.queryByRole('menu', { name: 'Reference images' })).not.toBeInTheDocument();
  });

  it('accepts a generated-image action as an Agent @ reference', async () => {
    renderWorkbench({
      profiles: [{ ...profiles[0]!, capabilities: ['chat', 'vision'] }],
      referenceImages: [{
        assetId: 'b'.repeat(16),
        label: 'Generated hero',
        displayUrl: 'novus-project://asset/generated-hero',
      }],
    });

    window.dispatchEvent(new CustomEvent('novus:generated-image-to-agent', { detail: { assetId: 'b'.repeat(16) } }));

    await waitFor(() => expect(screen.getByTestId('agent-composer-input')).toHaveValue('@图片1'));
    expect(screen.getByLabelText('Selected image references')).toHaveTextContent('Generated hero');
  });

  it('exposes the Figma new-chat action above an empty Skill conversation', () => {
    renderWorkbench();

    expect(screen.getByTestId('agent-new-chat')).toBeVisible();
    expect(screen.getByTestId('agent-new-chat')).toHaveTextContent('新对话');
  });

  it('creates a separate task and restores the previous conversation from the task selector', async () => {
    renderWorkbench();

    fireEvent.change(screen.getByTestId('agent-composer-input'), { target: { value: '分析第一张产品参考图的构图与光线' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(screen.getByText('Use a clean studio-lighting hierarchy.')).toBeVisible());

    const taskSelector = screen.getByRole('combobox', { name: 'Codex 任务' });
    const firstTaskId = (taskSelector as HTMLSelectElement).value;
    expect(within(taskSelector).getByRole('option', { name: '分析第一张产品参考图的构图与光线' })).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('agent-new-chat'));
    expect(screen.queryByText('Use a clean studio-lighting hierarchy.')).not.toBeInTheDocument();
    expect((taskSelector as HTMLSelectElement).value).not.toBe(firstTaskId);

    fireEvent.change(taskSelector, { target: { value: firstTaskId } });
    expect(within(screen.getByLabelText('对话消息')).getByText('分析第一张产品参考图的构图与光线')).toBeVisible();
    expect(screen.getByText('Use a clean studio-lighting hierarchy.')).toBeVisible();
  });

  it('restores the active task and its mode after the workbench remounts', async () => {
    const first = renderWorkbench();
    fireEvent.click(screen.getByRole('tab', { name: '原智能' }));
    fireEvent.change(screen.getByTestId('agent-composer-input'), { target: { value: '保留这个任务' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(screen.getByText('Use a clean studio-lighting hierarchy.')).toBeVisible());

    first.unmount();
    renderWorkbench();

    expect(within(screen.getByLabelText('对话消息')).getByText('保留这个任务')).toBeVisible();
    expect(screen.getByRole('tab', { name: '原智能' })).toHaveAttribute('aria-selected', 'true');
    expect((screen.getByRole('combobox', { name: 'Codex 任务' }) as HTMLSelectElement).value).toMatch(/^conversation-/u);
  });

  it('shows reasoning effort only for Codex so the compact composer is not overcrowded', () => {
    renderWorkbench();

    expect(screen.getByRole('combobox', { name: '推理强度' })).toBeVisible();
    fireEvent.click(screen.getByRole('tab', { name: '对话' }));
    expect(screen.queryByRole('combobox', { name: '推理强度' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: '原智能' }));
    expect(screen.queryByRole('combobox', { name: '推理强度' })).not.toBeInTheDocument();
  });

  it('keeps non-Codex routes out of Codex mode and selects an available Codex route', async () => {
    renderWorkbench({
      profiles: [
        { provider: 'comfly', modelRoute: 'chat/general', modelId: 'general-chat', displayName: 'General Chat', capabilities: ['chat'] },
        { provider: 'comfly', modelRoute: 'codex-auto-review', modelId: 'codex-auto-review', displayName: 'Codex Auto Review', capabilities: ['responses', 'vision'] },
      ],
    });

    await waitFor(() => expect(screen.getByTestId('agent-model-trigger')).toHaveAttribute('data-selected-model', 'Codex Auto Review'));
    fireEvent.click(screen.getByTestId('agent-model-trigger'));
    const dialog = screen.getByRole('dialog', { name: '选择聊天模型' });
    expect(within(dialog).getByText('Codex Auto Review')).toBeVisible();
    expect(within(dialog).queryByText('General Chat')).not.toBeInTheDocument();
  });

  it('does not fall back to ordinary chat models when Codex mode has no Codex route', async () => {
    renderWorkbench({
      profiles: [{ provider: 'comfly', modelRoute: 'chat/general', modelId: 'general-chat', displayName: 'General Chat', capabilities: ['chat'] }],
    });

    await waitFor(() => expect(screen.getByTestId('agent-model-trigger')).toHaveTextContent('未发现 Codex 模型'));
    fireEvent.click(screen.getByTestId('agent-model-trigger'));
    const dialog = screen.getByRole('dialog', { name: '选择聊天模型' });
    expect(dialog).not.toHaveTextContent('General Chat');
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled();
  });

  it('uses the active RelayMe chat route as the Codex Agent runtime when RelayMe is configured alone', async () => {
    renderWorkbench({
      profiles: [{
        provider: 'relayme',
        modelRoute: 'relayme-gemini-3-1-flash-lite',
        modelId: 'gemini-3.1-flash-lite',
        displayName: 'Gemini 3.1 Flash Lite',
        capabilities: ['chat'],
      }],
    });

    await waitFor(() => expect(screen.getByTestId('agent-model-trigger')).toHaveAttribute('data-selected-model', 'Gemini 3.1 Flash Lite'));
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled();
    fireEvent.change(screen.getByTestId('agent-composer-input'), { target: { value: '分析当前画布' } });
    expect(screen.getByRole('button', { name: '发送' })).toBeEnabled();
  });

  it('keeps internal request metadata out of the visible conversation in every mode', async () => {
    const chat = vi.fn(async () => ({ message: '普通助手回复', modelRoute: 'codex-auto-review', sources: [] }));
    renderWorkbench({
      profiles: [{ provider: 'comfly', modelRoute: 'codex-auto-review', modelId: 'codex-auto-review', displayName: 'Codex Auto Review', capabilities: ['responses'] }],
      reverseTimeline: [{ nodeId: 'reverse-1', title: '旧反推', positivePrompt: 'studio product' }],
      chat,
    });
    fireEvent.change(screen.getByTestId('agent-composer-input'), { target: { value: '正常聊天消息' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(screen.getByText('普通助手回复')).toBeVisible());
    expect(screen.queryByLabelText('知识库请求: Codex Auto Review')).not.toBeInTheDocument();
    expect(screen.getByLabelText('反推上下文事件')).toBeVisible();

    fireEvent.click(screen.getByRole('tab', { name: '对话' }));

    expect(within(screen.getByLabelText('对话消息')).getByText('正常聊天消息')).toBeVisible();
    expect(screen.getByText('普通助手回复')).toBeVisible();
    expect(screen.queryByLabelText('知识库请求: Codex Auto Review')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('反推上下文事件')).not.toBeInTheDocument();
  });

  it('sends the selected Codex reasoning effort instead of keeping it as presentation-only state', async () => {
    const chat = vi.fn(async () => ({ message: 'Codex plan', modelRoute: 'chat/creative', sources: [] }));
    renderWorkbench({ chat });
    fireEvent.change(screen.getByRole('combobox', { name: '推理强度' }), { target: { value: 'high' } });
    fireEvent.change(screen.getByTestId('agent-composer-input'), { target: { value: '设计一个生图工作流' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    await waitFor(() => expect(chat).toHaveBeenCalledWith(expect.objectContaining({
      agentMode: 'codex',
      reasoningEffort: 'high',
    })));
  });

  it('gives an empty Skill timeline a Chinese, non-canvas action next step', () => {
    renderWorkbench({ profiles: [] });

    const emptyState = screen.getByLabelText('Agent conversation empty state');
    expect(emptyState).toHaveTextContent('请先在设置中配置聊天模型');
    expect(emptyState.querySelector('button, input, textarea, select')).toBeNull();
  });

  it('shows LibLib-style skill recommendations only in the empty state', () => {
    renderWorkbench();

    const emptyState = screen.getByLabelText('Agent conversation empty state');
    expect(emptyState).toHaveClass('skill-chat-workbench__empty-state');
    expect(emptyState).toHaveTextContent('产品分析');
    expect(emptyState).toHaveTextContent('提示词优化');
    expect(emptyState).toHaveTextContent('生成方案');
    expect(emptyState).toHaveTextContent('知识库检索');
    expect(screen.getByRole('button', { name: '分析当前画布' })).toBeVisible();
    expect(screen.getByRole('button', { name: '生成视觉方向' })).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: '分析当前画布' }));
    expect(screen.getByTestId('agent-composer-input')).toHaveValue('分析当前画布并指出下一步可优化的节点。');
  });

  it('keeps knowledge cards out of the empty conversation above the composer', () => {
    renderWorkbench({ knowledgeBases: [] });

    expect(screen.queryByLabelText('已连接知识库')).not.toBeInTheDocument();
    expect(screen.queryAllByTestId('agent-knowledge-placeholder')).toHaveLength(0);
    return;

    const placeholders = screen.getAllByTestId('agent-knowledge-placeholder');
    expect(placeholders).toHaveLength(4);
    expect(placeholders.map((card) => card.textContent)).toEqual(expect.arrayContaining([
      expect.stringContaining('产品规范库'),
      expect.stringContaining('镜头语言库'),
      expect.stringContaining('中文创意库'),
      expect.stringContaining('灯光案例库'),
    ]));
    placeholders.forEach((card) => expect(card).toHaveAttribute('aria-disabled', 'true'));
  });

  it('does not show knowledge selectors above the composer in the empty conversation', () => {
    renderWorkbench({ knowledgeBases: [] });

    expect(screen.queryByLabelText('宸茶繛鎺ョ煡璇嗗簱')).not.toBeInTheDocument();
    expect(screen.queryByTestId('agent-knowledge-placeholder')).not.toBeInTheDocument();
    expect(screen.getByTestId('knowledge-base-trigger')).toBeVisible();
  });

  it('uses only the two required project knowledge bases in the footer picker', () => {
    renderWorkbench({ knowledgeBases: [] });

    fireEvent.click(screen.getByTestId('knowledge-base-trigger'));
    const library = screen.getByRole('dialog', { name: '选择知识库' });

    expect(library).toHaveTextContent('场景 Skill');
    expect(library).toHaveTextContent('电商详情页知识库');
    expect(library).not.toHaveTextContent('产品规范库');
    expect(library).not.toHaveTextContent('镜头语言库');
  });

  it('keeps recommendations out of an active conversation', async () => {
    const chat = vi.fn(async () => ({ message: 'A focused direction.', modelRoute: 'chat/creative', sources: [] }));
    renderWorkbench({ chat });
    fireEvent.change(screen.getByTestId('agent-composer-input'), { target: { value: 'Draft a direction.' } });
    fireEvent.submit(screen.getByTestId('agent-composer-input').closest('form')!);
    await waitFor(() => expect(screen.getByText('A focused direction.')).toBeVisible());
    expect(screen.queryByRole('button', { name: '分析当前画布' })).not.toBeInTheDocument();
  });

  it('lists only configured chat routes and sends controlled text context to chat', async () => {
    const chat = vi.fn(async () => ({
      message: 'Use a clean studio-lighting hierarchy.',
      modelRoute: 'chat/creative',
      sources: [{ knowledgeBaseId: 'scene-skill', version: 3, displayName: '场景 Skill' }],
    }));
    renderWorkbench({ chat });

    expect(screen.queryByRole('heading', { name: 'Agent 对话' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '打开聊天模型菜单' }));
    expect(screen.getByRole('button', { name: '使用 Creative chat' })).toBeVisible();
    expect(screen.queryByRole('button', { name: '使用 Image only' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '展开上下文' }));
    expect(screen.getByText('scene-skill')).toBeVisible();
    expect(screen.getByText('memory-style')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: '打开知识库' }));
    const knowledgeLibrary = screen.getByRole('dialog', { name: '选择知识库' });
    fireEvent.click(within(knowledgeLibrary).getByText('场景 Skill').closest('button')!);

    fireEvent.change(screen.getByLabelText('向 Agent 发送消息'), { target: { value: 'Suggest an art direction.' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    await waitFor(() => expect(chat).toHaveBeenCalledWith({
      provider: 'comfly',
      modelRoute: 'chat/creative',
      agentMode: 'codex',
      reasoningEffort: 'medium',
      visualAnalysis: false,
      messages: [{ role: 'user', content: 'Suggest an art direction.' }],
      context: { knowledgeBaseIds: ['scene-skill'], projectMemoryIds: ['memory-style'] },
    }));
    expect(screen.getByText('Use a clean studio-lighting hierarchy.')).toBeVisible();
    expect(screen.getByText('来源 · 场景 Skill v3')).toBeVisible();
    expect(screen.getByLabelText('来源')).toHaveTextContent('场景 Skill');
  });

  it('uses the provider attached to the selected chat profile', async () => {
    const chat = vi.fn(async () => ({ message: 'Relay response', modelRoute: 'relay/chat', sources: [] }));
    renderWorkbench({
      profiles: [{
        provider: 'relayme',
        modelRoute: 'relay/chat',
        modelId: 'gemini-3.1-flash-lite',
        displayName: 'Relay chat',
        capabilities: ['chat'],
      }],
      chat,
    });
    fireEvent.click(screen.getByRole('tab', { name: '对话' }));

    fireEvent.change(screen.getByTestId('agent-composer-input'), { target: { value: 'Use RelayMe.' } });
    fireEvent.submit(screen.getByTestId('agent-composer-input').closest('form')!);

    await waitFor(() => expect(chat).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'relayme',
      modelRoute: 'relay/chat',
    })));
  });

  it('sends the Agent message with Enter and keeps Shift+Enter for a newline', async () => {
    const chat = vi.fn(async () => ({ message: 'Agent reply', modelRoute: 'chat/creative', sources: [] }));
    renderWorkbench({ chat });
    const composer = screen.getByTestId('agent-composer-input');

    fireEvent.change(composer, { target: { value: 'First line' } });
    fireEvent.keyDown(composer, { key: 'Enter', code: 'Enter', shiftKey: true });
    expect(chat).not.toHaveBeenCalled();

    fireEvent.keyDown(composer, { key: 'Enter', code: 'Enter' });

    await waitFor(() => expect(chat).toHaveBeenCalledOnce());
    expect(chat).toHaveBeenCalledWith(expect.objectContaining({
      messages: [expect.objectContaining({ role: 'user', content: 'First line' })],
    }));
  });
  it('does not display Stop when the chat bridge has no cancellation capability', () => {
    const chat = vi.fn(() => new Promise<ChatSkillBridgeResult>(() => {}));
    renderWorkbench({ chat });

    fireEvent.change(screen.getByLabelText('向 Agent 发送消息'), { target: { value: 'Draft a headline.' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    expect(screen.queryByRole('button', { name: '停止显示' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '停止' })).not.toBeInTheDocument();
  });

  it('recovers a safe text-only conversation only for the same project id', async () => {
    renderWorkbench();
    fireEvent.change(screen.getByLabelText('向 Agent 发送消息'), { target: { value: 'Suggest a headline.' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(screen.getByText('Use a clean studio-lighting hierarchy.')).toBeVisible());

    cleanup();
    renderWorkbench({ chat: vi.fn(async () => ({ message: 'unused', modelRoute: 'chat/creative', sources: [] })) });
    expect(screen.getByText('Suggest a headline.')).toBeVisible();
    expect(screen.getByText('Use a clean studio-lighting hierarchy.')).toBeVisible();

    cleanup();
    renderWorkbench({
      projectId: 'project-b',
      chat: vi.fn(async () => ({ message: 'unused', modelRoute: 'chat/creative', sources: [] })),
    });
    expect(screen.queryByText('Suggest a headline.')).not.toBeInTheDocument();
  });

  it('ignores unsafe persisted session text instead of rendering it', () => {
    window.sessionStorage.setItem('agent-canvas:skill-chat:project-a', JSON.stringify({
      version: 1,
      modelRoute: 'chat/creative',
      knowledgeBaseIds: [],
      projectMemoryIds: [],
      messages: [{ id: 'unsafe', role: 'assistant', content: 'file:///C:/secret.txt', sources: [] }],
    }));

    renderWorkbench();

    expect(screen.queryByText('file:///C:/secret.txt')).not.toBeInTheDocument();
  });

  it('renders node reverse results as compact context events with details on demand', () => {
    renderWorkbench({
      reverseTimeline: [{
        nodeId: 'reverse-node-1',
        title: 'Bottle reference reverse result',
        positivePrompt: 'Frosted glass bottle, low-angle studio light.',
      }],
    });

    expect(screen.getByLabelText('Agent 消息流')).toBeInTheDocument();
    expect(screen.getByLabelText('反推上下文事件')).toBeInTheDocument();
    const entry = screen.getByLabelText('节点反推结果：Bottle reference reverse result');
    expect(entry).toHaveTextContent('反推结果已加入上下文');
    expect(entry).not.toHaveTextContent('Frosted glass bottle, low-angle studio light.');

    fireEvent.click(within(entry).getByRole('button', { name: '查看反推内容' }));
    expect(entry).toHaveTextContent('Frosted glass bottle, low-angle studio light.');
  });

  it('uses a route sheet and project-safe skill library instead of exposing unrelated routes', () => {
    renderWorkbench({
      profiles: [
        ...profiles,
        {
          provider: 'comfly',
          modelRoute: 'chat/analysis',
          modelId: 'analysis-chat',
          displayName: 'Analysis chat',
          capabilities: ['chat'],
        },
      ],
    });
    fireEvent.click(screen.getByRole('tab', { name: '对话' }));

    fireEvent.click(screen.getByRole('button', { name: '打开聊天模型菜单' }));
    const routeSheet = screen.getByRole('dialog', { name: '选择聊天模型' });
    expect(routeSheet).toHaveTextContent('Creative chat');
    expect(routeSheet).toHaveTextContent('Analysis chat');
    expect(routeSheet).not.toHaveTextContent('Image only');

    fireEvent.click(screen.getByRole('button', { name: '使用 Analysis chat' }));
    expect(screen.getByRole('button', { name: '打开聊天模型菜单' })).toHaveAttribute('data-selected-model', 'Analysis chat');

    fireEvent.click(screen.getByRole('button', { name: '打开知识库' }));
    const library = screen.getByRole('dialog', { name: '选择知识库' });
    expect(library).toHaveTextContent('场景 Skill');
    expect(library).toHaveTextContent('memory-style');
    expect(library).not.toHaveTextContent('Image only');
  });

  it('starts the knowledge-library picker with no selected context and toggles a chosen base', () => {
    renderWorkbench();

    fireEvent.click(screen.getByRole('button', { name: '打开知识库' }));
    const library = screen.getByRole('dialog', { name: '选择知识库' });
    const productCopy = within(library).getByText('场景 Skill').closest('button');

    expect(productCopy).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(productCopy!);
    expect(productCopy).toHaveAttribute('aria-pressed', 'true');
  });

  it('renders a highlighted media reference mention chip while preserving the managed image request', async () => {
    const chat = vi.fn(async () => ({
      message: 'The bottle has a soft studio highlight.',
      modelRoute: 'chat/vision',
      sources: [],
    }));
    renderWorkbench({
      profiles: [{
        provider: 'comfly',
        modelRoute: 'chat/vision',
        modelId: 'codex-vision-chat',
        displayName: 'Vision chat',
        capabilities: ['chat', 'vision'],
      }],
      referenceImages: [{
        assetId: 'a'.repeat(16),
        label: 'Bottle reference',
        displayUrl: 'novus-project://asset/bottle',
      }],
      chat,
    });
    fireEvent.click(screen.getByRole('tab', { name: '对话' }));

    fireEvent.change(screen.getByTestId('agent-composer-input'), { target: { value: '@' } });
    const mentionItem = screen.getByRole('menuitem', { name: 'Mention Bottle reference' });
    expect(screen.getByRole('menu', { name: 'Reference images' })).toBeVisible();
    expect(within(mentionItem).getByRole('img')).toHaveAttribute('src', 'novus-project://asset/bottle');
    expect(mentionItem).toHaveTextContent('@图片1');
    expect(screen.queryByRole('button', { name: 'Mention image' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Mention Bottle reference' }));
    expect(screen.getByTestId('agent-composer-input')).toHaveValue('@图片1');
    const presentation = screen.getByRole('textbox', { name: '向 Agent 发送消息' });
    expect(presentation).toHaveTextContent('图片1');
    expect(presentation).not.toHaveTextContent('@');
    expect(within(presentation).getByText('图片1')).toHaveAttribute('data-media-mention', 'image');

    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    await waitFor(() => expect(chat).toHaveBeenCalledWith(expect.objectContaining({
      referenceAssetIds: ['a'.repeat(16)],
    })));
    expect(screen.queryByLabelText('知识库请求: Vision chat')).not.toBeInTheDocument();
    expect(screen.getByText('The bottle has a soft studio highlight.')).toBeVisible();
  });

  it('submits ordered visual-analysis metadata and asks before drafting a workflow', async () => {
    const chat = vi.fn(async () => ({ message: '结构化反推结果', modelRoute: 'chat/vision', sources: [] }));
    const draftWorkflowFromAnalysis = vi.fn();
    renderWorkbench({
      profiles: [{ ...profiles[0]!, modelRoute: 'chat/vision', capabilities: ['chat', 'vision'] }],
      referenceImages: [
        { assetId: 'a'.repeat(16), label: '产品参考', displayUrl: 'novus-project://asset/product' },
        { assetId: 'b'.repeat(16), label: '场景参考', displayUrl: 'novus-project://asset/scene' },
      ],
      chat,
      draftWorkflowFromAnalysis,
    });

    window.dispatchEvent(new CustomEvent('novus:generated-image-to-agent', { detail: { assetId: 'a'.repeat(16) } }));
    window.dispatchEvent(new CustomEvent('novus:generated-image-to-agent', { detail: { assetId: 'b'.repeat(16) } }));
    await waitFor(() => expect(screen.getByLabelText('Selected image references')).toHaveTextContent('场景参考'));
    fireEvent.change(screen.getByTestId('agent-composer-input'), { target: { value: '@图片1 @图片2 反推图片并输出提示词' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    await waitFor(() => expect(chat).toHaveBeenCalledWith(expect.objectContaining({
      agentMode: 'codex',
      visualAnalysis: true,
      referenceAssetIds: ['a'.repeat(16), 'b'.repeat(16)],
      referenceMentions: [
        { assetId: 'a'.repeat(16), label: '产品参考', mention: '@图片1' },
        { assetId: 'b'.repeat(16), label: '场景参考', mention: '@图片2' },
      ],
    })));
    expect(await screen.findByText('是否基于本次反推生成工作流？')).toBeVisible();
    expect(draftWorkflowFromAnalysis).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '生成工作流' }));
    expect(draftWorkflowFromAnalysis).toHaveBeenCalledWith({
      analysis: '结构化反推结果',
      modelRoute: 'chat/vision',
      modelRouteDisplayName: 'Creative chat',
      references: [
        { assetId: 'a'.repeat(16), label: '产品参考', mention: '@图片1' },
        { assetId: 'b'.repeat(16), label: '场景参考', mention: '@图片2' },
      ],
    });
  });

  it('shows structured reverse variants before creating the durable workflow plan', async () => {
    const chat = vi.fn(async () => ({
      message: JSON.stringify({
        visual: { subject: '白色瓶身', environment: '浅色棚拍', material: '磨砂玻璃', lighting: '柔光', camera: '平视', depth: '浅景深', composition: '居中留白', perspective: '正面', layers: '前中后景' },
        prompts: { zh: '白色瓶身，浅色棚拍，柔光', en: 'White bottle, soft studio light', negative: ['水印'] },
        variants: [
          { id: 'faithful', name: 'faithful', change: '保留构图', prompt: 'A' },
          { id: 'balanced', name: 'balanced', change: '提升清晰度', prompt: 'B' },
          { id: 'exploratory', name: 'exploratory', change: '调整背景', prompt: 'C' },
        ],
      }),
      modelRoute: 'chat/vision',
      sources: [],
    }));
    renderWorkbench({
      profiles: [{ ...profiles[0]!, modelRoute: 'chat/vision', capabilities: ['chat', 'vision'] }],
      referenceImages: [{ assetId: 'a'.repeat(16), label: '产品参考', displayUrl: 'novus-project://asset/product' }],
      chat,
    });

    window.dispatchEvent(new CustomEvent('novus:generated-image-to-agent', { detail: { assetId: 'a'.repeat(16) } }));
    await waitFor(() => expect(screen.getByLabelText('Selected image references')).toHaveTextContent('产品参考'));
    fireEvent.change(screen.getByTestId('agent-composer-input'), { target: { value: '@图片1 反推图片并输出提示词' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    expect(await screen.findByTestId('reverse-structure-summary')).toHaveTextContent('白色瓶身');
    expect(screen.getByTestId('reverse-variant-list')).toHaveTextContent('保留构图');
    expect(screen.getByTestId('reverse-variant-list')).toHaveTextContent('提升清晰度');
    expect(screen.getByTestId('reverse-variant-list')).toHaveTextContent('调整背景');
  });

  it('sends an ordered referenced reverse request to visual chat instead of requiring a selected reverse node', async () => {
    const chat = vi.fn(async () => ({ message: '结构化反推结果', modelRoute: 'chat/vision', sources: [] }));
    renderWorkbench({
      profiles: [{ ...profiles[0]!, modelRoute: 'chat/vision', capabilities: ['chat', 'vision'] }],
      referenceImages: [{ assetId: 'a'.repeat(16), label: '产品参考', displayUrl: 'novus-project://asset/product' }],
      canvasActionTargets: [],
      executeCanvasAction: vi.fn(async () => true),
      chat,
    });

    fireEvent.change(screen.getByTestId('agent-composer-input'), { target: { value: '@' } });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Mention 产品参考' }));
    fireEvent.change(screen.getByTestId('agent-composer-input'), { target: { value: '@图片1 反推这张图并输出中文和英文提示词' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    await waitFor(() => expect(chat).toHaveBeenCalledWith(expect.objectContaining({
      visualAnalysis: true,
      referenceAssetIds: ['a'.repeat(16)],
      referenceMentions: [{ assetId: 'a'.repeat(16), label: '产品参考', mention: '@图片1' }],
    })));
    expect(screen.queryByText('请先在画布中选择一个反推节点。')).not.toBeInTheDocument();
  });

  it('asks before drafting a requested Codex workflow and keeps the selected model route', async () => {
    const chat = vi.fn(async () => ({ message: '建议按输入、反推、生图和输出依次连接。', modelRoute: 'openai/gpt-5.6-sol', sources: [] }));
    const draftWorkflowFromAnalysis = vi.fn();
    renderWorkbench({
      profiles: [{ provider: 'comfly', modelRoute: 'openai/gpt-5.6-sol', modelId: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', capabilities: ['responses'] }],
      chat,
      draftWorkflowFromAnalysis,
    });

    fireEvent.change(screen.getByTestId('agent-composer-input'), { target: { value: '为产品图创建一个反推后生图的工作流' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    expect(await screen.findByText('是否基于本次方案生成工作流？')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '生成工作流' }));
    expect(draftWorkflowFromAnalysis).toHaveBeenCalledWith({
      analysis: '建议按输入、反推、生图和输出依次连接。',
      references: [],
      modelRoute: 'openai/gpt-5.6-sol',
      modelRouteDisplayName: 'GPT-5.6 Sol',
    });
  });

  it('renders the twentieth Agent image reference as a highlighted 图片20 mention chip', () => {
    const referenceImages = Array.from({ length: 20 }, (_, index) => ({
      assetId: `asset-${index + 1}`,
      label: `Image ${index + 1}`,
      displayUrl: `novus-project://asset/${index + 1}`,
    }));
    renderWorkbench({
      profiles: [{ ...profiles[0]!, capabilities: ['chat', 'vision'] }],
      referenceImages,
    });

    fireEvent.change(screen.getByTestId('agent-composer-input'), { target: { value: '@' } });

    fireEvent.click(screen.getByRole('menuitem', { name: 'Mention Image 20' }));
    expect(screen.getByTestId('agent-composer-input')).toHaveValue('@图片20');
    const presentation = screen.getByRole('textbox', { name: '向 Agent 发送消息' });
    expect(within(presentation).getByText('图片20')).toHaveAttribute('data-media-mention', 'image');
    expect(presentation).not.toHaveTextContent('@');
  });

  it('explains why @ images cannot be used on a text-only chat route without sending a request', () => {
    const chat = vi.fn(async () => ({ message: 'unused', modelRoute: 'chat/creative', sources: [] }));
    renderWorkbench({
      referenceImages: [{
        assetId: 'a'.repeat(16),
        label: 'Bottle reference',
        displayUrl: 'novus-project://asset/bottle',
      }],
      chat,
    });
    fireEvent.click(screen.getByRole('tab', { name: '对话' }));

    fireEvent.change(screen.getByTestId('agent-composer-input'), { target: { value: '@' } });

    expect(screen.getByRole('alert')).toHaveTextContent('当前模型不支持图片引用');
    expect(screen.queryByRole('menu', { name: 'Reference images' })).not.toBeInTheDocument();
    expect(chat).not.toHaveBeenCalled();
  });
});

  it('keeps both approved knowledge bases visible before sync but does not send unavailable ids', async () => {
    const chat = vi.fn(async () => ({ message: 'done', modelRoute: 'chat/creative', sources: [] }));
    renderWorkbench({ knowledgeBases: [], chat });

    fireEvent.click(screen.getByRole('button', { name: '\u6253\u5f00\u77e5\u8bc6\u5e93' }));
    const library = screen.getByRole('dialog', { name: '\u9009\u62e9\u77e5\u8bc6\u5e93' });
    const sceneSkill = within(library).getByText('\u573a\u666f Skill').closest('button')!;
    const ecommerceKnowledge = within(library).getByText('\u7535\u5546\u8be6\u60c5\u9875\u77e5\u8bc6\u5e93').closest('button')!;
    expect(sceneSkill).toBeEnabled();
    expect(ecommerceKnowledge).toBeEnabled();
    expect(sceneSkill).toHaveTextContent('\u5c1a\u672a\u540c\u6b65');
    fireEvent.click(sceneSkill);
    fireEvent.click(ecommerceKnowledge);
    fireEvent.change(screen.getByRole('textbox', { name: '\u5411 Agent \u53d1\u9001\u6d88\u606f' }), { target: { value: 'analyze' } });
    fireEvent.click(screen.getByRole('button', { name: '\u53d1\u9001' }));

    await waitFor(() => expect(chat).toHaveBeenCalledWith(expect.objectContaining({
      context: expect.objectContaining({ knowledgeBaseIds: [] }),
    })));
    expect(JSON.stringify(chat.mock.calls)).not.toMatch(/activeContentHash|displayName|versions|status/iu);
  });

  it('imports a managed reference and immediately attaches it for a vision model', async () => {
    const onImportReferenceImage = vi.fn().mockResolvedValue({
      assetId: 'image-1', label: 'reference.png', displayUrl: 'novus-asset://image-1',
    });
    const chat = vi.fn(async () => ({ message: 'done', modelRoute: 'chat/vision', sources: [] }));
    renderWorkbench({
      profiles: [{ ...profiles[0]!, modelRoute: 'chat/vision', capabilities: ['chat', 'vision'] }],
      onImportReferenceImage,
      chat,
    });

    fireEvent.click(screen.getByRole('button', { name: '\u6dfb\u52a0\u7d20\u6750' }));
    fireEvent.change(screen.getByTestId('agent-reference-file-input'), {
      target: { files: [new File([new Uint8Array([1])], 'reference.png', { type: 'image/png' })] },
    });
    await waitFor(() => expect(onImportReferenceImage).toHaveBeenCalledOnce());
    expect(within(screen.getByLabelText('Selected image references')).getByText('@图片1')).toBeVisible();
    expect(within(screen.getByLabelText('Selected image references')).getByLabelText('Media reference slot 1')).toHaveTextContent('1');
    expect(within(screen.getByLabelText('Selected image references')).getByRole('img', { name: 'reference.png' })).toHaveAttribute('src', 'novus-asset://image-1');
    fireEvent.change(screen.getByRole('textbox', { name: '\u5411 Agent \u53d1\u9001\u6d88\u606f' }), { target: { value: 'analyze @图片1' } });
    fireEvent.click(screen.getByRole('button', { name: '\u53d1\u9001' }));

    await waitFor(() => expect(chat).toHaveBeenCalledWith(expect.objectContaining({ referenceAssetIds: ['image-1'] })));
    expect(JSON.stringify(chat.mock.calls)).not.toMatch(/novus-asset|displayUrl|base64|path/iu);
  });

  it('keeps the conversation unchanged when managed reference import is cancelled', async () => {
    const onImportReferenceImage = vi.fn().mockResolvedValue(null);
    renderWorkbench({ onImportReferenceImage });
    fireEvent.change(screen.getByRole('textbox', { name: '\u5411 Agent \u53d1\u9001\u6d88\u606f' }), { target: { value: 'keep draft' } });

    fireEvent.click(screen.getByRole('button', { name: '\u6dfb\u52a0\u7d20\u6750' }));
    fireEvent.change(screen.getByTestId('agent-reference-file-input'), {
      target: { files: [new File([new Uint8Array([1])], 'reference.png', { type: 'image/png' })] },
    });

    await waitFor(() => expect(onImportReferenceImage).toHaveBeenCalledOnce());
    expect(screen.getByRole('textbox', { name: '\u5411 Agent \u53d1\u9001\u6d88\u606f' })).toHaveValue('keep draft');
    expect(screen.queryByLabelText('Selected image references')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('keeps a text-only imported asset unselected and explains the capability error', async () => {
    const onImportReferenceImage = vi.fn().mockResolvedValue({
      assetId: 'image-2', label: 'text-only.png', displayUrl: 'novus-asset://image-2',
    });
    renderWorkbench({ onImportReferenceImage });
    fireEvent.click(screen.getByRole('tab', { name: '对话' }));

    fireEvent.click(screen.getByRole('button', { name: '\u6dfb\u52a0\u7d20\u6750' }));
    fireEvent.change(screen.getByTestId('agent-reference-file-input'), {
      target: { files: [new File([new Uint8Array([1])], 'reference.png', { type: 'image/png' })] },
    });

    await waitFor(() => expect(onImportReferenceImage).toHaveBeenCalledOnce());
    expect(screen.queryByLabelText('Selected image references')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('\u5f53\u524d\u6a21\u578b\u4e0d\u652f\u6301\u56fe\u7247\u6216\u89c6\u9891\uff0c\u8bf7\u5207\u6362\u89c6\u89c9\u6a21\u578b\u540e\u518d\u5f15\u7528');
  });

  it('imports a pasted video and renders a highlighted 视频1 mention chip for a vision model', async () => {
    const onImportReferenceVideo = vi.fn().mockResolvedValue({
      assetId: 'video-1', label: 'clip.mp4', displayUrl: 'blob:video-1',
    });
    renderWorkbench({
      profiles: [{ ...profiles[0]!, modelRoute: 'chat/vision', capabilities: ['chat', 'vision'] }],
      onImportReferenceVideo,
    });

    fireEvent.paste(screen.getByTestId('agent-composer-input'), {
      clipboardData: {
        files: [new File([new Uint8Array([0])], 'clip.mp4', { type: 'video/mp4' })],
        getData: () => '',
      },
    });

    await waitFor(() => expect(onImportReferenceVideo).toHaveBeenCalledOnce());
    expect(onImportReferenceVideo).toHaveBeenCalledWith(expect.objectContaining({ name: 'clip.mp4', type: 'video/mp4' }));
    expect(screen.getByLabelText('clip.mp4 video thumbnail')).toBeVisible();
    expect(within(screen.getByLabelText('Selected image references')).getByText('@视频1')).toBeVisible();
    expect(screen.getByTestId('agent-composer-input')).toHaveValue('@视频1');
    const presentation = screen.getByRole('textbox', { name: '向 Agent 发送消息' });
    expect(within(presentation).getByText('视频1')).toHaveAttribute('data-media-mention', 'video');
    expect(presentation).not.toHaveTextContent('@');
    expect(within(screen.getByLabelText('Selected image references')).getByLabelText('Media reference slot 1')).toHaveTextContent('1');
    const css = readFileSync('apps/renderer/src/styles/figma-hybrid-canvas.css', 'utf8');
    expect(css).toMatch(/skill-chat-workbench__image-tags[^{]*video[^{]*\{[^}]*object-fit:\s*contain/isu);
  });
  it('imports a clipboard image exposed through DataTransfer items when files is empty', async () => {
    const pastedImage = new File([new Uint8Array([1, 2, 3])], 'clipboard.png', { type: 'image/png' });
    const onImportReferenceImage = vi.fn().mockResolvedValue({
      assetId: 'clipboard-image-1', label: 'clipboard.png', displayUrl: 'novus-asset://clipboard-image-1',
    });
    renderWorkbench({
      profiles: [{ provider: 'comfly', modelRoute: 'codex-vision', modelId: 'codex-vision', displayName: 'Codex Vision', capabilities: ['responses', 'vision'] }],
      onImportReferenceImage,
    });

    fireEvent.paste(screen.getByTestId('agent-composer-input'), {
      clipboardData: {
        files: [],
        items: [{ kind: 'file', type: 'image/png', getAsFile: () => pastedImage }],
        getData: () => '',
      },
    });

    await waitFor(() => expect(onImportReferenceImage).toHaveBeenCalledWith(pastedImage));
    expect(screen.getByTestId('agent-composer-input')).toHaveValue('@图片1');
    expect(within(screen.getByLabelText('Selected image references')).getByRole('img', { name: 'clipboard.png' })).toBeVisible();
  });
  it('keeps text-only paste behavior', () => {
    renderWorkbench();
    const composer = screen.getByTestId('agent-composer-input');
    fireEvent.paste(composer, {
      clipboardData: { files: [], items: [], getData: (type: string) => type === 'text/plain' ? '保留原生粘贴' : '' },
    });

    expect(composer).toHaveValue('保留原生粘贴');
  });

  it('keeps a media-only non-vision selection unchanged while reporting the capability error', async () => {
    const image = new File(['one'], 'media-only.png', { type: 'image/png' });
    const onImportReferenceImage = vi.fn().mockResolvedValue({ assetId: 'blocked-image', label: 'media-only.png', displayUrl: 'novus-asset://blocked-image' });
    const initialConversation = { ...createAgentConversation(2), mode: 'chat' as const, modelRoute: 'chat/creative' };
    writeAgentConversationCollection('project-a', {
      version: 2,
      activeConversationId: initialConversation.id,
      conversations: [initialConversation],
    });
    renderWorkbench({ onImportReferenceImage });
    const composer = screen.getByTestId('agent-composer-input');
    fireEvent.change(composer, { target: { value: 'before selected after' } });
    const range = document.createRange();
    range.setStart(composer.firstChild!, 7);
    range.setEnd(composer.firstChild!, 15);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    fireEvent.paste(composer, {
      clipboardData: { files: [image], items: [], getData: () => '' },
    });

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('当前模型不支持图片或视频'));
    expect(onImportReferenceImage).not.toHaveBeenCalled();
    expect(composer).toHaveValue('before selected after');
    expect(window.getSelection()?.toString()).toBe('selected');
  });

  it('removes a pasted marker from a rejected send retry and from the next bridge request', async () => {
    const image = new File(['one'], 'retry-pending.png', { type: 'image/png' });
    const onImportReferenceImage = vi.fn(() => new Promise<{ assetId: string; label: string; displayUrl: string }>(() => undefined));
    const chat = vi.fn()
      .mockRejectedValueOnce(new Error('retry'))
      .mockResolvedValueOnce({ message: 'ok', modelRoute: 'chat/vision', sources: [] });
    renderWorkbench({
      profiles: [{ ...profiles[0]!, modelRoute: 'chat/vision', capabilities: ['chat', 'vision'] }],
      onImportReferenceImage,
      chat,
    });
    const composer = screen.getByTestId('agent-composer-input');
    fireEvent.paste(composer, {
      clipboardData: { files: [image], items: [], getData: (type: string) => type === 'text/plain' ? 'retry text' : '' },
    });
    await waitFor(() => expect(onImportReferenceImage).toHaveBeenCalledWith(image));
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(composer).toHaveValue('retry text');
    expect((composer as HTMLDivElement & { value: string }).value).not.toMatch(/[\u2063\u2064\u200B\u200C]/u);

    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(chat).toHaveBeenCalledTimes(2));
    const secondRequest = chat.mock.calls[1]![0];
    expect(secondRequest.messages.at(-1)?.content).toBe('retry text');
    expect(secondRequest.messages.at(-1)?.content).not.toMatch(/[\u2063\u2064\u200B\u200C]/u);
  });

  it('disables marker-only sends and clears the invalidated pending batch on submit', async () => {
    const image = new File(['one'], 'marker-only.png', { type: 'image/png' });
    const onImportReferenceImage = vi.fn(() => new Promise<{ assetId: string; label: string; displayUrl: string }>(() => undefined));
    renderWorkbench({
      profiles: [{ ...profiles[0]!, modelRoute: 'chat/vision', capabilities: ['chat', 'vision'] }],
      onImportReferenceImage,
    });
    const composer = screen.getByTestId('agent-composer-input');
    fireEvent.paste(composer, {
      clipboardData: { files: [image], items: [], getData: () => '' },
    });
    await waitFor(() => expect(onImportReferenceImage).toHaveBeenCalledWith(image));

    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled();
    fireEvent.submit(composer.closest('form')!);
    await waitFor(() => expect(composer).toHaveValue(''));
    expect(screen.getByRole('button', { name: '添加素材' })).toBeEnabled();
  });

  it('does not let an old-generation manual import attach to a new conversation', async () => {
    const image = new File(['one'], 'manual-pending.png', { type: 'image/png' });
    let resolveImport: ((value: { assetId: string; label: string; displayUrl: string }) => void) | undefined;
    const onImportReferenceImage = vi.fn(() => new Promise<{ assetId: string; label: string; displayUrl: string }>((resolve) => { resolveImport = resolve; }));
    renderWorkbench({
      profiles: [{ ...profiles[0]!, modelRoute: 'chat/vision', capabilities: ['chat', 'vision'] }],
      onImportReferenceImage,
    });

    fireEvent.click(screen.getByRole('button', { name: '添加素材' }));
    fireEvent.change(screen.getByTestId('agent-reference-file-input'), { target: { files: [image] } });
    await waitFor(() => expect(onImportReferenceImage).toHaveBeenCalledWith(image));
    fireEvent.click(screen.getByRole('button', { name: '新建对话' }));
    expect(screen.getByRole('button', { name: '添加素材' })).toBeEnabled();
    fireEvent.change(screen.getByTestId('agent-composer-input'), { target: { value: 'fresh draft' } });

    await act(async () => resolveImport?.({ assetId: 'manual-old', label: 'manual-pending.png', displayUrl: 'novus-asset://manual-old' }));
    expect(screen.getByTestId('agent-composer-input')).toHaveValue('fresh draft');
    expect(screen.queryByLabelText('Selected image references')).not.toBeInTheDocument();
  });

  it('removes citations when controlled HTML paste replaces their mention chip', async () => {
    const image = new File(['one'], 'chip.png', { type: 'image/png' });
    const onImportReferenceImage = vi.fn().mockResolvedValue({ assetId: 'chip-image', label: 'chip.png', displayUrl: 'novus-asset://chip-image' });
    renderWorkbench({
      profiles: [{ ...profiles[0]!, modelRoute: 'chat/vision', capabilities: ['chat', 'vision'] }],
      onImportReferenceImage,
    });
    const composer = screen.getByTestId('agent-composer-input');
    fireEvent.change(screen.getByTestId('agent-reference-file-input'), { target: { files: [image] } });
    await waitFor(() => expect(composer).toHaveValue('@图片1'));
    const chip = composer.querySelector('[data-token]')!;
    const range = document.createRange();
    range.selectNode(chip);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    fireEvent.paste(composer, {
      clipboardData: { files: [], items: [], getData: (type: string) => type === 'text/html' ? '<p>replacement</p>' : '' },
    });

    await waitFor(() => expect(composer).toHaveValue('replacement'));
    expect(screen.queryByLabelText('Selected image references')).not.toBeInTheDocument();
  });

  it('removes selected 图片1 while preserving 图片10 citation and send mapping', async () => {
    const references = Array.from({ length: 10 }, (_, index) => ({
      assetId: `asset-${index + 1}`,
      label: `Reference ${index + 1}`,
      displayUrl: `novus-asset://asset-${index + 1}`,
    }));
    const chat = vi.fn(async (_request: SkillChatRequest) => ({ message: 'ok', modelRoute: 'chat/vision', sources: [] }));
    renderWorkbench({
      profiles: [{ ...profiles[0]!, modelRoute: 'chat/vision', capabilities: ['chat', 'vision'] }],
      referenceImages: references,
      chat,
    });
    for (const reference of references) {
      window.dispatchEvent(new CustomEvent('novus:generated-image-to-agent', { detail: { assetId: reference.assetId } }));
    }
    const composer = screen.getByTestId('agent-composer-input');
    await waitFor(() => expect(composer).toHaveValue('@图片1 @图片2 @图片3 @图片4 @图片5 @图片6 @图片7 @图片8 @图片9 @图片10'));
    const chip1 = composer.querySelector('[data-token="@图片1"]')!;
    const range = document.createRange();
    range.selectNode(chip1);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    fireEvent.paste(composer, {
      clipboardData: { files: [], items: [], getData: (type: string) => type === 'text/html' ? '<span></span>' : '' },
    });

    await waitFor(() => expect((composer as HTMLDivElement & { value: string }).value).toContain('@图片10'));
    const controlledValue = (composer as HTMLDivElement & { value: string }).value;
    expect(controlledValue).not.toMatch(/@图片1(?!\d)/u);
    expect(controlledValue).toContain('@图片10');
    const tags = screen.getByLabelText('Selected image references');
    expect(within(tags).queryByRole('button', { name: 'Remove Reference 1 media reference' })).not.toBeInTheDocument();
    expect(within(tags).getByRole('button', { name: 'Remove Reference 10 media reference' })).toHaveTextContent('@图片10');

    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(chat).toHaveBeenCalledOnce());
    const request = chat.mock.calls[0]![0];
    expect(request.referenceAssetIds).not.toContain('asset-1');
    expect(request.referenceAssetIds).toContain('asset-10');
    expect(request.referenceMentions).toContainEqual({ assetId: 'asset-10', label: 'Reference 10', mention: '@图片10' });
  });

  it('keeps a refreshed pasted A at slot one and sends its canonical asset identity', async () => {
    const refreshedA = new File(['a2'], 'a-refreshed.png', { type: 'image/png' });
    const onImportReferenceImage = vi.fn().mockResolvedValue({ assetId: 'asset-a', label: 'A refreshed', displayUrl: 'novus-asset://a2' });
    const chat = vi.fn(async (_request: SkillChatRequest) => ({ message: 'ok', modelRoute: 'chat/vision', sources: [] }));
    renderWorkbench({
      profiles: [{ ...profiles[0]!, modelRoute: 'chat/vision', capabilities: ['chat', 'vision'] }],
      referenceImages: [
        { assetId: 'asset-a', label: 'A', displayUrl: 'novus-asset://a' },
        { assetId: 'asset-b', label: 'B', displayUrl: 'novus-asset://b' },
      ],
      onImportReferenceImage,
      chat,
    });
    const composer = screen.getByTestId('agent-composer-input');
    fireEvent.paste(composer, {
      clipboardData: { files: [refreshedA], items: [], getData: (type: string) => type === 'text/plain' ? 'inspect' : '' },
    });

    await waitFor(() => expect(composer).toHaveValue('inspect @图片1'));
    expect(within(screen.getByLabelText('Selected image references')).getByRole('button', { name: 'Remove A refreshed media reference' })).toHaveTextContent('@图片1');
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(chat).toHaveBeenCalledOnce());
    const request = chat.mock.calls[0]![0];
    expect(request.referenceAssetIds).toEqual(['asset-a']);
    expect(request.referenceMentions).toEqual([{ assetId: 'asset-a', label: 'A refreshed', mention: '@图片1' }]);
  });

  it('inserts parsed html-only text at a real contenteditable selection and restores the caret', async () => {
    renderWorkbench();
    const composer = screen.getByTestId('agent-composer-input');
    fireEvent.change(composer, { target: { value: 'left right' } });
    const range = document.createRange();
    range.setStart(composer.firstChild!, 5);
    range.collapse(true);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    fireEvent.paste(composer, {
      clipboardData: {
        files: [],
        items: [],
        getData: (type: string) => type === 'text/html' ? '<p>first</p><div>second<br>third</div>' : '',
      },
    });

    await waitFor(() => expect(composer).toHaveValue('left first\nsecond\nthirdright'));
    expect(composer).not.toHaveTextContent('<p>');
    await waitFor(() => {
      const caretRange = window.getSelection()!.getRangeAt(0);
      const beforeCaret = document.createRange();
      beforeCaret.selectNodeContents(composer);
      beforeCaret.setEnd(caretRange.endContainer, caretRange.endOffset);
      expect(beforeCaret.toString()).toBe('left first\nsecond\nthird');
    });
  });

  it('keeps imported reference assets and citations in their original slots when a later import refreshes A', async () => {
    const files = [
      new File(['a'], 'a.png', { type: 'image/png' }),
      new File(['b'], 'b.png', { type: 'image/png' }),
      new File(['a2'], 'a-refreshed.png', { type: 'image/png' }),
    ];
    const onImportReferenceImage = vi.fn()
      .mockResolvedValueOnce({ assetId: 'asset-a', label: 'A', displayUrl: 'novus-asset://a' })
      .mockResolvedValueOnce({ assetId: 'asset-b', label: 'B', displayUrl: 'novus-asset://b' })
      .mockResolvedValueOnce({ assetId: 'asset-a', label: 'A refreshed', displayUrl: 'novus-asset://a2' });
    renderWorkbench({
      profiles: [{ ...profiles[0]!, modelRoute: 'chat/vision', capabilities: ['chat', 'vision'] }],
      onImportReferenceImage,
    });
    const input = screen.getByTestId('agent-reference-file-input');
    for (const file of files) {
      fireEvent.change(input, { target: { files: [file] } });
      await waitFor(() => expect(onImportReferenceImage).toHaveBeenCalledWith(file));
    }

    await waitFor(() => expect(screen.getByTestId('agent-composer-input')).toHaveValue('@图片1 @图片2'));
    const tags = screen.getByLabelText('Selected image references');
    expect(within(tags).getByRole('button', { name: 'Remove A refreshed media reference' })).toHaveTextContent('@图片1');
    expect(within(tags).getByRole('button', { name: 'Remove B media reference' })).toHaveTextContent('@图片2');
  });

  it('chooses native, controlled, rejected, and import paste paths from clipboard state', () => {
    expect(resolveClipboardPasteAction({ hasPlainText: true, parsedText: 'plain', hasMedia: false, supportsMedia: true })).toBe('native-text');
    expect(resolveClipboardPasteAction({ hasPlainText: false, parsedText: 'html', hasMedia: false, supportsMedia: true })).toBe('controlled-text');
    expect(resolveClipboardPasteAction({ hasPlainText: false, parsedText: '', hasMedia: false, supportsMedia: true })).toBe('ignore');
    expect(resolveClipboardPasteAction({ hasPlainText: false, parsedText: '', hasMedia: true, supportsMedia: false })).toBe('reject-media');
    expect(resolveClipboardPasteAction({ hasPlainText: true, parsedText: 'mixed', hasMedia: true, supportsMedia: true })).toBe('import-media');
  });

  it('keeps readable text and reports the existing capability error for a mixed paste on an initial text-only model', async () => {
    const image = new File(['one'], 'blocked.png', { type: 'image/png' });
    const video = new File(['two'], 'blocked.mp4', { type: 'video/mp4' });
    const onImportReferenceImage = vi.fn().mockResolvedValue({ assetId: 'blocked-image', label: 'blocked.png', displayUrl: 'novus-asset://blocked-image' });
    const onImportReferenceVideo = vi.fn().mockResolvedValue({ assetId: 'blocked-video', label: 'blocked.mp4', displayUrl: 'novus-asset://blocked-video' });
    const chat = vi.fn(async (_request: SkillChatRequest) => ({ message: 'sent', modelRoute: 'chat/creative', sources: [] }));
    const initialConversation = { ...createAgentConversation(1), mode: 'chat' as const, modelRoute: 'chat/creative' };
    writeAgentConversationCollection('project-a', {
      version: 2,
      activeConversationId: initialConversation.id,
      conversations: [initialConversation],
    });
    renderWorkbench({ onImportReferenceImage, onImportReferenceVideo, chat });
    const composer = screen.getByTestId('agent-composer-input');

    fireEvent.paste(composer, {
      clipboardData: {
        files: [image, video],
        items: [],
        getData: (type: string) => type === 'text/plain' ? '可读正文' : '',
      },
    });

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('当前模型不支持图片或视频'));
    expect(onImportReferenceImage).not.toHaveBeenCalled();
    expect(onImportReferenceVideo).not.toHaveBeenCalled();
    expect(composer).toHaveValue('可读正文');
    expect((composer as HTMLDivElement & { value: string }).value).not.toMatch(/[\u2063\u2064\u200B\u200C]/u);

    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(chat).toHaveBeenCalledOnce());
    const request = chat.mock.calls[0]![0];
    const sentMessage = request.messages[request.messages.length - 1];
    expect(sentMessage?.content).toBe('可读正文');
    expect(sentMessage?.content).not.toMatch(/[\u2063\u2064\u200B\u200C]/u);
  });

  it('pastes mixed multiline text at the caret and imports clipboard media in order', async () => {
    const image = new File(['one'], 'one.png', { type: 'image/png' });
    const video = new File(['two'], 'two.mp4', { type: 'video/mp4' });
    const onImportReferenceImage = vi.fn().mockResolvedValue({
      assetId: 'managed-image', label: 'one.png', displayUrl: 'novus-asset://managed-image',
    });
    const onImportReferenceVideo = vi.fn().mockResolvedValue({
      assetId: 'managed-video', label: 'two.mp4', displayUrl: 'novus-asset://managed-video',
    });
    renderWorkbench({
      profiles: [{ ...profiles[0]!, modelRoute: 'chat/vision', capabilities: ['chat', 'vision'] }],
      onImportReferenceImage,
      onImportReferenceVideo,
    });
    const composer = screen.getByTestId('agent-composer-input');
    fireEvent.change(composer, { target: { value: '前缀 后缀' } });
    const textNode = composer.firstChild!;
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.setStart(textNode, 3);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);

    fireEvent.paste(composer, {
      clipboardData: {
        files: [image, video],
        items: [],
        getData: (type: string) => type === 'text/plain' ? '第一行\n第二行' : '',
      },
    });

    await waitFor(() => expect(onImportReferenceVideo).toHaveBeenCalledWith(video));
    expect(onImportReferenceImage).toHaveBeenCalledWith(image);
    expect(onImportReferenceImage.mock.invocationCallOrder[0]).toBeLessThan(onImportReferenceVideo.mock.invocationCallOrder[0]!);
    expect(composer).toHaveValue('前缀 第一行\n第二行 @图片1 @视频1 后缀');
  });

  it('imports every supported items-only clipboard file in item order', async () => {
    const image = new File(['one'], 'items-one.png', { type: 'image/png' });
    const video = new File(['two'], 'items-two.mp4', { type: 'video/mp4' });
    const onImportReferenceImage = vi.fn().mockResolvedValue({
      assetId: 'items-image', label: 'items-one.png', displayUrl: 'novus-asset://items-image',
    });
    const onImportReferenceVideo = vi.fn().mockResolvedValue({
      assetId: 'items-video', label: 'items-two.mp4', displayUrl: 'novus-asset://items-video',
    });
    renderWorkbench({
      profiles: [{ ...profiles[0]!, modelRoute: 'chat/vision', capabilities: ['chat', 'vision'] }],
      onImportReferenceImage,
      onImportReferenceVideo,
    });

    fireEvent.paste(screen.getByTestId('agent-composer-input'), {
      clipboardData: {
        files: [],
        items: [
          { kind: 'file', type: image.type, getAsFile: () => image },
          { kind: 'file', type: video.type, getAsFile: () => video },
        ],
        getData: () => '',
      },
    });

    await waitFor(() => expect(onImportReferenceVideo).toHaveBeenCalledWith(video));
    expect(onImportReferenceImage).toHaveBeenCalledWith(image);
    expect(onImportReferenceImage.mock.invocationCallOrder[0]).toBeLessThan(onImportReferenceVideo.mock.invocationCallOrder[0]!);
    expect(screen.getByTestId('agent-composer-input')).toHaveValue('@图片1 @视频1');
  });

  it('keeps successful pasted references and reports a later failure without stopping the remaining imports', async () => {
    const firstImage = new File(['one'], 'first.png', { type: 'image/png' });
    const failingVideo = new File(['two'], 'failed.mp4', { type: 'video/mp4' });
    const lastImage = new File(['three'], 'last.png', { type: 'image/png' });
    const onImportReferenceImage = vi.fn()
      .mockResolvedValueOnce({ assetId: 'first-image', label: 'first.png', displayUrl: 'novus-asset://first-image' })
      .mockResolvedValueOnce({ assetId: 'last-image', label: 'last.png', displayUrl: 'novus-asset://last-image' });
    const onImportReferenceVideo = vi.fn().mockRejectedValue(new Error('manage failed'));
    renderWorkbench({
      profiles: [{ ...profiles[0]!, modelRoute: 'chat/vision', capabilities: ['chat', 'vision'] }],
      onImportReferenceImage,
      onImportReferenceVideo,
    });

    fireEvent.paste(screen.getByTestId('agent-composer-input'), {
      clipboardData: { files: [firstImage, failingVideo, lastImage], items: [], getData: () => '' },
    });

    await waitFor(() => expect(onImportReferenceImage).toHaveBeenLastCalledWith(lastImage));
    expect(onImportReferenceVideo).toHaveBeenCalledWith(failingVideo);
    expect(screen.getByRole('alert')).toHaveTextContent('素材导入失败');
    expect(screen.getByTestId('agent-composer-input')).toHaveValue('@图片1 @图片2');
  });

  it('does not overwrite text typed while pasted media is importing', async () => {
    const image = new File(['one'], 'slow.png', { type: 'image/png' });
    let resolveImport: ((value: { assetId: string; label: string; displayUrl: string }) => void) | undefined;
    const onImportReferenceImage = vi.fn(() => new Promise<{ assetId: string; label: string; displayUrl: string }>((resolve) => {
      resolveImport = resolve;
    }));
    renderWorkbench({
      profiles: [{ ...profiles[0]!, modelRoute: 'chat/vision', capabilities: ['chat', 'vision'] }],
      onImportReferenceImage,
    });
    const composer = screen.getByTestId('agent-composer-input');

    fireEvent.paste(composer, {
      clipboardData: { files: [image], items: [], getData: (type: string) => type === 'text/plain' ? '粘贴文字' : '' },
    });
    fireEvent.change(composer, { target: { value: '粘贴文字后续输入' } });
    await waitFor(() => expect(onImportReferenceImage).toHaveBeenCalledWith(image));
    await act(async () => resolveImport?.({ assetId: 'slow-image', label: 'slow.png', displayUrl: 'novus-asset://slow-image' }));

    await waitFor(() => expect(composer).toHaveValue('粘贴文字后续输入 @图片1'));
  });

  it('serializes overlapping paste batches without mixing their references', async () => {
    const first = new File(['one'], 'first.png', { type: 'image/png' });
    const second = new File(['two'], 'second.mp4', { type: 'video/mp4' });
    let resolveFirst: ((value: { assetId: string; label: string; displayUrl: string }) => void) | undefined;
    let resolveSecond: ((value: { assetId: string; label: string; displayUrl: string }) => void) | undefined;
    const onImportReferenceImage = vi.fn(() => new Promise<{ assetId: string; label: string; displayUrl: string }>((resolve) => { resolveFirst = resolve; }));
    const onImportReferenceVideo = vi.fn(() => new Promise<{ assetId: string; label: string; displayUrl: string }>((resolve) => { resolveSecond = resolve; }));
    renderWorkbench({
      profiles: [{ ...profiles[0]!, modelRoute: 'chat/vision', capabilities: ['chat', 'vision'] }],
      onImportReferenceImage,
      onImportReferenceVideo,
    });
    const composer = screen.getByTestId('agent-composer-input');

    fireEvent.paste(composer, { clipboardData: { files: [first], items: [], getData: () => '' } });
    fireEvent.paste(composer, { clipboardData: { files: [second], items: [], getData: () => '' } });
    await waitFor(() => expect(onImportReferenceImage).toHaveBeenCalledOnce());
    expect(onImportReferenceVideo).not.toHaveBeenCalled();

    await act(async () => resolveFirst?.({ assetId: 'first-image', label: 'first.png', displayUrl: 'novus-asset://first-image' }));
    await waitFor(() => expect(onImportReferenceVideo).toHaveBeenCalledWith(second));
    await act(async () => resolveSecond?.({ assetId: 'second-video', label: 'second.mp4', displayUrl: 'novus-asset://second-video' }));

    await waitFor(() => expect(composer).toHaveValue('@图片1 @视频1'));
  });

  it('keeps same-kind overlapping batches in import order while restoring each marker at its own reverse text position', async () => {
    const first = new File(['one'], 'first.png', { type: 'image/png' });
    const second = new File(['two'], 'second.png', { type: 'image/png' });
    let resolveFirst: ((value: { assetId: string; label: string; displayUrl: string }) => void) | undefined;
    const onImportReferenceImage = vi.fn()
      .mockImplementationOnce(() => new Promise<{ assetId: string; label: string; displayUrl: string }>((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce({ assetId: 'second-image', label: 'second.png', displayUrl: 'novus-asset://second-image' });
    renderWorkbench({
      profiles: [{ ...profiles[0]!, modelRoute: 'chat/vision', capabilities: ['chat', 'vision'] }],
      onImportReferenceImage,
    });
    const composer = screen.getByTestId('agent-composer-input');
    fireEvent.change(composer, { target: { value: 'left right' } });
    const firstRange = document.createRange();
    firstRange.setStart(composer.firstChild!, 5);
    firstRange.collapse(true);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(firstRange);
    fireEvent.paste(composer, {
      clipboardData: { files: [first], items: [], getData: (type: string) => type === 'text/plain' ? 'A' : '' },
    });
    await waitFor(() => expect(onImportReferenceImage).toHaveBeenCalledWith(first));

    const secondRange = document.createRange();
    secondRange.setStart(composer.firstChild!, 0);
    secondRange.collapse(true);
    selection.removeAllRanges();
    selection.addRange(secondRange);
    fireEvent.paste(composer, {
      clipboardData: { files: [second], items: [], getData: (type: string) => type === 'text/plain' ? 'B' : '' },
    });
    expect(onImportReferenceImage).toHaveBeenCalledOnce();

    await act(async () => resolveFirst?.({ assetId: 'first-image', label: 'first.png', displayUrl: 'novus-asset://first-image' }));
    await waitFor(() => expect(onImportReferenceImage).toHaveBeenLastCalledWith(second));
    await waitFor(() => expect(composer).toHaveValue('B @图片2 left A @图片1 right'));
  });

  it('starts a new-generation paste without waiting for an invalidated pending batch', async () => {
    const oldImage = new File(['one'], 'old-pending.png', { type: 'image/png' });
    const freshImage = new File(['two'], 'fresh-generation.png', { type: 'image/png' });
    let resolveOld: ((value: { assetId: string; label: string; displayUrl: string }) => void) | undefined;
    const onImportReferenceImage = vi.fn((file?: File) => file?.name === oldImage.name
      ? new Promise<{ assetId: string; label: string; displayUrl: string }>((resolve) => { resolveOld = resolve; })
      : Promise.resolve({ assetId: 'fresh-generation', label: 'fresh-generation.png', displayUrl: 'novus-asset://fresh-generation' }));
    renderWorkbench({
      profiles: [{ ...profiles[0]!, modelRoute: 'chat/vision', capabilities: ['chat', 'vision'] }],
      onImportReferenceImage,
    });

    fireEvent.paste(screen.getByTestId('agent-composer-input'), {
      clipboardData: { files: [oldImage], items: [], getData: () => '' },
    });
    await waitFor(() => expect(onImportReferenceImage).toHaveBeenCalledWith(oldImage));
    fireEvent.click(screen.getByRole('button', { name: '新建任务' }));
    fireEvent.paste(screen.getByTestId('agent-composer-input'), {
      clipboardData: { files: [freshImage], items: [], getData: () => '' },
    });

    await waitFor(() => expect(onImportReferenceImage).toHaveBeenCalledWith(freshImage));
    await waitFor(() => expect(screen.getByTestId('agent-composer-input')).toHaveValue('@图片1'));
    expect(screen.getByRole('button', { name: '添加素材' })).toBeEnabled();
    await act(async () => resolveOld?.({ assetId: 'old-pending', label: 'old-pending.png', displayUrl: 'novus-asset://old-pending' }));
    expect(screen.getByTestId('agent-composer-input')).toHaveValue('@图片1');
  });

  it('cancels a pending paste before a new conversation can receive its reference', async () => {
    const image = new File(['one'], 'pending.png', { type: 'image/png' });
    let resolveImport: ((value: { assetId: string; label: string; displayUrl: string }) => void) | undefined;
    const onImportReferenceImage = vi.fn(() => new Promise<{ assetId: string; label: string; displayUrl: string }>((resolve) => { resolveImport = resolve; }));
    renderWorkbench({
      profiles: [{ ...profiles[0]!, modelRoute: 'chat/vision', capabilities: ['chat', 'vision'] }],
      onImportReferenceImage,
    });

    fireEvent.paste(screen.getByTestId('agent-composer-input'), {
      clipboardData: { files: [image], items: [], getData: (type: string) => type === 'text/plain' ? 'pending' : '' },
    });
    fireEvent.click(screen.getByRole('button', { name: '新建任务' }));
    await act(async () => resolveImport?.({ assetId: 'pending-image', label: 'pending.png', displayUrl: 'novus-asset://pending-image' }));

    await waitFor(() => expect(screen.getByTestId('agent-composer-input')).toHaveValue(''));
    expect(screen.queryByLabelText('Selected image references')).not.toBeInTheDocument();
  });

  it('uses canonical slots when a pasted import returns an existing asset id', async () => {
    const duplicate = new File(['one'], 'existing.png', { type: 'image/png' });
    const fresh = new File(['two'], 'fresh.png', { type: 'image/png' });
    const onImportReferenceImage = vi.fn()
      .mockResolvedValueOnce({ assetId: 'existing-asset', label: 'existing.png', displayUrl: 'novus-asset://existing' })
      .mockResolvedValueOnce({ assetId: 'fresh-asset', label: 'fresh.png', displayUrl: 'novus-asset://fresh' });
    renderWorkbench({
      profiles: [{ ...profiles[0]!, modelRoute: 'chat/vision', capabilities: ['chat', 'vision'] }],
      referenceImages: [{ assetId: 'existing-asset', label: 'existing.png', displayUrl: 'novus-asset://existing' }],
      onImportReferenceImage,
    });

    fireEvent.paste(screen.getByTestId('agent-composer-input'), {
      clipboardData: { files: [duplicate, fresh], items: [], getData: () => '' },
    });

    await waitFor(() => expect(onImportReferenceImage).toHaveBeenLastCalledWith(fresh));
    expect(screen.getByTestId('agent-composer-input')).toHaveValue('@图片1 @图片2');
  });

  it('preserves block boundaries when pasting at a contenteditable range', async () => {
    const image = new File(['one'], 'block.png', { type: 'image/png' });
    const onImportReferenceImage = vi.fn().mockResolvedValue({
      assetId: 'block-image', label: 'block.png', displayUrl: 'novus-asset://block-image',
    });
    renderWorkbench({
      profiles: [{ ...profiles[0]!, modelRoute: 'chat/vision', capabilities: ['chat', 'vision'] }],
      onImportReferenceImage,
    });
    const composer = screen.getByTestId('agent-composer-input');
    fireEvent.change(composer, { target: { value: 'one\ntwo' } });
    composer.innerHTML = '<div>one</div><p>two</p>';
    const secondLine = composer.querySelector('p')!.firstChild!;
    const range = document.createRange();
    range.setStart(secondLine, 3);
    range.collapse(true);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    fireEvent.paste(composer, {
      clipboardData: { files: [image], items: [], getData: (type: string) => type === 'text/plain' ? 'X' : '' },
    });

    await waitFor(() => expect(onImportReferenceImage).toHaveBeenCalledWith(image));
    expect(composer).toHaveValue('one\ntwoX @图片1');
  });

  it('places the contenteditable caret after pasted text before pending media references', async () => {
    const image = new File(['one'], 'caret.png', { type: 'image/png' });
    const onImportReferenceImage = vi.fn().mockResolvedValue({
      assetId: 'caret-image', label: 'caret.png', displayUrl: 'novus-asset://caret-image',
    });
    renderWorkbench({
      profiles: [{ ...profiles[0]!, modelRoute: 'chat/vision', capabilities: ['chat', 'vision'] }],
      onImportReferenceImage,
    });
    const composer = screen.getByTestId('agent-composer-input');
    fireEvent.change(composer, { target: { value: 'abcd' } });
    const range = document.createRange();
    range.setStart(composer.firstChild!, 2);
    range.collapse(true);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    fireEvent.paste(composer, {
      clipboardData: { files: [image], items: [], getData: (type: string) => type === 'text/plain' ? 'X' : '' },
    });

    await waitFor(() => expect(onImportReferenceImage).toHaveBeenCalledWith(image));
    await waitFor(() => {
      const caretRange = window.getSelection()!.getRangeAt(0);
      const beforeCaret = document.createRange();
      beforeCaret.selectNodeContents(composer);
      beforeCaret.setEnd(caretRange.endContainer, caretRange.endOffset);
      expect(beforeCaret.toString()).toBe('abX');
    });
  });

  it('cancels a pending paste before sending and never sends its private marker', async () => {
    const image = new File(['one'], 'send-pending.png', { type: 'image/png' });
    let resolveImport: ((value: { assetId: string; label: string; displayUrl: string }) => void) | undefined;
    const onImportReferenceImage = vi.fn(() => new Promise<{ assetId: string; label: string; displayUrl: string }>((resolve) => { resolveImport = resolve; }));
    const chat = vi.fn(async () => ({ message: 'sent', modelRoute: 'chat/vision', sources: [] }));
    renderWorkbench({
      profiles: [{ ...profiles[0]!, modelRoute: 'chat/vision', capabilities: ['chat', 'vision'] }],
      onImportReferenceImage,
      chat,
    });

    fireEvent.paste(screen.getByTestId('agent-composer-input'), {
      clipboardData: { files: [image], items: [], getData: (type: string) => type === 'text/plain' ? 'send pending' : '' },
    });
    await waitFor(() => expect(onImportReferenceImage).toHaveBeenCalledWith(image));
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(chat).toHaveBeenCalledWith(expect.objectContaining({
      messages: expect.arrayContaining([expect.objectContaining({ content: 'send pending' })]),
    })));
    await act(async () => resolveImport?.({ assetId: 'send-pending', label: 'send-pending.png', displayUrl: 'novus-asset://send-pending' }));

    expect(screen.queryByLabelText('Selected image references')).not.toBeInTheDocument();
  });

  it('cancels a pending paste when switching to a non-vision model', async () => {
    const image = new File(['one'], 'switch-pending.png', { type: 'image/png' });
    let resolveImport: ((value: { assetId: string; label: string; displayUrl: string }) => void) | undefined;
    const onImportReferenceImage = vi.fn(() => new Promise<{ assetId: string; label: string; displayUrl: string }>((resolve) => { resolveImport = resolve; }));
    renderWorkbench({
      profiles: [
        { ...profiles[0]!, modelRoute: 'chat/vision', displayName: 'Vision chat', capabilities: ['chat', 'vision'] },
        profiles[0]!,
      ],
      onImportReferenceImage,
    });

    fireEvent.paste(screen.getByTestId('agent-composer-input'), {
      clipboardData: { files: [image], items: [], getData: () => '' },
    });
    await waitFor(() => expect(onImportReferenceImage).toHaveBeenCalledWith(image));
    fireEvent.click(screen.getByTestId('agent-model-trigger'));
    fireEvent.click(screen.getByRole('button', { name: '使用 Creative chat' }));
    await act(async () => resolveImport?.({ assetId: 'switch-pending', label: 'switch-pending.png', displayUrl: 'novus-asset://switch-pending' }));

    expect(screen.getByTestId('agent-composer-input')).toHaveValue('');
    expect(screen.queryByLabelText('Selected image references')).not.toBeInTheDocument();
  });

  it('does not update an unmounted composer after a pending paste resolves', async () => {
    const image = new File(['one'], 'unmount-pending.png', { type: 'image/png' });
    let resolveImport: ((value: { assetId: string; label: string; displayUrl: string }) => void) | undefined;
    const onImportReferenceImage = vi.fn(() => new Promise<{ assetId: string; label: string; displayUrl: string }>((resolve) => { resolveImport = resolve; }));
    const view = renderWorkbench({
      profiles: [{ ...profiles[0]!, modelRoute: 'chat/vision', capabilities: ['chat', 'vision'] }],
      onImportReferenceImage,
    });

    fireEvent.paste(screen.getByTestId('agent-composer-input'), {
      clipboardData: { files: [image], items: [], getData: () => '' },
    });
    await waitFor(() => expect(onImportReferenceImage).toHaveBeenCalledWith(image));
    view.unmount();
    await expect(act(async () => resolveImport?.({ assetId: 'unmounted', label: 'unmount-pending.png', displayUrl: 'novus-asset://unmounted' }))).resolves.toBeUndefined();
  });

  it('replaces a noncollapsed contenteditable range spanning media chips', async () => {
    const image = new File(['one'], 'replace.png', { type: 'image/png' });
    const onImportReferenceImage = vi.fn().mockResolvedValue({
      assetId: 'replace-image', label: 'replace.png', displayUrl: 'novus-asset://replace-image',
    });
    renderWorkbench({
      profiles: [{ ...profiles[0]!, modelRoute: 'chat/vision', capabilities: ['chat', 'vision'] }],
      referenceImages: [
        { assetId: 'existing-one', label: 'existing-one.png', displayUrl: 'novus-asset://existing-one' },
        { assetId: 'existing-two', label: 'existing-two.png', displayUrl: 'novus-asset://existing-two' },
      ],
      onImportReferenceImage,
    });
    const composer = screen.getByTestId('agent-composer-input');
    fireEvent.change(composer, { target: { value: 'left @图片1 @图片2 right' } });
    const chips = composer.querySelectorAll('[data-token]');
    const range = document.createRange();
    range.setStartBefore(chips[0]!);
    range.setEndAfter(chips[1]!);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    fireEvent.paste(composer, {
      clipboardData: { files: [image], items: [], getData: (type: string) => type === 'text/plain' ? 'X' : '' },
    });

    await waitFor(() => expect(onImportReferenceImage).toHaveBeenCalledWith(image));
    expect(composer).toHaveValue('left X @图片3 right');
  });

  it('shows a controlled error when managed reference import fails', async () => {
    const onImportReferenceImage = vi.fn().mockRejectedValue(new Error('C:\\private\\reference.png'));
    renderWorkbench({ onImportReferenceImage });

    fireEvent.click(screen.getByRole('button', { name: '\u6dfb\u52a0\u7d20\u6750' }));
    fireEvent.change(screen.getByTestId('agent-reference-file-input'), {
      target: { files: [new File([new Uint8Array([1])], 'reference.png', { type: 'image/png' })] },
    });

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('\u7d20\u6750\u5bfc\u5165\u5931\u8d25\uff0c\u8bf7\u91cd\u8bd5\u3002'));
    expect(screen.getByRole('alert')).not.toHaveTextContent('private');
  });

it('shows no media warning initially and clears it after switching to a vision model', () => {
  renderWorkbench({
    profiles: [
      profiles[0]!,
      {
        provider: 'comfly',
        modelRoute: 'chat/vision',
        modelId: 'vision-chat',
        displayName: 'Vision chat',
        capabilities: ['chat', 'vision'],
      },
    ],
    referenceImages: [{ assetId: 'asset-vision-1', label: 'Reference one', displayUrl: 'novus-asset://asset-vision-1' }],
  });
  fireEvent.click(screen.getByRole('tab', { name: '对话' }));

  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  fireEvent.change(screen.getByTestId('agent-composer-input'), { target: { value: '@' } });
  expect(screen.getByRole('alert')).toHaveTextContent('当前模型不支持图片引用');

  fireEvent.click(screen.getByTestId('agent-model-trigger'));
  fireEvent.click(screen.getByRole('button', { name: '使用 Vision chat' }));

  expect(screen.queryByText(/当前模型不支持图片引用/u)).not.toBeInTheDocument();
});
it('keeps only one transient composer popover open and closes it on send', async () => {
  const chat = vi.fn(async () => ({ message: 'done', modelRoute: 'chat/vision', sources: [] }));
  renderWorkbench({
    profiles: [{ ...profiles[0]!, modelRoute: 'chat/vision', capabilities: ['chat', 'vision'] }],
    referenceImages: [{ assetId: 'asset-1', label: 'Reference one', displayUrl: 'novus-asset://asset-1' }],
    chat,
  });

  fireEvent.click(screen.getByTestId('knowledge-base-trigger'));
  expect(screen.getAllByRole('dialog')).toHaveLength(1);
  fireEvent.click(screen.getByTestId('agent-model-trigger'));
  expect(screen.queryByRole('dialog', { name: '选择知识库' })).not.toBeInTheDocument();
  expect(screen.getAllByRole('dialog')).toHaveLength(1);

  fireEvent.change(screen.getByTestId('agent-composer-input'), { target: { value: '@' } });
  expect(screen.queryByRole('dialog', { name: '选择聊天模型' })).not.toBeInTheDocument();
  expect(screen.getByRole('menu', { name: 'Reference images' })).toBeVisible();

  fireEvent.change(screen.getByTestId('agent-composer-input'), { target: { value: 'send this' } });
  fireEvent.click(screen.getByRole('button', { name: '发送' }));
  await waitFor(() => expect(chat).toHaveBeenCalledOnce());
  expect(screen.queryByRole('menu', { name: 'Reference images' })).not.toBeInTheDocument();
});
it('closes the transient composer popover on outside click and Escape', () => {
  renderWorkbench();
  fireEvent.click(screen.getByTestId('knowledge-base-trigger'));
  expect(screen.getByRole('dialog', { name: '选择知识库' })).toBeVisible();
  fireEvent.pointerDown(document.body);
  expect(screen.queryByRole('dialog', { name: '选择知识库' })).not.toBeInTheDocument();

  fireEvent.click(screen.getByTestId('agent-model-trigger'));
  expect(screen.getByRole('dialog', { name: '选择聊天模型' })).toBeVisible();
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(screen.queryByRole('dialog', { name: '选择聊天模型' })).not.toBeInTheDocument();
});
it('shows one selectable chat route for the same visible model name without exposing provider names', () => {
  renderWorkbench({
    profiles: [
      { provider: 'comfly', modelRoute: 'comfly-shared-chat', modelId: 'shared-chat', displayName: 'Shared Chat', capabilities: ['chat'] },
      { provider: 'relayme', modelRoute: 'relayme-shared-chat', modelId: 'shared-chat', displayName: 'Shared Chat', capabilities: ['chat'] },
    ],
  });
  fireEvent.click(screen.getByRole('tab', { name: '对话' }));

  fireEvent.click(screen.getByTestId('agent-model-trigger'));
  const dialog = screen.getByRole('dialog', { name: '选择聊天模型' });
  expect(within(dialog).getAllByText('Shared Chat')).toHaveLength(1);
  expect(dialog).not.toHaveTextContent('Comfly');
  expect(dialog).not.toHaveTextContent('RelayMe');
});
it('shows only model names for unique chat models', () => {
  renderWorkbench({
    profiles: [
      { provider: 'comfly', modelRoute: 'creative-chat', modelId: 'creative-chat', displayName: 'Creative Skill', capabilities: ['chat'] },
      { provider: 'relayme', modelRoute: 'relay-chat', modelId: 'relay-chat', displayName: 'Relay Chat', capabilities: ['chat'] },
    ],
  });
  fireEvent.click(screen.getByRole('tab', { name: '对话' }));

  fireEvent.click(screen.getByTestId('agent-model-trigger'));
  const dialog = screen.getByRole('dialog', { name: '选择聊天模型' });
  expect(within(dialog).getByText('Creative Skill')).toBeVisible();
  expect(within(dialog).getByText('Relay Chat')).toBeVisible();
  expect(dialog).not.toHaveTextContent('Comfly');
  expect(dialog).not.toHaveTextContent('RelayMe');
});

it('requires confirmation before an Agent image command executes a canvas node', async () => {
  const executeCanvasAction = vi.fn(async () => true);
  const chat = vi.fn(async () => ({ message: 'unused', modelRoute: 'chat/creative', sources: [] }));
  renderWorkbench({
    chat,
    canvasActionTargets: [{ kind: 'image_generation', nodeId: 'image-node-1', label: 'Image node 1', selected: true }],
    executeCanvasAction,
  } as never);

  fireEvent.change(screen.getByTestId('agent-composer-input'), { target: { value: '生成一张产品主图' } });
  fireEvent.submit(screen.getByTestId('agent-composer-input').closest('form')!);

  expect(screen.getByRole('button', { name: '确认执行生图' })).toBeVisible();
  expect(executeCanvasAction).not.toHaveBeenCalled();
  expect(chat).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole('button', { name: '确认执行生图' }));
  await waitFor(() => expect(executeCanvasAction).toHaveBeenCalledWith({
    kind: 'image_generation', nodeId: 'image-node-1', prompt: '生成一张产品主图',
  }));
});

it.each([
  ['生成一个8秒产品视频', 'video_generation', 'video-node-1', '确认执行视频生成'],
  ['反推当前参考图的提示词', 'reverse_agent', 'reverse-node-1', '确认执行反推'],
] as const)('routes %s to the matching confirmed canvas action', async (command, kind, nodeId, confirmLabel) => {
  const executeCanvasAction = vi.fn(async () => true);
  renderWorkbench({
    canvasActionTargets: [{ kind, nodeId, label: nodeId, selected: true }],
    executeCanvasAction,
  } as never);

  fireEvent.change(screen.getByTestId('agent-composer-input'), { target: { value: command } });
  fireEvent.submit(screen.getByTestId('agent-composer-input').closest('form')!);
  expect(executeCanvasAction).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: confirmLabel }));

  await waitFor(() => expect(executeCanvasAction).toHaveBeenCalledWith({ kind, nodeId, prompt: command }));
});
