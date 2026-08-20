# 生图结果会话恢复设计

## 目标

修复图片已成功保存到历史记录，但源生图节点仍显示“生成中”、持续计时且没有结果预览的问题。修复后，生成结果必须写回原 `image_generation` 节点的 `data.config.resultAssetIds`，任务转为完成，节点停止计时；当前已经卡住的任务也应在恢复执行时完成同样的回写。

## 已确认根因

桌面桥接先用 `Store generated image` 事务保存生成资源并增加项目 revision。渲染端随后用旧 revision 提交 `Store image generation result inline`，首次提交发生 revision 冲突。冲突恢复会关闭旧项目会话并重新打开同一项目，产生新的 session ID；现有 `canContinueResult` 只接受任务创建时记录的旧 session ID，因此在重试前中止回写。模型任务继续保持 `running`，造成历史记录已有图片、节点无预览且持续计时。

## 方案

保留 session ID 检查作为第一层隔离，同时增加持久化的源节点任务所有权检查作为受控恢复条件：

- session ID 未变化时，沿用现有检查。
- session ID 变化时，仅当当前项目中仍存在任务对应的源生成节点，并且该节点的 `data.config.lastResultJobId` 与任务 ID 完全一致时，允许继续结果回写。
- 在允许前后都检查任务仍为同一个 `running` 任务，避免取消、重试或状态变化后的旧结果落盘。
- 如果节点已经开始新任务、节点被删除、项目被切换或任务不再运行，拒绝旧结果。
- 不移除全局 session 防护，不按节点 ID 单独放行，也不允许兼容型 `image_result` 节点绕过所有权检查。

`lastResultJobId` 是生成开始事务已经持久化到源节点的随机任务标识。它同时证明当前项目、当前节点和当前一代生成任务之间的归属关系，可覆盖 revision 冲突后的同项目新会话以及软件重启后的任务恢复，而无需迁移 IndexedDB 中已有任务。

## 数据流

1. 用户在生图节点发起生成；节点保存 `lastResultJobId`、`resultState: pending` 和 `execution.state: queued`。
2. provider 返回生成结果；桌面桥接保存图片资源，项目 revision 增加。
3. 节点结果提交若因 revision 冲突失败，则重新加载持久项目。
4. 新会话下的继续检查验证当前源节点仍声明同一个 `lastResultJobId`。
5. 通过后重新构建内联结果事务，将资源 ID 追加到 `resultAssetIds`，最多保留四张，并设置 `resultState: fresh`、`execution.state: completed`。
6. 模型任务转为 `completed`，计时停止。

## 当前卡住任务恢复

当前任务仍保存在 IndexedDB 中且状态为 `running`，源节点仍保存相同的 `lastResultJobId`。修复后的任务恢复流程再次取得 provider 的已完成结果时，可通过节点所有权检查并补交内联结果事务。若 provider 已无法重新返回结果，则只对当前已确认的项目、任务和资源执行一次精确修复事务；必须同时核对项目 ID、源节点 ID、`lastResultJobId`、资源 ID 和资源 SHA-256，不实现“选择最近一张未引用图片”之类的模糊自动匹配。

恢复不得创建新的外部 `image_result` 节点；结果仍显示在原生图节点内。现有显示合同保持不变：最多四张、保持原始比例、历史记录继续保留。

## 错误与安全边界

- 新项目或其他项目没有匹配的 `lastResultJobId` 时，不允许旧任务写入。
- 同一节点启动新任务后，旧任务 ID 不再匹配，旧结果被拒绝。
- 任务取消或失败后，不因节点残留标识而恢复为完成。
- 资源不存在或不可读取时，不伪造完成状态，保留可诊断错误。
- revision 冲突最多沿用现有三次提交尝试，不增加无限重试。

## 测试与验收

- 回归测试先复现：资源保存增加 revision、首次内联提交冲突、重新加载产生新 session ID，随后结果仍能写入原节点。
- 测试 session 变化但 `lastResultJobId` 不匹配时必须拒绝回写。
- 测试同节点新任务覆盖旧任务后，旧结果不能写入。
- 测试当前卡住任务在源节点和资源匹配时完成恢复。
- 运行 `model-result-commit`、`job-store`、`app-store` 和桌面持久化相关测试，再运行类型检查与构建。
- 使用隔离的真实桌面运行目录发起一次实际生成，确认历史记录与源节点同时出现结果、`resultAssetIds` 已写入、任务状态为 `completed`、计时停止。
