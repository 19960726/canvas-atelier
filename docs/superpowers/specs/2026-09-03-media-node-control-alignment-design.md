# Canvas Atelier Full Acceptance Repair Design

## Objective

修复截图中确认的媒体节点 UI 问题、模型路由与素材连接问题，以及保存失败时无法完成退出的问题，并以全量源代码和安装版验收作为安装包交付门槛。

## Scope

- 媒体节点：删除不需要的视频工具按钮；生图和视频模型选择只保留一个可见入口；统一展开态可见控件高度和布局。
- 路由与连线：普通生图目录和 Reverse Agent 目录保持隔离；旧项目中的图片素材连接在安装版重载后保持。
- 持久化：关闭时保存失败仍保护未保存数据，但将真实的脱敏错误码传递给主进程恢复对话框。
- 验收：增加正常 Electron 运行态 DOM 检查、旧项目副本关闭/重启回归，并完成全量 Vitest、typecheck、build、NSIS 和安装版 smoke。

## Architecture

继续使用现有 React/Zustand/Electron 分层。`ModuleNodeCard` 负责媒体节点可见控件；`release-layout-contract.css` 提供最终运行态契约；`provider-profiles.ts` 保持生成与反推目录分离；`App.tsx` 在异步保存结束后重新读取 store 状态生成 close ACK。QA 脚本只操作复制的项目和临时 user-data，不读取或输出凭据，不触发付费生成。

## Error Handling

- 保存提交失败或超时：renderer 返回失败 ACK，主进程显示取消/放弃未保存更改并退出选项。
- 保存成功：完成 durable close，再销毁窗口。
- provider 网络不可用：记录为外部集成门禁结果，不重复发起付费请求。
- 任一必需测试失败、跳过或被执行环境阻塞：不交付“验收通过”的安装包。

## Verification Contract

1. 新增回归测试必须先对当前代码失败，再实现修复并转绿。
2. 可见图片/视频控件统一 38px；视频可见参与者只有 model、mode、settings、duration、generate 五项。
3. 安装版必须验证正常运行态计算样式、旧项目加载、素材连接、保存失败恢复、退出和重启恢复。
4. 最终安装包必须与构建目录 `app.asar`、renderer 资源哈希匹配，并记录版本、大小、时间、SHA-256/SHA-512。
