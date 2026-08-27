# RelayMe 登录、单供应商路由、反推兼容与 GitHub 更新实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox items and require review checkpoints.

**目标：** 让 RelayMe 支持账号密码登录并自动加载账号模型，保证 Comfly 与 RelayMe 全局严格互斥；修复反推结果类型漂移仍被误报为通用格式错误；将设置页更新检查替换为真实 GitHub Release 更新链路，并通过 1.6.62 → 1.6.63 双版本验收。

**架构：** RelayMe 密码只经窄 IPC 进入桌面主进程并用于一次 HTTPS 登录，返回 JWT 存入现有安全凭据库。新增持久化 `activeProvider` 作为所有 Agent、反推、图片、视频操作的唯一主进程门禁。反推边界返回稳定结构化失败原因，并只对安全、明确的常见字段形态做规范化。生产更新由 `electron-updater` 驱动，desktop-core 维持可测试的窄状态机，Renderer 订阅更新状态并显示显式下载/安装弹窗。

**技术栈：** TypeScript、React、Electron、Zod、Vitest、Playwright、electron-builder、electron-updater、GitHub Releases、Windows NSIS x64。

## 全局约束

- 只使用 `E:\画布项目\staging-canvas-build` 现有 dirty linked worktree。
- 禁止 `git reset`、`git clean`、`git checkout`、创建副本或覆盖无关修改。
- 已经 dirty 的文件必须先保存任务前 diff/基线；每次只暂存任务自有增量，禁止 `git add -A` 和宽路径暂存。
- 每个行为修改都必须先写失败回归，再做最小实现，再运行聚焦测试与相邻宽套件。
- 密码、JWT、API Key、供应商原始响应、用户素材和本地路径不得进入日志、测试快照、诊断包、GitHub Release 或文档。
- 一次反推点击最多发起一次供应商请求；不做自动付费重试。
- GitHub 上传只包括明确列出的发布资产和最小发布锚点；不得把“上传安装包”扩大为公开整个 dirty 源码。
- 更新安装必须由用户显式点击；不得静默安装或覆盖用户现有安装。

---

## 任务 0：建立可审计基线

**文件：**

- 读取：`AGENTS.md`
- 读取：`docs/project-memory.md`
- 读取：`docs/superpowers/specs/2026-08-28-relayme-login-reverse-github-updater-design.md`
- 读取：`.superpowers/sdd/progress.md`（若存在）
- 新增：`.superpowers/sdd/2026-08-28-relayme-updater-baseline/`

- [ ] 运行 `git status --short`、`git diff --stat`、`git diff --check`，记录当前 dirty 文件，不解释为本任务改动。
- [ ] 对本计划将触碰且当前已 dirty 的文件保存任务前副本或补丁；至少包括 `SettingsDrawer*`、`CanvasWorkspace*`、`ModuleNodeCard*`、`relayme-provider-service*`、`package*.json`、`docs/project-memory.md`。
- [ ] 运行当前聚焦基线：

  ```powershell
  npm.cmd exec vitest -- run packages/provider-relayme packages/desktop-core/src/relayme-provider-service.test.ts packages/desktop-core/src/reverse-provider-result.test.ts apps/renderer/src/settings/SettingsDrawer.test.tsx apps/renderer/src/canvas/ModuleNodeCard.test.tsx
  npm.cmd run typecheck
  ```

- [ ] 把基线失败与已知历史失败分开记录；后续不得把历史失败误报为新回归。

**检查点：** 无生产代码修改，不提交 `.superpowers/sdd` 临时证据。

---

## 任务 1：RelayMe 账号登录客户端与安全凭据清除

**文件：**

- 新增：`packages/provider-relayme/src/account-auth.ts`
- 新增：`packages/provider-relayme/src/account-auth.test.ts`
- 修改：`packages/provider-relayme/src/index.ts`
- 修改：`packages/desktop-core/src/provider-credential-vault.ts`
- 新增：`packages/desktop-core/src/provider-credential-vault.test.ts`

- [ ] 先写 RelayMe 登录客户端失败测试，覆盖：
  - POST `/api/auth/user/login`，请求体只含 `username`、`password`；
  - 成功响应只返回 JWT，不返回或保存密码；
  - 401/403、账号受限、网络失败、非 JSON、缺失 token 映射为白名单错误；
  - 错误文本、日志钩子和异常对象不包含用户名、密码、JWT 或响应正文。
- [ ] 运行 `npm.cmd exec vitest -- run packages/provider-relayme/src/account-auth.test.ts`，确认 RED 原因为实现缺失。
- [ ] 实现独立 `loginRelayMeAccount`，从 AI Tools base URL 安全推导同源 `/api/auth/user/login`，拒绝跨源重定向或任意登录 URL 注入。
- [ ] 再运行聚焦测试，确认 GREEN。
- [ ] 为 `ProviderCredentialStore.clear(): Promise<void>` 写失败测试，覆盖锁内删除、文件不存在幂等、删除后 `status/getToken` 不再返回凭据。
- [ ] 最小实现 `clear()`，沿用现有受限路径与锁，不新增明文旁路。
- [ ] 运行：

  ```powershell
  npm.cmd exec vitest -- run packages/provider-relayme/src/account-auth.test.ts packages/desktop-core/src/provider-credential-vault.test.ts
  npm.cmd run typecheck
  ```

**提交边界：** 只暂存上述任务 1 文件，提交建议：`feat: add secure RelayMe account login client`。

---

## 任务 2：单一活动供应商存储、IPC 与主进程硬门禁

**文件：**

- 新增：`packages/desktop-core/src/provider-active-store.ts`
- 新增：`packages/desktop-core/src/provider-active-store.test.ts`
- 修改：`packages/desktop-core/src/provider-contracts.ts`
- 修改：`packages/desktop-core/src/provider-service-types.ts`
- 修改：`packages/desktop-core/src/provider-ipc-handlers.ts`
- 新增：`packages/desktop-core/src/provider-ipc-handlers.test.ts`
- 修改：`packages/desktop-core/src/relayme-provider-service.ts`
- 修改：`packages/desktop-core/src/relayme-provider-service.test.ts`
- 修改：`packages/desktop-core/src/preload-api.ts`
- 修改：对应 preload/contract 测试

- [ ] 先写 `ProviderActiveStore` 测试，定义唯一状态：`{ activeProvider: 'comfly' | 'relayme' | null }`；覆盖缺文件、合法持久化、非法值回退为 `null`、原子写入。
- [ ] 运行新测试确认 RED，再实现受限 JSON store。
- [ ] 在 contract 测试中先加入四个窄通道：
  - `getActiveProvider`
  - `setActiveProvider`
  - `loginRelayMe`
  - `logoutRelayMe`
- [ ] 登录请求 schema 只允许 `username`、`password`；响应不含 JWT。增加稳定错误 `PROVIDER_INACTIVE`（或等价独立 code），禁止用自由文本判断。
- [ ] 为 `relayme-provider-service` 写 RED：登录成功后保存 JWT、刷新 `/models` 成功才切换活动供应商；模型刷新失败不得切换；401 原子清凭据并令 RelayMe 失活；退出清 JWT 与运行时目录。
- [ ] 实现登录事务：`login → 临时 token 验证 models → 安全保存 → 设置 activeProvider=relayme`。任何失败都不能暴露 token 或留下半激活状态。
- [ ] 为 `createProviderBridgeHandlers` 写跨能力 RED：
  - Comfly 活动时拒绝 RelayMe chat/reverse/image/video；
  - RelayMe 活动时拒绝 Comfly 同类请求；
  - `null` 时全部执行请求拒绝；
  - status/configure/list/login/logout 可用于设置，不受执行门禁误伤；
  - Renderer 传旧 provider 值也必须由主进程拒绝。
- [ ] 在统一 handler 入口实现一次权威校验，避免各能力分散复制。
- [ ] 扩展 preload 白名单 API；验证渲染进程永远读不到保存的 token。
- [ ] 运行：

  ```powershell
  npm.cmd exec vitest -- run packages/desktop-core/src/provider-active-store.test.ts packages/desktop-core/src/provider-ipc-handlers.test.ts packages/desktop-core/src/relayme-provider-service.test.ts packages/desktop-core/src/preload-api.test.ts
  npm.cmd exec vitest -- run packages/desktop-core/src/provider-bridge.test.ts packages/desktop-core/src/provider-skill-chat.test.ts
  npm.cmd run typecheck
  ```

**提交边界：** 已 dirty 文件使用任务前基线生成仅本任务差异审查包；不得宽暂存。提交建议：`feat: enforce one active AI provider`。

---

## 任务 3：设置页登录、互斥切换与活动供应商模型目录

**文件：**

- 修改：`apps/renderer/src/settings/SettingsDrawer.tsx`
- 修改：`apps/renderer/src/settings/SettingsDrawer.test.tsx`
- 修改：`apps/renderer/src/app/provider-profiles.ts`
- 修改：`apps/renderer/src/app/provider-profiles.test.ts`
- 修改：`apps/renderer/src/canvas/CanvasWorkspace.tsx`
- 修改：`apps/renderer/src/canvas/CanvasWorkspace.test.tsx`
- 修改：`apps/renderer/src/jobs/desktop-model-executor.ts`
- 修改：`apps/renderer/src/jobs/desktop-model-executor.test.ts`
- 修改：`apps/renderer/src/test-mode/e2e-harness.ts`
- 修改：`tests/e2e/multi-provider-models.spec.ts`

- [ ] 先写 Settings RED：RelayMe 主操作为“登录 RelayMe”；模态框提交账号密码；完成或关闭后清空 password；注册/找回链接打开官方页面；API Key 只在“高级兼容”折叠区。
- [ ] 写互斥 RED：选择 RelayMe 后 Comfly 变为非活动，反之亦然；退出活动 RelayMe 后状态为未选择，不静默回退 Comfly。
- [ ] 写模型目录 RED：`provider-profiles` 只返回活动供应商目录；RelayMe 登录后按 capability 元数据为对话、视觉反推、生图、视频选择该供应商首个启用模型；不按模型名称猜能力。
- [ ] 写画布 RED：历史项目保留非活动 provider 路由，但执行按钮禁用并显示切换提示；模型菜单只显示活动供应商；无对应能力显示“该账号没有此类模型”。
- [ ] 最小实现活动供应商状态装载、代次保护目录刷新和 UI。密码只存在登录模态局部状态，finally 中清空。
- [ ] 为 executor 增加客户端预检，但保持主进程任务 2 门禁为权威来源。
- [ ] E2E 使用本地 mock，不请求真实 RelayMe，不使用真实账号。
- [ ] 运行：

  ```powershell
  npm.cmd exec vitest -- run apps/renderer/src/settings/SettingsDrawer.test.tsx apps/renderer/src/app/provider-profiles.test.ts apps/renderer/src/canvas/CanvasWorkspace.test.tsx apps/renderer/src/jobs/desktop-model-executor.test.ts
  npm.cmd exec playwright test tests/e2e/multi-provider-models.spec.ts
  npm.cmd run typecheck
  ```

**提交边界：** `SettingsDrawer*`、`CanvasWorkspace*`、`e2e-harness.ts` 已 dirty，必须按任务前副本审查并只暂存新增 hunks。提交建议：`feat: add RelayMe login and exclusive provider UI`。

---

## 任务 4：反推结构化失败原因与安全核心规范化

**文件：**

- 修改：`packages/desktop-core/src/provider-contracts.ts`
- 修改：`packages/desktop-core/src/reverse-provider-response.ts`
- 修改：`packages/desktop-core/src/reverse-provider-result.ts`
- 修改：`packages/desktop-core/src/reverse-provider-result.test.ts`
- 修改：`packages/desktop-core/src/professional-reverse-analysis.ts`
- 修改：对应 prompt/bridge 测试
- 修改：`apps/renderer/src/canvas/ModuleNodeCard.tsx`
- 修改：`apps/renderer/src/canvas/ModuleNodeCard.test.tsx`

- [ ] 先写结构化 reason RED，至少区分：`TRUNCATED`、`NO_TEXT`、`INVALID_JSON`、`CORE_SCHEMA_INVALID`、`IDENTITY_MISMATCH`、`MEDIA_RESPONSIBILITIES_INVALID`。
- [ ] 删除 Renderer 依赖英文 message 正则的测试期望，改为 reason 到中文提示的穷尽映射；未知 reason 仍安全降级。
- [ ] 写真实九素材回归，输入模拟 Flash Lite 常见漂移：
  - `keywords`、`negativeConstraints`、`executionChecklist` 为字符串、字符串数组或含 `text/label/value/description` 的对象数组；
  - `positivePrompt` 来自 `positivePromptZh`、`promptZh`、`prompt` 或明确中英文对象；
  - Gemini 多文本 parts 与常见 `result/data/output/reversePromptResult` wrapper；
  - 缺失核心字段时错误只暴露白名单字段名。
- [ ] 保持严格 RED/GREEN：显式非空错误 `sessionId/nonce/knowledgeSnapshotVersion` 必须拒绝；已提供但缺项的 `mediaResponsibilities` 必须拒绝；不得用本次身份覆盖显式错误身份。
- [ ] 最小扩展 `normalizeReverseProviderResult`，只提取明确字段，不拼接任意对象或供应商原文。
- [ ] 收紧 `professional-reverse-analysis` 请求：身份和核心字段最前；专业扩展为可选；保留素材职责要求；不增加第二次调用。
- [ ] 运行：

  ```powershell
  npm.cmd exec vitest -- run packages/desktop-core/src/reverse-provider-result.test.ts packages/desktop-core/src/provider-bridge.test.ts packages/desktop-core/src/relayme-provider-service.test.ts apps/renderer/src/canvas/ModuleNodeCard.test.tsx
  npm.cmd run typecheck
  ```

**提交边界：** 只提交反推 reason、规范化、prompt 和 UI 映射增量。提交建议：`fix: classify and normalize reverse model output`。

---

## 任务 5：真实 GitHub 更新驱动与生产主进程接线

**文件：**

- 修改：`packages/desktop-core/src/update-client.ts`
- 修改：`packages/desktop-core/src/update-client.test.ts`
- 新增：`apps/desktop-modern/src/electron-updater-adapter.ts`
- 新增：`apps/desktop-modern/src/electron-updater-adapter.test.ts`
- 修改：`apps/desktop-modern/src/main.ts`
- 修改：`apps/desktop-modern/src/runtime-entry-contract.test.ts`
- 修改：`apps/desktop-modern/package.json`
- 修改：`apps/desktop-modern/electron-builder.yml`
- 修改：`package-lock.json`

- [ ] 先用 fake driver 写 UpdateClient RED：checking、available、not-available、download-progress、downloaded、error；`download()` 必须调用真实 driver；`restart()` 只在 downloaded 后接受。
- [ ] 保持 desktop-core 不直接依赖 Electron；抽象最小 `UpdateDriver`，在 desktop-modern adapter 内包装 `electron-updater.autoUpdater`。
- [ ] adapter RED 覆盖：`autoDownload=false`、`autoInstallOnAppQuit=false`、事件映射、发布说明安全裁剪、`quitAndInstall` 只由显式 IPC 调用。
- [ ] 安装并锁定 `electron-updater`；不得手工改 lockfile，使用 npm 更新。
- [ ] 修改生产入口：packaged 模式使用真实 adapter；Mock 只允许显式测试环境，禁止生产默认落回 Mock。
- [ ] electron-builder 配置 GitHub provider `19960726/canvas-atelier`，生成 `latest.yml` 和 `.blockmap`。未签名过渡版明确配置与风险，不伪称已签名。
- [ ] 运行：

  ```powershell
  npm.cmd exec vitest -- run packages/desktop-core/src/update-client.test.ts apps/desktop-modern/src/electron-updater-adapter.test.ts apps/desktop-modern/src/runtime-entry-contract.test.ts
  npm.cmd run typecheck
  npm.cmd run build
  ```

**提交边界：** package files 已 dirty，先核对任务前依赖/版本 diff，只暂存 updater 依赖与配置增量。提交建议：`feat: connect production GitHub updater`。

---

## 任务 6：设置页更新弹窗、进度订阅与本地 E2E

**文件：**

- 修改：`packages/desktop-core/src/provider-contracts.ts` 或独立 update contracts 文件
- 修改：`packages/desktop-core/src/preload-api.ts`
- 修改：对应 IPC/preload 测试
- 修改：`apps/renderer/src/settings/SettingsDrawer.tsx`
- 修改：`apps/renderer/src/settings/SettingsDrawer.test.tsx`
- 修改：`apps/renderer/src/test-mode/e2e-harness.ts`
- 新增：`tests/e2e/settings-update-flow.spec.ts`
- 修改：相关样式文件（只在需要时）

- [ ] 先写 update state 订阅 contract RED，返回 unsubscribe；窗口卸载后不得继续 setState；不向 Renderer 暴露任意 Electron event。
- [ ] 写 Settings RED：
  - 无更新显示“当前已是最新版本”；
  - available 自动弹出版本/发布说明与“下载更新/稍后”；
  - downloading 显示真实百分比；
  - downloaded 显示“重启并安装/稍后安装”；
  - error 显示安全中文错误和重试；
  - 关闭弹窗不触发下载或安装。
- [ ] 最小实现窄事件订阅和可访问 modal（焦点、Escape、按钮禁用、明暗主题）。
- [ ] E2E 用本地 fake adapter 验证完整 UI 状态机，不访问 GitHub、不安装软件。
- [ ] 运行：

  ```powershell
  npm.cmd exec vitest -- run apps/renderer/src/settings/SettingsDrawer.test.tsx packages/desktop-core/src/preload-api.test.ts
  npm.cmd exec playwright test tests/e2e/settings-update-flow.spec.ts
  npm.cmd run typecheck
  ```

**提交边界：** 只暂存更新弹窗及订阅增量。提交建议：`feat: show explicit desktop update flow`。

---

## 任务 7：1.6.62 引导版完整验证与隔离打包冒烟

**文件：**

- 修改：根 `package.json`（若版本契约使用）
- 修改：`apps/desktop-modern/package.json`
- 修改：`package-lock.json`
- 修改：`apps/desktop-modern/src/packaging-boundary.test.ts`
- 修改：`apps/desktop-modern/src/runtime-entry-contract.test.ts`
- 修改：`docs/project-memory.md`

- [ ] 先把版本契约测试改为期望 `1.6.62` 并确认 RED。
- [ ] 仅修改版本字段与 lockfile 对应值，确认版本测试 GREEN。
- [ ] 依次运行，任何失败都先定位根因并补回归：

  ```powershell
  npm.cmd run scan:e2e
  npm.cmd run typecheck
  npm.cmd exec vitest -- run
  npm.cmd exec playwright test
  npm.cmd run build
  npm.cmd exec electron-builder --workspace apps/desktop-modern -- --win nsis --x64
  git diff --check
  ```

- [ ] 在不覆盖用户现有安装的隔离目录启动 `win-unpacked`，验证：最近画布恢复、RelayMe 登录 UI、活动供应商互斥、反推错误分类、更新检查入口。
- [ ] 核对并记录 EXE、blockmap、latest.yml、app.asar：版本、字节数、SHA-256；使用 PowerShell `Get-AuthenticodeSignature` 如实记录签名状态。
- [ ] 更新 `docs/project-memory.md`，写入根因、修改、验证证据、剩余风险，不写凭据。

**外部写入门：** 在 GitHub 上传前再次列出精确资产、哈希和 secret scan 结果。不得测试安装器覆盖真实安装。

---

## 任务 8：建立最小 GitHub 发布锚点并发布 1.6.62

**远端：** `https://github.com/19960726/canvas-atelier`

- [ ] 用 `gh auth status` 和只读 GitHub API 再确认账号、仓库可见性、默认分支和现有 release/tag 状态。
- [ ] 若仓库仍为空，通过 GitHub Contents API 创建只含产品名、下载入口与隐私边界的最小 `README.md` 作为 `main`；不要切换本地 dirty worktree，不上传本地源码。
- [ ] 创建 `v1.6.62` GitHub Release，上传且仅上传：
  - `CanvasAtelier-Win10-11-x64-1.6.62.exe`
  - 对应 `.blockmap`
  - `latest.yml`
  - SHA-256 清单
  - 无敏感信息的发布说明
- [ ] 重新下载远端资产到临时目录并校验 SHA-256/文件大小；打开 Release URL 确认资产公开可读。

**提交/推送边界：** 不 push 当前本地分支，不发布完整源码。所有 GitHub 写入都记录 URL 和资产 ID。

---

## 任务 9：构建发布 1.6.63 并验收真实更新发现/下载

**文件：** 与任务 7 相同的版本契约和项目记忆文件。

- [ ] 先把版本契约测试改为 `1.6.63` 并确认 RED，再更新版本与 lockfile，确认 GREEN。
- [ ] 重跑任务 7 的完整验证、NSIS 打包、隔离 `win-unpacked` 冒烟和哈希/签名核对；不得复用 1.6.62 旧测试输出宣称通过。
- [ ] 创建 `v1.6.63` Release 并上传新的 EXE、blockmap、latest.yml、SHA-256 清单与发布说明；校验 `latest.yml` 指向 1.6.63 且 SHA-512 与资产一致。
- [ ] 在隔离的 1.6.62 QA 环境执行真实验收：设置 → 检查更新 → 弹出 1.6.63 → 下载完成。任何访问 GitHub、下载或安装行为都保留非敏感日志。
- [ ] “重启并安装”会改变本机安装状态；执行前必须再次取得用户对精确 QA 安装目标的明确许可。未获许可时验收到“下载完成”即停止，不得声称安装升级成功。
- [ ] 获许可后完成隔离升级，核对升级后 app.asar 版本为 1.6.63，确认最近画布仍恢复、RelayMe/Comfly 状态不混用。

---

## 任务 10：最终审查、项目记忆与交付

- [ ] 对所有任务增量生成相对任务 0 基线的审查包，确认没有吸收无关 dirty 修改。
- [ ] 使用 `superpowers:requesting-code-review` 做规格与质量审查；Critical/Important 未清零不得交付。
- [ ] 使用 `superpowers:verification-before-completion` 复核最新一次完整命令输出、安装包和 GitHub 资产，禁止引用过期结果。
- [ ] 最终更新 `docs/project-memory.md`：
  - 反推真实根因及防复发测试；
  - RelayMe 登录安全边界与单活动供应商规则；
  - 1.6.62/1.6.63 各自哈希、大小、签名状态；
  - GitHub Release URL；
  - 更新验收实际停在哪一步；
  - 未解决风险（尤其未签名 Windows 包）。
- [ ] 最终报告按“结果、根因、修改、验证证据、风险、安装包/Release 路径、下一步”给出；若安装验收未获许可，明确标注未执行。

## 完成定义

- RelayMe 可用账号密码登录，密码从不持久化，JWT 只保存在桌面安全凭据库。
- Comfly/RelayMe 在 Renderer 与主进程双层严格互斥，所有生成能力不存在跨供应商回退。
- 九素材 Flash Lite 常见输出漂移可被安全规范化；截断、JSON、schema、身份、素材职责错误有稳定可测试分类。
- 设置页能真实发现 GitHub 新版本、显示弹窗与下载进度；安装始终需要显式点击。
- 1.6.62 引导包和 1.6.63 更新包通过最新完整验证并发布，远端资产哈希与本地一致。
- 未覆盖用户现有安装、未上传 dirty 源码、未泄露任何凭据或用户数据。
