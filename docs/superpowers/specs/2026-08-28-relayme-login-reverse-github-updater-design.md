# RelayMe 账号登录、反推兼容与 GitHub 更新设计

## 目标

让 Canvas Atelier 用户无需手工创建 RelayMe API Key，直接使用 RelayMe 账号密码登录并自动加载该账号可用模型；修复多素材反推仍落入通用格式错误的问题；建立可从设置页检查、下载并确认安装 GitHub Release 的 Windows 更新链路。

## 全局约束

- 继续使用 `E:\画布项目\staging-canvas-build` 现有 dirty linked worktree，不 reset、clean、checkout 或覆盖无关修改。
- RelayMe 密码只用于一次 HTTPS 登录请求，不写入磁盘、项目、日志或诊断信息。
- 仅把 RelayMe JWT 交给桌面主进程的安全凭据存储；渲染进程不得读取已保存 JWT。
- 不自动进行付费反推重试；一次点击最多提交一次供应商反推请求。
- GitHub 更新只接受稳定通道中严格大于当前版本的版本。
- Windows 安装仍为 x64 NSIS、per-machine。安装更新必须由用户明确点击，不静默覆盖现有安装。
- 发布前必须通过 secret scan、完整 Vitest、完整 Playwright、typecheck、build、NSIS 打包和隔离打包运行时冒烟。

## 1. RelayMe 账号登录

### 用户流程

1. 设置页 RelayMe 卡片以“登录 RelayMe”作为主入口，不再要求普通用户先创建 API Key。
2. 点击后打开 Canvas Atelier 自有的模态登录框，输入 RelayMe 用户名和密码。
3. 桌面主进程直接向 `https://www.ml.relayme.uk/api/auth/user/login` 提交登录请求。
4. 登录成功后仅保存返回 JWT，并立即调用 `/api/ai-tools/v1/models`。
5. 设置页切换到 RelayMe，并把 RelayMe 设为唯一活动供应商，显示该账号实际返回的模型目录。
6. 对每项能力按目录顺序选择第一个已启用模型作为 RelayMe 默认项：对话、视觉反推、生图、视频。没有对应能力时保持未配置并显示原因。
7. Comfly 与 RelayMe 严格互斥：任意时刻只能启用一家供应商。切到 RelayMe 后，Agent、反推、生图和视频都只能使用 RelayMe；切回 Comfly 后都只能使用 Comfly。禁止跨供应商模型混用、单项回退或后台自动改用另一家。
8. 两家的凭据和各自模型偏好可以独立保留；切换供应商只改变活动路由，不删除另一家的安全凭据。
9. 提供“退出 RelayMe”。退出会删除安全存储中的 RelayMe JWT、清空 RelayMe 运行时目录；如果 RelayMe 正在活动，画布进入“未选择供应商”状态并要求用户明确选择 Comfly，不能静默回退。

### 注册验证码

- 邮箱验证码只属于 RelayMe 注册或密码找回流程，不进入 Canvas Atelier。
- “没有账号/需要验证码”打开 RelayMe 官方注册页。
- RelayMe 官方 OpenAPI 说明 AI Tools Bearer 凭据允许 JWT 或 `sk_...` API Key；Canvas Atelier 默认使用账号登录取得的 JWT。

### 安全边界

- 新增专用 RelayMe 登录 IPC 请求和响应 schema；请求字段只允许 `username`、`password`。
- 登录函数不记录请求体；错误只返回白名单状态：凭据无效、账号受限、需要重新登录、网络不可达、服务受限。
- 密码不进入 React 持久状态之外的任何持久层；对话框关闭和请求完成后清空字段。
- JWT 使用现有 `createSecureProviderCredentialStore` 及 Windows `safeStorage` 保存。
- 401 会原子清除失效 JWT，并将 RelayMe 状态改为“登录已过期”。
- 原 API Key 输入仅保留在“高级兼容”折叠区，防止已配置用户突然失效；正常登录流程不展示或要求 API Key。

## 2. 单一活动供应商与登录后的模型自动适配

- RelayMe 模型目录仍以接口声明的 capability、input modalities、vision、generation endpoint 为准，不按模型名称猜能力。
- 登录成功后执行一次受请求代次保护的目录刷新；旧请求不得覆盖新账号或退出后的状态。
- 新增持久化的单一 `activeProvider`，取值只能是 `comfly`、`relayme` 或未选择。所有模型目录、默认路由和提交动作先受该值约束。
- 自动默认只影响 RelayMe 自身的 capability defaults，不改写 Comfly defaults；切换回 Comfly 时恢复 Comfly 自身此前保存的默认项。
- 画布当前使用 RelayMe 时，模型路由失效或账号变化后只能选择同能力的 RelayMe 模型；没有可用项时显示“该账号没有此类模型”，不得使用 Comfly 或其他 RelayMe 能力替代。
- 画布当前使用 Comfly 时应用相同规则，RelayMe 路由不得出现在菜单或提交请求中。
- 已保存项目若包含非活动供应商的历史路由，打开时保留原始配置用于回溯，但执行按钮禁用并提示先切换供应商或重新选择当前供应商模型；不得静默重写历史项目。
- Agent、Reverse Agent、图片生成和视频生成继续通过统一 provider registry 发送，并在主进程再次校验请求 provider 必须等于 `activeProvider`，防止 Renderer 状态过期造成跨供应商提交。

## 3. 反推结果兼容与诊断

### 根因

当前反推边界把截断、JSON 解析、bridge schema、domain schema、运行身份和素材职责错误全部编码成 `PROVIDER_INVALID_RESPONSE`。Renderer 再通过英文 message 猜测类别。真实响应进入未识别的 domain-validation 分支时只能显示“模型已返回内容，但反推结果格式无效”。九素材加完整专业输出契约也会增加轻量模型返回字段类型漂移或遗漏核心字段的概率。

### 修复边界

- 为截断、无文本、无效 JSON、核心字段缺失、运行身份不匹配、素材职责不完整建立稳定的结构化 reason；UI 不再匹配英文文案。
- 在不伪造分析内容的前提下兼容常见核心形态：
  - `keywords`、`negativeConstraints`、`executionChecklist` 可由非空字符串或字符串数组规范化；
  - 常见对象数组只提取明确的 `text`、`label`、`value` 或 `description` 字段；
  - `positivePrompt` 可从 `positivePromptZh`、`promptZh`、`prompt` 或明确的中英文提示词对象取得；
  - 保留显式错误身份，绝不替换非空但不匹配的 `sessionId`、`nonce` 或知识快照版本；
  - 已提供但不完整的 `mediaResponsibilities` 继续严格拒绝。
- 调整供应商请求说明：七个核心必填字段排在最前；专业场景、构图、相机、材质、灯光、Seedance 等扩展块继续可选，不要求轻量模型同时生成所有巨大嵌套对象。
- schema 错误只向 UI 暴露白名单核心字段名，不包含供应商原文、素材内容、路径或密钥。
- 不自动重试，避免额外付费。

## 4. GitHub Release 更新

### 更新实现

- 使用 `electron-updater` 的 Windows NSIS/GitHub provider，不再在生产入口实例化 `MockReleaseFeed`。
- electron-builder 发布配置指向公开仓库 `19960726/canvas-atelier`，生成 `latest.yml`、安装包和 `.blockmap`。
- 主进程监听 checking、available、not-available、download-progress、downloaded、error 事件，并映射到现有窄 IPC 状态。
- `autoDownload=false`、`autoInstallOnAppQuit=false`；用户点击“下载更新”才下载，点击“重启并安装”才调用安装。
- 设置页点击“检查更新”后：
  - 无更新：显示当前已是最新版本；
  - 有更新：打开模态框，显示版本、发布说明和“下载更新/稍后”；
  - 下载中：显示真实进度；
  - 下载完成：显示“重启并安装/稍后安装”；
  - 出错：显示中文安全错误和重试按钮。
- 当前 Windows 包未做 Authenticode 签名。过渡版本依赖 GitHub HTTPS 与 `latest.yml` SHA-512 校验，并在项目记忆中明确风险；取得证书后恢复 Windows 发布者签名校验。

### 两阶段验收

现有 1.6.61 只包含 Mock 更新器，无法自举到真实 GitHub 更新。因此采用两阶段验证：

1. 构建 1.6.62 引导版，包含 RelayMe 登录、反推修复和真实更新器；用户或隔离环境首次手动安装。
2. 构建并发布 1.6.63 更新测试版，同时上传 EXE、blockmap、latest.yml。
3. 从 1.6.62 设置页点击“检查更新”，确认弹出 1.6.63，完成下载、重启安装并验证画布恢复。

### GitHub 空仓库边界

- 当前远端仓库为空。发布前先建立最小 `main` 发布基准与版本标签；不默认公开整个 dirty worktree。
- 发布资产只包含当前验证通过的安装包、blockmap、latest.yml、SHA-256 清单和发布说明。
- 若要公开完整源代码，必须由用户另行明确批准；本设计不把“上传安装包”解释为自动公开所有本地源文件。
- 任何 GitHub 写入前再次运行 secret scan 并列出即将上传的精确资产。

## 5. 测试与验收

- RelayMe client：账号登录成功、错误凭据、401 过期、网络失败、响应 schema、日志脱敏。
- Desktop provider service：JWT 安全保存、退出删除、登录后目录刷新、API Key 兼容回退。
- Renderer：登录模态框、密码清理、自动切换 RelayMe、单一供应商互斥、能力缺失提示、退出后的未选择状态。
- Provider routing：Comfly 活动时拒绝 RelayMe 请求、RelayMe 活动时拒绝 Comfly 请求、历史项目非活动路由不被静默改写。
- Reverse：所有结构化 reason、核心别名和对象数组规范化、显式身份拒绝、素材职责严格校验、九素材紧凑契约。
- Updater：GitHub available/not-available/error、下载进度、下载完成、显式安装、Renderer 弹窗状态机。
- E2E：RelayMe 登录使用本地 mock server，不发送真实账号；设置更新弹窗使用本地 update adapter；最终 GitHub Release 使用 1.6.62 → 1.6.63 的真实打包验收。
- 版本、app.asar、安装包哈希、签名状态、GitHub Release URL 和更新恢复结果写入 `docs/project-memory.md`。

## 6. 不在本次范围

- 不在 Canvas Atelier 内实现 RelayMe 注册、邮箱验证码发送、找回密码或 MFA 管理。
- 不保存 RelayMe 密码。
- 不实现后台静默安装。
- 不自动重试付费模型调用。
- 不上传用户项目、素材、供应商响应、凭据、日志或本地缓存。
