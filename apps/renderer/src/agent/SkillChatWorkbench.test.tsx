import { readFileSync } from 'node:fs';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatSkillBridgeRequestSchema, CODEX_ASTRA_PROFILE, type ChatSkillBridgeResult, type ProviderBridgeProfile } from '@agent-canvas/desktop-core';
import type { KnowledgeBaseStateSummary } from '@agent-canvas/skill-store';
import { codexAnalysisDelayHint, resolveAgentRequestTimeoutMs, resolveClipboardPasteAction, SkillChatWorkbench, type SkillCanvasActionRequest, type SkillChatRequest } from './SkillChatWorkbench';
import { queueGeneratedImageForAgent } from './generated-image-agent-transfer';
import { createAgentConversation, writeAgentConversationCollection } from './skill-chat-session-store';

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
  window.localStorage.clear();
  delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  delete (HTMLElement.prototype as { scrollTo?: unknown }).scrollTo;
  vi.useRealTimers();
});

function projectMention(label: string) {
  const browse = screen.queryByRole('button', { name: '浏览项目图片' });
  if (browse) fireEvent.click(browse);
  return screen.getByRole('menuitem', { name: 'Mention ' + label });
}

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
    constraints: { image: { resolutions: ['1K', '2K', '4K'] } },
  },
];

const catalogAstraProfile = {
  ...CODEX_ASTRA_PROFILE,
  supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const,
  defaultReasoningEffort: 'low' as const,
};

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
  const projectId = overrides.projectId ?? 'project-a';
  const hasStoredConversation = window.localStorage.getItem(`agent-canvas:skill-chat:v2:${projectId}`) !== null;
  const view = render(workbench(overrides));
  // Provider conversation tests explicitly enter their provider mode. Tests of
  // the default Codex surface supply codexProfiles (including an empty catalog).
  if (overrides.codexProfiles === undefined && !hasStoredConversation) {
    fireEvent.click(screen.getByRole('tab', { name: '对话' }));
  }
  return view;
}

function canonicalCaretOffset(editor: HTMLElement): number {
  const selection = window.getSelection();
  const focusNode = selection?.focusNode;
  const focusOffset = selection?.focusOffset ?? 0;
  if (focusNode === null || focusNode === undefined) return -1;

  let offset = 0;
  const visit = (node: Node): boolean => {
    if (node === focusNode) {
      if (node.nodeType === Node.TEXT_NODE) offset += focusOffset;
      else {
        for (let index = 0; index < focusOffset; index += 1) {
          const child = node.childNodes[index];
          if (child !== undefined) offset += canonicalNodeLength(child);
        }
      }
      return true;
    }
    if (node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).dataset.token !== undefined) {
      offset += ((node as HTMLElement).dataset.token ?? '').length;
      return false;
    }
    if (node.nodeType === Node.TEXT_NODE) {
      offset += node.textContent?.length ?? 0;
      return false;
    }
    for (const child of Array.from(node.childNodes)) {
      if (visit(child)) return true;
    }
    return false;
  };

  visit(editor);
  return offset;
}

function canonicalNodeLength(node: Node): number {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent?.length ?? 0;
  if (node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).dataset.token !== undefined) {
    return ((node as HTMLElement).dataset.token ?? '').length;
  }
  return Array.from(node.childNodes).reduce((length, child) => length + canonicalNodeLength(child), 0);
}

describe('SkillChatWorkbench', () => {
  it('explains when Max or Ultra reasoning is the reason an analysis is taking longer', () => {
    expect(codexAnalysisDelayHint('max', 59)).toBeNull();
    expect(codexAnalysisDelayHint('max', 60)).toContain('Max 深度推理耗时较长');
    expect(codexAnalysisDelayHint('ultra', 120)).toContain('切换到“高”或“中”');
    expect(codexAnalysisDelayHint('high', 120)).toBeNull();
  });
  it('scales Codex timeout with the selected reasoning effort instead of giving every request ten minutes', () => {
    expect(resolveAgentRequestTimeoutMs('codex', 'low', false)).toBe(90_000);
    expect(resolveAgentRequestTimeoutMs('codex', 'medium', false)).toBe(150_000);
    expect(resolveAgentRequestTimeoutMs('codex', 'high', true)).toBe(240_000);
    expect(resolveAgentRequestTimeoutMs('codex', 'max', false)).toBe(480_000);
    expect(resolveAgentRequestTimeoutMs('codex', 'ultra', false)).toBe(600_000);
    expect(resolveAgentRequestTimeoutMs('comfly', 'high', true)).toBe(315_000);
  });
  it('shows model-declared reasoning in chat and creative Agent while keeping each mode independent', async () => {
    const chat = vi.fn(async () => ({ message: '完成', modelRoute: 'chat/reasoning', sources: [] }));
    const reasoningProfile: ProviderBridgeProfile = {
      provider: 'comfly', modelRoute: 'chat/reasoning', modelId: 'reasoning-chat', displayName: 'Reasoning chat', capabilities: ['chat'],
      reasoning: { efforts: ['low', 'medium', 'high'], defaultEffort: 'medium', protocol: 'system_instruction' },
    };
    renderWorkbench({ profiles: [reasoningProfile], chat });

    fireEvent.click(await screen.findByRole('button', { name: '思考能力：中' }));
    fireEvent.change(screen.getByRole('slider', { name: '思考能力' }), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('tab', { name: '创作 Agent' }));
    expect(screen.getByRole('button', { name: '思考能力：中' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '思考能力：中' }));
    fireEvent.change(screen.getByRole('slider', { name: '思考能力' }), { target: { value: '2' } });
    fireEvent.change(screen.getByTestId('agent-composer-input'), { target: { value: '生成可执行工作流方案' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(chat).toHaveBeenCalledWith(expect.objectContaining({ agentMode: 'original', reasoningEffort: 'high' })));
    fireEvent.click(screen.getByRole('tab', { name: '对话' }));
    expect(screen.getByRole('button', { name: '思考能力：轻度' })).toBeVisible();
    fireEvent.change(screen.getByTestId('agent-composer-input'), { target: { value: '检查方案' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(chat).toHaveBeenCalledWith(expect.objectContaining({ agentMode: 'chat', reasoningEffort: 'low' })));
  });

  it('sends a separately selected reverse-analysis depth without changing model reasoning', async () => {
    const chat = vi.fn(async () => ({ message: '完成', modelRoute: 'chat/vision', sources: [] }));
    const visualProfile: ProviderBridgeProfile = {
      provider: 'comfly', modelRoute: 'chat/vision', modelId: 'vision-chat', displayName: 'Vision chat', capabilities: ['chat', 'vision'],
      reasoning: { efforts: ['low', 'medium', 'high'], defaultEffort: 'medium', protocol: 'system_instruction' },
    };
    renderWorkbench({
      profiles: [visualProfile], chat,
      referenceImages: [{ assetId: 'a'.repeat(16), label: '产品参考', displayUrl: 'novus-project://asset/product' }],
    });
    window.dispatchEvent(new CustomEvent('novus:generated-image-to-agent', { detail: { assetId: 'a'.repeat(16) } }));
    await waitFor(() => expect(screen.getByLabelText('Selected image references')).toHaveTextContent('产品参考'));
    expect(screen.getByRole('group', { name: '反推强度' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '深度反推' }));
    fireEvent.change(screen.getByTestId('agent-composer-input'), { target: { value: '@图片1 分析当前构图' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(chat).toHaveBeenCalledWith(expect.objectContaining({
      reasoningEffort: 'medium', reverseAnalysisDepth: 'deep',
    })));
  });

  it('uses each local model reasoning catalog including ultra without offering unsupported levels', async () => {
    const localProfile = { ...CODEX_ASTRA_PROFILE, supportedReasoningEfforts: ['low', 'ultra'] as const, defaultReasoningEffort: 'low' as const };
    renderWorkbench({ profiles: [], codexProfiles: [localProfile] });
    fireEvent.click(await screen.findByRole('button', { name: '思考能力：轻度' }));
    const effort = screen.getByRole('slider', { name: '思考能力' });
    expect(effort).toHaveValue('0');
    expect(effort).toHaveAttribute('max', '1');
    fireEvent.change(effort, { target: { value: '1' } });
    expect(effort).toHaveAttribute('aria-valuetext', 'Ultra');
    fireEvent.click(screen.getByRole('button', { name: '恢复默认思考能力' }));
    expect(effort).toHaveAttribute('aria-valuetext', '轻度');
  });

  it('does not invent reasoning levels when the local catalog omits them', async () => {
    renderWorkbench({ profiles: [], codexProfiles: [CODEX_ASTRA_PROFILE] });

    expect(await screen.findByRole('button', { name: '思考能力：不可用' })).toBeDisabled();
    expect(screen.queryByRole('slider', { name: '思考能力' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByTestId('agent-composer-input'), { target: { value: '读取画布' } });
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled();
  });

  it('maps the five reference slider stops to exact request efforts and restores the saved selection', async () => {
    const chat = vi.fn(async () => ({ message: '已读取', modelRoute: 'codex/gpt-5.6-sol', sources: [] }));
    const localProfile = { ...CODEX_ASTRA_PROFILE, modelId: 'gpt-5.6-sol', modelRoute: 'codex/gpt-5.6-sol' as const, displayName: 'GPT-5.6 Sol', supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'ultra'] as const, defaultReasoningEffort: 'medium' as const };
    const view = renderWorkbench({ profiles: [], codexProfiles: [localProfile], chat });
    await screen.findByRole('button', { name: '思考能力：中' });
    for (const [index, label, effort] of [[0, '轻度', 'low'], [1, '中', 'medium'], [2, '高', 'high'], [3, '极高', 'xhigh'], [4, 'Ultra', 'ultra']] as const) {
      fireEvent.click(screen.getByRole('button', { name: /^思考能力：/ }));
      const slider = screen.getByRole('slider', { name: '思考能力' });
      expect(slider).toHaveAttribute('max', '4');
      fireEvent.change(slider, { target: { value: String(index) } });
      expect(slider).toHaveAttribute('aria-valuetext', label);
      fireEvent.change(screen.getByTestId('agent-composer-input'), { target: { value: `检查 ${label}` } });
      fireEvent.click(screen.getByRole('button', { name: '发送' }));
      await waitFor(() => expect(chat).toHaveBeenLastCalledWith(expect.objectContaining({ reasoningEffort: effort, modelRoute: localProfile.modelRoute })));
      await waitFor(() => expect(screen.getByRole('button', { name: '发送' })).toBeDisabled());
    }
    view.unmount();
    renderWorkbench({ profiles: [], codexProfiles: [localProfile], chat });
    expect(await screen.findByRole('button', { name: '思考能力：Ultra' })).toBeVisible();
  });

  it('keeps the reasoning popup interactive and mutually exclusive with other menus', async () => {
    renderWorkbench({ codexProfiles: [catalogAstraProfile] });
    const trigger = await screen.findByRole('button', { name: '思考能力：中' });
    fireEvent.click(trigger);
    const slider = screen.getByRole('slider', { name: '思考能力' });
    fireEvent.pointerDown(slider);
    expect(screen.getByRole('dialog', { name: '思考能力设置' })).toBeVisible();
    fireEvent.keyDown(slider, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: '思考能力设置' })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    fireEvent.click(trigger);
    fireEvent.click(screen.getByTestId('agent-model-trigger'));
    expect(screen.queryByRole('dialog', { name: '思考能力设置' })).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: '选择聊天模型' })).toBeVisible();
    fireEvent.click(trigger);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('dialog', { name: '思考能力设置' })).not.toBeInTheDocument();
  });

  it('discards a late creative response when the mode changes', async () => {
    let resolveChat!: (result: ChatSkillBridgeResult) => void;
    const chat = vi.fn(() => new Promise<ChatSkillBridgeResult>((resolve) => { resolveChat = resolve; }));
    renderWorkbench({ chat });
    fireEvent.click(screen.getByRole('tab', { name: '创作 Agent' }));
    fireEvent.change(screen.getByTestId('agent-composer-input'), { target: { value: '图片方案' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    fireEvent.click(screen.getByRole('tab', { name: '对话' }));
    await act(async () => resolveChat({ message: '过期方案', modelRoute: 'chat/creative', sources: [] }));
    expect(screen.queryByText('过期方案')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Agent 正在分析')).not.toBeInTheDocument();
  });
  it('asks the chat model for choices before any creative execution and keeps generation preferences separate', async () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView });
    const executeCanvasAction = vi.fn(async () => true);
    const chat = vi.fn(async () => ({ message: JSON.stringify({
      summary: '保留产品比例，选择构图',
      requirements: {
        goal: '生成一张产品主图',
        mustKeep: ['产品比例与 Logo'],
        mustChange: ['改为简洁棚拍构图'],
        mustAvoid: ['不要改变产品颜色'],
        acceptanceCriteria: ['产品完整清晰，实际返图尺寸符合所选清晰度'],
      },
      observations: ['产品居中'], estimates: [], unknowns: [],
      options: [{ id: 'clean', title: '简洁棚拍', reason: '突出产品', kind: 'image', prompt: '产品居中构图，保持产品比例与 Logo，柔和棚灯突出材质，纯净浅色背景，高清商业摄影。', modelRoute: 'image/only' }],
    }), modelRoute: 'chat/creative', sources: [] }));
    const canvasActionTargets = [{ kind: 'image_generation' as const, nodeId: 'image-node', label: '图片节点', selected: true }];
    const view = renderWorkbench({ chat, executeCanvasAction, canvasActionTargets });
    fireEvent.click(screen.getByRole('tab', { name: '创作 Agent' }));
    fireEvent.click(screen.getByRole('button', { name: '生成偏好' }));
    expect(screen.getByRole('dialog', { name: '生成偏好' })).toBeVisible();
    fireEvent.change(screen.getByLabelText('生成模型选择方式'), { target: { value: 'fixed' } });
    expect(screen.getByTestId('agent-model-trigger')).toHaveAttribute('data-selected-model', 'Creative chat');
    fireEvent.click(screen.getByRole('button', { name: '关闭生成偏好' }));
    fireEvent.change(screen.getByTestId('agent-composer-input'), { target: { value: '生成一张产品主图' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(executeCanvasAction).not.toHaveBeenCalled();
    await waitFor(() => expect(chat).toHaveBeenCalledOnce());
    expect(chat).toHaveBeenCalledWith(expect.objectContaining({
      messages: expect.arrayContaining([expect.objectContaining({
        content: expect.stringContaining('每条要求必须落实到完整提示词或 workflow'),
      })]),
    }));
    const option = await screen.findByRole('button', { name: '选择方案：简洁棚拍' });
    expect(option.closest('article')).toHaveClass('skill-chat-workbench__message--creative-plan');
    expect(screen.getByLabelText('需求分析')).toHaveTextContent('产品比例与 Logo');
    expect(screen.getByLabelText('需求分析')).toHaveTextContent('不要改变产品颜色');
    expect(screen.getByLabelText('需求分析')).toHaveTextContent('实际返图尺寸符合所选清晰度');
    expect(option.closest('.creative-plan__option')).toHaveTextContent('工作流预览');
    expect(option.closest('.creative-plan__option')).toHaveTextContent('整理需求与素材');
    expect(option.closest('.creative-plan__option')).toHaveTextContent('执行图片生成');
    expect(option.closest('.creative-plan__option')).toHaveTextContent('回写并检查结果');
    fireEvent.click(option);
    expect(option).toHaveAttribute('aria-pressed', 'true');
    expect(option).toHaveTextContent('已选择');
    expect(scrollIntoView).toHaveBeenCalledWith({ block: 'center', behavior: 'smooth' });
    expect(executeCanvasAction).not.toHaveBeenCalled();
    expect(screen.getByLabelText('待确认画布操作')).toHaveTextContent('将创建1个生图节点');
    expect(screen.getByLabelText('待确认画布操作')).toHaveTextContent('提示词与结果保留在生成节点内');
    const claritySelect = screen.getByRole('combobox', { name: '选择生图清晰度' });
    expect(claritySelect).toHaveValue('');
    fireEvent.change(claritySelect, { target: { value: '4K' } });
    expect(screen.getByLabelText('待确认画布操作')).toHaveClass('skill-chat-workbench__confirmation');
    fireEvent.click(screen.getByRole('button', { name: '确认执行生图' }));
    await waitFor(() => expect(executeCanvasAction).toHaveBeenCalledWith(expect.objectContaining({
      createNode: true,
      createWorkflow: true,
      nodeId: expect.stringMatching(/^agent-image-/u),
      modelRoute: 'image/only',
      prompt: '产品居中构图，保持产品比例与 Logo，柔和棚灯突出材质，纯净浅色背景，高清商业摄影。',
      parameters: expect.objectContaining({ resolution: '4K' }),
    })));
    const actionCall = (executeCanvasAction.mock.calls as unknown as Array<[SkillCanvasActionRequest]>)[0]!;
    expect(actionCall[0].nodeId).not.toBe('image-node');

    const createdNodeId = actionCall[0].nodeId;
    view.rerender(workbench({
      chat,
      executeCanvasAction,
      canvasActionTargets,
      canvasActionResults: [{ nodeId: createdNodeId, status: 'completed', assetIds: [] }],
    }));
    expect(await screen.findByLabelText('生成执行进度')).toHaveTextContent('结果已生成，但尚未回写画布');
  });

  it('shows the selected image or video workflow type in the composer and sends it as a strict planning choice', async () => {
    const chat = vi.fn(async () => ({ message: JSON.stringify({
      summary: '视频方案', observations: [], estimates: [], unknowns: [],
      options: [{ id: 'video', title: '视频替代', reason: '动态展示', kind: 'video', prompt: '生成产品视频' }],
    }), modelRoute: 'chat/creative', sources: [] }));
    renderWorkbench({ profiles: [
      profiles[0]!,
      { ...profiles[1]!, modelRoute: 'image/edit', capabilities: ['image_generation', 'image_edit'] },
      { provider: 'julun', modelRoute: 'video/i2v', modelId: 'seedance-2.0-deal', displayName: 'Seedance', capabilities: ['video_generation'] },
    ], chat });
    fireEvent.click(screen.getByRole('tab', { name: '创作 Agent' }));

    expect(screen.getByRole('button', { name: '生成偏好' })).toHaveTextContent('图片工作流');
    fireEvent.change(screen.getByTestId('agent-composer-input'), { target: { value: '@图片1 精修产品，其他不要改变' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    await waitFor(() => expect(chat).toHaveBeenCalledWith(expect.objectContaining({
      messages: expect.arrayContaining([expect.objectContaining({ content: expect.stringContaining('本次已明确选择输出类型：image') })]),
    })));
    expect(await screen.findByRole('alert')).toHaveTextContent('本次已选择图片工作流');
    expect(screen.queryByRole('button', { name: '选择方案：视频替代' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '生成偏好' }));
    fireEvent.click(screen.getByRole('tab', { name: '视频' }));
    expect(screen.getByRole('button', { name: '生成偏好' })).toHaveTextContent('视频工作流');
  });

  it('blocks a creative option that only repeats the user request', async () => {
    const executeCanvasAction = vi.fn(async () => true);
    const chat = vi.fn(async () => ({
      message: JSON.stringify({
        summary: '需要先改写执行提示词',
        options: [{ id: 'copy', title: '原文方案', reason: '测试原文保护', kind: 'image', prompt: '生成一张产品主图', modelRoute: 'image/only' }],
      }),
      modelRoute: 'chat/creative',
      sources: [],
    }));
    renderWorkbench({ chat, executeCanvasAction });
    fireEvent.click(screen.getByRole('tab', { name: '创作 Agent' }));
    fireEvent.change(screen.getByTestId('agent-composer-input'), { target: { value: '生成一张产品主图' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    fireEvent.click(await screen.findByRole('button', { name: '选择方案：原文方案' }));
    expect(screen.getByRole('alert')).toHaveTextContent('没有把需求改写成生图提示词');
    expect(screen.queryByRole('button', { name: '确认执行生图' })).not.toBeInTheDocument();
    expect(executeCanvasAction).not.toHaveBeenCalled();
  });

  it('blocks a creative option that repeats the user request with the same image mention', async () => {
    const executeCanvasAction = vi.fn(async () => true);
    const chat = vi.fn(async () => ({
      message: JSON.stringify({
        summary: '需要先改写执行提示词',
        options: [{ id: 'copy', title: '带引用原文方案', reason: '测试引用原文保护', kind: 'image', prompt: '@图片1 生成一张产品主图', modelRoute: 'image/edit' }],
      }),
      modelRoute: 'chat/vision',
      sources: [],
    }));
    renderWorkbench({
      profiles: [
        { ...profiles[0]!, modelRoute: 'chat/vision', capabilities: ['chat', 'vision'] },
        { ...profiles[1]!, modelRoute: 'image/edit', capabilities: ['image_generation', 'image_edit'] },
      ],
      referenceImages: [{ assetId: 'a'.repeat(16), label: '产品参考', displayUrl: 'novus-project://asset/product' }],
      chat,
      executeCanvasAction,
    });
    window.dispatchEvent(new CustomEvent('novus:generated-image-to-agent', { detail: { assetId: 'a'.repeat(16) } }));
    await waitFor(() => expect(screen.getByLabelText('Selected image references')).toHaveTextContent('产品参考'));
    fireEvent.click(screen.getByRole('tab', { name: '创作 Agent' }));
    fireEvent.change(screen.getByTestId('agent-composer-input'), { target: { value: '@图片1 生成一张产品主图' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    fireEvent.click(await screen.findByRole('button', { name: '选择方案：带引用原文方案' }));
    expect(screen.getByRole('alert')).toHaveTextContent('仍包含 @图片 或 @视频标记');
    expect(screen.queryByRole('button', { name: '确认执行生图' })).not.toBeInTheDocument();
    expect(executeCanvasAction).not.toHaveBeenCalled();
  });

  it('blocks a creative option that wraps the original request in generic chat wording', async () => {
    const executeCanvasAction = vi.fn(async () => true);
    const chat = vi.fn(async () => ({
      message: JSON.stringify({
        summary: '模型只给原话加了套话',
        options: [{
          id: 'wrapped-copy',
          title: '套话方案',
          reason: '验证高重合保护',
          kind: 'image',
          prompt: '根据你的要求，生成一张产品主图，请执行。',
          modelRoute: 'image/only',
        }],
      }),
      modelRoute: 'chat/creative',
      sources: [],
    }));
    renderWorkbench({ chat, executeCanvasAction });
    fireEvent.click(screen.getByRole('tab', { name: '创作 Agent' }));
    fireEvent.change(screen.getByTestId('agent-composer-input'), { target: { value: '生成一张产品主图' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    fireEvent.click(await screen.findByRole('button', { name: '选择方案：套话方案' }));
    expect(screen.getByRole('alert')).toHaveTextContent('没有把需求改写成生图提示词');
    expect(screen.queryByRole('button', { name: '确认执行生图' })).not.toBeInTheDocument();
    expect(executeCanvasAction).not.toHaveBeenCalled();
  });

  it('blocks an underspecified creative prompt before creating a generation node', async () => {
    const executeCanvasAction = vi.fn(async () => true);
    const chat = vi.fn(async () => ({
      message: JSON.stringify({
        summary: '模型没有写出可执行细节',
        options: [{ id: 'thin', title: '过短方案', reason: '验证质量门禁', kind: 'image', prompt: '产品图', modelRoute: 'image/only' }],
      }),
      modelRoute: 'chat/creative',
      sources: [],
    }));
    renderWorkbench({ chat, executeCanvasAction });
    fireEvent.click(screen.getByRole('tab', { name: '创作 Agent' }));
    fireEvent.change(screen.getByTestId('agent-composer-input'), { target: { value: '为新品设计一张高级电商主图，保持品牌颜色和产品结构' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    fireEvent.click(await screen.findByRole('button', { name: '选择方案：过短方案' }));
    expect(screen.getByRole('alert')).toHaveTextContent('生图提示词过于简略');
    expect(screen.queryByRole('button', { name: '确认执行生图' })).not.toBeInTheDocument();
    expect(executeCanvasAction).not.toHaveBeenCalled();
  });

  it('keeps an empty structured creative response non-executable instead of inventing a prompt', async () => {
    const executeCanvasAction = vi.fn(async () => true);
    const chat = vi.fn(async () => ({
      message: '```json\n{"summary":"只精修产品并保持其他内容","observations":["保留背景"],"estimates":[],"unknowns":[],"options":[]}\n```',
      modelRoute: 'chat/vision',
      sources: [],
    }));
    renderWorkbench({
      profiles: [
        { ...profiles[0]!, modelRoute: 'chat/vision', capabilities: ['chat', 'vision'] },
        { ...profiles[1]!, modelRoute: 'image/edit', capabilities: ['image_generation', 'image_edit'] },
      ],
      referenceImages: [{ assetId: 'product-reference', label: '产品参考', displayUrl: 'novus-project://asset/product' }],
      chat,
      executeCanvasAction,
    });
    fireEvent.click(screen.getByRole('tab', { name: '创作 Agent' }));
    window.dispatchEvent(new CustomEvent('novus:generated-image-to-agent', { detail: { assetId: 'product-reference' } }));
    await waitFor(() => expect(screen.getByLabelText('Selected image references')).toHaveTextContent('产品参考'));
    fireEvent.change(screen.getByTestId('agent-composer-input'), { target: { value: '@图片1 把产品单独精修，其他不需要改变' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    expect(await screen.findByText('只精修产品并保持其他内容')).toBeVisible();
    expect(screen.queryByRole('button', { name: /选择方案/ })).not.toBeInTheDocument();
    expect(executeCanvasAction).not.toHaveBeenCalled();
  });

  it('sends only the active mode history after switching from chat to Codex', async () => {
    const chat = vi.fn(async (request: SkillChatRequest) => ({
      message: request.agentMode === 'codex' ? 'Codex 已检查画布' : '对话模式已分析素材',
      modelRoute: request.modelRoute,
      sources: [],
    }));
    renderWorkbench({ profiles, codexProfiles: [catalogAstraProfile], chat });
    fireEvent.click(screen.getByRole('tab', { name: '对话' }));
    fireEvent.change(screen.getByTestId('agent-composer-input'), { target: { value: '先分析这张产品图' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await screen.findByText('对话模式已分析素材');

    fireEvent.click(screen.getByRole('tab', { name: 'Codex' }));
    await waitFor(() => expect(screen.getByTestId('agent-model-trigger')).toHaveAttribute('data-selected-model', 'GPT-6 Astra'));
    fireEvent.change(screen.getByTestId('agent-composer-input'), { target: { value: '检查当前画布节点' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(chat).toHaveBeenCalledTimes(2));

    expect(chat.mock.calls[1]?.[0].messages).toEqual([{ role: 'user', content: '检查当前画布节点' }]);
  });

  it('keeps a new Agent request within the 48-message provider contract after a long conversation', async () => {
    const now = 1_725_000_000_000;
    const conversation = {
      ...createAgentConversation(now),
      mode: 'chat' as const,
      modelRoute: 'chat/creative',
      messages: Array.from({ length: 48 }, (_, index) => ({
        id: `history-${index}`,
        role: index % 2 === 0 ? 'user' as const : 'assistant' as const,
        mode: 'chat' as const,
        content: `历史消息 ${index}`,
      })),
    };
    writeAgentConversationCollection('project-a', {
      version: 2,
      activeConversationId: conversation.id,
      conversations: [conversation],
    });
    const chat = vi.fn(async (_request: SkillChatRequest) => ({ message: '继续完成', modelRoute: 'chat/creative', sources: [] }));
    renderWorkbench({ chat });

    fireEvent.change(screen.getByTestId('agent-composer-input'), { target: { value: '继续精修图片' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    await waitFor(() => expect(chat).toHaveBeenCalledOnce());
    const sentMessages = chat.mock.calls[0]![0].messages;
    expect(sentMessages).toHaveLength(48);
    expect(sentMessages[0]).toEqual({ role: 'assistant', content: '历史消息 1' });
    expect(sentMessages[sentMessages.length - 1]).toEqual({ role: 'user', content: '继续精修图片' });
  });

  it('allows a Codex request above the provider limit while keeping it inside the Codex 16000-character contract', async () => {
    const chat = vi.fn(async (_request: SkillChatRequest) => ({ message: 'Codex 已完成长上下文检查', modelRoute: catalogAstraProfile.modelRoute, sources: [] }));
    const content = `检查当前画布细节：${'构图与材质'.repeat(1_700)}`;
    expect(content.length).toBeGreaterThan(8_000);
    expect(content.length).toBeLessThan(16_000);
    renderWorkbench({ profiles: [], codexProfiles: [catalogAstraProfile], chat });

    fireEvent.change(screen.getByTestId('agent-composer-input'), { target: { value: content } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    await waitFor(() => expect(chat).toHaveBeenCalledOnce());
    const sentMessages = chat.mock.calls[0]![0].messages;
    expect(sentMessages[sentMessages.length - 1]?.content).toBe(content);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('does not let a link in an earlier model reply poison the next Agent request', async () => {
    const chat = vi.fn(async (request: SkillChatRequest) => ({
      message: request.messages[request.messages.length - 1]?.content === '第一次请求'
        ? '可以查看 https://example.com/result'
        : '第二次完成',
      modelRoute: 'chat/creative',
      sources: [],
    }));
    renderWorkbench({ chat });

    fireEvent.change(screen.getByTestId('agent-composer-input'), { target: { value: '第一次请求' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await screen.findByText('可以查看 https://example.com/result');
    fireEvent.change(screen.getByTestId('agent-composer-input'), { target: { value: '第二次请求' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    await waitFor(() => expect(chat).toHaveBeenCalledTimes(2));
    expect(chat.mock.calls[1]?.[0].messages).toEqual([
      { role: 'user', content: '第一次请求' },
      { role: 'user', content: '第二次请求' },
    ]);
  });

  it('does not allow a fixed generation preference before its model directory is available', () => {
    renderWorkbench({
      profiles: [{ ...profiles[0]!, modelRoute: 'chat/only', displayName: 'Chat only', capabilities: ['chat'] }],
    });
    fireEvent.click(screen.getByRole('button', { name: '生成偏好' }));
    expect(screen.getByRole('option', { name: '固定模型与参数' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('请先在设置中配置图片生成模型');
  });

  it('shows and forwards a persisted quality choice only for a fixed GPT image model', async () => {
    const executeCanvasAction = vi.fn(async () => true);
    const gptImage: ProviderBridgeProfile = {
      provider: 'comfly',
      modelRoute: 'image/gpt-1.5',
      modelId: 'gpt-image-1.5',
      displayName: 'GPT Image 1.5',
      capabilities: ['image_generation'],
    };
    const chat = vi.fn(async () => ({
      message: JSON.stringify({
        summary: 'GPT 生图方案',
        observations: [],
        estimates: [],
        unknowns: [],
        options: [{ id: 'gpt', title: 'GPT 高质量', reason: '保留细节', kind: 'image', prompt: '产品居中构图，保持品牌色与外观比例，柔和侧光呈现材质细节，纯净背景，高清电商主图。', modelRoute: gptImage.modelRoute }],
      }),
      modelRoute: 'chat/creative',
      sources: [],
    }));
    renderWorkbench({ profiles: [...profiles, gptImage], executeCanvasAction, chat });

    fireEvent.click(screen.getByRole('button', { name: '生成偏好' }));
    fireEvent.change(screen.getByLabelText('生成模型选择方式'), { target: { value: 'fixed' } });
    expect(screen.queryByLabelText('固定 GPT 图片质量')).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('固定生成模型'), { target: { value: gptImage.modelRoute } });
    const quality = screen.getByLabelText('固定 GPT 图片质量');
    expect(quality).toHaveValue('medium');
    fireEvent.change(quality, { target: { value: 'high' } });
    fireEvent.click(screen.getByRole('button', { name: '关闭生成偏好' }));

    expect(JSON.parse(window.localStorage.getItem('agent-canvas:generation-preferences:v1:project-a') ?? '{}'))
      .toMatchObject({ image: { parameters: { imageQuality: 'high' } } });

    fireEvent.click(screen.getByRole('tab', { name: '创作 Agent' }));
    fireEvent.change(screen.getByTestId('agent-composer-input'), { target: { value: '生成 GPT 产品主图' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    fireEvent.click(await screen.findByRole('button', { name: '选择方案：GPT 高质量' }));
    fireEvent.click(screen.getByRole('button', { name: '确认执行生图' }));

    await waitFor(() => expect(executeCanvasAction).toHaveBeenCalledWith(expect.objectContaining({
      modelRoute: gptImage.modelRoute,
      parameters: expect.objectContaining({ imageQuality: 'high' }),
    })));
  });

  it('delivers assets that arrive after a completed action was first observed without assets', async () => {
    const executeCanvasAction = vi.fn(async () => true);
    const chat = vi.fn(async () => ({
      message: JSON.stringify({ summary: '迟到返图', options: [{ id: 'late', title: '迟到返图', reason: '验证回写竞态', kind: 'image', prompt: '产品居中构图，保持品牌色与主体结构，柔和侧光突出材质，纯净背景，高清电商主图。', modelRoute: 'image/only' }] }),
      modelRoute: 'chat/creative',
      sources: [],
    }));
    const view = renderWorkbench({ chat, executeCanvasAction });
    fireEvent.click(screen.getByRole('tab', { name: '创作 Agent' }));
    fireEvent.change(screen.getByTestId('agent-composer-input'), { target: { value: '生成产品主图' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    fireEvent.click(await screen.findByRole('button', { name: '选择方案：迟到返图' }));
    fireEvent.click(screen.getByRole('button', { name: '确认执行生图' }));
    await waitFor(() => expect(executeCanvasAction).toHaveBeenCalledOnce());
    const nodeId = (executeCanvasAction.mock.calls as unknown as Array<[SkillCanvasActionRequest]>)[0]![0].nodeId;

    view.rerender(workbench({ chat, executeCanvasAction, canvasActionResults: [{ nodeId, status: 'completed', assetIds: [] }] }));
    expect(await screen.findByText('任务结束，但未收到可展示的结果。')).toBeVisible();
    view.rerender(workbench({ chat, executeCanvasAction, canvasActionResults: [{ nodeId, status: 'completed', assetIds: ['late-result'] }] }));

    expect(await screen.findByText('生成已完成，1 个结果已回写画布节点。')).toBeVisible();
    expect(screen.getAllByText('生成已完成，1 个结果已回写画布节点。')).toHaveLength(1);
  });

  it('opens and copies a generated image from the Agent result progress', async () => {
    const executeCanvasAction = vi.fn(async () => true);
    const chat = vi.fn(async () => ({
      message: JSON.stringify({
        summary: '生成结果预览',
        options: [{ id: 'preview', title: '生成结果预览', reason: '验证结果交互', kind: 'image', prompt: '产品居中构图，保持品牌色与主体结构，柔和侧光突出材质，纯净背景，高清电商主图。', modelRoute: 'image/only' }],
      }),
      modelRoute: 'chat/creative',
      sources: [],
    }));
    const writeClipboardImage = vi.fn(async (_bytes: Uint8Array) => true);
    const originalDesktop = window.novusDesktop;
    const originalFetch = globalThis.fetch;
    window.novusDesktop = { projectImages: { writeClipboardImage } } as unknown as typeof window.novusDesktop;
    globalThis.fetch = vi.fn(async () => new Response(new Blob(['image-bytes'], { type: 'image/png' }), {
      status: 200,
      headers: { 'content-type': 'image/png' },
    }));
    try {
      const view = renderWorkbench({ chat, executeCanvasAction });
      fireEvent.click(screen.getByRole('tab', { name: '创作 Agent' }));
      fireEvent.change(screen.getByTestId('agent-composer-input'), { target: { value: '生成产品主图' } });
      fireEvent.click(screen.getByRole('button', { name: '发送' }));
      fireEvent.click(await screen.findByRole('button', { name: '选择方案：生成结果预览' }));
      fireEvent.click(screen.getByRole('button', { name: '确认执行生图' }));
      await waitFor(() => expect(executeCanvasAction).toHaveBeenCalledOnce());
      const nodeId = (executeCanvasAction.mock.calls as unknown as Array<[SkillCanvasActionRequest]>)[0]![0].nodeId;
      const resultImage = { assetId: 'result-preview', label: '生成结果', displayUrl: 'novus-project://asset/result-preview' };
      view.rerender(workbench({ chat, executeCanvasAction, referenceImages: [resultImage], canvasActionResults: [{ nodeId, status: 'completed', assetIds: [resultImage.assetId] }] }));

      const resultCard = await screen.findByLabelText('生成执行进度');
      expect(resultCard.closest('article')).toHaveTextContent('生成已完成，1 个结果已回写画布节点。');
      const previewButton = await screen.findByRole('button', { name: '查看生成结果：生成结果' });
      previewButton.focus();
      fireEvent.click(previewButton);
      const dialog = screen.getByRole('dialog', { name: '生成结果预览：生成结果' });
      expect(dialog).toBeVisible();
      expect(within(dialog).getByRole('img', { name: '生成结果' })).toBeVisible();
      const closeButton = within(dialog).getByRole('button', { name: '关闭图片预览' });
      const zoomOutButton = within(dialog).getByRole('button', { name: '缩小预览' });
      const zoomInButton = within(dialog).getByRole('button', { name: '放大预览' });
      const copyButton = within(dialog).getByRole('button', { name: '复制生成图片：生成结果' });
      expect(closeButton).toHaveFocus();
      fireEvent.keyDown(closeButton, { key: 'Tab', shiftKey: true });
      expect(copyButton).toHaveFocus();
      fireEvent.keyDown(copyButton, { key: 'Tab' });
      expect(closeButton).toHaveFocus();
      expect(zoomOutButton).toBeDisabled();
      for (let index = 0; index < 12; index += 1) fireEvent.click(zoomInButton);
      expect(within(dialog).getByText('300%')).toBeVisible();
      expect(zoomInButton).toBeDisabled();
      for (let index = 0; index < 12; index += 1) fireEvent.click(zoomOutButton);
      expect(within(dialog).getByText('100%')).toBeVisible();
      expect(zoomOutButton).toBeDisabled();
      fireEvent.click(copyButton);
      await waitFor(() => expect(writeClipboardImage).toHaveBeenCalledOnce());
      fireEvent.keyDown(closeButton, { key: 'Escape' });
      expect(screen.queryByRole('dialog', { name: '生成结果预览：生成结果' })).not.toBeInTheDocument();
      expect(previewButton).toHaveFocus();
    } finally {
      vi.unstubAllGlobals();
      window.novusDesktop = originalDesktop;
      globalThis.fetch = originalFetch;
    }
  });

  it('scrolls the message stream to the newest generated result', async () => {
    const scrollTo = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', { configurable: true, value: scrollTo });
    const resultNodeId = 'agent-image-scroll-result';
    const conversation = {
      ...createAgentConversation(40),
      id: 'conversation-scroll-result',
      messages: [{
        id: `canvas-result:${resultNodeId}`,
        role: 'assistant' as const,
        content: '生成已完成，1 个结果已回写画布节点。',
        mode: 'codex' as const,
        canvasNodeLabel: '方案 1 · 最新结果',
      }],
    };
    writeAgentConversationCollection('project-a', {
      version: 2,
      activeConversationId: conversation.id,
      conversations: [conversation],
    });

    renderWorkbench({
      codexProfiles: [catalogAstraProfile],
      canvasActionTargets: [{ kind: 'image_generation', nodeId: resultNodeId, label: '方案 1 · 最新结果', selected: false }],
      canvasActionResults: [{ nodeId: resultNodeId, status: 'completed', assetIds: [] }],
    });

    await waitFor(() => expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: expect.any(Number), behavior: 'smooth' })));
  });

  it.each(['failed', 'cancelled'] as const)('reports a successful retry of the same node after %s without duplicating stale terminal messages', async (terminalStatus) => {
    const executeCanvasAction = vi.fn(async () => true);
    const chat = vi.fn(async () => ({
      message: JSON.stringify({ summary: '同节点重试', options: [{ id: 'retry', title: '同节点重试', reason: '验证终态通知', kind: 'image', prompt: '产品居中构图，保持品牌色与主体结构，柔和侧光突出材质，纯净背景，高清电商主图。', modelRoute: 'image/only' }] }),
      modelRoute: 'chat/creative',
      sources: [],
    }));
    const view = renderWorkbench({ chat, executeCanvasAction });
    fireEvent.click(screen.getByRole('tab', { name: '创作 Agent' }));
    fireEvent.change(screen.getByTestId('agent-composer-input'), { target: { value: '生成产品主图' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    fireEvent.click(await screen.findByRole('button', { name: '选择方案：同节点重试' }));
    fireEvent.click(screen.getByRole('button', { name: '确认执行生图' }));
    await waitFor(() => expect(executeCanvasAction).toHaveBeenCalledOnce());
    const nodeId = (executeCanvasAction.mock.calls as unknown as Array<[SkillCanvasActionRequest]>)[0]![0].nodeId;
    const staleText = terminalStatus === 'failed' ? '生成失败，请查看画布节点中的错误信息。' : '生成已取消。';

    view.rerender(workbench({ chat, executeCanvasAction, canvasActionResults: [{ nodeId, status: terminalStatus, assetIds: [] }] }));
    expect(await screen.findByText(staleText)).toBeVisible();
    view.rerender(workbench({ chat, executeCanvasAction, canvasActionResults: [{ nodeId, status: terminalStatus, assetIds: [] }] }));
    expect(screen.getAllByText(staleText)).toHaveLength(1);
    view.rerender(workbench({ chat, executeCanvasAction, canvasActionResults: [{ nodeId, status: 'completed', assetIds: ['retry-result'] }] }));

    expect(await screen.findByText('生成已完成，1 个结果已回写画布节点。')).toBeVisible();
    expect(screen.queryByText(staleText)).not.toBeInTheDocument();
  });

  it('auto-switches an incompatible fixed image preference for references and keeps compatible routes selectable', async () => {
    window.localStorage.setItem('agent-canvas:generation-preferences:v1:project-a', JSON.stringify({
      kind: 'image',
      image: { mode: 'fixed', modelRoute: 'image/only', parameters: { resolution: '4K' } },
      video: { mode: 'auto', parameters: {} },
    }));
    const executeCanvasAction = vi.fn(async () => true);
    const chat = vi.fn(async () => ({
      message: JSON.stringify({
        summary: '参考图生图方案',
        observations: ['保留主体'],
        estimates: [],
        unknowns: [],
        options: [{ id: 'edit', title: '参考图编辑', reason: '保留主体', kind: 'image', prompt: '严格保持参考图主体结构与品牌色，调整为纯净浅色背景，柔和侧光突出材质，居中构图，高清输出。', modelRoute: 'image/only' }],
      }),
      modelRoute: 'chat/vision',
      sources: [],
    }));
    const imageOnly = { ...profiles[1]!, modelRoute: 'image/only', displayName: 'Image only', capabilities: ['image_generation'] as ProviderBridgeProfile['capabilities'] };
    const imageEdit = { ...profiles[1]!, modelRoute: 'image/edit', displayName: 'Image edit', capabilities: ['image_generation', 'image_edit'] as ProviderBridgeProfile['capabilities'] };
    const geminiNative = { ...profiles[1]!, modelRoute: 'image/gemini', displayName: 'Gemini native', capabilities: ['image_generation', 'gemini_native'] as ProviderBridgeProfile['capabilities'] };
    renderWorkbench({
      profiles: [{ ...profiles[0]!, modelRoute: 'chat/vision', displayName: 'Vision chat', capabilities: ['chat', 'vision'] }, imageOnly, imageEdit, geminiNative],
      referenceImages: [{ assetId: 'a'.repeat(16), label: '产品参考', displayUrl: 'novus-project://asset/product' }],
      executeCanvasAction,
      chat,
    });

    window.dispatchEvent(new CustomEvent('novus:generated-image-to-agent', { detail: { assetId: 'a'.repeat(16) } }));
    await waitFor(() => expect(screen.getByLabelText('Selected image references')).toHaveTextContent('产品参考'));
    fireEvent.click(screen.getByRole('tab', { name: '创作 Agent' }));
    fireEvent.change(screen.getByTestId('agent-composer-input'), { target: { value: '@图片1 生成一张参考图编辑' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(chat).toHaveBeenCalledWith(expect.objectContaining({ referenceAssetIds: ['a'.repeat(16)] })));

    fireEvent.click(await screen.findByRole('button', { name: '选择方案：参考图编辑' }));
    const modelSelect = screen.getByRole('combobox', { name: '选择生图模型' });
    expect(modelSelect).toBeEnabled();
    expect(modelSelect).toHaveValue('image/edit');
    expect(screen.getByText(/固定模型不支持参考素材，已自动切换到兼容路线/u)).toBeVisible();
    fireEvent.change(modelSelect, { target: { value: 'image/gemini' } });
    expect(modelSelect).toHaveValue('image/gemini');
    fireEvent.click(screen.getByRole('button', { name: '确认执行生图' }));
    await waitFor(() => expect(executeCanvasAction).toHaveBeenCalledWith(expect.objectContaining({ modelRoute: 'image/gemini', createNode: true })));
  });

  it('does not create a RelayMe video node when a creative option includes a reference image', async () => {
    const executeCanvasAction = vi.fn(async () => true);
    const chat = vi.fn(async (_request: SkillChatRequest) => ({
      message: JSON.stringify({
        summary: '参考图视频方案',
        observations: ['保留主体'],
        estimates: [],
        unknowns: [],
        options: [{ id: 'video', title: '参考图运镜', reason: '保持产品一致', kind: 'video', prompt: '严格保持参考产品外观与品牌色，镜头缓慢环绕主体，柔和棚拍光线，背景稳定，画面清晰无变形。', modelRoute: 'video/relay' }],
      }),
      modelRoute: 'chat/vision',
      sources: [],
    }));
    renderWorkbench({
      profiles: [
        { ...profiles[0]!, modelRoute: 'chat/vision', displayName: 'Vision chat', capabilities: ['chat', 'vision'] },
        { provider: 'relayme', modelRoute: 'video/relay', displayName: 'Relay video', modelId: 'relay-video', capabilities: ['video_generation', 'async_tasks'] },
      ],
      referenceImages: [{ assetId: 'v'.repeat(16), label: '产品参考', displayUrl: 'novus-project://asset/video-product' }],
      executeCanvasAction,
      chat,
    });

    window.dispatchEvent(new CustomEvent('novus:generated-image-to-agent', { detail: { assetId: 'v'.repeat(16) } }));
    await waitFor(() => expect(screen.getByLabelText('Selected image references')).toHaveTextContent('产品参考'));
    fireEvent.click(screen.getByRole('tab', { name: '创作 Agent' }));
    fireEvent.click(screen.getByRole('button', { name: '生成偏好' }));
    fireEvent.click(screen.getByRole('tab', { name: '视频' }));
    fireEvent.click(screen.getByRole('button', { name: '关闭生成偏好' }));
    fireEvent.change(screen.getByTestId('agent-composer-input'), { target: { value: '@图片1 生成参考图视频' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(chat).toHaveBeenCalledOnce());
    expect(JSON.stringify(chat.mock.calls[0]?.[0]?.messages)).not.toContain('video/relay');
    fireEvent.click(await screen.findByRole('button', { name: '选择方案：参考图运镜' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('当前参考素材需要支持参考图输入的视频生成模型');
    expect(screen.queryByLabelText('待确认画布操作')).not.toBeInTheDocument();
    expect(executeCanvasAction).not.toHaveBeenCalled();
  });

  it('explains a local save permission failure before an Agent node can be created', async () => {
    const executeCanvasAction = vi.fn(async () => {
      throw Object.assign(new Error('Project commit failed'), { code: 'PERMISSION_DENIED' });
    });
    const chat = vi.fn(async () => ({
      message: JSON.stringify({
        summary: '选择一个生图方案',
        options: [{ id: 'fresh', title: '新方案', reason: '测试保存边界', kind: 'image', prompt: '产品居中构图，保持品牌色与主体结构，柔和侧光突出材质，纯净背景，高清电商主图。', modelRoute: 'image/only' }],
      }),
      modelRoute: 'chat/creative',
      sources: [],
    }));
    renderWorkbench({ chat, executeCanvasAction });
    fireEvent.click(screen.getByRole('tab', { name: '创作 Agent' }));
    fireEvent.change(screen.getByTestId('agent-composer-input'), { target: { value: '生成新图' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    fireEvent.click(await screen.findByRole('button', { name: '选择方案：新方案' }));
    fireEvent.click(screen.getByRole('button', { name: '确认执行生图' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('本地保存权限不足，生成节点未能保存或启动。请检查项目目录权限后重试。');
  });
  it('repairs a stale persisted Agent route instead of leaving chat unavailable', async () => {
    const initialConversation = { ...createAgentConversation(7), mode: 'chat' as const, modelRoute: '1' };
    writeAgentConversationCollection('project-a', {
      version: 2,
      activeConversationId: initialConversation.id,
      conversations: [initialConversation],
    });
    const chat = vi.fn(async () => ({ message: '已恢复对话', modelRoute: 'chat/creative', sources: [] }));
    renderWorkbench({ chat });

    await waitFor(() => expect(screen.getByTestId('agent-model-trigger')).toHaveAttribute('data-selected-model', 'Creative chat'));
    const composer = screen.getByTestId('agent-composer-input');
    fireEvent.change(composer, { target: { value: '测试恢复' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(chat).toHaveBeenCalledOnce());
    expect(await screen.findByText('已恢复对话')).toBeVisible();
  });

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

  it('clamps restored project-memory selections to the 32 currently available ids', async () => {
    const availableMemoryIds = Array.from({ length: 35 }, (_, index) => `memory-${index}`);
    const initialConversation = {
      ...createAgentConversation(8),
      mode: 'chat' as const,
      modelRoute: 'chat/creative',
      projectMemoryIds: ['superseded-memory', ...availableMemoryIds.slice(0, 31)],
    };
    writeAgentConversationCollection('project-a', {
      version: 2,
      activeConversationId: initialConversation.id,
      conversations: [initialConversation],
    });
    const chat = vi.fn(async () => ({ message: '记忆上下文有效', modelRoute: 'chat/creative', sources: [] }));
    renderWorkbench({ chat, projectMemoryIds: availableMemoryIds });

    fireEvent.change(screen.getByTestId('agent-composer-input'), { target: { value: '检查项目记忆' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    await waitFor(() => expect(chat).toHaveBeenCalledOnce());
    expect(chat).toHaveBeenCalledWith(expect.objectContaining({
      context: expect.objectContaining({ projectMemoryIds: availableMemoryIds.slice(0, 31) }),
    }));
  });

  it.each([
    ['CREDENTIALS_LOCKED', '模型密钥不可用，请在设置中重新配置。'],
    ['PROVIDER_UNAVAILABLE', '模型服务暂时不可用，请检查网络或连接设置。'],
    ['CAPABILITY_UNSUPPORTED', '当前模型不支持该素材或任务，请切换模型。'],
    ['PROVIDER_INVALID_RESPONSE', '模型返回内容无效，请重试或切换模型。'],
    ['CODEX_CLI_AUTH_REQUIRED', 'Codex 认证已失效，请使用 ChatGPT 登录或重新配置有效的 API Key。'],
    ['CODEX_CLI_UPSTREAM_UNAVAILABLE', '当前 Codex 模型上游通道不可用，请检查 Codex 账号的模型权限后重试。'],
    ['CODEX_CLI_INVALID_RESPONSE', 'Codex 返回内容异常，请重试；若持续失败请更新 Codex。'],
    ['CODEX_CLI_FAILED', 'Codex 进程调用失败，请重试；若持续失败请检查 ChatGPT 登录或 API Key。'],
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

  it.each([
    ['PROVIDER_TIMEOUT', 'Provider request timed out after 300000ms', '模型分析已等待 300 秒仍未返回，请减少图片数量、切换快速或标准反推，或更换模型后重试。'],
    ['PROVIDER_ERROR', 'Provider request failed with status 503', '模型上游服务返回 503，当前路线暂时异常，请稍后重试或切换模型。'],
  ])('shows the display-safe provider diagnosis for Agent error %s', async (code, message, expectedMessage) => {
    const chat = vi.fn().mockRejectedValue({ code, message, retryable: true });
    renderWorkbench({ chat });

    fireEvent.change(screen.getByTestId('agent-composer-input'), { target: { value: '分析这个方案' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(expectedMessage));
    expect(screen.getByRole('button', { name: '发送' })).toBeEnabled();
  });

  it('times out a stalled Agent request and restores the composer for retry', async () => {
    vi.useFakeTimers();
    const chat = vi.fn(() => new Promise<ChatSkillBridgeResult>(() => undefined));
    renderWorkbench({ chat });

    fireEvent.change(screen.getByTestId('agent-composer-input'), { target: { value: '继续分析' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(194_999);
    });

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });

    expect(screen.getByRole('alert')).toHaveTextContent('模型分析已等待 195 秒仍未返回，请减少图片数量、切换快速或标准反推，或更换模型后重试。');
    expect(screen.getByTestId('agent-composer-input')).toHaveValue('继续分析');
    expect(screen.getByRole('button', { name: '发送' })).toBeEnabled();
  });

  it('retries an identical failed request in place without duplicating provider history', async () => {
    const chat = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('temporary failure'), { code: 'PROVIDER_UNAVAILABLE' }))
      .mockResolvedValueOnce({ message: '已恢复', modelRoute: 'chat/creative', sources: [] });
    const view = renderWorkbench({ chat });

    fireEvent.change(screen.getByTestId('agent-composer-input'), { target: { value: '继续分析' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(view.container.querySelectorAll('.skill-chat-workbench__message--user')).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(chat).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText('已恢复')).toBeInTheDocument());

    expect(view.container.querySelectorAll('.skill-chat-workbench__message--user')).toHaveLength(1);
    const retriedMessages = chat.mock.calls[1]![0].messages.filter((message: SkillChatRequest['messages'][number]) => (
      message.role === 'user' && message.content === '继续分析'
    ));
    expect(retriedMessages).toHaveLength(1);
  });

  it('keeps an edited request as a new user turn after a failed send', async () => {
    const chat = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('temporary failure'), { code: 'PROVIDER_UNAVAILABLE' }))
      .mockResolvedValueOnce({ message: '已按新请求处理', modelRoute: 'chat/creative', sources: [] });
    const view = renderWorkbench({ chat });

    const composer = screen.getByTestId('agent-composer-input');
    fireEvent.change(composer, { target: { value: '原请求' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    fireEvent.change(composer, { target: { value: '修改后的请求' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(chat).toHaveBeenCalledTimes(2));

    expect(view.container.querySelectorAll('.skill-chat-workbench__message--user')).toHaveLength(2);
    expect(chat.mock.calls[1]![0].messages.filter((message: SkillChatRequest['messages'][number]) => message.role === 'user').map((message: SkillChatRequest['messages'][number]) => message.content)).toEqual([
      '原请求',
      '修改后的请求',
    ]);
  });

  it.each([
    { provider: 'comfly' as const, content: '@图片1 记录素材', visualAnalysis: false },
    { provider: 'relayme' as const, content: '@图片1 分析素材', visualAnalysis: true },
  ])(
    'keeps a stalled $provider visual request alive through the provider timeout window',
    async ({ provider, content, visualAnalysis }) => {
      vi.useFakeTimers();
      const visualProfile: ProviderBridgeProfile = {
        provider,
        modelRoute: `${provider}/vision`,
        modelId: `${provider}-vision`,
        displayName: `${provider} vision`,
        capabilities: ['chat', 'vision'],
      };
      const initialConversation = {
        ...createAgentConversation(9),
        mode: 'chat' as const,
        modelRoute: visualProfile.modelRoute,
      };
      writeAgentConversationCollection('project-a', {
        version: 2,
        activeConversationId: initialConversation.id,
        conversations: [initialConversation],
      });
      const chat = vi.fn(() => new Promise<ChatSkillBridgeResult>(() => undefined));
      renderWorkbench({
        profiles: [visualProfile],
        referenceImages: [{
          assetId: 'a'.repeat(16),
          label: 'Bottle reference',
          displayUrl: 'novus-project://asset/bottle',
        }],
        chat,
      });

      const composer = screen.getByTestId('agent-composer-input');
      fireEvent.change(composer, { target: { value: '@' } });
      fireEvent.click(projectMention('Bottle reference'));
      fireEvent.change(composer, { target: { value: content } });
      fireEvent.click(screen.getByRole('button', { name: '发送' }));

      expect(chat).toHaveBeenCalledWith(expect.objectContaining({
        provider,
        referenceAssetIds: ['a'.repeat(16)],
        visualAnalysis,
      }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(314_999);
      });

      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: '发送' })).toBeDisabled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });

      expect(screen.getByRole('alert')).toHaveTextContent('模型分析已等待 315 秒仍未返回，请减少图片数量、切换快速或标准反推，或更换模型后重试。');
      expect(composer).toHaveValue(content);
      expect(screen.getByRole('button', { name: '发送' })).toBeEnabled();
    },
  );

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
    const css = readFileSync('apps/renderer/src/styles/canvas-layout.css', 'utf8');
    const iconRule = css.match(/\.workspace--canvas-layout \.agent-panel--skill-chat \.skill-chat-workbench__composer-footer > button svg \{[^}]+\}/u)?.[0] ?? '';

    expect(iconRule).toContain('transform: none');
    const submitAfterRule = css.match(/\.workspace--canvas-layout \.agent-panel--skill-chat \.skill-chat-workbench__composer-footer > button\[type='submit'\]::after \{[^}]+\}/u)?.[0] ?? '';
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

  it('uses icon-only Canvas tools without showing the removed image-reference button by default', () => {
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
  it('keeps the Canvas image-reference affordance hidden until the user types @', () => {
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

  it('consumes a generated-image transfer that was queued before the Agent listener mounted', async () => {
    queueGeneratedImageForAgent('q'.repeat(16));
    renderWorkbench({
      profiles: [
        { ...profiles[0]!, displayName: 'Text only', capabilities: ['chat'] },
        { ...profiles[0]!, modelRoute: 'chat/vision-transfer', displayName: 'Vision transfer', capabilities: ['chat', 'vision'] },
      ],
      referenceImages: [{
        assetId: 'q'.repeat(16),
        label: 'Queued generated image',
        displayUrl: 'novus-project://asset/queued-generated-image',
      }],
    });

    await waitFor(() => expect(screen.getByTestId('agent-composer-input')).toHaveValue('@图片1'));
    expect(screen.getByLabelText('Selected image references')).toHaveTextContent('Queued generated image');
    expect(screen.getByRole('button', { name: '打开聊天模型菜单' })).toHaveTextContent('Vision transfer');
  });

  it('restores the composer caret after a generated-image mention replaces an in-sentence @ query', async () => {
    renderWorkbench({
      profiles: [{ ...profiles[0]!, capabilities: ['chat', 'vision'] }],
      referenceImages: [{
        assetId: 'c'.repeat(16),
        label: 'Generated scene',
        displayUrl: 'novus-project://asset/generated-scene',
      }],
    });

    const composer = screen.getByTestId('agent-composer-input');
    fireEvent.change(composer, { target: { value: '前文 @ 后文' } });
    window.dispatchEvent(new CustomEvent('novus:generated-image-to-agent', { detail: { assetId: 'c'.repeat(16) } }));

    await waitFor(() => {
      expect(canonicalCaretOffset(composer)).toBe('前文 @图片1'.length);
    });

    const selection = window.getSelection();
    const range = selection?.getRangeAt(0);
    expect(range).not.toBeUndefined();
    const typed = document.createTextNode('继续');
    range?.insertNode(typed);
    range?.setStartAfter(typed);
    range?.collapse(true);
    selection?.removeAllRanges();
    if (range !== undefined) selection?.addRange(range);
    fireEvent.input(composer);

    await waitFor(() => expect(composer).toHaveValue('前文 @图片1继续 后文'));
  });

  it('exposes the Canvas new-chat action above an empty Skill conversation', () => {
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
    fireEvent.click(screen.getByRole('tab', { name: '创作 Agent' }));
    fireEvent.change(screen.getByTestId('agent-composer-input'), { target: { value: '保留这个任务' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(screen.getByText('Use a clean studio-lighting hierarchy.')).toBeVisible());

    first.unmount();
    renderWorkbench();

    expect(within(screen.getByLabelText('对话消息')).getByText('保留这个任务')).toBeVisible();
    expect(screen.getByRole('tab', { name: '创作 Agent' })).toHaveAttribute('aria-selected', 'true');
    expect((screen.getByRole('combobox', { name: 'Codex 任务' }) as HTMLSelectElement).value).toMatch(/^conversation-/u);
  });

  it('restores each conversation generated-result card with its durable canvas node label', async () => {
    const resultNodeId = 'agent-image-persisted-result';
    const resultConversation = {
      ...createAgentConversation(10),
      id: 'conversation-with-result',
      title: '产品主图方案',
      messages: [{
        id: `canvas-result:${resultNodeId}`,
        role: 'assistant' as const,
        content: '生成已完成，1 个结果已回写画布节点。',
        mode: 'codex' as const,
        canvasNodeLabel: '生图 · 旧的临时名称',
      }],
    };
    const otherConversation = { ...createAgentConversation(20), id: 'conversation-other', title: '其他任务' };
    writeAgentConversationCollection('project-a', {
      version: 2,
      activeConversationId: resultConversation.id,
      conversations: [resultConversation, otherConversation],
    });
    const props = {
      codexProfiles: [catalogAstraProfile],
      canvasActionTargets: [{ kind: 'image_generation' as const, nodeId: resultNodeId, label: '方案 3 · 红色破壁机主图', selected: false }],
      canvasActionResults: [{ nodeId: resultNodeId, status: 'completed', assetIds: ['generated-result'] }],
      referenceImages: [{ assetId: 'generated-result', label: '生成结果 1', displayUrl: 'novus-asset://generated-result' }],
    };

    const first = renderWorkbench(props);
    expect(await screen.findByLabelText('生成执行进度')).toHaveAttribute('data-node-label', '方案 3 · 红色破壁机主图');
    await waitFor(() => {
      const persisted = JSON.parse(window.localStorage.getItem('agent-canvas:skill-chat:v2:project-a') ?? '{}');
      const marker = persisted.conversations?.[0]?.messages?.find((message: { id?: string }) => message.id === `canvas-result:${resultNodeId}`);
      expect(marker?.canvasNodeLabel).toBe('方案 3 · 红色破壁机主图');
    });
    first.unmount();

    renderWorkbench(props);
    const selector = screen.getByRole('combobox', { name: 'Codex 任务' });
    fireEvent.change(selector, { target: { value: otherConversation.id } });
    expect(screen.queryByLabelText('生成执行进度')).not.toBeInTheDocument();
    fireEvent.change(selector, { target: { value: resultConversation.id } });
    expect(await screen.findByLabelText('生成执行进度')).toHaveAttribute('data-node-label', '方案 3 · 红色破壁机主图');
    expect(screen.getByRole('button', { name: '查看生成结果：生成结果 1' })).toBeVisible();
  });

  it('reports an orphaned persisted result marker instead of showing it as running forever', () => {
    const resultNodeId = 'deleted-agent-result';
    const conversation = {
      ...createAgentConversation(30),
      id: 'conversation-with-orphaned-result',
      messages: [{
        id: `canvas-result:${resultNodeId}`,
        role: 'assistant' as const,
        content: '图片节点已开始运行。',
        mode: 'codex' as const,
        canvasNodeLabel: '图片 · 已删除的红色破壁机主图',
      }],
    };
    writeAgentConversationCollection('project-a', {
      version: 2,
      activeConversationId: conversation.id,
      conversations: [conversation],
    });

    renderWorkbench({ codexProfiles: [catalogAstraProfile], canvasActionTargets: [], canvasActionResults: [] });

    const progress = screen.getByLabelText('生成执行进度');
    expect(progress).toHaveAttribute('data-node-label', '图片 · 已删除的红色破壁机主图');
    expect(progress).toHaveTextContent('节点或结果已不存在');
    expect(progress).not.toHaveTextContent('生成任务执行中');
    expect(within(screen.getByRole('article')).queryByText('图片节点已开始运行。')).not.toBeInTheDocument();
  });

  it('shows reasoning effort only for Codex so the compact composer is not overcrowded', () => {
    renderWorkbench({ codexProfiles: [catalogAstraProfile] });

    expect(screen.getByRole('button', { name: /^思考能力：/ })).toBeVisible();
    expect(screen.queryByRole('group', { name: '反推强度' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: '对话' }));
    expect(screen.queryByRole('button', { name: /^思考能力：/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: '创作 Agent' }));
    expect(screen.queryByRole('button', { name: /^思考能力：/ })).not.toBeInTheDocument();
  });

  it('labels the active assistant without claiming a canvas operation has run', () => {
    renderWorkbench({ codexProfiles: [catalogAstraProfile] });

    const emptyState = screen.getByLabelText('Agent conversation empty state');
    expect(emptyState).toHaveTextContent('Codex 画布助手');
    expect(emptyState).not.toHaveTextContent('通过 Canvas Atelier MCP 完成操作');
  });

  it('does not substitute provider Astra or GPT-5.6 routes for the local Codex catalog', async () => {
    renderWorkbench({
      profiles: [
        { provider: 'comfly', modelRoute: 'chat/general', modelId: 'general-chat', displayName: 'General Chat', capabilities: ['chat'] },
        { provider: 'comfly', modelRoute: 'codex/gpt-6-astra', modelId: 'gpt-6-astra', displayName: 'GPT-6 Astra', capabilities: ['responses', 'vision'] },
        { provider: 'comfly', modelRoute: 'openai/gpt-5.6-sol', modelId: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', capabilities: ['responses', 'vision'] },
        { provider: 'comfly', modelRoute: 'openai/gpt-5.6-terra', modelId: 'gpt-5.6-terra', displayName: 'GPT-5.6 Terra', capabilities: ['responses', 'vision'] },
        { provider: 'comfly', modelRoute: 'openai/gpt-5.6-luna', modelId: 'gpt-5.6-luna', displayName: 'GPT-5.6 Luna', capabilities: ['responses', 'vision'] },
      ],
      codexProfiles: [],
    });

    await waitFor(() => expect(screen.getByTestId('agent-model-trigger')).toHaveTextContent('未发现 Codex 模型'));
    fireEvent.click(screen.getByTestId('agent-model-trigger'));
    const dialog = screen.getByRole('dialog', { name: '选择聊天模型' });
    for (const model of ['GPT-6 Astra', 'GPT-5.6 Sol', 'GPT-5.6 Terra', 'GPT-5.6 Luna']) {
      expect(within(dialog).queryByText(model)).not.toBeInTheDocument();
    }
    expect(within(dialog).queryByText('General Chat')).not.toBeInTheDocument();
  });

  it('shows only local Codex CLI profiles when provider catalogs contain legacy Codex routes', async () => {
    const chat = vi.fn(async () => ({ message: 'Local Codex reply', modelRoute: CODEX_ASTRA_PROFILE.modelRoute, sources: [] }));
    renderWorkbench({
      profiles: [
        { provider: 'comfly', modelRoute: 'chat/gpt-5.3-codex-high', modelId: 'gpt-5.3-codex-high', displayName: 'Comfly GPT-5.3 Codex High', capabilities: ['responses', 'vision'] },
        { provider: 'relayme', modelRoute: 'relayme/codex-chat', modelId: 'relayme-codex-chat', displayName: 'RelayMe Codex Chat', capabilities: ['chat', 'vision'] },
      ],
      codexProfiles: [catalogAstraProfile],
      chat,
    });

    await waitFor(() => expect(screen.getByTestId('agent-model-trigger')).toHaveAttribute('data-selected-model', 'GPT-6 Astra'));
    fireEvent.click(screen.getByTestId('agent-model-trigger'));
    const dialog = screen.getByRole('dialog', { name: '选择聊天模型' });
    expect(within(dialog).getByRole('button', { name: '使用 GPT-6 Astra' })).toBeVisible();
    expect(within(dialog).queryByText('Comfly GPT-5.3 Codex High')).not.toBeInTheDocument();
    expect(within(dialog).queryByText('RelayMe Codex Chat')).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('agent-model-trigger'));
    fireEvent.change(screen.getByTestId('agent-composer-input'), { target: { value: '读取当前画布' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(chat).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'codex',
      modelRoute: CODEX_ASTRA_PROFILE.modelRoute,
      agentMode: 'codex',
    })));
  });

  it('does not fall back to ordinary chat models when Codex mode has no Codex route', async () => {
    renderWorkbench({
      profiles: [{ provider: 'comfly', modelRoute: 'chat/general', modelId: 'general-chat', displayName: 'General Chat', capabilities: ['chat'] }],
      codexProfiles: [],
    });

    await waitFor(() => expect(screen.getByTestId('agent-model-trigger')).toHaveTextContent('未发现 Codex 模型'));
    fireEvent.click(screen.getByTestId('agent-model-trigger'));
    const dialog = screen.getByRole('dialog', { name: '选择聊天模型' });
    expect(dialog).not.toHaveTextContent('General Chat');
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled();
  });

  it('keeps RelayMe chat routes out of Codex mode instead of cross-provider fallback', async () => {
    renderWorkbench({
      profiles: [{
        provider: 'relayme',
        modelRoute: 'relayme-gemini-3-1-flash-lite',
        modelId: 'gemini-3.1-flash-lite',
        displayName: 'Gemini 3.1 Flash Lite',
        capabilities: ['chat'],
      }],
      codexProfiles: [],
    });

    await waitFor(() => expect(screen.getByTestId('agent-model-trigger')).toHaveTextContent('未发现 Codex 模型'));
    expect(screen.getByRole('button', { name: '发送' })).toBeDisabled();
    fireEvent.click(screen.getByRole('tab', { name: '对话' }));
    await waitFor(() => expect(screen.getByTestId('agent-model-trigger')).toHaveAttribute('data-selected-model', 'Gemini 3.1 Flash Lite'));
  });

  it('keeps internal request metadata out of the visible conversation in every mode', async () => {
    const chat = vi.fn(async () => ({ message: '普通助手回复', modelRoute: 'codex-auto-review', sources: [] }));
    renderWorkbench({
      codexProfiles: [catalogAstraProfile],
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
    renderWorkbench({ chat, codexProfiles: [catalogAstraProfile] });
    fireEvent.click(screen.getByRole('button', { name: /^思考能力：/ }));
    fireEvent.change(screen.getByRole('slider', { name: '思考能力' }), { target: { value: '2' } });
    fireEvent.change(screen.getByTestId('agent-composer-input'), { target: { value: '设计一个生图工作流' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    await waitFor(() => expect(chat).toHaveBeenCalledWith(expect.objectContaining({
      agentMode: 'codex',
      reasoningEffort: 'high',
    })));
  });

  it('selects local GPT-6 Astra independently of RelayMe and sends its exact max effort with a cancellable request id', async () => {
    const chat = vi.fn(async () => ({ message: 'Astra result', modelRoute: CODEX_ASTRA_PROFILE.modelRoute, sources: [] }));
    const onImportReferenceImage = vi.fn();
    const onImportReferenceVideo = vi.fn();
    renderWorkbench({
      profiles: [{
        provider: 'relayme', modelRoute: 'relayme/chat', modelId: 'gemini-3.1-flash-lite',
        displayName: 'Gemini 3.1 Flash Lite', capabilities: ['chat'],
      }],
      codexProfiles: [catalogAstraProfile],
      chat,
      onImportReferenceImage,
      onImportReferenceVideo,
    });

    await waitFor(() => expect(screen.getByTestId('agent-model-trigger')).toHaveAttribute('data-selected-model', 'GPT-6 Astra'));
    expect(screen.getByText('支持 ChatGPT / API Key · 调用时验证')).toBeVisible();
    expect(screen.getByRole('button', { name: '添加素材' })).toBeEnabled();
    fireEvent.click(screen.getByRole('tab', { name: '对话' }));
    await waitFor(() => expect(screen.getByTestId('agent-model-trigger')).toHaveAttribute('data-selected-model', 'Gemini 3.1 Flash Lite'));
    fireEvent.click(screen.getByRole('tab', { name: 'Codex' }));
    await waitFor(() => expect(screen.getByTestId('agent-model-trigger')).toHaveAttribute('data-selected-model', 'GPT-6 Astra'));
    fireEvent.click(screen.getByRole('button', { name: /^思考能力：/ }));
    fireEvent.change(screen.getByRole('slider', { name: '思考能力' }), { target: { value: '4' } });
    fireEvent.change(screen.getByTestId('agent-composer-input'), { target: { value: '读取当前画布结构' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    await waitFor(() => expect(chat).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'codex',
      modelRoute: 'codex/gpt-6-astra',
      requestId: expect.stringMatching(/^[A-Za-z0-9_-]+$/u),
      agentMode: 'codex',
      reasoningEffort: 'max',
    })));
  });

  it('shows the active Codex model, Max effort, elapsed time, and a direct stop action while analysis is running', async () => {
    let rejectChat: ((error: Error) => void) | undefined;
    const chat = vi.fn((_request: SkillChatRequest) => new Promise<ChatSkillBridgeResult>((_resolve, reject) => { rejectChat = reject; }));
    const cancelChat = vi.fn(async () => {
      rejectChat?.(Object.assign(new Error('cancelled'), { code: 'CODEX_CLI_CANCELLED' }));
      return true;
    });
    renderWorkbench({ profiles: [], codexProfiles: [catalogAstraProfile], chat, cancelChat });
    fireEvent.click(screen.getByRole('button', { name: /^思考能力：/ }));
    fireEvent.change(screen.getByRole('slider', { name: '思考能力' }), { target: { value: '4' } });
    fireEvent.change(screen.getByTestId('agent-composer-input'), { target: { value: '检查当前画布并提出执行方案' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    expect(await screen.findByRole('status')).toHaveTextContent('GPT-6 Astra · Max');
    expect(screen.getByRole('status')).toHaveTextContent(/已等待 \d+ 秒/u);
    fireEvent.click(screen.getByRole('button', { name: '停止 Codex 分析' }));

    const sentRequestId = (chat.mock.calls[0]?.[0] as SkillChatRequest | undefined)?.requestId;
    await waitFor(() => expect(cancelChat).toHaveBeenCalledWith(sentRequestId));
    await waitFor(() => expect(screen.queryByLabelText('Agent 正在分析')).not.toBeInTheDocument());
  });

  it('cancels the background Codex process when the effort deadline expires', async () => {
    vi.useFakeTimers();
    let rejectChat: ((error: Error) => void) | undefined;
    const chat = vi.fn((_request: SkillChatRequest) => new Promise<ChatSkillBridgeResult>((_resolve, reject) => { rejectChat = reject; }));
    const cancelChat = vi.fn(async () => {
      rejectChat?.(Object.assign(new Error('cancelled'), { code: 'CODEX_CLI_CANCELLED' }));
      return true;
    });
    renderWorkbench({ profiles: [], codexProfiles: [catalogAstraProfile], chat, cancelChat });
    fireEvent.click(screen.getByRole('button', { name: /^思考能力：/ }));
    fireEvent.change(screen.getByRole('slider', { name: '思考能力' }), { target: { value: '0' } });
    fireEvent.change(screen.getByTestId('agent-composer-input'), { target: { value: '检查当前画布并建立工作流' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await act(async () => { await Promise.resolve(); });
    const sentRequestId = (chat.mock.calls[0]?.[0] as SkillChatRequest | undefined)?.requestId;

    await act(async () => { await vi.advanceTimersByTimeAsync(91_000); });

    expect(cancelChat).toHaveBeenCalledWith(sentRequestId);
  });

  it('cancels the current local Codex request when a new task replaces it', async () => {
    let rejectChat: ((error: Error) => void) | undefined;
    const chat = vi.fn((_request: SkillChatRequest) => new Promise<ChatSkillBridgeResult>((_resolve, reject) => { rejectChat = reject; }));
    const cancelChat = vi.fn(async () => {
      rejectChat?.(Object.assign(new Error('cancelled'), { code: 'CODEX_CLI_CANCELLED' }));
      return true;
    });
    renderWorkbench({ profiles: [], codexProfiles: [catalogAstraProfile], chat, cancelChat });
    fireEvent.change(screen.getByTestId('agent-composer-input'), { target: { value: '修改当前画布' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(chat).toHaveBeenCalledOnce());
    const sentRequestId = (chat.mock.calls[0]?.[0] as SkillChatRequest | undefined)?.requestId;
    expect(sentRequestId).toMatch(/^[A-Za-z0-9_-]+$/u);

    fireEvent.click(screen.getByTestId('agent-new-chat'));

    await waitFor(() => expect(cancelChat).toHaveBeenCalledWith(sentRequestId));
    await waitFor(() => expect(screen.queryByLabelText('Agent 正在思考')).not.toBeInTheDocument());
  });

  it('cancels the current local Codex request when switching out of Codex mode', async () => {
    let rejectChat: ((error: Error) => void) | undefined;
    const chat = vi.fn((_request: SkillChatRequest) => new Promise<ChatSkillBridgeResult>((_resolve, reject) => { rejectChat = reject; }));
    const cancelChat = vi.fn(async () => {
      rejectChat?.(Object.assign(new Error('cancelled'), { code: 'CODEX_CLI_CANCELLED' }));
      return true;
    });
    renderWorkbench({ profiles: [], codexProfiles: [catalogAstraProfile], chat, cancelChat });
    await waitFor(() => expect(screen.getByTestId('agent-model-trigger')).toHaveAttribute('data-selected-model', 'GPT-6 Astra'));
    fireEvent.change(screen.getByTestId('agent-composer-input'), { target: { value: '读取画布' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(chat).toHaveBeenCalledOnce());
    const sentRequestId = (chat.mock.calls[0]?.[0])?.requestId;

    fireEvent.click(screen.getByRole('tab', { name: '对话' }));

    await waitFor(() => expect(cancelChat).toHaveBeenCalledWith(sentRequestId));
  });

  it('cancels the current local Codex request when the workbench unmounts', async () => {
    const chat = vi.fn((_request: SkillChatRequest) => new Promise<ChatSkillBridgeResult>(() => undefined));
    const cancelChat = vi.fn(async () => true);
    const view = renderWorkbench({ profiles: [], codexProfiles: [catalogAstraProfile], chat, cancelChat });
    fireEvent.change(screen.getByTestId('agent-composer-input'), { target: { value: '读取画布' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(chat).toHaveBeenCalledOnce());
    const sentRequestId = (chat.mock.calls[0]?.[0])?.requestId;

    view.unmount();

    await waitFor(() => expect(cancelChat).toHaveBeenCalledWith(sentRequestId));
  });

  it('lets local Astra handle full canvas intent through MCP instead of the legacy node shortcut', async () => {
    const chat = vi.fn(async () => ({ message: '已通过 MCP 创建节点', modelRoute: CODEX_ASTRA_PROFILE.modelRoute, sources: [] }));
    const executeCanvasAction = vi.fn();
    renderWorkbench({
      profiles: [],
      codexProfiles: [catalogAstraProfile],
      chat,
      executeCanvasAction,
    });

    await waitFor(() => expect(screen.getByTestId('agent-model-trigger')).toHaveAttribute('data-selected-model', 'GPT-6 Astra'));
    fireEvent.change(screen.getByTestId('agent-composer-input'), { target: { value: '创建一个生图节点并连接提示词节点' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    await waitFor(() => expect(chat).toHaveBeenCalledOnce());
    expect(executeCanvasAction).not.toHaveBeenCalled();
  });

  it('imports a clipboard image into Codex and sends the managed reference metadata', async () => {
    const image = new File(['one'], 'codex-reference.png', { type: 'image/png' });
    const onImportReferenceImage = vi.fn().mockResolvedValue({
      assetId: 'c'.repeat(16), label: 'codex-reference.png', displayUrl: 'novus-asset://codex-reference',
    });
    const chat = vi.fn(async () => ({ message: '已分析图片', modelRoute: CODEX_ASTRA_PROFILE.modelRoute, sources: [] }));
    renderWorkbench({ profiles: [], codexProfiles: [catalogAstraProfile], onImportReferenceImage, chat });

    const composer = screen.getByTestId('agent-composer-input');
    fireEvent.paste(composer, { clipboardData: { files: [image], items: [], getData: () => '' } });

    await waitFor(() => expect(onImportReferenceImage).toHaveBeenCalledWith(image));
    expect(composer).toHaveValue('@图片1');
    fireEvent.change(composer, { target: { value: '@图片1 分析产品外观' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(chat).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'codex',
      referenceAssetIds: ['c'.repeat(16)],
      referenceMentions: [{ assetId: 'c'.repeat(16), label: 'codex-reference.png', mention: '@图片1' }],
      visualAnalysis: true,
    })));
  });

  it('explains the Codex video boundary and clears it when switching modes', async () => {
    const video = new File(['one'], 'codex-reference.mp4', { type: 'video/mp4' });
    renderWorkbench({ profiles: [], codexProfiles: [catalogAstraProfile] });
    const composer = screen.getByTestId('agent-composer-input');
    fireEvent.paste(composer, { clipboardData: { files: [video], items: [], getData: () => '' } });
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('当前 Codex 支持图片引用'));

    fireEvent.click(screen.getByRole('tab', { name: '对话' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
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
    expect(screen.getByRole('button', { name: '梳理创作目标' })).toBeVisible();
    expect(screen.getByRole('button', { name: '生成视觉方向' })).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: '梳理创作目标' }));
    expect(screen.getByTestId('agent-composer-input')).toHaveValue('请帮我梳理创作目标、约束条件和下一步方案。');
  });

  it('does not claim embedded canvas execution readiness before a chat model is available', () => {
    renderWorkbench({ profiles: [] });

    expect(screen.getByText('等待模型配置')).toBeVisible();
    expect(screen.queryByText('运行就绪')).not.toBeInTheDocument();
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
    expect(screen.queryByRole('button', { name: '梳理创作目标' })).not.toBeInTheDocument();
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
      agentMode: 'chat',
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
      codexProfiles: [catalogAstraProfile],
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

  it('shows and sends only the selected reverse node instead of every canvas reverse result', async () => {
    const chat = vi.fn(async (_request: SkillChatRequest) => ({ message: '已参考当前反推。', modelRoute: catalogAstraProfile.modelRoute, sources: [] }));
    renderWorkbench({
      codexProfiles: [catalogAstraProfile],
      chat,
      reverseTimeline: [
        { nodeId: 'reverse-old', title: '旧反推', positivePrompt: 'old unrelated prompt' },
        { nodeId: 'reverse-current', title: '当前红色破壁机反推', positivePrompt: 'current red blender prompt' },
        { nodeId: 'reverse-new', title: '其他新反推', positivePrompt: 'new unrelated prompt' },
      ],
      canvasActionTargets: [
        { kind: 'reverse_agent', nodeId: 'reverse-old', label: '旧反推', selected: false },
        { kind: 'reverse_agent', nodeId: 'reverse-current', label: '当前红色破壁机反推', selected: true },
        { kind: 'reverse_agent', nodeId: 'reverse-new', label: '其他新反推', selected: false },
      ],
    });

    expect(screen.getByLabelText('节点反推结果：当前红色破壁机反推')).toBeVisible();
    expect(screen.queryByLabelText('节点反推结果：旧反推')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('节点反推结果：其他新反推')).not.toBeInTheDocument();

    fireEvent.change(screen.getByTestId('agent-composer-input'), { target: { value: '基于当前结果给我新的构图方案' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(chat).toHaveBeenCalledOnce());
    const request = chat.mock.calls[0]![0];
    const sentContent = request.messages[request.messages.length - 1]?.content ?? '';
    expect(sentContent).toContain('【当前反推节点上下文】');
    expect(sentContent).toContain('当前红色破壁机反推');
    expect(sentContent).toContain('current red blender prompt');
    expect(sentContent).not.toContain('old unrelated prompt');
    expect(sentContent).not.toContain('new unrelated prompt');
  });

  it('keeps the final provider message inside the desktop bridge 8000-character contract', async () => {
    const chat = vi.fn(async (request: SkillChatRequest) => ({ message: '已生成方案。', modelRoute: request.modelRoute, sources: [] }));
    renderWorkbench({
      chat,
      reverseTimeline: [{
        nodeId: 'reverse-long-context',
        title: '长反推上下文',
        positivePrompt: '红色产品，暖色厨房，保持主体结构，柔和侧光，商业摄影。'.repeat(240),
      }],
    });
    fireEvent.click(screen.getByRole('tab', { name: '创作 Agent' }));
    const userRequest = `请根据当前反推重新设计一套完整电商主图方案，${'保留产品结构并优化构图。'.repeat(120)}`;
    fireEvent.change(screen.getByTestId('agent-composer-input'), { target: { value: userRequest } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    await waitFor(() => expect(chat).toHaveBeenCalledOnce());
    const request = chat.mock.calls[0]![0];
    const latestContent = request.messages[request.messages.length - 1]?.content ?? '';
    expect(latestContent).toContain(userRequest);
    expect(latestContent).toContain('请先分析需求');
    expect(latestContent).toContain('【当前反推节点上下文】');
    expect(latestContent.length).toBeLessThanOrEqual(8_000);
    expect(ChatSkillBridgeRequestSchema.safeParse(request).success).toBe(true);
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
    const mentionItem = projectMention('Bottle reference');
    expect(screen.getByRole('menu', { name: 'Reference images' })).toBeVisible();
    expect(within(mentionItem).getByRole('img')).toHaveAttribute('src', 'novus-project://asset/bottle');
    expect(mentionItem).toHaveTextContent('@图片1');
    expect(screen.queryByRole('button', { name: 'Mention image' })).not.toBeInTheDocument();
    fireEvent.click(projectMention('Bottle reference'));
    expect(screen.getByTestId('agent-composer-input')).toHaveValue('@图片1');
    const presentation = screen.getByRole('textbox', { name: '向 Agent 发送消息' });
    expect(presentation).toHaveTextContent('图片1');
    expect(presentation).not.toHaveTextContent('@');
    expect(within(presentation).getByText('图片1').closest('[data-token="@图片1"]')).toHaveAttribute('data-media-mention', 'image');

    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    await waitFor(() => expect(chat).toHaveBeenCalledWith(expect.objectContaining({
      referenceAssetIds: ['a'.repeat(16)],
    })));
    const sentReferences = screen.getByRole('region', { name: '已发送素材' });
    expect(within(sentReferences).getByRole('img', { name: 'Bottle reference' })).toHaveAttribute('src', 'novus-project://asset/bottle');
    expect(sentReferences).toHaveTextContent('@图片1');
    expect(screen.queryByLabelText('知识库请求: Vision chat')).not.toBeInTheDocument();
    expect(screen.getByText('The bottle has a soft studio highlight.')).toBeVisible();
  });

  it('replaces an in-sentence @ query at its original position instead of appending the capsule', () => {
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
    });

    fireEvent.click(screen.getByRole('tab', { name: '对话' }));
    const composer = screen.getByTestId('agent-composer-input');
    fireEvent.change(composer, { target: { value: '前文 @ 后文' } });
    fireEvent.click(projectMention('Bottle reference'));

    expect(composer).toHaveValue('前文 @图片1 后文');
  });

  it('replaces the unresolved @ query at the live caret without deleting adjacent text', () => {
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
    });

    fireEvent.click(screen.getByRole('tab', { name: '对话' }));
    const composer = screen.getByTestId('agent-composer-input');
    fireEvent.change(composer, { target: { value: '前文@图后文，第二处@尾部' } });
    const range = document.createRange();
    range.setStart(composer.firstChild!, '前文@图'.length);
    range.collapse(true);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));

    fireEvent.click(projectMention('Bottle reference'));

    expect(composer).toHaveValue('前文@图片1后文，第二处@尾部');
  });

  it('restores the composer caret after a menu mention so the next text follows the capsule', async () => {
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
    });

    fireEvent.click(screen.getByRole('tab', { name: '对话' }));
    const composer = screen.getByTestId('agent-composer-input');
    fireEvent.change(composer, { target: { value: '前文 @ 后文' } });
    fireEvent.click(projectMention('Bottle reference'));

    await waitFor(() => {
      const selection = window.getSelection();
      expect(selection?.rangeCount).toBe(1);
      expect(selection?.anchorNode && composer.contains(selection.anchorNode)).toBe(true);
      expect(canonicalCaretOffset(composer)).toBe('前文 @图片1'.length);
    });

    const selection = window.getSelection();
    const range = selection?.getRangeAt(0);
    expect(range).not.toBeUndefined();
    const typed = document.createTextNode('继续');
    range?.insertNode(typed);
    range?.setStartAfter(typed);
    range?.collapse(true);
    selection?.removeAllRanges();
    if (range !== undefined) selection?.addRange(range);
    fireEvent.input(composer);

    await waitFor(() => expect(composer).toHaveValue('前文 @图片1继续 后文'));
  });

  it('keeps project videos out of Agent dialogue attachments and bridge requests', async () => {
    const chat = vi.fn(async () => ({ message: '已分析图片', modelRoute: 'chat/vision', sources: [] }));
    const onImportReferenceVideo = vi.fn().mockResolvedValue({
      assetId: 'video-import', label: 'imported.mp4', displayUrl: 'novus-project://asset/imported-video',
    });
    renderWorkbench({
      profiles: [{ ...profiles[0]!, modelRoute: 'chat/vision', capabilities: ['chat', 'vision'] }, profiles[1]!],
      referenceImages: [{ assetId: 'a'.repeat(16), label: 'Bottle reference', displayUrl: 'novus-project://asset/bottle' }],
      referenceVideos: [{ assetId: 'b'.repeat(16), label: 'Demo video', displayUrl: 'novus-project://asset/demo' }],
      onImportReferenceVideo,
      chat,
    });
    fireEvent.click(screen.getByRole('tab', { name: '对话' }));

    expect(screen.getByTestId('agent-reference-file-input')).toHaveAttribute('accept', 'image/*');
    fireEvent.change(screen.getByTestId('agent-composer-input'), { target: { value: '@' } });
    expect(projectMention('Bottle reference')).toBeVisible();
    expect(screen.queryByRole('menuitem', { name: 'Mention Demo video' })).not.toBeInTheDocument();

    fireEvent.paste(screen.getByTestId('agent-composer-input'), {
      clipboardData: {
        files: [new File(['video'], 'imported.mp4', { type: 'video/mp4' })],
        items: [],
        getData: () => '',
      },
    });

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('当前对话暂不支持视频引用'));
    expect(onImportReferenceVideo).not.toHaveBeenCalled();
    expect(screen.queryByText('@视频1')).not.toBeInTheDocument();
    expect(chat).not.toHaveBeenCalled();
  });

  it('lets users copy an image from sent Agent references while project videos stay unavailable', async () => {
    const chat = vi.fn(async () => ({ message: '已收到素材', modelRoute: 'chat/vision', sources: [] }));
    const writeClipboardImage = vi.fn(async (_bytes: Uint8Array) => true);
    const originalDesktop = window.novusDesktop;
    const originalFetch = globalThis.fetch;
    window.novusDesktop = { projectImages: { writeClipboardImage } } as unknown as typeof window.novusDesktop;
    globalThis.fetch = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } }));
    try {
      renderWorkbench({
        profiles: [{ ...profiles[0]!, modelRoute: 'chat/vision', capabilities: ['chat', 'vision'] }, profiles[1]!],
        referenceImages: [{ assetId: 'a'.repeat(16), label: 'Bottle reference', displayUrl: 'novus-project://asset/bottle' }],
        referenceVideos: [{ assetId: 'b'.repeat(16), label: 'Demo video', displayUrl: 'novus-project://asset/demo' }],
        chat,
      });
      fireEvent.click(screen.getByRole('tab', { name: '对话' }));
      const composer = screen.getByTestId('agent-composer-input');
      fireEvent.change(composer, { target: { value: '@' } });
      fireEvent.click(projectMention('Bottle reference'));
      expect(screen.queryByRole('menuitem', { name: 'Mention Demo video' })).not.toBeInTheDocument();
      fireEvent.change(composer, { target: { value: '@图片1 分析素材' } });
      fireEvent.click(screen.getByRole('button', { name: '发送' }));

      await waitFor(() => expect(chat).toHaveBeenCalledOnce());
      const sentReferences = screen.getByRole('region', { name: '已发送素材' });
      const copyButton = within(sentReferences).getByRole('button', { name: '复制图片：Bottle reference' });
      expect(sentReferences).toHaveTextContent('@图片1');
      expect(sentReferences).not.toHaveTextContent('@视频');
      expect(chat).toHaveBeenCalledWith(expect.objectContaining({
        referenceAssetIds: ['a'.repeat(16)],
        referenceMentions: [{ assetId: 'a'.repeat(16), label: 'Bottle reference', mention: '@图片1' }],
      }));

      fireEvent.click(copyButton);

      await waitFor(() => expect(writeClipboardImage).toHaveBeenCalledOnce());
      expect(await screen.findByRole('status')).toHaveTextContent('图片已复制');
    } finally {
      window.novusDesktop = originalDesktop;
      globalThis.fetch = originalFetch;
    }
  });

  it('reports a clear error when copying a sent Agent image fails', async () => {
    const chat = vi.fn(async () => ({ message: '已收到素材', modelRoute: 'chat/vision', sources: [] }));
    const writeClipboardImage = vi.fn(async (_bytes: Uint8Array) => false);
    const originalDesktop = window.novusDesktop;
    const originalFetch = globalThis.fetch;
    window.novusDesktop = { projectImages: { writeClipboardImage } } as unknown as typeof window.novusDesktop;
    globalThis.fetch = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } }));
    try {
      renderWorkbench({
        profiles: [{ ...profiles[0]!, modelRoute: 'chat/vision', capabilities: ['chat', 'vision'] }, profiles[1]!],
        referenceImages: [{ assetId: 'a'.repeat(16), label: 'Bottle reference', displayUrl: 'novus-project://asset/bottle' }],
        chat,
      });
      fireEvent.click(screen.getByRole('tab', { name: '对话' }));
      const composer = screen.getByTestId('agent-composer-input');
      fireEvent.change(composer, { target: { value: '@' } });
      fireEvent.click(projectMention('Bottle reference'));
      fireEvent.change(composer, { target: { value: '@图片1 分析素材' } });
      fireEvent.click(screen.getByRole('button', { name: '发送' }));

      await waitFor(() => expect(chat).toHaveBeenCalledOnce());
      fireEvent.click(within(screen.getByRole('region', { name: '已发送素材' })).getByRole('button', { name: '复制图片：Bottle reference' }));

      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('无法复制图片，请检查系统剪贴板权限'));
      expect(writeClipboardImage).toHaveBeenCalledOnce();
    } finally {
      window.novusDesktop = originalDesktop;
      globalThis.fetch = originalFetch;
    }
  });

  it('falls back to the browser clipboard when the native sent-image copy bridge rejects', async () => {
    const chat = vi.fn(async () => ({ message: '已收到素材', modelRoute: 'chat/vision', sources: [] }));
    const writeClipboardImage = vi.fn(async (_bytes: Uint8Array) => { throw new Error('IPC unavailable'); });
    const browserWrite = vi.fn(async (_items: ClipboardItem[]) => undefined);
    const originalDesktop = window.novusDesktop;
    const originalFetch = globalThis.fetch;
    window.novusDesktop = { projectImages: { writeClipboardImage } } as unknown as typeof window.novusDesktop;
    globalThis.fetch = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } }));
    vi.stubGlobal('ClipboardItem', class ClipboardItemMock { constructor(readonly data: Record<string, Blob>) {} });
    vi.stubGlobal('navigator', { clipboard: { write: browserWrite } });
    try {
      renderWorkbench({
        profiles: [{ ...profiles[0]!, modelRoute: 'chat/vision', capabilities: ['chat', 'vision'] }, profiles[1]!],
        referenceImages: [{ assetId: 'a'.repeat(16), label: 'Bottle reference', displayUrl: 'novus-project://asset/bottle' }],
        chat,
      });
      fireEvent.click(screen.getByRole('tab', { name: '对话' }));
      const composer = screen.getByTestId('agent-composer-input');
      fireEvent.change(composer, { target: { value: '@' } });
      fireEvent.click(projectMention('Bottle reference'));
      fireEvent.change(composer, { target: { value: '@图片1 分析素材' } });
      fireEvent.click(screen.getByRole('button', { name: '发送' }));

      await waitFor(() => expect(chat).toHaveBeenCalledOnce());
      fireEvent.click(within(screen.getByRole('region', { name: '已发送素材' })).getByRole('button', { name: '复制图片：Bottle reference' }));

      await waitFor(() => expect(browserWrite).toHaveBeenCalledOnce());
      expect(await screen.findByRole('status')).toHaveTextContent('图片已复制');
    } finally {
      vi.unstubAllGlobals();
      window.novusDesktop = originalDesktop;
      globalThis.fetch = originalFetch;
    }
  });

  it('does not pass a failed non-image response to either clipboard bridge', async () => {
    const chat = vi.fn(async () => ({ message: '已收到素材', modelRoute: 'chat/vision', sources: [] }));
    const writeClipboardImage = vi.fn(async (_bytes: Uint8Array) => true);
    const browserWrite = vi.fn(async (_items: ClipboardItem[]) => undefined);
    const originalDesktop = window.novusDesktop;
    const originalFetch = globalThis.fetch;
    window.novusDesktop = { projectImages: { writeClipboardImage } } as unknown as typeof window.novusDesktop;
    globalThis.fetch = vi.fn(async () => new Response('<html>not found</html>', {
      status: 404,
      headers: { 'content-type': 'text/html' },
    }));
    vi.stubGlobal('ClipboardItem', class ClipboardItemMock { constructor(readonly data: Record<string, Blob>) {} });
    vi.stubGlobal('navigator', { clipboard: { write: browserWrite } });
    try {
      renderWorkbench({
        profiles: [{ ...profiles[0]!, modelRoute: 'chat/vision', capabilities: ['chat', 'vision'] }, profiles[1]!],
        referenceImages: [{ assetId: 'a'.repeat(16), label: 'Bottle reference', displayUrl: 'novus-project://asset/missing' }],
        chat,
      });
      fireEvent.click(screen.getByRole('tab', { name: '对话' }));
      const composer = screen.getByTestId('agent-composer-input');
      fireEvent.change(composer, { target: { value: '@' } });
      fireEvent.click(projectMention('Bottle reference'));
      fireEvent.change(composer, { target: { value: '@图片1 分析素材' } });
      fireEvent.click(screen.getByRole('button', { name: '发送' }));
      await waitFor(() => expect(chat).toHaveBeenCalledOnce());

      fireEvent.click(within(screen.getByRole('region', { name: '已发送素材' })).getByRole('button', { name: '复制图片：Bottle reference' }));

      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('图片素材暂时无法读取，请重新打开项目后重试'));
      expect(writeClipboardImage).not.toHaveBeenCalled();
      expect(browserWrite).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      window.novusDesktop = originalDesktop;
      globalThis.fetch = originalFetch;
    }
  });

  it('submits ordered visual-analysis metadata and asks before drafting a workflow', async () => {
    const chat = vi.fn(async () => ({
      message: JSON.stringify({
        visual: {
          subject: '红色产品',
          environment: '浅色棚拍',
          material: '磨砂材质',
          lighting: '柔和侧光',
          camera: '平视',
          depth: '浅景深',
          composition: '居中构图',
          perspective: '正面视角',
          layers: '前中后景分层',
        },
        prompts: {
          zh: '红色产品，浅色棚拍，柔和侧光，居中构图，浅景深',
          en: 'Red product, bright studio, soft side light, centered composition, shallow depth of field',
          negative: ['水印'],
        },
      }),
      modelRoute: 'chat/vision',
      sources: [],
    }));
    const draftWorkflowFromAnalysis = vi.fn();
    renderWorkbench({
      profiles: [{ ...profiles[0]!, modelRoute: 'chat/vision', capabilities: ['chat', 'vision'] }, { ...profiles[1]!, capabilities: ['image_generation', 'image_edit'] }],
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
      agentMode: 'chat',
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
    expect(draftWorkflowFromAnalysis).toHaveBeenCalledOnce();
    const workflowDraft = draftWorkflowFromAnalysis.mock.calls[0]?.[0];
    expect(workflowDraft?.generation?.prompt).toBe('红色产品，浅色棚拍，柔和侧光，居中构图，浅景深');
    expect(workflowDraft?.reverseAnalysis).toMatchObject({
      runnable: true,
      prompts: { zh: '红色产品，浅色棚拍，柔和侧光，居中构图，浅景深' },
    });
    expect(workflowDraft?.references).toEqual([
      { assetId: 'a'.repeat(16), label: '产品参考', mention: '@图片1' },
      { assetId: 'b'.repeat(16), label: '场景参考', mention: '@图片2' },
    ]);
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
      profiles: [{ ...profiles[0]!, modelRoute: 'chat/vision', capabilities: ['chat', 'vision'] }, profiles[1]!],
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

  it('does not write an unstructured reverse response into an image node', async () => {
    const chat = vi.fn(async () => ({ message: '结构化反推结果', modelRoute: 'chat/vision', sources: [] }));
    const draftWorkflowFromAnalysis = vi.fn();
    renderWorkbench({
      profiles: [{ ...profiles[0]!, modelRoute: 'chat/vision', capabilities: ['chat', 'vision'] }, { ...profiles[1]!, modelRoute: 'image/edit', capabilities: ['image_generation', 'image_edit'] }],
      referenceImages: [{ assetId: 'a'.repeat(16), label: '产品参考', displayUrl: 'novus-project://asset/product' }],
      chat,
      draftWorkflowFromAnalysis,
    });

    window.dispatchEvent(new CustomEvent('novus:generated-image-to-agent', { detail: { assetId: 'a'.repeat(16) } }));
    await waitFor(() => expect(screen.getByLabelText('Selected image references')).toHaveTextContent('产品参考'));
    fireEvent.change(screen.getByTestId('agent-composer-input'), { target: { value: '@图片1 反推这张图并输出提示词' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    expect(await screen.findByText('是否基于本次反推生成工作流？')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '生成工作流' }));

    expect(draftWorkflowFromAnalysis).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('没有返回可执行的生图提示词');
  });

  it('sends an ordered referenced reverse request to visual chat instead of requiring a selected reverse node', async () => {
    const chat = vi.fn(async () => ({ message: '结构化反推结果', modelRoute: 'chat/vision', sources: [] }));
    renderWorkbench({
      profiles: [{ ...profiles[0]!, modelRoute: 'chat/vision', capabilities: ['chat', 'vision'] }, profiles[1]!],
      referenceImages: [{ assetId: 'a'.repeat(16), label: '产品参考', displayUrl: 'novus-project://asset/product' }],
      canvasActionTargets: [],
      executeCanvasAction: vi.fn(async () => true),
      chat,
    });

    fireEvent.change(screen.getByTestId('agent-composer-input'), { target: { value: '@' } });
    fireEvent.click(projectMention('产品参考'));
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
    const analysis = JSON.stringify({ summary: '建议按输入、反推、生图和输出依次连接。', generation: { prompt: '产品居中构图，保持原有形状和 Logo，柔和侧光呈现金属细节，浅色背景。' } });
    const chat = vi.fn(async () => ({ message: analysis, modelRoute: 'codex/gpt-5.6-sol', sources: [] }));
    const draftWorkflowFromAnalysis = vi.fn();
    const localSolProfile = {
      ...catalogAstraProfile,
      modelRoute: 'codex/gpt-5.6-sol' as const,
      modelId: 'gpt-5.6-sol',
      displayName: 'GPT-5.6 Sol',
    };
    renderWorkbench({
      profiles: [profiles[1]!],
      codexProfiles: [localSolProfile],
      chat,
      draftWorkflowFromAnalysis,
    });

    fireEvent.change(screen.getByTestId('agent-composer-input'), { target: { value: '为产品图创建一个反推后生图的工作流' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    expect(await screen.findByText('是否基于本次方案生成工作流？')).toBeVisible();
    expect(screen.getByText('建议按输入、反推、生图和输出依次连接。')).toBeVisible();
    expect(screen.queryByText(analysis)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '生成工作流' }));
    expect(draftWorkflowFromAnalysis).toHaveBeenCalledWith({
      analysis,
      generation: { kind: 'image', prompt: '产品居中构图，保持原有形状和 Logo，柔和侧光呈现金属细节，浅色背景。', modelRoute: 'image/only', modelRouteDisplayName: 'Image only', parameters: {} },
      references: [],
      modelRoute: 'codex/gpt-5.6-sol',
      modelRouteDisplayName: 'GPT-5.6 Sol',
    });
  });

  it('blocks a Codex workflow whose generation prompt is only a generic wrapper around the request', async () => {
    const requestText = '为产品图创建一个反推后生图的工作流';
    const analysis = JSON.stringify({
      summary: '模型没有完成提示词分析',
      generation: { prompt: `根据你的要求，${requestText}，请执行。` },
    });
    const chat = vi.fn(async () => ({ message: analysis, modelRoute: 'codex/gpt-5.6-sol', sources: [] }));
    const draftWorkflowFromAnalysis = vi.fn();
    const localSolProfile = {
      ...catalogAstraProfile,
      modelRoute: 'codex/gpt-5.6-sol' as const,
      modelId: 'gpt-5.6-sol',
      displayName: 'GPT-5.6 Sol',
    };
    renderWorkbench({ profiles: [profiles[1]!], codexProfiles: [localSolProfile], chat, draftWorkflowFromAnalysis });
    fireEvent.change(screen.getByTestId('agent-composer-input'), { target: { value: requestText } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    expect(await screen.findByText('是否基于本次方案生成工作流？')).toBeVisible();
    expect(screen.getByText('模型没有完成提示词分析')).toBeVisible();
    expect(screen.queryByText(analysis)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '生成工作流' }));
    expect(screen.getByRole('alert')).toHaveTextContent('没有把需求改写成生图提示词');
    expect(draftWorkflowFromAnalysis).not.toHaveBeenCalled();
  });

  it('offers a Codex workflow for a referenced product-refinement request without requiring the word workflow', async () => {
    const chat = vi.fn(async () => ({ message: '先锁定参考图，只精修产品主体并保持背景。', modelRoute: 'codex/gpt-5.6-sol', sources: [] }));
    const draftWorkflowFromAnalysis = vi.fn();
    const localSolProfile = {
      ...catalogAstraProfile,
      modelRoute: 'codex/gpt-5.6-sol' as const,
      modelId: 'gpt-5.6-sol',
      displayName: 'GPT-5.6 Sol',
    };
    renderWorkbench({
      profiles: [{ ...profiles[1]!, capabilities: ['image_generation', 'image_edit'] }],
      codexProfiles: [localSolProfile],
      referenceImages: [{ assetId: 'codex-product', label: '产品图', displayUrl: 'novus-project://asset/codex-product' }],
      chat,
      draftWorkflowFromAnalysis,
    });
    window.dispatchEvent(new CustomEvent('novus:generated-image-to-agent', { detail: { assetId: 'codex-product' } }));
    await waitFor(() => expect(screen.getByLabelText('Selected image references')).toHaveTextContent('产品图'));
    fireEvent.change(screen.getByTestId('agent-composer-input'), { target: { value: '@图片1 把产品单独精修，其他不需要改变' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    expect(await screen.findByText('是否基于本次方案生成工作流？')).toBeVisible();
  });

  it('keeps unrelated project images out of the default reference picker', () => {
    renderWorkbench({
      profiles: [{ ...profiles[0]!, capabilities: ['chat', 'vision'] }],
      referenceImages: [{ assetId: 'unrelated', label: '无关项目图片', displayUrl: 'novus-asset://unrelated' }],
    });
    fireEvent.change(screen.getByTestId('agent-composer-input'), { target: { value: '@' } });
    expect(screen.getByRole('menu', { name: 'Reference images' })).toBeVisible();
    expect(screen.queryByRole('menuitem', { name: 'Mention 无关项目图片' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '浏览项目图片' }));
    expect(screen.getByRole('menuitem', { name: 'Mention 无关项目图片' })).toBeVisible();
  });

  it('numbers a newly pasted image from the conversation catalog and preserves its send mapping', async () => {
    const projectImages = Array.from({ length: 69 }, (_, index) => ({
      assetId: `project-image-${index + 1}`,
      label: `Project image ${index + 1}`,
      displayUrl: `novus-asset://project-image-${index + 1}`,
    }));
    const imported = {
      assetId: 'pasted-only-image',
      label: 'pasted-only.png',
      displayUrl: 'novus-asset://pasted-only-image',
    };
    const onImportReferenceImage = vi.fn().mockResolvedValue(imported);
    const chat = vi.fn(async (_request: SkillChatRequest) => ({ message: 'ok', modelRoute: 'chat/vision', sources: [] }));
    renderWorkbench({
      profiles: [{ ...profiles[0]!, modelRoute: 'chat/vision', capabilities: ['chat', 'vision'] }, profiles[1]!],
      referenceImages: projectImages,
      onImportReferenceImage,
      chat,
    });
    const composer = screen.getByTestId('agent-composer-input');
    const pastedImage = new File([new Uint8Array([1, 2, 3])], imported.label, { type: 'image/png' });
    fireEvent.paste(composer, {
      clipboardData: { files: [pastedImage], items: [], getData: (type: string) => type === 'text/plain' ? '分析这张图' : '' },
    });

    await waitFor(() => expect(composer).toHaveValue('分析这张图 @图片1'));
    expect(within(screen.getByLabelText('Selected image references')).getByRole('button', { name: 'Remove pasted-only.png media reference' })).toHaveTextContent('@图片1');
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(chat).toHaveBeenCalledOnce());
    expect(chat.mock.calls[0]![0]).toMatchObject({
      referenceAssetIds: ['pasted-only-image'],
      referenceMentions: [{ assetId: 'pasted-only-image', label: 'pasted-only.png', mention: '@图片1' }],
    });

    fireEvent.change(composer, { target: { value: '@' } });
    expect(screen.queryByRole('menuitem', { name: 'Mention Project image 1' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '浏览项目图片' }));
    const browsedProjectImage = screen.getByRole('menuitem', { name: 'Mention Project image 1' });
    expect(browsedProjectImage).toHaveTextContent('@图片2');
    fireEvent.click(browsedProjectImage);
    expect(composer).toHaveValue('@图片2');
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() => expect(chat).toHaveBeenCalledTimes(2));
    expect(chat.mock.calls[1]![0]).toMatchObject({
      referenceAssetIds: ['project-image-1'],
      referenceMentions: [{ assetId: 'project-image-1', label: 'Project image 1', mention: '@图片2' }],
    });
  });

  it('does not leak an imported reference into a newly created conversation', async () => {
    const imported = { assetId: 'conversation-a-import', label: '任务A粘贴图.png', displayUrl: 'novus-asset://conversation-a-import' };
    const onImportReferenceImage = vi.fn().mockResolvedValue(imported);
    renderWorkbench({
      profiles: [{ ...profiles[0]!, modelRoute: 'chat/vision', capabilities: ['chat', 'vision'] }, profiles[1]!],
      onImportReferenceImage,
    });
    fireEvent.click(screen.getByRole('button', { name: '添加素材' }));
    fireEvent.change(screen.getByTestId('agent-reference-file-input'), {
      target: { files: [new File([new Uint8Array([1])], imported.label, { type: 'image/png' })] },
    });
    await waitFor(() => expect(screen.getByLabelText('Selected image references')).toHaveTextContent(imported.label));

    fireEvent.click(screen.getByRole('button', { name: '新建任务' }));
    fireEvent.click(screen.getByRole('tab', { name: '对话' }));
    fireEvent.change(screen.getByTestId('agent-composer-input'), { target: { value: '@' } });

    expect(screen.queryByRole('menuitem', { name: `Mention ${imported.label}` })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Selected image references')).not.toBeInTheDocument();
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

    fireEvent.click(projectMention('Image 20'));
    expect(screen.getByTestId('agent-composer-input')).toHaveValue('@图片20');
    const presentation = screen.getByRole('textbox', { name: '向 Agent 发送消息' });
    expect(within(presentation).getByText('图片20').closest('[data-token="@图片20"]')).toHaveAttribute('data-media-mention', 'image');
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
      profiles: [{ ...profiles[0]!, modelRoute: 'chat/vision', capabilities: ['chat', 'vision'] }, profiles[1]!],
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

  it('inserts a manually imported image at the live composer caret', async () => {
    const onImportReferenceImage = vi.fn().mockResolvedValue({
      assetId: 'image-1', label: 'reference.png', displayUrl: 'novus-asset://image-1',
    });
    renderWorkbench({
      profiles: [{ ...profiles[0]!, modelRoute: 'chat/vision', capabilities: ['chat', 'vision'] }, profiles[1]!],
      onImportReferenceImage,
    });
    fireEvent.click(screen.getByRole('tab', { name: '对话' }));
    const composer = screen.getByTestId('agent-composer-input');
    fireEvent.change(composer, { target: { value: '前文 后文' } });
    const range = document.createRange();
    range.setStart(composer.firstChild!, '前文 '.length);
    range.collapse(true);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));

    fireEvent.change(screen.getByTestId('agent-reference-file-input'), {
      target: { files: [new File([new Uint8Array([1])], 'reference.png', { type: 'image/png' })] },
    });

    await waitFor(() => expect(onImportReferenceImage).toHaveBeenCalledOnce());
    await waitFor(() => expect(composer).toHaveValue('前文 @图片1 后文'));
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

  it('rejects a pasted video before importing it into Agent dialogue', async () => {
    const onImportReferenceVideo = vi.fn().mockResolvedValue({
      assetId: 'video-1', label: 'clip.mp4', displayUrl: 'blob:video-1',
    });
    renderWorkbench({
      profiles: [{ ...profiles[0]!, modelRoute: 'chat/vision', capabilities: ['chat', 'vision'] }, profiles[1]!],
      onImportReferenceVideo,
    });

    fireEvent.paste(screen.getByTestId('agent-composer-input'), {
      clipboardData: {
        files: [new File([new Uint8Array([0])], 'clip.mp4', { type: 'video/mp4' })],
        getData: () => '',
      },
    });

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('当前对话暂不支持视频引用'));
    expect(onImportReferenceVideo).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Selected image references')).not.toBeInTheDocument();
    expect(screen.getByTestId('agent-composer-input')).toHaveValue('');
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
  it('closes the reference picker when a clipboard image is pasted over it', async () => {
    const pastedImage = new File([new Uint8Array([1, 2, 3])], 'pasted.png', { type: 'image/png' });
    const onImportReferenceImage = vi.fn().mockResolvedValue({
      assetId: 'pasted-image-1', label: 'pasted.png', displayUrl: 'novus-asset://pasted-image-1',
    });
    renderWorkbench({
      profiles: [{ provider: 'comfly', modelRoute: 'chat/vision', modelId: 'vision-chat', displayName: 'Vision chat', capabilities: ['chat', 'vision'] }],
      referenceImages: [{ assetId: 'existing-image-1', label: 'Existing image', displayUrl: 'novus-asset://existing-image-1' }],
      onImportReferenceImage,
    });

    fireEvent.click(screen.getByRole('tab', { name: '对话' }));
    const composer = screen.getByTestId('agent-composer-input');
    fireEvent.change(composer, { target: { value: '@' } });
    expect(screen.getByRole('menu', { name: 'Reference images' })).toBeVisible();
    fireEvent.paste(composer, { clipboardData: { files: [pastedImage], items: [], getData: () => '' } });

    await waitFor(() => expect(onImportReferenceImage).toHaveBeenCalledOnce());
    expect(screen.queryByRole('menu', { name: 'Reference images' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Selected image references')).toHaveTextContent('pasted.png');
  });
  it('keeps text-only paste behavior', () => {
    renderWorkbench();
    const composer = screen.getByTestId('agent-composer-input');
    fireEvent.paste(composer, {
      clipboardData: { files: [], items: [], getData: (type: string) => type === 'text/plain' ? '保留原生粘贴' : '' },
    });

    expect(composer).toHaveValue('保留原生粘贴');
  });

  it.each([{ types: [] }, { types: ['text/uri-list'] }, { types: ['Files'] }])('imports a native desktop image when clipboard files are hidden and formats are $types', async ({ types }) => {
    const onImportReferenceImage = vi.fn().mockResolvedValue({ assetId: 'native-image', label: 'native.png', displayUrl: 'novus-asset://native-image' });
    Object.defineProperty(window, 'novusDesktop', { configurable: true, value: {} });
    try {
      renderWorkbench({ profiles: [{ ...profiles[0]!, capabilities: ['chat', 'vision'] }], onImportReferenceImage });
      fireEvent.paste(screen.getByTestId('agent-composer-input'), {
        clipboardData: { files: [], items: types.includes('Files') ? [{ kind: 'file', getAsFile: () => null }] : [], types, getData: (type: string) => type === 'text/uri-list' ? 'file:///C:/reference.png' : '' },
      });
      await waitFor(() => expect(onImportReferenceImage).toHaveBeenCalledWith(undefined, { fromClipboard: true }));
      expect(screen.getByLabelText('Selected image references')).toHaveTextContent('native.png');
    } finally {
      delete window.novusDesktop;
    }
  });

  it.each(['chat', 'original'] as const)('switches %s to a vision model after manual image import', async (mode) => {
    const initialConversation = { ...createAgentConversation(1), mode, modelRoute: 'chat/creative' };
    writeAgentConversationCollection('project-a', { version: 2, activeConversationId: initialConversation.id, conversations: [initialConversation] });
    const image = new File(['image'], 'manual.png', { type: 'image/png' });
    const onImportReferenceImage = vi.fn().mockResolvedValue({ assetId: 'manual-image', label: 'manual.png', displayUrl: 'novus-asset://manual-image' });
    renderWorkbench({ profiles: [profiles[0]!, { ...profiles[0]!, modelRoute: 'chat/vision', displayName: 'Vision chat', capabilities: ['chat', 'vision'] }], onImportReferenceImage });
    fireEvent.change(screen.getByTestId('agent-reference-file-input'), { target: { files: [image] } });
    await waitFor(() => expect(screen.getByTestId('agent-model-trigger')).toHaveAttribute('data-selected-model', 'Vision chat'));
    expect(screen.getByLabelText('Selected image references')).toHaveTextContent('manual.png');
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
      profiles: [{ ...profiles[0]!, modelRoute: 'chat/vision', capabilities: ['chat', 'vision'] }, profiles[1]!],
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
      profiles: [{ ...profiles[0]!, modelRoute: 'chat/vision', capabilities: ['chat', 'vision'] }, profiles[1]!],
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
      profiles: [{ ...profiles[0]!, modelRoute: 'chat/vision', capabilities: ['chat', 'vision'] }, profiles[1]!],
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
      profiles: [{ ...profiles[0]!, modelRoute: 'chat/vision', capabilities: ['chat', 'vision'] }, profiles[1]!],
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
      profiles: [{ ...profiles[0]!, modelRoute: 'chat/vision', capabilities: ['chat', 'vision'] }, profiles[1]!],
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
      profiles: [{ ...profiles[0]!, modelRoute: 'chat/vision', capabilities: ['chat', 'vision'] }, profiles[1]!],
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
      profiles: [{ ...profiles[0]!, modelRoute: 'chat/vision', capabilities: ['chat', 'vision'] }, profiles[1]!],
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

  it.each([
    ['chat', '对话'],
    ['original', '创作 Agent'],
  ] as const)('switches %s mode to an available vision model when an image is pasted', async (mode, _label) => {
    const image = new File(['one'], `${mode}-reference.png`, { type: 'image/png' });
    const visionProfile: ProviderBridgeProfile = {
      ...profiles[0]!,
      modelRoute: 'chat/vision',
      displayName: 'Vision chat',
      capabilities: ['chat', 'vision'],
    };
    const onImportReferenceImage = vi.fn().mockResolvedValue({
      assetId: `${mode}-managed-image`,
      label: `${mode}-reference.png`,
      displayUrl: `novus-asset://${mode}-managed-image`,
    });
    const initialConversation = { ...createAgentConversation(1), mode, modelRoute: 'chat/creative' };
    writeAgentConversationCollection('project-a', {
      version: 2,
      activeConversationId: initialConversation.id,
      conversations: [initialConversation],
    });
    renderWorkbench({ profiles: [profiles[0]!, visionProfile], onImportReferenceImage });

    fireEvent.paste(screen.getByTestId('agent-composer-input'), {
      clipboardData: { files: [image], items: [], getData: () => '' },
    });

    await waitFor(() => expect(onImportReferenceImage).toHaveBeenCalledWith(image));
    await waitFor(() => expect(screen.getByTestId('agent-model-trigger')).toHaveAttribute('data-selected-model', 'Vision chat'));
    expect(screen.getByLabelText('Selected image references')).toBeVisible();
    expect(screen.queryByText(/当前模型不支持图片或视频/u)).not.toBeInTheDocument();
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

  it('pastes mixed multiline text at the caret while importing only supported images', async () => {
    const image = new File(['one'], 'one.png', { type: 'image/png' });
    const video = new File(['two'], 'two.mp4', { type: 'video/mp4' });
    const onImportReferenceImage = vi.fn().mockResolvedValue({
      assetId: 'managed-image', label: 'one.png', displayUrl: 'novus-asset://managed-image',
    });
    const onImportReferenceVideo = vi.fn().mockResolvedValue({
      assetId: 'managed-video', label: 'two.mp4', displayUrl: 'novus-asset://managed-video',
    });
    renderWorkbench({
      profiles: [{ ...profiles[0]!, modelRoute: 'chat/vision', capabilities: ['chat', 'vision'] }, profiles[1]!],
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

    await waitFor(() => expect(onImportReferenceImage).toHaveBeenCalledWith(image));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('当前对话暂不支持视频引用'));
    expect(onImportReferenceVideo).not.toHaveBeenCalled();
    expect(composer).toHaveValue('前缀 第一行\n第二行 @图片1 后缀');
  });

  it('imports only image files from an items-only clipboard payload', async () => {
    const image = new File(['one'], 'items-one.png', { type: 'image/png' });
    const video = new File(['two'], 'items-two.mp4', { type: 'video/mp4' });
    const onImportReferenceImage = vi.fn().mockResolvedValue({
      assetId: 'items-image', label: 'items-one.png', displayUrl: 'novus-asset://items-image',
    });
    const onImportReferenceVideo = vi.fn().mockResolvedValue({
      assetId: 'items-video', label: 'items-two.mp4', displayUrl: 'novus-asset://items-video',
    });
    renderWorkbench({
      profiles: [{ ...profiles[0]!, modelRoute: 'chat/vision', capabilities: ['chat', 'vision'] }, profiles[1]!],
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

    await waitFor(() => expect(onImportReferenceImage).toHaveBeenCalledWith(image));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('当前对话暂不支持视频引用'));
    expect(onImportReferenceVideo).not.toHaveBeenCalled();
    expect(screen.getByTestId('agent-composer-input')).toHaveValue('@图片1');
  });

  it('keeps image references around an unsupported pasted video without importing the video', async () => {
    const firstImage = new File(['one'], 'first.png', { type: 'image/png' });
    const failingVideo = new File(['two'], 'failed.mp4', { type: 'video/mp4' });
    const lastImage = new File(['three'], 'last.png', { type: 'image/png' });
    const onImportReferenceImage = vi.fn()
      .mockResolvedValueOnce({ assetId: 'first-image', label: 'first.png', displayUrl: 'novus-asset://first-image' })
      .mockResolvedValueOnce({ assetId: 'last-image', label: 'last.png', displayUrl: 'novus-asset://last-image' });
    const onImportReferenceVideo = vi.fn().mockRejectedValue(new Error('manage failed'));
    renderWorkbench({
      profiles: [{ ...profiles[0]!, modelRoute: 'chat/vision', capabilities: ['chat', 'vision'] }, profiles[1]!],
      onImportReferenceImage,
      onImportReferenceVideo,
    });

    fireEvent.paste(screen.getByTestId('agent-composer-input'), {
      clipboardData: { files: [firstImage, failingVideo, lastImage], items: [], getData: () => '' },
    });

    await waitFor(() => expect(onImportReferenceImage).toHaveBeenLastCalledWith(lastImage));
    expect(onImportReferenceVideo).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('当前对话暂不支持视频引用');
    expect(screen.getByTestId('agent-composer-input')).toHaveValue('@图片1 @图片2');
  });

  it('does not overwrite text typed while pasted media is importing', async () => {
    const image = new File(['one'], 'slow.png', { type: 'image/png' });
    let resolveImport: ((value: { assetId: string; label: string; displayUrl: string }) => void) | undefined;
    const onImportReferenceImage = vi.fn(() => new Promise<{ assetId: string; label: string; displayUrl: string }>((resolve) => {
      resolveImport = resolve;
    }));
    renderWorkbench({
      profiles: [{ ...profiles[0]!, modelRoute: 'chat/vision', capabilities: ['chat', 'vision'] }, profiles[1]!],
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

  it('serializes an image paste before rejecting a later video paste', async () => {
    const first = new File(['one'], 'first.png', { type: 'image/png' });
    const second = new File(['two'], 'second.mp4', { type: 'video/mp4' });
    let resolveFirst: ((value: { assetId: string; label: string; displayUrl: string }) => void) | undefined;
    const onImportReferenceImage = vi.fn(() => new Promise<{ assetId: string; label: string; displayUrl: string }>((resolve) => { resolveFirst = resolve; }));
    const onImportReferenceVideo = vi.fn();
    renderWorkbench({
      profiles: [{ ...profiles[0]!, modelRoute: 'chat/vision', capabilities: ['chat', 'vision'] }, profiles[1]!],
      onImportReferenceImage,
      onImportReferenceVideo,
    });
    const composer = screen.getByTestId('agent-composer-input');

    fireEvent.paste(composer, { clipboardData: { files: [first], items: [], getData: () => '' } });
    fireEvent.paste(composer, { clipboardData: { files: [second], items: [], getData: () => '' } });
    await waitFor(() => expect(onImportReferenceImage).toHaveBeenCalledOnce());
    expect(onImportReferenceVideo).not.toHaveBeenCalled();

    await act(async () => resolveFirst?.({ assetId: 'first-image', label: 'first.png', displayUrl: 'novus-asset://first-image' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('当前对话暂不支持视频引用'));
    expect(onImportReferenceVideo).not.toHaveBeenCalled();
    await waitFor(() => expect((composer as HTMLDivElement & { value: string }).value.trim()).toBe('@图片1'));
    expect((composer as HTMLDivElement & { value: string }).value).not.toContain('@视频');
  });

  it('keeps same-kind overlapping batches in import order while restoring each marker at its own reverse text position', async () => {
    const first = new File(['one'], 'first.png', { type: 'image/png' });
    const second = new File(['two'], 'second.png', { type: 'image/png' });
    let resolveFirst: ((value: { assetId: string; label: string; displayUrl: string }) => void) | undefined;
    const onImportReferenceImage = vi.fn()
      .mockImplementationOnce(() => new Promise<{ assetId: string; label: string; displayUrl: string }>((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce({ assetId: 'second-image', label: 'second.png', displayUrl: 'novus-asset://second-image' });
    renderWorkbench({
      profiles: [{ ...profiles[0]!, modelRoute: 'chat/vision', capabilities: ['chat', 'vision'] }, profiles[1]!],
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
      profiles: [{ ...profiles[0]!, modelRoute: 'chat/vision', capabilities: ['chat', 'vision'] }, profiles[1]!],
      onImportReferenceImage,
    });

    fireEvent.paste(screen.getByTestId('agent-composer-input'), {
      clipboardData: { files: [oldImage], items: [], getData: () => '' },
    });
    await waitFor(() => expect(onImportReferenceImage).toHaveBeenCalledWith(oldImage));
    fireEvent.click(screen.getByRole('button', { name: '新建任务' }));
    fireEvent.click(screen.getByRole('tab', { name: '对话' }));
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
      profiles: [{ ...profiles[0]!, modelRoute: 'chat/vision', capabilities: ['chat', 'vision'] }, profiles[1]!],
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
      profiles: [{ ...profiles[0]!, modelRoute: 'chat/vision', capabilities: ['chat', 'vision'] }, profiles[1]!],
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
      profiles: [{ ...profiles[0]!, modelRoute: 'chat/vision', capabilities: ['chat', 'vision'] }, profiles[1]!],
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
      profiles: [{ ...profiles[0]!, modelRoute: 'chat/vision', capabilities: ['chat', 'vision'] }, profiles[1]!],
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
      profiles: [{ ...profiles[0]!, modelRoute: 'chat/vision', capabilities: ['chat', 'vision'] }, profiles[1]!],
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
      profiles: [{ ...profiles[0]!, modelRoute: 'chat/vision', capabilities: ['chat', 'vision'] }, profiles[1]!],
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
      profiles: [{ ...profiles[0]!, modelRoute: 'chat/vision', capabilities: ['chat', 'vision'] }, profiles[1]!],
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
    expect(composer).toHaveValue('left X @图片1 right');
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
    profiles: [{ ...profiles[0]!, modelRoute: 'chat/vision', capabilities: ['chat', 'vision'] }, profiles[1]!],
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

it('keeps action-shaped language as ordinary conversation in chat mode', async () => {
  const executeCanvasAction = vi.fn(async () => true);
  const chat = vi.fn(async () => ({ message: '我可以先帮你梳理这张产品图的方向。', modelRoute: 'chat/creative', sources: [] }));
  renderWorkbench({
    chat,
    canvasActionTargets: [{ kind: 'image_generation', nodeId: 'image-node-1', label: 'Image node 1', selected: true }],
    executeCanvasAction,
  } as never);

  fireEvent.click(screen.getByRole('tab', { name: '对话' }));
  fireEvent.change(screen.getByTestId('agent-composer-input'), { target: { value: '帮我生成一张产品主图' } });
  fireEvent.submit(screen.getByTestId('agent-composer-input').closest('form')!);

  await waitFor(() => expect(chat).toHaveBeenCalledWith(expect.objectContaining({ agentMode: 'chat' })));
  expect(await screen.findByText('我可以先帮你梳理这张产品图的方向。')).toBeVisible();
  expect(executeCanvasAction).not.toHaveBeenCalled();
  expect(screen.queryByLabelText('待确认画布操作')).not.toBeInTheDocument();
});

it.each(['生成一个8秒产品视频', '反推当前参考图的提示词'])('asks the model about %s without regex-triggered execution', async (command) => {
  const executeCanvasAction = vi.fn(async () => true);
  const chat = vi.fn(async () => ({ message: '需要先确认素材与内容', modelRoute: 'chat/creative', sources: [] }));
  renderWorkbench({ chat, executeCanvasAction });
  fireEvent.click(screen.getByRole('tab', { name: '创作 Agent' }));
  fireEvent.change(screen.getByTestId('agent-composer-input'), { target: { value: command } });
  fireEvent.click(screen.getByRole('button', { name: '发送' }));
  expect(await screen.findByText('需要先确认素材与内容')).toBeVisible();
  expect(chat).toHaveBeenCalledOnce();
  expect(executeCanvasAction).not.toHaveBeenCalled();
  expect(screen.queryByLabelText('待确认画布操作')).not.toBeInTheDocument();
});
