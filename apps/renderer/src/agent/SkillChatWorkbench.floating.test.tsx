import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, expect, it, vi } from 'vitest';
import { SkillChatWorkbench } from './SkillChatWorkbench';
afterEach(() => { cleanup(); localStorage.clear(); sessionStorage.clear(); });
const props = {
  projectId: 'floating-test', knowledgeBases: [], projectMemoryIds: [], reverseTimeline: [],
  profiles: [{ provider: 'comfly' as const, modelRoute: 'vision-chat', modelId: 'vision-chat', displayName: 'Vision', capabilities: ['chat', 'vision'] as ('chat' | 'vision')[] }],
  referenceImages: [
    { assetId: 'red', label: '红色产品', displayUrl: 'data:image/png;base64,AA==' },
    { assetId: 'blue', label: '蓝色场景', displayUrl: 'data:image/png;base64,AA==' },
  ],
  chat: vi.fn(async () => ({ message: 'ok', modelRoute: 'vision-chat', sources: [] })),
};
it('offers searchable project pictures directly after @ without sending unselected pictures', () => {
  render(<SkillChatWorkbench {...props} />);
  fireEvent.change(screen.getByLabelText('Agent 模式'), { target: { value: 'chat' } });
  fireEvent.change(screen.getByLabelText('向 Agent 发送消息'), { target: { value: '@' } });
  expect(screen.getByRole('menuitem', { name: 'Mention 红色产品' })).toBeVisible();
  fireEvent.change(screen.getByRole('textbox', { name: '搜索引用图片' }), { target: { value: '蓝色' } });
  expect(screen.queryByRole('menuitem', { name: 'Mention 红色产品' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('menuitem', { name: 'Mention 蓝色场景' }));
  expect(within(screen.getByLabelText('Selected image references')).getByRole('button')).toHaveAccessibleName('Remove 蓝色场景 media reference');
  expect(props.chat).not.toHaveBeenCalled();
});
it('provides a history popover while keeping all three Agent modes selectable', () => {
  render(<SkillChatWorkbench {...props} />);
  fireEvent.change(screen.getByLabelText('Agent 模式'), { target: { value: 'chat' } });
  fireEvent.click(screen.getByRole('button', { name: '历史对话' }));
  expect(screen.getByRole('dialog', { name: '历史对话' })).toBeVisible();
  expect(screen.getByLabelText('Agent 模式')).toBeVisible();
  expect(screen.getByLabelText('Agent 模式').querySelectorAll('option')).toHaveLength(3);
});
it('keeps selected reference chips when preparing a storyboard shortcut', () => {
  render(<SkillChatWorkbench {...props} />);
  fireEvent.change(screen.getByLabelText('Agent 模式'), { target: { value: 'chat' } });
  fireEvent.change(screen.getByLabelText('向 Agent 发送消息'), { target: { value: '@' } });
  fireEvent.click(screen.getByRole('menuitem', { name: 'Mention 红色产品' }));
  fireEvent.click(screen.getByRole('button', { name: '一句话生成分镜' }));
  expect(screen.getByLabelText('向 Agent 发送消息')).toHaveTextContent('分镜');
  expect(screen.getByLabelText('Selected image references')).toHaveTextContent('红色产品');
  expect(props.chat).not.toHaveBeenCalled();
});
