# Agent 结构化反推工作流实施计划

> **给智能编码代理：** 必须使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans`，按任务逐项执行。本计划中的步骤使用复选框跟踪。

**目标：** 在现有 Canvas Atelier Agent 中实现“自动分析、生成可编辑工作流草案、一次确认后持久化并执行”的结构化反推流程。

**架构：** 保留现有 `SkillChatWorkbench`、`runReverseAgent`、provider capability selection、ordered media resolution 和 app-store 持久化边界。新增 provider-neutral 的反推契约、结果解析器、工作流提案状态和一次性确认事务；分析阶段只更新对话/提案状态，确认阶段才更新画布和启动模型任务。

**技术栈：** React + TypeScript、Zustand app-store、Vitest + Testing Library、现有 Electron desktop bridge、现有 `@xyflow/react` 画布事务。

## 全局约束

- 参考视频和截图只作为行为与视觉参考，不复制品牌、文案、水印、素材或专有布局。
- 自动分析允许读取项目和模型，但在确认前不得持久化新节点/边、调用付费生成任务或改变画布。
- 保留有序 `@图片N` 引用，输入顺序必须稳定传递到 provider-neutral 请求。
- 反推必须包含主体、环境、材质、灯光、镜头、景深、构图、透视、前中后景、每张参考图职责、继承/替换/禁止照搬、中英提示词、负面约束和执行清单。
- 默认输出三种有意义的变体：忠实、平衡、探索；用户指定数量时尊重用户数量。
- 不新增平行持久化路径；继续使用现有项目身份、revision、stable save boundary 和 durable transaction。
- 保留所有已有未提交改动；每个任务只暂存自己修改的文件。
- 安装包必须等聚焦测试、全量测试、类型检查、构建和打包运行时验证全部通过后再生成。

## 文件边界

- 新建 `apps/renderer/src/agent/reverse-workflow-contract.ts`：结构化反推请求、结果、参考职责、变体、执行清单和提案状态类型及纯校验/规范化函数。
- 新建 `apps/renderer/src/agent/reverse-workflow-contract.test.ts`：契约序列化、顺序、必需段落和兼容旧文本结果的单元测试。
- 新建 `apps/renderer/src/agent/reverse-workflow-proposal.ts`：从结构化结果派生可编辑提案、ghost 节点摘要、确定性边计划和影响摘要；不得调用 store。
- 新建 `apps/renderer/src/agent/reverse-workflow-proposal.test.ts`：三种默认变体、节点/边顺序、冲突和缺失素材测试。
- 修改 `apps/renderer/src/agent/ReversePromptAgent.tsx`：把现有反推请求构建与结果解析接入统一契约，保留旧 provider 文本回退。
- 修改 `apps/renderer/src/agent/ReversePromptAgent.test.tsx`：补充完整结构化结果、缺失段落和旧文本回退测试。
- 修改 `apps/renderer/src/agent/SkillChatWorkbench.tsx`：加入分析进度、提案展示、编辑状态和“确认并执行/继续修改”边界；不直接写 canvas store。
- 修改 `apps/renderer/src/agent/SkillChatWorkbench.test.tsx`：补充未确认不改画布、确认入口、编辑字段、进度和错误恢复测试。
- 修改 `apps/renderer/src/app/app-store.ts`：加入 proposal revalidation、稳定保存、一次性节点/边事务和部分失败重试入口。
- 修改 `apps/renderer/src/app/app-store.test.ts`、`apps/renderer/src/app/desktop-persistence.test.ts`：补充 stale proposal、revision conflict、无重复创建和保存失败测试。
- 修改 `apps/renderer/src/canvas/CanvasWorkspace.tsx` 与对应测试：渲染只读 ghost 预览和确定性执行结果定位，不让预览进入 durable project。
- 修改 `apps/renderer/src/styles/app.css` 与 `apps/renderer/src/main.styles.test.ts`：为反推提案卡、进度行、引用职责和执行清单增加稳定布局，继续满足现有 38px 控件契约。
- 修改 `docs/project-memory.md`：每个已验证任务记录根因、保护行为和命令。

### 任务 1：建立结构化反推契约

**目标：** 让反推请求和结果拥有稳定、可校验、可持久化的类型边界。

**接口：**

```ts
export type ReverseProposalState =
  | 'idle' | 'analyzing' | 'proposal_ready' | 'confirming'
  | 'executing' | 'completed' | 'partial_failure' | 'failed' | 'cancelled';

export interface ReverseReferenceDuty {
  assetId: string;
  mention: string;
  responsibility: string;
  inherit: string[];
  replace: string[];
  doNotCopy: string[];
  conflict?: string;
}

export interface ReverseAnalysisResult {
  intent: { deliverable: string; useCase: string; defaults: string[]; missing: string[] };
  referenceDuties: ReverseReferenceDuty[];
  visual: { subject: string; environment: string; material: string; lighting: string; camera: string; depth: string; composition: string; perspective: string; layers: string };
  prompts: { zh: string; en: string; negative: string[] };
  variants: Array<{ id: string; name: 'faithful' | 'balanced' | 'exploratory'; change: string; prompt: string }>;
  checklist: Array<{ id: string; label: string; state: 'pending' | 'done' | 'blocked' }>;
}

export interface ReverseWorkflowProposal {
  id: string;
  projectId: string;
  persistenceGeneration: number;
  referenceAssetIds: string[];
  modelRoute: string;
  state: ReverseProposalState;
  analysis: ReverseAnalysisResult;
  editedAnalysis: ReverseAnalysisResult;
  plannedNodes: Array<{ id: string; moduleType: string; variantId?: string }>;
  plannedEdges: Array<{ source: string; target: string; targetPortId: string; order: number }>;
}
```

- [ ] **步骤 1：先写失败测试**

在 `reverse-workflow-contract.test.ts` 中覆盖：引用顺序 `a,b,c` 不可被排序改变；缺少 `prompts.en` 或 `visual.layers` 时返回明确校验错误；空 variants 自动补齐 faithful/balanced/exploratory；旧的纯文本 provider 结果能包装为 `legacyText` 而不是丢失。

- [ ] **步骤 2：运行测试确认失败**

运行：

```powershell
npm.cmd exec vitest -- --config vitest.config.ts apps/renderer/src/agent/reverse-workflow-contract.test.ts --run
```

预期：因契约导出和规范化函数不存在而失败。

- [ ] **步骤 3：实现最小契约**

实现 `normalizeReverseAnalysisResult(value, references)`、`parseReverseAnalysisResponse(value, references)` 和 `createDefaultVariants(basePrompt)`。规范化时只按输入引用顺序建立职责，不对引用数组做字典序排序；旧文本结果放入 `legacyText`，同时生成可编辑的空缺段落和明确缺失项。

- [ ] **步骤 4：运行测试确认通过**

运行同一 Vitest 命令，预期契约测试全部通过。

- [ ] **步骤 5：提交**

```powershell
git add apps/renderer/src/agent/reverse-workflow-contract.ts apps/renderer/src/agent/reverse-workflow-contract.test.ts
git commit -m "feat: add structured reverse workflow contract"
```

### 任务 2：生成工作流提案而不修改画布

**目标：** 把反推结果转换为可编辑的影响摘要、ghost 节点和确定性边计划。

**接口：**

```ts
export function buildReverseWorkflowProposal(input: {
  projectId: string;
  persistenceGeneration: number;
  modelRoute: string;
  references: Array<{ assetId: string; mention: string; label: string }>;
  analysis: ReverseAnalysisResult;
}): ReverseWorkflowProposal;
```

- [ ] **步骤 1：先写失败测试**

测试两张引用和三种变体会产生固定的 reference -> reverse -> variant edges；重复调用相同输入得到相同节点/边 id；提案只包含计划数据，不调用 `useAppStore` 或持久化客户端。

- [ ] **步骤 2：运行测试确认失败**

```powershell
npm.cmd exec vitest -- --config vitest.config.ts apps/renderer/src/agent/reverse-workflow-proposal.test.ts --run
```

- [ ] **步骤 3：实现提案构建器**

使用 `proposal-${projectId}-${hash(referenceAssetIds + analysis)}` 形式的稳定提案 id；节点 id 使用 `proposalId:reverse` 和 `proposalId:variant:${variant.id}`；边的 `order` 使用引用原始位置。不要在此模块调用 provider 或写项目。

- [ ] **步骤 4：运行测试确认通过**

运行同一命令，确认重复构建、变体和冲突摘要测试通过。

- [ ] **步骤 5：提交**

```powershell
git add apps/renderer/src/agent/reverse-workflow-proposal.ts apps/renderer/src/agent/reverse-workflow-proposal.test.ts
git commit -m "feat: build non-persistent reverse workflow proposals"
```

### 任务 3：接入反推请求和结果解析

**目标：** 让现有 `ReversePromptAgent` 发送完整结构化要求，并兼容旧 provider 返回。

**接口：**

```ts
export function buildStructuredReverseRequest(input: {
  content: string;
  references: ReverseReferenceDuty[];
  projectContext: string;
}): string;
```

- [ ] **步骤 1：先写失败测试**

在 `ReversePromptAgent.test.tsx` 验证请求包含 `referenceDuties`、视觉分解八项、中英文 prompt、negative constraints、variants 和 checklist；验证 `@图片2` 在第二位且不被重排；验证只返回纯文本时仍能显示可读结果。

- [ ] **步骤 2：运行测试确认失败**

```powershell
npm.cmd exec vitest -- --config vitest.config.ts apps/renderer/src/agent/ReversePromptAgent.test.tsx --run
```

- [ ] **步骤 3：实现请求/结果接入**

把现有 visual-analysis metadata 扩展为 JSON 优先、文本可读的请求格式；调用 `parseReverseAnalysisResponse`，失败时保留 provider 原文并填充 `missing`，不能伪造不可见的文字或品牌信息。保留现有 capability selection、timeout 和 cancellation 行为。

- [ ] **步骤 4：运行测试确认通过**

运行同一命令，并确认既有反推测试没有回归。

- [ ] **步骤 5：提交**

```powershell
git add apps/renderer/src/agent/ReversePromptAgent.tsx apps/renderer/src/agent/ReversePromptAgent.test.tsx
git commit -m "feat: request and parse structured reverse analysis"
```

### 任务 4：实现 Workbench 反推提案 UI

**目标：** 在现有 Agent 面板中展示进度、引用职责、可编辑结果和单次确认边界。

- [ ] **步骤 1：先写失败测试**

在 `SkillChatWorkbench.test.tsx` 添加以下断言：

```tsx
expect(screen.getByLabelText('反推分析进度')).toHaveTextContent('读取参考图');
expect(screen.getByLabelText('反推方案')).toHaveTextContent('中文提示词');
expect(screen.getByLabelText('反推方案')).toHaveTextContent('英文提示词');
expect(screen.getByLabelText('反推方案')).toHaveTextContent('禁止照搬');
expect(screen.getByRole('button', { name: '确认并执行' })).toBeVisible();
expect(screen.getByRole('button', { name: '继续修改' })).toBeVisible();
```

验证分析完成前不存在确认按钮；点击“继续修改”不会调用执行回调；编辑中文 prompt 后提案状态仍为 `proposal_ready`。

- [ ] **步骤 2：运行测试确认失败**

```powershell
npm.cmd exec vitest -- --config vitest.config.ts apps/renderer/src/agent/SkillChatWorkbench.test.tsx --run
```

- [ ] **步骤 3：实现 UI**

新增独立的 `ReverseWorkflowProposalView`（可放在 `SkillChatWorkbench.tsx` 内部，若超过当前文件可读范围再拆为同目录文件），渲染五个进度阶段、可折叠视觉段落、引用职责列表、双语 prompt、negative constraints、三变体、checklist 和影响摘要。组件只发出 `onConfirm(proposal)` / `onEdit(proposal)`，不直接操作 app-store。

- [ ] **步骤 4：运行测试确认通过**

运行 Workbench 测试，并额外执行现有 `ReversePromptAgent.test.tsx`。

- [ ] **步骤 5：提交**

```powershell
git add apps/renderer/src/agent/SkillChatWorkbench.tsx apps/renderer/src/agent/SkillChatWorkbench.test.tsx
git commit -m "feat: show editable reverse workflow proposal"
```

### 任务 5：实现确认事务与 stale proposal 防护

**目标：** 在 app-store 中把 revalidate、stable save、节点/边创建和任务启动绑定成一次可恢复操作。

**接口：**

```ts
confirmReverseWorkflowProposal(proposal: ReverseWorkflowProposal): Promise<{
  ok: boolean;
  createdNodeIds: string[];
  failedVariantIds: string[];
  reason?: string;
}>;
```

- [ ] **步骤 1：先写失败测试**

在 `app-store.test.ts` 覆盖：

- proposal projectId 不等于当前 project 时拒绝；
- persistenceGeneration 过期时拒绝并保留原画布；
- 引用资产缺失时指出具体 mention；
- 首次确认只创建一套节点和边；重复确认不重复创建；
- stable save 失败时不创建节点、不启动 provider；
- revision conflict 时重新读取并只重试一次；
- 三个 variant 中第二个失败时保留成功节点并返回 `partial_failure`。

- [ ] **步骤 2：运行测试确认失败**

```powershell
npm.cmd exec vitest -- --config vitest.config.ts apps/renderer/src/app/app-store.test.ts --run
```

- [ ] **步骤 3：实现最小事务**

先调用现有 stable save boundary，再读取当前 project 和 asset inventory，校验 proposal id/generation；用现有 durable node creation/edge transaction 写入 reverse 与 generation nodes；只有事务成功后调用现有 job starters。为 proposal 和 variant 保存 execution ids，重试时跳过已有成功 execution id。

- [ ] **步骤 4：运行测试确认通过**

运行 `app-store.test.ts`、`desktop-persistence.test.ts` 和已有 reverse execution 测试。

- [ ] **步骤 5：提交**

```powershell
git add apps/renderer/src/app/app-store.ts apps/renderer/src/app/app-store.test.ts apps/renderer/src/app/desktop-persistence.test.ts
git commit -m "feat: confirm reverse proposals transactionally"
```

### 任务 6：连接 CanvasWorkspace ghost 预览和结果回填

**目标：** 让用户在确认前看到非持久化的工作流预览，确认后能定位真实节点和生成结果。

- [ ] **步骤 1：先写失败测试**

在 `CanvasWorkspace.test.tsx` 验证 proposal 预览显示虚线/ghost 结构但不增加 durable node count；确认后节点 count 增加且输入边顺序为 `@图片1...N`；取消/关闭 Agent 后 ghost 预览消失；结果节点带 proposal id、variant id、source references 元数据。

- [ ] **步骤 2：运行测试确认失败**

```powershell
npm.cmd exec vitest -- --config vitest.config.ts apps/renderer/src/canvas/CanvasWorkspace.test.tsx --run
```

- [ ] **步骤 3：实现预览与回填**

把 proposal 作为渲染层临时数据传入，使用独立的 `previewNodes` / `previewEdges`，不得拼入受控 React Flow durable arrays；确认回调成功后由 store 正式发布节点，失败时清空 preview 并保留对话提案。

- [ ] **步骤 4：运行测试确认通过**

运行 CanvasWorkspace、ModuleNodeCard、use-canvas-draft 和 node-types 测试。

- [ ] **步骤 5：提交**

```powershell
git add apps/renderer/src/canvas/CanvasWorkspace.tsx apps/renderer/src/canvas/CanvasWorkspace.test.tsx
git commit -m "feat: preview and materialize reverse workflow on canvas"
```

### 任务 7：补齐样式、持久化恢复和错误恢复

**目标：** 使提案卡在现有右侧 Agent 面板中稳定显示，并支持关闭重开、取消、部分失败和编辑恢复。

- [ ] **步骤 1：先写失败测试**

在 `main.styles.test.ts` 检查提案卡的 38px 控件、面板窄宽不溢出、长模型名不遮挡发送按钮、长 prompt 可滚动；在 `SkillChatWorkbench.test.tsx` 检查关闭后重开仍保留 proposal 和用户编辑；检查失败/取消后可继续修改。

- [ ] **步骤 2：运行测试确认失败**

```powershell
npm.cmd exec vitest -- --config vitest.config.ts apps/renderer/src/main.styles.test.ts apps/renderer/src/agent/SkillChatWorkbench.test.tsx --run
```

- [ ] **步骤 3：实现样式和恢复**

在 `app.css` EOF 添加 scoped `.skill-chat-workbench__reverse-proposal` 规则：固定标题/按钮高度、消息区独立滚动、双栏 prompt 在窄宽时单列、checklist 不参与父布局撑高；把 proposal、editedAnalysis、state、execution ids 接入现有 conversation persistence，不新增存储根。

- [ ] **步骤 4：运行测试确认通过**

运行样式、Workbench、app-store、desktop-persistence 全部聚焦测试。

- [ ] **步骤 5：提交**

```powershell
git add apps/renderer/src/styles/app.css apps/renderer/src/main.styles.test.ts apps/renderer/src/agent/SkillChatWorkbench.tsx apps/renderer/src/agent/SkillChatWorkbench.test.tsx apps/renderer/src/app/desktop-persistence.test.ts
git commit -m "feat: persist and polish reverse proposal recovery"
```

### 任务 8：全量验证和 Electron 运行时验收

**目标：** 证明结构化反推没有破坏既有 Agent、画布、持久化和运行时行为。

- [ ] **步骤 1：运行聚焦回归**

```powershell
npm.cmd exec vitest -- --config vitest.config.ts apps/renderer/src/agent/reverse-workflow-contract.test.ts apps/renderer/src/agent/reverse-workflow-proposal.test.ts apps/renderer/src/agent/ReversePromptAgent.test.tsx apps/renderer/src/agent/SkillChatWorkbench.test.tsx apps/renderer/src/app/app-store.test.ts apps/renderer/src/app/desktop-persistence.test.ts apps/renderer/src/canvas/CanvasWorkspace.test.tsx apps/renderer/src/canvas/ModuleNodeCard.test.tsx apps/renderer/src/main.styles.test.ts --run
```

预期：所有文件通过，且没有 React maximum update depth、stale proposal 或重复节点失败。

- [ ] **步骤 2：运行全量源码验证**

```powershell
npm.cmd test -- --run
npm.cmd run typecheck
npm.cmd run build
```

预期：Vitest 全部通过（性能测试按项目约定跳过），类型检查和生产构建退出码为 0。

- [ ] **步骤 3：运行隐藏 Electron smoke**

基于当前 `apps/desktop-modern/dist-builder/desktop-modern/win-unpacked/Canvas Atelier.exe` 创建隔离 QA 数据根，使用 Playwright 验证：打开 Agent、导入两张参考图、发送反推请求、看到五阶段进度和方案卡；确认前 durable node count 不变；点击“确认并执行”后节点/边出现；重复点击不重复创建；关闭重开后 proposal/state 正确恢复；`fatalAlertCount=0`、`pageErrors=[]`。

- [ ] **步骤 4：记录运行时证据**

在 `docs/project-memory.md` 记录可执行文件路径、QA 数据根、节点数、边数、保存状态、错误数组、测试计数和任何环境阻塞。区分源码、构建产物、安装包和运行时证据。

- [ ] **步骤 5：只有全门禁通过后再打包**

按项目 release gate 运行 NSIS 打包，记录安装包大小、SHA-256、签名状态、安装后 `app.asar` hash 和未残留进程。若测试或 runtime 被 `spawn EPERM`、权限或浏览器缺失阻塞，明确记录为环境阻塞，不把它写成产品失败或通过。

## 自检结果

- 规格覆盖：任务 1 覆盖完整结构化契约；任务 2 覆盖非持久化工作流草案；任务 3 覆盖请求/结果解析与旧文本兼容；任务 4 覆盖对话 UI；任务 5 覆盖确认事务、稳定保存、stale/revision/部分失败；任务 6 覆盖 ghost 预览和结果回填；任务 7 覆盖窄面板布局与关闭重开恢复；任务 8 覆盖源码、构建和 Electron 运行时验收。
- 占位检查：未使用 `TBD`、`TODO`、`稍后实现` 或未定义的泛化“适当处理”步骤。
- 类型一致性：`ReverseAnalysisResult`、`ReverseWorkflowProposal`、`buildReverseWorkflowProposal` 和 `confirmReverseWorkflowProposal` 在任务 1/2/5 中定义后被后续任务复用。
