# 2026-08-08 画布后续执行总顺序

用户确认顺序：先完成 API 与模型，再执行完整工作计划。

## 阶段 1：双供应商与智能参数适配

执行：`docs/superpowers/plans/2026-08-08-comfly-relayme-multi-provider-integration.md`

验收门：

- Comfly 与 RelayMe 都可独立配置隐藏密钥和检查连接。
- 两家真实模型按聊天、反推、生图、视频能力分类。
- 生图/视频比例、尺寸、清晰度、数量和时长按模型智能适配。
- 用户在浅色与深色测试页面亲自验收。

## 阶段 2：统一图槽编号

执行：`docs/superpowers/plans/2026-08-08-unified-media-slot-numbering.md`

所有真实图片/视频素材统一显示 `1–20`，拖动换位后重新编号，空槽不显示伪序号。

## 阶段 3：画布性能方案 B

执行：`docs/superpowers/plans/2026-08-08-canvas-interaction-performance.md`

保留 React Flow，优化拖动、缩放、平移、框选、节点重渲染与媒体加载。

## 阶段 4：Agent 聊天与媒体可靠性

执行：`docs/superpowers/plans/2026-08-08-agent-chat-media-reliability.md`

修复纯文本聊天、图片/视频上传和粘贴、真实缩略图、`@序号`、中文错误和桌面桥。

## 阶段 5：节点感知 Agent 与知识库成长

执行：`docs/superpowers/plans/2026-08-08-node-aware-image-agent-knowledge-growth.md`

实现工作流预览、用户确认后原子写入、撤销、KEEP/CHANGE/NEVER 候选、审核版本和跨设备同步。

## 阶段 6：整体验收

- 空白画布启动。
- 深色/浅色全功能检查。
- 用户亲自测试，不以自动测试代替页面验收。
- 所有功能通过后再讨论封包安装。