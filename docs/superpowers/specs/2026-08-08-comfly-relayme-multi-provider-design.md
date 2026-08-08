# Comfly 与 RelayMe 双供应商接入设计

日期：2026-08-08

## 目标

画布同时接入 Comfly（`https://ai.comfly.org`）和 RelayMe（`https://www.ml.relayme.uk/api/ai-tools/v1`），让用户分别保存 API Key、检查连接、同步真实模型，并在 Agent 对话、反推、生图和视频节点中选择实际可用的供应商与模型。

Comfly 不被 RelayMe 替换。两家供应商互相隔离，任一家未配置、鉴权失败或暂时不可用时，另一家仍可正常使用。

## 已确认方案

采用“共享合同 + 独立适配器 + 动态能力目录”方案：

- `provider` 从写死的 `comfly` 扩展为 `comfly | relayme`。
- 保留 `packages/provider-comfly`，新建 `packages/provider-relayme`。
- 桌面主进程使用供应商注册表按请求中的 `provider` 分发，不在 UI 或 IPC 中硬编码某一家。
- 每个模型保存稳定的 `provider`、`modelRoute`、`modelId`、显示名、能力集合和参数约束。
- 设置页分别显示 Comfly 与 RelayMe 卡片、连接状态、隐藏密钥、模型数量和最后同步时间。
- 模型列表只来自真实接口响应或用户明确保存的能力配置，不编造模型名称。

## 供应商接口边界

### Comfly

沿用现有 OpenAI/Gemini 兼容客户端能力：

- `GET /v1/models`
- `POST /v1/chat/completions`
- `POST /v1/responses`
- `POST /v1/images/generations`
- `POST /v1/images/edits`
- `GET /v1/images/tasks/{taskId}`
- `POST /v1beta/models/{model}:generateContent`

视频接口不得根据名称猜测。只有 Comfly 模型目录、用户提供的官方配置或成功的能力探测能够证明视频端点与请求格式时，才启用视频生成能力；否则 UI 显示“该供应商当前未发现可用视频模型”。

### RelayMe

使用 Bearer API Key 调用：

- `GET /models`
- `POST /chat/completions`
- `POST /images/generations`
- `POST /videos/generations`
- `GET /tasks/{taskId}`
- `GET /tasks`
- `GET /workflows`
- `GET /workflows/{id}`
- `POST /workflows/validate`

RelayMe 的模型和能力以带密钥的 `/models` 响应为准。公开模型目录可作为未登录预览，但不能替代受保护目录的能力判断。

## 模型目录与能力映射

统一能力值：`chat`、`vision`、`reverse_prompt`、`image_generation`、`image_edit`、`video_understanding`、`video_generation`、`async_tasks`。

能力映射规则：

1. 聊天列表只显示 `chat`。
2. 反推图片需要 `vision` 或供应商明确返回的 `reverse_prompt`。
3. 反推视频需要 `video_understanding`；不能仅凭模型名称含有“video”就启用。
4. 生图列表只显示 `image_generation`。
5. 视频列表只显示 `video_generation`。
6. 模型缺少能力字段时默认不授予高级能力，并显示中文说明。
7. RelayMe 重复条目按 `deploymentName/modelId + 能力` 合并，保留价格、特价或版本元数据，不重复显示相同路由。
8. 同名但不同供应商的模型不合并，UI 必须显示供应商标识。

## 生图与视频智能比例尺寸适配

所有真实生图和视频模型共用一个规范化参数层，但每个模型使用自己的能力约束：

- UI 使用统一目标：比例、清晰度、生成数量；视频额外包含时长、首尾帧与参考素材能力。
- 模型目录保存其支持的比例、像素尺寸、清晰度档位、数量范围、视频时长范围/步长和素材限制。
- 请求前由 `ModelParameterAdapter` 把统一目标转换成该供应商、该模型的真实字段，不把 Comfly 参数直接传给 RelayMe。
- 模型原生支持目标比例时使用原生参数。
- 不支持时优先选择等比例且不裁剪的最接近尺寸；必须裁剪、补边或二次放大时，在按钮上方明确展示“实际输出”和处理方式，用户确认后才提交。
- `4K` 只在模型原生支持或存在明确的后处理能力时可选；不得把 2K 请求标成 4K。
- 视频时长按模型真实范围适配。例如模型只允许固定档位时选择最近档位，允许连续范围时按合法步长校正，并在提交前显示实际秒数。
- 切换模型后立即重新校验比例、清晰度、数量和时长；无效值自动进入“待确认适配”状态，不静默提交。
- 生成结果记录真实供应商返回的宽、高、时长和媒体数量，预览按原始比例展示。
- 无法发现参数能力时只展示供应商明确支持的最低公共选项，并显示“模型参数能力未完整返回”。

## 配置与密钥安全

- Comfly 和 RelayMe 使用独立凭据槽，API Key 只进入桌面安全凭据库。
- 设置页只显示掩码和“已配置/未配置”，不回显完整密钥。
- API Key 不写入项目 JSON、日志、截图、测试快照、Base64 数据或渲染进程持久化状态。
- 修改基础地址时继续执行 HTTPS、主机与重定向安全校验。
- 错误信息必须脱敏 Authorization、Bearer、token、secret、文件路径和原始任务 ID。
- 浏览器验收环境使用合同级模拟，不冒充真实付费请求成功。

## 桌面桥与服务注册表

IPC 请求携带 `provider`，供应商相关操作按供应商隔离：状态、连接检查、配置、模型目录、聊天、反推、生图、视频、任务轮询和取消。新增通用任务结果合同，图片和视频任务共享状态机，但结果媒体类型严格区分，禁止把输入素材当结果。

## 设置与节点 UI

- 原 GLM 占位卡替换为 RelayMe，Comfly 卡片继续保留。
- 点击供应商卡片切换该供应商的地址、密钥、连接检查和模型列表；两张卡片都可启用。
- 模型列表支持按聊天、反推、生图、视频筛选，并显示供应商、模型名、能力和可用状态。
- 用户可为四类节点分别选择默认的“供应商 + 模型”。
- 节点模型选择器保存 `{ provider, modelRoute }`。
- 比例、清晰度、数量、时长等只显示或适配当前模型真实支持的选项。
- API 未配置、能力不足或参数需适配时都显示中文原因，按钮不能无反应。

## 验证标准

- 合同测试覆盖 `comfly` 和 `relayme` 的合法与非法请求。
- 两家密钥、状态、模型目录完全隔离。
- 聊天、生图、视频及任务响应分别通过客户端解析测试。
- 反推列表只接受实际视觉能力模型。
- 智能适配覆盖横图、竖图、方图、1K/2K/4K、1–4 张和所有已发现视频时长规则。
- 切换模型后无效参数必须进入待确认状态。
- 设置页可分别保存、检查和刷新两家供应商。
- 浅色、深色主题截图布局一致。
- TypeScript、Vitest、Playwright 和密钥扫描通过后才提供用户测试链接。

## 非目标

- 不抓取或硬编码网站前端展示的全部模型名称。
- 不绕过供应商鉴权、计费或使用限制。
- 不虚构 Comfly 视频端点或 RelayMe 视觉反推能力。
- 本阶段不制作安装包；先交付浏览器页面供用户验收。