# Agent 推理、反推强度与画布可靠性设计

## 目标

在保留当前脏工作区和既有 `1.6.128` 候选修复的前提下，执行用户批准的实施项 `1 + 2 + 3 + 4 + 6`，并修复三项已反馈故障：Photoshop 智能对象适配、所选 4K 与实际 2K 不一致、旧项目无法打开。

## 范围

本轮包含：

1. 先写回归测试，锁定普通对话、创作 Agent、Codex 三种模式的控件显示、请求映射和独立持久化。
2. 为供应商语言模型目录增加推理能力元数据，声明支持档位、默认档位和实际协议。
3. 在普通对话和创作 Agent 中开放思考能力控件。
4. 增加独立的快速、标准、深度反推强度；Agent 会话按任务保存，画布反推节点按节点保存。
5. 在设置的 MCP 联动页增加 Codex/MCP 能力诊断卡。
6. Photoshop 导入的智能对象按原图比例等比缩放、完整放入并居中到当前文档；源图较小时也放大适配。
7. 审计所有已启用生图模型的分辨率能力与请求映射，保存实际返回像素，并在请求档位与实际结果不符时明确提示。
8. 旧项目打开失败时区分文件缺失、格式或迁移失败和可恢复版本，优先无损兼容或恢复，不能把所有失败都伪装成“文件不存在”。

本轮不实现两阶段深度反推和中断续写，因为用户明确没有选择原计划第 5 项；不发起真实或付费供应商任务；不发布、不安装、不清理工作区文件。

## 推理能力目录

供应商语言模型 profile 增加可选的 `reasoning`：

```ts
interface ProviderReasoningCapability {
  readonly efforts: readonly ('low' | 'medium' | 'high')[];
  readonly defaultEffort: 'low' | 'medium' | 'high';
  readonly protocol: 'chat_completions' | 'responses' | 'model_variant' | 'system_instruction';
}
```

- `chat_completions` 把选择映射到 `reasoning_effort`。
- `responses` 把选择映射到 `reasoning: { effort }`。
- `model_variant` 选择同一模型族对应的 low/medium/high route，不额外伪造字段。
- `system_instruction` 只把强度写入受控系统指令，不向供应商发送未经证明的参数。
- 非语言模型不声明该能力；旧缓存缺少字段时在运行时按安全规则补齐，保持旧项目兼容。
- 本地 Codex 继续使用自身 low/medium/high/xhigh/max/ultra 目录，不缩窄已有能力。

## 三模式独立状态

每个 Agent 会话保存三种模式各自的思考强度，并单独保存反推强度：

```ts
interface StoredAgentConversation {
  readonly reasoningEfforts: {
    readonly chat: AgentReasoningEffort;
    readonly original: AgentReasoningEffort;
    readonly codex: AgentReasoningEffort;
  };
  readonly reverseAnalysisDepth: 'fast' | 'standard' | 'deep';
}
```

旧数据只有 `reasoningEffort` 时，迁移值只作为当前保存模式的值，其余模式回到 `medium`。切换任务、模式、模型、项目或重新挂载都不能把一个任务或模式的选择写入另一个任务或模式。

普通对话、创作 Agent 和 Codex 共用现有离散思考控件。控件只展示当前模型 profile 声明的档位；模型不支持原档位时，切到该模型自己的默认档位。请求必须携带当前模式保存的值。

## 独立反推强度

反推强度与模型思考强度是两个字段：

- `fast`：快速取证，优先主体、构图、光线、材质和可执行提示词，保持完整结果合同但要求简洁。
- `standard`：覆盖当前完整合同和关键取舍，是默认值。
- `deep`：逐素材证据、冲突裁决、空间与材质细节、复现步骤更详细；仍为一次供应商请求。

Agent 会话的视觉分析请求传 `reverseAnalysisDepth`，桌面层据此生成系统指令。画布反推节点把同一值写入 `ReverseAgentNodeConfig`、项目快照和专业反推请求。旧节点缺少字段时读取为 `standard`。

## Codex/MCP 诊断卡

设置的 MCP 联动页显示一张可访问的诊断卡，包含：

- 本地 Codex CLI 是否可调用、发现的模型数、当前可用最高推理档位。
- Canvas Atelier MCP runtime 状态和已公开模块/工具能力。
- Codex MCP 客户端配置状态；配置不匹配、解析失败或未连接时显示具体修复动作。
- 诊断只读取公开状态，不显示密钥、本地私人路径或原始错误内容。

## Photoshop 智能对象适配

Photoshop JSX 和 COM fallback 使用同一 contain 几何：

```ts
scale = Math.min(canvasWidth / layerWidth, canvasHeight / layerHeight)
```

允许 `scale` 大于 1，因此小图也会按比例放大到触及画布的一条边；随后按变换后的边界把图层中心移动到文档中心。不得拉伸、裁切、旋转、复制已有图层或改变文档尺寸。失败时保留现有文档和图层，不保存 Photoshop 文档。

当前根因已经确认：两条路径都使用 `Math.min(1, ...)` 并且只在 `scale < 1` 时 resize，旧测试还主动锁定了这个策略。修复同时收紧三个同路径问题：没有活动文档时在进入脚本前返回 `no_active_document`；打开源图的 fallback 必须在 `finally` 关闭源文档；只有 Place Embedded 在创建目标图层前失败时才允许进入 direct-COM fallback，避免对已经部分写入的目标文档重复导入。direct-COM 不再使用会污染系统剪贴板的 copy/paste 兜底。

## 生图分辨率真实性

每个生图 profile 只显示其已验证协议支持的 `1K / 2K / 4K`：

- 需要精确像素的 GPT Image 路线发送映射后的 `size`。
- Gemini/Nano Banana 原生路线发送 `imageConfig.imageSize`。
- RelayMe 只显示 offer 价格目录实际存在的分辨率。
- 没有证明 4K 参数的路线不得显示 4K，也不得把 UI 的 `4K` 字符串发送到不接受该值的字段。

受管结果继续以解码后的实际 `width`/`height` 为准。节点结果区域同时显示请求档位和实际像素；如果实际长边或像素面积没有达到该 profile 的档位规则，任务仍保留结果，但显示“实际分辨率低于请求”以及实际尺寸，不能把它静默标成 4K 成功。该验证不重新提交任务。

## 旧项目无损打开与恢复

最近项目打开返回结构化结果，而不是 `project | null`：

- `opened`：正常打开。
- `missing`：根目录或项目主文件确实不存在，提供重新定位。
- `invalid`：文件存在但解析或 schema 迁移失败，保留文件并显示原因。
- `recovery_available`：主版本不可读但存在有效恢复版本，允许用户打开恢复预览。

打开前再次解析实际路径，避免列表检测与点击之间的状态变化。旧 schema 通过现有迁移入口升级到内存表示，只有用户后续保存才写新版本；原文件和恢复版本均不删除。renderer 根据结构化失败显示对应操作，不能继续统一显示“请检查文件是否仍然存在”。

当前误报根因已经确认：列表只检查根目录和 manifest 是否存在；点击后的 `false` 还可能表示当前画布保存失败、恢复预览阻止切换或用户取消放弃未保存更改，popover 却把所有 `false` 写成“文件不存在”。本轮先把 renderer 切换结果改成 `opened | blocked_unsaved | blocked_recovery | missing | failed`，并让恢复预览中的最近项目入口与“打开其他项目”保持同一禁用边界。

数据兼容同时修复两处确定性缺口：稳定索引已存在时仍按条目合并有效 legacy 索引，稳定条目优先且 legacy 文件只读；`CORRUPT_JOURNAL` 与 `CORRUPT_SNAPSHOT` 一样扫描完整恢复候选。重新定位必须验证 manifest 的 `projectId`，不能把一个最近项目静默指向另一个项目。

## 回归与验收

- 所有生产修改前必须先运行对应新测试并记录预期失败。
- Agent：三模式控件、协议映射、每任务/每模式持久化、反推强度、模型切换和旧数据迁移。
- 反推节点：三个强度的节点持久化与专业请求指令。
- MCP：Codex CLI、MCP runtime、客户端配置三种状态组合，且不泄漏受保护信息。
- Photoshop：小图放大、大图缩小、横竖图、比例、完整落画布、中心误差、单图层和 JSX/COM fallback 一致。
- 分辨率：供应商映射矩阵、4K 参数快照、实际尺寸不符提示、下载和保存不缩放。
- 项目：旧 schema、丢失路径、主文件损坏但有恢复版本、不可恢复格式、列表与点击间路径变化。
- 通过聚焦测试后运行相关宽套件、全量 Vitest、全 workspace typecheck、生产 build、`scan:e2e` 和 `git diff --check`。本轮只有在用户随后要求构建候选时才重建安装包。
