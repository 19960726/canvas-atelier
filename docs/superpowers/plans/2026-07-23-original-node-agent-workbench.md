# 原创节点与 Agent 工作台 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将画布的可执行节点和右侧 Skill 对话改为层级清晰、内容优先的原创工作台，同时保持既有运行与安全边界。

**Architecture:** 通过可复用的节点状态标题、配置分区和结果区统一 ModuleNodeCard 的可执行节点呈现。SkillChatWorkbench 保持现有 IPC 数据流，只更改安全摘要、消息和输入控件的结构与样式；CanvasWorkspace 继续唯一负责把节点结果投影为只读时间线。

**Tech Stack:** React、TypeScript、Vitest、现有 CSS design tokens、Lucide 图标。

## Global Constraints

- 只在 `E:\画布项目\.worktrees\canvas-agent-mvp`、`feature/canvas-agent-mvp` 工作。
- 保留现有未提交改动；不 reset、clean、checkout 或提交。
- 不复制第三方代码、品牌、图标、素材或逐像素布局。
- Agent 聊天不能创建或修改节点、连线、选择状态或 viewport；媒体反推只能从节点执行。
- 不向渲染端暴露知识正文、路径、URL、base64 或 Provider 凭据。
- 不发布、不安装、不调用真实自动更新或付费 Provider。

---

### Task 1: 统一可执行节点的信息层级

**Files:**
- Modify: `apps/renderer/src/canvas/ModuleNodeCard.tsx`
- Modify: `apps/renderer/src/styles/app.css`
- Test: `apps/renderer/src/canvas/ModuleNodeCard.test.tsx`

**Interfaces:**
- Consumes: 当前 `ModuleNodeCard` 的 image 与 reverse-agent 节点数据和运行回调。
- Produces: 不改变节点运行 API 的统一标题、配置与结果 DOM 区域。

- [ ] **Step 1: 写失败测试，断言反推节点有可见状态标题和固定结果区。**

```tsx
expect(screen.getByLabelText('Agent 节点状态')).toHaveTextContent('等待运行');
expect(screen.getByLabelText('Agent 节点结果')).toBeInTheDocument();
```

- [ ] **Step 2: 运行测试确认失败。**

Run: `npm test -- apps/renderer/src/canvas/ModuleNodeCard.test.tsx`

Expected: FAIL，因为新语义区域尚不存在。

- [ ] **Step 3: 最小实现统一三段节点结构。**

```tsx
<header className="module-node-card__workbench-header" aria-label={`${label} 节点状态`}>
  <span>{label}</span><span>{statusLabel}</span>
</header>
<section className="module-node-card__configuration">{configuration}</section>
<section className="module-node-card__result" aria-label={`${label} 节点结果`}>{result}</section>
```

为生图与反推节点补充对应 CSS：标题保持紧凑、运行状态始终可见、配置与结果有清晰边界；不得改变端口元素或回调。

- [ ] **Step 4: 运行节点测试确认通过。**

Run: `npm test -- apps/renderer/src/canvas/ModuleNodeCard.test.tsx`

Expected: PASS。

### Task 2: 重构 Skill 对话为内容优先工作台

**Files:**
- Modify: `apps/renderer/src/agent/SkillChatWorkbench.tsx`
- Modify: `apps/renderer/src/styles/app.css`
- Test: `apps/renderer/src/agent/SkillChatWorkbench.test.tsx`

**Interfaces:**
- Consumes: `SkillChatWorkbenchProps` 中现有 `chat`、`profiles`、知识库/记忆 ID 与 `reverseTimeline`。
- Produces: 不改变 chat 请求的安全字段、可读性更高的消息流与上下文摘要界面。

- [ ] **Step 1: 写失败测试，断言消息角色、来源和只读节点条目具有独立语义。**

```tsx
expect(screen.getByLabelText('Skill 消息流')).toBeInTheDocument();
expect(screen.getByLabelText('只读反推时间线')).toBeInTheDocument();
expect(screen.getByText('来源')).toBeInTheDocument();
```

- [ ] **Step 2: 运行测试确认失败。**

Run: `npm test -- apps/renderer/src/agent/SkillChatWorkbench.test.tsx`

Expected: FAIL，因为新语义容器尚不存在。

- [ ] **Step 3: 最小实现内容优先的工作台 DOM 与样式。**

```tsx
<div className="skill-chat-workbench__stream" aria-label="Skill 消息流">…</div>
<aside className="skill-chat-workbench__context-summary">…</aside>
<form className="skill-chat-workbench__composer" onSubmit={submit}>…</form>
```

将上下文收纳为摘要条，用户/Skill/来源/只读反推采用不同的排版层级；保留 session 恢复、路由筛选、脱敏与无伪停止约束。

- [ ] **Step 4: 运行工作台测试确认通过。**

Run: `npm test -- apps/renderer/src/agent/SkillChatWorkbench.test.tsx`

Expected: PASS。

### Task 3: 画布集成与视觉回归

**Files:**
- Modify: `apps/renderer/src/canvas/CanvasWorkspace.tsx`（仅在语义标签或布局容器必要时）
- Modify: `apps/renderer/src/canvas/CanvasWorkspace.test.tsx`
- Test: `apps/renderer/src/canvas/formal-module-workbench.test.tsx`

**Interfaces:**
- Consumes: 任务 1 的节点 DOM 与任务 2 的 `SkillChatWorkbench`。
- Produces: 保持画布不变式、可聚焦右侧面板以及最新交互测试。

- [ ] **Step 1: 写失败测试，验证发送聊天后节点、连线和 viewport 保持不变。**

```tsx
await user.click(screen.getByRole('button', { name: '发送' }));
expect(readCanvasSnapshot()).toEqual(snapshotBeforeChat);
```

- [ ] **Step 2: 运行集成测试确认失败。**

Run: `npm test -- apps/renderer/src/canvas/CanvasWorkspace.test.tsx`

Expected: FAIL，直到新的语义和不变式断言完成。

- [ ] **Step 3: 只补充布局容器或标签，禁止改变聊天到画布的数据路径。**

```tsx
<aside className="agent-panel" aria-label="Skill 对话工作台">
  <SkillChatWorkbench {...props} />
</aside>
```

不得新增任何节点创建、事务或 `analyzeReversePrompt` 调用。

- [ ] **Step 4: 运行回归验证。**

Run: `npm test -- apps/renderer/src/canvas/CanvasWorkspace.test.tsx apps/renderer/src/canvas/ModuleNodeCard.test.tsx apps/renderer/src/canvas/formal-module-workbench.test.tsx apps/renderer/src/agent/SkillChatWorkbench.test.tsx && npm run typecheck`

Expected: PASS。
