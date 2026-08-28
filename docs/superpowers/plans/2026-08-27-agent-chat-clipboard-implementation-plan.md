# Agent 对话复制粘贴实施计划

> **供自动化开发执行者使用：** 必须逐任务使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans`。使用复选框跟踪每一步。

**目标：** 让整个 Agent 对话区可以原生复制可见内容，并让输入框可靠粘贴多行文字、富文本、图片、视频和混合载荷，同时隔离画布快捷键。

**架构：** 新增一个无 UI 依赖的剪贴板解析模块，负责文字归一化、媒体有序提取和去重；`SkillChatWorkbench` 只负责光标插入、受管文件导入和引用状态更新。Agent 工作台根节点形成事件边界，消息区通过最终样式契约保持原生文字选择。

**技术栈：** React 18、TypeScript、Vitest、Testing Library、Playwright、Electron 桌面桥接。

## 全局约束

- 直接使用 `E:\画布项目\staging-canvas-build` 现有脏工作区，不新建副本，不执行 reset 或 clean。
- 只修改本计划列出的 Agent 剪贴板相关文件及 `docs/project-memory.md`，保留所有无关修改。
- 所有生产代码必须先有能够正确失败的回归测试。
- 复制内容不得合成供应商密钥、内部元数据或受管文件本地路径。
- 粘贴成功不得绕过既有模型路由媒体能力门禁。
- 多媒体导入必须保持剪贴板顺序；后续失败不得回滚之前成功的附件。
- 未取得新鲜验证证据前，不声明修复完成，也不生成新安装包。

---

## 文件结构

- 新建 `apps/renderer/src/agent/agent-chat-clipboard.ts`：解析剪贴板文字和有序媒体，不访问 React 状态或桌面桥。
- 新建 `apps/renderer/src/agent/agent-chat-clipboard.test.ts`：覆盖纯文本、HTML 回退、文件 items、去重和顺序。
- 修改 `apps/renderer/src/agent/SkillChatWorkbench.tsx`：在光标处插入文字、顺序导入媒体、建立工作台事件边界。
- 修改 `apps/renderer/src/agent/SkillChatWorkbench.test.tsx`：覆盖混合粘贴、异步导入、部分失败和能力门禁。
- 修改 `apps/renderer/src/styles/app.css` 与 `apps/renderer/src/main.styles.test.ts`：保护消息文字选择的最终样式契约。
- 修改 `apps/renderer/src/canvas/CanvasWorkspace.test.tsx`：证明 Agent 内剪贴板事件不会触发画布快捷键。
- 修改 `tests/e2e/agent-chat-image-picker.spec.ts`：覆盖真实输入框多媒体粘贴及有序引用。
- 修改 `docs/project-memory.md`：记录根因、保护行为和验证证据。

### 任务 1：纯剪贴板解析器

**文件：**
- 新建：`apps/renderer/src/agent/agent-chat-clipboard.ts`
- 新建：`apps/renderer/src/agent/agent-chat-clipboard.test.ts`

**接口：**

```ts
export type AgentChatClipboardMedia = {
  readonly file: File;
  readonly kind: 'image' | 'video';
};

export type AgentChatClipboardPayload = {
  readonly text: string;
  readonly media: readonly AgentChatClipboardMedia[];
};

export function readAgentChatClipboard(dataTransfer: DataTransfer): AgentChatClipboardPayload;
```

- [ ] **步骤 1：写解析器红灯测试**

```ts
it('按 items 顺序读取所有受支持文件且不重复', () => {
  const image = new File(['image'], 'one.png', { type: 'image/png' });
  const video = new File(['video'], 'two.mp4', { type: 'video/mp4' });
  const data = {
    files: [image, video],
    items: [
      { kind: 'file', type: image.type, getAsFile: () => image },
      { kind: 'file', type: video.type, getAsFile: () => video },
    ],
    getData: (type: string) => type === 'text/plain' ? '第一行\n第二行' : '',
  } as unknown as DataTransfer;

  expect(readAgentChatClipboard(data)).toEqual({
    text: '第一行\n第二行',
    media: [
      { file: image, kind: 'image' },
      { file: video, kind: 'video' },
    ],
  });
});

it('仅在没有纯文本时使用 HTML 可读文字', () => {
  const data = {
    files: [],
    items: [],
    getData: (type: string) => type === 'text/html' ? '<p>第一行</p><p>第二行<br>第三行</p>' : '',
  } as unknown as DataTransfer;
  expect(readAgentChatClipboard(data).text).toBe('第一行\n第二行\n第三行');
});
```

- [ ] **步骤 2：运行测试并确认正确红灯**

```powershell
npm.cmd exec vitest -- --config vitest.config.ts apps/renderer/src/agent/agent-chat-clipboard.test.ts --run
```

预期：FAIL，原因是新模块或导出函数尚不存在，而不是测试环境或语法错误。

- [ ] **步骤 3：实现最小解析器**

```ts
export function readAgentChatClipboard(data: DataTransfer): AgentChatClipboardPayload {
  const plain = data.getData('text/plain');
  const text = plain || htmlToReadableText(data.getData('text/html'));
  const candidates = data.items.length > 0
    ? [...data.items].map((item) => item.kind === 'file' ? item.getAsFile() : null)
    : [...data.files];
  const seen = new Set<File>();
  const media: AgentChatClipboardMedia[] = [];

  for (const file of candidates) {
    if (file === null || seen.has(file)) continue;
    seen.add(file);
    const kind = file.type.startsWith('image/') ? 'image'
      : file.type.startsWith('video/') ? 'video'
        : undefined;
    if (kind !== undefined) media.push({ file, kind });
  }
  return { text, media };
}
```

`htmlToReadableText` 使用 `DOMParser`，把 `br` 与块级边界转成换行，再读取 `textContent`；不得执行或保留 HTML。

- [ ] **步骤 4：重跑步骤 2，确认全部 PASS、0 失败**

- [ ] **步骤 5：仅提交本任务文件**

```powershell
git add -- apps/renderer/src/agent/agent-chat-clipboard.ts apps/renderer/src/agent/agent-chat-clipboard.test.ts
git commit -m "feat: parse agent chat clipboard payloads"
```

### 任务 2：输入框完整粘贴与顺序导入

**文件：**
- 修改：`apps/renderer/src/agent/SkillChatWorkbench.tsx`
- 修改：`apps/renderer/src/agent/SkillChatWorkbench.test.tsx`

**消费接口：** `readAgentChatClipboard(dataTransfer)`；复用现有 `importReferenceFile(file)` 受管文件流程。

- [ ] **步骤 1：写混合粘贴红灯测试**

```tsx
it('在光标处粘贴多行文字并按顺序导入全部媒体', async () => {
  const image = new File(['one'], 'one.png', { type: 'image/png' });
  const video = new File(['two'], 'two.mp4', { type: 'video/mp4' });
  const onImportReferenceImage = vi.fn().mockResolvedValue({
    assetId: 'managed-image', label: 'one.png', displayUrl: 'novus-asset://managed-image',
  });
  const onImportReferenceVideo = vi.fn().mockResolvedValue({
    assetId: 'managed-video', label: 'two.mp4', displayUrl: 'novus-asset://managed-video',
  });
  renderWorkbench({
    profiles: [{ ...profiles[0]!, capabilities: ['chat', 'vision'] }],
    onImportReferenceImage,
    onImportReferenceVideo,
  });
  const composer = screen.getByTestId('agent-composer-input');
  await userEvent.type(composer, '前缀 后缀');
  composer.setSelectionRange(3, 3);

  fireEvent.paste(composer, { clipboardData: {
    files: [image, video],
    items: [],
    getData: (type: string) => type === 'text/plain' ? '第一行\n第二行' : '',
  } });

  await waitFor(() => expect(onImportReferenceVideo).toHaveBeenCalledWith(video));
  expect(onImportReferenceImage).toHaveBeenCalledWith(image);
  expect(onImportReferenceImage.mock.invocationCallOrder[0])
    .toBeLessThan(onImportReferenceVideo.mock.invocationCallOrder[0]!);
  expect(composer).toHaveValue(expect.stringMatching(/前缀第一行\n第二行.*@图片1.*@视频1.* 后缀/));
});
```

- [ ] **步骤 2：运行组件测试并确认正确红灯**

```powershell
npm.cmd exec vitest -- --config vitest.config.ts apps/renderer/src/agent/SkillChatWorkbench.test.tsx --run
```

预期：现有实现只导入第一个媒体，或混合文字未插入，因此 FAIL。

- [ ] **步骤 3：实现最小顺序导入**

```ts
const handleComposerPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
  const payload = readAgentChatClipboard(event.clipboardData);
  if (payload.media.length === 0) return;

  event.preventDefault();
  event.stopPropagation();
  const start = event.currentTarget.selectionStart;
  const end = event.currentTarget.selectionEnd;
  if (payload.text.length > 0) {
    setComposer((current) => insertComposerText(current, payload.text, start, end));
  }
  void importPastedReferencesInOrder(payload.media.map(({ file }) => file));
};
```

`importPastedReferencesInOrder` 使用 `for...of` 和 `await`，每次成功后沿用现有引用编号；状态更新必须使用函数式 `setComposer(current => ...)`，不能覆盖导入期间的新输入。

- [ ] **步骤 4：写部分失败红灯并补齐错误行为**

```tsx
it('后续附件失败时保留此前成功引用', async () => {
  const onImportReferenceImage = vi.fn().mockResolvedValue({
    assetId: 'managed-image', label: 'one.png', displayUrl: 'novus-asset://managed-image',
  });
  const onImportReferenceVideo = vi.fn().mockRejectedValue(new Error('manage failed'));
  renderWorkbench({
    profiles: [{ ...profiles[0]!, capabilities: ['chat', 'vision'] }],
    onImportReferenceImage,
    onImportReferenceVideo,
  });
  fireEvent.paste(screen.getByTestId('agent-composer-input'), {
    clipboardData: { files: [imageFile, videoFile], items: [], getData: () => '' },
  });
  await screen.findByText(/manage failed|导入失败/i);
  expect(screen.getByRole('textbox', { name: /消息|输入/i }))
    .toHaveValue(expect.stringContaining('@图片1'));
});
```

先运行步骤 2 确认红灯，再实现逐文件错误记录并继续处理，最后确认绿灯。

- [ ] **步骤 5：验证既有模型能力门禁**

```powershell
npm.cmd exec vitest -- --config vitest.config.ts apps/renderer/src/agent/SkillChatWorkbench.test.tsx apps/renderer/src/agent/agent-media-capability.test.ts packages/desktop-core/src/provider-skill-chat.test.ts --run
```

预期：全部 PASS；普通非视觉路由仍拒绝媒体，Codex chat/responses 仍允许受管引用。

- [ ] **步骤 6：仅提交本任务文件**

```powershell
git add -- apps/renderer/src/agent/SkillChatWorkbench.tsx apps/renderer/src/agent/SkillChatWorkbench.test.tsx
git commit -m "feat: support complete agent chat paste"
```

### 任务 3：消息复制、文字选择与画布事件隔离

**文件：**
- 修改：`apps/renderer/src/agent/SkillChatWorkbench.tsx`
- 修改：`apps/renderer/src/agent/SkillChatWorkbench.test.tsx`
- 修改：`apps/renderer/src/styles/app.css`
- 修改：`apps/renderer/src/main.styles.test.ts`
- 修改：`apps/renderer/src/canvas/CanvasWorkspace.test.tsx`

- [ ] **步骤 1：写事件隔离红灯测试**

```tsx
it('剪贴板事件保持在 Agent 工作台内部', () => {
  const outerCopy = vi.fn();
  const outerPaste = vi.fn();
  renderWorkbench();
  const workbench = screen.getByLabelText('Agent 对话工作台');
  workbench.parentElement!.addEventListener('copy', outerCopy);
  workbench.parentElement!.addEventListener('paste', outerPaste);
  fireEvent.copy(screen.getByLabelText('Agent 消息流'));
  fireEvent.paste(screen.getByTestId('agent-composer-input'), {
    clipboardData: { files: [], items: [], getData: () => '内容' },
  });
  expect(outerCopy).not.toHaveBeenCalled();
  expect(outerPaste).not.toHaveBeenCalled();
});
```

同时在 `main.styles.test.ts` 增加最终 CSS 契约：消息正文、代码和可见详情最终必须包含 `user-select: text`。

- [ ] **步骤 2：运行红灯测试**

```powershell
npm.cmd exec vitest -- --config vitest.config.ts apps/renderer/src/agent/SkillChatWorkbench.test.tsx apps/renderer/src/main.styles.test.ts apps/renderer/src/canvas/CanvasWorkspace.test.tsx --run
```

预期：外层仍收到事件，或最终 CSS 没有选择契约，因此 FAIL。

- [ ] **步骤 3：实现局部事件边界和最终样式**

```tsx
<section
  className="skill-chat-workbench"
  onCopy={(event) => event.stopPropagation()}
  onCut={(event) => event.stopPropagation()}
  onPaste={(event) => event.stopPropagation()}
>
  {content}
</section>
```

```css
.skill-chat-workbench__stream,
.skill-chat-workbench__message,
.skill-chat-workbench__reverse-entry,
.skill-chat-workbench__request-card,
.skill-chat-workbench__sources {
  -webkit-user-select: text;
  user-select: text;
}
```

- [ ] **步骤 4：重跑步骤 2，确认全部 PASS、0 失败**

- [ ] **步骤 5：仅提交本任务文件**

```powershell
git add -- apps/renderer/src/agent/SkillChatWorkbench.tsx apps/renderer/src/agent/SkillChatWorkbench.test.tsx apps/renderer/src/styles/app.css apps/renderer/src/main.styles.test.ts apps/renderer/src/canvas/CanvasWorkspace.test.tsx
git commit -m "fix: isolate agent chat clipboard events"
```

### 任务 4：真实流程回归与项目记忆

**文件：**
- 修改：`tests/e2e/agent-chat-image-picker.spec.ts`
- 修改：`docs/project-memory.md`

- [ ] **步骤 1：写真实输入框多媒体 E2E 红灯场景**

```ts
await composer.evaluate((element) => {
  const transfer = new DataTransfer();
  transfer.items.add(new File(['one'], 'one.png', { type: 'image/png' }));
  transfer.items.add(new File(['two'], 'two.mp4', { type: 'video/mp4' }));
  transfer.setData('text/plain', '同时分析这两个素材');
  element.dispatchEvent(new ClipboardEvent('paste', {
    clipboardData: transfer,
    bubbles: true,
    cancelable: true,
  }));
});
await expect(composer).toHaveValue(/同时分析这两个素材[\s\S]*@图片1[\s\S]*@视频1/);
```

- [ ] **步骤 2：运行 E2E 并确认正确红灯**

```powershell
npm.cmd exec playwright test tests/e2e/agent-chat-image-picker.spec.ts --workers=1
```

预期：在实现前因只处理一个媒体或丢失文字而 FAIL，而不是服务或夹具错误。

- [ ] **步骤 3：实现完成后重跑步骤 2，确认全部 PASS**

- [ ] **步骤 4：运行相关宽套件与类型检查**

```powershell
npm.cmd exec vitest -- --config vitest.config.ts apps/renderer/src/agent apps/renderer/src/canvas/CanvasWorkspace.test.tsx apps/renderer/src/main.styles.test.ts packages/desktop-core/src/provider-skill-chat.test.ts --run
npm.cmd run typecheck
```

- [ ] **步骤 5：运行完整验证**

```powershell
npm.cmd exec vitest -- --config vitest.config.ts --run
npm.cmd exec playwright test
npm.cmd run build
```

预期：Vitest 与 Playwright 0 失败，build 退出码 0；记录准确通过/跳过数量和非阻断警告。

- [ ] **步骤 6：更新项目记忆**

在 `docs/project-memory.md` 追加 2026-08-27 条目，写明：单文件读取导致多附件丢失的根因、Agent 局部事件边界、混合载荷顺序与部分失败契约、测试文件、实际运行命令和新鲜结果。未执行的打包冒烟必须明确标为未验证。

- [ ] **步骤 7：提交 E2E 与项目记忆**

```powershell
git add -- tests/e2e/agent-chat-image-picker.spec.ts docs/project-memory.md
git commit -m "test: protect agent chat clipboard workflow"
```

## 完成判定

- 对话区所有用户可见文字均可选中并原生复制。
- 输入框能在光标处粘贴多行文字、图片、视频和混合内容。
- 多媒体引用顺序稳定，异步导入不覆盖后续输入，部分失败不回滚成功项。
- Agent 内复制粘贴不会触发画布快捷键。
- 模型能力门禁、既有单图片与单视频粘贴行为无回归。
- 聚焦测试、相关宽套件、完整 Vitest、完整 Playwright、typecheck 和 build 均有本次执行的新鲜通过证据。
