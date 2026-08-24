# 画布可靠性、视频结果、模型与性能实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**目标：** 修复历史记录白屏、视频结果数量错误、模型链路不完整、Agent 错误提示、设置错位和画布交互卡顿，并提供可由用户手动验收的新测试页面。

**实现方式：** 保留现有 React Flow、Zustand 和桌面桥接结构，在历史入口增加能力边界；把视频参考素材与真实结果列表分离；让模型发现与节点选择器使用同一组持久化配置；按动画帧合并视口更新。所有修改先写失败测试，再实施最小修复。

**技术栈：** React、TypeScript、Zustand、React Flow、Vitest、Testing Library、Playwright、Electron 预加载桥、Comfly Provider。

## 全局约束

- 不重置或覆盖工作区中已有的用户修改。
- 不编造 Comfly 模型标识，真实模型只能来自账户接口或已保存配置。
- 参考素材不能被当成生成结果。
- 生成前不显示空结果窗口；生成结果数量必须等于真实完成结果数量。
- 浏览器验收桥不能调用付费生成接口，也不能暴露密钥或本地路径。
- 浅色和深色主题必须使用相同的布局尺寸与交互规则。

---

### 任务 1：修复历史记录白屏并补齐受控空状态

**文件：**
- 修改：`apps/renderer/src/history/GenerationHistoryDrawer.tsx`
- 修改：`apps/renderer/src/history/GenerationHistoryDrawer.test.tsx`
- 修改：`apps/renderer/src/test-mode/e2e-harness.ts`
- 修改：`apps/renderer/src/test-mode/manual-acceptance-bridge.test.ts`
- 修改：`tests/e2e/generation-history-drawer.spec.ts`

**接口：**
- 使用现有 `window.novusDesktop?.history`。
- 新增组件内部判断 `typeof bridge?.list === 'function' && typeof bridge?.getCapacity === 'function'`。
- 浏览器验收桥提供返回空列表的完整只读历史接口。

- [ ] **步骤 1：增加历史桥不完整时的失败测试**

```tsx
it('keeps the workspace mounted when the history bridge is incomplete', async () => {
  window.novusDesktop = { history: { getCapacity: vi.fn() } } as unknown as typeof window.novusDesktop;
  render(<GenerationHistoryDrawer onClose={vi.fn()} />);
  expect(await screen.findByRole('status')).toHaveTextContent('当前环境暂不支持历史记录');
  expect(screen.getByTestId('history-drawer')).toBeVisible();
});
```

- [ ] **步骤 2：运行测试并确认因 `bridge.list is not a function` 失败**

运行：

```powershell
npm.cmd test -- apps/renderer/src/history/GenerationHistoryDrawer.test.tsx
```

预期：新增测试失败或组件抛出 `TypeError: bridge.list is not a function`。

- [ ] **步骤 3：实现历史能力守卫与浏览器空列表桥**

```ts
const canListHistory = typeof bridge?.list === 'function' && typeof bridge?.getCapacity === 'function';
if (!canListHistory) {
  setRecords([]);
  setCapacity(null);
  setTotal(0);
  setNextCursor(null);
  setError('当前环境暂不支持历史记录');
  setLoading(false);
  return;
}
```

浏览器验收桥中的 `history` 至少实现 `list`、`getCapacity`、`compare`、`setFavorite`、`trash`、`restore`、`permanentlyDelete`、`exportSelected` 和 `getReusableSummary`，未使用操作返回安全空结果。

- [ ] **步骤 4：运行组件和浏览器历史测试**

```powershell
npm.cmd test -- apps/renderer/src/history/GenerationHistoryDrawer.test.tsx apps/renderer/src/test-mode/manual-acceptance-bridge.test.ts
$env:NOVUS_E2E_PORT='43164'; npm.cmd exec playwright test tests/e2e/generation-history-drawer.spec.ts
```

预期：历史面板可见、空状态可见、工作区不卸载、无页面异常。

- [ ] **步骤 5：提交本任务文件**

```powershell
git add apps/renderer/src/history/GenerationHistoryDrawer.tsx apps/renderer/src/history/GenerationHistoryDrawer.test.tsx apps/renderer/src/test-mode/e2e-harness.ts apps/renderer/src/test-mode/manual-acceptance-bridge.test.ts tests/e2e/generation-history-drawer.spec.ts
git commit -m "fix: prevent history drawer from blanking canvas"
```

### 任务 2：让视频预览严格来自真实完成结果

**文件：**
- 新建：`apps/renderer/src/canvas/video-generation-results.ts`
- 新建：`apps/renderer/src/canvas/video-generation-results.test.ts`
- 修改：`apps/renderer/src/canvas/ModuleNodeCard.tsx`
- 修改：`apps/renderer/src/canvas/ModuleNodeCard.test.tsx`
- 修改：`apps/renderer/src/app/app-store.ts`
- 修改：`apps/renderer/src/app/app-store.test.ts`
- 修改：`tests/e2e/video-generation-ui.spec.ts`

**接口：**

```ts
export interface VideoGenerationResultItem {
  readonly assetId: string;
  readonly mediaType: string;
  readonly durationMs: number;
  readonly posterUrl?: string;
}

export function readVideoGenerationResults(config: Record<string, unknown>): VideoGenerationResultItem[];
```

节点配置使用 `videoResults` 数组保存真实完成结果；`outputCount` 只表示请求数量，不能控制结果网格长度。

- [ ] **步骤 1：增加 0 至 4 个真实视频结果的失败测试**

```ts
it.each([0, 1, 2, 3, 4])('renders exactly %i completed video previews', (count) => {
  const node = videoNode({ outputCount: 4, videoResults: createVideoResults(count) });
  renderNode(node);
  expect(screen.queryAllByLabelText(/Generated video preview/)).toHaveLength(count);
});
```

并断言只有连接素材、没有 `videoResults` 时结果预览数量为 0，素材缩略图只出现在 `Video editor reference slots`。

- [ ] **步骤 2：运行测试并确认当前代码按 `outputCount` 复制封面而失败**

```powershell
npm.cmd test -- apps/renderer/src/canvas/ModuleNodeCard.test.tsx apps/renderer/src/canvas/video-generation-results.test.ts
```

预期：请求数量为 4、真实结果为 1 时，当前实现错误地渲染 4 个预览。

- [ ] **步骤 3：实现结果读取器并替换 `Array.from({ length: outputCount })`**

```tsx
const completedVideoResults = readVideoGenerationResults(config);
const hasCompletedResult = completedVideoResults.length > 0;

{completedVideoResults.length > 0 && (
  <div className={`module-node__generation-preview-gallery module-node__generation-preview-gallery--${Math.min(completedVideoResults.length, 4)}`}>
    {completedVideoResults.slice(0, 4).map((item, index) => (
      <VideoGenerationPreview key={item.assetId} item={item} index={index} />
    ))}
  </div>
)}
```

离线模拟运行时按实际完成的模拟任务写入唯一 `assetId` 的 `videoResults`；单个任务只写入一个结果，不能根据旧状态复制参考封面。

- [ ] **步骤 4：运行视频节点、状态存储和 E2E 测试**

```powershell
npm.cmd test -- apps/renderer/src/canvas/video-generation-results.test.ts apps/renderer/src/canvas/ModuleNodeCard.test.tsx apps/renderer/src/app/app-store.test.ts
$env:NOVUS_E2E_PORT='43165'; npm.cmd exec playwright test tests/e2e/video-generation-ui.spec.ts
```

预期：零结果无窗口；一项只显示一个；四项才显示四宫格；图槽仍显示连接素材。

- [ ] **步骤 5：提交本任务文件**

```powershell
git add apps/renderer/src/canvas/video-generation-results.ts apps/renderer/src/canvas/video-generation-results.test.ts apps/renderer/src/canvas/ModuleNodeCard.tsx apps/renderer/src/canvas/ModuleNodeCard.test.tsx apps/renderer/src/app/app-store.ts apps/renderer/src/app/app-store.test.ts tests/e2e/video-generation-ui.spec.ts
git commit -m "fix: render only completed video results"
```

### 任务 3：打通 Comfly 模型发现、启用和节点选择器

**文件：**
- 修改：`apps/renderer/src/settings/SettingsDrawer.tsx`
- 修改：`apps/renderer/src/settings/SettingsDrawer.test.tsx`
- 修改：`packages/provider-comfly/src/client.ts`
- 修改：`packages/provider-comfly/src/client.test.ts`
- 修改：`packages/desktop-core/src/provider-bridge.ts`
- 修改：`packages/desktop-core/src/provider-bridge.test.ts`
- 修改：`apps/renderer/src/canvas/ModuleNodeCard.test.tsx`
- 修改：`apps/renderer/src/agent/SkillChatWorkbench.test.tsx`

**接口：**
- `provider.listAvailableModelIds(): Promise<string[]>` 返回账户真实模型标识。
- `provider.updateProfiles({ profiles })` 保存启用模型和默认路由。
- 默认路由固定为 `image-default`、`video-default`、`reverse-default`、`chat-default`。

- [ ] **步骤 1：增加真实模型分组和四个选择器的失败测试**

```ts
expect(groupAvailableModels([
  'gpt-image-1',
  'seedance-1.5-pro',
  'gemini-vision-pro',
  'gpt-5-chat',
])).toEqual(expect.arrayContaining([
  expect.objectContaining({ route: 'image-default', models: ['gpt-image-1'] }),
  expect.objectContaining({ route: 'video-default', models: ['seedance-1.5-pro'] }),
  expect.objectContaining({ route: 'reverse-default', models: ['gemini-vision-pro'] }),
  expect.objectContaining({ route: 'chat-default', models: expect.arrayContaining(['gpt-5-chat']) }),
]));
```

保存后分别断言生图、视频、反推和 Agent 模型下拉框包含对应显示名称。

- [ ] **步骤 2：运行设置、Provider 和节点测试确认失败**

```powershell
npm.cmd test -- apps/renderer/src/settings/SettingsDrawer.test.tsx packages/provider-comfly/src/client.test.ts packages/desktop-core/src/provider-bridge.test.ts apps/renderer/src/canvas/ModuleNodeCard.test.tsx apps/renderer/src/agent/SkillChatWorkbench.test.tsx
```

预期：视觉语言模型目前同时进入普通对话和反推分组，或保存后节点路由没有同步。

- [ ] **步骤 3：实现模型能力分类与可区分状态**

```ts
const imagePattern = /(image|banana|flux|dall|recraft|ideogram|sdxl|nano)/iu;
const videoPattern = /(video|veo|sora|kling|wan|seedance|hailuo|minimax)/iu;
const visionPattern = /(vision|gemini|qwen-vl|vl-|multimodal)/iu;
```

视频优先于图片，图片优先于视觉语言；反推组使用视觉语言模型；普通对话组使用剩余语言模型。接口失败保留错误类型，不用空数组掩盖身份验证或网络错误。保存成功后重新调用 `listProfiles()` 并更新应用 Provider 状态。

- [ ] **步骤 4：运行全部模型链路测试**

```powershell
npm.cmd test -- apps/renderer/src/settings/SettingsDrawer.test.tsx packages/provider-comfly/src/client.test.ts packages/desktop-core/src/provider-bridge.test.ts apps/renderer/src/canvas/ModuleNodeCard.test.tsx apps/renderer/src/agent/SkillChatWorkbench.test.tsx
```

预期：四组模型列表和默认项正确；没有虚构模型；各节点选择器可用。

- [ ] **步骤 5：提交本任务文件**

```powershell
git add apps/renderer/src/settings/SettingsDrawer.tsx apps/renderer/src/settings/SettingsDrawer.test.tsx packages/provider-comfly/src/client.ts packages/provider-comfly/src/client.test.ts packages/desktop-core/src/provider-bridge.ts packages/desktop-core/src/provider-bridge.test.ts apps/renderer/src/canvas/ModuleNodeCard.test.tsx apps/renderer/src/agent/SkillChatWorkbench.test.tsx
git commit -m "fix: synchronize Comfly model selections"
```

### 任务 4：修复 Agent 初始错误提示

**文件：**
- 修改：`apps/renderer/src/agent/SkillChatWorkbench.tsx`
- 修改：`apps/renderer/src/agent/SkillChatWorkbench.test.tsx`

**接口：**
- `error` 只由用户素材操作或请求失败设置。
- 模型变化到支持视觉能力时清除视觉能力错误。

- [ ] **步骤 1：增加初始无错误和切换模型清错测试**

```tsx
it('does not show a media capability warning before a media action', () => {
  renderWorkbench({ profiles: [textOnlyProfile] });
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('clears the media warning after selecting a vision model', () => {
  renderWorkbench({ profiles: [textOnlyProfile, visionProfile] });
  pasteReferenceImage();
  selectAgentModel('Vision chat');
  expect(screen.queryByText(/当前模型不支持图片或视频/)).not.toBeInTheDocument();
});
```

- [ ] **步骤 2：运行测试确认当前错误状态会残留**

```powershell
npm.cmd test -- apps/renderer/src/agent/SkillChatWorkbench.test.tsx
```

- [ ] **步骤 3：增加模型变化时的定向清理逻辑**

```ts
useEffect(() => {
  if (selectedProfile?.capabilities.includes('vision')) {
    setError((current) => current === MEDIA_CAPABILITY_ERROR ? null : current);
  }
}, [selectedProfile]);
```

将图片和视频不兼容提示统一为常量 `MEDIA_CAPABILITY_ERROR`，组件初始化期间不设置该错误。

- [ ] **步骤 4：运行 Agent 组件测试**

```powershell
npm.cmd test -- apps/renderer/src/agent/SkillChatWorkbench.test.tsx
```

预期：初始无警告；实际素材操作触发警告；切换视觉模型清除警告。

- [ ] **步骤 5：提交本任务文件**

```powershell
git add apps/renderer/src/agent/SkillChatWorkbench.tsx apps/renderer/src/agent/SkillChatWorkbench.test.tsx
git commit -m "fix: show Agent media errors only on action"
```

### 任务 5：统一高级故障排查样式

**文件：**
- 修改：`apps/renderer/src/styles/figma-hybrid-canvas.css`
- 修改：`apps/renderer/src/settings/SettingsDrawer.test.tsx`
- 修改：`tests/e2e/current-settings-ui.spec.ts`

**接口：**
- 仅在 `.workspace--ui-gate` 内覆盖。
- `.settings-diagnostics-grid` 使用响应式两列或一列布局。
- `.settings-status-card` 取消旧版最小高度与超大字体。

- [ ] **步骤 1：增加样式契约和浅深色截图失败断言**

```ts
expect(css).toMatch(/settings-advanced-diagnostics[\s\S]*font-size:\s*14px/);
expect(css).toMatch(/settings-status-card[\s\S]*min-height:\s*0/);
expect(css).toMatch(/settings-connection-row[\s\S]*align-items:\s*center/);
```

E2E 检查“连接与恢复”卡片高度不超过 260px，按钮与状态文字在同一行。

- [ ] **步骤 2：运行设置测试确认旧规则仍撑大卡片**

```powershell
npm.cmd test -- apps/renderer/src/settings/SettingsDrawer.test.tsx
$env:NOVUS_E2E_PORT='43166'; npm.cmd exec playwright test tests/e2e/current-settings-ui.spec.ts
```

- [ ] **步骤 3：在样式文件末尾添加最终限定规则**

```css
.workspace--ui-gate .settings-advanced-diagnostics { font-size: 14px; }
.workspace--ui-gate .settings-diagnostics-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.workspace--ui-gate .settings-status-card { min-height: 0; padding: 16px; gap: 12px; }
.workspace--ui-gate .settings-status-card header strong { font-size: 16px; line-height: 1.35; }
.workspace--ui-gate .settings-status-card input { height: 40px; font-size: 14px; }
.workspace--ui-gate .settings-connection-row { align-items: center; justify-content: flex-start; gap: 12px; }
```

- [ ] **步骤 4：运行设置测试并截取浅色、深色页面**

```powershell
npm.cmd test -- apps/renderer/src/settings/SettingsDrawer.test.tsx
$env:NOVUS_E2E_PORT='43166'; npm.cmd exec playwright test tests/e2e/current-settings-ui.spec.ts
```

- [ ] **步骤 5：提交本任务文件**

```powershell
git add apps/renderer/src/styles/figma-hybrid-canvas.css apps/renderer/src/settings/SettingsDrawer.test.tsx tests/e2e/current-settings-ui.spec.ts
git commit -m "fix: normalize settings diagnostics layout"
```

### 任务 6：合并高频视口更新并验证画布流畅性

**文件：**
- 修改：`apps/renderer/src/canvas/use-viewport-culling.ts`
- 修改：`apps/renderer/src/canvas/use-viewport-culling.test.ts`
- 修改：`apps/renderer/src/canvas/use-interaction-quality.ts`
- 新建：`apps/renderer/src/canvas/use-interaction-quality.test.tsx`
- 修改：`apps/renderer/src/canvas/CanvasWorkspace.tsx`
- 修改：`tests/e2e/durable-canvas-stress.spec.ts`

**接口：**
- `handleViewportChange` 保持现有签名。
- 待发布视口保存在 ref 中，通过 `requestAnimationFrame` 每帧最多发布一次。
- 组件卸载时取消待执行动画帧。

- [ ] **步骤 1：增加动画帧合并失败测试**

```ts
act(() => {
  result.current.handleViewportChange(null, { x: 10, y: 20, zoom: 1 });
  result.current.handleViewportChange(null, { x: 30, y: 40, zoom: 1.2 });
  result.current.handleViewportChange(null, { x: 50, y: 60, zoom: 1.4 });
});
expect(result.current.viewport).toEqual({ x: 0, y: 0, zoom: 1 });
flushAnimationFrame();
expect(result.current.viewport).toEqual({ x: 50, y: 60, zoom: 1.4 });
```

同时断言交互已为 `true` 时重复 `markInteraction()` 不重复切换 React 布尔状态。

- [ ] **步骤 2：运行性能 Hook 测试确认每次移动都会立即更新**

```powershell
npm.cmd test -- apps/renderer/src/canvas/use-viewport-culling.test.ts apps/renderer/src/canvas/use-interaction-quality.test.tsx
```

- [ ] **步骤 3：实现 `requestAnimationFrame` 合并和稳定交互状态**

```ts
const pendingViewportRef = useRef<Viewport | null>(null);
const frameRef = useRef<number | null>(null);
const handleViewportChange = useCallback((_event, nextViewport) => {
  pendingViewportRef.current = nextViewport;
  if (frameRef.current !== null) return;
  frameRef.current = requestAnimationFrame(() => {
    frameRef.current = null;
    const pending = pendingViewportRef.current;
    if (pending) publishViewport(pending);
  });
}, [publishViewport]);
```

`useInteractionQuality` 使用 ref 记录当前交互状态，只在 `false → true` 和 `true → false` 时调用 `setIsInteracting`。

- [ ] **步骤 4：运行 Hook、工作区和压力测试**

```powershell
npm.cmd test -- apps/renderer/src/canvas/use-viewport-culling.test.ts apps/renderer/src/canvas/use-interaction-quality.test.tsx apps/renderer/src/canvas/CanvasWorkspace.test.tsx
$env:NOVUS_E2E_PORT='43167'; npm.cmd exec playwright test tests/e2e/durable-canvas-stress.spec.ts
```

预期：快速平移缩放无页面错误，节点拖动停止后持久化，框选与连线仍可用。

- [ ] **步骤 5：提交本任务文件**

```powershell
git add apps/renderer/src/canvas/use-viewport-culling.ts apps/renderer/src/canvas/use-viewport-culling.test.ts apps/renderer/src/canvas/use-interaction-quality.ts apps/renderer/src/canvas/use-interaction-quality.test.tsx apps/renderer/src/canvas/CanvasWorkspace.tsx tests/e2e/durable-canvas-stress.spec.ts
git commit -m "perf: coalesce canvas interaction updates"
```

### 任务 7：整体验证与用户测试页面

**文件：**
- 修改：`tests/e2e/manual-acceptance-interactions.spec.ts`
- 新建：`artifacts/2026-08-08-canvas-reliability/light-canvas.png`
- 新建：`artifacts/2026-08-08-canvas-reliability/dark-canvas.png`
- 新建：`artifacts/2026-08-08-canvas-reliability/history-empty.png`
- 新建：`artifacts/2026-08-08-canvas-reliability/video-one-result.png`
- 新建：`artifacts/2026-08-08-canvas-reliability/video-four-results.png`
- 新建：`artifacts/2026-08-08-canvas-reliability/settings-diagnostics.png`

- [ ] **步骤 1：补充完整浏览器验收测试**

测试必须依次点击历史、关闭历史、打开设置、检查模型列表、打开 Agent、验证初始无红色错误、连接素材、展开视频节点，并验证一项和四项真实结果的预览数量。

- [ ] **步骤 2：运行类型检查和相关组件测试**

```powershell
npm.cmd run typecheck
npm.cmd test -- apps/renderer/src/history/GenerationHistoryDrawer.test.tsx apps/renderer/src/canvas/video-generation-results.test.ts apps/renderer/src/canvas/ModuleNodeCard.test.tsx apps/renderer/src/settings/SettingsDrawer.test.tsx apps/renderer/src/agent/SkillChatWorkbench.test.tsx apps/renderer/src/canvas/use-viewport-culling.test.ts apps/renderer/src/canvas/use-interaction-quality.test.tsx
```

预期：退出码为 0，无未处理异常。

- [ ] **步骤 3：运行浏览器验收套件**

```powershell
$env:NOVUS_E2E_PORT='43168'; npm.cmd exec playwright test tests/e2e/generation-history-drawer.spec.ts tests/e2e/video-generation-ui.spec.ts tests/e2e/current-settings-ui.spec.ts tests/e2e/manual-acceptance-interactions.spec.ts tests/e2e/durable-canvas-stress.spec.ts
```

预期：全部通过，控制台没有 `pageerror`。

- [ ] **步骤 4：启动新的用户测试页面并截图**

```powershell
npm.cmd run dev -w @agent-canvas/renderer -- --host 127.0.0.1 --port 43168 --strictPort --configLoader runner
```

测试地址：`http://127.0.0.1:43168/?novusHarness=novus-e2e-codex-ui-gate`。

- [ ] **步骤 5：只在验证结果真实通过后交付**

交付内容必须明确区分：自动测试通过项、浏览器截图、用户仍需手动验证的真实 Comfly API 调用。安装包不在本轮生成。