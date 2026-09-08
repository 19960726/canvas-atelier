# Canvas Atelier 生成、Agent 与 Photoshop 智能对象修复设计

日期：2026-09-08。

## 用户可见目标

- 图片和视频生成完成后，结果必须可靠挂回原生成节点并可保存、关闭、重开。
- “对话”和“创作 Agent”只显示能返回文本的模型；图片输出模型不得伪装成聊天模型。
- 从画布导入 Photoshop 的图片必须成为智能对象，并在不裁切、不拉伸的前提下按原图比例适配当前文档。
- 下一正式版覆盖现有 `D:\CanvasAtelier\Canvas Atelier`，不保留并列测试安装。

## 已确认原因

### Agent 模型误分类

Comfly 动态目录把声明 `/v1/chat/completions` 或 `/v1/responses` 的模型一律标成文本对话。部分 Gemini Image、DALL-E、Qwen Image、Seedream、Sora、Veo 组件等模型只借用这些传输端点输出媒体或执行动作，并不保证返回文本，因此进入两个 Agent 选择器后会触发 `PROVIDER_INVALID_RESPONSE`。

目录构建、Renderer 选择器和主进程聊天入口都采用 fail-closed：已知图片输出身份不获得文本聊天能力；旧缓存或直接 IPC 也不能绕过服务端检查。图片生成能力只由已经验证的生成合同开放，不根据名称猜测后发起付费请求。

### 生成结果提交

真实失败包含两层。第一层是供应商完成并把媒体写入托管资产后，结果可能只含 `assetId`；Renderer 旧代码仍把缺失的 `width`、`height` 作为自有 `undefined` 字段写入事务。JournalWriter 在落 revision 前对完整请求做 canonical hash，遇到非 JSON 安全值直接抛错，IPC 最后把它误报为 `DURABLE_WRITE_FAILED`。第二层是资产写入已经推进项目 revision，Renderer 随后的“把 assetId 挂回生成节点”事务会先遇到 revision conflict；旧刷新路径又同步等待约 18 秒 recovery 扫描，超过 15 秒保存时限。

修复仅在宽高为有限正数时写入尺寸字段；缺失尺寸的事务保持 JSON 安全。冲突刷新先采用最新耐久项目并重建结果事务，把 recovery refresh 放到后台；关闭时仍会等待既有维护队列，避免降低保存完整性。

### Photoshop 普通图层降级

主 ExtendScript 使用 `Place` 创建智能对象并按比例缩放；Windows COM 降级路径却复制/粘贴源图层，然后仍返回成功。该降级路径会产生普通像素层，正是用户看到的行为。

降级路径在复制到目标文档后立即把活动图层转换为智能对象，再读取边界、使用统一比例 `min(1, canvasWidth/layerWidth, canvasHeight/layerHeight)` 缩放并居中。任何转换或适配失败都返回 `placement_failed`，不能把普通图层当作成功。

## 安全边界

- 不修改真实供应商凭据，不自动提交付费生成。
- 不覆盖或清理无关 dirty worktree 文件。
- Photoshop 安装态验证只在临时文档执行并无保存关闭，不改用户当前作品。
- source、单测、打包、安装和真实供应商可用性分别记录。

## 验收

- 回归测试先分别复现：图片模型进入 Agent、生成资产 revision 前进后结果挂载失败、COM 降级产生普通层。
- 聚焦测试转绿后运行 Renderer/Desktop/Provider/Photoshop 宽回归、全量 Vitest、typecheck、build 与打包门禁。
- 安装态验证 Agent 模型菜单、零费用生成/视频/反推合同、保存关闭重开，以及 Photoshop 临时文档中的 `LayerKind.SMARTOBJECT` 和等比例边界。
