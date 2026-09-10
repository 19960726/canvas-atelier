# Agent 推理、反推强度与画布可靠性 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完成用户批准的 `1 + 2 + 3 + 4 + 6`，同时修复 Photoshop 等比适配、4K 被静默降档和旧项目误报打不开的问题。

**Architecture:** 在供应商 profile 中声明推理和图片分辨率能力；renderer 只提交用户实际选择且已验证的参数，desktop provider 在保存原始响应后校验实际像素。Agent 的思考档位按会话和模式隔离，反推强度独立保存。项目切换使用结构化结果区分当前画布阻塞、路径缺失和读取失败。

**Tech Stack:** TypeScript、React、Zustand、Zod、Electron IPC、Vitest、Testing Library、Photoshop JSX/COM。

**Spec:** `docs/superpowers/specs/2026-09-10-reasoning-photoshop-resolution-project-recovery-design.md`

## Global Constraints

- 保留当前脏工作区和全部未跟踪资产；不得 reset、clean 或删除现有文件。
- 每项生产修改前先添加回归测试并运行到预期失败。
- 不发起真实或付费生图请求，不安装、不发布、不清理工作区。
- 不实现原计划第 5 项“两阶段深度反推和中断续写”。
- 保存供应商返回的原始图片；分辨率不足时只报告，不插值放大，也不自动重试付费请求。

---

### Task 1: 推理能力目录与请求协议

- [ ] 在 `packages/domain/src/provider-profile.test.ts` 或现有 profile schema 测试中，先覆盖 reasoning 档位、默认值、四种协议和旧缓存兼容。
- [ ] 在 `packages/desktop-core/src/provider-skill-chat.test.ts`、`packages/desktop-core/src/relayme-provider-service.test.ts` 中，先覆盖普通对话/创作 Agent 的 native 字段、model variant 与受控 system instruction 映射。
- [ ] 运行聚焦测试，确认新断言因字段缺失或仅 Codex 模式映射而失败。
- [ ] 最小扩展 provider profile/schema、catalog 归一化和 provider request mapper。
- [ ] 重跑聚焦测试并通过。

### Task 2: 三模式思考控件与独立持久化

- [ ] 在 `apps/renderer/src/agent/skill-chat-session-store.test.ts` 添加 chat/original/codex 独立保存、旧 `reasoningEffort` 迁移、项目/会话隔离测试。
- [ ] 在 `apps/renderer/src/agent/SkillChatWorkbench.test.tsx` 添加普通对话与创作 Agent 控件显示、按模型能力收窄档位、切模式不串值、请求携带当前值测试。
- [ ] 运行测试到 RED。
- [ ] 修改 `skill-chat-session-store.ts`、`SkillChatWorkbench.tsx` 与相关类型，复用离散思考控件并按模式选择值。
- [ ] 重跑聚焦测试并通过。

### Task 3: 独立快速/标准/深度反推

- [ ] 在 `packages/domain` 的 reverse node schema 测试中添加 `analysisDepth` 默认 standard 与快照往返。
- [ ] 在 `apps/renderer/src/canvas/ModuleNodeCard.test.tsx`、`apps/renderer/src/app/app-store.test.ts` 添加反推节点三个按钮、节点独立保存和请求透传测试。
- [ ] 在 `apps/renderer/src/agent/SkillChatWorkbench.test.tsx` 与 `packages/desktop-core/src/skill-chat-visual-analysis.test.ts` 添加 Agent 反推强度独立保存及 fast/standard/deep 指令测试。
- [ ] 运行到 RED 后，最小修改 reverse schema、节点 UI、Agent 会话状态和一次请求的深度指令。
- [ ] 重跑聚焦测试并通过，确认 deep 仍只发起一次请求。

### Task 4: Codex/MCP 能力诊断卡

- [ ] 在 `apps/renderer/src/settings/SettingsDrawer.test.tsx` 添加 Codex CLI、MCP runtime、客户端配置组合与敏感信息不显示测试。
- [ ] 运行到 RED。
- [ ] 在 `SettingsDrawer.tsx` 读取既有 `codexCli.listProfiles`、MCP runtime/client status，并渲染状态、模型数、最高档位和可执行修复提示。
- [ ] 重跑聚焦测试并通过。

### Task 5: Photoshop contain 导入与失败安全

- [ ] 先在 `packages/desktop-core/src/photoshop-script.test.ts` 把 `Math.min(1, ...)` 旧契约改为小图也等比放大，并覆盖大图缩小、横竖图、居中和单图层。
- [ ] 在 `packages/desktop-core/src/photoshop-windows-adapter.test.ts` 添加无活动文档提前返回、源文档 finally 关闭、部分写入后不二次 fallback、禁止 clipboard copy/paste 测试。
- [ ] 运行到 RED。
- [ ] 修改 `photoshop-place-smart-object.jsx`、`photoshop-windows-runner.js` 和 `photoshop-windows-adapter.ts`，统一 contain 公式并收紧 fallback 边界。
- [ ] 重跑 Photoshop 聚焦测试并通过。

### Task 6: 生图档位真实性与实际像素提示

- [ ] 在 `apps/renderer/src/app/app-store.test.ts` 先反转“4K 静默变 2K”旧测试，并覆盖 Comfly Nano 4K 不因 constraints 缺失而被删除。
- [ ] 在 `apps/renderer/src/app/provider-profiles.test.ts`、`apps/renderer/src/canvas/ModuleNodeCard.test.tsx` 添加已知 Nano 固定档路线不被同名折叠、缺少验证 metadata 不凭空显示 4K 测试。
- [ ] 在 provider bridge/service 聚焦测试中添加请求 4K、实际 `1696x2528` 时保留原文件并返回 `PROVIDER_RESOLUTION_MISMATCH` 或等价结构化警告的测试。
- [ ] 运行到 RED。
- [ ] 修改 `app-store.ts`，不再静默 nearest-tier；补齐已验证 Comfly/4D/Nano/Gemini/RelayMe profile constraints 并保留固定档 route identity。
- [ ] 在 provider job/result metadata 记录 requested/submitted/actual 分辨率，在 `ModuleNodeCard.tsx` 显示“请求档位 / 实际像素 / 未达档位”。
- [ ] 重跑 provider、store、节点聚焦测试，确认下载与 AssetStore 路径没有重采样。

### Task 7: 旧项目结构化打开、索引合并与恢复

- [ ] 在 `apps/renderer/src/canvas/ProjectManagerPopover.test.tsx` 与 `CanvasWorkspace.test.tsx` 添加 blocked_unsaved、blocked_recovery、missing、failed 的独立文案和调用边界。
- [ ] 在 `packages/desktop-core/src/user-data-migration.test.ts` 添加稳定索引已存在时合并有效 legacy 条目且不修改 legacy 文件的测试。
- [ ] 在 `packages/desktop-core/src/recent-project-bridge.test.ts` 添加 `CORRUPT_JOURNAL` 恢复候选和 relocate projectId 不匹配拒绝测试。
- [ ] 运行到 RED。
- [ ] 修改 renderer 的 open result 合同和提示；恢复预览时禁用最近项目入口。
- [ ] 修改 migration 为逐条合并、bridge 同时处理损坏 journal/snapshot，并校验 relocate manifest projectId。
- [ ] 重跑项目保存/恢复/最近项目聚焦测试并通过。

### Task 8: 交叉回归、记忆与验收

- [ ] 检查模式切换、模型刷新、项目重开、应用状态重建，不得出现跨会话推理值、错误档位或旧素材残留。
- [ ] 运行相关宽套件后执行 `npm.cmd test`、`npm.cmd run typecheck`、`npm.cmd run build`、`npm.cmd run scan:e2e`、`git diff --check`。
- [ ] 更新 `docs/project-memory.md`，记录根因、改动、验证证据和未进行的真实供应商/安装验证。
- [ ] 检查最终 diff 只包含本轮有意修改与先前已存在的脏改动，不删除或覆盖用户资产。
