# Canvas Atelier 启动、Agent 与供应商稳定性设计

日期：2026-09-08。用户已要求继续处理正式版启动慢、Agent 超时/重复请求、Codex 报错不明确，并复查两家供应商、生图/视频/反推、剪贴板、删除和保存。

## 目标

- 最近项目打开后立即把画布交给 Renderer，不让恢复扫描阻塞首屏。
- 阻止恢复扫描在 `%APPDATA%\Canvas Atelier\recovery` 无限新增完整项目镜像。
- 普通 Agent 规划允许供应商在合理时间内完成；真正超时时由网络请求自己取消，重试不重复消息或上下文。
- Codex 的 MCP 启动/连接故障与认证、模型、超时故障分开提示。
- 保持 Comfly 与 RelayMe 的真实能力边界，并用零费用门禁复查图片、视频、画布反推和对话反推。
- 用现有安装态脚本复查多图粘贴、复制、删除、保存和重启恢复；只有失败证据才继续改这些已在 1.6.113 验证过的链路。

## 设计

### 启动与恢复

`desktop-persistence.hydrate()` 打开最近项目后立即采用返回的项目和 revision，同时把 `getRecoveryPlan` 排到现有后台刷新队列。恢复预览仍保留同步处理，因为它要求用户先解决恢复选择。

`RecoveryScanner` 每次成功生成至少一个恢复候选后，保留当前扫描会话以及同一项目最新的两个已完成会话。它只删除 `appData/recovery/<safe project>/<safe session>` 下、能够验证为同一 projectId 的派生镜像目录；未知、损坏、符号链接或校验失败的目录不删除。裁剪失败不改变恢复结果。

### Agent 请求生命周期

无媒体文本请求由 desktop provider client 使用 180000 ms 超时，Renderer 使用 195000 ms 兜底。视觉/反推请求继续使用 300000/315000 ms；Codex 继续使用 600000 ms 和既有 requestId 取消链。这样正常网络超时先中止真实请求，再由 UI 返回可重试状态。

当输入内容、模型和引用与最后一条失败的用户请求一致时，重试把该消息从 `error` 更新为 `sending`，不再追加第二条相同消息，也不把失败内容重复发送给供应商。编辑后的新请求仍新增消息。

### Codex 错误

`mapCodexFailure` 同时用于非零退出事件和 runner 抛出的错误。认证、模型、超时保留现有分类；包含 Canvas Atelier MCP 初始化、连接、握手或工具传输失败特征的错误映射到 `CODEX_CLI_MCP_FAILED`，只返回固定脱敏中文提示。

### 供应商与既有数据

不修改真实凭据，不自动发送付费任务。Comfly 和 RelayMe 继续按活动供应商隔离；RelayMe 文生图、文生视频、图片画布反推和图片对话反推进入验收，未被服务契约证明的参考图生图、视频素材输入、视频反推和远端取消继续提前拒绝。

恢复镜像是派生副本；正式项目、资产、供应商配置、任务历史和其他应用目录均不属于裁剪范围。正式安装仍覆盖 `D:\CanvasAtelier\Canvas Atelier`，版本只保留一个。

## 验收

- 单元测试先证明最近项目 hydration 被慢恢复扫描阻塞、普通文本 30 秒超时、失败重试重复气泡、Codex MCP 错误落入 generic、恢复会话不裁剪。
- 聚焦测试转绿后运行相关 Renderer/Desktop/Provider 宽回归、全量 Vitest、typecheck、build、Playwright。
- 生成 1.6.114 NSIS，核对安装包、正式 EXE、app.asar 版本和 SHA-256；覆盖唯一正式目录。
- 安装版测量首屏时间，并运行剪贴板、25 图、多图删除、保存/关闭/重开、Agent 图片对话、Creative Agent、MCP 图片/视频/反推零费用门禁。
- Live Comfly/RelayMe 只有在有效登录且获得付费调用授权后才能标为通过；否则单独记录为外部阻断。
