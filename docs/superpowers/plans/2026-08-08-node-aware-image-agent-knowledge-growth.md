# 节点感知生图 Agent 与知识库成长实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在双供应商 API 验收后，实现只服务生图的节点感知 Agent、确认后工作流写入、知识库升级审核和已批准版本跨设备同步。

**Architecture:** 用只读画布快照生成结构化工作流计划，经过 UI 确认后交给单一原子事务执行器；知识库候选与已批准版本分库存储，跨设备同步只读取批准仓库。

**Tech Stack:** TypeScript、Zod、Zustand、React Flow、Electron IPC、Vitest、Playwright。

## Global Constraints

- 必须先完成 `2026-08-08-comfly-relayme-multi-provider-integration.md`。
- Agent 只负责生图相关工作。
- 未确认不修改画布、不调用付费生成。
- 不删除已有节点，不覆盖未确认配置。
- 知识库未审核候选不参与同步。
- 所有素材统一 `1–20` 与 `@序号`。

---

### Task 1: 定义节点能力快照和工作流计划合同

**Files:**
- Create: `packages/domain/src/image-agent-workflow.ts`
- Create: `packages/domain/src/image-agent-workflow.test.ts`
- Modify: `packages/domain/src/index.ts`
- Modify: `packages/domain/src/codex-workflow-contract.ts`

- [ ] 写失败测试：空画布、复杂画布、非法节点、未知端口、超过 20 个素材、供应商模型缺失。
- [ ] Run: `npm.cmd test -- packages/domain/src/image-agent-workflow.test.ts`，Expected: RED。
- [ ] 实现 `ImageAgentCanvasSnapshotSchema`、`ImageAgentWorkflowPlanSchema`、新增/修改/连接操作和冲突记录。
- [ ] Run 同上，Expected: GREEN。
- [ ] Commit: `git commit -m "feat: define image agent workflow plans"`。

### Task 2: 构建只读画布节点感知适配器

**Files:**
- Create: `apps/renderer/src/app/image-agent-canvas-adapter.ts`
- Create: `apps/renderer/src/app/image-agent-canvas-adapter.test.ts`
- Modify: `apps/renderer/src/app/workspace-api.ts`

- [ ] 写失败测试：读取六类允许节点、连线、图槽顺序、模型、比例、清晰度、数量和提示词；排除无关节点。
- [ ] Run: `npm.cmd test -- apps/renderer/src/app/image-agent-canvas-adapter.test.ts`，Expected: RED。
- [ ] 实现稳定只读快照，不暴露 API Key、Base64 和本地路径。
- [ ] Run 同上，Expected: GREEN。
- [ ] Commit: `git commit -m "feat: expose image agent canvas context"`。

### Task 3: Agent 对话、媒体引用与知识库选择

**Files:**
- Modify: `apps/renderer/src/agent/SkillChatWorkbench.tsx`
- Modify: `apps/renderer/src/agent/SkillChatWorkbench.test.tsx`
- Modify: `apps/renderer/src/canvas/ConnectedAgentMediaSlots.tsx`
- Modify: `apps/renderer/src/canvas/ConnectedAgentMediaSlots.test.tsx`

- [ ] 写失败测试：零/一/两个知识库、点击上传、粘贴、`@1`、图片与多视频、20 个上限、点击空白自动关闭选择框。
- [ ] Run 对应测试，Expected: RED。
- [ ] 复用统一图槽组件，发送真实 provider/model/context/referenceAssetIds。
- [ ] Run 对应测试，Expected: GREEN。
- [ ] Commit: `git commit -m "feat: add knowledge-aware image agent chat"`。

### Task 4: 生成工作流预览

**Files:**
- Create: `apps/renderer/src/agent/ImageWorkflowPlanPreview.tsx`
- Create: `apps/renderer/src/agent/ImageWorkflowPlanPreview.test.tsx`
- Modify: `apps/renderer/src/agent/SkillChatWorkbench.tsx`

- [ ] 写失败测试：新增、修改、连接分组；模型与智能尺寸适配结果；冲突；确认与取消。
- [ ] Run: `npm.cmd test -- apps/renderer/src/agent/ImageWorkflowPlanPreview.test.tsx`，Expected: RED。
- [ ] 实现只读预览，未确认不能调用 workspace 写接口。
- [ ] Run 同上，Expected: GREEN。
- [ ] Commit: `git commit -m "feat: preview image agent workflows"`。

### Task 5: 原子应用与撤销

**Files:**
- Create: `apps/renderer/src/app/image-workflow-transaction.ts`
- Create: `apps/renderer/src/app/image-workflow-transaction.test.ts`
- Modify: `apps/renderer/src/app/app-store.ts`
- Modify: `apps/renderer/src/app/workspace-api.ts`

- [ ] 写失败测试：未确认零修改、一次确认一次提交、中途失败全回滚、不删除已有节点、撤销恢复。
- [ ] Run: `npm.cmd test -- apps/renderer/src/app/image-workflow-transaction.test.ts`，Expected: RED。
- [ ] 实现 `applyConfirmedImageWorkflow(plan)` 单事务 API 和撤销令牌。
- [ ] Run 同上，Expected: GREEN。
- [ ] Commit: `git commit -m "feat: apply confirmed image workflows atomically"`。

### Task 6: KEEP/CHANGE/NEVER 升级候选

**Files:**
- Create: `packages/domain/src/knowledge-upgrade-candidate.ts`
- Create: `packages/domain/src/knowledge-upgrade-candidate.test.ts`
- Create: `packages/skill-store/src/upgrade-candidate-store.ts`
- Create: `packages/skill-store/src/upgrade-candidate-store.test.ts`

- [ ] 写失败测试：三种反馈、来源、影响范围、冲突、候选不可直接激活。
- [ ] Run 对应测试，Expected: RED。
- [ ] 实现候选 schema 和隔离存储。
- [ ] Run 对应测试，Expected: GREEN。
- [ ] Commit: `git commit -m "feat: create reviewed knowledge upgrade candidates"`。

### Task 7: 审核、版本与回退

**Files:**
- Create: `apps/renderer/src/settings/KnowledgeUpgradeReview.tsx`
- Create: `apps/renderer/src/settings/KnowledgeUpgradeReview.test.tsx`
- Modify: `packages/skill-store/src/index.ts`
- Modify: `apps/renderer/src/settings/SettingsDrawer.tsx`

- [ ] 写失败测试：差异、新增/修改规则、批准、拒绝、版本号、回退。
- [ ] Run 对应测试，Expected: RED。
- [ ] 实现审核 UI 与批准写入，拒绝不改活动版本。
- [ ] Run 对应测试，Expected: GREEN。
- [ ] Commit: `git commit -m "feat: review and version knowledge growth"`。

### Task 8: 仅批准版本跨设备同步

**Files:**
- Create: `packages/skill-store/src/approved-version-sync.ts`
- Create: `packages/skill-store/src/approved-version-sync.test.ts`
- Modify: `apps/renderer/src/app/knowledge-client.ts`
- Modify: `apps/renderer/src/settings/SettingsDrawer.tsx`

- [ ] 写失败测试：候选不出站、批准版本出站、冲突不覆盖、失败保留本地、两个知识库独立。
- [ ] Run 对应测试，Expected: RED。
- [ ] 实现批准版本序列化与冲突结果。
- [ ] Run 对应测试，Expected: GREEN。
- [ ] Commit: `git commit -m "feat: sync approved knowledge versions"`。

### Task 9: 端到端用户验收

**Files:**
- Create: `tests/e2e/node-aware-image-agent.spec.ts`
- Create: `tests/e2e/knowledge-growth-review.spec.ts`
- Modify: `apps/renderer/src/test-mode/e2e-harness.ts`

- [ ] 覆盖上传/粘贴、`@1–@20`、工作流预览、确认、撤销、生成结果反馈、候选审核、同步和中文错误。
- [ ] Run: `$env:NOVUS_E2E_PORT='43181'; npm.cmd run e2e -- tests/e2e/node-aware-image-agent.spec.ts tests/e2e/knowledge-growth-review.spec.ts`。
- [ ] Run: `npm.cmd run typecheck; npm.cmd run scan:e2e`。
- [ ] 输出浅色、深色截图和测试链接，等待用户亲自验收。
- [ ] Commit: `git commit -m "test: verify node-aware image agent growth"`。