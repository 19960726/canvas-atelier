# Agent / Codex UI、完整模型目录与媒体回归 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task in the current task. Steps use checkbox (`- [ ]`) syntax for tracking. 用户本次要求补充计划；此处不自动分派子代理或创建新任务。

**Goal:** 按本任务截图改进 Agent/Codex 对话，把 GPT-6 Astra 与 GPT-5.6 Sol 同时纳入模型目录和思考滑动条，并完成 20 图槽、@ 引用、拖动、全部节点与 MCP 自动化验收。

**Architecture:** 保留现有 SkillChatWorkbench、Codex CLI、Provider 和画布持久化链路。模型目录与思考选择独立于生成偏好；复用受管素材和 ConnectedAgentMediaSlots。先核对实际缺陷与最终 CSS，再做有失败回归证据的最小修复。

**Tech Stack:** TypeScript、React 19、Zustand、React Flow、Electron、Vitest、Testing Library、Playwright。

**Spec:** `docs/superpowers/specs/2026-09-06-agent-codex-ui-models-design.md`

## Global Constraints

- 工作目录固定为 `E:\画布项目\staging-canvas-build`，保留所有既有未提交和未跟踪文件。
- 本计划替代旧 Agent 计划中固定三档推理、九图槽与旧 CSS 追加方式；继续保留项目隔离、持久化和现有画布确认边界。
- Astra 与 Sol 必须同阶段核对并纳入目录，不把补齐 Sol 留成计划外后续选项。
- Extra High = xhigh；Ultra = ultra，仅按对应模型真实能力呈现，不统一转换为 max。
- 源码通过、模型目录返回、CLI 已安装、安装版显示、真实模型调用分别记账。
- 不覆盖账号配置或修改 Codex 的 models_cache.json 来制造模型可用性；测试使用隔离 fixture。
- 不自动发起付费重试，不绕过 WorkBuddy 信任审批；现有授权范围内的验证继续执行。
- 最终生产修改后重新构建、打包并核对实际安装位置与 app.asar 指纹，不能仅重启旧安装版。
- 保存失败/超时/冲突不得静默退出或丢弃当前 draft；关闭流程必须有可测试的取消、重试和明确放弃分支。
- 拖动位置、保存响应、启动 hydration 和 fitView 必须有 request/revision 证据；旧响应不得覆盖较新的用户拖动。
- 图片复制、视觉粘贴、Codex 媒体边界和 `@` 内联引用分别验收，不能用一个“复制成功”断言替代全部链路。
- 本轮新增 UI 几何要求：Agent 头部控件统一基线；composer 编辑区最小 96px、默认约 118px，底栏不遮挡文字；加号按钮和模型按钮共享中心线。
- Figma 相关代码只允许作为历史兼容/迁移标识保留；生产运行时和新增 CSS/组件使用通用 Canvas/React Flow 命名，任何迁移必须通过旧项目打开、保存和重开测试。

## 当前证据与未完成项

| 项目 | 本任务已知记录 | 后续要求 |
| --- | --- | --- |
| Astra 缓存缺失复现 | 缓存只有 Terra/Luna/5.5/Mini；缺少 Astra 和 Sol | 记录当前目录来源与账号，不推断缺失原因一定是过期 |
| Astra 初步补回 | 前一轮已改源码；服务 28/28、Renderer 聚焦 2/2、类型检查通过 | 补显式禁用/隐藏 Astra 的反例；核对调用路由；重新打包 |
| Sol 补齐 | 尚未完成 | 与 Astra 一起实施，不能只写 UI 名称 |
| 思考滑动条 | 当前仍为 select | 实现离散 range、模型对应档位、默认恢复和持久化 |
| 原始 UI/媒体/MCP 请求 | 有历史基础与测试文件 | 本计划任务 3–6 逐项获得新鲜证据 |

## Task 1：模型目录补全、状态与刷新

**Files:**
- 修改：`packages/desktop-core/src/codex-cli-service.ts`、`codex-cli-contract.ts`。
- 修改：`apps/desktop-modern/src/main.ts`、`apps/renderer/src/canvas/CanvasWorkspace.tsx`。
- 修改：`apps/renderer/src/agent/SkillChatWorkbench.tsx`、`apps/renderer/src/app/provider-profiles.ts`。
- 测试：上述目录内 `codex-cli-service.test.ts`、`SkillChatWorkbench.test.tsx`、`provider-profiles.test.ts`。

**Interfaces:** 消费官方目录的精确 ID、可见性、传输能力、支持档位与默认档位；通过现有 `codexCli.listProfiles()` 返回正常执行 profile。待同步的参考清单只用于 UI 状态，不能作为可执行 profile 注入服务。输出给请求层的 `modelRoute` 始终为 `codex/<modelId>`。

- [ ] 读取受支持的本机 Codex 目录接口说明，核对 Astra、Sol、Terra、Luna、5.5、5.4、5.4 Mini、5.2 和 Default；保存不含凭据的目录快照。参考清单是需求，账号权限需要证据。
- [ ] 先补以下失败回归：Astra/Sol 同时缺失、目录刷新失败、成功刷新增加新模型、同 ID 重复、账号切换、空/损坏缓存、Astra/Sol 明确隐藏或禁用。前一轮补回逻辑会复活显式不可用 Astra，必须被测试捕获。

```ts
// 在 codex-cli-service.test.ts 的现有 safeRunner 与临时目录 fixture 中使用。
await writeFile(catalogPath, JSON.stringify({ models: [
  { slug: 'gpt-6-astra', visibility: 'hide', supported_in_api: true },
  { slug: 'gpt-5.6-sol', visibility: 'list', supported_in_api: false },
  { slug: 'gpt-5.6-terra', visibility: 'list', supported_in_api: true },
] }));
const service = createCodexCliService({ executablePath: 'C:\\Codex\\codex.exe',
  modelCatalogPath: catalogPath, processRunner: safeRunner(),
  mcpServer: { command: 'C:\\Canvas\\Canvas.exe', args: [], env: {} } });
const models = await service.listProfiles();
expect(models.some(model => model.modelId === 'gpt-6-astra')).toBe(false);
expect(models.some(model => model.modelId === 'gpt-5.6-sol')).toBe(false);
```

- [ ] 运行 `npm.cmd exec -- vitest run packages/desktop-core/src/codex-cli-service.test.ts`，确认新反例确实失败。
- [ ] 收紧已有回退：先检查原始目录的显式否定；缺失项使用同账号最后成功目录或受支持接口刷新；Astra/Sol 无可用证据时保留 UI 待同步入口和刷新说明。不得把参考名单直接标为 installed/complete。保持现有 API/传输限制，不借补目录扩大调用能力。
- [ ] 对已确认可用的 Astra/Sol 分别通过真实服务函数加 mock runner 验证 CLI `-m`、stdin model 和返回 `modelRoute` 一致；Astra 选择不得发到 Sol，反之亦然。
- [ ] 运行服务、profile、Workbench 聚焦回归；新增状态若影响 IPC schema，同步验证 parser/preload/IPC，不能只测组件 props。

## Task 2：思考能力滑动条与会话保存

**Files:**
- 新建：`apps/renderer/src/agent/CodexReasoningPopover.tsx`、`CodexReasoningPopover.test.tsx`。
- 修改：`apps/renderer/src/agent/SkillChatWorkbench.tsx`、`skill-chat-session-store.ts` 及各自测试。
- 修改：`apps/renderer/src/styles/agent-workbench.css`，核对 `main.tsx` 的样式导入顺序。
- 浏览器验证：扩展 `tests/e2e/release-agent-layout.spec.ts`。

**Interfaces:** 新组件接收 `{ modelLabel, efforts, value, defaultValue, onChange, onClose }`；efforts/value/defaultValue 使用 `CodexReasoningEffort`。只把所选值交给 Workbench 的 `reasoningEffort`，不更换 `modelRoute`。

- [x] 已写 Astra/ Sol 的五档请求参数、缺少档位、默认复位、键盘边界与会话恢复测试；断言实际请求，而非只看文字。

```tsx
// 在现有 renderWorkbench / CODEX_ASTRA_PROFILE fixture 中使用。
const chat = vi.fn(async () => ({ message: 'OK', modelRoute: 'codex/gpt-6-astra', sources: [] }));
renderWorkbench({ profiles: [], chat, codexProfiles: [{ ...CODEX_ASTRA_PROFILE,
  supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultReasoningEffort: 'medium' }] });
fireEvent.click(screen.getByRole('tab', { name: 'Codex' }));
fireEvent.click(screen.getByRole('button', { name: '思考能力' }));
fireEvent.change(screen.getByRole('slider', { name: '思考能力' }), { target: { value: '3' } });
fireEvent.change(screen.getByTestId('agent-composer-input'), { target: { value: '读取画布' } });
fireEvent.click(screen.getByRole('button', { name: '发送' }));
await waitFor(() => expect(chat).toHaveBeenCalledWith(expect.objectContaining({
  modelRoute: 'codex/gpt-6-astra', reasoningEffort: 'xhigh',
})));
```

- [x] 已实现离散索引、`aria-valuetext`、默认复位、空/单档禁用和每模型子集。
- [x] 模型变化、会话恢复与请求层继续使用同一合法 effort，保留独立 `ultra`。
- [x] Edge 浏览器已在浅色、深色、800px 窄面板验证拖动、Home/End、Escape、互斥弹层、发送参数和边界。

## Task 3：图 1–6 与图 8 的完整 Agent 界面

**Files:** `apps/renderer/src/agent/SkillChatWorkbench.tsx`、`GenerationPreferencesSheet.tsx`、`generation-preferences.ts`、`apps/renderer/src/styles/agent-workbench.css`、`release-layout-contract.css` 及 Workbench/样式测试；`tests/e2e/release-agent-layout.spec.ts`。

**Interfaces:** 继续消费会话集合、模型目录和独立 generationPreferences；输出原有 chat、draftWorkflowFromAnalysis、executeCanvasAction 请求，不新增平行执行通道。

- [ ] 按规格第 2 节截图表逐项留当前截图和几何：标题/徽标/状态/任务选择、消息区、输入区、模型菜单、思考浮层、生成偏好。先复现重叠、溢出、Markdown 原文直接展示等具体问题。
- [ ] 写浏览器回归：标题文本与任务选择 bbox 不相交；模型菜单位于 viewport 内；底部发送按钮可点击；长模型名不挤掉控件；三种模式切换后不串参数。
- [ ] 实现“标题区 + 可滚动消息区 + 固定输入区”，消息显示附件和可恢复错误；模型使用紧凑列表，当前项对勾。思考浮层沿用 Task 2。
- [ ] 在最终生效的局部样式中修复，删除同一受影响规则的冲突来源；不得通过继续叠加全局 button/span 样式修图。保留节点的 38px 栏。
- [ ] 图 5 每个控件均绑定实际状态：自动/固定、普通/Skill/Agent、图片/视频；聊天模型与生成模型独立。中文/Auto/默认/回读数量如实现为设置，必须绑定实际字号/偏好/上下文行为，不留假按钮。
- [ ] 用 800、1024、1440px 窗口和浅/深主题执行 UI 回归，保留与原图一一对应的截图证据。

## Task 4：20 张素材缩略图与 @ 内联引用

**Files:** `apps/renderer/src/canvas/ConnectedAgentMediaSlots.tsx`、`ModuleNodeCard.tsx`、`apps/renderer/src/mentions/MediaMentionTextarea.tsx`、`media-mention-model.ts` 及同名测试；`tests/e2e/video-inset-and-twenty-slots.spec.ts`、`media-mention-chip.spec.ts`、`agent-chat-image-picker.spec.ts`。

**Interfaces:** 复用受管 assetId/displayUrl、连接顺序、canonical mention tokens 与既有重排回调；保持显示层和执行引用数量校验分离。

- [ ] 建立“全部节点类型 → 实际输入能力 → 图槽组件 → 20 图测试结果”表。对所有多图节点测试 0/1/6/7/12/20/21/25，单图/无媒体类型说明实际能力。
- [ ] 先增加真实 Chromium 失败用例：连接 20 张后逐一解码；滚到最后一张；损坏其中一张不能清空行；删除/重排/保存重开不串图。
- [ ] 修复资源 URL、错误状态或最终 overflow 的实际根因。有效图必须 loaded 且 naturalWidth > 0；错误占位单独计数，不能用占位数充当已显示图片数。保留超限连接，执行前明确提示。
- [ ] 在三个节点编辑器与 Agent 输入框复现 `前文 @图片1 后文`。断言 canonical value 没有新增换行、chip 为 inline、足够宽时文本与 chip 同行；用户主动 Enter 仍保留。
- [ ] 修复仅导致伪换行的 DOM/CSS/序列化来源，覆盖中文输入、任意光标插入、重复引用、删除、撤销和粘贴；按 assetId 检查引用对应图片。
- [ ] 执行上述组件和三个浏览器文件，分别记录展示数量、解码数量、滚动可达数量、保存重开数量。

## Task 5：素材节点选中与拖动、Agent 结果回写

**Files:** `apps/renderer/src/canvas/CanvasWorkspace.tsx`、`ModuleNodeCard.tsx`、`use-canvas-draft.ts`、`apps/renderer/src/app/app-store.ts`、`apps/renderer/src/agent/SkillChatWorkbench.tsx` 及相关测试；`tests/e2e/agent-reference-workflow.spec.ts`、`agent-job-retry.spec.ts`。

**Interfaces:** 节点拖动继续使用 React Flow changes 和现有持久化事务；Agent 只根据实际 node/job/run 身份回写所属会话。

- [ ] 先记录真实 pointer 操作的节点坐标、选中状态及保存后测量。覆盖缩略图/空白区拖动、折叠结果拖动、端口连线、内部编辑与播放。
- [ ] 增加失败回归：拖动后仍可见且坐标持久化；拖动不触发打开预览；内部控件不移动节点；槽位排序不改变节点位置。
- [ ] 仅对交互控件设 nodrag/nopan，不把整张素材节点禁拖；保留 width/height/measured 与选中状态，防止回写后隐藏。
- [ ] 重测意图分析 → 模型/方案选择 → 既有确认 → 节点执行 → 持久化结果 → 原会话回复；取消或切换任务后的迟到结果不得串入新任务。
- [ ] 用受控 executor 验证成功/失败/取消/重试；真实 Provider 调用独立记录，不把 mock 完成等同于线上成功。

## Task 5A：拖动坐标、自动归位与旧响应覆盖

**Files:**
- 修改：`apps/renderer/src/canvas/use-canvas-draft.ts`、`CanvasWorkspace.tsx`。
- 修改：`apps/renderer/src/app/app-store.ts`、`desktop-persistence.ts`。
- 测试：`apps/renderer/src/canvas/use-canvas-draft.test.tsx`、`apps/renderer/src/app/app-store.test.ts`、`tests/e2e/visual-layout.spec.ts`，新增 `tests/e2e/node-drag-persistence.spec.ts`。

**Interfaces:** React Flow 的 `NodeChange` 只负责实时 draft；`onNodeDragStop` 生成带 `projectId`、`baseRevision` 和递增 `commitToken` 的位置提交；合并 durable source 时，活动拖动节点和 pending token 的位置优先，旧响应只能更新 revision 不能覆盖位置。

- [ ] 写失败回归：拖动节点到 `{x: 720, y: 420}`，在 commit 延迟期间注入旧 source `{x: 120, y: 120}`，断言屏幕和 store 仍保持新坐标；commit 成功后重开仍是新坐标。
- [ ] 写失败回归：拖动后触发 fitView、窗口 resize、Agent 打开/关闭和第二次节点拖动，断言每一步都不调用自动布局覆盖用户坐标。
- [ ] 写失败回归：并发拖动两个选中节点，旧 commit 先返回、新 commit 后返回，断言按 token/revision 保留每个节点最后一次用户坐标。
- [ ] 在生产实现中把拖动 token 绑定到项目 ID 和 base revision；`mergeDurableNodes` 对 pending/active 节点保留 draft position，成功 ACK 只清理对应 token，失败 ACK 保留可重试状态并不回退视觉位置。
- [ ] 运行 `npm.cmd exec -- vitest run apps/renderer/src/canvas/use-canvas-draft.test.tsx apps/renderer/src/app/app-store.test.ts`，再运行 `npm.cmd exec -- playwright test tests/e2e/node-drag-persistence.spec.ts tests/e2e/visual-layout.spec.ts`。

## Task 5B：保存超时、保存失败和无法退出

**Files:**
- 修改：`apps/renderer/src/app/app-store.ts`、`apps/renderer/src/app/desktop-persistence.ts`。
- 修改：`packages/desktop-core/src/renderer-close-flush-contract.ts`、`apps/desktop-modern/src/main.ts`。
- 测试：`apps/renderer/src/app/app-store.test.ts`、`apps/renderer/src/canvas/CanvasWorkspace.test.tsx`、`packages/desktop-core/src/renderer-close-flush-contract.test.ts`，新增 `tests/e2e/project-save-failure-recovery.spec.ts` 和 `work/qa-installed-save-recovery.mjs`。

**Interfaces:** `saveProjectExplicitly(): Promise<boolean>` 和 `flushProjectSave(reason)` 必须在超时、拒绝、冲突时返回明确 false/typed error；close flush ACK 必须包含 `requestId`, `phase`, `reason`, `errorCode`, `canRetry`。主进程只在 `saved`、用户明确 `discarded` 或安全 `read_only` 状态后结束窗口。

- [ ] 写失败回归：让 commit Promise 永不完成，断言 15 秒超时转换为 `SAVE_TIMEOUT`，状态为 error、项目 draft 仍在 store、重试按钮可用，不能变成空项目。
- [ ] 写失败回归：模拟 `REVISION_CONFLICT`、磁盘写失败、项目目录锁定和 close ACK 丢失，分别断言取消退出会保留窗口与内容，重试会再次发起保存，只有明确放弃才退出。
- [ ] 写失败回归：保存成功后 `projectPersistenceClient.close()` 超时，断言不显示“保存失败”且不会阻止安全退出；保存本身未成功时 close 超时必须继续显示恢复选择。
- [ ] 修复 close coordinator 的状态机：保存期间禁用重复关闭请求但保留取消；超时不调用 `app.quit()`；恢复对话框的“放弃”必须显式记录 `discarded`，并在退出前停止 MCP/Provider 子进程。
- [ ] 保存后重开旧项目，比较 project revision、node IDs/positions、edges、assets、prompts、Agent references 和 generation results；任何字段丢失都阻断安装验收。
- [ ] 运行 focused Vitest，再运行 `node work/qa-installed-save-recovery.mjs <candidate-exe> <report-dir>`；报告必须包含 timeout/error/conflict/cancel/retry/discard 六个分支和进程清理结果。

## Task 5C：复制图片、媒体粘贴和模式切换能力状态

**Files:**
- 修改：`apps/renderer/src/agent/SkillChatWorkbench.tsx`、`agent-chat-clipboard.ts`、`agent-chat-paste-state.ts`。
- 修改：`packages/desktop-core/src/electron-clipboard-image.ts`、`bridge-handlers.ts` 以及 preload 类型（仅在证据确认 native 写入失败时）。
- 测试：`apps/renderer/src/agent/SkillChatWorkbench.test.tsx`、`agent-chat-clipboard.test.ts`、`tests/e2e/agent-chat-image-picker.spec.ts`，新增 `tests/e2e/agent-image-copy-and-mode-switch.spec.ts`。

**Interfaces:** `copySentImage(displayUrl)` 先走 `novusDesktop.projectImages.writeClipboardImage(Uint8Array)`，失败时走标准 `ClipboardItem`; 返回结果必须区分 `unsupported`, `permission_denied`, `invalid_image`, `success`。`supportsAgentMediaReferences(profile, mode)` 是唯一能力判断入口，模式/模型/会话切换必须使旧错误和 pending paste generation 失效。

- [ ] 写失败回归：注入有效 PNG，native bridge 成功时断言系统剪贴板可读；native bridge 拒绝时断言标准 Clipboard API fallback；两者都拒绝时显示可操作错误，不假报成功。
- [ ] 写失败回归：Codex 文本/MCP 模式粘贴图片显示当前模型能力提示且不创建引用；切换到“对话”视觉模型或“创作 Agent”后再次粘贴，旧错误消失、图片成为 `@图片1` 受管引用并进入请求。
- [ ] 修复模式切换时清理 `imageMentionError`, `mediaCapabilityError` 和旧 paste queue；不允许图八所示“已切换创作 Agent 仍显示 Codex 错误”。
- [ ] 安装版用有效 nativeImage fixture 执行复制图片、再粘贴到视觉对话、发送后消息流显示缩略图三个连续动作；报告系统剪贴板像素尺寸、assetId、request referenceAssetIds 和 page errors。

## Task 5D：@ 图片引用保持同一行和所有编辑器一致

**Files:**
- 修改：`apps/renderer/src/mentions/MediaMentionTextarea.tsx`、`media-mention-model.ts`、`apps/renderer/src/styles/canvas-layout.css`、`agent-workbench.css`。
- 测试：`MediaMentionTextarea.test.tsx`、`media-mention-model.test.ts`、`SkillChatWorkbench.test.tsx`、`tests/e2e/media-mention-chip.spec.ts`、`tests/e2e/agent-reference-workflow.spec.ts`。

**Interfaces:** canonical editor value 使用 token + text 的单一序列化；chip 使用 `display:inline-flex`，编辑器容器使用可换行 inline flow，不把每个 chip 放入 block；`pasteMentionToken` 只在用户原始文本确有换行时写入 `\\n`。

- [ ] 写失败回归：输入 `产品说明 @图片1 后续文字`、中文前后缀、连续两个引用、引用后继续输入，断言 DOM chip 与正文同一行（空间足够时）、canonical value 无自动换行。
- [ ] 写失败回归：节点编辑器、Agent composer、创作 Agent 提示词三处使用相同值模型；保存/重开后 chip 顺序、assetId 和文本完全一致。
- [ ] 删除 block-level `<div>`、`white-space: pre-line` 或序列化层隐式换行的根因；保留用户主动 Enter 的换行。
- [ ] 在 800/1024/1440 宽度和窄容器下验证：空间不足时自然换行到下一行，但不能单独把图片 chip 强制换到下一行。

## Task 5E：Agent 顶部加号、输入区空间和通用运行时命名

**Files:**
- 修改：`apps/renderer/src/agent/SkillChatWorkbench.tsx`、`apps/renderer/src/styles/agent-workbench.css`、`release-layout-contract.css`。
- 检查并迁移：生产运行时中仍带 Figma 专用语义的组件/CSS/测试；保留协议兼容和历史迁移 allowlist。
- 测试：`SkillChatWorkbench.test.tsx`、`main.styles.test.ts`、`tests/e2e/release-agent-layout.spec.ts`、`tests/e2e/release-ui-audit.spec.ts`。

- [x] 以同一个 header grid 定义标题、任务选择、加号和关闭按钮的中心线；加号按钮的 bbox 与任务选择控件垂直居中且不会漂到第二行。
- [x] 将 composer 编辑区设为 `min-height:96px`、默认 `118px`，最大 `160px`，工具栏独立占行；正文 padding 18–24px，输入文字不能贴边或被底栏覆盖。
- [x] 先跑样式失败断言，再改最后生效的局部 CSS；禁止追加全局 button/span 规则或恢复 Figma 专用 layout 选择器。
- [ ] 对新增/修改的生产命名执行 Figma 扫描：仅允许历史迁移、协议兼容和测试 fixture 命中；运行时用户可见标签、CSS 主类和新 API 改为通用 Canvas/Agent 命名。
- [ ] 运行浅色/深色、800/1024/1440 三组 Playwright，并保存顶部 header、composer、模式切换和引用状态截图。当前已完成候选 `win-unpacked` 实际 DOM 几何，正式安装目录仍待安装器放行。

## Task 5F：统一引用胶囊尺寸、输入流与视频节点布局

**Files:**
- 修改：`apps/renderer/src/mentions/MediaMentionTextarea.tsx`。
- 修改：`apps/renderer/src/styles/release-layout-contract.css`（文件末尾的唯一最终契约）。
- 修改：`apps/renderer/src/styles/agent-workbench.css`、`apps/renderer/src/styles/app.css`（删除会覆盖共享契约的重复胶囊规则，只保留基础样式）。
- 修改：`apps/renderer/src/canvas/ModuleNodeCard.tsx`、`apps/renderer/src/agent/SkillChatWorkbench.tsx`（仅补充语义 modifier，不复制布局实现）。
- 测试：`apps/renderer/src/mentions/MediaMentionTextarea.test.tsx`、`apps/renderer/src/canvas/ModuleNodeCard.test.tsx`、`apps/renderer/src/agent/SkillChatWorkbench.test.tsx`、`tests/e2e/media-mention-chip.spec.ts`、`work/qa-formal-geometry.mjs`。

**Interfaces:** `MediaMentionTextarea` 继续消费现有 canonical text/mention value 与 `mentionPreviews`，输出同一 inline token contract；场景只提供 `data-mention-context="agent|image|video|reverse"`，已选引用栏继续作为独立 rail。

- [ ] 写失败回归：断言 chip 为 `inline-flex`、`width:max-content`、`white-space:nowrap`，编辑器是 `pre-wrap` inline flow；输入 `前文 @图片1 后文` 时 canonical value 不增加换行，图片/视频节点使用相同 medium 尺寸。
- [ ] 运行聚焦测试确认当前规则失败，并记录具体失败断言。
- [ ] 实现唯一共享尺寸契约：Agent 28–30px、图片/视频/反推 30–32px、缩略图 20–24px、最大宽度 220–240px；删除 Agent `!important` 和历史 release 规则对 `display/white-space/width` 的重复覆盖。
- [ ] 保持正文与胶囊同级直接子节点；插入最多补一个必要空格，禁止隐式 `\n`、block wrapper、flex/grid 编辑器和整段 `trim()`。
- [ ] 扩展视频节点规则：视频正文胶囊与图片同档，视频缩略图使用 `object-fit:contain`；参数栏与正文引用流独立，不能把引用撑成一行媒体带。
- [ ] 运行组件测试，再运行 800/1024/1440px 与窄容器 Playwright，读取真实 bbox/computed style，确认自然换行、无横向溢出和基线对齐。
- [ ] 重新构建 Renderer 与桌面包，安装同一候选版本后重复几何和引用测试；记录 EXE/app.asar 指纹。
- [ ] 更新 `docs/project-memory.md`，写明最终级联所有者、实测尺寸、安装版结果和未验证的外部 provider 项。

## Task 6：全部节点、MCP 自动化及最终安装版验收

**Files:** 复用 `tests/e2e/release-ui-audit.spec.ts`、`work/qa-installed-formal-module-catalog.mjs`、`qa-installed-ui-and-nodes.mjs`、`qa-installed-agent-image-chat.mjs`、`qa-installed-creative-plan.mjs`、`qa-installed-mcp-zero-cost-full-chain.mjs`、`qa-installed-mcp-video-reverse-zero-cost.mjs`；新增 `work/qa-installed-codex-model-picker.mjs` 和独立 JSON/Markdown 结果报告。

**Interfaces:** 验收 runner 接收已核实的候选版本、EXE 路径、app.asar 哈希和隔离 QA 根；使用真实窗口 DOM/受管资源/MCP 边界，不能向生产包添加“测试通过”捷径。

- [ ] 执行前检查当前 package scripts：本次只读检查发现根 package.json 没有 scripts/workspaces，不能照抄历史 `npm run build` 并记为通过。先与 Git 基线和构建配置比对，按真实当前命令运行；任何必要修复保留脏工作树。
- [ ] 运行全 Vitest、各包 TypeScript、生产构建和完整 Playwright，保留退出码与失败摘要。运行示例：`npm.cmd exec -- vitest run`、`npm.cmd exec -- tsc -p packages/desktop-core/tsconfig.json --noEmit`、`npm.cmd exec -- tsc -p apps/renderer/tsconfig.json --noEmit`、`npm.cmd exec -- playwright test`。构建入口核实后写入当次报告。
- [ ] 对正式目录与兼容节点逐项验证创建/选中/编辑/输入/输出/删除/撤销/保存重开；逐项填写通过、失败或具具体原因的不适用，不能以“节点能创建”替代全部功能。
- [ ] MCP：配置解析、备份、共存、连接/断开、14 工具逐一调用；自动化工作流的创建/连接/更新/移动/执行/取消/删除/媒体导入/结果保存/重启读取；验证自然生命周期清理。
- [ ] 外部 Codex/WorkBuddy 实际客户端连接与信任单独检查；未获信任必须写明状态。既有 canvasforge 和其他 MCP 项保持不变。
- [ ] 所有生产改动完成且源码门禁通过后才构建新包；核对 EXE/asar 版本、时间和哈希。确认当前实际安装目录，完成同一候选安装验证后再声称用户可见。
- [ ] 安装版模型菜单同时显示 Astra 与 Sol，状态与本机官方目录一致；分别选择 Astra xhigh 与目录支持时的 Sol ultra，关闭重开仍一致；服务记录确认精确模型与 effort。模型调用失败时保留选择并给出可操作错误。
- [ ] 安装版重跑 20 图槽、@ 不换行、节点拖动、完整 Agent 流程和两条 MCP executor 路径；截图与 JSON 同时记录，不采用旧版报告替代。
- [ ] 更新 `docs/project-memory.md` 和本计划勾选项，报告完整通过数及未过项。付费模型、签名或外部信任尚未验证时保留边界；不把“计划已更新”或“源码单测已通过”写成“全部 BUG 已修复”。

## Task 7：新候选安装后的真实用户路径验收

**Files:**
- 运行：`apps/desktop-modern/dist-builder/desktop-modern-<version>/CanvasAtelier-*.exe`。
- 运行/产出：`work/qa-installed-save-recovery.mjs`、`work/qa-installed-agent-image-chat.mjs`、`work/qa-installed-creative-plan.mjs`、`work/qa-installed-mcp-zero-cost-full-chain.mjs`、`work/qa-installed-mcp-video-reverse-zero-cost.mjs`。

- [ ] 使用带引号的 NSIS `/D=...` 安装到隔离目录，核对 EXE、`resources/app.asar`、package version 和 SHA-256；不以旧安装目录或同名文件替代候选版本。
- [ ] 普通图片生成：使用受控 provider fixture，验证模型选择、提交、轮询、完成、图片显示、复制图片、保存、关闭、重开。
- [ ] 视频生成：验证图片/视频输入、模型/比例/清晰度/时长、提交、轮询/取消、视频播放、结果持久化、保存和重开。
- [ ] Agent 自动化：验证“选择模型 → 输入文字 → `@图片1` → 发送 → 方案/节点确认 → 执行 → 结果回写 → 保存 → 重开”；再覆盖 Codex 文本模式的明确媒体拒绝和切换视觉模式后的成功引用。
- [ ] 保存故障矩阵：正常保存、超时、冲突、失败后重试、关闭时取消、明确放弃、成功保存后 close 超时；每一项都检查窗口状态、项目文件、进程和下一次启动结果。
- [ ] 只有上述安装版报告全部通过且无未解释 page error、进程泄漏、旧坐标回写或数据丢失，才可报告候选包可交付；真实 RelayMe/Comfly 付费请求仍单独标记，不能用 fixture 代替。

## 计划完成检查

- [x] Astra 与 Sol 写入同一个模型目录任务。
- [x] Extra High/xhigh、Ultra/ultra 与逐模型档位写入规格及测试方案。
- [x] 原图 1–8、补充 Astra 图与原始媒体/节点/MCP 请求均有任务映射。
- [x] 标明前一轮只完成源码级 Astra 初步补回，安装版和额外反例仍未完成。
- [ ] Task 1–6 的实现和最终验收完成后再逐项勾选，文档编写本身不改变它们的状态。
- [ ] 新增稳定性任务 5A–5E 和安装后任务 7 完成后，才允许把保存、拖动、复制、引用、Agent UI 与通用命名标为通过。
