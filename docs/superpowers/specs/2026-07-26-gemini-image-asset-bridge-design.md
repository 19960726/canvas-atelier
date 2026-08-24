# Gemini 原生生图资产桥接设计

## 目标

将 Comfly Gemini 原生 `generateContent` 返回的内联图片安全写入当前画布项目资产目录，并让渲染器通过现有项目图片读取链路显示结果。

## 数据流

1. Renderer 提交生图请求，携带当前项目 `conversationId`。
2. Provider service 识别具备 `gemini_native` 与 `image_generation` 能力的模型，调用 Gemini endpoint。
3. 主进程解码并校验 `inlineData`，调用 `storeGeneratedImage(sessionId, bytes, mediaType)`。
4. Desktop bridge 使用 `AssetStore.stageAndCommit` 写入 `assets/`，并以项目事务更新 `project.assets`。
5. Provider task ledger 保存 opaque 任务结果；IPC 只返回安全 `assetId`、宽高和状态。

## 边界与失败处理

- Base64、文件路径、远端 URL 不穿过 IPC。
- `conversationId` 无对应打开会话时拒绝请求。
- 解码、媒体类型、大小或项目事务失败时清理暂存文件，不更新资产目录。
- Gemini 同步结果使用本地完成任务映射；OpenAI-compatible 异步模型保持现有轮询路径。

## 验证

- provider-comfly：Gemini 图片响应解析和 Base64 解码测试。
- desktop-core：生成图片回调成功、无会话失败、事务失败回滚测试。
- 全量 typecheck 与 provider bridge focused tests。
