# Canvas Atelier project memory

## 2026-09-15 多供应商模型目录复核与 4D 漏项修复

- 四供应商实现均已重新核对：Comfly、RelayMe、巨轮 API 和 4D AI 都在 provider contract、主进程注册、设置页卡片和 renderer 目录路由中；设置页按供应商独立加载，不会因为当前优先供应商而隐藏其他站点。巨轮只暴露 `openai-video` 视频模型，4D 只暴露已通过端点证据的生图、视觉反推和对话模型。
- 发现 4D 公开目录快照包含精确 `gpt-image-2.5`，但目录候选识别和静态种子此前只覆盖 `gpt-image-2.5-flare/sunburst`，导致该模型可能完全不显示。现补入 4D 候选和稳定 route；由于它当前只有 OpenAI endpoint、没有已验证的图片传输证据，仍标记 `incomplete`，不会进入可执行模型、默认模型或付费提交路径。未把 `gpt-image-2.5-2k/4k`、Gemini 4K 别名或未证实的视觉模型强行标为可运行。
- Comfly Nano Banana 变体的根因是目录归一化先按可见名称、后按模型家族去重，把 `nano-banana-2`、`nano-banana-2-2k`、`nano-banana-2-4k`（以及 Pro 对应变体）折叠成一条；现在去重键保留 1K/2K/4K 变体，桥接和 Comfly 客户端都用精确 `model`、`aspect_ratio` 与 `image_size`，不会把 Nano Banana 2 偷换成 Nano Banana Pro 2K。完整 profile 缺失比例约束时仍保留用户选择的 `9:16` 等比例。
- 生图历史原来只保存可见模型名并把历史协议路径的非 MP4 文件一律声明为 PNG，导致 JPEG/WebP/GIF 缩略图可能空白，且首屏异步校验期间会短暂显示 `0`。现在记录保存精确 `modelId/modelRoute`、比例、分辨率和张数；首屏显示加载态；modern/legacy 资源 MIME 按扩展名返回；解码失败显示明确缩略图错误。详情页可核对 `Nano Banana 2 · nano-banana-2 · 9:16 · 2K`，历史缩略图仍复用受管资产，不复制大文件。
- 当前用户目录只持久化了 Comfly 460 个完整 profile，其中 47 个为生图/视频路由；RelayMe 配置 profile 为空，4D 与巨轮 provider 配置目录为空。这是当前机器的凭据/目录状态，不代表供应商全网没有模型；RelayMe、巨轮和 4D 需要配置凭据后点击连接检测/重新检测模型，服务会以认证 `/v1/models` 与公开价格目录交集动态刷新，不以静态 seed 冒充可用。
- 同轮保留并验证画布修复：完整 profile 缺少比例表时仍保留用户选择的 `aspect_ratio`，历史先显示记录再异步容量审计，保存冲突自动采用最新 revision 后重试，引用/提示词写入合并为最新值并关闭长期 picker，重排采用 latest-only 队列，四宫格使用固定 2×2 且 `contain` 防裁切。
- 验证：供应商目录、服务、客户端、桥接、注册、历史 MIME/详情和 renderer provider 回归通过；画布、历史、保存、样式、队列和比例回归 437/437；workspace typecheck 通过；全量 Vitest 241 文件通过、2 个性能测试按设计跳过，3682/3684 测试通过。未读取 4D/RelayMe 密钥，未发起任何真实生图、视频或反推请求，不能把本轮静态/fixture 验证写成账号已在线可用。
- 生产候选：`apps/desktop-modern/dist-builder/desktop-modern/CanvasAtelier-Win10-11-x64-1.6.142.exe` 已由 electron-builder 26.0.12 生成，103324612 字节，SHA-256 `D52AB8BA8192CCD35A21CE13B07DBA9AE3E401417503312BC8813BA400E0E9FC`；解包 `app.asar` 为 6077563 字节，包含 `1.6.142` 与历史协议 MIME 修复。候选只在工作区生成，未上传 GitHub、未覆盖日用安装目录、未执行 NSIS 安装，也未发起真实供应商任务。

## 2026-09-10 1.6.127 4D Nano Banana、关闭生命周期与正式安装目录验收

- 4D 模型根因与修复：公开 `/api/pricing` 中真正同时声明 OpenAI 与 Gemini endpoint family 的精确模型是 `gemini-3.1-flash-image-preview`（Nano Banana 2）和 `gemini-3-pro-image-preview`（Nano Banana Pro）。目录归类现在先识别这两个精确 ID，再处理宽泛 Gemini/图片别名；只有公开价格目录、认证后的模型列表和 Gemini endpoint 证据三者相交才标为可执行，静态 seed 继续保持 incomplete。请求走 Gemini 原生 `POST /v1beta/models/{model}:generateContent`，比例与 1K/2K/4K 写入 `imageConfig`，参考图使用 `inlineData`，返回图从候选 part 的 `inlineData` 落入受管项目素材。仅声明 OpenAI endpoint 的 `gemini-3-pro-image-preview-4k` 与 special 4K 别名仍 fail closed，避免把未证明的接口显示成可用。
- 生图、返图和上下文链继续沿用 1.6.123/1.6.124 的稳定 projectId、精确 execution route、任务归属与有界结果摘要刷新；本轮候选及日用安装目录再次验证 GPT `high + 4K`、模型目录刷新、项目重开和完整应用重启。两轮均保持精确 route，红色“重新配置”计数为 0；受控成功图片可见，result asset 在刷新和重开后仍可恢复；缺少结果摘要时显示明确失败且不会再次提交付费任务。
- 关闭竞态根因与修复：renderer 的关闭保护曾可能被普通 focus/blur 事件提前清空，main 也会在 ACK 尚未被 coordinator 接受前记录状态；取消、失败、超时或 renderer 不可用后没有关联 requestId 的恢复通知，重复的 window close 还可能把活动 app quit 降级成仅关窗口。现在 abort 契约严格携带 requestId 与 reason，renderer 只响应当前请求且关闭保护期间忽略 blur；main 只记录 coordinator 已接受的 ACK，安全中止时重置主进程状态并通知 renderer；活动目标只允许 `window -> app` 升级，不允许 `app -> window` 降级。若 session close 已经开始，则不会再把窗口恢复成可继续编辑状态。
- QA runner 补齐 Playwright `pageerror` 收集，覆盖初始窗口、reload 替换页和第二生命周期；清理阶段先停止自有进程并删除隔离根，再归并错误、写最终 JSON 和设置退出码。full-chain 与 video/reverse helper 共 41/41 通过，四个 runner 文件均通过 `node --check`；候选与安装目录的最终报告均为 `pageErrors: []`。
- 新鲜源码验证：全量 Vitest 为 234 个文件通过、2 个性能文件按设计跳过，3439 项通过、2 项跳过；全 workspace typecheck、生产 build、`scan:e2e` 与 `git diff --check` 通过，diff-check 仅有既有 LF/CRLF 提示。相关 Playwright 为 12/12；close coordinator/modern/legacy 聚焦回归为 25/25；provider bridge 当前文件为 121/121。Comfly 配置互斥回归删除了 25 ms 墙钟竞速，直接等待 `getStatus()`；慢 provider Promise 仍保持未完成，因此实现若重新持有配置锁会由测试超时确定性失败。
- 正式候选位于 `apps/desktop-modern/dist-builder/desktop-modern-1.6.127-4d-nano-banana-close-lifecycle-20260910`。NSIS 安装包 103301035 字节、SHA-256 `82a186e4e294e642d9880f3578e745fe4fc3e6f54b2b58001d170d88cbb35d73`；候选 EXE 225448960 字节、SHA-256 `4adcc076b811efd99619c52b5f9ef8f78a2467549f231371928365aca7d4a64e`；`app.asar` 6031940 字节、SHA-256 `d78487ddfc7d6c2676e198ba502d81b4fcdbf9f2843e8743da74098d910050e4`；MCP bridge SHA-256 `24e1e662e40b888af5d5333dea0331235037d03f80e2cc0e71b28f499266b43b`。12 文件 package payload 门禁通过。
- 为保留 Codex 正在使用的 bundled MCP 进程，本轮没有运行 NSIS，而是在完整备份到 `work/qa-installed-backup-before-1.6.127-manual-deploy-20260910` 后原位部署 12 文件载荷；运行中的旧 EXE 被保留为 `D:\CanvasAtelier\Canvas Atelier\Canvas Atelier.exe.running-pre-1.6.127.bak`。日用目录 `D:\CanvasAtelier\Canvas Atelier` 的关键文件与候选同哈希，`app.asar` 版本为 1.6.127；原有 MCP PID 37344、39740、44408、57864 在部署完成快照中全部保留，之后另出现 PID 46104，GUI 进程为 0。最终审计又发现 6 个未被 `index.html` 引用的旧哈希 renderer JS，并将它们逐个移入同一备份根下的 `post-deploy-stale-renderer-assets`；清理后候选与日用 renderer 树均为 4 个文件且逐文件同哈希，报告为 `work/qa-release-1.6.127-installed-renderer-hygiene.json`，最终 12/12 应用载荷身份报告为 `work/qa-release-1.6.127-installed-identity-final.json`。注册表仍是最后一次 NSIS 安装的 1.6.123，这只表示卸载项未刷新，不能把本次手工载荷部署写成 NSIS 安装成功；MCP PID 只能作为各次检查的瞬时快照。
- 候选与日用目录均通过隔离断网门禁：四供应商设置、GPT 专用质量按钮与 4K、10 类正式节点明暗主题、精确生图 route 与返图、CSP、MCP 14/14 工具及重启持久化、图片完成/取消、视频生成、反推完整结果、媒体导入与删除。旧 renderer 文件移入备份后，又重新通过 GPT 双生命周期、10 节点明暗主题与 CSP 三项安装目录门禁，页面错误仍为空。所有 QA 自有进程和隔离根已清理，网络尝试为 0；Codex 可通过 bundled MCP 调用画布，但其他用户仍需在各自账户安装应用、配置并信任 MCP 客户端，不能把本机门禁当作所有机器已自动接通。
- 本轮公开目录和协议审计没有读取供应商凭据，没有发送真实 Comfly、RelayMe、巨轮或 4D 生图、视频、反推任务，也没有消耗额度。4D 59 模型与 Comfly 官方 Apifox 协议、Nano Banana/GPT Image 路由、客户端解析、能力守卫和零费用返图链已验证；特定账号的鉴权、模型授权、计费队列与真实最终媒体仍需用户主动发起低成本任务后单独验收。

## 2026-09-10 Julun/4D 反推知识接线与本地停止语义

- 根因：modern 与 legacy 已注册独立 Julun/4D New API service，但 4D service 没有收到 `resolveReverseKnowledge`；带固定知识快照的反推请求因此会把知识静默降为空数组。主进程现在通过 `@agent-canvas/desktop-core` 公共入口复用既有 `knowledgeStore` 与 `readPinnedReverseKnowledge`，保持知识、项目和 provider 状态都位于当前 Electron `userData` 根，Julun/4D task mapping 继续分别隔离在 `providers/julun` 与 `providers/4dai`。
- 取消语义：Julun/4D 当前只能在本地终止等待与跟踪，不能证明上游任务已取消或停止计费。任务条对这两家显示“停止等待”和“已停止跟踪”；其他 provider 的既有取消文案不变。
- TDD 与回归：`apps/desktop-modern/src/runtime-entry-contract.test.ts` 覆盖 modern/legacy 的 4D 知识解析器、公共依赖入口与 provider 根隔离；`apps/renderer/src/jobs/JobStrip.test.tsx` 覆盖本地停止文案。验证命令为 `npx vitest run --config vitest.config.ts apps/desktop-modern/src/runtime-entry-contract.test.ts apps/renderer/src/jobs/JobStrip.test.tsx`、desktop-core/modern/legacy 三个 TypeScript `--noEmit` 检查。

## 2026-09-08 安装版 Photoshop 智能对象安全验收工具

- 原因：旧的临时 Photoshop 验收脚本会读取真实项目并直接使用当前活动文档，无法证明安装版 bridge 的隔离性，也可能把测试图层写入用户文档。新增 `work/qa-installed-photoshop-smart-object.mjs` 后，安装版验收只使用隔离 user-data、离线网络门禁、脚本生成的 320×180 PNG 和唯一命名的 240×240 Photoshop QA 文档；发现任意预先打开的 Photoshop 文档时直接阻断，不创建、不激活、不关闭任何文档。
- 验收：脚本经公开 `projectImages.importDroppedMedia` 和 `projectImages.importToPhotoshop` bridge 导入素材，随后验证 `LayerKind.SMARTOBJECT`、像素取整容差内的原图比例、完整落在画布内和中心对齐。finally 只按唯一名称定位 QA 文档并调用 `qaDocument.close(SaveOptions.DONOTSAVECHANGES)`；不按活动文档或序号关闭，也不保存、退出 Photoshop。正式运行必须同时提供期望版本、EXE SHA-256 和 app.asar SHA-256。
- TDD 与当前证据：`node --test work/qa-installed-photoshop-smart-object.test.mjs` 先得到静态安全契约、几何断言、隔离路径和 operationId 的预期 RED，修复后 10/10 通过。对 1.6.114 安装版的零网络阻断冒烟已通过安装指纹、隔离 user-data、离线门禁和受管图片导入；因 Photoshop 当前已有 1 个文档而按设计停止，QA 根已删除且没有创建或关闭 Photoshop 文档。完整智能对象导入 PASS 须在无打开文档时对新正式安装版重跑。

## 2026-09-07 Provider large generated-result downloads

- 根因：Electron `net.request` 适配器虽然接受单请求 `timeoutMs`，但响应体始终使用创建适配器时的 64 MiB 全局上限；Comfly 与 RelayMe 的结果 CDN 下载没有传媒体专用策略，RelayMe 服务和 generation-history sink 也各自保留了 64 MiB 固定限制。大图或常见视频会在供应商已完成、项目素材已写入的不同阶段被误判失败。
- 修复：两家供应商的 fetch init 增加 `maxResponseBytes`，Electron 的普通与 DNS-pinned 路径都读取单请求覆盖值；Comfly 图片/视频下载分别使用 256 MiB/512 MiB，RelayMe 按结果 kind 使用同样上限，媒体 CDN 下载超时统一为 300000 ms。generation-history sink 同步按图片 256 MiB、视频 512 MiB 校验；普通 API JSON 仍沿用 30 秒与 64 MiB 默认值。
- TDD 证据：`work/qa-provider-large-result-download-red-20260907.log` 在旧实现得到 6 个预期失败；修复后聚焦 216/216 与相关宽回归 298/298 通过，见 `work/qa-provider-large-result-download-green-final-20260907.log`、`work/qa-provider-large-result-download-wide-20260907.log`。回归覆盖声明 Content-Length 超过 65 MiB 但实际小响应的 Electron 单请求覆盖，以及约 65 MiB 的结构有效 MP4 在 RelayMe 服务与 history sink 的存储路径。
- 类型检查：provider-comfly、provider-relayme、desktop-core 三个包均通过；本项未修改 UI、模型目录、安装包或本机安装版本，也未提交真实付费生成。

## 2026-09-06 Agent chat breathing layout

- 根因：Agent 面板固定 460px，消息区只有 16px 内边距，composer 固定 160px，底栏按窄控制台排列，导致对话气泡、输入框和工具按钮缺少呼吸间距。
- 修复：面板扩展到最大 560px；标题区、消息区和输入区增加分层留白；消息间距 18px，用户消息限制为 88% 宽度并使用聊天气泡；编辑区提升到 78–118px；composer 提升到 184px，工具栏保持稳定网格。窄于 620px 时使用 18px 内边距。
- 回归位置：`tests/e2e/release-agent-layout.spec.ts`。

## 2026-09-06 Codex reasoning slider UI

- 根因：Agent Codex 底栏仍使用普通 select，无法表达参考图的离散滑块、当前模型副标题、恢复默认和 Ultra 独立视觉；固定 136px 输入框高度在长档位标签下会把发送操作挤出圆角边界。
- 修复：新增 `CodexReasoningPopover`，按模型目录支持的 low/medium/high/xhigh/max/ultra 子集渲染离散 range；五档截图对应轻度/中/高/极高/Ultra，Ultra 使用紫色渐变；支持鼠标/触摸、方向键、Home/End、Escape 回焦、默认复位和模型弹层互斥。底栏改为稳定两行网格并将 Agent 顶部状态改为正常文档流，避免标题错位和状态覆盖任务选择。
- 回归位置：`apps/renderer/src/agent/CodexReasoningPopover.test.tsx`、`SkillChatWorkbench.test.tsx`、`tests/e2e/codex-reasoning-slider.spec.ts`、`tests/e2e/release-agent-layout.spec.ts`。
- 新鲜验证：相关 Vitest 146/146 通过；renderer 与 desktop-core TypeScript 检查通过；Codex slider Edge 回归 3/3（浅色、深色、800px）通过，包含截图和 hit-test；旧布局测试契约已更新为新的 160px composer 高度。完整安装包尚未因本次 UI 变更重建，不能用旧安装版证明用户路径。

## 2026-09-06 Codex model cache fallback

- 根因：Codex 服务传入 `models_cache.json` 后只返回缓存中的公开模型；本机缓存短暂缺少 `gpt-6-astra` 时，内置主模型因此从 Agent/Codex 目录消失。
- 修复：当缓存包含至少一个公开且 API 可用的模型时，服务补回已安装的 `GPT-6 Astra` 主路由；空缓存、不可用缓存和隐藏/API 未开放模型仍不会被伪装成可用模型。
- 回归位置：`packages/desktop-core/src/codex-cli-service.test.ts` 的 stale-cache 用例。
- 新鲜验证：聚焦回归在旧实现上先失败，修复后通过；完整 Codex 服务回归与类型检查随后执行。

## 2026-09-05 Codex Agent model picker and media boundary

- 根因：本机 Codex CLI profile、请求 schema、CLI 参数和返回值都把 `gpt-6-astra` 写死，虽然本机 `models_cache.json` 已列出其他公开 API 模型，Agent 选择器仍只显示 Astra；错误提示也固定称 Astra，切换模型后会误导用户。
- 修复：桌面启动时把本机 Codex 模型缓存路径传给 Codex 服务；服务仅暴露 `visibility=list` 且 `supported_in_api=true` 的安全模型 ID，按 `codex/<model-id>` 校验请求并将同一 ID传给 CLI；隐藏或 API 未开放的模型不会显示。Codex profile 仍明确为文本/MCP 通道，未把图片/视频能力标为支持，媒体提示改为当前 Codex 模型。
- 回归位置：`packages/desktop-core/src/codex-cli-service.test.ts` 验证多模型切换、缓存过滤和 CLI `-m` 参数；`apps/renderer/src/agent/SkillChatWorkbench.test.tsx` 验证 Codex 媒体提示；`apps/renderer/src/app/provider-profiles.test.ts` 验证 Codex provider 路由过滤。
- 新鲜验证：Codex/IPC/provider/Agent 聚焦套件 4 文件、164 测试通过；新增模型缓存用例后 Codex 服务 26/26 通过；`npm.cmd exec -- tsc -p packages/desktop-core/tsconfig.json --noEmit` 与 renderer 类型检查通过。

## 2026-09-05 Agent 已发送图片在消息流中缺少展示

- 根因：`SkillChatWorkbench` 将图片引用保存在用户消息的 `request.references` 中并正常发送给视觉模型，但消息气泡只渲染 `message.content`，没有把引用重新映射到当前项目素材并渲染缩略图，因此模型已收到素材而对话看不到图片。
- 修复：用户消息现在显示“已发送素材”区域；按 `assetId` 从当前受管图片/视频集合恢复缩略图，历史素材不在当前上下文时仍保留引用标签，不改变 Provider、Codex 或 MCP 请求协议。
- 回归位置：`apps/renderer/src/agent/SkillChatWorkbench.test.tsx` 的视觉引用发送用例，验证用户消息气泡出现图片和 `@图片1`。
- 新鲜验证：SkillChatWorkbench 100/100；全工作区 `npm.cmd run typecheck` 退出 0；目标 diff whitespace 检查退出 0。
- 复核发现：截图所用的本机 GPT-6 Astra 属于 text/MCP-only 路线，图片粘贴被正确拒绝，但原提示过于笼统。现在 Codex 模式显示明确的切换建议；视觉聊天路线的图片粘贴端到端 5/5 通过，Codex 边界回归也通过。
- 根因补充：如果用户在输入 `@` 后打开了“@ 图片引用”浮层，再粘贴图片，媒体导入路径此前没有关闭该浮层，导致浮层遮住新生成的引用缩略图，看起来像粘贴仍停留在引用提示。媒体粘贴现在立即关闭引用浮层；新增回归验证浮层消失且素材仍附加。
- 新鲜验证：SkillChatWorkbench 102/102；Agent 图片/视频粘贴 E2E 5/5；全工作区 typecheck 退出 0。

## 2026-09-05 WorkBuddy MCP 信任层阻断（配置文件本身无解析错误）

- 对真实运行中的 WorkBuddy 5.5.3 做只读复核后发现，`C:\Users\Administrator\.workbuddy\mcp.json` 能正常解析，且同时保留 `canvasforge` 与 `canvas_atelier`；但 WorkBuddy 主进程日志 `C:\Users\Administrator\.workbuddy\logs\2026-09-05\workbuddyMainThread__22be230a230dcc2f1d23d3d261812acb.log` 在本次检查期间累计 26 次记录 `MCP Security ... skipping untrusted server "canvas_atelier"`，最新记录仍在 13:08。对应 `refreshAndSync` 的 desired list 只包含 `custom-mcp:canvasforge` 等既有条目，没有 `custom-mcp:canvas_atelier`。
- `C:\Users\Administrator\.workbuddy\mcp-approvals.json` 当前只有一个 `canvasforge` 审批键，没有 `canvas_atelier`。因此“Canvas Atelier 自己的配置管理器/renderer bridge 返回 WorkBuddy configured、14-tool connected”只能证明本地配置与 Canvas Atelier bridge 健康，不能证明 WorkBuddy 实际 Agent 已接入；真实 WorkBuddy 用户路径当前应标为 `BLOCKED`。
- 这不是本项目的 JSON/TOML 解析、路径、重复 section、备份或 runtime 清理错误，也不是通过手工写入审批键可以安全绕过的问题。未修改 WorkBuddy 配置、审批文件或进程；需要用户在 WorkBuddy 的 MCP 安全/审批界面明确信任 `canvas_atelier` 后重启或刷新 WorkBuddy，再重新检查日志中的 desired list 和实际连接。

## 2026-09-05 登录后 RelayMe 安装版 Provider 门禁恢复

- 用户完成 RelayMe 登录后，隔离只读状态检查返回 `activeProvider=relayme`、`configured=true`、`locked=false`、连接 `connected`，并读取到 10 个 profile；10 个 profile 的 `capabilityStatus` 全部为 `complete`。`RENAF` 已恢复 `chat + reverse_prompt`，路由为 `relayme-gemini-3-1-flash-lite`。
- 安装版 `D:\CanvasAtelier\Canvas Atelier.exe` 1.6.100 的 Provider 隔离门禁已新鲜通过：图片、视频、反推三条目录均加载并完成真实控件选择，选项分别为 3、4、1；三条 rail 的元素均 `attached=true`、`positioned=true`，`pageErrors=[]`。完整结果与截图位于 `work/qa-installed-provider-isolation-1.6.100-after-login/`，固化日志为 `run.log`。
- 本次仅读取连接/任务目录并做 UI/目录隔离验证，没有提交图片、视频、反推或 Astra 生成任务。Comfly 仍为 `configured=false`、`locked=true`，因此不把 Comfly 记为通过；Photoshop 导入、付费生成、真实 Astra 对话、签名发布与多系统矩阵仍保持原边界。

## 2026-09-05 1.6.100 安装版全链验收与当前外部边界

- 当前正式核验产物为已安装的 `D:\CanvasAtelier\Canvas Atelier.exe` 1.6.100。安装包 `apps/desktop-modern/dist-builder/desktop-modern/CanvasAtelier-Win10-11-x64-1.6.100.exe` 为 103238623 字节，SHA-256 `1E39A90A99C7097E6BBBA1A53E9CF96B14A5A8FA9E41C707727295FD2DBA867E`；安装包解包与安装目录的 `app.asar` 完全一致，均为 5872033 字节、SHA-256 `2D5E6D30F9576816358DF97171C1E7F0AFDFF7247542211F15AF7EAB4ABF9ADF`。安装版 EXE SHA-256 为 `1022E86905C094DEABA5E7105D6189F6CC40CFAAE5ADCAF85E2A129EA0BB0488`。注册表安装版本与 asar 内 package 版本均为 1.6.100。
- 新鲜源码证据：完整 Vitest 220 个文件通过、2 个性能文件按设计跳过，2838 个测试通过、2 个跳过；完整 Playwright 147/147；repo typecheck、build、`scan:e2e`、10k persistence replay 与 knowledge performance 均通过。生产修复包含 WorkBuddy `mcpServers` 非对象值必须返回 `MCP_CONFIG_PARSE_FAILED`，不再静默覆盖；反推视觉验收改为测量 Agent summary 而不是有意伸出卡片外的输出 handle。
- 新鲜安装版证据：packaged/installed CSP smoke 均通过；UI 门禁在 light/dark 两套主题下通过，10 个正式节点均可创建，图片/视频控制条均为 38px、无嵌套边框，视频选中态为单层 2px 边框，深色视频菜单与节点同为 `rgb(15,20,29)`，反推模型行宽约 390px 且位于素材区下方；正式模块目录 10/10 可发现类型和 24/24 兼容类型通过，零网络 mutation、无 renderer/runtime failure。对比图位于 `work/qa-ui-comparison-1.6.100-formal2/`，已人工检查无空白、裁切、重叠或旧双层描边。
- 安装版 MCP 零费用链已通过：14/14 工具逐一调用，创建/更新/移动/连接/删除、媒体导入、QA 图片任务完成/取消、视频生成与 Agent 反推结果持久化、重启读取、公开 MCP 节点 roundtrip 均通过，网络提交次数为 0，真实项目保持不变。Canvas Atelier 自己的配置管理器/bridge 对 Codex 与 WorkBuddy 配置返回过 14-tool connected；但这不等于 WorkBuddy 外部 Agent 已通过信任层，当前真实 WorkBuddy 日志仍需以顶部 2026-09-05 记录为准。Codex 原有 `cua_repl/figma/node_repl` 和 WorkBuddy 原有 `canvasforge` 均保留；每次配置前精确备份；Codex 与 WorkBuddy 最终字节指纹不变；真实应用生命周期关闭后 `runtime-modern-v1.json` 已删除。QA runner 已改为调用 renderer `lifecycle.requestClose()`，不再用 `app.exit()` 绕过生产清理。
- 旧项目保存链已通过：对现有 QA 旧项目的只读源复制执行“打开→显式保存→关闭→重开”，4 个节点、2 条连线、3 张图片和 revision 21 全部保持；两次离线网络 guard 均启用且 blockedAttemptCount=0；源目录整树 SHA-256 前后同为 `c3ff4087c45726221e6931e2e0457ac5ee33ef1b7540f0514e570760ddc856f5`。
- Provider 当前是外部状态阻断而非产品通过：RelayMe 原始目录仍返回 10 个模型，但真实连接为 `authentication_failed`；`relayme-gemini-3-1-flash-lite` 从旧证据的 `complete + chat + reverse_prompt` 降为 `incomplete + chat`，因此产品正确地不将其暴露为可执行反推路线。需用户重新登录 RelayMe 后重跑 `work/qa-installed-provider-isolation.mjs`。Comfly 在真实安装配置中未配置，安装版目录门禁返回 `COMFLY_NOT_CONFIGURED`。未执行任何付费图片/视频生成或真实 Astra 对话。
- Photoshop 只读 COM 探测发现运行中的 20.x 实例且当前有 2 个打开文档；未执行真实智能对象导入，因为该操作会改变用户当前活动 PSD/PSB。需用户明确指定可修改的测试文档后才可做实机导入。WorkBuddy 运行进程热重载/人工重启、Windows 7/10/11 独立机器矩阵也尚未完成。
- 发布边界：安装包与安装版 EXE 的 Authenticode 状态均为 `NotSigned`，没有签名证书不能成为正式签名发布件。本轮未 commit、push、创建 PR 或 Release；这些动作仍需明确仓库、分支、提交和发布目标授权。

## 2026-09-05 MCP 启动事务与 Codex TOML 配置边界加固

- 运行时启动根因：`mcp-runtime-service.start()` 先完成 named-pipe `listen`，再发布 discovery runtime 文件；后一步失败时没有回滚，已监听的 pipe、已接入 socket、descriptor 与 service 状态会留在内存中，下一次 `start()` 还会把这个未完成启动误当作成功。现在 runtime 文件 write/delete 与 listen 可做窄适配注入；启动事务失败会先清空 descriptor/state、取消刷新 timer、销毁 socket、关闭 server、等待刷新写入并删除 runtime 与 `.tmp`，正常清理后保留原始启动错误，随后可重新启动。
- Codex 配置根因：旧 section 正则只识别 `[mcp_servers.canvas_atelier]`，无法识别等价的 `[mcp_servers."canvas_atelier"]`，而下一 section 正则不识别 `[[array.table]]`，替换时可能把后续数组表吞掉；同时配置合并前没有对整份 TOML 做结构校验，明显未闭合的字符串、表头或数组仍会被写回。现在使用仓库内受控 TOML 扫描器解析 quoted/bare dotted key、普通/数组表、单双引号及多行字符串、数组/inline-table 配对和顶层赋值；目标 section 按解析后的 key path 定位，后续任意 table header 都是硬边界，明显 malformed 文档只备份、不写入且不执行健康检查。
- 保留语义：目标 section 之外的 prefix/suffix 字节保持原样，CRLF 文档继续使用 CRLF；同秒备份继续使用独占创建的递增后缀，旧 CanvasForge 配置和备份不改动。真实本机 Codex 配置仅经 `getStatus()` 只读验证，返回 `configured`，没有写入用户配置。
- TDD 证据：新增回归在旧实现上先得到 5 个预期失败（runtime 用例超时、quoted key 被判 `unconfigured`、3 类结构 malformed TOML 被错误写入），第二轮 invalid scalar 又单独取得 1 个预期 RED；修复后聚焦 2 文件 `21/21`，MCP 宽回归 11 文件 `130/130`；`@agent-canvas/desktop-core` typecheck、build 与全工作区 `npm.cmd run typecheck` 均退出 0。回归位于 `packages/desktop-core/src/mcp-runtime-service.test.ts` 与 `packages/desktop-core/src/mcp-client-config.test.ts`。
- 交付边界：本轮没有打包、安装、启动正式应用、修改真实 Codex/WorkBuddy 配置或调用外部/付费服务；最终安装版 MCP 仍需由根任务重新构建、安装并跑真实 14 工具及客户端连接验收。

## 2026-09-05 GPT-6 Astra 本机 Codex 安全桥接 checkpoint

- 内嵌 Codex 现在通过独立 `codexCli` profile/channel 执行精确模型 `gpt-6-astra`，不把它伪装为 Comfly/RelayMe 路由，也不修改 active provider。当前安装机 resolver 选择 `C:\Users\Administrator\AppData\Local\OpenAI\Codex\bin\9ba750cce02d5e5c\codex.exe`（`codex-cli 0.153.0`），优先于 npm 0.130；只执行原生 exe，不执行 cmd/ps1 shim。
- 执行前必须通过 0.153+与 feature capability 检查。CLI 使用 `--ignore-user-config --ignore-rules --ephemeral`，只注入 `canvas_atelier` MCP；显式禁用 unified_exec、shell、view_image、skill_search、hooks、goals、sleep、plugins、multi_agent、browser/computer 等，并启用 `skip_host_skill_discovery`。本机只读 `--version`、`features list`、`exec --help` 已证明目标 0.153.0 具备这些开关；未发真实模型请求。
- JSONL 必须存在，只有一个 `turn.completed` 且为最终事件；canvas_atelier MCP 采用 completed-only allowlist：status 经 trim/lowercase 后必须严格为 completed 且 error 为空。状态缺失、`failed `、rejected、in_progress、任意失败/未知状态或非空 error 都使整次失败，不能被后续成功文本覆盖。非 canvas MCP 或 shell/file/web item 固定拒绝。
- Renderer→persistence→preload→IPC→service→runner 使用独立 requestId/cancel；模式/任务切换、新建、卸载、项目关闭/切换与 dispose 都中止旧请求。Service 从 preflight 开始全局单飞；Windows 通过 `taskkill.exe /T /F` 终止完整树并等待 close，timeout/output limit/EPIPE/卡死 close 都有受控失败，无法确认退出时 runner 熔断。临时执行目录在 runner 结束后 finally 清理。
- 本地 Codex 仍为 text/MCP-only，拒绝图片/视频引用；公开 reasoning effort 为 low/medium/high/xhigh/max，`ultra` 已移除并将旧存储值迁移为 max。二次复审修复后的新鲜相关回归为 12 files / 616 tests，desktop-modern 最近结果为 11 files / 63 tests；repo-wide typecheck 退出 0。未打包、未安装、未做 Astra live 或安装版 MCP 写画布，均不得标为 PASS。详细证据：`work/qa-codex-astra-change.md`。

## 2026-09-05 安装版正式模块目录第六节点与反推端口根因

- 正式目录脚本中第六个 `image_generation` 按 Enter 后不创建不是节点事件失效：脚本在每个小节点后执行 Fit View，使前一 `text_prompt` 把 React Flow 保留在约 `2.5x`；新建项目后模块库占宽，剩余画布坐标空间小于生图节点的安装版放置尺寸，生产安全放置逻辑因此正确拒绝。验收脚本现在每次插入前只用真实缩小控件把空画布归一到不高于 `100%`。
- 正式目录重置不得接受原生“放弃未保存”确认。脚本已移除 `dialog.accept()`/discard 路径，改为读取明确的 `data-save-state`、必要时点击真实“保存项目”、证明 `saved` 后才新建；保存失败必须直接阻断。每次隐藏运行记录 Electron PID，并证明自然退出及脚本自有临时根删除。
- Fit View 几何审核必须使用渲染缩放和节点实际边框：端口中心可位于缩放后的边框内沿，Chromium 独立矩形换算允许额外 `0.5` viewport px 数值误差；一 CSS px 的圆角内容溢出也按缩放判断。明显偏离端口及真实越界继续失败。
- 端口边缘验收必须计算“端口中心到对应卡片边”的绝对距离，不能只拒绝向卡片内部偏移；输入、输出端口向内或向外偏移 50 viewport px 均由回归明确拒绝。
- 修正后的验收脚本已在安装版依次通过目录节点 1–7（含生图、视频），随后发现真实 `reverse_agent` 生产缺陷：右输出端口中心向内偏移正好 9 CSS px，原因是终端 release CSS 把右端口改成 `translate(0, -50%)` 并裁切。源码现恢复零外边距、可见溢出和 `translate(50%, -50%)`，使左右端口中心落在卡片边界。
- 端口“完整可见”不能只看 `boundingBox`：明暗主题、初始/放大缩放均需证明端口框跨越卡片边界，内外半圆同时存在，并在外半圆取点通过 `elementsFromPoint` 命中真实 handle，从而捕获祖先裁切。
- 安装版正式目录脚本也必须执行同一硬门禁，而不能从源码 E2E 推断：每个端口记录与浏览器 viewport 及所有 overflow 裁剪祖先求交后的 `visibleBox`，并记录外半圆采样点是否由 `elementsFromPoint` 命中该 handle。lib 断言要求原始框跨越对应卡片边、内外两部分和垂直范围均未被裁掉、采样点确在外侧可见区且命中为真；“中心仍对齐但只剩内半圆”和“完整可见但外侧不可命中”都有独立回归反例。
- 高倍缩放且模块库占宽时，大节点无安全放置区不能静默 `return false`。画布现在显示独立 `模块创建提示`，明确要求缩小画布或关闭模块库重试；真实浏览器回归在 `≥2.49x` 下通过 Enter 尝试生图节点，证明不创建越界节点、保留模块库并显示可操作提示。
- 新鲜源码证据：正式目录脚本单元 `23/23`，CanvasWorkspace/样式/ModuleNodeCard `400/400`，完整 release UI audit `11/11`，完整 module-library workflow `11/11`，正式模块工作台明暗主题及三种视口 `8/8`。本轮 repo-wide typecheck 已执行，但暂时只被并行中的 Codex/Astra 未提交改动阻断，formal 任务没有修改这些文件，待并行任务收敛后由根任务统一复跑。当前已安装 `1.6.99` 仍是修复前产物，完整安装版目录仍未通过；必须重包、安装并重跑到 10 个目录节点与 24 个兼容节点全部完成后才能交付。详细报告：`work/qa-formal-catalog-debug.md`。

## 2026-09-01 MCP、RelayMe 持久化与 Photoshop 实机边界

- 脱敏读取正式 WorkBuddy 配置：当前已有键 `canvasforge`，命令文件为 `CanvasForge.exe`；Canvas Atelier 尚未在正式配置中连接，因此没有修改正式配置。
- 隔离合并脚本 `work/qa-mcp-config-coexistence.mjs` 使用当前编译后的管理器验证：连接后键为 `canvas_atelier, canvasforge`，断开后仅保留 `canvasforge`；原命令 `D:\CanvasForge\CanvasForge.exe` 前后不变，Canvas Atelier 使用 `runtime-modern-v1.json`。脚本退出 0。
- RelayMe 正式数据脱敏检查：`provider-active.json` 指向 `relayme`；`provider-credentials.json` 存在且字段仅为 `version,kind,ciphertextHex`，484 字节，证明凭据以密文持久化而非明文。当前会话是否仍获服务端接受仍需 Electron 连接检测，不能据文件存在判定登录有效。
- Photoshop runner `--inspect` 实机返回 `{"kind":"automation_unavailable"}`；当前机器无法取得 Photoshop COM 自动化实例，因此 PS 导入仍不能判定可用。
- `npm.cmd run typecheck` 与 `git diff --check` 新鲜通过。Playwright、生产构建、安装版 RelayMe/旧画布/MP4 仍受子进程 `spawn EPERM` 和审批 503 阻塞。

## 2026-09-01 旧画布连线重测边界修正

- 复查发现增量端点重测初版会对所有“启动时已有边”跳过首次刷新；这可能让旧保存画布继续出现状态有边但 React Flow 不显示线的问题。
- 现在仅当首次端点数大于 40 时跳过全量刷新；旧画布常见的小规模已有边首次仍调用 `useUpdateNodeInternals`，后续只刷新新增/移除端点。
- `npx.cmd tsc -p apps/renderer/tsconfig.json --noEmit` 新鲜通过。完整 E2E、压力、生产构建和安装版验收仍因 `spawn EPERM`/审批 503 未完成，不能发布。

## 2026-09-01 继续验收（环境仍阻塞）

- `npm.cmd run typecheck` 新鲜通过，`git diff --check` 无错误。
- Playwright/Edge 与 Vite/esbuild 仍无法启动：沙箱外审批服务持续返回 503，沙箱内返回 `spawn EPERM`。因此本轮无法重新证明端点增量重测后的压力、完整 E2E 或安装版行为。
- 未发布、未提交、未创建新安装包；现有 `1.6.87-verified` 仍是修复前旧产物，不得使用。

## 2026-09-01 继续验收状态

- 再次尝试完整 `npm.cmd run build`、Vitest 和 Edge 压力验收时，执行环境均无法启动 Vite/esbuild/Edge 子进程：沙箱内为 `spawn EPERM`，沙箱外审批服务为 503。不能把上一次通过结果延用为当前修改后的新鲜证据。
- 当前源码 `npx.cmd tsc -p apps/renderer/tsconfig.json --noEmit` 通过，`git diff --check` 无错误。已确认没有可安全归属于本项目的残留 Electron/Node 测试进程；系统中存在其他应用的 Edge/WebView 进程，未终止。
- `apps/desktop-modern/dist-builder/desktop-modern-1.6.87-verified/CanvasAtelier-Win10-11-x64-1.6.87.exe` 是端点增量重测修复前生成的旧产物，不能作为当前源码的安装版验收证据，不能发布。
- 未完成：端点增量重测后的完整 146 项 E2E、大画布压力、重新打包及旧保存画布安装版重启/RelayMe/MP4 验收。

## 2026-09-01 全功能验收继续（未完成）

- 新鲜完整 Vitest：211 个文件通过、2 个跳过；2633 个测试通过、2 个跳过。`npm.cmd run typecheck` 通过。
- 新鲜完整 Playwright 首轮为 142/146 通过。4 项失败中，视频比例和分辨率、模型分组、设置区宽度均为过期验收断言；更新契约后这些项目通过。端口连线首次在全套顺序下出现状态 edgeCount=1 但 `.react-flow__edges` 为空，单独诊断确认 React Flow 动态句柄内部测量刷新竞态。
- 保护修复：`CanvasWorkspace` 增加 React Flow `useUpdateNodeInternals` 的边端点增量重测；只刷新边变化引入/移除的节点，避免大画布 O(V) 刷新。固定顺序的端口连线用例已通过，`CanvasWorkspace`/视口回归 139/139 通过。
- 未完成项：增量重测后的完整 146 项 Playwright 和 300 节点/500 连线压力验收尚未取得新鲜通过证据。沙箱外执行通道随后连续返回审批服务 503，沙箱内 Edge 启动失败 `spawn EPERM`。因此不能声称全部功能通过、不能生成正式安装包或发布。
- 变更位置：`apps/renderer/src/canvas/CanvasWorkspace.tsx`、`tests/e2e/generation-parameter-adaptation.spec.ts`、`tests/e2e/manual-acceptance-interactions.spec.ts`、`tests/e2e/module-library-workflow.spec.ts`、`tests/e2e/release-ui-audit.spec.ts`；验收计划：`docs/superpowers/plans/2026-09-01-full-function-verification.md`。

This is the durable regression memory for `staging-canvas-build`. Read it before every modification and update it after every verified fix.

## Current continuation checkpoint

- Current objective: completed on 2026-08-23. Preserve the verified layout, wheel, clipboard, mention, Reverse Agent, draft, startup hydration, autosave, and reopen behavior in every later change.
- Completed: root causes traced; durable working rules added; regression tests added for final CSS anchoring, node `nowheel` boundary, image/video draft dispatch, and generation draft autosave.
- Current evidence: focused persistence/UI suites pass 396/396. Full workspace TypeScript/build passes. Full workspace Vitest passes 193 files and 2283 tests, with 2 performance suites/tests skipped by design and 0 failures.
- Completed implementation: final image/video rail is absolutely anchored 18px inside the node bottom; every module node is a React Flow `nowheel` boundary; image/video prompt and control drafts immediately enter the active project and schedule autosave.
- Durable-state audit: the most recent installed-app snapshot (`s-47-18423096`, revision 47) contains all nine image nodes and the image prompt `生成一条鱼`, but its Reverse Agent `role` and `task` are empty. This proves the reported reverse failure was a missing saved task, not successful model execution.
- Verified: full workspace suite passed on 2026-08-23: 193 test files passed, 2 performance suites skipped by design, 2283 tests passed and 0 failed. This includes Reverse Agent, ordered media, mention input/wheel, clipboard media, Photoshop, autosave/recovery, image/video generation, and desktop persistence suites.
- Verified: full workspace TypeScript typecheck and production build exited successfully. Vite emitted only its existing large-chunk advisory.
- Verified packaged runtime: the current `win-unpacked/Canvas Atelier.exe` opened against an isolated QA data root, displayed the canvas, reported no fatal alert, and closed normally.
- Current installer: `apps/desktop-modern/dist-builder/desktop-modern/CanvasAtelier-Win10-11-x64-1.6.38.exe`; last write `2026-08-23 15:30:00`; size `103100925` bytes; SHA-256 `6328649E97872031DE98A4171732B774092E771420C7F3393238535BBE1707EA`. Any earlier same-name binary is obsolete; compare SHA-256, not filename alone.
- Next continuation: if the user reports a packaged-runtime symptom, reproduce it against this exact hash and append the result here before changing code. Do not compare against an older `1.6.38` binary by filename alone.

## Non-negotiable product behavior

- Preserve all unrelated uncommitted work. Never reset or replace the dirty worktree.
- Image-generation and video-generation parameter rails stay inside the bottom of their expanded node. They must never participate in normal document flow, jump to the top, or overflow the node boundary.
- All controls in a generation rail use one aligned height and remain usable at supported zoom levels.
- Text and parameter edits are drafts of the current node immediately. Collapsing, selecting another node, autosaving, closing, and reopening must not revert them to stale config.
- Autosave overwrites the active saved project identity. It must not silently create a blank replacement project, and it must restore text/config as well as media.
- Reverse Agent uses every connected media item in deterministic input order. A successful provider connection is not sufficient by itself: role/task/route drafts must remain present and the UI must explain any real validation failure.
- Typing `@` at any valid caret position opens the reference picker. Existing mention chips must not prevent later mentions. The picker and every long editor/list must accept mouse-wheel scrolling without React Flow consuming the event.
- Pasting an image or video into a selected compatible node replaces that node's material directly. Pasting on blank canvas creates the appropriate input node. It must not open a file chooser unless the user explicitly clicks import/upload.
- Keep the minimap usable for returning to off-screen nodes.

## Active regression audit (2026-08-23)

### Generation rail placement

- Observed cause: the last `Final terminal generation geometry` CSS block overrides the earlier bottom-anchor rule with `position: static !important`, so image/video controls render at the top and can escape the card.
- Protected fix: final cascade must use absolute bottom anchoring with explicit insets and reserved editor space.
- Regression test: `apps/renderer/src/main.styles.test.ts` must assert the final rule, not an obsolete intermediate rule.
- 2026-08-23 follow-up root cause: the compact video rail assigned both `Video preview quantity` and `.module-node__run-generation` to grid column 5. CSS Grid therefore created an implicit second row, making the action drop below the other controls and enlarging/overflowing the white rail. The old regression test incorrectly required this collision.
- Protected fix: after hidden video mode/duration/audio controls are removed, the five visible cells are model column 1, ratio column 2, resolution column 3, quantity column 4, and action column 5. The rail has one explicit 38px row; every visible control and the action remain 38px high.
- Verification: `npm.cmd exec vitest -- --config vitest.config.ts apps/renderer/src/main.styles.test.ts apps/renderer/src/canvas/ModuleNodeCard.test.tsx --run` passed 193/193 after first failing exactly on the erroneous quantity-column contract.
- Packaged follow-up exposed a second cascade defect: the old expanded-video selector had greater specificity than the first shared terminal child selector, so model and quantity remained 28px while the popovers/action were 38px. The legacy rail also retained a 64px minimum and full-parent width, extending past the node despite final left/right insets.
- Protected terminal geometry: the rail width is `calc(100% - 36px)`, height/min/max-height are 60px, and its direct image/video selects plus the action are explicitly 38px at the same expanded-state specificity. Do not weaken this to a low-specificity shared `:is(...)` rule.
- Packaged coordinate acceptance after rebuilding: video model, ratio, resolution, quantity, and action all measured `y=1190` and `height=38`; rail measured `height=60`; `oneRow=true`, `oneHeight=true`, and `railInsideNode=true`.
- Release verification after the follow-up: full workspace Vitest passed 193 files and 2269 tests with 2 performance suites/tests skipped by design; `npm.cmd run build` completed typecheck plus all production builds with exit code 0; Electron Builder completed NSIS packaging with exit code 0; packaged smoke reported `canvasVisible: true` and `fatalAlertCount: 0`.

### Draft text disappearing

- Observed cause: image/video editors keep prompt and parameters only in component-local state. Unmount/reopen initializes from stale node config, so typed text disappears and autosave cannot serialize it.
- Protected fix: every edit updates the active node config and schedules autosave, matching the Reverse Agent draft path.
- Regression tests: component draft-dispatch tests plus store save/restore tests.
- 2026-08-23 reopen root cause: image, video, and Reverse Agent editors initialized local text state from `config` only once. When desktop hydration or opening a saved canvas supplied newer config to an already mounted node with the same id, the editors kept their earlier blank local state and their draft effects could write those blanks back over the restored values.
- Protected hydration fix: whenever persisted `config.prompt`, Reverse `config.role`/`config.task`, model controls, knowledge ids, or reference ids change, synchronize the mounted editor state before its draft effect persists again. This applies to image generation, video generation, and Reverse Agent; do not rely on `useState(config...)` initialization alone.
- Regression proof: three new component cases first failed for restored Reverse, image, and video text, then passed after config-to-local synchronization. The combined style/component/store/App close-flush run passed 4 files and 367 tests.
- 2026-08-23 packaged-runtime root cause: startup `hydratePersistence()` could finish after the user had already created nodes and typed. It unconditionally cancelled the pending autosave and replaced the active canvas with the earlier startup snapshot, producing the visible symptom where text suddenly vanished and only old media survived reopening.
- Protected startup rule: capture the project object and persistence generation before hydration. Apply the hydration result only if both remain unchanged after every hydration read; a delayed startup result must never cancel or overwrite edits made while the app is opening.
- 2026-08-23 commit race root cause: generation and Reverse draft actions waited for the active stable commit before placing text in store state. Closing during that wait saw no pending draft. A successful older ACK was also treated as failure whenever a newer draft changed the project object.
- Protected draft/ACK rule: draft actions synchronously update the active project and schedule autosave. When an older commit succeeds in the same project and generation, accept only its revision while preserving the newer project object, then commit the queued latest draft.
- Additional persistence protections: Reverse field writes are serialized and merged; first writable desktop session creation is single-flight; autosave commits preserve newer drafts scheduled during an in-flight commit; same-project layout synchronization does not rotate the persistence boundary.
- Packaged acceptance: two independent runs each created Reverse, image, and video nodes, typed unique text, clicked the real close button, reopened the app, and restored every field exactly. All six reopen scenarios passed.

### Wheel scrolling

- Observed risk: React Flow consumes wheel events unless interactive node regions use its `nowheel` boundary; isolated textarea handlers do not protect every nested menu/list/editor.
- Protected fix: node/editor scroll regions must be inside a `nowheel` boundary and preserve native overflow scrolling.
- Regression tests: node boundary contract and mention-editor wheel propagation tests.

### Reverse execution

- Observed failure mode: provider health can show connected while Start remains unavailable or execution fails because role/task drafts reverted to blank or were not serialized. Provider health and request validity are separate states.
- Protected fix: persist Reverse Agent fields immediately, validate with a visible reason, and submit all connected ordered media.
- Regression tests: draft persistence, enabled-state validation, ordered multi-image request, and provider error rendering.

## Release gate

Before producing an installer, verify at minimum:

1. Focused Vitest suites for styles, `ModuleNodeCard`, mention input, app store persistence, and reverse execution.
2. Renderer typecheck/build.
3. Desktop build and NSIS packaging.
4. Fresh installer timestamp, size, and SHA-256.
5. No project-owned process is left running and no unrelated working-tree changes were discarded.

## 2026-08-23 continuation checkpoint

- Delete key regression was traced to React Flow built-in removal racing the durable workspace deletion. `deleteKeyCode={null}`, remove-change filtering, and the node-removal editor reducer now keep one deletion owner and prevent React error #185.
- `Ctrl/Cmd+S` now calls the explicit project save boundary. Image, video, and Reverse Agent execution also establish a writable stable save point before contacting a model, so an untitled or newly edited canvas cannot reach a provider with an unsaved configuration.
- Settings model refreshes are request/provider guarded. Connection messaging counts only routes that satisfy the same runnable Reverse Agent capability contract as the node (`reverse_prompt` plus `gemini_native`, or `chat` plus `vision`). RelayMe tokens normalize pasted `Bearer` prefixes and the workspace link is `https://www.ml.relayme.uk/workflow`.
- Video controls use one five-part bottom rail: model, aspect ratio, clarity, duration, and action. Mode/audio/quantity no longer create a hidden second row; fallback duration options are 4/8/12 seconds and provider-declared options still take precedence. Duration labels use `4秒` style text.
- Marquee selection plus quick insert already plans deterministic top-to-bottom/left-to-right ordered connections for compatible image/video/reverse inputs, with skips reported instead of silently dropping materials. Minimap and native wheel boundaries remain covered by regression tests.
- Verification: full workspace Vitest `193` files, `2288` passed, `2` performance tests skipped by design; focused post-review node/settings run `210` passed; `npm.cmd run typecheck` passed; `npm.cmd run build` passed; NSIS packaging passed.
- Final release artifact after Terra-reviewed fixes: `apps/desktop-modern/dist-builder/desktop-modern/CanvasAtelier-Win10-11-x64-1.6.38.exe`, 103,101,259 bytes, SHA-256 `317F3CA0EEE583A99F65ADA4D3ADC365C4B6354B4FEC52B368F6CD22C28E2096`.

## 2026-08-23 release checkpoint (latest)

- Reverse execution root cause fixed: the renderer could keep a historical model-route alias after provider catalog refresh. The provider bridge then rejected that stale route even though connection health was green. Reverse execution now resolves the current runnable profile and submits its canonical route; the validated node config is kept complete before the request.
- Video rail root cause fixed: a higher-specificity legacy selector hid duration and could leave the compact rail with an implicit second row. The terminal CSS now keeps duration visible and fixes the five visible controls to one aligned row inside the node.
- User-data identity fixed: new desktop data is stored under `%APPDATA%\\Canvas Atelier`; `CanvasForge` and the old agent-canvas roots are migration-only sources, so existing projects/provider data remain recoverable without continuing to write under the prototype name.
- Verification: fresh full Vitest passed `193` files, `2289` tests, with `2` performance tests skipped by design. `npm.cmd run typecheck` passed. `npm.cmd run build` passed. NSIS packaging passed. Packaged smoke against the new unpacked executable reported `canvasVisible: true`, `fatalAlertCount: 0`, and exited cleanly; the reported React #185 startup failure was not reproduced.
- Current installer: `apps/desktop-modern/dist-builder/desktop-modern/CanvasAtelier-Win10-11-x64-1.6.38.exe`; size `103101348` bytes; SHA-256 `7EC890D2D861C70CDA8E15257F5E73BC91C8CACDD141B9383B305CE4739EAB91`; verify this hash before installing because the filename/version is unchanged.
- Next continuation: if a packaged symptom is reported, reproduce against this exact hash and record runtime evidence before changing code. Preserve the existing dirty worktree and do not treat provider health alone as proof that a Reverse request is valid.

## 2026-08-23 model rail follow-up

- New symptom root cause: when the provider model catalog refresh rejected or timed out, `SettingsDrawer` cleared `providerProfiles`, immediately turning image/video controls into `未配置模型` even though the last inventory was still usable. Refresh failure now preserves the last successful inventory; only an explicit invalid-credential result clears it.
- Button-height protection: the terminal UI-Gate rail now constrains native selects, parameter popovers, and the primary action to the same 38px track. The regression contract is in `apps/renderer/src/main.styles.test.ts`.
- Deliberately not persisted: automatically writing discovered catalog entries into the user-selected provider profile file caused stale models to survive API-key rotation. Keep user selection and discovery cache semantics separate; do not reintroduce that shortcut.
- Verification: provider bridge, settings, and stylesheet focused suites passed 195/195. Rebuild and installer verification are required before release.
- Release verification: fresh full Vitest passed `193` files, `2289` tests, with `2` performance tests skipped; typecheck, production build, NSIS packaging, and packaged smoke passed. The new unpacked app reported `canvasVisible: true`, `fatalAlertCount: 0`, and exited normally. Installer SHA-256 is `7EC890D2D861C70CDA8E15257F5E73BC91C8CACDD141B9383B305CE4739EAB91` (`103101348` bytes).

## 2026-08-23 button geometry follow-up

- Root cause: the video composer kept a higher-specificity legacy `.module-node__video-figma-composer .module-node__video-control-bar` rule that restored a 44px row after hydration. A lower-specificity shared child rule could not prevent the outer rail from stretching, so video controls appeared taller and more widely spaced than image controls.
- Protected fix: the terminal UI-Gate cascade now overrides the composer-specific selector, fixes both rails to a 60px bar with one 38px grid row, fixes every visible select/popover/action to 38px, and independently hides legacy video mode/audio/quantity controls while keeping duration in column four. A regression test protects the nested legacy selector from returning.
- Verification: focused styles and module tests passed `205/205`; full Vitest passed `193` files and `2289` tests with `2` performance tests skipped; typecheck and production build passed; NSIS packaging passed; packaged smoke reported `canvasVisible: true`, `fatalAlertCount: 0`.
- Current installer: `apps/desktop-modern/dist-builder/desktop-modern/CanvasAtelier-Win10-11-x64-1.6.38.exe`, `103101526` bytes, SHA-256 `37B1E0E5B14D1203F7569AEF2CD9CCD45F6CD0E449F4D452C1597966B6EF55AC`.
- Next continuation: if a packaged screenshot still differs, reproduce against this exact hash and inspect computed styles for the affected node before adding another override; do not add another broad selector without a regression assertion.

## 2026-08-23 Delete shortcut follow-up

- Root cause: the canvas Delete listener ran in the window bubble phase, so React Flow or an inner node control could stop propagation before the durable deletion transaction started. Holding the key could also enqueue duplicate deletion attempts.
- Protected fix: the canvas shortcut now listens in capture phase, still ignores editable targets and active surfaces, prevents default browser behavior, and ignores auto-repeat. React Flow's built-in deletion remains disabled so durable deletion has one owner and cannot race into React error #185.
- Regression proof: CanvasWorkspace and app-store focused tests passed `277/277`; full Vitest passed `193` files and `2290` tests with `2` performance tests skipped; typecheck/build/NSIS/packaged smoke passed.
- Current installer: `apps/desktop-modern/dist-builder/desktop-modern/CanvasAtelier-Win10-11-x64-1.6.38.exe`, `103101481` bytes, SHA-256 `BB6BA7BB7892530143CE7F43EAE263277D6EC58D32E7705CB3E910D7132EC006`.

## 2026-08-23 continuation verification

- Rechecked the three reported symptoms against the current dirty worktree. Quick Insert treats only an explicit `false` return as creation failure, so synchronous or fire-and-forget node creation closes the menu; `useCanvasDraft` ignores React Flow `remove` changes because durable deletion has one owner; Reverse Agent resolves the current runnable provider profile and rewrites stale route aliases before bridge submission.
- Focused verification passed: 6 files, 312 tests (`QuickInsert`, `use-canvas-draft`, `CanvasWorkspace`, `App`, `app-store`, and `ReversePromptAgent`). The suite includes double-click background/menu interaction, failed-then-retried creation, startup hydration guards, durable deletion, stale reverse route resolution, and visible reverse failure persistence.
- Environment note: Vitest must be run outside the sandbox because Vite/esbuild startup otherwise fails with `spawn EPERM`; that restriction is not a product test failure.
- Next continuation: if the packaged app still shows React #185 or reverse failure, capture the exact installer SHA-256 and the persisted `reverseAgentError`/renderer console error before modifying source. Do not treat a green provider-health badge as proof that the selected profile supports `reverse_prompt` plus a usable vision capability.

## 2026-08-23 React Flow edge-loop follow-up

- Root cause: controlled React Flow edges were rebuilt as fresh empty arrays during node creation. The conversion and viewport-culling layers copied `[]` on every render, so React Flow repeatedly called its internal `setEdges` and hit React error #185.
- Protected fix: `toFlowEdges` and `selectViewportCulledElements` now reuse stable empty edge arrays; the canvas delete-edge callback is also memoized. Startup hydration additionally compares a serialized project fingerprint so in-place bridge edits cannot be overwritten by delayed restore.
- Regression proof: focused canvas/app suites passed (`CanvasWorkspace`, `use-canvas-draft`, `node-types`, `use-viewport-culling`, `app-store`), including delayed startup creation; production typecheck/build and NSIS packaging passed. Packaged startup smoke reports `canvasVisible: true` and `fatalAlertCount: 0`.
- Current installer: `apps/desktop-modern/dist-builder/desktop-modern/CanvasAtelier-Win10-11-x64-1.6.38.exe`, `103101610` bytes, SHA-256 `F380A8B151BBFC46C031D3564D3FEB8D0DC3D0E10F05DDA5DC257931AFAA0F27`.
- Acceptance note: the older text-persistence harness now progresses past the former React #185 crash; its prompt locator assumes the image editor is expanded and timed out before the persistence assertion. Treat that harness result as incomplete, not as a persistence pass.

## 2026-08-24 Backspace old-project release verification

- The reported old canvas is not corrupt. A read-only copy of project `60fa8022-171c-4f04-ab60-a9ae545d0195` was opened with its provider configuration in isolated QA roots. It contains 12 nodes, 9 reverse-reference edges, and a legacy Reverse Agent task with multiple `@图片` mentions.
- The React #185 protection remains owned by `useCanvasDraft`: durable text/config replacement preserves React Flow `width`, `height`, and `measured`, while identical `dimensions` changes return the existing draft list. Dropping measurement metadata or publishing the same measurement repeatedly recreates the controlled-node update loop during text deletion.
- The exact legacy Reverse Agent text path is protected in `apps/renderer/src/canvas/ModuleNodeCard.test.tsx`: deleting ordinary text beside a legacy mention updates the real app-store draft without an update loop. Mention-chip deletion remains protected in `apps/renderer/src/mentions/MediaMentionTextarea.test.tsx`.
- Hidden QA execution is dual-gated by `CANVASFORGE_QA_MODE=1` plus `CANVASFORGE_QA_HIDDEN=1`; normal application windows still show. This permits packaged old-canvas verification without repeatedly interrupting the user.
- Release identity advanced from ambiguous repeated `1.6.38` artifacts to `1.6.47`. Packaging and runtime-entry tests assert the new version and installer filename.
- Focused release regression passed 219/219 before the final legacy text test; the final `ModuleNodeCard` run passed 167/167. Full workspace Vitest passed 194 files and 2304 tests with 2 performance tests skipped by design and 0 failures. Full TypeScript and production build passed.
- Packaged `1.6.47` smoke reported `canvasVisible: true` and `fatalAlertCount: 0`. A fresh packaged old-project run shortened the role from 198 to 197 characters and the Reverse task from 218 to 217 characters with `FAILURE=none`.
- Installer: `apps/desktop-modern/dist-builder/desktop-modern/CanvasAtelier-Win10-11-x64-1.6.47.exe`; size `103101848` bytes; SHA-256 `7D003C010C5A5B6C8ADBA961DFBDE9108E4D7035F696C6A7015CC94C4DFB75F3`; Authenticode status `NotSigned`.
- Silent install completed with exit code 0. Registry and installed `app.asar` report `1.6.47`; installed and packaged renderer hashes both equal `53052CA8780990F5EF7C37848F22757BD589EAF61F20C5FED5325C5590DC0C8C`. The application was not auto-launched.

## 2026-08-24 repeated Backspace hardening

- Hidden QA replayed the old 12-node canvas with ten consecutive real `Backspace` key events beside a legacy `@图片` chip and ten ordinary task deletions; the current packaged renderer completed all events without a fatal alert or console React #185.
- Hardened every generation/reverse external-reference hydration effect so a newly allocated but content-identical string-array config keeps the existing React state reference. This prevents old projects with serialized empty/reference arrays from scheduling redundant controlled-node updates while text deletion is publishing drafts.
- Added an eight-cycle rerender/delete regression around the legacy reverse mention path; focused ModuleNodeCard passed 167/167 and the CanvasWorkspace/use-canvas-draft/node-types/mention suite passed 154/154.
- Release 1.6.48 verification: renderer and desktop builds passed, TypeScript passed, NSIS packaging passed. Hidden packaged old-project replay completed ten real task Backspaces with `FAILED_AT=none`, `FAILURE=none`; installer is `apps/desktop-modern/dist-builder/desktop-modern/CanvasAtelier-Win10-11-x64-1.6.48.exe`, 103101914 bytes, SHA-256 `9203BA20BCA2AE3447A263DA5FFFE3367520CB8753ABE1B26854414CD74AD993`, Authenticode `NotSigned`. Silent install exited 0 and left no app process running.

## 2026-08-24 reference-chip and full-preview follow-up

- The remaining deletion path was the mention component's parent callback: every input, including a deletion that did not change the surviving reference set, returned a newly allocated array. That created an unnecessary second React/React Flow draft publication for each chip removal. `retainMentionedAssetIds` now returns the existing array when its contents are unchanged across image, video, and reverse editors.
- Added a three-chip reverse-agent regression that deletes `@图片1`, `@图片2`, and `@图片3` through the real contenteditable Backspace handler; it passes without an update-depth error. The terminal UI contract now also explicitly forces the collapsed generated-image preview to intrinsic `width/height: auto`, bounded by `max-width/max-height`, and `object-fit: contain`, so generated images are not cropped by a late legacy selector.
- Focused style and node tests pass 211/211; full TypeScript passes. Release 1.6.49 renderer/desktop builds and NSIS packaging pass. Installer: `apps/desktop-modern/dist-builder/desktop-modern/CanvasAtelier-Win10-11-x64-1.6.49.exe`, 103101926 bytes, SHA-256 `EDA325E0307C2EF6DAA07AAC0F8789BE4F4F9B954BDEB4E10ED336DD534FE762`, Authenticode `NotSigned`. A silent install retry was cancelled by Windows before launch, so installation of this specific artifact remains an environment blocker; the package itself is complete and ready to run.

## 2026-08-24 full-canvas Backspace root-cause correction

- The isolated mention and node tests were insufficient. A new full `CanvasWorkspace` regression deleted three Reverse Agent reference chips through the controlled canvas and reproduced the reported React #185 exactly at `ModuleNodeCard.tsx` model-route hydration.
- Root cause: changing `config.referenceAssetIds` reran a combined hydration effect that also reset local `modelRoute` from persisted config; the capability-compatibility effect then changed it back. Under the real app-store and React Flow subscriptions, repeated reference deletion made those two updates ping-pong until React reached maximum update depth. Model-route hydration now depends only on `config.modelRoute`, reference-array hydration is separate, and reverse text edits persist only after the local draft is coherent.
- Save feedback was already generated by the hidden JobStrip. A visible `aria-live` save-state pill now lives beside the top-bar save control and reports pending, saving, success, and failure states. The shared terminal control contract now covers image/video/reverse parameter rows, storyboard controls, reference-add, and settings-agent controls with the same 38px height, 10px radius, zero vertical padding, and 8px row gap.
- Fresh regression evidence: `App`, `ModuleNodeCard`, `CanvasWorkspace`, and stylesheet suites passed 346/346; packaging-boundary and runtime-entry suites passed 15/15; full typecheck and production build passed; NSIS packaging passed.
- Release 1.6.50 installer: `apps/desktop-modern/dist-builder/desktop-modern/CanvasAtelier-Win10-11-x64-1.6.50.exe`, 103101940 bytes, SHA-256 `CB2A8673F784C68068F881534CC47C635856763BD8538920641836FC4F06A128`. Silent installation to `D:\CanvasAtelier\Canvas Atelier` exited 0; installed `app.asar` reports 1.6.50 and matches the packaged SHA-256 `A06073B83C792EE61A25E8A8AAAC6FA7FE8F5687AFEE1F7C231C4E57DF70EBFE`. No application process was launched. The mistaken duplicate `D:\CanvasAtelier\Canvas` created by an earlier unquoted NSIS `/D` argument was verified and removed.

## 2026-08-24 batch-selection entry-point follow-up

- The previous batch-selection work had the deterministic connection planner and module-library callback, but no visible action surface matching the reference workflow. The canvas now shows a floating `批量连接选中素材` toolbar only when at least two selected nodes are compatible media nodes; its image, video, and Agent reverse actions reuse the existing durable creation-and-connection transaction.
- Existing blank-canvas insertion, single-node module creation, deletion, save, and editor shortcuts are unchanged. The toolbar uses the safe viewport placement path and does not create a node when the current viewport cannot fit it.
- Fresh CanvasWorkspace and stylesheet regression passed 164/164; full TypeScript passed after the new toolbar was type-guarded.
- Release 1.6.51 build and NSIS packaging passed. Installer: `apps/desktop-modern/dist-builder/desktop-modern/CanvasAtelier-Win10-11-x64-1.6.51.exe`, 103102222 bytes, SHA-256 `853E81FCD5BE5919AB46BAB8927CE003A8A68AFFF309CA8F37C7140EBDE1565A`. Silent installation exited 0; installed version is 1.6.51, installed and packaged `app.asar` SHA-256 both equal `40E88D87A2F3B04681B88DBF08D68DC261FEEAB5317D1E915E0125BECF49EAA2`, and no application process was launched.

## 2026-08-24 Codex Agent conversation and structured reverse workflow

- Replaced the one-shot Agent surface with project-scoped persistent tasks, task switching, new-task creation, Chat/Original/Codex modes, reasoning effort, and independently switchable model routes. The layout follows the requested Codex Agent anatomy while retaining Canvas Atelier styling.
- Structured visual reverse requests now preserve ordered `@图片N` references and explicitly request visible subject/environment/material/light/camera/depth, foreground/midground/background structure, composition, perspective, per-reference duties, inherit/replace/do-not-copy rules, Chinese and English prompts, negative constraints, and an execution checklist. After a structured reverse result, the Agent asks whether to draft a workflow; drafting still requires the existing canvas confirmation before mutation or execution.
- Fresh focused evidence: CanvasWorkspace `121/121`; image actions, node geometry, slots, persistence, clipboard and Photoshop group `352/352`; Agent/profile/provider bridge group `179/179`; post-type-fix Agent group `56/56`; desktop release contracts `23/23`; full workspace TypeScript and production build passed. Hidden packaged smoke returned `canvasVisible: true` and `fatalAlertCount: 0`.
- Release 1.6.54 installer: `apps/desktop-modern/dist-builder/desktop-modern/CanvasAtelier-Win10-11-x64-1.6.54.exe`, 103105875 bytes, SHA-256 `DAEA6A9DA6E490D4D376438D0C96683FFB0AE42914F39191C89DEB78CA16F42A`, Authenticode `NotSigned`. Silent installation to `D:\CanvasAtelier\Canvas Atelier` exited 0. Installed manifest reports 1.6.54; packaged and installed `app.asar` SHA-256 both equal `2B91D38B6E3CF83696DA9CCA0D9BA0E386AA26729872389B5BC3D2B4B129CCFC`; no Canvas Atelier process was launched.

## 2026-08-24 React #185 video hydration correction and release verification

- Root cause: generation editors hydrated local video/image controls directly from every external config snapshot while their own draft effect was asynchronously persisting defaults and user edits. A stale snapshot could reset the local model route/duration/audio, then the compatibility effect changed it back; repeated Backspace/reference edits amplified the ping-pong into React error #185. Video route arrays were also recomputed on every render, so compatibility effects had no semantic boundary.
- Protected fix: image/video route lists are memoized by their route input; model route, aspect ratio, duration, resolution, output count, keyframe, and audio controls use the existing externally-hydrated draft-state guard, so local edits are not overwritten by older snapshots. Added a regression that fails on the old rollback and passes after the fix.
- Fresh source evidence: `ModuleNodeCard` passed 169/169; core suites passed 543/543 plus Agent/style/domain/desktop-core follow-up 149/149 (692 total). Typecheck and production build passed.
- Fresh packaged hidden runtime: Backspace after text edit, image insertion, video insertion, and save completed with `fatalAlertCount=0`, `pageErrors=[]`, `nodeCount=2`, and `saveState=本地稳定点已保存`. Reverse/image/video restart persistence each returned `preserved=true`. Release E2E passed 7/8; the only failure is a pre-existing test configuration mismatch that hard-codes a missing `Gemini Vision` route, not a renderer error.
- Release 1.6.55 installer: `apps/desktop-modern/dist-builder/desktop-modern/CanvasAtelier-Win10-11-x64-1.6.55.exe`, 103108084 bytes, SHA-256 `58EFE0869446737F1FA7BC79AD0112530A3CED92668AFB670F0460FF70184FDD`. Silent installation to `D:\CanvasAtelier\Canvas Atelier` exited 0; installed and packaged `app.asar` SHA-256 both equal `A1FE300059DDEE4A5656162BE0AF3ECAC61916A38432844D2BAC2D88FA99A7EE`; no application process was launched.

## 2026-08-24 final slot and compact-agent UI correction

- Root cause of the remaining reference-slot complaint was interaction CSS, not the reorder transaction: the row scrollbar was explicitly hidden, reorder buttons were pointer-disabled until hover, and legacy UI-gate selectors could hide the row children. The row now supports vertical-wheel-to-horizontal scrolling, keeps all reorder controls visible, and exposes a thin scrollbar; the existing reorder callback already passed arbitrary slot 4, 9, and 20 moves.
- Removed the decorative `AGENT WORKSPACE · OUTPUT` surface label that leaked into the left edge of the canvas. Agent composer model labels are ellipsized inside a wrapping footer so mode, model, effort, knowledge, and send controls remain usable at narrow panel widths. Image/video generation rails retain the Canvas-style 38px unified control contract.
- Fresh focused evidence: ConnectedAgentMediaSlots `11/11`, main styles `48/48`, SkillChatWorkbench `54/54` (113/113). Full typecheck and production build passed. Hidden Electron smoke returned `fatalAlertCount=0`, `nodeCount=2`, `pageErrors=[]`, `saveState=本地稳定点已保存`.
- Rebuilt release 1.6.55 installer: `apps/desktop-modern/dist-builder/desktop-modern/CanvasAtelier-Win10-11-x64-1.6.55.exe`, 103108271 bytes, SHA-256 `8C4D764C755CB62D977B12F444082A450149715D941FC18E176F5740526273C3`. Silent installation to `D:\CanvasAtelier\Canvas Atelier` exited 0; installed renderer asset `index-D0lDniMP.css` matches the packaged renderer hash `F751037F7EAEA11148F54494770388CA6CF0E7643E7D990D234261D6166C0618`; no application process was launched.

## 2026-08-24 slot swap and Agent composer position correction

- The prior slot CSS fix was inserted before later legacy selectors, so the later cascade hid scrollbars and disabled reorder hit targets again. The final override is now genuinely at EOF. Slot buttons stop propagation before canvas handling, all 20 cells render (including empty drop targets), and dropping an item on an empty cell resolves to the last occupied position before the durable edge-order transaction.
- The Agent composer footer now keeps the send control at the far right, hides the redundant in-composer new-task button, and prevents the model pill from overlapping the knowledge/send controls.
- Fresh focused evidence: ConnectedAgentMediaSlots `11/11`, SkillChatWorkbench `54/54`; production typecheck/build passed. Release 1.6.55 installer rebuilt at `apps/desktop-modern/dist-builder/desktop-modern/CanvasAtelier-Win10-11-x64-1.6.55.exe`, 103108521 bytes, SHA-256 `88629ADBA94826973B1AC0DBBB083C9D5D33D8B258B6A62DC816D10DCF89F441`. Silent install to `D:\CanvasAtelier\Canvas Atelier` exited 0; installed renderer hash `AC37F25646DABE2D4D8BDAC879374F5CC7BEE0735215A0E8C950115AB295F44D` matches the packaged renderer; no application process was launched.

## 2026-08-24 slot swap durable-conflict and Electron pointer correction

- The remaining no-op had two independent causes. A `REVISION_CONFLICT` makes `reorderModuleInput` return `false`, which the slot UI previously ignored; the node now reloads the durable project and retries the exact requested edge order once. The pointer fallback also captured the pointer on the source cell, preventing Electron from delivering enter/release to the destination cell; pointer capture was removed while native HTML drag and pointer drag remain available.
- Empty visual slot placeholders were removed again: image, video, and Reverse Agent trays render only actual connected media, with a `N / 20` capacity counter. All real cells keep durable edge identity, and real images/videos disable nested native dragging so the slot owns the gesture.
- The Agent composer groups knowledge and send actions so older direct-child `last-child` rules cannot stretch the send button over adjacent controls. The compact top project actions use 36px controls and hide the saved-state pill while retaining compact error feedback.
- Fresh focused regression passed `285/285`: ConnectedAgentMediaSlots `13/13`, ModuleNodeCard `170/170`, SkillChatWorkbench `54/54`, and main styles `48/48`. Coverage includes slot 20 to slot 1, positions after slot 4, Electron pointer fallback, conflict reload-and-retry, connected-only rendering, and Agent layout. Full TypeScript/production build passed.
- Hidden packaged runtime passed with `fatalAlertCount=0`, `nodeCount=2`, `pageErrors=[]`, and no failures after repeated Backspace and both save paths. Rebuilt 1.6.55 installer is `apps/desktop-modern/dist-builder/desktop-modern/CanvasAtelier-Win10-11-x64-1.6.55.exe`, 103108708 bytes, SHA-256 `2749134C11A1B2A6E03324B74078B8ECD4FE3D1D22C144A2F00A0F8FCC37F10C`. Silent installation to `D:\CanvasAtelier\Canvas Atelier` completed; packaged and installed `app.asar` SHA-256 both equal `A1FE300059DDEE4A5656162BE0AF3ECAC61916A38432844D2BAC2D88FA99A7EE`. No application window was shown.

## 2026-08-25 worktree pollution boundary and local checkpoint

- Root cause: the repository ignored generic `dist/` but not root `.tmp-*` QA roots, `artifacts/`, either Electron Builder output location, the root runtime index, or the copied root desktop entry. This exposed 21,404 generated files as untracked changes alongside the real source work.
- Protected boundary: `.gitignore` now excludes only those proven generated/runtime paths while retaining all source, tests, installer configuration, and project documentation. One accidental 16 KB `tatus --short` file containing only redirected Git line-ending warnings was removed after its exact workspace path and content were verified.
- After the ignore correction, untracked paths fell from 21,404 to 237; the remaining paths were real source/tests/docs. They and 140 tracked changes were preserved in one local checkpoint instead of using reset/clean. Pre-checkpoint verification remained the fresh full Vitest result of 196 files and 2,344 passing tests (2 performance tests skipped by design), plus a successful no-emit workspace typecheck. No application runtime was launched for this cleanup audit.

## 2026-08-25 continuation verification

- The current checkout still has exactly two unrelated user-owned source edits: the untitled-project stable-save boundary in `apps/renderer/src/app/app-store.ts` and the terminal generation/Agent layout cascade in `apps/renderer/src/styles/app.css`. No source edits were made during this continuation.
- Fresh focused verification passed: renderer styles, `SkillChatWorkbench`, `ModuleNodeCard`, and `CanvasWorkspace` passed `393/393`; app-store, autosave, desktop-persistence, and durable-canvas semantics passed `228/228`.
- Fresh workspace `npm.cmd run typecheck` passed with exit code 0. The first in-sandbox Vitest attempt was blocked at Vite/esbuild startup by `spawn EPERM`; the same command was rerun in the permitted environment and reached the tests successfully.
- No packaged runtime or installer was produced in this continuation. Existing generated QA roots remain ignored and no unrelated worktree changes were discarded.

## 2026-08-25 Agent reverse workflow continuation

- Reproduced the remaining reverse failure in the renderer: a request containing ordered media references was intercepted by the selected-node canvas action branch, so it never reached visual chat when no reverse node was selected. The guard now bypasses that branch only for `reverse_agent` requests that carry references; node-targeted reverse execution remains confirmation-gated.
- The desktop bridge already supplies the ordered `referenceMentions` and `visualAnalysis` contract to the provider. No project-memory IDs or private metadata were added to the provider prompt.
- Added a deterministic structured reverse contract and workflow proposal model. JSON and fenced-JSON assistant responses are parsed into the contract; legacy prose remains readable and is marked non-runnable until required visual/prompt sections are present.
- Added a compact Agent summary showing subject, composition, Chinese prompt, and missing required sections before workflow drafting. Existing durable plan confirmation remains the single canvas/model execution boundary.
- Fresh verification: `SkillChatWorkbench` plus reverse contract passed 59/59; renderer interaction suite (styles, media slots, module nodes, workspace, app-store) passed 569/569; desktop visual-analysis/provider tests and proposal test passed 8/8; renderer no-emit TypeScript check passed.

## 2026-08-25 browser runtime continuation

- Renderer production build completed successfully with Vite. The first browser run exposed two stale E2E assumptions in `agent-reference-workflow.spec.ts`: a hard-coded `Gemini Vision` route label and an input-value assertion against the contenteditable Agent composer. The test now selects the first configured route from the model list, reads the selected display label, and asserts the rendered `@图片1` text.
- Fresh browser verification passed: Agent managed-image reference flow and compact Agent layout both passed `2/2`. The flow confirmed no canvas commit, model job, or model submission was created by citation-only chat.

## 2026-08-26 settings button contract continuation

- Settings storage/update controls now use a terminal `release-layout-contract.css` button contract: cache directory actions, the primary cache cleanup action, and update check share 34px height, centered icon/text, radius, focus, hover, active, and disabled states. Per-cache cleanup actions use the same geometry at 30px for compact cards.
- Cache directory actions now report successful open, custom-path migration, and default-path restore in the storage card. Cleanup buttons visibly switch to `清理中…`; update checking includes a spinning refresh icon and Chinese loading label.
- Fresh focused `SettingsDrawer` verification passed `47/47`; workspace typecheck and production build passed. Real packaged renderer screenshot: `E:\\画布项目\\staging-canvas-build\\.tmp-settings-storage-buttons.png`. Electron DOM smoke confirmed one `.settings-update-action`; the update-card screenshot was blocked by Electron screenshot stability timeout, so it is not claimed as visual evidence.
## 2026-08-26 1.6.56 release-contract integrity verification

- Root cause: the desktop package version had already advanced to `1.6.56`, while two release-contract tests and one installer-path assertion still expected `1.6.55`.
- Minimal fix: updated only the stale expectations in `apps/desktop-modern/src/packaging-boundary.test.ts` and `apps/desktop-modern/src/runtime-entry-contract.test.ts`; no production code was changed.
- Protected behavior: packaging/runtime contract tests now track the current package version and the `CanvasAtelier-Win10-11-x64-1.6.56.exe` installer identity.
- Focused verification: both release-contract test files passed, 16/16 tests.
- Type verification: the full workspace `npm run typecheck` passed.
- Full verification: Vitest passed 198 test files and 2367 tests; 2 performance tests were skipped by design; 0 failures.
- Existing installer confirmed at `apps/desktop-modern/dist-builder/desktop-modern/CanvasAtelier-Win10-11-x64-1.6.56.exe` (103111963 bytes; last modified 2026-08-25 21:59:21). A fresh installer rebuild/runtime smoke was not performed in this verification pass.
- Workspace note: all unrelated pre-existing dirty changes were preserved.
## 2026-08-26 1.6.56 rebuilt release verification

- Fresh production build passed, including full workspace TypeScript checks, renderer build, desktop bridge/core builds, and the Electron main/preload bundles.
- Electron Builder 26.0.12 completed Windows x64 NSIS packaging for Electron 43.1.0 with exit code 0.
- Rebuilt installer: `apps/desktop-modern/dist-builder/desktop-modern/CanvasAtelier-Win10-11-x64-1.6.56.exe`; size `103112336` bytes; last write `2026-08-26 13:24:36`; SHA-256 `1A38BC87427DDA56C93A51864CF5B8D1C401EDD78F23FA90644440CA9DD3891D`; Authenticode status `NotSigned`.
- Fresh packaged runtime smoke used the rebuilt `win-unpacked/Canvas Atelier.exe` with an isolated temporary user-data directory. It returned `title=Canvas Atelier`, `canvasVisible=true`, `fatalAlertCount=0`, `pageErrors=[]`, and `dialogs=[]`, then closed normally and removed its temporary profile.
- The build reported the existing Vite large-chunk advisory and missing package `description`/`author` metadata; neither warning blocked packaging or runtime startup.
- The existing user installation was not overwritten in this pass.

## 2026-08-26 Agent media, reverse-port, and final 1.6.56 release verification

- The Codex Agent accepts pasted image/video attachments, Codex mode exposes only Codex routes, and ordinary chat no longer renders the workflow request/reverse-analysis cards. Current browser coverage also confirms managed media mentions, structured reverse analysis, image generation, and video generation behavior.
- Root cause of the reverse-card black edge and unreliable output drag was a 16px output column clipping a handle centered on its right boundary. The terminal layout contract keeps the port row clipped, places the full output handle inside the card, and gives handles their own pointer-active stacking layer; this preserves drag hit testing without adding horizontal overflow.
- Updated stale E2E expectations to the current 460px Agent panel, the current project-memory disclosure, and clipboard-file naming. Full Playwright passed `136/136`, including both themes, 1366/1440/1920 desktop layouts, reverse-result overflow, real port dragging, Agent chat, image paste, and image/video generation flows.
- Full workspace TypeScript passed. Full Vitest passed `198` files and `2374` tests; `2` performance tests were skipped by design. The first restricted Vitest run hit only expected `EPERM` errors while security tests created simulated secret files and desktop contract tests rewrote `dist`; the permitted rerun passed with zero failures. `git diff --check` reported no whitespace errors.
- Fresh production build and Electron Builder 26.0.12 Windows x64 NSIS packaging passed. Packaged hidden runtime returned `fatalAlertCount=0`, `nodeCount=2`, `pageErrors=[]`, and `failures=[]` after inserting image/video nodes, editing, and saving.
- Final installer: `apps/desktop-modern/dist-builder/desktop-modern/CanvasAtelier-Win10-11-x64-1.6.56.exe`; size `103112725` bytes; SHA-256 `25202A734D67E2228028F1E52AA9D222B6365F4222D30BC944A16C770A13E374`; Product/File version `1.6.56`; Authenticode status `NotSigned`. The existing user installation was not overwritten.

## 2026-08-27 Agent paste, reverse reliability, generated preview, and 1.6.58 release

- Agent clipboard image paste now imports directly into the current conversation reference list. Files with a usable path go through the managed dropped-media transaction; in-memory clipboard bitmaps fall back to the native clipboard bridge. Neither path opens the Windows image picker or creates an extra canvas node.
- Codex/Agent conversation messages no longer render the internal `知识库请求` card. Request metadata remains in task state for execution and diagnostics, while ordinary chat displays only the user and assistant conversation.
- Reverse Agent now reloads and reconciles one recoverable durable revision conflict inside the first click before starting the provider request. Provider timeouts were raised from 120 seconds to 300 seconds, with the renderer operation boundary at 315 seconds, so a slow provider is not reported as an exact two-minute failure.
- Generated-image preview buttons are exempt from the shared 38px form-control rule. The preview stage and image now fill the available gallery in both dimensions instead of collapsing into a thin strip.
- Fresh verification: focused unit coverage passed `415/415`, the final full Vitest run passed `2382/2382` with `2` performance tests skipped by design, TypeScript passed, and full Playwright passed `139/139`. The packaged hidden runtime returned `title=Canvas Atelier`, `canvasVisible=true`, `fatalAlertCount=0`, and `pageErrors=[]`.
- Release 1.6.58 production build and NSIS packaging passed. Installer: `apps/desktop-modern/dist-builder/desktop-modern/CanvasAtelier-Win10-11-x64-1.6.58.exe`; size `103113039` bytes; SHA-256 `188EB241C3EA42A83054C98358B1D405261AAC8DE4BE204469ED973889999995`; Authenticode `NotSigned`. Packaged `app.asar` reports version `1.6.58`. The existing user installation was not overwritten.
- Online update audit: the settings button currently uses `MockReleaseFeed`, performs no HTTP request, and restart installation returns `REAL_INSTALL_DISABLED`. Uploading only the EXE to GitHub will not notify or update users; a later release must add the real GitHub Releases feed, `latest.yml` publication, integrity/signing policy, download/restart installation, and startup or scheduled checks.
- Fixed release habit: every change batch ends with a written root-cause retrospective, an exact change list, fresh verification evidence, release artifact identity, and explicit remaining risks/next steps. Update this project memory before declaring the batch complete.

## 2026-08-27 result-only generation gallery follow-up

- User reference established the final completion contract: generated image/video nodes should return to a media-only canvas surface instead of leaving the prompt editor visible. A newly completed image or video now closes only its own open generation editor; opening an already completed node still intentionally reveals the full editor for a new run.
- Completed nodes hide prompt, parameter, and connected-reference surfaces until the user explicitly opens the editor. Single images adapt the result node to portrait, square, or landscape orientation; two results fill two equal columns; three results use one tall primary tile plus two secondary tiles; four results use a full 2x2 grid. Completed video posters use the same result-only gallery contract.
- The shared 38px button rule also applied to the collapsed preview opener and initially reproduced the thin-strip defect. The terminal gallery rule now clears that button's `max-height`, while each result tile and its image/video fill the assigned cell with `object-fit: cover`.
- Added reducer, component style-contract, one-result completion, and four-result E2E coverage. The E2E harness can seed 1-4 deterministic generated images for layout verification.
- Release version advanced to `1.6.59` because these changes were made after the 1.6.58 installer had already been built. Fresh full Vitest passed `199` files and `2383` tests with `2` files / `2` performance tests skipped by design. The first full Playwright pass exposed six stale video assertions that still expected connected input media in the result-only state; the assertions were updated to require it only after the editor is opened. The six focused video cases then passed, followed by a fresh full Playwright pass of `141/141`.
- Full workspace TypeScript and production builds passed. Electron Builder 26.0.12 completed Windows x64 NSIS packaging; packaged `app.asar` reports version `1.6.59`. The packaged hidden runtime returned `title=Canvas Atelier`, `canvasVisible=true`, `fatalAlertCount=0`, and `pageErrors=[]`.
- Final installer: `apps/desktop-modern/dist-builder/desktop-modern/CanvasAtelier-Win10-11-x64-1.6.59.exe`; size `103113376` bytes; SHA-256 `07E87E8B51BDE4A1A843F094F902F72CB7277575094BE83BF5AEECA64DB08DAD`; Authenticode `NotSigned`. `git diff --check` exited successfully; its only output was the repository's existing LF-to-CRLF conversion warnings. The existing user installation was not overwritten and no GitHub release was uploaded.
- Remaining release risk: deterministic and mocked provider paths are covered, but no paid live image/video/reverse provider request was issued during final packaging. Online update remains intentionally disabled until the user finishes manual acceptance and explicitly requests GitHub release/update work.

## 2026-08-27 Codex media, reverse normalization, Photoshop runner, portal menu, and 1.6.60 release candidate

- Root cause of the Codex attachment failure: the renderer allowed managed media for Codex `chat`/`responses` routes when discovery omitted `vision`, but `provider-skill-chat.ts` still rejected every referenced request without the flag. The desktop gate now applies the same narrow rule only when `agentMode` is `codex`; ordinary chat/original routes still require explicit `vision`. A provider-level regression proves the managed PNG reaches the Responses request as a data URL.
- Reverse-provider normalization now joins every Gemini text part, unwraps common `reversePromptResult`/`result`/`output`/`data` envelopes, removes unknown top-level fields, maps common aliases, and fills only missing current-run identity. Explicit mismatched provider identity remains intact so the domain schema rejects it rather than masking a cross-run response.
- The Photoshop Windows Script Host runner uses legacy-JScript-compatible `/i` regular expressions. Its contract test protects the real `GetObject('', 'Photoshop.Application')`, `DoJavaScript`, version/document checks, and the absence of unsupported `/iu` or `/gu` flags.
- The body-portaled generated-image action menu has independent opaque light/dark surfaces, high-contrast text, hover, focus, and disabled styling. The contract test reads the terminal release stylesheet through a workspace path that works under Vitest's browser environment.
- Startup remains restore-first: desktop hydration selects the first available entry from the recent-project store, whose list is ordered by `lastOpenedAt`; automatic blank creation was not introduced. A blank canvas is created only through the explicit New Project workflow.
- Fresh focused regressions passed after the Codex server gate fix. Fresh full Vitest passed `202` files and `2391` tests with `2` performance files/tests skipped by design and zero failures. Full Playwright passed `141/141`. Full workspace typecheck and production build passed; Vite emitted only the existing large-chunk advisory.
- Version advanced from `1.6.59` to `1.6.60`; package metadata, lockfile, packaging contract, and runtime-entry contract agree. Electron Builder 26.0.12 completed Windows x64 NSIS packaging from `apps/desktop-modern`.
- Release candidate installer: `apps/desktop-modern/dist-builder/desktop-modern/CanvasAtelier-Win10-11-x64-1.6.60.exe`; size `103113993` bytes; SHA-256 `72EE501E69B4F78DEE136968D13D05774AE3EDDFFAD99DF6FD9227BCC0017770`; Authenticode `NotSigned`. Packaged `app.asar` reports version `1.6.60`, size `4985964` bytes, SHA-256 `346DDB60B23E07B89F9EF116A3D1C1063F445CF1C456C6C769500743A31732C3`.
- Browser screenshot evidence for the image-generation toolbar is `artifacts/2026-08-10-complete-project-release/05-image-node-compact-dark.png`; model, ratio, resolution, quantity, and Generate controls remain aligned in one contained row.
- Remaining release gate: the final `win-unpacked` isolated-profile restart smoke and packaged screenshot are not yet claimed. The application reached the real New Project confirmation and durable `saved` state in earlier attempts, but the QA script initially assumed a production E2E global, then omitted the confirmation, then incorrectly required the intentionally hidden save-state element to be visible. After those harness corrections, the local command helper failed during setup and prevented collection of the final run. Do not overwrite the user's installed application or call this candidate fully accepted until that smoke is rerun and recorded.

## 2026-08-27 Agent chat complete clipboard regression

- Root cause: the earlier Agent composer paste path consumed only one clipboard file and lacked an Agent-local clipboard event boundary. Mixed clipboard payloads could therefore lose later attachments, while copy/cut/paste events from the Agent surface could bubble to the canvas clipboard owners.
- Protected behavior: clipboard parsing preserves readable text plus every supported image/video in `DataTransfer.items` order. Managed imports run sequentially, successful earlier references remain when a later import fails, and the canonical composer order is text followed by `@图片1 @视频1`. Reference updates and pending imports are scoped to the active conversation/model/mode generation so stale completions cannot mutate a replacement draft.
- Event boundary: the Agent workbench stops copy, cut, and paste propagation locally, while the terminal message/reverse/request/source style contract restores native `user-select: text`. This keeps visible Agent content selectable without routing Agent clipboard events into Canvas handlers.
- Regression locations: `apps/renderer/src/agent/agent-chat-clipboard.test.ts`, `apps/renderer/src/agent/agent-chat-paste-state.test.ts`, `apps/renderer/src/agent/SkillChatWorkbench.test.tsx`, `apps/renderer/src/main.styles.test.ts`, `apps/renderer/src/canvas/CanvasWorkspace.test.tsx`, and `tests/e2e/agent-chat-image-picker.spec.ts`.
- Fresh Task 4 browser evidence: `npm.cmd exec playwright test tests/e2e/agent-chat-image-picker.spec.ts --workers=1` passed `4/4` with one worker. The added real composer case dispatched one `DataTransfer` containing plain text, one PNG, and one MP4, then observed the canonical value `同时分析这两个素材 @图片1 @视频1` and both visible media chips. The first run passed the three existing cases and failed only because the new assertion omitted the expected spaces between canonical references; correcting that test expectation produced the fresh green run.
- Final fresh verification: the related Agent/Canvas/style/server suite passed `336/336`; full workspace typecheck passed; full Vitest passed `204` files and `2434` tests with `2` performance files/tests skipped by design; after the browser-level Minor closure, full Playwright passed `143/143` in `4.1m`; and the complete production build exited `0`. Playwright emitted only the existing `NO_COLOR`/`FORCE_COLOR` warning and intermittent non-blocking Vite `ResizeObserver loop` logs. Vite build emitted the existing large-chunk advisory.
- No packaging, installer, GitHub upload, installed-app overwrite, or packaged-runtime smoke was performed for this clipboard change. The existing `1.6.60` release-candidate artifact and its remaining isolated-profile restart smoke gate are unchanged.
- Browser-level Minor closure: `agent-chat-image-picker.spec.ts` now creates a real mock Agent reply, selects its visible text with a DOM `Range`, and dispatches copy/cut plus composer paste while monitoring the browser `window` bubbling boundary used by Canvas clipboard listeners. Selection was non-empty, copy/cut kept their browser defaults, and all three window counters remained zero. The focused Agent clipboard spec passed `5/5`, followed by full Playwright `143/143`. Two earlier runs correctly exposed test assumptions rather than production defects: selection was initially read after default cut cleared it, and controlled contenteditable paste intentionally prevents the browser default while remaining local.

## 2026-08-27 Reverse provider truncation and schema diagnostics

- Root cause: the Gemini client already preserved candidate `finishReason`, but reverse orchestration ignored it and wrapped JSON parsing, bridge-schema parsing, run-identity checks, and media-responsibility validation in one unconditional catch. A `MAX_TOKENS` response, malformed optional professional section, and explicit identity mismatch therefore all became the same non-actionable `PROVIDER_INVALID_RESPONSE` message.
- Gemini reverse requests now use JSON output with `maxOutputTokens: 16384`. A `MAX_TOKENS` finish is reported as a retryable truncation before JSON parsing. Missing text, invalid JSON, schema failure, run-identity mismatch, and incomplete media responsibilities retain separate sanitized categories without exposing provider output.
- Normalization tolerates malformed non-core professional sections such as camera or composition when the required reverse core is complete. It does not overwrite explicit provider identity and does not drop a provided malformed `mediaResponsibilities` section; that section still fails strict schema and per-media validation.
- Renderer errors now provide actionable Chinese guidance for truncation, invalid JSON, missing required fields, run-identity mismatch, and incomplete material responsibility instead of always displaying “反推结果格式无效”.
- TDD evidence: the first focused run failed 7 new regressions as expected; a later safety RED proved malformed media responsibilities were incorrectly being dropped, then passed after the boundary was tightened. Final focused safety verification passed `11/11`; reverse-related wide verification passed `488/488`; full Vitest passed `204` files and `2443` tests with `2` performance files/tests skipped by design. Full workspace typecheck and production build passed; Vite emitted only the existing large-chunk advisory.
- No installer was rebuilt, no installed application was overwritten, and no GitHub upload was performed in this repair pass. A paid live Gemini reverse call is still required to confirm the exact provider behavior for the user's nine-image workload.

## 2026-08-27 Cross-provider reverse truncation hardening and 1.6.61 release

- The reverse-response boundary now handles truncation consistently across Gemini native, Comfly OpenAI-compatible Chat Completions, and RelayMe Chat Completions. Gemini `finishReason` and Chat-compatible `finish_reason` values are preserved and normalized; `LENGTH`, `MAX_TOKENS`, and `MAX_OUTPUT_TOKENS` are reported as retryable output truncation before JSON/schema parsing.
- A shared staged parser distinguishes missing text, invalid JSON, bridge-schema failure, explicit run-identity mismatch, and incomplete media responsibilities. Explicit mismatched identity remains non-retryable and is never replaced with the current run identity. Malformed optional professional sections may be filtered only when the required reverse core remains valid; malformed supplied media responsibilities are never silently dropped.
- Gemini reverse requests explicitly ask for `application/json` and set `maxOutputTokens` to `16384`. Renderer messages now explain in Chinese whether the user should retry with fewer references, repair provider output, or start a fresh run instead of collapsing every case into “反推结果格式无效”.
- Cross-provider TDD coverage lives in `packages/desktop-core/src/provider-bridge.test.ts`, `packages/desktop-core/src/relayme-provider-service.test.ts`, `packages/desktop-core/src/reverse-provider-result.test.ts`, and `apps/renderer/src/canvas/ModuleNodeCard.test.tsx`. Fresh final verification passed full Vitest: `204` files and `2445` tests, with `2` performance files/tests skipped by design; full Playwright passed `143/143` in `4.2m`. Full workspace typecheck and production build passed before packaging.
- Version advanced to `1.6.61`; desktop package metadata, lockfile, packaging boundary, and runtime entry contract agree. Windows x64 NSIS packaging completed. Installer: `apps/desktop-modern/dist-builder/desktop-modern/CanvasAtelier-Win10-11-x64-1.6.61.exe`; size `103116905` bytes; SHA-256 `DF2C24E596D2EC3755E5C95BA0205559FB84A6795451784183EFFF8C635B8558`; Authenticode `NotSigned`. Packaged `app.asar` reports `1.6.61`, size `4987716` bytes, SHA-256 `0948D7D339AA6AC8E6A23FF3FAA8BA960BE6CDCE8C417C3C4B8EF530B2F1A919`.
- The final isolated `win-unpacked` restart smoke used a `canvasforge-qa-*` user-data root and returned `title=Canvas Atelier`, `firstVersion=1.6.61`, `secondVersion=1.6.61`, `canvasVisible=true`, `fatalAlertCount=0`, `pageErrors=[]`, and `restoredImageNodes=1`. It also found all five visible image-generation toolbar controls: model route, aspect ratio, resolution, quantity, and Generate. This protects the restore-most-recent-canvas startup rule without auto-creating a blank project.
- QA incident record: earlier smoke attempts used an invalid isolation prefix, so the packaged app rejected the QA root and may have created one blank/test project in the user's real application data. No installed files were overwritten and no automatic deletion was attempted because a test project could not be distinguished safely from user data. Later smoke runs used the accepted isolated prefix.
- Remaining risks: the installer is unsigned; no paid live nine-image Gemini/Comfly/RelayMe reverse request was submitted during release verification; hidden Electron pixel capture remained unstable, so the existing verified toolbar screenshot is retained as layout evidence while the 1.6.61 packaged DOM smoke supplies current control-presence evidence. No GitHub release was uploaded and the user's existing installation was not overwritten.

## 2026-08-28 RelayMe、反推兼容与 GitHub 更新引导版 1.6.62

- RelayMe 现支持账号密码登录事务：密码只存在于登录调用期间，JWT 仅进入桌面安全凭据库；登录后模型目录验证成功才激活 RelayMe，退出或认证失效会清凭据并失活。
- Comfly 与 RelayMe 使用持久化单一 `activeProvider`，Renderer 过滤目录并在执行前提示，主进程对 Agent、反推、图片和视频执行做权威 `PROVIDER_INACTIVE` 门禁，禁止跨供应商静默回退。
- 反推失败原因改为六种稳定分类：`TRUNCATED`、`NO_TEXT`、`INVALID_JSON`、`CORE_SCHEMA_INVALID`、`IDENTITY_MISMATCH`、`MEDIA_RESPONSIBILITIES_INVALID`。常见 wrapper、多文本 part、字符串/对象列表和中英文字段别名会被安全规范化；显式错误身份与缺损素材职责仍拒绝。
- 更新检查原先始终使用 `MockReleaseFeed`，重启固定返回 `REAL_INSTALL_DISABLED`，因此设置页不可能真实发现或安装 GitHub Release。现由 `electron-updater@6.8.9` 驱动 packaged 模式，`autoDownload=false`、`autoInstallOnAppQuit=false`；Renderer 通过窄 IPC 订阅状态，只有用户点击才下载或重启安装。
- 发布前修复了两类过期回归：preload 安全方法表遗漏四个受控 provider 通道；Playwright 仍选择已被单活动供应商正确隐藏的 RelayMe `Gemini Vision` 与旧反推路线。测试现改用带明确 `chat + vision + reverse_prompt` 能力的活动 Comfly 路由。
- 最新验证：`scan:e2e` 通过；全工作区 typecheck 通过；完整 Vitest 为 209 个文件、2498 个测试通过，2 个性能测试按设计跳过；完整 Playwright 144/144；最终生产 build 通过。
- 1.6.62 Windows x64 NSIS：`CanvasAtelier-Win10-11-x64-1.6.62.exe`，103182785 字节，SHA-256 `6E4FF3FB8BEA6B392AB08C358D4DFB41FA94C01FB469A2D6D7AAAA2F866E9E51`，Authenticode `NotSigned`。
- updater 资产：`.blockmap` 109428 字节，SHA-256 `E64E82F034EEA3039C774103AE3536D57CB73C1D4BD41BD4814B562BB3AC2AEC`；`latest.yml` 372 字节，SHA-256 `0DEA7E3FB7DBCDA96AFE3379021F9FBBCE45A400081CF6F5BC97401227241D56`。
- `win-unpacked/resources/app.asar`：版本 1.6.62，5592001 字节，SHA-256 `2C556A0C263B6C562B7C8AFC3BECEE3CD61492D4814CD9B8EDF4293B7C146C1A`。隔离 QA 数据根启动 8 秒保持存活，随后按精确 PID 终止且无遗留进程；未运行安装器、未覆盖现有安装。
- 剩余风险：Windows 产物未签名，SmartScreen 可能警告；真实 GitHub 1.6.62→1.6.63 下载/升级链路尚未完成远端发布验收，未获精确 QA 安装许可前不得点击“重启并安装”。

## 2026-08-28 GitHub 更新验证版 1.6.63

- GitHub Release：[v1.6.63](https://github.com/19960726/canvas-atelier/releases/tag/v1.6.63)，仅上传 EXE、blockmap、latest.yml 与 SHA-256 清单；未上传 dirty 源码、凭据或用户素材。
- `CanvasAtelier-Win10-11-x64-1.6.63.exe`：103182810 bytes，SHA-256 `9CA525C85B69E9E359500C7D1833B908EA1324BBCDAF421A109D75E00080A141`；blockmap 109446 bytes，SHA-256 `6E3DB4F920AD4AF5EE0529A19B763D3B6B30C3B4E369C7D03C16F601F3071DDF`；latest.yml 372 bytes，SHA-256 `BAB6822958934D10693DEA02C8838B8043465F96A730F71C9A7A4389E1054874`。
- `app.asar` 为 5592001 bytes，SHA-256 `A5766FA4A7DC4CE14C16B224007026F39A99BED24CED080670F8BEC4EE200199`，包内版本 1.6.63；EXE 与 unpacked 运行体均未签名。
- 验证：版本契约 17/17；scan:e2e、typecheck、Vitest 209/2498（2 skips）通过；Playwright 首次 143/144（单次 280ms 压力抖动），失败场景隔离重跑 6/6 通过；build、NSIS、隐藏隔离启动冒烟通过。远端 latest.yml 与 EXE 均 HTTP 200，EXE 长度 103182810。
- 更新验收实际停在远端元数据和安装包可下载性核验：本地 1.6.62 运行体在 1.6.63 重建时被覆盖，因此未声称完成旧版设置页 UI 下载；未执行重启/安装，也未触碰用户现有安装。
- 未解决风险：Windows 包未签名；需保留一份 1.6.62 运行体后再做一次真实设置页“检查更新→下载完成”验收。

## 2026-08-28 画布性能验收

- 当前实现已启用视口裁剪、选中/活动节点保留和交互期间低质量渲染；拖动、平移、缩放和连接预览均通过统一长任务观测器检查。
- 新鲜 Playwright 验证：`durable-canvas-stress.spec.ts` 在 1366x768、1440x900、1920x1080 的浅色/深色组合共 6/6 通过，300 节点、500 连线的所有操作最大 stall 为 200ms，低于 250ms 门槛；渲染节点数保持低于 50。
- `visual-layout.spec.ts` 15/15 通过，覆盖 100 节点压力图、布局无重叠和 pan/zoom frame marks；未发现水平溢出或交互回写异常。
- 本轮未修改性能实现；结论是性能项从“待验证”提升为“已验证”。仍未覆盖真实 Windows 7/10/11 多机 FPS，兼容性矩阵中的系统级项目继续保持 pending。

## 2026-08-28 持久化与恢复专项验收

- 凭据库、最近项目排序、关闭前保存、恢复扫描、Renderer 持久化和项目保存状态专项测试共 `85/85` 通过。
- `project-save-manager.spec.ts` 与设置更新流程 E2E 共 `2/2` 通过；项目管理列表、缺失项目状态、恢复版本和显式更新检查均正常。
- 本轮未运行安装器、未覆盖用户安装、未读取或写入真实用户凭据；跨版本真实覆盖安装仍需保留旧版运行体后单独验收。

## 2026-08-28 画布管理、模型目录、RelayMe 错误映射与 1.6.64 候选版

- 画布管理弹层透明的根因是 `.canvas-manager` 引用了未定义的 `--gate-panel-surface`。浅色和深色主题现分别提供不透明表面值，并由终端样式契约测试保护。
- Comfly 模型目录在生成 profile 前过滤空 key、空名称和重复精确 key，重复项保留第一条，避免无效或重复模型进入设置和执行路线。
- RelayMe 图片生成错误现区分认证失效、额度或频率限制、模型能力不支持以及网络超时，并保留可重试语义；用户可以据此重新登录、切换模型或稍后重试。
- 新鲜验证：完整 Vitest 209 个文件通过、2 个按设计跳过，共 2501 个测试通过、2 个跳过；完整 Playwright `144/144`；全工作区 typecheck 与 production build 均通过。压力验收为 `6/6`，300 节点和 500 连线下最大 stall 200ms；视觉布局 `15/15`；持久化专项 `85/85`。
- Windows x64 NSIS 候选包：`apps/desktop-modern/dist-builder/desktop-modern/CanvasAtelier-Win10-11-x64-1.6.64.exe`，103183411 字节，SHA-256 `2B6CE33DF36B6FAF49778AC24F19B1A950810125E4DD06EF8E8815DA92CCD93E`，Authenticode `NotSigned`。blockmap 为 109515 字节，SHA-256 `E83F956925F7679E90C22CDD94E8F0AF4B0F6C7E88B3D14EC2E95944C9B5A23C`。
- 最终隔离 `win-unpacked` 重启冒烟返回 `firstVersion=1.6.64`、`secondVersion=1.6.64`、`canvasVisible=true`、`fatalAlertCount=0`、`pageErrors=[]`、`restoredImageNodes=1`；图片生成的模型、比例、分辨率、数量和生成按钮均可见且高度为 30px。
- 未执行安装器、未覆盖现有安装、未提交或推送代码、未创建 GitHub Release。剩余风险是 Windows 包未签名、未做真实跨版本覆盖升级，也未发起付费的 Gemini/Comfly/RelayMe 在线请求。

## 2026-08-28 1.6.63 → 1.6.64 隔离更新发现与下载验收

- 从保留的 `CanvasAtelier-Win10-11-x64-1.6.63.exe` 直接提取真实 packaged 运行体，不执行 NSIS 安装器；其大小为 103182810 字节，SHA-256 为 `9CA525C85B69E9E359500C7D1833B908EA1324BBCDAF421A109D75E00080A141`。
- `work/release-1.6.63-to-1.6.64-update-smoke.mjs` 在脚本专属临时目录中启动 1.6.63，并通过随机本机 HTTP 端口提供当前 `latest.yml`、1.6.63/1.6.64 blockmap 和 1.6.64 EXE。设置页真实完成“检查更新 → 发现 1.6.64 → 下载更新 → 版本 1.6.64 已准备好”。
- 下载缓存 EXE 为 103183411 字节，SHA-256 `2B6CE33DF36B6FAF49778AC24F19B1A950810125E4DD06EF8E8815DA92CCD93E`，与 1.6.64 源安装包完全一致；HTTP 请求全部返回 200，页面错误为空，`restartInvoked=false`。
- QA 隔离事故：只设置应用 `userData` 不会改变 electron-updater 的 `baseCachePath`，第一次下载在真实 `%LOCALAPPDATA%` 测试专用缓存中因跨卷重命名 `EXDEV` 失败。验收脚本现同时把 `APPDATA` 和 `LOCALAPPDATA` 指向 E: 临时根，既修复跨卷改名，也保证下载缓存不会进入真实用户目录。
- 隐藏 Electron 的截图 API 在文件已经写入后仍返回超时；当前证据图已人工核对为“版本 1.6.64 已准备好”。最终脚本把已生成的非空截图视为成功证据，但下载完成的权威证据仍是 UI 状态、electron-updater 日志和缓存文件哈希。
- finally 清理后确认：无 `work/update-smoke-*` 临时目录、无 `%LOCALAPPDATA%/canvas-atelier-updater-smoke` 缓存、无隔离 Canvas Atelier 进程。没有点击“重启并安装”，没有覆盖用户现有安装。
- 本次是使用真实 packaged updater 与真实发布资产的本机 HTTP 验收，不等同于 GitHub 远端 1.6.64 Release 验收；1.6.64 尚未发布到 GitHub，远端发现/下载和真实覆盖升级仍保持未验证。

## 2026-08-29 RelayMe 生图、节点恢复、自动保存与设置目录修复

- RelayMe “连接成功但生图 0 秒失败”的请求契约根因已定位：画布把 `1K/2K/4K` 错误发送到 `imageQuality`，而 RelayMe 公共生图接口要求分辨率使用 `imageSampleSize`，画质使用 `low/medium/high`。现发送 `imageSampleSize` 与 `imageQuality: medium`，保留账号登录令牌认证，不引入独立 RelayMe API 密钥。
- 失败后无法重试有两条持久化根因：模型任务恢复无时间上限，旧 `running` 任务会继续占用节点；Reverse Agent 崩溃遗留的 `reverseAgentRunState: running` 会永久显示停止按钮。模型任务现在只允许恢复 30 分钟内的运行项，过期项转为本地取消；没有本地执行实例的持久化反推状态显示为“上次反推已中断”，可直接重新执行。
- 折叠图片/视频结果卡同时带有 `nodrag` 和阻断指针传播，导致必须展开提示词才能拖动。折叠结果壳与打开按钮现保留 `nopan`，移除 `nodrag` 和指针阻断，点击仍展开，拖动可直接移动节点。
- 打开节点缓慢的根因是完整供应商目录被传给每个节点并在节点内重复分类。`CanvasWorkspace` 现在只构建一次按能力去重的图片、视频、反推和分镜路线集合，再共享给节点。
- 新建画布不再显示“保存/不保存”确认框。存在未保存内容时先静默调用显式保存，成功后才新建；重复点击在同一个保存事务内合并，保存失败则保留当前画布。
- 模型目录改为单一能力工作区：顶部使用图标标签切换生图、视频、对话、反推、视觉和视频理解，正文一次只显示一个能力及其默认模型和启用列表。RelayMe 设置改称“账号连接”，空目录入口改为重新登录；连接检测与更新按钮使用同一 42px 画布主操作样式。
- TDD 红灯分别覆盖 RelayMe 请求字段、折叠节点拖动、过期任务恢复、画布路线精简、反推中断恢复、静默新建保存和能力标签目录。新鲜相关验证通过 9 个文件、499 个测试；全工作区 TypeScript 通过；生产 build 通过。构建仅生成本地 dist，尚未打包、安装或发布。
- 真实拖动后节点短暂移动却随即消失的根因不在点击手势，而是持久化位置回写时用未测量的 durable node 覆盖了 React Flow 节点，丢失 `width`/`height`/`measured` 等运行时测量，导致 React Flow 重新设为 `visibility:hidden`。`useCanvasDraft` 现在在持久化对齐时保留测量、选中和拖动态；折叠预览只在未发生位移的 pointer-up 时展开，卡片空白区可直接拖动。
- 最终相关联合回归为 10 个文件、511/511 通过；节点专项 181/181 通过；完整 TypeScript 检查和生产 build 通过。Playwright 真实浏览器回归 7/7 通过，覆盖 RelayMe/Comfly 独立目录、亮暗主题、生成启动失败后重试、折叠节点直接拖动、停止任务和结果重载。本轮仍未生成安装包、未安装、未提交、未推送、未发布。
- 按用户确认进入打包阶段：`npx.cmd electron-builder --projectDir apps/desktop-modern --config electron-builder.yml --win nsis --x64` 成功生成 `apps/desktop-modern/dist-builder/desktop-modern/CanvasAtelier-Win10-11-x64-1.6.67.exe`，文件大小 `103185794` 字节，SHA-256 `D1E0631CD8C3D28EFFED94E92BE8DFDB1A49E75B24CAAFC30C5014A3E6F18B54`，blockmap 大小 `109559` 字节，SHA-256 `F83D12BBDCAF5B84A73087AC6AF8935B9B7EFD011D1CFC0D2F9BCDCE3E1F4B68`，`latest.yml` 包内版本为 `1.6.67`。隔离 packaged 重启冒烟通过：`firstVersion=1.6.67`/`secondVersion=1.6.67`、`canvasVisible=true`、`fatalAlertCount=0`、`pageErrors=[]`、`restoredImageNodes=1`，五个生图控件均为 30px 且可见。包未签名（`NotSigned`），未安装、未覆盖旧版、未发布 GitHub。

## 2026-08-29 RelayMe 任务清单公开桥接契约回归

- 根因：RelayMe 账号任务清单新增窄 `provider.listTasks` preload 方法后，`bridge-contract.test.ts` 的公开 provider 方法白名单仍停留在旧集合，导致全量测试唯一失败。
- 保护行为：Renderer 只通过 `listTasks({ provider: 'relayme', page, size })` 接收任务 id、类型、状态、创建时间和错误摘要；桥接不得暴露令牌、远端内容、URL、base64 或原始工作流。
- 回归位置：`packages/desktop-core/src/bridge-contract.test.ts` 与 `packages/desktop-core/src/preload-api.test.ts`。Photoshop 脚本层另由 `packages/desktop-core/src/photoshop-script.test.ts` 固定 runner 的 CS6 major 13 门槛，防止 adapter 与 WSH runner 版本判断漂移。
- 验证命令：`npm.cmd exec vitest -- --config vitest.config.ts packages/desktop-core/src/bridge-contract.test.ts packages/desktop-core/src/preload-api.test.ts --run`，随后执行 `npm.cmd test` 和 `npm.cmd run build`。

## 2026-08-30 RelayMe Agent 对话真实响应适配

- 根因：RelayMe 当前 `/chat/completions` 成功响应是 `{ success, data: { content, model, promptTokens, completionTokens, totalTokens } }`，不是旧客户端唯一接受的 OpenAI 顶层 `{ id, model, choices }`。因此请求实际上已成功，但 `RelayMeClient` 在进入桌面 Agent 文本提取前就以响应格式无效拒绝。
- 保护行为：客户端同时接受 OpenAI-compatible 响应和 RelayMe 真实 data envelope，并把后者规范化为共享的 `choices[0].message.content` 与 `usage`；Comfly 与 RelayMe 的活动供应商和模型目录仍保持隔离，不做跨供应商回退。
- 回归位置：`packages/provider-relayme/src/client.test.ts` 固定真实 envelope 规范化；`packages/desktop-core/src/relayme-provider-service.test.ts` 固定字符串及结构化 content 的 Agent 文本提取。
- TDD 证据：新增客户端用例在修复前以缺少 `id` 明确失败；最小 schema union 适配后，客户端与桌面服务联合回归 43/43 通过。
- 在线证据：隔离 QA 桌面运行体使用已配置 RelayMe 账号调用 `gemini-3.1-flash-lite`，请求“只回复 OK”，桥接真实返回 `message: "OK"`。诊断只暴露响应键名和类型，临时脚本随后删除。
- 1.6.74 packaged QA：`win-unpacked/Canvas Atelier.exe` 在隔离数据根中报告版本 `1.6.74`；新建项目无确认框；创建节点后状态为 `pending`，点击真实保存按钮正常进入 `saved`，没有停留在 `saving`；节点从 `(730, 301.67)` 移至 `(843, 376.67)` 后 Ctrl+Z 回原位；Delete 删除后 Ctrl+Z 恢复；生图提示词文本 Ctrl+Z 清除；Codex Agent 选择 `gemini-3.1-flash-lite`，真实对话返回 `OK`；静默退出在 25 秒门限内完成，页面错误为 0。
- 正式构建证据：联合 RelayMe 回归 43/43、全工作区 typecheck、production build 和 Electron Builder Windows x64 NSIS 均通过；完整 Vitest 为 210 个文件、2566 个测试通过，2 个性能文件/测试按设计跳过。
- 1.6.74 Windows x64 NSIS：`CanvasAtelier-Win10-11-x64-1.6.74.exe`，103192040 字节，SHA-256 `925EF2FCD236007AA40CBE8C37720BCA7D3E724B8E4D74CE6CFD3B51DCE4AC58`；blockmap 109534 字节，SHA-256 `F7E4395471210E50C0D817EC64F7D01EFACA430182AE391B8A4851EE36865AAE`；`latest.yml` 372 字节，SHA-256 `6EE29C1AEE45DF08A8C75712B42F093AE06F6D937D0BD8F68EE94CCD140A6A49`。安装包未签名（`NotSigned`），Windows 可能显示 SmartScreen 警告。

## 2026-08-31 正式数据冲突、新建/退出恢复与 RelayMe 连接状态修复

- 正式版“新建项目无响应”的确认根因是当前项目处于 `REVISION_CONFLICT`：新建流程仍先调用不可能成功的保存，并在失败后直接返回。现在只在只读或持久化冲突阻止保存时明确询问是否放弃本次未保存更改；取消会保留原画布，确认后才新建。正常可保存状态仍先静默保存，不降低数据安全。
- 正式版“退出卡住”的确认根因是关闭协调器收到 Renderer 的 `failed`/`timeout`/`unavailable` 结果后已有恢复回调能力，但主进程没有接入。主进程现在显示原生安全选择，默认取消；只有用户明确选择“放弃未保存更改并退出”才关闭，已保存项目不受影响。
- RelayMe 当前正式凭据与 Electron 网络链路经只读模型目录调用验证为可连接；截图中“网络不可用”不能据此认定为真实断网。设置页此前 12 秒超时短于 provider 的 30 秒请求边界，会提前把慢响应误标为网络不可用。UI 检测边界现为 35 秒，并把超时单列为“连接检测超时”，认证、限流与真实网络错误仍保持独立状态。
- 回归位置：`apps/renderer/src/canvas/CanvasWorkspace.test.tsx`、`apps/desktop-modern/src/close-coordinator.test.ts`、`apps/renderer/src/settings/SettingsDrawer.test.tsx`。TDD 红灯分别复现冲突新建不执行、主进程未接恢复回调、前端超时误标网络不可用。
- 新鲜验证：相关联合回归 192/192，升版后的版本/关闭/新建/设置联合回归 201/201；全工作区 TypeScript 通过；完整 Vitest 210 个文件、2571 个测试通过，2 个性能文件/测试按设计跳过。生产 build 与 Electron Builder Windows x64 NSIS 均退出 0。
- 1.6.76 隔离 packaged 验收实际执行了“新建项目 → 创建图片生成节点 → 保存 → 正常关闭 → 重新打开恢复”：两次运行版本均为 1.6.76，`canvasVisible=true`、`fatalAlertCount=0`、`pageErrors=[]`、`restoredImageNodes=1`，五个图片生成控件均可见。该验收未读取正式用户项目，也未触发付费生成。
- 正式候选安装包：`apps/desktop-modern/dist-builder/desktop-modern/CanvasAtelier-Win10-11-x64-1.6.76.exe`，103192907 字节，SHA-256 `B84A48EF366F82338D2CBBC7A176B0C2F14F2A70701228F94F0600E3255C115B`；blockmap 109624 字节，SHA-256 `1D6EE8D386D741DCED9C8F9EB30D98710E1B6842B81F0865543B951048EF06D6`；`latest.yml` SHA-256 `69B1EB629B90A79F23AA87151B22B79E9C0CC6C61EA418AD64B9C87F1570B51B`。`app.asar` 包内版本独立读取为 1.6.76。安装包未签名（`NotSigned`），Windows 仍可能显示 SmartScreen 警告。

## 2026-08-31 正式旧项目 Del 冲突恢复修复

- 确认根因：已安装 1.6.76 对新建普通节点的 Delete 黑盒测试能够成功，问题不是按键监听全局失效。正式旧项目处于 `REVISION_CONFLICT` 时，Store 会在删除事务执行前返回 `false`，但 `deleteCanvasNodesWithDurableReload` 只在 `saveStatus === 'read_only'` 时重载重试；冲突状态是 `saveStatus: 'error'`，因此 Del 静默结束且节点仍存在。
- 保护行为：删除首次失败时，仅当桌面允许安全重载且当前状态为只读或明确的持久化冲突，才重载最新持久化项目并对相同节点 id 重试一次。普通保存错误不会被误当作冲突，也不会无限重试。
- 回归位置：`apps/renderer/src/canvas/CanvasWorkspace.test.tsx` 的 `reloads and retries when Delete is blocked by a durable revision conflict`。该用例修复前明确失败为节点数仍为 1、重载 0 次；最小实现后通过，并确认重载 1 次、删除调用 2 次。
- 当前新鲜验证：聚焦红转绿通过；`CanvasWorkspace` 与 `app-store` 联合回归 307/307 通过。验证命令：`npm.cmd exec vitest -- --config vitest.config.ts apps/renderer/src/canvas/CanvasWorkspace.test.tsx apps/renderer/src/app/app-store.test.ts --run`。全量测试、构建、打包及安装版验收仍待执行，不得据此提前声称正式安装包已完成。

## 2026-08-31 正式 Photoshop 与最近项目切换边界修复

- 正式 Photoshop 按钮无反馈存在两个确认根因：Electron Builder 未把 `dist/photoshop` 带入安装包的 `resources/photoshop`；Windows runner 又使用旧 JScript 不支持的对象尾逗号和不可用的 `JSON.stringify`，错误处理本身也会再次失败并返回空输出。
- 修复后打包清单明确复制 Photoshop 资源，脚本使用旧 WSH 兼容的平面对象 JSON 编码，并以测试禁止尾逗号和原生 `JSON.stringify`。目标机只读 `cscript` 实测返回 Photoshop major 27、`activeDocument: false`，证明连接与诊断输出已恢复；当没有活动 PSD/PSB 时 UI 应明确提示，而不是静默无反应。
- 画布管理把当前已经打开的同一项目再次显示为“打开”，点击只能形成表面无响应。现在同项目显示禁用的“当前项目”；真正打开其他最近项目或文件夹前，未保存内容必须先保存，只读或 `REVISION_CONFLICT` 则明确确认是否放弃本次更改。
- 新鲜验证：全量 Vitest 210 个文件、2575 个测试通过，2 个性能文件/测试按设计跳过；全工作区 TypeScript 通过。生产打包、安装版验收仍待执行，不得提前声称正式版完成。

## 2026-08-31 1.6.78 项目会话竞态、安装版验收与 RelayMe 真实状态

- “新建后 Del 又出现旧节点”的最终根因是旧项目关闭与同会话刷新重叠：刷新推进 `clientGeneration` 后，`close()` 因 generation 不同而放弃清理已经关闭的旧 session。新画布第一次保存因此仍写向旧项目并形成 revision conflict，删除冲突恢复又把旧节点载回。`close()` 现在以 session/project 身份判断是否仍是同一关闭目标；只有已经切换为其他 session/project 才放弃清理。新增竞态测试修复前明确得到 `lifecycle: durable, revision: 4`，修复后为 `untitled, revision: 0`。
- 完整 Vitest 为 210 个文件、2577 个测试通过，2 个性能文件/测试按设计跳过；项目持久化、Store 与 CanvasWorkspace 联合回归 365/365；全工作区 TypeScript 与 production build 通过。Electron Builder Windows x64 NSIS 成功。
- 打包版和安装版分别在独立 QA 数据根执行真实 Electron 验收，均得到：`createdCount=1`、Delete 后 `deletedCount=0`、Ctrl+Z 恢复 `restoredCount=1`、文本撤回为空、节点移动撤回成功、当前项目标记 1 个、关闭重开节点 1 个、`fatalAlertCount=0`、`pageErrors=[]`，两次运行版本均为 1.6.78。验收未读取正式项目、未触发付费生成。
- 安装包：`apps/desktop-modern/dist-builder/desktop-modern/CanvasAtelier-Win10-11-x64-1.6.78.exe`，103195247 字节，SHA-256 `C0E02AF7B636E77802A3CC09B499E8771F6E1DD4D1B5DA1DFD155E1D2CF1254F`；blockmap 109689 字节，SHA-256 `4F4C7897465D154322B2CF022E2F52737235D62601EDDA7482AD503A01214B7D`；`latest.yml` 372 字节，SHA-256 `40A3810DC652E83493F9BEEC70A2D7F48429792B5A9F4872FCB4C055A4CD73D8`。安装包未签名（`NotSigned`）。
- 已静默安装到 `D:\CanvasAtelier\Canvas Atelier`；安装后 `resources/app.asar` 与 packaged `app.asar` SHA-256 均为 `6D57F85E7FA7711D2529F6124780FD642B09BA8E6233B0F4C7123615D6795AB6`，包内版本均为 1.6.78；已安装 Photoshop runner/JSX 资源存在。
- RelayMe 本机网络实测：DNS 解析到 `47.57.181.124`，443/TLS 成功；无凭据访问模型和 workflow 接口均快速返回 401，说明链路可达且接口要求登录认证。已安装正式数据的脱敏检测为 `configured=true`、`locked=false`、`encryption=safeStorage`、`activeProvider=relayme`，但服务端返回 `authentication_failed`、模型 0 个；这是已保存账号会话被拒绝，不是真实断网。用户无需手工 API Key，但必须重新输入 RelayMe 账号密码取得新会话令牌。未读取或输出令牌与密码。
- RelayMe 图片数量控件为 1–4 张；一次点击会创建同一 confirmedAt 下的 1–4 个独立结果任务，provider queue 并发上限 4，现有回归固定 RelayMe 即使单任务约束为 1 也会一次排入 4 个任务。这样每个结果都有独立持久化资产和重试身份；不是要求用户逐张点击。未执行付费多图在线测试。

## 2026-08-31 Codex/RelayMe 路由隔离与视频约束回归

- 根因：Agent 的 Codex 模式曾保留一条旧测试契约，允许只配置 RelayMe 时把普通 RelayMe 聊天路由当成 Codex 运行时；同时画布只把活动供应商目录传给 Agent，导致选择 RelayMe 生成供应商时独立 Codex 路由不可见。现在普通对话按活动供应商优先，Codex 模式从完整目录中只选择明确的 Codex/受支持 GPT-5.6 路由，并明确排除 RelayMe，避免两套供应商互相回退。
- 视频节点必须遵循当前模型目录约束：比例、分辨率、时长和输出数量只显示模型声明的选项；只有缺少对应元数据时才使用产品回退。旧测试不再强制每个视频模型显示全部比例、分辨率或 1–4 数量。
- Photoshop 多图结果保护：右键选中的 RelayMe 多图结果必须按其真实 asset id 导入当前 Photoshop 文档，不得固定导入第一张；旧版 WSH/CS6 兼容和无活动文档错误提示继续由专项回归保护。
- 新鲜验证：`npm.cmd exec vitest -- --config vitest.config.ts apps/renderer/src/canvas/CanvasWorkspace.test.tsx apps/renderer/src/canvas/ModuleNodeCard.test.tsx apps/renderer/src/agent/SkillChatWorkbench.test.tsx --run` 为 406/406 通过；完整 `npm.cmd test -- --run` 为 211 个文件、2625 个测试通过，2 个性能文件/测试按设计跳过；`npm.cmd run build` 通过，Vite 仅保留既有大 chunk 提示。Windows 安装包与隔离 packaged 验收仍需在此记录之后重新执行。
- 1.6.83 packaged 真实 RelayMe 验收使用隔离 QA 数据根：账号登录成功、目录返回 11 个模型；`GPT Image 2` 图片任务完成并落盘为 1254×1254 PNG；`Veo 3.1 Fast` 视频任务完成并落盘为 MP4；页面错误为 0。Photoshop 导入桥接返回 `no_active_document`，证明调用已到达 Photoshop 适配层且当前没有活动 PSD/PSB，未误报成功。验收使用的账号密码未写入项目、日志或安装包。

## 2026-08-31 视频结果 MP4 播放与 RelayMe 引用能力边界

- 视频结果节点的显示根因已确认：`video_result` 只从上游配置读取 `posterUrl`/`posterAssetId`，没有解析同一 `assetId` 对应的 `projectVideos`，所以即使任务已落盘为 MP4，画布仍只渲染静态封面图。
- 保护行为：结果节点现在按资产 id 绑定真实 `video/mp4` 的 `displayUrl`，使用带 `controls` 的 `<video>` 播放器并保留封面 `poster`；生成节点展开后的结果网格也优先渲染真实视频，只有缺少视频资产时才回退到图片封面。折叠卡仍保留轻量封面预览。
- RelayMe 的图片/视频生成接口当前契约仅公开文本 `messages`，服务层对非空 `referenceAssetIds` 明确返回 `CAPABILITY_UNSUPPORTED`，因此画布的 `@` 选择、提示词持久化和 Comfly 引用链路正常，但 RelayMe 不能安全地伪造素材引用；UI 会显示可重试的能力错误而不是误生成。
- 新鲜验证：视频结果与 RelayMe 服务/客户端联合回归 245/245 通过；全工作区 TypeScript 检查通过；`git diff --check` 通过。未触发新的付费 RelayMe 生成。
- 1.6.84 发布门禁：完整 Vitest 为 211 个文件、2625 个测试通过，2 个性能文件/测试按设计跳过；全工作区 typecheck 和 production build 通过；真实浏览器 `a completed video remains inside its source node after reload without an external result node` 通过，确认 MP4 元素及重载恢复。隔离 packaged 重启冒烟两次版本均为 1.6.84，`canvasVisible=true`、`fatalAlertCount=0`、`pageErrors=[]`、`restoredImageNodes=1`。
- 1.6.84 Windows x64 NSIS：`CanvasAtelier-Win10-11-x64-1.6.84.exe` 为 103200260 字节，SHA-256 `537AA2E399F64FC16548BAF3CF5E15B610213AFC98FCBA529E7634E558ADB0A0`；blockmap 为 109581 字节，SHA-256 `E1FA463834F4DD5BD22C8A05D02B9F5A183363727725CDD003BACD8610B5AA58`；`latest.yml` SHA-256 `938D4162F691A8CAB0E1D0B5B1E88FB8D3FBE35E7343B83EC0BCBA0F173C5C9A`。安装包未签名（`NotSigned`），Windows 可能显示 SmartScreen 提示。

## 2026-09-01 保存画布图片操作与 MP4 流式播放修复

- “发送到画布”此前被 UI 硬编码为禁用；现在生成图片会通过单一持久化事务创建已绑定真实 `assetId` 的 `image_input` 节点，因此保存项目与重开项目共享同一受管资产，不复制临时 URL。
- “复制图片”此前在剪贴板图片写入失败时静默退化为复制资源链接；现在不再复制链接，而是明确提示系统剪贴板权限失败。
- 保存项目中的 MP4 实际存在且包含 `ftyp`、`mdat`、`moov`，但 `novus-asset` 使用一次性 `registerFileProtocol`，不适合作为视频分段读取边界。1.6.85 改用 `protocol.handle` 与 `net.fetch(file:)`，保留请求头并启用流式 Fetch 支持，使 Chromium 能按 Range 读取受管 MP4。
- 真实保存画布隔离验收使用资产 `74baafbd7d1eb55a`：1.6.85 通过最近项目桥接打开 2 节点项目，视频从 `currentTime=0` 前进到 `1.174935`，`duration=4.01`、`readyState=4`、`paused=false`、媒体错误和页面错误均为空；未触发任何付费生成。
- 内容不匹配的事实边界：保存节点提示词是“生成一条狗散步”，桌面服务按原文提交 RelayMe，但服务端结果画面为女子在菜地。当前代码没有视频语义复核，因此不能把“文件可播放”表述为“内容符合提示词”；若要自动保证内容相关，需要增加结果理解/复核及拒收重试流程。
- 新鲜验证：完整 Vitest 为 211 个文件、2627 个测试通过，2 个性能文件/测试按设计跳过；全工作区 typecheck、production build、Electron Builder Windows x64 NSIS 均通过。已安装版再次对同一真实 MP4 验收，时间从 0 前进到 1.175837 秒，版本为 1.6.85，媒体错误和页面错误均为空。
- 1.6.85 Windows x64 NSIS：`CanvasAtelier-Win10-11-x64-1.6.85.exe` 为 103200374 字节，SHA-256 `2EE32764AF79C1E345230B88BC8E44DEEB3BE55B84ACD86799768AF395A5E0C2`；blockmap 为 109627 字节，SHA-256 `86FA54DF10DDD05A56A0F92C7EA8513AAD71424FA0173F212F062A44009CF598`；`latest.yml` SHA-256 `B615AF9EEB366C49007C35B555A8A6951797CAB14EC51F0C816B7AA68EBABFBA`。安装包未签名（`NotSigned`）。安装后 `app.asar` 版本为 1.6.85，且与 packaged `app.asar` SHA-256 同为 `24837A1886C84CC6F9EEE364ED149AA72510B41FA1989939DA7AC3C0232C8327`。

## 2026-09-01 视频点击边界与 Photoshop COM 诊断

- 视频文件可解码并不保证画布节点能接收点击。已确认 `.module-node__video-preview-play` 覆盖在原生 `<video controls>` 上方且此前允许接收指针事件；该装饰层现在显式 `pointer-events: none`，使所有播放点击到达原生播放器。
- 当前机器对 `Photoshop.Application` 及常见版本化 ProgID 均返回 COM `0x800401E3`（Operation unavailable）。这意味着 Canvas Atelier 无法取得当前 Photoshop 自动化实例；不是图片 asset、PSD 是否已选择或普通 placement 错误。Windows runner 现将该错误归类为 `automation_unavailable` 并由界面提示以相同权限运行 Photoshop 和画布后重试，不再伪装成 generic placement failure。
- 回归：`packages/desktop-core/src/photoshop-windows-adapter.test.ts`、`apps/renderer/src/app/photoshop-import.test.ts`、`apps/renderer/src/main.styles.test.ts`。聚焦验证：`npm.cmd exec vitest -- --config vitest.config.ts packages/desktop-core/src/photoshop-windows-adapter.test.ts apps/renderer/src/app/photoshop-import.test.ts apps/renderer/src/main.styles.test.ts --run`，89/89 通过。
- 边界：该修复提供真实诊断与视频点击边界，不能自行让 Windows 已拒绝的 Photoshop COM 实例可用；也未增加 RelayMe 视频的语义验收，提示词原文与任务身份可追溯但模型结果是否相关仍不能自动保证。
- 1.6.86 发布候选验证：完整 Vitest 为 211 个文件、2630 个测试通过，2 个性能文件/测试按设计跳过；全工作区 typecheck 与 production build 通过。隔离 packaged 重启冒烟两次版本均为 1.6.86，`canvasVisible=true`、`fatalAlertCount=0`、`pageErrors=[]`、保存节点恢复为 1。
- 真实保存视频资产 `66f946e139999032` 在 1.6.86 packaged 运行体中从 `currentTime=0` 前进到 `1.167211`，`duration=4.01`、`readyState=4`、`paused=false`、媒体错误和页面错误均为空。打包内 Photoshop runner 在当前机器返回 `automation_unavailable`，确认新诊断已进入产物。
- 1.6.86 Windows x64 NSIS 候选：`CanvasAtelier-Win10-11-x64-1.6.86.exe` 为 103200647 字节，SHA-256 `B453D114499D915ECE1903292E2ED228E52D990CB2695DEEE8136609742AA434`；blockmap 为 109674 字节，SHA-256 `224EF8D1812641297DA7713FEA7A0D58D932DDB027807590FA9357F26744D0F7`；`latest.yml` SHA-256 `662E1658AADA26D850519A642C40CE5129DD64F11656E8BF880F0D2DF99C1A86`。`app.asar` 版本为 1.6.86，SHA-256 `2AA8873C5125F5C907048128ED049EFA649D7D076B9260CEB25C9BED3AC218ED`。安装包未签名（`NotSigned`）；尚未安装、提交、推送或发布 GitHub Release。

## 2026-09-01 1.6.87 全功能验收续跑

- 当前源码 1.6.87 的聚焦回归 387/387、完整 Vitest 2633 通过（2 个性能测试按设计跳过）、Playwright 146/146、typecheck/build 均通过。
- 最终修复后重新打包的 NSIS：`CanvasAtelier-Win10-11-x64-1.6.87.exe`，103201072 字节，SHA-256 `2CD7B43DA03BC584921BE40B4836B369F8F6768DF3D0DA62619BE184034476A7`；未发布。
- 新打包隔离冒烟恢复 1 个保存图片节点；真实 MP4 资产 `66f946e139999032` 播放从 0 前进到 1.171792 秒，duration 4.01、readyState 4、无媒体/页面错误。
- MCP 共存检查通过：连接后 `canvas_atelier, canvasforge`，断开后仅 `canvasforge`，原 CanvasForge 命令不变，Atelier 使用 `runtime-modern-v1.json`。
- Photoshop COM 诊断返回 `running`、major 27、`activeDocument=false`；连接可用，但当前无活动文档，不能据此声称智能对象导入完成。
- 旧画布 RelayMe 端点仍未完成：隔离诊断显示 `activeProvider=relayme`、`configured=true`、`locked=false`、10 个模型配置，但连接状态为 `network_unavailable`；旧画布生成脚本在外部请求阶段挂起后中止，未取得“提交前阻断”最终 JSON，因此不能把该门禁标记为通过。

## 2026-09-01 RelayMe 登录慢与重登根因

- 正式数据的隔离 Electron 实测证明凭据没有丢失：`configured=true`、`locked=false`、`safeStorage` 可自动解密，10 个模型配置和任务历史均可读取。真正的误判发生在 `checkConnection()`：它只探测 `/models`，当线上模型目录返回了客户端不认识的 envelope 时，服务把这一种解析异常统一显示成 `network_unavailable`，从而让用户误以为必须重新登录。
- 修复：模型目录探测发生非认证、非限流异常时，再用带同一已保存凭据的只读 `/tasks` 请求确认会话；任务读取成功即报告 `connected`，401/403 仍报告认证失败，429/5xx 仍报告服务受限。TDD 回归位于 `packages/desktop-core/src/relayme-provider-service.test.ts`。
- 系统确实启用了 `127.0.0.1:7890` 用户代理，旧代码却对 RelayMe API 和网页登录强制 `mode: 'direct'`。Electron 实测显示当前机器的 system/direct 两条路径都能快速到达 RelayMe 并返回未认证 401，因此“直连就是本次唯一根因”的早期判断不成立；改为 `relayme-system-network` 和 `mode: 'system'` 作为兼容系统网络策略的修正保留。
- 设置页在凭据已配置时显示“重新登录 RelayMe”，未配置时才显示“登录 RelayMe”，避免把可选的重新认证按钮误读成登录丢失。相关回归覆盖 SettingsDrawer、网页登录网络策略、runtime entry 和连接降级探测。
- 最终 1.6.87 新包验证：聚焦 115/115、完整 Vitest 2635 通过且 2 个性能测试按设计跳过、Playwright 146/146、typecheck/build/NSIS 均通过。隔离 packaged 启动返回 RelayMe `connected`、10 个模型、可读任务历史；启动烟测恢复 1 个保存图片节点，`fatalAlertCount=0`、`pageErrors=[]`。未提交新的付费生成，未安装、提交、推送或发布。

## 2026-09-03 1.6.90 全量验收与媒体控制栏修复

- 根因确认：`ModuleNodeCard` 仍渲染已退役的视频脚本/翻译/高级设置按钮；图片和视频模型同时存在原生 `select` 与自定义触发器，造成重复可见入口；展开态 CSS 中旧的高特异性 `:has()` 规则把媒体控制栏回写为 30px/48px；`App.tsx` 关闭 ACK 使用了保存前的旧 store 快照，导致保存失败时错误码丢失。
- 修复：移除退役视频工具按钮；原生模型/模式下拉保留可访问语义但设为透明、绝对定位、不可拦截指针，仅保留自定义入口可见；补齐图片/视频展开控制栏和视频主操作按钮的最终高特异性 38px/60px 规则；关闭保存后从最新 store 状态读取 `saveErrorCode`。
- TDD 与回归：先取得 3 个预期失败的红灯证据，修复后聚焦参数/图片执行/视频执行 10/10 通过；完整 Vitest 211 文件、2669 测试通过，2 个性能测试按设计跳过；全工作区 typecheck 与 production build 通过；Playwright 全量 146/146 通过。
- 真实最终 packaged smoke：版本两次均为 1.6.90，页面错误为空；图片生成栏 60px 高、可见控件均 38px；视频栏可见控件均 38px、生成按钮 52px；退役视频工具按钮 0；保存状态为 `saved`。生产包没有测试专用桥接，因此临时目录的跨进程最近项目自动恢复不作为 packaged smoke 判据，持久化与退出 ACK 由现有 renderer/desktop-core 回归及 E2E 覆盖。
- 1.6.90 Windows x64 NSIS：`CanvasAtelier-Win10-11-x64-1.6.90.exe` 为 103211920 字节，SHA-256 `CAAA3FEA5718511F0D16A58861191F8EC20D203B66FBA1FEFC32E79175F5AB0E`；blockmap 为 109554 字节，SHA-256 `222147BE6A8E591D3AB549C5970B53918D982393EEB375B61556064376E9B88D`；`latest.yml` SHA-256 `435517A78C1DDF9AB01FDB90E5472FC6EF073F18FFC23EFE8B27343977A879B3`。安装包未签名，未安装、提交、推送或发布 GitHub Release。

## 2026-09-04 MCP 媒体导入双权限边界

- 根因：`canvas_import_media` 只检查 `externalFileAccess`，所以该权限开启但 `editCanvas` 关闭时仍会打开媒体选择器，并可在用户选取后修改画布。
- 保护行为：媒体导入必须同时具备 `externalFileAccess` 和 `editCanvas`；任一权限缺失时在 adapter 边界返回 `MCP_PERMISSION_DENIED`，且不调用 `requestMediaImport`。现有外部文件权限错误优先级保持不变。
- 回归位置：`apps/renderer/src/app/mcp-workspace-adapter.test.ts` 的 `requires edit permission before opening the media picker`。该用例修复前返回 `ok: true`，最小实现后通过。
- 新鲜验证：单文件回归 16/16；MCP 相关 5 文件 39/39；`npx.cmd tsc -p apps/renderer/tsconfig.json --noEmit` 退出 0。未打包、安装或执行外部服务操作。

## 2026-09-04 Comfly 视频与 RelayMe 反推目录正证据边界

- 根因：Comfly 目录把 provider-wide `/v2/videos/generations` 当成模型级视频能力，导致没有 `视频` tag 的对话、识图和动作模型进入视频生成目录；RelayMe 目录又把“text 且非 video-only”当成反推能力，导致普通文本模型、`supportsVision: false` 以及仅文本输入模型被提升为图片反推模型。
- 保护行为：Comfly 只有同时声明规范视频 endpoint 和明确 `视频` tag 才获得 `video_generation`。RelayMe 只有明确的图片输入正证据才获得 `vision`/`reverse_prompt`；唯一 fallback 是项目真实反推 UI harness 已固定验证的精确 deployment `gemini-3.1-flash-lite`，且 `supportsVision: false` 或显式仅文本 modalities 优先否决该 fallback。
- 回归位置：`packages/desktop-core/src/provider-model-catalog.test.ts` 覆盖 Comfly 对话/识图/动作负例、明确视频正例、RelayMe 缺失视觉证据负例、显式视觉否定、仅文本输入，以及已验证 RelayMe fallback 正例。4 条收紧用例在实现前按预期失败，实现后目录单测 27/27 通过。
- 新鲜验证：provider catalog、RelayMe 服务、provider bridge/IPC、Skill chat 与 renderer profile 联合回归 6 文件 241/241；`npm.cmd run typecheck` 退出 0；目标 diff whitespace 检查退出 0。未打包、安装或发起任何付费/外部生成。

## 2026-09-04 独立 Provider UI 截图证据加固

- 根因：`work/qa-installed-provider-isolation.mjs` 的拖动辅助只根据拖动前的 bbox 返回成功，截图矩形只裁剪 `x/y` 而保留原始 `width/height`，写盘后也不检查截图像素；因此反推区域即使仍在视口外，结果仍可记录 `positioned: false` 并把全白 PNG 当作通过证据。
- 保护行为：拖动后必须重新读取目标 bbox 并确认与 viewport 相交；三类 UI 证据都必须记录并断言 `positioned === true` 与 element scope。截图矩形同时裁剪四个字段，PNG 经 Electron `nativeImage` 解码为 bitmap 后必须包含非白且非单色的 RGB 像素，否则验收立即失败。独立脚本版本固定为 `1.6.99`，环境变量不能把它降级到其他版本。
- 回归位置：`work/qa-installed-provider-isolation.test.mjs`；辅助契约位于 `work/qa-provider-isolation-helpers.mjs`。红灯首先得到 4 个预期失败，最小实现后目标文件 12/12 通过；全部 `work/*.test.mjs` 纯单元契约 59/59 通过，三个目标 `.mjs` 的 `node --check` 退出 0。
- 验证命令：`node --test work/qa-installed-provider-isolation.test.mjs`；`$tests = Get-ChildItem work -File -Filter '*.test.mjs' | ForEach-Object { $_.FullName }; node --test $tests`。本轮未启动安装版、未调用外部服务、未执行安装或付费生成。

## 2026-09-04 独立 Comfly 安装版目录验收契约

- 新增独立 `work/qa-installed-comfly-catalog.mjs`，不修改 RelayMe gate。它固定正式安装入口 `D:\CanvasAtelier\Canvas Atelier.exe`、`resources\app.asar` 与版本 `1.6.99`，要求调用方显式提供两个 SHA-256，再对真实文件流式哈希；任一哈希或版本不符都在 provider 网络检查前失败。
- 隔离边界只复制 `Local State` 与 `providers/comfly` 到经过校验的 `mkdtemp` QA 根；不复制 RelayMe、活动供应商文件、项目或 IndexedDB。启动环境移除 token、password、secret、key、auth 等凭据形状变量，脚本不调用 reveal、生成、反推、导入或聊天 API。
- 只读验收通过 renderer provider bridge 检查 Comfly `configured=true`、`locked=false`、连接状态 `connected`，并要求返回目录全部属于 Comfly 且 `image_generation`、`video_generation`、`reverse_prompt` 各至少一条。隔离 profile 内激活 Comfly 后，UI 依次创建图片生成、视频生成和 Reverse Agent 节点，只读取三个 select，要求选中值及所有选项均为 Comfly、无 RelayMe。
- 若正式 Comfly 目录缺失、`configured=false` 或安全状态锁定，runner 写入 `blocked.json`、状态为 `BLOCKED` 并设置非零退出码；其他错误写入脱敏 `failure.json`。测试位于 `work/qa-installed-comfly-catalog.test.mjs`，初始 11 项全部红灯，后续清理顺序、扩展环境凭据名与 quoted failure 值也分别经过红转绿。
- 本轮只运行纯单元测试与 `node --check`，没有启动安装版、没有调用外部服务、没有安装或付费操作；真实安装版 Comfly 状态仍待带双 SHA 的正式执行取得证据。

## 2026-09-05 Electron CSP frame-ancestors 响应头修复

- 根因：共享 renderer 把 `frame-ancestors 'none'` 放在 `Content-Security-Policy` 的 `<meta>` 中。CSP Level 3 明确要求浏览器忽略 meta 策略内的该指令，因此安装版持续输出 `frame-ancestors is ignored`，且原本期望的防嵌入策略实际没有生效；这不是 QA 对普通 console error 的误判。
- 保护行为：原有 script/style/image/media/font/connect/object/base/form meta 限制保持不变；只把 `frame-ancestors 'none'` 移到 Electron `defaultSession` 的 `file://` document 响应头。modern 与 legacy shell 都在创建窗口前注册；helper 保留已有 CSP header 并按大小写不敏感查找 header 名。只有实际生效且 source list 精确为 `'none'` 的 directive 才去重；已有 `'self'`、`*` 或其他弱值时会追加独立的 conjunctive `'none'` policy，不能绕过防嵌入边界。图片/脚本等非文档响应保持不变。
- 回归位置：`packages/desktop-core/src/renderer-security-headers.test.ts` 首轮先因 helper 缺失取得预期 RED；reviewer 加固又让弱 `'self'` 和多 policy `*` 两项按预期失败，最终 4/4 通过，覆盖混合大小写精确 `'none'` 和弱策略加固。`work/qa-csp-packaged-smoke.test.mjs` 首轮先因正式 helper/runner 缺失取得 2 个预期 RED；reviewer 随后用 1/2 RED 证明 `firstWindow().url()` 存在启动竞态，runner 现在先等待精确 `file:` renderer `index.html` 和 `domcontentloaded` 再复制 URL，最终 2/2 通过；同时继续禁止不存在的 `ChildProcess.exited` 与会触发原生退出确认框的 `electronApp.close()`。
- 新鲜验证：CSP/runtime 聚焦契约 28/28；desktop-core/desktop-bridge/desktop-modern 宽回归 92 个文件、1017 个测试通过，2 个性能文件/测试按设计跳过；desktop-core、modern、legacy typecheck 通过；desktop-core、renderer、modern build 通过。
- reviewer 后的隐藏 packaged-directory smoke 使用 Electron 43.1.0 且不读取正式数据：document response 实测为 `content-security-policy: frame-ancestors 'none'`，meta 不含该指令，CSP console message 为 0；runner exit 0、状态 `passed`，PID 7368 和隔离 `canvasforge-qa-csp-YS8uZK` 根均清零。临时 `dist-builder/csp-smoke` 随后经路径/进程校验删除。报告为 `work/qa-csp-warning-fix.md`。
- 交付边界：当前已安装 1.6.99 仍是修复前二进制。必须在所有并行修改合并后重新构建/安装最终版本，并对 `D:\CanvasAtelier\Canvas Atelier.exe` 重跑同一 CSP smoke，才能把安装版该项标为通过。

## 2026-09-05 MCP 产品身份与默认运行时路径隔离

- 根因：MCP 客户端配置键已是 `canvas_atelier`，但品牌迁移只完成了配置入口；stdio server 握手、工具/错误文案、设置页、工作流 `productName` 以及 bridge 无显式环境变量时的 AppData fallback 仍写死 `CanvasForge`。这会让新配置看起来仍属于旧产品，并可能在手工启动 bridge 时读取旧产品目录。
- 保护行为：用户可见身份统一为 `Canvas Atelier`，稳定 server name 为 `canvas_atelier`；Codex 配置仍只写 `[mcp_servers.canvas_atelier]`。新增备份/原子临时文件使用 `.canvas-atelier-*` 后缀，既有 `canvasforge` server 项和旧 `.canvasforge-backup-*` 文件原样保留；内部 `canvasforge.mcp.*` wire protocol、pipe 名和 `CANVASFORGE_MCP_RUNTIME_FILE` 环境变量继续兼容，不做破坏性迁移。无显式 runtime 环境变量时只回退到 `%APPDATA%\Canvas Atelier\mcp\runtime-modern-v1.json`，不再读取 `%APPDATA%\CanvasForge`。
- 回归位置：`packages/mcp-bridge/src/server.test.ts`、`runtime-client.test.ts`、`runtime-path.test.ts`，`packages/domain/src/codex-workflow-contract.test.ts`、`mcp-workflow.test.ts`，`packages/desktop-core/src/mcp-client-config.test.ts`、`mcp-runtime-service.test.ts`、`mcp-stdio-health.test.ts`，以及 `apps/renderer/src/settings/SettingsDrawer.test.tsx`。首轮 21 项按预期失败，覆盖旧身份、旧 fallback 和旧后缀；最小实现后 MCP 聚焦 8 文件 101/101、首轮 MCP 宽回归 17 文件 223/223 通过。
- 独立复核随后发现 renderer adapter 的权限、无效请求、任务、确认、持久化和付费任务错误，以及 Agent 空状态介绍仍含用户可见 `CanvasForge`。新增 `mcp-product-identity-scan.test.ts` 扫描 `apps`/`packages` 生产源码；allowlist 只容许稳定 wire protocol、pipe、兼容资源文件名、旧环境变量、旧数据迁移、旧快捷方式清理及隔离 formal-QA 内部命名。扫描首先以 14 个未授权命中 RED，行为回归同时 5 项失败、108 项通过；替换用户文案后聚焦 3 文件 114/114 通过，生产扫描 1/1 通过。
- 供应商隔离复核：复核修正后重新运行 Comfly/RelayMe 目录、RelayMe 服务、bridge、IPC、Agent 和 renderer profile 联合回归，6 文件 241/241 通过。本次没有修改 provider 选择、凭据或模型路由。复核后的 MCP 宽回归 19 文件 321/321 通过；完整工作区 `npm.cmd run typecheck` 退出 0，MCP bridge build 退出 0。
- 交付边界：未打包、未安装、未修改或删除用户 MCP 配置/旧 CanvasForge 数据。最终安装版仍必须重跑真实 Codex/WorkBuddy 连接、14 工具和零付费画布往返，才能把安装版 MCP 标为通过。

## 2026-09-05 安装版 MCP 14 工具零付费全链与重启持久化

- 正式安装入口 `D:\CanvasAtelier\Canvas Atelier.exe`、版本 1.6.99 在完全隔离的 `APPDATA`、`LOCALAPPDATA` 与 user-data root 下完成 bundled MCP 验收；真实项目、供应商凭据和用户 MCP 配置均未读取或改写。本轮没有打包、安装、联网或真实付费生成。
- bundled schema 精确为 14 项，SHA-256 `7a765fe40550d2cf78dc44b3f845a895d85b2106cf91c242da64bc6283a58576`；运行 ledger 证明 14/14 工具均被实际调用。精确计数：describe 1、read 11、get_selection 1、get_job_status 5、plan 2、apply 2、create 5、update 1、connect 1、move 1、delete_selection 2、run_node 7、cancel_job 1、import_media 1。
- 受控零付费 executor 记录 2 次提交、2 次轮询、1 次 provider cancel、`completed`/`cancelled` 两种 terminal ACK，且 `networkAttemptCount=0`。完成任务的受管结果落回节点；可取消任务先进入 running，再由 MCP 调用真实 provider cancel channel，最终状态为 cancelled。
- `canvas_get_selection` 使用真实 React Flow DOM 选中节点；`canvas_delete_selection` 经安装版 UI 确认、同一计划重试与 apply 后节点消失。`canvas_import_media` 的请求抵达可信 filechooser bridge，由 Playwright 注入 QA root 内 2x2 PNG，不弹原生对话框；生成的 `image_input` 节点、坐标和 managed asset 均由 MCP read 验证。
- 同一隔离 root 下先保存 MCP 创建/修改的节点、边、生成结果与导入媒体，再关闭首个 MCP client、destroy 隐藏窗口、`app.exit(0)`，清除隔离 runtime descriptor 后重启同一安装版。第二个全新 bundled MCP client 读取到完全相同 revision 13、3 个要求节点、原 edge 与媒体 node/asset；先前删除的 selection node 仍不存在。
- 最终执行的两组 Electron main、Playwright wrapper 与 MCP bridge PID 均精确停止，QA root 随后移除；不调用 `app.close()`，因此没有原生保存/退出对话框。验收报告：`work/qa-installed-mcp-zero-cost-full-chain.md`。
- 边界：当前 `canvas_run_node` 的安装版正向证据覆盖 image completion 与 image cancellation，尚未分别覆盖 video_generation 和 reverse_agent 的安装版执行；它们需要独立的零付费 video IPC 与完整 reverse result/media fixture，不能由“14 工具都调用”外推为已通过。

## 2026-09-05 安装版 MCP 视频与反推零付费执行门禁

- 新增独立 `work/qa-installed-mcp-video-reverse-zero-cost.mjs`，不修改 14-tool/restart gate。它在隔离安装版 1.6.99 内注册 video submit/poll/cancel/ACK 和 reverse analyze IPC，移除凭据形状环境变量并拒绝所有 main-process `fetch`；真实项目、供应商配置、凭据和 MCP 客户端配置均未读取或改写。
- 视频节点通过 MCP 三段付费确认后，真实 model-job 队列提交 1、轮询 1、取消 0、completed ACK 1；`canvas_get_job_status=completed`，视频 asset `fedcba9876543210` 回写同一 `video_generation` 节点并由 MCP workflow read 验证。
- 反推输入通过 trusted filechooser 导入 QA root 内 2x2 PNG，不弹原生 picker；managed asset `1701ee1866e400ef` 被写入 `reverse_agent.referenceAssetIds`。MCP 三段确认后 analyze IPC 只调用一次，严格匹配 route、task、run identity、SHA/byte/media/ordered-media identity，并返回带 `@图片1` 素材职责的完整合法结果。
- 反推不属于 modelJobs；其 `reverseAgentRunId` 仍由 `canvas_get_job_status` 读到 completed，随后 MCP read 验证 `reverseAgentRunState=completed` 与 identity-matched result 已持久化。首次安装版 RED 是 gate 错把通用 `executionState=completed` 套到反推节点；TDD 以 `executionState=idle` 的合法 fixture 复现并改为检查真实 reverse 状态，没有修改生产代码。
- 最终 1.6.99 gate exit 0/status passed，`networkAttemptCount=0`；PID 58672、47896、34792 均停止，隔离 root `canvasforge-qa-installed-mcp-video-reverse-7fJQpS` 已删除。目标单测 6/6、相关源码 8 文件 408/408、两个 node syntax check 均通过。报告为 `work/qa-installed-mcp-video-reverse-zero-cost.md`。
- 发布边界：以上只是当前安装版 1.6.99 的受控零付费资格验证，不是 live provider/真实付费结果。最终 1.6.100 安装后必须用 `CANVASFORGE_QA_EXPECTED_VERSION=1.6.100` 重跑同一脚本才能转为正式版本证据。

## 2026-09-05 视频节点、反推缩略图与 Codex 模型选择修复

- 根因：视频生成结果仍渲染自定义中心播放按钮和全屏按钮，旧 CSS 还保留对应定位与指针层；反推 Agent 的媒体标签与路由区在同一控制条中被压扁，最终缩略图行又被旧 pseudo-element/overflow 规则隐藏；Codex profile、请求 schema、CLI 参数和 renderer persistence 曾把 `gpt-6-astra` 写死。
- 修复：视频结果保留原生 `<video controls>`，移除自定义播放/全屏 DOM 与死 CSS；视频节点控制栏仅在 `data-module-type='video_generation'` 下使用流式 38px 控件布局；反推路由区与媒体区分区排列，媒体槽按 20 个上限显示并横向滚动；Codex 从本机 `models_cache.json` 读取 `visibility=list` 且 `supported_in_api=true` 的公开模型，并将选择的 `codex/<model>` 传到 CLI 和结果。
- 当前本机 Codex 目录显示 6 个模型：GPT-6 Astra、GPT-5.6 Sol、GPT-5.6 Terra、GPT-5.6 Luna、GPT-5.5、GPT-5.4 Mini。隐藏/API 未开放项继续过滤。当前本机 Codex 通道仍是文本/MCP 契约，图片/视频引用在 contract 中明确拒绝；需要图片粘贴时切换到“对话”模式和视觉模型，界面错误提示已改为通用“当前 Codex 模型”，不再误指 Astra。
- 右键发送根因：图片结果菜单原先只切换 Agent 折叠状态，没有切换 `CanvasWorkspace` 的 active surface，因此事件可能发出但 Agent 面板仍隐藏。新增幂等的 `novus:open-agent` surface 事件，确保多次发送不会把已打开的 Agent 关闭；随后延迟派发受管图片引用。
- 视频结果基础节点也清理了自定义全屏按钮、中心播放符号及对应死 CSS，所有可播放结果只保留原生 `<video controls playsInline>`。
- 新鲜验证：视频 UI Playwright 43/43、反推 UI Playwright 2/2、组合 Agent/媒体/视频 UI Playwright 59/59、完整 Vitest 220 文件 2845/2845（2 个性能测试按设计跳过）、右键/Agent/Canvas 聚焦回归 404/404、全工作区 `npm.cmd run typecheck` 退出 0、生产 `npm.cmd run build` 退出 0、`git diff --check` 退出 0。未打包安装、未提交或发布；旧安装版不会自动包含本轮源码改动。

## 2026-09-05 视频控制栏最终发布规则与安装占用处理

- 根因：`main.tsx` 先导入 `canvas-layout.css`，再导入 `release-layout-contract.css`；后者末尾的同选择器规则把视频展开态控制栏恢复为 `position: relative`，因此源码看似有底部间距，已安装版仍贴边。另一个独立问题是 Codex/MCP 以 `Canvas Atelier.exe ...canvasforge-mcp.cjs` 保留 stdio 子进程，窗口关闭后 NSIS 仍检测到安装目录被占用。
- 修复：视频展开控制栏固定左右和底部 18px、控件高 38px，提示词与控制栏保留 12px 间隔；窄屏双行控制栏为 84px。最终几何及截图由 `work/diagnose-installed-video-rail.mjs` 验证。NSIS 使用 `customCheckAppRunning`，只停止目标安装目录中命令行精确匹配 bundled MCP bridge 的后台进程；GUI、未知调用和其他安装目录保持运行，GUI 未关闭时提示保存退出。已撤销早期 `customInit/taskkill` 方案，旧候选安装包不可交付。
- 安装检查证据：`work/installer-process-check.test.ps1` 的 8 项模拟边界测试，以及 `work/qa-installer-process-check.mjs` 编译执行真实 NSIS hook 均通过；覆盖 MCP 停止、未知调用与其他安装保留、可执行文件占用释放。

## 2026-09-05 多图图槽、批量粘贴和连线吸附

- 反推根因：执行层对超过 20 张或重复引用返回校验失败，渲染层把失败转换为空数组，导致整条图槽消失。现在显示层逐连接解析有效素材，超过 20 张仍显示所有有效缩略图并横向滚动；单次反推的 20 张执行上限保持不变，错误提示使用独立可见样式。
- 图片和视频生成图槽保留前 20 张。连接 25 张时对可见 20 张换位，旧逻辑遗漏另外 5 条边，导致顺序没有持久化；现在补齐未显示的连接后提交完整排列。视频展开态也接回换位回调。三类图槽浏览器测试覆盖 6、7、20、21、25 张、滚动、换位、保存重开以及生成节点展开态。
- 桌面粘贴根因：`readClipboardMediaFile` 使用 `find` 或循环首次返回，丢掉其余图片。现在读取完整 FileList（items 仅作为后备，避免重复），依次调用现有受管导入、分开摆放；单图仍可替换所选图片节点，多图创建独立节点。导入失败或切换项目时停止余下批次。
- 原生粘贴证据：`work/qa-packaged-multi-paste.mjs` 在隔离 1.6.103 桌面程序中使用真实 Windows FileDropList 一次复制 25 张 PNG，记录 clipboardFiles/imported/nodes/loaded/positions 均为 25，页面错误 0，测试后恢复原剪贴板。报告为 `work/qa-packaged-multi-paste-final/report.json`。远离视口的节点会按既有策略卸载，检查时通过实际缩小画布查看全部节点，不把视口卸载误报为导入失败。
- 连线根因：部分新节点的 React Flow `handleBounds` 尚未建立，原内部坐标刷新仅覆盖已有连线端点。小画布现在也刷新新节点；吸附半径按视口缩放换算为屏幕 48px。9 项浏览器测试覆盖四个方向偏离端口 32px、缩小画布后的相同距离以及不兼容/远距离拒绝。
- 验收边界：上述是实际媒体、桌面剪贴板及受控 MCP/UI 验证，不代表外部供应商付费生成已重测。最终安装包必须在这些修改及回归后重新构建。
- 最终回归：完整 Vitest 220 文件、2854 项通过，2 项性能测试按设计跳过；完整 Playwright 160/160 通过；全工作区 typecheck 和生产 build 退出 0。最终 unpacked 1.6.103 三类节点均完成真实 PNG 的 6、7、20、21、25 输入检查点，反推显示25张，图片/视频保留20张，最后一张可滚动查看及换位，页面错误均为0；同一构建原生剪贴板再次通过25/25。报告分别位于 `work/qa-packaged-25-images-final`、`work/qa-packaged-25-image_generation-final`、`work/qa-packaged-25-video_generation-final` 和 `work/qa-packaged-multi-paste-final`。

## 2026-09-06 1.6.106 安装版 Agent 图片复制门禁

- 安装根因：静默安装命令 `/D=D:\CanvasAtelier\Canvas Atelier` 在 NSIS 解析时按空格截断，首次把 1.6.106 写到了 `D:\CanvasAtelier\Canvas`；使用带引号的 `/D="D:\CanvasAtelier\Canvas Atelier"` 后，安装注册信息、安装可执行文件和 app.asar 均回到目标目录并报告 1.6.106。
- 版本边界：候选 unpacked 与安装后的 `resources/app.asar` 均为 1.6.106，SHA-256 均为 `1687621ffe33dc9862ed4dbfa362d025025d3b98460bf3d5863c6e40a9c0826d`。原目录的六个隐藏进程均为精确 bundled MCP bridge 调用，没有 GUI 窗口。
- QA 根因：`work/qa-installed-agent-image-chat.mjs` 原先写入的手工 2x2 PNG 能在 Chromium 预览和 `novus-asset:` fetch 中工作，但被 Electron `nativeImage` 拒绝，导致复制桥返回 false。改用与 `packages/desktop-core/src/test/png-fixture.ts` 同格式的 1x1 PNG；这只修复验证 fixture，不改变生产剪贴板逻辑。
- 新鲜安装版验证命令：`$env:CANVASFORGE_QA_EXPECTED_VERSION='1.6.106'; node work/qa-installed-agent-image-chat.mjs 'D:\CanvasAtelier\Canvas Atelier\Canvas Atelier.exe' 'work/qa-installed-agent-image-chat-1.6.106-correct-fixture-20260906'`。结果 status `passed`：隔离网络、模型选择、原生粘贴、`@图片1` 引用、发送缩略图、novus-asset fetch、图片复制反馈和原生剪贴板非空有效 PNG 全部通过（报告记录实际像素尺寸）；pageErrors/consoleMessages 均为空，隔离 root 与原剪贴板均已清理。
- 交付边界：该门禁证明 1.6.106 已安装并通过 Agent 图片复制链路；尚未证明外部 provider 的真实付费生成、RelayMe 登录保持、Photoshop 导入或完整 MCP 14-tool 生产安装版链路。
- 模型路由回归：`resolveModelJobProfile` 原先固定筛选 `image_generation`，视频计划会静默使用图片模型。现在从计划 transaction 的模块类型推导 `video_generation` 或 `image_generation` 能力后再筛选；回归测试位于 `apps/renderer/src/app/app-store.test.ts` 的 `agent generation model selection`。

## 2026-09-06 1.6.107 Agent 创作规划与专业反推回归

- 创作 Agent 现在由聊天模型先返回带观察/估计/未知标记的 1 至 3 个方案；用户选择方案后才创建或定位生成节点，确认后才提交图片/视频任务。生成偏好独立保存图片与视频的自动/固定模型和参数，不改变聊天模型路由。
- 生成任务按实际生成节点绑定自己的提示词、类型、参数和素材引用；不再让多个方案共用旧提示词节点。切换模式、模型、会话会使迟到响应失效，完成任务通过画布节点的实际 job 状态回写 Agent 消息和缩略图。
- Codex 模型目录读取本地 `models_cache.json` 的可见模型、支持的推理档位和默认档位；不再把目录解析失败或空目录伪装成可用 Astra。反推专业章节保留相机/透视、形态结构、景深、材质、灯光、特效、流体、视频分镜和不确定性；格式不完整时保存部分章节与缺失清单。
- 验证：`npm.cmd exec vitest -- run` 通过 221 文件 / 2873 项（2 项跳过）；`npm.cmd run typecheck` 通过。安装版 1.6.107 需在新包生成后重跑 `work/qa-installed-agent-image-chat.mjs` 和 `work/qa-installed-creative-plan.mjs`，不能用 1.6.106 证据替代。

## 2026-09-06 1.6.107 安装包与全量回归

- 根目录 `package.json` 曾被错误替换为 desktop-modern 子包，导致 npm workspace 消失；已恢复 workspace manifest，保留 desktop-modern 1.6.107 版本。
- 生产构建及 NSIS 打包通过。安装包位于 `apps/desktop-modern/dist-builder/desktop-modern-1.6.107/CanvasAtelier-Win10-11-x64-1.6.107.exe`，SHA-256 为 `26BF12167EF06C969ABDFF9DEC77425ED73E85E3E667BA642C20676E36A05A4E`，`latest.yml` 版本为 1.6.107。
- 全量 Vitest 首轮仅发现 3 个旧版本/旧布局契约，更新 1.6.107 与 560px Agent 面板断言后定向回归通过；全量 Playwright 159/163 通过，剩余 4 项同为旧 460px 几何契约，更新后受影响套件 26 项通过。MCP 配置、14 工具 schema、自动化/生图/视频零成本工作流测试 44/44 通过。
- Playwright 输出有 Chromium `ResizeObserver loop completed with undelivered notifications` 开发服务器告警，但未导致用例失败。未执行新的 RelayMe/Comfly 付费生成，也未覆盖真实外部 provider 成功证据。

## 2026-09-06 1.6.107 Agent 稳定性与引用回归

- 拖动根因：位置提交成功后，旧的 durable source 回写会在提交 finally 阶段覆盖本地拖动位置。`useCanvasDraft` 现在记录已确认位置及提交前位置；源状态仍是旧值时保留本地位置，源状态变为其他新位置时接受 durable source，避免自动归位。
- 关闭协议：completed ACK schema 现在允许受限的 `errorCode`，因此 `SAVE_TIMEOUT`、`CLOSE_SAVE_EXCEPTION` 等失败原因能安全传到桌面关闭恢复流程。现有保存失败重试、丢弃和关闭超时回归继续通过。
- Agent 引用：模式切换会清除旧媒体能力错误；Agent 对话作用域补齐引用芯片的内联、换行和缩略图尺寸规则，避免 `@图片` 被挤成独立异常行。聚焦回归为 129/129，renderer、desktop-core、desktop-modern 类型检查通过。
- 本轮尚未重新生成 1.6.107 安装包；安装版普通生图、视频生图、Agent 自动化工作流和真实外部 provider 仍需在新包完成后重新验证。

## 2026-09-07 提交 ACK 与后台维护解耦

- 根因：桌面 bridge 的 `commit` 在 journal writer 已返回 durable ACK 后，仍在同一个 IPC Promise 中等待自动快照、项目重读和 recent-project 索引更新；大型项目或慢磁盘因此会让 renderer 的保存计时误报 `SAVE_TIMEOUT`。自动维护还与关闭共用队列，关闭时序容易被未完成的 compaction 影响。
- 修复：journal ACK 现在立即返回；自动快照在 ACK 已预留的同一会话维护尾中继续有序执行，stable point/close 会等待这段维护完成；recent-project 索引改为独立的有序辅助队列，并直接使用已应用事务的项目快照。辅助索引异常不会生成未处理 rejection，也不会阻塞 durable write。
- 回归位置：`packages/desktop-core/src/bridge-contract.test.ts` 的 `returns the durable commit acknowledgement...` 与 `reserves automatic snapshot maintenance...` 用例，分别覆盖慢快照/索引和提交期间关闭的顺序。
- 新鲜验证：bridge contract 90/90 通过；新增提交 ACK/关闭顺序用例通过。desktop-core 全套类型检查与更宽套件需由当前发布任务继续执行。

## 2026-09-06 1.6.107 稳定性修复候选包验证

- 重新构建并打包 `1.6.107` 成功。候选安装包 `apps/desktop-modern/dist-builder/desktop-modern-1.6.107/CanvasAtelier-Win10-11-x64-1.6.107.exe` SHA-256 为 `207C45F51E367620F7A6F57E6E58E052DBE11B452D0DEC0BFE0A6D63ED5B79BE`；候选 `app.asar` SHA-256 为 `3E78B7ED0607F46BB01286B726A63F8EF435FDF6E3793573E6DB436B33DFD6B8`。旧 payload 脚本中的历史 app.asar 哈希不适用于本候选包，不能作为失败证据。
- 安装到隔离目录 `D:\CanvasAtelier\Canvas Atelier-1.6.107-qa` 后，实际版本为 `1.6.107`。安装版 Agent 图片引用门禁通过：原生剪贴板、`@图片1`、发送缩略图、图片复制和 PNG 回读均通过，页面错误为空。
- 安装版创作 Agent/MCP 工作流通过：聊天规划 1 次、节点提交 1 次、结果缩略图回写，重启后节点 ID、提示词和结果均保持，付费调用为 0，页面错误为空。
- MCP 配置与 14 工具零成本门禁仍为 `44/44`。真实 RelayMe/Comfly provider、生图和视频付费调用没有在离线 QA 中伪造为成功，仍需独立授权后验证。

## 2026-09-06 1.6.107 Renderer 打包与 Agent 几何复核

- 用户截图复现确认第一处根因：桌面 `build` 不会自动运行 Renderer 的 Vite build，electron-builder 只复制已有 `apps/renderer/dist`；只重建桌面主进程会把旧界面继续放进新安装包。现已显式执行 `npm.cmd run build --workspace @agent-canvas/renderer` 后再打包。
- 第二处根因：`release-layout-contract.css` 在 `app.css` 之后加载，仍把 Agent header actions 设为旧的 `1fr 34px`、输入区设为 54px/110px，覆盖了前面的修复。已在 release contract 末尾增加最终局部规则：Agent 面板 560px、选择器/加号 42px 同基线、编辑区 96px 至 160px。
- 新增样式红测先失败后通过；最终安装候选的真实 DOM 几何为：panel 558px、header action grid `428px 42px`、select 42px、plus 42px、composer editor 96px。Agent 样式/引用聚焦回归 `125/125` 通过。
- 候选 `win-unpacked` 已重新启动并完成 Agent 图片引用/复制门禁；正式目录安装器受 Windows 安装器现有占用/权限流程阻断，未强行杀进程或覆盖用户目录。必须在正式目录安装成功后再做最终用户路径验收。

## 2026-09-06 1.6.107 正式目录写入与复测

- 最新候选包已成功写入正式目录 `D:\\CanvasAtelier\\Canvas Atelier`，安装器退出码为 0；正式目录 `resources\\app.asar` SHA-256 为 `3E78B7ED0607F46BB01286B726A63F8EF435FDF6E3793573E6DB436B33DFD6B8`，与候选包一致。
- 正式目录实际启动版本为 `1.6.107`。真实 DOM 几何复测：Agent 面板 558px，任务选择器 42px，加号 42px，输入区 96px；不再使用旧的 460px/34px/54px 级联。
- 正式目录安装版 Agent 图片引用/复制门禁通过，`@图片1` 发送、缩略图加载、系统剪贴板 PNG 回读均通过；创作 Agent/MCP 工作流通过，重启后节点、提示词和结果保持，页面错误为空。

## 2026-09-06 1.6.107 正式目录生图/视频与 Codex 工作流验证

- 正式目录 `1.6.107` 的普通模式零成本图片执行链通过：创建、确认、提交、轮询、结果资源持久化、取消和重启读取均通过；14 个 MCP 工具全部实际调用，页面错误为空。
- 正式目录 `1.6.107` 的普通模式零成本视频执行链通过：视频提交、轮询、终态确认、托管结果持久化和进程清理通过；反推链同步通过。
- Codex/MCP 简单图片与视频工作流通过：读取画布、创建/更新/移动/连接节点、确认后执行、结果回写、取消、删除、重启读取均通过；图片和视频结果均持久化，工作流报告无网络请求。
- 当前环境未配置 RelayMe/Comfly 凭据，未发起真实付费 provider 生图或视频请求；上述结果是隔离零成本执行器验证，不能替代真实供应商成功证据。

## 2026-09-07 RelayMe 四链能力与过期会话修复

- 根因一：RelayMe 画布反推已通过 `/chat/completions` 使用受管图片，但 Agent 对话服务仍无条件拒绝所有 `referenceAssetIds`，两套桌面入口也没有注入 Agent 受管图片读取器；因此同一视觉模型能做画布反推，却不能做对话反推。现在 Agent 只允许 `vision` profile，安全读取受管 PNG/JPEG/WebP/GIF，校验数量、非空字节和 MIME，并只把 data URL 附到最后一条用户消息；modern/legacy 均已接线。
- 根因二：实际反推 deployment `gemini-3.1-flash-lite` 的目录可能遗漏视觉 metadata，旧 fallback 只给 `reverse_prompt`，没有给 Agent 路由需要的 `vision`。现在仅对这个精确 deployment 补 `chat + vision + reverse_prompt`；`supportsVision:false` 或明确 text-only modalities 仍优先，普通文本模型不会被提升。
- 根因三：RelayMe 401/403 只翻译成 `CREDENTIALS_LOCKED`，没有设置 IPC 已有清理逻辑识别的 `authenticationExpired`；模型目录又可用缓存吞掉 401。现在过期错误带稳定 marker，目录不会以缓存掩盖鉴权过期，既有 IPC 会清除过期会话和 active RelayMe。
- 参考图生图边界：已认证的 `/images/generations` 请求只有 `model`、文本 `messages`、比例、采样尺寸、质量和数量；task/list 只有任务身份、类型、状态、时间与错误，没有可验证的参考图片字段。`supportsImageToImage` 只是目录 metadata。旧代码会在该 flag 为 true 时暴露 `image_edit`，随后付费请求却完全丢掉图片。现在 RelayMe 不再宣称 `image_edit`，任何非空参考图都在提交前明确拒绝并说明不会消耗额度。RelayMe 文生图和文生视频仍走直接 generation + task polling；视频素材引用、视频反推和 provider cancel 继续 fail closed。
- TDD 证据：Agent 引用 RED 3 项失败、过期缓存 RED 1 项失败、verified vision RED 4 项失败、参考图静默丢失 RED 2 项失败；最终 RelayMe 聚焦 10 文件 226/226，设置/反推 UI 5 文件 205/205，RelayMe client typecheck 退出 0。完整记录见 `work/qa-relayme-capability-audit-20260907.md`。
- 验收边界：本轮未发真实请求、未读取或修改凭据，也没有消耗额度。2026-09-06 保存的 RelayMe 登录已失效；必须重新完成官方网页登录后，分别验证当前目录、一次低成本文生图、一次低成本文生视频、一次图片画布反推和一次图片对话反推，才能把 live provider 行标为通过。并行 Comfly 改动曾导致 modern/legacy typecheck 的 resolution union 临时失败，最终发布任务必须在共享修改收口后重跑全量 typecheck/build/package/installed gates。

## 2026-09-07 E2E 供应商能力 fixture 收敛

- 根因：浏览器 E2E 仍直接加载 2026-08-09 的 Comfly 审计快照，把没有当前生产提交契约的 Grok、MiniMax、Kling 等视频家族标成可运行；RelayMe 视觉对话 fixture 还声明了 `video_understanding`，与生产服务明确拒绝视频反推的边界冲突。因此 UI 测试可以通过一条生产环境必定 fail closed 的路线。
- 修复：E2E 的 Comfly 视频目录只保留 Seedance、Veo、Wan 各一个已验证代表；RelayMe 反推 fixture 保留图片 `vision + reverse_prompt`，移除视频理解声明。契约测试 `apps/renderer/src/test-mode/e2e-provider-profiles.test.ts` 直接用生产 `hasVerifiedComflyVideoSubmissionContract` 检查所有 E2E Comfly 视频项，并锁定 RelayMe 图片反推边界。
- 验证：契约 RED 为 2/2 失败，修复后 2/2 通过；生产目录/提交契约宽测 58/58、相关媒体与反推 Playwright 76/76、renderer typecheck、secret/path scan 与相关 diff-check 通过。上述仍是离线 fixture 验证，不代表任何供应商 live 请求成功。

## 2026-09-07 1.6.113 正式发布验收

- 正式版本已安装到唯一日常目录 `D:\CanvasAtelier\Canvas Atelier`。安装包为 `apps/desktop-modern/dist-builder/desktop-modern-1.6.113-formal-20260907/CanvasAtelier-Win10-11-x64-1.6.113.exe`，大小 103258689 字节、SHA-256 `A529EC4820E8B018C8ABCCB5BD94CBFB663658748311BAE5EC95DC7C3EA691AE`；正式 EXE SHA-256 为 `83EBBB815495838C7CA394AB3A122F204F0F19F7ACD5B3A8267BAF7B10E56D4D`，`resources/app.asar` SHA-256 为 `AD41775FF1754784AE80C047779B5EBCB1D23031BD391A85F32D9CDCABFC9E00`。安装器内 12 个应用载荷通过解包比对；安装目录的 EXE、app.asar、renderer 入口、MCP 和 3 个 Photoshop 文件与候选逐项同哈希。安装包与 EXE 的 Authenticode 状态仍为 `NotSigned`。
- 清理脚本先验证正式 EXE、app.asar、1.6.113 注册项和全部白名单目标，再删除 2 个空壳目录、5 个 1.6.92 至 1.6.96 旧备份、2 个旧用户快捷方式和 3 个旧用户注册项；旧 1.6.109 全机器注册键已由安装器原位更新为 1.6.113。清理前 7 个目录合计 1865448324 字节；清理后 `D:\CanvasAtelier` 只剩 `Canvas Atelier`，注册表只剩 1.6.113，公共桌面和开始菜单快捷方式均指向正式 EXE。
- CanvasForge 保持独立：`D:\CanvasForge\CanvasForge.exe` 与其 app.asar 前后 SHA-256 分别保持 `7AE6E7B125F892F8DCE446D7F3D7058728BEC00A755457246B3F6EF544DE6548`、`D8B955A89844C914C67DEA21302DBDB5778B7DB8CDDACEC2E1F152391E55DCF9`，进程未停止。真实 Canvas Atelier 项目仍存在；保存恢复门禁使用副本，源项目树 SHA-256 前后同为 `a8c96f45a3d475459fc178b13a96242cb92d22335cd841ddb9202b995571e645`。
- 多图根因包含两层：renderer 旧路径只取剪贴板首项并让批次导入在项目切换/删除后继续；桌面导入还把自动快照刷新后的同一 writer/session root 误判为“会话已更换”，第二张起可能报 `PROJECT_IMAGE_UNAVAILABLE`。生产逻辑现完整读取 FileList、有序并发校验素材、支持批次取消与 25 节点删除；桌面 bridge 以 session context、writer 和 root 身份判断真正换会话。对应桌面图片/视频 bridge 聚焦回归 44/44 通过。
- 正式安装版真实 Windows 剪贴板门禁使用 25 张 1600x1200 高熵 JPG、总计 37209274 字节：首节点 120 ms、25 张建节点 994 ms、全部图片解码 5926 ms；25/25 文件、节点、图片和位置通过。粘贴中途取消后仅保留 1 个已提交节点并可立即删除；尾部删除、中部删除、25 张批量清空、保存与重开后不回魂全部通过，系统剪贴板已恢复。
- 三类多参考图门禁在候选和安装版均通过：Agent 反推显示并解码 25/25；图片生成与视频生成按执行上限显示并解码 20/20；6、7、20、21、25 张检查点、横向滚动、末项重排和持久修订均成功。Agent 图片对话同时通过原生粘贴、`@图片1`、发送缩略图、视觉请求、回复、`novus-asset:` 读取和复制回系统剪贴板。
- 安装版 MCP 零费用链通过：14/14 工具实际调用，图片任务完成/取消、媒体导入、视频生成、图片反推、结果持久化、正常关闭和重启读取均成功；网络尝试为 0，隔离目录全部清理。明暗主题正式 UI、10 个正式节点、图片/视频控制栏和 Agent 反推布局也通过；真实项目副本的稳定点保存、退出和重开保持 revision 269、31 个节点、25 张图片和 1 个视频。
- 全量源码证据：最终 Vitest 为 225 个文件通过、2 个按设计跳过，2990 项通过、2 项跳过；全工作区 typecheck、生产 build、NSIS 打包和 164/164 Playwright 通过。供应商隔离工具补齐当前版本/正式路径、JPEG 剪贴板文件和旧版 Comfly 加密配置兼容，相关 Node 回归分别为 20/20 与 12/12。
- Comfly 当前只读 live 状态为 `configured=true`、`locked=false`、连接 `connected`，返回 866 个 profile，其中生图 32、视频 18、视觉/反推 146；正式 UI 的生图、视频、反推选择器均为非空且只含 Comfly 路由。`doubao-seedance-2.5`、`wan2.2-t2v-plus`、`veo3.1` 均被识别为完整 `video_generation + async_tasks`。本轮没有提交付费任务；历史 2 参考图 Nano Banana 失败为上游 `ERR_CONNECTION_CLOSED`，1.6.113 已将同步等待放宽到 300 秒并禁止超时自动重试，仍需下一次用户主动生成验证供应商最终产物。
- RelayMe 代码和安装包的文生图、文生视频、图片画布反推、图片对话反推都已通过单元/零费用 fixture 与安装版桥接门禁；参考图生图、视频素材输入、视频反推和远端取消在没有已验证契约时继续提前拒绝。当前只读 live 连接明确返回 `authentication_failed`，profile/task 读取返回 `CREDENTIALS_LOCKED`，因此 live 行保持 BLOCKED；用户重新网页登录后，才能执行并验收四条真实供应商请求。本轮未消耗 RelayMe 或 Comfly 额度。

## 2026-09-08 1.6.114 启动、Agent、供应商与正式安装验收

- 启动卡顿包含两个串行阻塞：最近项目采用前同步等待 recovery 扫描，以及 durable project 采用前等待 25 张受管图片的完整性读取。当前真实项目启动前有 451 个 recovery session、20786 个文件、291723764 字节；旧 1.6.113 的 31 节点画布约 24049 ms 才可用。1.6.114 先采用 durable canvas，把 recovery refresh 和媒体完整性校验移到后台；正常最近项目与孤儿恢复仍保持不同路径，恢复数据不会静默覆盖正式项目。
- recovery mirror 现在为每个新会话写入 `session.json`，也能通过完整 candidate 记录验证旧版会话；每个 projectId 只保留当前会话和最新两个已验证旧会话。未知、损坏、符号链接或 reparse 数据保持不动，清理失败也不影响已找到的恢复结果。真实正式目录验收中，workspace 665 ms、31 节点且保存态可交互 785 ms、Fit View 响应 915 ms，后台剪枝 27438 ms 完成；451 个会话剪到 3 个，删除 448 个，项目 stable revision 仍为 269，正常关闭后 `cleanClose=true` 且无 project lock。当前项目 recovery 从 291723764 字节降到 5162280 字节。
- 独立离线启动门禁复制同一 31 节点项目，预置 5 个合法会话和 1 个未知损坏会话：workspace 602 ms、画布采用 687 ms、DOM 可交互 1722 ms、后台剪枝 18322 ms；合法会话最终为 3 个，未知目录保留，源项目树 SHA-256 前后同为 `390757653467269373426b3278e69b63780e77825eb69a2f1330bee4d1c5f8d5`，页面错误为空且隔离目录已清理。报告为 `work/qa-installed-startup-recovery-1.6.114-run2/report.json`。
- Agent 普通聊天由 provider 在 180 秒主动取消，视觉请求保持 300 秒；renderer 分别在 195 秒和 315 秒显示超时。完全相同的失败请求重试会复用原用户消息并避免向 provider 历史重复追加，编辑后的请求仍建立新回合。Codex CLI 的 MCP 初始化、握手、transport closed 等错误映射为稳定 `CODEX_CLI_MCP_FAILED`，界面不再只显示通用 CLI 失败，底层私有诊断不会泄漏。
- 正式安装版真实 Windows 剪贴板再次使用 25 张 1600x1200 高熵 JPG、总计 37209274 字节：首节点 119 ms、25 张建节点 1005 ms、全部解码 5961 ms；中途取消残留的 1 个已提交节点可删除，尾部、中部和 23 张批量删除均成功，保存和重开后节点数仍为 0，系统剪贴板已恢复。Agent 图片聊天的原生粘贴、`@图片1`、缩略图、`novus-asset:` fetch、复制反馈和 1x1 PNG 原生剪贴板回读也通过。
- 当前真实项目副本的保存门禁保持 revision 269、31 节点、37 连线、25 张图片和 1 个视频；显式保存观察到 `saved -> saving -> saved`，两次干净关闭均移除 lock 并写入 clean-close，重开内容一致，正式离线网络守卫两次握手均为 0 次网络尝试，原项目树未被该门禁修改。
- 安装版零费用执行门禁通过：14/14 bundled MCP 工具实际调用；图片完成与取消、媒体导入、选择删除、确认、保存重启、视频完成和图片反推均通过，结果与任务身份持久化；所有 fixture 的 `networkAttemptCount=0`，没有真实 provider 任务或费用。图片生成、视频生成和反推节点的 25 路连接门禁也通过：反推显示 25 张，图片/视频执行槽保留并解码前 20 张，滚动和重排成功。
- Comfly 正式安装版只读 live 验收为 `configured=true`、`locked=false`、connection `connected`；目录 866 个 profile，其中生图 32、视频 18、反推 146，三个正式 UI 选择器均有 Comfly 路由。本轮没有提交真实生图、视频、反推或聊天任务，所以不能把目录和 fixture 结果写成付费生成成功。
- RelayMe 正式安装版只读验收为 `configured=true`、`locked=false`，但 connection 明确返回 `authentication_failed`，`listProfiles` 返回 `PROVIDER_UNAVAILABLE`，正式 UI 因此没有 RelayMe 生图路由。代码、client、bridge、图片对话反推与零费用执行门禁通过；当前剩余阻塞是 2026-09-06 登录会话已经失效。必须由用户重新完成 RelayMe 官方网页登录，再分别提交低成本文生图、文生视频、图片画布反推和图片对话反推，才能把 live 行标为通过。
- 唯一正式安装已覆盖到 `D:\CanvasAtelier\Canvas Atelier`，注册表只剩 `Canvas Atelier 1.6.114`，公共桌面和开始菜单快捷方式都指向该 EXE；`D:\CanvasAtelier` 只剩 `Canvas Atelier`。首次静默安装的未正确引用 `/D=` 参数曾产生 `D:\CanvasAtelier\Canvas`，后置路径检查立即发现并用带引号参数重装，空壳经白名单和正式身份验证后删除。`D:\CanvasForge` 未停止、未修改、未删除。旧 `desktop-modern-1.6.113-formal-20260907` 构建副本已删除，只保留 1.6.114 正式构建目录。
- 正式安装包为 `apps/desktop-modern/dist-builder/desktop-modern-1.6.114-formal-20260908/CanvasAtelier-Win10-11-x64-1.6.114.exe`，大小 103260348 字节、SHA-256 `0FA51B19C90CC814CBDE4C77E889EFAF2BB447028E10E4732F52E0A8716C48C2`；EXE SHA-256 `6D0F4FA5E33F5AEE4A5372D3AF72CBD99D93394C6AFEBCCFA1C59525072633DE`，app.asar SHA-256 `DDC5B768E914297A638EDE532E7D2E6EBE1907C9C1730B5B639F4270AB46903A`。安装器解包的 12 个应用载荷通过比对；安装目录的 EXE、app.asar、renderer、MCP 和 3 个 Photoshop 文件与候选逐项同哈希。安装包和 EXE 的 Authenticode 仍为 `NotSigned`。
- 最终验证：完整 Vitest 225 个文件通过、2 个按设计跳过，2999 项通过、2 项跳过；全工作区 typecheck 和生产 build 退出 0；QA helper Node 回归 66/66、安装占用边界 8/8、cleanup safety contract、NSIS 打包、12 文件 payload 比对及安装后哈希门禁均通过。不要用这些离线与只读结果替代外部供应商真实付费产物证据。

## 2026-09-08 生图结果缺少尺寸导致 durable commit 失败

- 根因：正式生图结果可以只返回 `assetId`；`job-store` 把缺失的 `width`/`height` 作为自有 `undefined` 属性写入正式生图节点的 `resultWidth`/`resultHeight`。模块配置保留这些属性，JournalWriter 在写入 revision 前对完整 commit request 执行 `sha256Canonical`，因此抛出 `canonicalJson only accepts JSON-safe finite values`，renderer 最终只得到 `DURABLE_WRITE_FAILED`，生成素材虽已落盘但节点结果未提交。
- 修复与保护：正式生图结果仅在对应尺寸为有限正数时写入 `resultWidth`/`resultHeight`；缺失或无效尺寸省略字段，正常的有限正数尺寸仍原样保留。没有修改供应商协议、Photoshop、版本或 JournalWriter。
- TDD 与验证：`apps/renderer/src/jobs/job-store.test.ts` 新增缺尺寸 materialization 回归，使用 JournalWriter 同形状的 commit request 调用真实 `sha256Canonical`。旧实现聚焦 RED 为 1/1 失败，精确指出 `resultWidth` 不应存在；修复后聚焦 1/1、job-store 43/43、保存链与 canonical/JournalWriter 宽回归 337/337 通过，`npm.cmd exec -- tsc -p apps/renderer/tsconfig.json --noEmit` 退出 0。

## 2026-09-08 MCP 受信任媒体选择器前台与真值修复

- 旧候选的真实根因不是 MCP 请求未送达。安装版隔离 QA 将 Canvas Atelier 原生窗口最小化后，经 bundled stdio MCP 调用 `canvas_import_media`，Playwright 确实捕获了 `filechooser`，工具也返回 `pickerOpened=true`；但事件瞬间窗口仍为 `visible=false`、`minimized=true`、`focused=false`。因此选择器可能藏在后台，旧实现却把 fire-and-forget 的 `input.click()` 无条件报告为已打开。RED 报告为 `work/qa-installed-mcp-trusted-picker-focus-1.6.115-pre-rebuild/report.json`。
- 修复在桌面 MCP bridge 转发交互请求前恢复、显示并聚焦 Canvas 窗口，异步有界等待可见、非最小化且已聚焦；renderer 再有界等待 `document.visibilityState=visible` 与 `document.hasFocus()` 后发起受信任 file input。workspace adapter 只有在 renderer 确认接收选择器请求时才返回 `pickerOpened=true`，否则分别返回 `MCP_INTERACTION_UNAVAILABLE` 或 `MEDIA_PICKER_NOT_OPENED`。MCP server 指令也明确禁止在错误响应后声称选择器已打开。
- TDD 与当前源码验证：workspace adapter 与 main-to-renderer bridge 的 RED 共 3 项，分别证明旧实现假成功、未调用前台准备、准备失败仍转发；MCP 指令 RED 证明旧文案会诱导假报告。修复后相关 Vitest 3 文件 33/33 通过，desktop-core、renderer、desktop-modern、desktop-legacy TypeScript 检查均退出 0。新离线 helper `work/qa-installed-mcp-trusted-picker-focus.mjs` 只使用隔离 QA root 和 bundled MCP stdio，取消 filechooser 后要求 revision 与节点 ID 完全不变；生产候选重建后必须复跑该门禁再关闭安装版行。

- 2026-09-08 continuation: the source implementation was recompiled and an isolated Electron-builder unpacked candidate was created at `apps/desktop-modern/dist-builder/desktop-modern-1.6.115-picker-20260908/`. Candidate identity is version `1.6.115`, app.asar SHA-256 `5cd104ab362845d98b876cc3733ed028e815d67cd1b87bef1818ceec65afed4f`, EXE SHA-256 `4bc090e439f29ef6c39c1ac02458fafe01c6757fed618eefa946843ea8d0f487`; `dist/main.cjs` matches the compiled source and contains the foreground preparation/interaction guard. Focused MCP, workspace adapter, server, runtime and packaging tests passed 53/53; QA helper contract passed 3/3; full typecheck and production build passed. The fresh installed Electron focus runner was attempted against this candidate but automatic elevated execution was rejected after the approval usage limit was reached, so the actual minimized-window/filechooser foreground state remains unverified. Existing daily Canvas Atelier processes were left running.
- 2026-09-08 resumed verification: after the execution policy changed, the same candidate passed `work/qa-installed-mcp-trusted-picker-focus.mjs` with exit code 0. The precondition was `visible=false,minimized=true,focused=false`; when the real filechooser fired, native state was `visible=true,minimized=false,focused=true`, and MCP truthfully returned `pickerOpened=true`. Cancelling preserved revision 0 and the empty node set; requested network calls were 0 and the isolated root was removed. Fresh report: `work/qa-mcp-picker-focus-1.6.115-repacked-20260908/report.json`. This closes the unpacked-candidate picker gate only; it does not establish a fresh NSIS installer or formal installed-directory acceptance.
- 2026-09-08 formal 1.6.115 continuation: full Vitest passed 225 files / 3039 tests with 2 designed skips; full Playwright initially exposed 2 stale mode assumptions, then the corrected targeted files passed 12/12. The source fixture tests were updated so provider chat scenarios explicitly choose 对话 and Codex scenarios supply the local Codex catalog; no production behavior was weakened. Secret/path scan, diff check, installer process boundary (8/8), candidate MCP 14-tool chain, candidate video/reverse chain, and installed image chat/model/filter gates passed. NSIS installer `apps/desktop-modern/dist-builder/desktop-modern-1.6.115-formal-20260908/CanvasAtelier-Win10-11-x64-1.6.115.exe` is 103263177 bytes with SHA-256 `903cc7faeb1167aa8ef8f07d642b92e34150a4792952db9829768b5a79521cce`; payload verification matched 11 files and installed `app.asar`/EXE identity. Installed picker focus passed with foreground state `visible=true,minimized=false,focused=true`; installed save/reopen preserved revision 272, 31 nodes, 37 edges, 26 images and 1 video, with unchanged source tree hash and zero network attempts. Photoshop installed smart-object QA fail-closed at the initial snapshot because one pre-existing user Photoshop document was open; it did not create, activate, modify, or close that document. The installer handled the two exact bundled MCP background processes through its existing process guard; final inspection found no Canvas Atelier processes remaining and only the 1.6.115 uninstall entry. CanvasForge executable and app.asar hashes remained unchanged. Authenticode remains `NotSigned`; live provider generation and real Photoshop placement remain unverified/blocked.

## 2026-09-08 1.6.116 Agent 创作、保存与在线更新发布

- Codex CLI 支持 ChatGPT 登录和 API Key 两种认证，界面现在直接说明两条路径并把 401/无效凭据映射为重新认证提示。当前机器的缓存 API Key 经最小真实请求返回 401，因此本机 live Codex 行仍需重新登录或更新 Key；未把本地 CLI 已安装误报为真实请求成功。
- 创作 Agent 固化为方案优先流程：分析后给出方案，选择后显示对勾、深色选中态和 `aria-pressed`，确认卡片滚动到视口中部，主操作写明“确认并新建节点”。每次图片/视频确认都创建独立 `agent-image-*` / `agent-video-*` 节点，不再复用选择节点或画布唯一同类节点。
- 生图状态使用同节点最新任务；旧失败不会覆盖更新成功。只有 completed 任务确实持有结果资源才宣称结果已回写，否则明确提示结果尚未回写。画布节点创建或启动保存失败会把真实 `saveErrorCode` 传给 Agent。
- 首个新候选复现了 Windows 原子目标重命名的短暂 `PERMISSION_DENIED`。`writeAtomic` 仅对目标 rename 的 `EPERM`/`EACCES` 做 20/60/140/280 ms 有界重试；其他错误不重试，持续权限拒绝在重试耗尽后仍返回标准错误并保留恢复候选。修复后候选连续三轮和最终轮通过。
- 最终候选完成方案选择、确认可见、独立节点创建、提交、结果缩略图、保存和重启持久化，页面错误为空，真实项目未触碰，付费调用为 0。聚焦回归 591/591；恢复契约 92/92；完整 Vitest 225 文件通过、2 文件按设计跳过，3047 项通过、2 项跳过；全工作区 typecheck、production build、NSIS 打包和 12 文件 payload 比对通过。
- v1.6.116 已发布为 GitHub latest：`https://github.com/19960726/canvas-atelier/releases/tag/v1.6.116`。安装包 103264076 字节，SHA-256 `51326f57f087ec452edd1b04b5d076fe50236539148d9a9cb3960f78ae02a094`；blockmap 与 `latest.yml` 线上摘要、大小均匹配本地产物。
- 带有效 feed 配置的 1.6.114 真实发现并下载 1.6.116。当前正式 1.6.115 首次检查失败的根因是其安装目录缺失 `resources/app-update.yml`；补入与 1.6.116 相同的 136 字节配置后，正式 1.6.115 真实到达 `ready_to_restart`，下载包同 SHA-256。没有调用重启安装，也没有关闭用户现有进程。其他缺少该文件的 1.6.115 用户需从 Release 页面手动安装 1.6.116 一次；1.6.116 包内已包含配置，后续可应用内更新。
- 仓库仍是大量既有改动混合的受保护工作树；没有批量暂存或提交。Release 标签沿用现有提交，因此自动 Source code 归档不是安装包完整源码快照。安装包仍无 Authenticode 签名，真实外部 provider 付费生成未执行。
- 用户明确要求正式版后，最终安装包以退出码 0 写入唯一日常目录 `D:\CanvasAtelier\Canvas Atelier`。正式 EXE SHA-256 `9DAC45FBBFCBDEC58ACBBCB32C84D0F68BD302B7284B2287EE9E7BA970FA14E3`，正式 app.asar SHA-256 `C28F8602A471170CAB39B749583BDA845F40F93D862D5184835F4C32EDCE9BCF`，版本 1.6.116；正式目录 12/12 个应用载荷与最终候选同哈希并包含 `resources/app-update.yml`。
- 正式 EXE 的创作 Agent 全链再次通过：方案选中与确认可见、新建独立 `agent-image-58f99999-8e16-44eb-9466-6b8bd2efd8dc` 节点、一次任务提交、返图缩略图、保存、关闭重启后节点/提示词/结果保持，页面错误为空、真实项目未触碰、付费调用为 0。正式 1.6.116 使用真实 GitHub feed 检查后返回 `No updates are available.`，确认当前正式安装已识别自己为 latest。
- 正式安装版完整零费用 MCP 门禁通过：14/14 工具实际调用，方案确认、图片任务完成与取消、结果资源持久化、媒体导入、删除、保存、关闭重启读取全部通过；隔离网络尝试为 0，隔离目录已清理。报告为 `work/qa-installed-mcp-zero-cost-full-chain-1.6.116-formal.json`。

## 2026-09-08 1.6.117 创作方案全宽正式版

- 用户在正式 1.6.116 截图中指出创作方案和确认卡只占左侧很小宽度。根因是微信式消息的终端样式把所有消息设为 `width: fit-content` 和 `max-width: 78%`；方案内部即使有卡片样式，也只能继承这块收缩宽度。
- 创作方案 assistant article 增加专用 `skill-chat-workbench__message--creative-plan` 类。终端 release contract 将该消息、`.creative-plan`、每个 `.creative-plan__option` 和 `.skill-chat-workbench__confirmation` 设为完整可用宽度，确认主按钮随栅格横向扩展。
- UI 红测先以 2 项失败证明旧 DOM 类与宽度契约缺失，修复后相关 188/188、版本/样式/Agent 聚焦 208/208 通过。完整 Vitest 为 225 文件通过、2 文件按设计跳过，3047 项通过、2 项跳过；全工作区 typecheck、production build、NSIS 打包和 12 文件 payload 比对通过。
- 候选与正式安装版量化结果一致：messages 492px、creative plan 488px、confirmation 488px。正式 1.6.117 创建独立 `agent-image-554bdd15-6aab-4339-b71c-4d645a15694e` 节点、返图、保存、关闭重启后节点/提示词/结果保持，页面错误为空，真实项目未触碰，付费和 provider 网络调用为 0。
- 正式安装器退出 0 并写入 `D:\CanvasAtelier\Canvas Atelier`。正式 EXE SHA-256 `1f13baef0468d254518257c4d7a95cc46f4083e6edd10b4eff35cc4dfbd6fcd8`，app.asar SHA-256 `3a2097b52f6b53fc01da7e36a47f51cd6fa6f00ae7d8df56ebab67e76d22639a`，12/12 载荷与最终候选一致。
- v1.6.117 已发布为 GitHub latest：`https://github.com/19960726/canvas-atelier/releases/tag/v1.6.117`。安装包 103264181 字节，SHA-256 `db9d7a45bdb3ded9b6f272184c9a22e42cecc85d2684318b90e9cfdb883ac211`；blockmap 与 latest.yml 线上摘要和大小匹配。本地旧正式客户端真实发现并下载 1.6.117 到 `ready_to_restart`，下载包同 SHA-256；正式 1.6.117 检查后返回无更新。
- 正式 1.6.117 的 bundled MCP 零费用门禁再次实际调用 14/14 工具，图片任务完成与取消、结果资产、媒体导入、选择删除、保存和重启读取全部通过；provider 网络尝试为 0，QA 隔离目录已清理。
- Release 标签仍使用已有远端提交；自动 Source code 归档不是本地混合工作树的完整源码快照。安装包仍未做 Authenticode 签名，真实付费 provider 请求未执行。

## 2026-09-08 1.6.118 Codex API 模式调用画布

- Codex 画布调用保留真实用户的 provider、API Key 和 Base URL 配置，不再使用会覆盖第三方 API 路由的 `--ignore-user-config`；运行时读取已配置 MCP 名称，仅动态禁用其他 MCP，保留 `canvas_atelier`。
- Codex MCP 调度启用 `code_mode_host` 与 `unified_exec`，画布 MCP 使用官方支持的独立 `default_tools_approval_mode=approve`，同时保持只读 sandbox、`approval_policy=never`，并由画布应用继续控制付费生图、媒体导入和危险操作。
- Codex 事件解析忽略正常的 `item.started`，仅把完成事件作为结果；一次 `PROJECT_REVISION_CONFLICT` 只有在重新读取画布并成功重试同一工具时才接受，其他失败仍拒绝并不采用后续文本。
- 最终 1.6.118 候选真实 API 模式验收通过：Codex 0.153.4 实际调用 `canvas_atelier`，新建两个独立节点、更新、移动、连线并最终读取确认，revision 从 0 到 5；没有执行生图、没有触碰用户项目，Codex 配置前后 SHA-256 相同。
- 最终候选完成 31 节点项目保存、关闭、重启和重新打开，原项目树 SHA-256 未改变；全量 Vitest 225 个文件、3053 项通过，2 项性能测试按配置跳过；全工作区 typecheck、production build、NSIS 打包和 12 文件 payload 比对通过。
- 正式安装器为 `apps/desktop-modern/dist-builder/desktop-modern/CanvasAtelier-Win10-11-x64-1.6.118.exe`，103265789 字节，SHA-256 `8349B38F3DE030EA5228DCE3DA84D9A0688C528FC36073A76BE6A705EC8DDB88`。v1.6.118 已发布为 GitHub latest：`https://github.com/19960726/canvas-atelier/releases/tag/v1.6.118`。

## 2026-09-09 1.6.119 生图、Agent 路线与保存恢复正式候选

- “连接成功但 API 生图失败”的主要根因在能力分类与请求契约，不是画布连线本身。Comfly 现在只对精确官方 Gemini 生图模型 ID 启用原生参考图路由：`gemini-3.1-flash-image-preview` 及其 `-512px`、`-2k`、`-4k` 变体；引用图按供应商已验证的 `image` 数组提交，原生尺寸映射与模型能力缓存同时修复。缺失或不完整的能力信息继续 fail closed，不再把相似名称、大小写或别名误判成可执行模型。
- 生图执行会把受管结果写回当前任务和历史记录；Agent 则在用户选定方案、模型、比例、分辨率、张数和参考图后，原子创建新的独立生成节点。方案卡与确认卡使用对话区完整宽度，选择按钮居中且有明确选中态；固定路线不会在节点挂载时被默认模型覆盖，提示词、参数、引用、route 和结果在保存、关闭、重启后保持一致。
- 图片编辑只向 `image_edit` 或 Gemini 原生图片路线传递参考图。视频节点与 Agent 共用同一个精确输入能力判定，覆盖已验证的 WAN、Seedance 和 Veo 文生视频、图生视频与首尾帧数量边界；只有已有目录证据证明当前输入不兼容时才清理旧路线，目录为空、未配置或加载中会保留已保存选择，避免仅打开项目就产生无关草稿修订。
- 最近项目元数据写入改为串行化。可用性和预览路径的文件状态检查共用有界队列，超时请求会从队列移除，已开始的检查在真正结束前继续占用槽位；最近项目索引本身不再排在可能失效的 UNC、映射盘或本地路径检查之后，因此坏路径不会饿死保存、历史刷新或关闭落盘。
- 最终源码验证为 Vitest 225 个文件通过、2 个性能文件按设计跳过，3103 项通过、2 项跳过；全工作区 typecheck、production build、secret/path scan 与 diff-check 通过。NSIS 正式候选的 12/12 应用载荷、8/8 安装进程边界及真实编译钩子通过。
- 最终候选安装包 103269060 字节、SHA-256 `65900D5B82D616715DA89D5481374A4459B82047D780BC1A1C751DA40BB1434A`；blockmap 109651 字节、SHA-256 `42081D08F5B9972AAC967D07DEECD5A81B1A578DB6BEAFA4EEF53D29F6EB9F25`；`latest.yml` 375 字节、SHA-256 `A9C544E526C057F0FF4FBD052D7CE65B0641E459739DD4885B64623C343A5C27`。候选 EXE SHA-256 `9F4B2AB06905B912B8B5445FB80795CDF503879E896ADCD03736D74BD8755F75`，`app.asar` SHA-256 `F2E70077414027F0BAD0B55394CB22A6BB1BB4AED044125F4CAD05988B3ADF46`；安装包仍为 `NotSigned`。
- 零费用候选验收中，方案、确认、独立节点、返图缩略图、保存与重启恢复通过；手选 `qa/image-edit` 后提交、节点与重启 route 完全一致，Provider 网络请求和付费调用均为 0。31 节点真实项目副本显式保存为 `saved -> saving -> saved`，稳定点保持 revision 304，原项目树前后 SHA-256 同为 `b364afbcfbf1906e95cbf09faca97cd03441a8a4b6396726f0cb4ef04c9b0c9a`。bundled MCP 14/14 工具在隔离环境完整执行，创建、更新、移动、连线、确认、运行、取消、媒体导入、删除和重启读取全部通过，网络尝试为 0。
- 本轮只读核对了 Comfly 当前公开模型目录和已验证提交端点，没有发送真实生图、视频或反推任务，也没有消耗供应商额度。目录连通和零费用 fixture 证明路由与落盘链路，不等于真实供应商产物成功。
- v1.6.119 已发布为 GitHub latest：`https://github.com/19960726/canvas-atelier/releases/tag/v1.6.119`，非草稿、非预发布，tag 指向 `2860617c9b001634eb8cea1a7d681b601f89d8d9`。线上安装包、blockmap 和 `latest.yml` 的大小与 SHA-256 均和本地最终产物一致。
- 日常安装的 1.6.118 通过真实 GitHub feed 发现 1.6.119 并下载到 `ready_to_restart`；下载包 103269060 字节、SHA-256 `65900D5B82D616715DA89D5481374A4459B82047D780BC1A1C751DA40BB1434A`，没有调用重启安装，原 EXE 与 app.asar 前后哈希不变，隔离下载缓存已清理。报告为 `C:\Users\ADMINI~1\AppData\Local\Temp\canvasforge-qa-github-update-119-evidence-20260909-030809\report.json`。
- 当前执行会话不是提升权限；普通启动和 `RunAs` 两次都在 NSIS 真正启动前收到 Windows“操作已被用户取消”，因此日常目录仍诚实标记为 1.6.118，没有宣称 1.6.119 installed QA 通过。机器上不存在 Canvas Atelier 高权限计划任务或服务；per-machine 正式安装需要用户在 UAC 中确认，不能用手工覆盖文件替代 NSIS 的进程门禁、HKLM 版本和卸载/快捷方式更新。
- 用户继续后接受 UAC，正式 NSIS 返回 0 并将日常目录升级到 1.6.119。已安装 EXE 为 225448960 字节、SHA-256 `9F4B2AB06905B912B8B5445FB80795CDF503879E896ADCD03736D74BD8755F75`；`resources/app.asar` 为 5944288 字节、SHA-256 `F2E70077414027F0BAD0B55394CB22A6BB1BB4AED044125F4CAD05988B3ADF46`，均与最终候选完全一致。安装目录 12/12 正式载荷逐项同哈希；HKLM 卸载项为 1.6.119，公共桌面和开始菜单快捷方式均指向 `D:\CanvasAtelier\Canvas Atelier\Canvas Atelier.exe`。
- 已安装版重复通过真实项目副本保存：31 节点、37 连线、稳定点 revision 304，`saved -> saving -> saved` 后关闭、重启内容不变，源项目树 SHA-256 前后同为 `b364afbcfbf1906e95cbf09faca97cd03441a8a4b6396726f0cb4ef04c9b0c9a`。创作方案和确认卡保持对话区全宽，独立节点返图、提示词和结果重启恢复通过；固定 `qa/image-edit` 路线的比例、分辨率、张数、引用和结果也全部保持，Provider 网络与付费调用为 0。
- 已安装版 bundled MCP 再次实际调用 14/14 工具，创建、更新、移动、连线、计划确认、任务完成/取消、媒体导入、删除和重启读取均通过，版本 1.6.119、网络尝试 0。正式安装再查真实 GitHub feed 返回 `No updates are available.`，确认已识别自身为 latest。
- Comfly 已安装版只读 live 检查为 `configured=true`、`locked=false`、connection `connected`，目录共 866 个 profile：生图 32、视频 18、反推 145。精确模型 `gemini-3.1-flash-image-preview` 及 `-512px`、`-2k`、`-4k` 四条路线都提供 `image_generation + image_edit`；正式 UI 图片、视频和反推路线均非空。检查只调用状态、连接和目录读取，generation submission 为 0，仍需用户主动生成一次才能确认上游真实返图。

## 2026-09-09 生图节点路线恢复与成功返图刷新

- 红色“重新配置”的根因是前端目录时序：节点已经保存了同名图片变体的精确 `modelRoute`，但目录首次只返回默认家族项时，旧回退 effect 会立即把默认项写回配置；目录刷新后精确变体即使重新出现，项目已经丢失原路线。现在 Canvas 路由集合保留节点保存的精确图片路线，节点在同名目录追上前不覆盖带有同一显示名的保存路线，目录刷新、节点重挂载和工作区重启后仍按精确 route 选中；真正不存在的旧 route 仍回退到可用模型，并在不可用时禁用提交。
- “成功但没有返图”的第一层根因是完成状态、`resultAssetIds` 和 `projectImages` 摘要可能分批到达：节点先显示完成，预览仍查旧摘要。现在只根据当前节点已经持久化的 result IDs 刷新媒体摘要，以 0/250/750/1500 ms 做四次有界尝试；摘要到达即显示返图，耗尽后明确显示“返图加载失败”和“重新加载返图”。手动重载只读取结果，不会再次提交生成或消耗额度。
- 第二层根因是 IndexedDB 模型任务队列由所有画布共享，而节点、History、Agent 结果、任务条和 MCP 过去主要按 `promptNodeId` 取任务；不同画布复用节点 ID 时会把 foreign completed/failed/running job 解释为当前结果，形成“显示成功但没有返图”、误收起编辑器、误亮历史红点或误取消任务。新任务现在持久化稳定 `projectId`；共享 selector 统一用于节点、History、Agent、JobStrip 和 MCP。旧任务仍可由当前 session、节点 `lastResultJobId` 或已持久化结果 ID 证明归属，所以模型刷新、项目重开和应用重启不会因 session 更换丢失合法结果。
- 项目切换后，job-store 只提交和轮询当前项目任务；其他项目的已提交任务保留为暂停状态，不会在无法写回当前画布时形成 750 ms 永久轮询，也不会被误取消。重新打开所属项目后，持久 `projectId` 与 durable node anchor 会恢复其轮询；启动 hydration 仍按原有安全边界取消无法证明归属的中断旧任务。
- 正式图片、视频和 Agent 生成均改为先建立 held queue job，再把完整批次 ID 写入 durable node，最后才放行 provider 提交；节点保存失败会取消 held jobs。恢复期间会先修复无锚点 generation job，completed repair 和 Agent/direct generation 在最终提交前再次校验项目、节点和 batch ownership，避免项目切换、重试或新批次覆盖后由旧任务写回当前画布。重复 asset 和多输出补齐仍以全部 result asset 已落盘、当前 job 已移出 pending 为完成条件。
- 任务条上下文污染也已收口：活动任务始终排在旧 failed/cancelled 前；终态任务只有源节点仍存在、正式生成节点仍锚定该 job，且当前草稿仍匹配原任务类型、提示词、模型路线、比例、清晰度及视频时长/音频选项时才显示。重试入口在 session 解析前、解析后和 durable binding 前重复执行同一身份校验，用户修改失败节点后不会再按旧提示词或旧模型参数提交；节点上的旧错误和失败计时也立即隐藏。字段缺失的旧任务保持兼容，多输出任务的单 job 数量不参与比较。删除源节点前后或 session 解析期间触发重试同样不会持久化永远无法执行的排队任务。项目历史仍保留，不因任务条过滤丢失。
- “成功但没有返图”的补充边界：图片节点现在同时检查 `assetId` 和受管 `displayUrl` 可渲染性。刷新期间显示“正在加载返回图片”；同 ID 摘要若只有无效/外部地址，会继续做四次有界刷新并进入明确失败，不会显示空白的“结果已就绪”。视频结果采用同样的摘要刷新、失败提示和只读手动重载；折叠态错误文字不再截获节点打开点击，重载按钮仍可单独操作。
- TDD 红测先复现 route 被覆盖、完成后摘要为空、无效返图地址、刷新失败后空白成功态、折叠错误遮挡点击、同节点 ID foreign job 污染、MCP 跨画布读取/取消、foreign running 永久轮询、删除节点后的孤儿重试、稳定项目归属缺失，以及修改失败节点后任务条仍显示旧任务、旧参数仍可重试和旧错误仍留在节点。最后一组 RED 明确得到 6 项预期失败，修复后目标 471/471 通过。最终完整 Vitest 为 226 个文件通过、2 个按设计跳过，3182 项通过、2 项跳过；全工作区 typecheck、生产 build、`git diff --check`、secret/path scan 和生图 Playwright 5/5 均通过。
- 当前最终候选为 `apps/desktop-modern/dist-builder/desktop-modern-1.6.120-image-context-return-20260909-final4`。NSIS 安装包 103272430 字节、SHA-256 `8733CA4462136C88A39DC7AFDAA398A357D8372B1F13118AB566D1B0C49F37E0`；blockmap 109750 字节、SHA-256 `403979CAC821EEA93A2392D8FB54036E62FC6CE0EF821F8B13D3B623D8548A82`；`latest.yml` 375 字节、SHA-256 `FF656C12538F18203D32F9A05127190B9B0F737AEDAF564E5C49CC6939D36085`。候选 EXE 225448960 字节、SHA-256 `5B0108D9051AAD20B0B31633C907BB5819C9BD0C84717ABDAB8C5788EE84A387`；`app.asar` 5944467 字节、SHA-256 `5E9C7089DE41A11960306341F69360C71C55694630838426FA471C79FE1FB988`；renderer `index-C5z0fGqB.js` 1223946 字节、SHA-256 `EF0244602CAB45F89477A6EE56DDCB31F4165FC8A06B858E5707057D4906324A`。安装器解包 12/12 应用载荷与 `win-unpacked` 逐文件一致；安装包和主 EXE 仍为 `NotSigned`。
- final4 候选与安装版隔离断网门禁均为 `passed`，报告分别为 `work/qa-packaged-image-route-result-1.6.120-context-return-final4/report.json` 和 `work/qa-packaged-image-route-result-1.6.120-installed-context-return-final4/report.json`：精确 `comfly-gemini-3-1-flash-image-preview-4k` 路线在目录刷新和项目重开后保持，缺失摘要显示无重复提交的恢复入口，受控本地返图成功显示并在重开后保留，页面错误为空，临时目录已清理。正式 NSIS 返回 0，唯一卸载项为 1.6.120；安装目录 EXE、`app.asar`、renderer 入口、final4 JS/CSS 和 MCP 与 final4 候选逐项同哈希。
- 安装版还通过了完整应用进程重启门禁 `work/qa-installed-mcp-zero-cost-full-chain-1.6.120-context-return-final4.json`：第一轮受控图片任务将精确 `qa/zero-cost-image` 路线、完成结果与项目 revision 12 持久化，完全关闭 Electron 和该门禁自己的 MCP 客户端后，在同一隔离根启动第二轮 Electron/MCP，3 个目标节点、结果资产、连线和导入媒体全部保持；14/14 bundled MCP 工具均实际执行，provider 网络尝试为 0，隔离根已清理。该证据与精确 Comfly 变体的 UI 门禁共同覆盖“生成后、模型刷新后、项目重开和应用重启”。
- 工作区上下文审计：根目录 3 个 `.recent-projects.index.json.tmp-*` 最后写入均在 2026-09-08，生产索引实际位于 `%APPDATA%\\Canvas Atelier\\recent-projects.index.json`；final4 安装前只有 1 个 `Canvas Atelier.exe`，命令行为精确 `resources\\mcp\\canvasforge-mcp.cjs` bridge，没有 GUI 画布进程。安装由 NSIS 自身进程门禁处理该精确 bridge，没有手动结束进程；final4 安装与隔离 QA 后最终检查没有 Canvas Atelier 残留进程。未发现临时索引或 bridge 把别的项目配置、模型目录或结果资产写入当前画布；真实污染来自共享任务队列跨项目按节点 ID 取任务，以及失败节点修改后仍允许旧任务重试，两者均已加项目归属和草稿身份守卫。残留文件均按用户要求保留，脏工作区没有 reset、clean 或删除。
- 本轮没有调用真实 Comfly/RelayMe 生图、视频或反推，也没有消耗供应商额度；隔离断网 fixture 证明应用内路线、队列、持久化、媒体刷新和显示链路，不等于上游供应商已经返回真实图片。

## 2026-09-10 MCP 视频门禁身份与能力拒绝隔离

- 1.6.122 `work/qa-installed-mcp-video-reverse-zero-cost.mjs` 的连续超时不是 durable save 竞态。零费用 Comfly profile 使用了未验证的伪模型 ID `qa-zero-cost-video`，应用在提交前按正式能力规则拒绝；诊断状态为 model jobs、submit、poll 和网络尝试全部为 0。门禁现在先断言 profile 是 0 参考图且使用已验证的 `wan2.2-t2v-plus` 身份，避免把夹具错误误报成 renderer timeout。
- 审计同时确认一个独立生产缺陷：workspace adapter 在 `canvas_run_node` 分支的 `try/catch` 中直接返回异步 `runNode()`，因此 `CAPABILITY_UNSUPPORTED` 的 Promise 拒绝绕过 catch，逃出 renderer runtime listener；preload 会把该 `unhandledrejection` 报给主进程并触发 safe mode。该分支改为等待异步结果，再由既有脱敏边界返回 `MCP_WORKSPACE_ERROR`。后续 `canvas_read_workflow` 仍可成功响应。
- TDD 证据在 `apps/renderer/src/app/App.test.tsx`：修复前聚焦测试明确失败为 approved capability rejection 而非 resolved response；修复后同一测试通过。`App.test.tsx`、`mcp-workspace-adapter.test.ts`、`mcp-renderer-bridge.test.ts`、`mcp-runtime-service.test.ts` 合计 57/57 通过；renderer TypeScript 检查退出 0；零费用门禁 helper 7/7 通过。
- 现有 1.6.122 unpacked 应用使用修正后的零费用夹具通过视频与反推门禁：视频 submit/poll/ack 为 1/1/1，反推 analyze 为 1，两者结果均持久化，网络尝试为 0，自有进程与隔离目录全部清理，真实项目未触碰。报告为 `work/qa-installed-mcp-video-reverse-zero-cost-1.6.122-final-report.json`。本轮按要求没有改版本、重建或打包，因此该安装包报告验证门禁夹具与既有运行链，不代表新的 Promise 捕获源码已经进入 1.6.122 包。

## 2026-09-10 1.6.123 多供应商、GPT 质量与返图正式验收

- 生图节点反复显示红色“重新配置”、成功无返图和跨画布上下文污染已形成同一条项目归属链：精确保存 route 在目录刷新期间不再被默认同族路线覆盖；完成结果按当前节点持久 result IDs 做 0/250/750/1500 ms 有界摘要刷新；手动重载只读不重提；任务、History、Agent、JobStrip 与 MCP 按稳定 projectId 和 durable node anchor 过滤。模型刷新、项目重开和完整应用重启门禁的 `reconfigureCount` 均为 0，受控返图可见且 resultAssetId 保持。
- GPT Image 质量从节点草稿、durable job、IPC、executor 到 provider 请求全链保存 `low | medium | high`，GPT 路线默认 `medium`。GPT 模式控制条为模型、比例、分辨率、质量、数量、生成六项同排，非 GPT 路线隐藏质量项；`high + 4K` 在项目保存和进程重启后保持。GPT Image 2 的 2K/4K 比例映射使用明确像素尺寸，避免把用户选定 4K 静默降为 1K；4K 仍按官方指南标为实验档。
- API 设置现为四个独立供应商：Comfly 与 RelayMe 保持兼容；巨轮 API 独立为视频专用，拒绝图片、反推、对话和分镜；4D AI 独立提供已证明 endpoint family 的生图、视觉反推与对话。每站点分别保存 base URL、加密凭据、连接状态、模型目录、默认模型和优先供应商；优先供应商只影响排序，不会隐藏其他已配置路线。response-only 视觉模型不会再冒充可执行反推路线，精确但不支持的保存 route fail closed，四 provider 服务均在读取媒体或传输前执行能力守卫。
- 公开只读目录证据为 `work/qa-public-provider-catalogs-20260910.json`，时间 `2026-09-09T19:15:59.694Z`，generationSubmitted=false。巨轮 `/api/pricing` HTTP 200，11 个明确 `openai-video` 模型，包括 Grok Imagine Video 1.5、MiniMax H3、Seedance 2.0 和 sd2 系列；没有把其他能力接入。4D `/api/pricing` HTTP 200，共 59 个模型；只有 `gpt-image-1` 和 `gpt-image-1.5` 明确声明 image-generation，GPT Image 2/2K/4K、Gemini 与 Grok 别名在未认证证明 endpoint 前保持 incomplete；`gpt-6-astra` 等带 imageRatio 的 chat 模型作为视觉反推候选。Comfly 公开目录 HTTP 200，共 1074 个模型，16 个明确 image-generation 项；GPT Image 2、2K、4K 和 2.5 变体的视觉证据已纳入审计。RelayMe 本轮只读账号目录为 10 offers、7 deployments，其中 5 生图、1 视频、1 文本/视觉；没有用目录可见性冒充 live 生成成功。
- MCP 付费确认现在绑定 projectId、精确 revision、公开项目状态 hash、节点、任务类型、数量、provider、精确 modelRoute 和公开配置；同 revision 内修改节点配置、边、素材或切换项目都会在消费 token 前拒绝，旧确认不能重放。最终候选门禁又发现反推 provider 可能在 MCP 25 ms 采样前直接完成，旧检测只接受 `running` 而误报 `JOB_START_FAILED`；新增先红回归后，只有新 runId 且状态为 running/completed/failed/cancelled 才视为已建立可跟踪任务，旧 runId 和启动前 reject 仍 fail closed。
- 最终源码验证：全 workspace typecheck 与生产 build 通过；Vitest 为 234 个文件通过、2 个按设计跳过，3403 项通过、2 项跳过；最终 Playwright 166/166 通过；secret/path scan、`git diff --check` 通过，diff-check 只有现有 LF/CRLF 提示。独立审查无 P0/P1。
- 正式候选为 `apps/desktop-modern/dist-builder/desktop-modern-1.6.123-multi-provider-20260910-final-r2`。NSIS 安装包 103298834 字节、SHA-256 `0f2208236b78f80250cd9984cdbfe508c6df0cd24d4f25c493f8b8a6330de4ef`；候选 EXE 225448960 字节、SHA-256 `6233bd344a8e054fa7e9af98887e6c3859671122e88d235eae64a1e725311b2e`；`app.asar` 6018550 字节、SHA-256 `ffe8040d88d52b288d4782f351ebc3855f574d4651a0f2dd210618c4d9ccd79f`。安装包与主 EXE Authenticode 仍为 NotSigned。第一次同版本 `final` 候选未含快速终态修复，明确保留为 BLOCK 证据；没有覆盖或删除。
- NSIS 已以退出码 0 安装到 `D:\CanvasAtelier\Canvas Atelier`。注册表只有一个 Canvas Atelier 卸载项且版本为 1.6.123；正式目录与 final-r2 候选 EXE、app.asar、renderer、MCP 和 Photoshop 载荷 12/12 同哈希。安装前 4 个由 Codex 启动的 bundled MCP 进程没有被手动终止；升级生命周期结束后这些旧 PID 已退出，Codex 自动拉起了 1 个新的 bundled MCP bridge。`D:\CanvasAtelier` 只保留 `Canvas Atelier` 目录。
- final-r2 候选和正式安装版均通过隔离断网门禁：四供应商卡、GPT `high + 4K`、进程重启、精确 route、返图显示、目录刷新、项目重开、MCP 14/14 工具、图片完成/取消、视频 submit/poll/ack、反推完整结果、媒体导入、删除、重启读取、10 类正式节点和明暗主题布局全部通过；页面错误为空，provider 网络尝试为 0，QA 自有进程和隔离根均清理。报告位于 `work/qa-installed-gpt-multi-provider-1.6.123-installed/report.json`、`work/qa-packaged-image-route-result-1.6.123-installed/report.json`、`work/qa-installed-ui-and-nodes-1.6.123-installed/result.json` 与身份报告 `work/qa-release-1.6.123-installed-identity.json`。
- 本轮没有提交真实 Comfly、RelayMe、巨轮或 4D 生图、视频、反推任务，也没有消耗供应商额度。公开目录、安装版能力守卫、精确 payload 和隔离零费用 fixture 均已验证；真实上游账号鉴权、计费、任务队列和最终返图仍需用户主动发起一次低成本任务后单独验收，不能把零费用门禁写成 live provider 成功。

## 2026-09-10 1.6.124 Comfly 官方协议与安装目录复测

- Comfly 官方 Apifox 文档确认其接口采用 OpenAI 兼容 `/v1` 与 Bearer 鉴权；模型目录为 `GET /v1/models`，GPT Image 2 生图为 `POST /v1/images/generations`。异步提交使用查询参数 `async=true`，首次响应允许只有 `task_id`；查询端点为 `GET /v1/images/tasks/{task_id}`，状态包含 `IN_PROGRESS`、`FAILURE`、`SUCCESS`，成功图片可能位于嵌套的 `data.data.data[]`。文档审计记录为 `work/qa-comfly-apifox-doc-audit-20260910.md`。
- “用户看到成功但没有返图”的 Comfly 协议缺口已用 RED 回归复现并修复：仅含 `task_id` 的提交响应现在归一为 queued；轮询识别官方大写状态与嵌套结果；`async` 只放查询参数，不再写入 JSON；GPT Image 2/2.5 请求不再发送 UI 档位字符串 `4K` 和额外 `aspect_ratio`，而是按所选比例映射为官方要求的 16 倍数精确像素尺寸。16:9/9:16 的 4K 分别为 3840x2160/2160x3840，方形 4K 为 2880x2880。
- Comfly 公开模型目录中的六个精确 GPT Image 2.5 路线 `flare`、`flare-2k`、`flare-4k`、`sunburst`、`sunburst-2k`、`sunburst-4k` 不再被 UI 的通用 GPT 家族折叠为单个 GPT Image 2；模型选择器分别显示友好名称。设置页新增 Comfly 官方 API 文档入口。4D 网站保持 `https://api.4dai.cc`、API base 保持 `https://api.4dai.cc/v1`；巨轮网站保持 `https://julun.cc`、API base 保持 `https://julun.cc/v1`，且巨轮继续只接视频能力。
- 源码验证通过：完整 Vitest 为 234 个文件通过、2 个按设计跳过，3420 项通过、2 项跳过；全 workspace typecheck、生产 build、secret/path scan 通过；相关图片执行、参数适配、多供应商目录和 Agent 重试 Playwright 为 12/12；安装 QA helper 回归为 19/19。测试遵循先添加失败回归、再修改实现。
- 1.6.124 候选位于 `apps/desktop-modern/dist-builder/desktop-modern-1.6.124-comfly-apifox-20260910-final-r2`。NSIS 安装包大小 103299826 字节、SHA-256 `1245E19EFBCF372299ABC4E86ED12DFB2B02149121E246E75ADDD2690B3C3860`；候选 EXE SHA-256 `D42189037FC5016669AB677D05A2C0A1C6B4BDFCF15C8246818BF276C3A71ADC`；`app.asar` SHA-256 `C2CE7D34F55FADC4C5B969984BE8C18907D856D9345C923FF5C4C362E3BD4C16`。安装包和主 EXE Authenticode 均为 NotSigned；12 文件包载荷门禁通过。
- Windows 在 NSIS 提升授权阶段返回“操作已被用户取消”，所以安装器没有刷新 HKLM 卸载信息；注册表仍显示 1.6.123。随后使用先备份、再逐文件校验的日用目录原位部署，将候选的 12 个应用载荷写入 `D:\CanvasAtelier\Canvas Atelier`；复核 12/12 哈希一致，实际应用版本为 1.6.124。备份为 `work/qa-installed-backup-before-1.6.124-manual-deploy-20260910-r2`，身份报告为 `work/qa-release-1.6.124-installed-identity.json`。此证据只证明应用载荷已更新，不把它记为 NSIS 正式安装成功；卸载项版本会保持旧值，直到一次获得 UAC 授权的 NSIS 安装完成。
- 日用目录隔离断网复测全部通过：四供应商设置卡和 Comfly 文档入口存在；4D GPT Image 2.5、巨轮视频专用边界、GPT `high + 4K` 保持；模型刷新和完整应用进程重启后红色“重新配置”计数为 0；受控返回图片可见，目录刷新和项目重开后精确 route、result asset 和图片均保留；10 类正式节点与明暗主题页面错误为 0；bundled MCP 可连接。对应报告为 `work/qa-installed-gpt-multi-provider-1.6.124-comfly-apifox-installed/report.json`、`work/qa-packaged-image-route-result-1.6.124-comfly-apifox-installed/report.json` 和 `work/qa-installed-ui-and-nodes-1.6.124-comfly-apifox-installed/result.json`。
- 当前由 Codex 维持的 4 个 `Canvas Atelier.exe ... resources\\mcp\\canvasforge-mcp.cjs` 进程均来自同一个 Codex 父进程，是 per-user 本地 stdio MCP bridge，不是 QA GUI 残留。其他 Windows 用户可以在自己的账户安装/运行画布、配置自己的 MCP 客户端和供应商凭据后调用；它不是默认开放给局域网或云端用户的公共 API。本轮没有第二个 Windows 用户或第二台机器的实机验证。
- 本轮只做公开目录读取与隔离零费用传输/持久化门禁，没有发送真实供应商生图、视频或反推请求，也没有消耗额度。官方协议、客户端解析和画布返图链已经覆盖；真实 Comfly 账号鉴权、计费队列与最终上游图片仍需用户主动发起一次低成本请求后单独验收。

## 2026-09-10 推理强度、Photoshop 等比导入、清晰度与旧项目恢复源码检查点

- 按计划 1+2+3+4+6 完成源码实现。对话与创作 Agent 现在按模式分别保存模型推理强度；反推节点和 Agent 反推增加快速、标准、深度三档，并把选项送入供应商协议或系统指令。设置页增加 Codex CLI 与 MCP 能力诊断，只显示模型数、最高推理档、runtime/客户端状态和修复动作，不显示可执行文件路径、配置路径、密钥或底层错误原文。
- Photoshop 导入的缩放根因是 `Math.min(1, canvasW/layerW, canvasH/layerH)` 禁止小图放大；脚本现按画布与素材比例求统一缩放因子，横图、竖图、大图和小图都保持原比例、完整落在画布内并居中。直接导入失败回退不再先残留一次 duplicate 再走剪贴板，保证一次操作最多生成一个智能对象，并在失败时关闭临时源文档、恢复目标文档。脚本和 Windows adapter 回归覆盖等比几何、单图层、无剪贴板回退与异常清理；本轮没有修改或关闭用户当前 Photoshop 文档，也没有执行真实 COM 写入。
- 生图 2K 问题的根因有三类：显式 4K 在不支持时被静默适配为 2K；完整供应商模型缺少 resolution contract 时仍展示虚假的 2K/4K；同名固定 2K/4K 路线被目录去重折叠。现在显式不支持的清晰度会在提交前明确拒绝，供应商默认尺寸不再伪装为可选 K 档，固定路线按精确分辨率保留并显示 `· 2K`/`· 4K`，4D GPT 固定 2K/4K 路线使用各自精确约束。请求档位持久化为 `requestedResolution`，供应商实际返图低于所选档位时保留图片并显示请求与实际像素警告。修复了目录刷新或重启时草稿默认值把固定 4K 路线覆写成 2K 的回归。
- 旧项目打不开的根因是最近项目索引迁移只在稳定索引不存在时合并旧索引，且同 projectId 的失效新路径会压住仍有效的旧路径。迁移现在始终合并兼容索引、重定位旧根；同 ID 当前目录不可用时采用可用旧记录。项目管理区区分已打开、切换被阻止、文件不可用三种结果；损坏 journal 与损坏 snapshot 都进入恢复；手动重定位会校验目录和 manifest projectId。真实旧项目目录未被改写，本轮证据为隔离回归测试。
- 上下文污染复核覆盖项目隔离对话、模式切换后丢弃迟到响应、模型刷新后的精确路线保持、新对话、参考图归属、foreign job 过滤、项目重开和旧反推配置归一。此前共享任务队列按重复节点 ID 串项目、失败节点修改后仍重试旧参数的生产根因继续由稳定 projectId、durable node anchor 和草稿身份守卫封闭；本轮新增的每模式推理设置不会跨模式覆盖。
- 验证：完整 Vitest 为 234 个文件通过、2 个按设计跳过，3470 项通过、2 项跳过、0 失败；最新设置页聚焦回归 74/74；相关 Playwright 23/23，覆盖 Agent 图片粘贴/选择、Codex 推理、GPT 质量与 4K、图片生成返图、多供应商、Photoshop 入口和项目管理；全 workspace typecheck、最新生产 build、secret/path scan 与 `git diff --check` 均通过。Vite 只有既有的 chunk size 提示。
- 当前是基于提交 `54d3214` 的脏工作区源码检查点，版本元数据为 1.6.128。未重新打包、未安装、未发布 GitHub，也没有提交真实 Comfly、RelayMe、巨轮或 4D 付费任务；因此这些结果不能冒充安装版、在线更新、真实供应商返图或真实 Photoshop COM 已通过。根目录既有 `.recent-projects.index.json.tmp-*`、QA 记录和其他未跟踪文件均按要求保留，没有 reset、clean 或删除。

## 2026-09-10 1.6.128 推理、Photoshop、清晰度与旧项目恢复安装包候选

- 用户明确要求安装包后，使用独立输出目录生成 NSIS x64 候选 `apps/desktop-modern/dist-builder/desktop-modern-1.6.128-reasoning-ps-resolution-project-recovery-20260910`，没有覆盖既有 `desktop-modern`、旧 1.6.128 候选或历史版本。安装器为 `CanvasAtelier-Win10-11-x64-1.6.128.exe`，103303836 字节，SHA-256 `1DCD6B804609057EA4308F113E28C03D8311A1633541F449EBAA98720C00E0F3`；blockmap 109636 字节，SHA-256 `9F523AAEF4A6FB9D76B92C7250D21095BAAD38D4A85DB049A57267D6B6EEF262`；`latest.yml` 375 字节，SHA-256 `84FBF86CA5456BBE455D78CE50573B358E1904549A1EB53BB50A2BCE688AD278`。候选 EXE SHA-256 `C2D260CA1586A845B463FDE945405C1054AABE6C10BF06A6ADEFF607F24A0DB8`；`app.asar` SHA-256 `7B87C4A2AA9DDDA65A7804A44D439958E0B767D84F383F78D42FC4F44CF2244D`。
- 安装器解包后 12/12 关键应用载荷与 `win-unpacked` 逐项一致。候选 CSP 启动门禁通过，主进程退出且隔离 QA 根已清理。多供应商离线门禁在两个独立 Electron 生命周期中识别版本 1.6.128：四供应商卡、Comfly 文档、4D GPT Image 2.5/Nano Banana 2/Nano Banana Pro、巨轮视频专用边界、GPT medium 默认质量、`high + 4K`、受控返图、保存与完整进程重启均通过；两轮 `reconfigureCount=0`、页面错误 0、网络尝试 0、generationSubmitted=false、真实项目未触碰。报告为 `work/qa-installed-gpt-multi-provider-1.6.128-reasoning-ps-resolution-project-recovery-candidate/report.json` 和 `work/qa-release-1.6.128-reasoning-ps-resolution-project-recovery-package-hashes.json`。
- 安装包 Authenticode 状态为 `NotSigned`。本轮只生成并验证候选包，没有运行 NSIS 安装、没有覆盖日用安装目录、没有发布 GitHub，也没有提交真实供应商付费任务或执行真实 Photoshop COM 写入。

## 2026-09-10 v1.6.128 GitHub 正式发布

- 发布源码提交为 `3163e3483ba4e4eb5e43cb8f79a1f6f111b6b41b`，已推送到 `origin/feature/canvas-agent-mvp`。annotated tag `v1.6.128` 展开后精确指向该提交。
- GitHub Release `https://github.com/19960726/canvas-atelier/releases/tag/v1.6.128` 已设为 latest，状态为非草稿、非预发布。线上安装包 103303836 字节、SHA-256 `1dcd6b804609057ea4308f113e28c03d8311a1633541f449ebaa98720c00e0f3`；blockmap 109636 字节、SHA-256 `9f523aaef4a6fb9d76b92c7250d21095baad38d4a85db049a57267d6b6eef262`；`latest.yml` 375 字节、SHA-256 `84fbf86ca5456bbe455d78ce50573b358e1904549a1eb53bb50a2bce688ad278`。GitHub API 返回三个资产均为 `uploaded`，大小和 digest 与最终本地候选逐项一致。
- Release 使用已验证的 1.6.128 NSIS 候选；安装包仍未做 Authenticode 签名。发布不等于本轮已覆盖日用安装目录，也不等于真实供应商付费返图或真实 Photoshop COM 写入已经通过。
- 真实更新器补充验证：日用目录当前应用身份为 1.6.128，EXE SHA-256 `c2d260ca1586a845b463fde945405c1054aabe6c10bf06a6adeff607f24a0db8`、`app.asar` SHA-256 `7b87c4a2aa9ddda65a7804a44d439958e0b767d84f383f78d42fc4f44cf2244d`，与最终候选逐项一致。首次按 1.6.127 源版本启动下载门禁时因实际身份已经是 1.6.128 而在检查 feed 前安全停止，安装文件前后哈希不变；随后以实际 1.6.128 身份访问真实 GitHub feed 返回 `No updates are available.`，确认已识别 v1.6.128 为 latest。两次均使用隔离 user-data，未调用重启安装。

## 2026-09-10 1.6.129 全模型清晰度与 Agent 模式隔离

- 清晰度根因：生图卡把完整但未声明 resolution contract 的非 GPT 路线判为“供应商默认”，因此隐藏 1K/2K/4K 控件；Nano Banana、GPT Image 2.5 等同一模型族的固定 1K/2K/4K 路线也没有在选择档位时联动。执行层对完整非 GPT 路线还会丢弃界面已选择的 resolution，造成界面选择与真实请求不一致。现在所有生图模型始终显示 1K、2K、4K；按模型族合并已验证档位，选择固定档位时自动切换同供应商的精确 2K/4K 路线。已验证不支持的档位保留可见但禁用，并继续对实际返图像素做请求档位校验，避免把 1024×1024 标成 4K。新建生图节点默认选择 2K。
- 请求保护：Comfly、RelayMe、4D/NewAPI 的已有协议映射保持不变；完整 Comfly 路线缺少目录分辨率元数据时，允许的 1K/2K 仍原样写入任务和 provider 请求；显式 1K-only 模型的 2K/4K 在提交前拒绝。Nano Banana 族从基础路线请求 4K 时会在排队前解析到同族 4K 路线，任务、持久化配置和提交 payload 使用相同 modelRoute 与 resolution。
- Agent 根因：对话、创作 Agent、Codex 三个页签共用可见消息是预期行为，但此前请求会把全部页签历史一起发送，导致反推 JSON 与长分析进入 Codex 上下文。消息现在持久化 mode；旧消息迁移到对话保存时的 mode；发送时只选择当前模式历史，界面仍保留完整可见记录。模式切换、模型刷新、项目重开后不会把其他模式内容继续发给当前模型。
- 执行能力根因：创作模型返回结构化 JSON 但 options 为空时，解析器把整段当普通文本，所以选择、确认、建节点、运行链全部消失。现在仅对合法的空 options 结构做受控恢复：复用用户原始要求、已连接参考素材与兼容生成路线，生成一个可选择方案；仍需用户选择并再次确认后才创建和执行节点。Codex 的参考图精修、保留与替换语句也会显示工作流建议，不再要求用户必须写出“工作流”三个字。
- Codex 长分析：10 分钟执行上限仍保留给 Max/Ultra 复杂任务，等待卡现在显示实际模型、推理档位和已等待秒数，并提供直接“停止”操作；停止会取消对应 requestId 并结束等待状态。
- 回归位置：`apps/renderer/src/app/app-store.test.ts`、`apps/renderer/src/canvas/ModuleNodeCard.test.tsx`、`packages/domain/src/canvas-module.test.ts`、`apps/renderer/src/agent/skill-chat-session-store.test.ts`、`apps/renderer/src/agent/creative-plan.test.ts`、`apps/renderer/src/agent/SkillChatWorkbench.test.tsx`。聚焦命令为 `npm.cmd test -- --run apps/renderer/src/canvas/ModuleNodeCard.test.tsx apps/renderer/src/app/app-store.test.ts apps/renderer/src/canvas/GenerationParameterPopover.test.tsx packages/domain/src/canvas-module.test.ts packages/provider-comfly/src/client.test.ts packages/provider-relayme/src/client.test.ts packages/desktop-core/src/newapi-provider-service.test.ts` 与 `npm.cmd test -- --run apps/renderer/src/agent/skill-chat-session-store.test.ts apps/renderer/src/agent/creative-plan.test.ts apps/renderer/src/agent/SkillChatWorkbench.test.tsx`。
- 完整源码验证通过：Vitest 为 234 个文件通过、2 个按设计跳过，3479 项通过、2 项跳过、0 失败；workspace typecheck、生产 build、secret/path scan、`git diff --check` 均通过；相关 Playwright 为 10/10。Vite 只有既有 chunk size 提示。测试遵循先增加失败回归、再修改实现。
- 1.6.129 独立候选位于 `apps/desktop-modern/dist-builder/desktop-modern-1.6.129-resolution-agent-20260910`。安装器 `CanvasAtelier-Win10-11-x64-1.6.129.exe` 为 103304817 字节、SHA-256 `A7DB56E304087DB8DFE366CE74EBF2D8591ABF443F971B1D92B280578CB9B884`；blockmap 为 109613 字节、SHA-256 `8A355238FD2A4889EA580A3AAA0814DB0ABE24FA45A6E208D9934B4FCE5758C1`；`latest.yml` 为 375 字节、SHA-256 `B7A656C83C77E5024C1731768BBF4A661D375D7D1E62928F54E6A66B5C56C49A`；候选 EXE SHA-256 `CB814DD32CC1BE07075D067E621838090CD4460D261071E4A6DDF208582A1259`；`app.asar` SHA-256 `59AA1A8B69DA8D70B0ABC1A2A28DD3DC3ED9C148B1D3F0CDE0B20A053685AEFB`。12 文件包载荷门禁通过，安装器 Authenticode 状态为 `NotSigned`。
- 候选包隔离验收通过：图片路线/返图测试确认模型目录刷新和项目重开后路线、结果与图片均保留；多供应商测试跨两个独立 Electron 生命周期确认四供应商设置、4D Nano Banana 2/Pro 的 1K/2K/4K、GPT `high + 4K`、重启持久化、MCP 连接，`reconfigureCount=0`、页面错误 0；Agent 创作方案测试确认选择方案后创建节点、提交、显示结果缩略图并在重启后保留。三组测试均未触碰真实项目，网络或付费生成调用为 0。
- 真实供应商是否最终返回所选像素仍受上游模型、账号和供应商目录能力约束；本轮没有发送付费生成任务，不能把协议映射、精确路线选择和返图像素校验写成 live 4K 返图成功。日用安装目录尚未由本候选覆盖；GitHub 发布状态在正式上传后另行记录。

## 2026-09-10 v1.6.129 GitHub 正式发布

- 发布源码提交为 `9db758d5b08a24acb93177a8b68830a9177857e1`，已推送到 `origin/feature/canvas-agent-mvp`。annotated tag `v1.6.129` 的本地展开提交与远端 peeled tag 都精确指向该提交。
- GitHub Release `https://github.com/19960726/canvas-atelier/releases/tag/v1.6.129` 已设为 latest，状态为非草稿、非预发布。线上安装包 103304817 字节、SHA-256 `a7db56e304087db8dfe366ce74ebf2d8591abf443f971b1d92b280578cb9b884`；blockmap 109613 字节、SHA-256 `8a355238fd2a4889ea580a3aaa0814db0abe24fa45a6e208d9934b4fce5758c1`；`latest.yml` 375 字节、SHA-256 `b7a656c83c77e5024c1731768bbf4a661d375d7d1e62928f54e6a66b5c56c49a`。GitHub API 返回三个资产均为 `uploaded`，大小和 digest 与本地最终候选逐项一致。
- Release 使用通过源码、Playwright、包载荷和三组隔离 Electron 门禁的 1.6.129 候选。安装包仍未做 Authenticode 签名；发布不等于日用安装目录已经覆盖，也不等于真实供应商付费 2K/4K 返图已经通过。
- 真实 GitHub 更新链补充通过：日用 1.6.128 应用在隔离 user-data 中识别 1.6.129 为 `available`，下载达到 `ready_to_restart`；下载文件为 103304817 字节，SHA-256 `a7db56e304087db8dfe366ce74ebf2d8591abf443f971b1d92b280578cb9b884`。测试没有调用重启安装，日用 EXE 与 `app.asar` 前后哈希一致，隔离下载缓存已安全删除。证据为 `work/qa-github-update-1.6.129-from-1.6.128/report.json`。

## 2026-09-10 1.6.130 Agent 工作流执行与 Codex 时延收口

- “Agent 只给关键词、不会执行”的根因是创作方案合同只包含标题、理由和提示词，确认后只新建一个生成节点；Codex 的通用工作流入口也只落一个旧式提示词和审核节点。现在每个创作方案显示 3–6 个用户可读的步骤；模型返回不足 3 步时使用完整保底，不会再退化成单个关键词。
- 用户选择方案并确认后，画布会原子创建参考素材、文本提示词、图片/视频生成与结果输出节点，用正式端口连线，再将确认的模型、比例、清晰度、GPT 质量、数量与参考顺序写入生成队列。回归首先暴露了连线缺失 `order` 导致事务整体回滚，修复后生图、保存错误与重启恢复链全部通过。
- 推理强度仍按对话、创作 Agent 和 Codex 分开持久化，选择值实际透传到聊天与反推请求；反推深度继续作为独立参数透传。Codex 超时从统一 10 分钟改为按 Low/Medium/High/XHigh/Max/Ultra 的 90/150/240/360/480/600 秒分档，等待卡显示模型、档位、已用时间和停止操作。Codex 内嵌指令新增“只读一次画布、直接调用 `canvas_plan_workflow`、不只返回关键词”，仅版本冲突时允许重读一次。
- 上下文污染复核未发现新的跨项目或跨模式泄漏：当前模式只发送本模式历史，参考素材按项目和发送快照绑定，外项目 job 继续被 `projectId` 与 durable node anchor 过滤。完整 Vitest 为 234 个文件通过、2 个按设计跳过，3483 项通过、2 项跳过。完整 Playwright 为 164 项直接通过；2 项旧断言仍只接受 `2K/4K`，更新为现行 `1K/2K/4K` 后深色和浅色用例分别重放通过。workspace typecheck、production build、secret/path scan、`git diff --check` 均通过。
- 1.6.130 最终候选位于 `apps/desktop-modern/dist-builder/desktop-modern-1.6.130-agent-workflows-20260910-final`。安装器 103306153 字节、SHA-256 `42161F4752DCA4EBFA9C4D8451794A48D375A3092DE65CD09EE0311CC27A83C3`；blockmap 109713 字节、SHA-256 `978364D0ECBCDFB691EE47FA5551C08FB0AA8BEC32BD3485EA68E0FE589EAF71`；`latest.yml` 375 字节、SHA-256 `901C302648B5472BF9319AE6092188489A32530E82E76E6D5DDAF89CA68EA7E4`。候选 EXE SHA-256 `41AC9C241024EEB5AA403DF088E304C66319C20556A283531D391EB16CF925B8`，`app.asar` 6043142 字节、SHA-256 `0313EE7D1560C561395E67940B7BC9EA685D0D64E7FA6E652B04BEDC2B924BB5`；12/12 安装载荷与解包目录同哈希，安装包仍为 `NotSigned`。
- 最终包隔离验收通过：创作 Agent 的 4 节点参考工作流、受控返图、重启恢复、GPT `high + 4K`、四供应商设置、两个独立 Electron 生命周期的 `reconfigureCount=0`、MCP 14/14 工具、工作流确认、生成完成/取消、媒体导入和重启读取全部通过；页面错误 0，网络尝试 0，真实项目未触碰。这些证据证明安装包和零费用链路，本轮没有发送真实供应商付费生成，也没有替用户安装到日用目录。

## 2026-09-10 v1.6.130 GitHub 正式发布

- 发布源码提交为 `17856e152844e435c48a243945ee37bde15a1a7a`，已推送到 `origin/feature/canvas-agent-mvp`。annotated tag `v1.6.130` 的本地展开提交与远端 peeled tag 均精确指向该提交。
- GitHub Release `https://github.com/19960726/canvas-atelier/releases/tag/v1.6.130` 已设为 latest，状态为非草稿、非预发布。线上安装包 103306153 字节、SHA-256 `42161f4752dca4ebfa9c4d8451794a48d375a3092de65cd09ee0311cc27a83c3`；blockmap 109713 字节、SHA-256 `978364d0ecbcdfb691ee47fa5551c08fb0aa8bec32bd3485ea68e0fe589eaf71`；`latest.yml` 375 字节、SHA-256 `901c302648b5472bf9319ae6092188489a32530e82e76e6d5ddaf89ca68ea7e4`。GitHub API 返回的三个资产大小和 digest 与最终本地候选逐项一致。
- 真实 GitHub 更新链补充通过：日用 1.6.128 应用在隔离 user-data 中识别 1.6.130 为 `available`，下载达到 `ready_to_restart`；下载文件为 103306153 字节，SHA-256 `42161f4752dca4ebfa9c4d8451794a48d375a3092de65cd09ee0311cc27a83c3`。测试没有调用重启安装，日用 EXE 与 `app.asar` 前后哈希一致，隔离下载缓存已安全删除。证据为 `work/qa-github-update-1.6.130-from-1.6.128/report.json`。
- Release 使用已通过源码、Playwright、安装包 payload 和隔离 Electron 门禁的 1.6.130 候选。安装包仍未做 Authenticode 签名；发布与更新下载验证不等于已替用户覆盖日用安装目录，也不等于真实供应商付费生图或视频已经通过。

## 2026-09-11 v1.6.131 Agent 输出类型、RelayMe 失败原因与 Codex 超时

- 截图中的生图失败已从用户最近任务历史只读定位：三次 RelayMe RENA2 任务均返回 `Insufficient balance. Please recharge and try again.`，根因是账户余额不足，不是模型或 API 配置丢失。RelayMe 轮询现在把该错误归一为可重试的额度错误，生图卡直接提示充值或切换供应商，不再显示误导性的“检查模型与 API 配置”。本轮没有提交新的真实供应商任务，也没有消耗额度。
- 创作 Agent 输入区把原先只有图标的生成偏好改为可见的“图片工作流 / 视频工作流”按钮。发送方案请求时保存用户明确选择的输出类型，规划指令和界面结果都严格限制为该类型；图片精修不会再被聊天模型替换成视频。参考图没有兼容 `image_edit` 或 `gemini_native` 路线时，保留可读分析并明确提示配置兼容图片模型。输出类型与请求一起持久化，应用重启后仍能约束旧消息中的方案。
- Codex 截图等待 162 秒时选择的是 GPT-6 Astra Max；Max 本身允许更长深度推理。实际缺陷是渲染层超时后没有终止后台 Codex CLI，后台仍可能占用请求槽。现在界面超时会按 requestId 取消进程，主进程也按 Low/Medium/High/XHigh/Max/Ultra 分别采用 90/150/240/360/480/600 秒上限；Max/Ultra 等待超过 60 秒时提示停止并切换到高或中档。
- 测试遵循先写失败回归再修改源码。完整 Vitest 为 234 个文件通过、2 个按设计跳过，3491 项通过、2 项跳过；补充会话重启测试后相关测试 29/29 通过。workspace typecheck、production build、`git diff --check` 通过；关键 Playwright 14/14 通过。1.6.131 候选的创作方案执行、四节点工作流、受控返图、重启恢复、模型路由返图、项目重开、图片类型锁定与错误视频方案拦截均通过，页面错误 0、真实项目未触碰、付费调用 0。
- 候选目录为 `apps/desktop-modern/dist-builder/desktop-modern-1.6.131-agent-routing-codex-timeout-20260911`。安装器 103306687 字节、SHA-256 `6BDB407CF4011D18C36945B6114891128DBA1E235B40C97FE327AE1E92CEED62`；blockmap 109694 字节、SHA-256 `12BAD3571C08643C8BC8AA79C5E2F3CE1B2F3776D23DA4F84484C25EC1BEDADC`；`latest.yml` 375 字节、SHA-256 `225F3B6D1B17B98F7818DA9C63E8E2620C6F4367D07929C9AD2839D0B5141C9E`；候选 EXE 225448960 字节、SHA-256 `E70ABABB58F9E667A43B31610DF1470625AC3DDA35CA80663175C01A63EEF5FA`；`app.asar` 6043578 字节、SHA-256 `525BDB37E8A9E4B6BF55D1446885631D486880CAA9E83877C1CBC67CE0904C0A`。安装器解包 12/12 应用载荷与候选目录一致。
- 发布源码提交和本地/远端分支均为 `999f5a0dba15111a7a39c808566b1471e825c556`，GitHub Release `https://github.com/19960726/canvas-atelier/releases/tag/v1.6.131` 已设为 latest，标签指向同一提交。三个线上资产的大小和 digest 与本地候选逐项一致。真实 GitHub 更新链从隔离的 1.6.130 候选识别 1.6.131 为 `available`，下载达到 `ready_to_restart`，下载文件大小与 SHA-256 完全一致；没有调用重启安装，源应用 EXE 与 `app.asar` 前后未改变，隔离缓存已清理。

## 2026-09-11 1.6.132 供应商目录隔离、Agent 排版与返图转入对话

- 供应商混显的根因是可运行模型函数始终合并 Comfly、RelayMe、巨轮和 4D 的目录，当前供应商只参与排序。画布生图、视频、反推和 Agent 选择器现在显式启用 `activeProviderOnly`，只显示当前供应商路线；设置页仍按供应商维护各自目录，内部任务恢复仍可解析旧项目保存的跨供应商路线，避免仅切换供应商就破坏旧任务。
- Agent 输入区错位的根因是非 Codex 模式增加推理强度后仍沿用四列 footer，推理控件和“图片工作流”文字挤入相同区域。最终样式为推理强度、工作流类型和发送操作分配独立列，紧凑按钮隐藏重复文字但保留 title 与无障碍名称；长输入、图片引用和亮暗主题布局均由 Playwright 覆盖。
- “发送到 AI 对话”无反应有两层竞态：图片事件可能先于 Agent 监听器挂载而丢失；右键菜单按钮的同一轮冒泡又会触发画布 surface close，把刚打开的 Agent 立即隐藏。现在使用有界去重的待转入图片队列，并在菜单点击传播完成后依次打开 Agent、投递图片；若当前模型不能看图，会自动选择当前供应商的视觉聊天路线，Codex 无可用视觉路线时回到普通对话并选视觉模型。
- TDD 先更新供应商隔离、模型刷新、预挂载图片队列和 footer 网格回归；新增端到端用例精确执行“生成结果右键菜单 → 发送到 AI 对话 → Agent 可见 → `@图片1` 与受管图片引用出现”。旧实现分别表现为混合目录、事件丢失和 Agent 仍隐藏，修复后通过。
- 最终源码验证：Vitest 234 个文件通过、2 个性能文件按设计跳过，3494 项通过、2 项跳过；Playwright 167/167；workspace typecheck、production build、secret/path scan 与 `git diff --check` 均通过。全量端到端同时覆盖 GPT `high + 4K`、全模型清晰度、返图重载、项目管理、Photoshop 操作入口、视频节点、Agent/Codex 推理强度和大画布布局。
- 最终候选目录为 `apps/desktop-modern/dist-builder/desktop-modern-1.6.132-provider-isolation-agent-transfer-ui-20260911-final`。安装器 103306854 字节、SHA-256 `FC221AFF1E4A64B0FF32EE6DD6B7D1D92EC9770E2C019FF8DCF197C32924F113`；blockmap 109585 字节、SHA-256 `5C38C2CAA44EABAE0625283C8663187E436B6D1AD2B877B6898E647C38C823F0`；`latest.yml` 375 字节、SHA-256 `436F3C429A18840481E103B19CEF0AFF15477DB9838F79D873D4290986C7AAFD`。候选 EXE SHA-256 `198E183A5B9A1B544740B2723CC9B98E2A771FBDC82061510C642C21A494B934`，`app.asar` SHA-256 `4D78CB96F12F5F63B44E41189EFF1C48D889F18437AF73EF97D1D09C0C7E5415`；安装器解包 12/12 载荷一致，Authenticode 为 `NotSigned`。
- 最终候选的隔离 Electron 门禁确认 Comfly 只提供 Comfly 生图路线，目录刷新与项目重开保持路线和返图；创作 Agent 创建并执行四节点图片工作流，受控返图在关闭重启后保持；CSP 门禁通过。上述包验收没有外部网络、没有触碰真实项目、没有付费调用，因此不等同于真实供应商账户返图成功。
- 发布源码提交和 `v1.6.132` 标签均指向 `ff9d88e95d2845ca506a3793abeb0475db001f94`。GitHub Release `https://github.com/19960726/canvas-atelier/releases/tag/v1.6.132` 已设为 latest，非草稿、非预发布；线上安装器、blockmap 与 `latest.yml` 的大小和 SHA-256 与最终本地产物逐项一致，三个资产状态均为 `uploaded`。
- 真实 GitHub 更新链从隔离的 1.6.131 候选识别 1.6.132 为 `available`，下载达到 `ready_to_restart`；下载文件为 103306854 字节、SHA-256 `fc221aff1e4a64b0ff32ee6dd6b7d1d92ec9770e2c019ff8dcf197c32924f113`。测试没有调用重启安装，1.6.131 源 EXE 与 `app.asar` 前后哈希一致，隔离下载缓存已删除。报告为 `work/qa-github-update-1.6.132-from-1.6.131/report.json`。

## 2026-09-11 1.6.133 Agent 紧凑操作组待用户确认候选

- 用户指出 Agent 底栏生成偏好与知识库之间仍有一块无意义留白。首轮真实浏览器 RED 测得跨容器间隔 13px；把生成偏好移入操作组后，第二轮 RED 又暴露旧高优先级兼容样式仍把操作组锁为 66px，导致三个按钮换行并形成 53px 间隔。
- 最终结构把生成偏好、知识库和发送放在同一个三列操作组，每个按钮 30px、统一间距 6px；推理强度保留独立 92px 轨道，模型列继续自适应。创作 Agent、Codex、亮暗主题、800px 窄窗口、长输入和多引用布局均未溢出。
- 聚焦 Vitest 5 文件 253/253 通过；相关 Playwright 6/6 通过。workspace typecheck、production build、NSIS x64 候选、12/12 载荷比对和候选 CSP 启动门禁通过。
- 待确认候选位于 `apps/desktop-modern/dist-builder/desktop-modern-1.6.133-agent-compact-actions-confirmation-20260911`。安装器 103307127 字节、SHA-256 `D514F0B7CE75509181FAD7D851B3E775CF8877BF9B462C25F8EDA8ABD5368EDA`；blockmap 109579 字节、SHA-256 `FD73AD33124226CC0583CD3CB89A8BB04B975237CCBCA03B12DC31A51ED191E0`；`latest.yml` 375 字节、SHA-256 `6A6E1357AC7AF6CBA59D851D9F20E611AD601579CB585290AD6BC89C5D33FC05`。候选 EXE SHA-256 `C3A774A6FE0232A38964C83B6ACAEA647AEC3C13E89F709E03DDB586BFD0C257`，`app.asar` SHA-256 `85F5D0B0D8CD8099AF08D9B65028FACAE72B3ED2813393E71A79A39DD5791F2E`，Authenticode 为 `NotSigned`。
- 按用户要求，本候选尚未发布 GitHub、尚未上传在线更新、尚未安装到日用目录；等待用户确认界面后再执行完整发布门禁。
- 后续收到“每次打开都要很久才有模型”的截图。根因有两层：画布启用当前供应商隔离后仍先等待四个供应商的目录和状态全部结束；Comfly 桌面服务在已有持久化目录时仍于每次进程重启首次读取触发远端目录发现。现在画布只请求当前供应商，目录结果与全局状态异步独立提交，并去掉重复的全局状态读取；Comfly 重启先返回已保存目录，用户保存新密钥或在设置执行“诊断与更新”时仍刷新远端目录。
- TDD 的两条界面回归先稳定复现“非当前供应商被调用”和“状态查询悬住时模型不出现”，服务层回归先复现“重启读取已保存目录仍访问网络”；修复后完整 Vitest 为 234 个文件通过、2 个性能文件按配置跳过，3496 项通过、2 项跳过，workspace typecheck 和 production build 通过。新安装包 12/12 载荷一致、CSP 门禁通过；隔离解包应用的项目重开与返图门禁通过，调用记录只出现当前 Comfly 目录，没有请求 RelayMe、巨轮或 4D。旧 `qa-installed-gpt-multi-provider` 脚本仍要求五条跨供应商路线同时出现在生图选择器，因与 1.6.132 已确认的供应商隔离要求冲突而失败，未作为本候选通过证据。
- 本次替代候选位于 `apps/desktop-modern/dist-builder/desktop-modern-1.6.133-fast-active-provider-startup-confirmation-20260911`，没有覆盖上一份 1.6.133 候选。安装器 103307037 字节、SHA-256 `BABFCDCD69EA47C9017D98929FB592926ACBB034E577EF10D66AEAA4B133C429`；blockmap 109644 字节、SHA-256 `D58EECDAE3C102CD7FBEC9EE3BAAED7BB9B7DBA078AD6E134678D56FEE8B5E8F`；`latest.yml` 375 字节、SHA-256 `396D78A05F712F8536DCE794C2522644A6AD531BC5CBB91C450BF2C4A77F2A7F`。候选 EXE SHA-256 `FC79088E1431C24D40BCBCE67B3AA02E89F6678864CF7B4259E66EA13391021C`，`app.asar` SHA-256 `12D79AB09E2DF746EA0B860B1BD32B34879F21C69838B53117E936252678ACB7`，Authenticode 为 `NotSigned`。
- 按用户最新要求，替代候选仍未发布 GitHub、未上传在线更新、未安装到日用目录；等待用户确认后再发布。

## 2026-09-11 1.6.133 Agent 反推强度排版修复候选

- 用户截图中的“快速反推 / 标准反推 / 深度反推”重叠是 1.6.133 紧凑操作组引入的布局回归：操作组缩为 102px 后，反推强度仍被限定在同一末列，三个中文按钮各自只有约 31px。反推参数和执行逻辑没有丢失，问题只在可见布局。
- 先在 `tests/e2e/release-agent-layout.spec.ts` 增加真实浏览器几何回归；旧样式稳定失败为反推行与模式行重叠。修复后模式切换、反推强度和底部操作各占独立行，三种反推按钮使用全宽三等分，每项不低于 80px且文本不溢出；下方模型、推理、生成偏好、知识库和发送仍保持同一紧凑行。
- 聚焦验证通过：Agent 布局 Playwright 2/2；`SkillChatWorkbench` 与 release layout contract Vitest 167/167；全 workspace typecheck 与 production build 通过。新候选安装包 12/12 关键载荷一致，候选 CSP 启动门禁通过，QA 主进程和隔离目录均已清理。
- 替代候选位于 `apps/desktop-modern/dist-builder/desktop-modern-1.6.133-reverse-mode-layout-confirmation-20260911`。安装器 103307155 字节、SHA-256 `15D440E3AE667B1819B7F1CBF2141BF49FF2184A052A2A528D22DC5B030B580B`；blockmap 109658 字节、SHA-256 `86F3852D6C54CDCB8286981C5BF92712710DC9E335E8A812A84F1B3E375EE4E7`；`latest.yml` 375 字节、SHA-256 `0E6E6F018D5AC0D13A3D8C27C5CC8A306E4CC865096F6CFBC03D9C83863E7209`。候选 renderer CSS SHA-256 为 `EA969DCEDBC7222743CBB034CF99F3F09CBD775504E6AA9ED64BD227FA5D7570`，安装包 Authenticode 状态为 `NotSigned`。
- 按用户要求，本候选未发布 GitHub、未上传在线更新、未安装到日用目录；等待用户确认界面后再发布。

## 2026-09-11 1.6.133 图片细节预览、Agent 需求分析与素材粘贴替换候选

- 生成图片双击预览增加 100%–800% 鼠标滚轮缩放、以光标为中心缩放、放大后拖动查看、`+`/`-`/`0` 键和可见缩放控制。预览舞台改为中性深色，去掉图片两侧绿色色块；同时补齐 portal 弹层在亮暗主题下的标题、关闭按钮和底栏颜色回退。真实浏览器用例确认滚轮从 100% 到 125%、重置回 100%，截图保存在 `artifacts/CanvasAtelier-1.6.133-image-zoom/generated-image-zoom.png`。
- 创作 Agent 的方案解析增加目标、必须保留、必须修改、禁止改变和验收标准五组结构化需求。模型没有返回完整字段时，会从用户原句恢复明确约束；快速、标准、深度分析现在分别进入规划指令，深度档额外检查需求冲突、证据、模型能力边界、构图/材质风险、未知项和取舍。界面新增可读的“需求分析”区，方案必须把每项需求映射到完整提示词或可执行工作流，不能只给关键词。
- 素材不能直接粘贴替换的根因是画布粘贴路由只识别单选图片输入节点，视频输入节点始终落入“新建素材节点”分支；类型不匹配也会误建第二个节点。现在单选图片素材后粘贴图片、单选视频素材后粘贴 MP4 都原位调用受管导入并保存；兼容 `clipboardData.files` 与只有 `DataTransfer.items` 的 `video/mp4` 载荷。图片/视频类型不匹配时不修改项目，并在画布明确提示正确格式；多选或未选素材节点仍保留原来的新建节点行为，输入框、文本域与可编辑区域不拦截粘贴。
- 测试先稳定复现视频粘贴没有进入原位导入、类型不匹配误走新建分支、只有 MP4 item 时事件被忽略，再修改源码。完整 Vitest 为 234 个文件通过、2 个性能文件按设计跳过，3502 项通过、2 项跳过；最终粘贴聚焦回归 163/163。图片预览、Agent 排版/引用与素材工作流相关 Playwright 为 19/19，其中安装前浏览器链明确验证视频替换后 `video_input` 节点数量仍为 1。workspace typecheck、production build 与 `git diff --check` 通过。
- 待确认候选位于 `apps/desktop-modern/dist-builder/desktop-modern-1.6.133-image-zoom-agent-analysis-media-paste-confirmation-20260911`。安装器 103308854 字节、SHA-256 `0B1D4AE150DABEC5F3BB08F72F120F508F0E96BA11BE7580CD980B60598AB0F1`；blockmap 109667 字节、SHA-256 `066535F24573A9FD5C3A7B0FFEFB86F26CD14FE44C29B50EECFE31A680087536`；`latest.yml` 375 字节、SHA-256 `D0A0394CB517A31832E58367FF195FFA28FC980DD6B9849443ED0A3710118919`。候选 renderer CSS 为 `index-CSBm2Vpv.css`、SHA-256 `FBD0F61BF8D08E06FE103A232AD6F9838BDF2667F48B795601BC5D408A9E8AD4`；renderer JS 为 `index-D9Z3_JI-.js`、SHA-256 `193E725F967B1F2F9B40FA2BBC49C98431356135FDF007AEF06C52853CD75703`。安装器解包 12/12 载荷一致，候选 CSP 启动门禁通过且隔离 QA 主进程和目录均清理，Authenticode 为 `NotSigned`。
- 按用户要求，本候选未发布 GitHub、未上传在线更新、未安装到日用目录。受控测试没有触发真实供应商付费生成，也没有改写用户真实项目。

## 2026-09-11 1.6.133 原生图片与 MP4 粘贴替换持久化候选

- 安装包实测发现浏览器 `ClipboardEvent` 能看到图片/MP4 `File`，但 Electron 隔离世界中的内存文件不一定保留原生路径。桌面持久化层现在先走受管 dropped-media 导入；拿不到可信路径时，对选中的图片或视频输入节点回退到对应的主进程原生剪贴板桥，避免点击粘贴后无反应。
- Windows Explorer 在 Electron 43 中可能只公开 `text/uri-list`，同时仍可从隐藏 `FileNameW` 读取本地文件路径。图片和视频适配器现兼容这种单路径载荷的有终止符与无终止符形式，继续拒绝多路径、网络路径、设备路径、相对路径、非 JPG/JPEG/PNG 图片与非 MP4 视频。模块替换 transaction 使用独立 operation receipt 和 asset fingerprint，应用刷新或重启只协调已提交操作，不会重复写入旧素材。
- r5 候选真实 Electron 门禁使用隔离用户目录并实际切换系统剪贴板：同一图片输入节点从 asset `9eebf278a1af40b5` 原位替换为 `8c720c21a66f0eaa`，同一视频输入节点从 `ae8c7100c9ffa5fe` 原位替换为 `55193204eaf98670`；两类节点重启后数量均为 1，节点 ID 和第二份素材 ID 保持，页面错误为空，剪贴板恢复退出码为 0。报告为 `work/qa-native-media-replacement-1.6.133-candidate-r5-selected/report.json`。
- 最新源码的聚焦剪贴板格式回归为 5/5；完整 Vitest 最终为 234 个文件通过、2 个按设计跳过，3522 项通过、2 项跳过；完整 workspace typecheck 与 production build 通过，构建输出 renderer JS 为 `index-CqoN03Pw.js`。第一次全量中的 MP4 失败来自新增单测把成功导入 mock 错写为 `null`，修正测试夹具后该项与一项安全扫描并发超时先聚焦 2/2 转绿，再完整复跑全部通过。
- 最终待确认候选为 `apps/desktop-modern/dist-builder/desktop-modern-1.6.133-native-media-replacement-agent-zoom-confirmation-20260911-r5`。NSIS 安装包 103310185 字节、SHA-256 `41B1E81001496A993985548223946F31910BE2FD06480B1B93EFDE795B96E49D`；blockmap 109650 字节、SHA-256 `38163EDC8301D9B87A98C3ACB3E5B7DE348E4E0C0EE18A1FBD297102DB681A83`；`latest.yml` 375 字节、SHA-256 `317479555CC225498C9670EF48059A4BD0D5C470FDA22EFFB32DC5CE72036612`；候选 EXE SHA-256 `E3AABC4569DE6E36EE2A4BC6A2D5812FCB2484CCB12A3D73B74F754E7BD8060F`；`app.asar` SHA-256 `52BD956017CF65138B2F44B0145A53D9797D50F195F78C961AACE29AA1A65878`。安装包和候选 EXE 均为 `NotSigned`；安装包解包后的 12 个关键载荷与 `win-unpacked` 逐项一致。
- 按用户要求，本候选未安装到日用目录、未发布 GitHub、未上传在线更新。现有脏工作区、未跟踪 QA 资产和两份用户既有 tracked 修改均保留，没有 reset、clean 或删除。
# 2026-09-12 image, Agent clipboard and reverse repair checkpoint

- Fixed the reproducible local causes behind the reported UI failures. GPT image references now use Comfly multipart edits with uploaded files and exact size mapping; generation options (`auto` quality, PNG/JPEG/WEBP, background) persist through node drafts, model jobs, retry identity and IPC. JPEG plus transparent is rejected before queueing. The image picker groups 1K/2K/4K variants into one visible model while preserving the exact route, and nine-image batches dispatch one-image jobs and retain all nine results.
- Agent clipboard parsing now handles empty MIME, `application/octet-stream`, merged DataTransfer wrappers and native Electron clipboard fallback. Manual visual imports can route to an available vision profile in Chat/Original modes.
- Reverse response handling ignores Gemini thought parts and sanitizes extra media-responsibility metadata before strict validation. This prevents thought text from corrupting JSON; it does not prove the historical live provider 503 was caused by this parser.
- Verification: focused Vitest 11 files / 1041 tests passed; Playwright generation parameter suite 4/4 passed; `npm.cmd run typecheck` passed; `npm.cmd run build` passed. No paid provider submission, installer install, or publication was performed. Existing live evidence still contains Comfly HTTP 503 records, which remain an upstream/provider boundary.

## 2026-09-12 1.6.133 GPT 生图、反推、Agent 剪贴板与主题安装版闭环

- 主题切换并非功能缺失：`ThemeControl`、`system | light | dark` 持久化和亮暗 token 已存在，发布布局文件末尾却把 `.theme-control--compact` 与关闭按钮一起设为 `display: none !important`。现已把主题控件移出关闭按钮专属规则，并增加发布 CSS 回归。最终安装版中控件尺寸为 112 x 36，`浅色`、`深色`、`跟随系统` 均真实改变根节点主题，页面错误为空；证据为 `work/qa-installed-theme-switch-1.6.133-20260912/report.json`。
- 老项目可能缺少 `recovery` 目录，写锁建立前的 operation guard 会因此失败并把项目静默降为只读，随后生图或反推在保存边界失败。`ProjectRepository.open(..., 'write')` 现在会先补建该目录再取得写锁；红测先复现 `read_only`，修复后项目仓库 46/46 通过。
- 用户授权的一次真实 Comfly 生图已执行且成功：`comfly-gpt-image-2-5-sunburst`、1:1、1K、1 张、无参考图，任务 `model-job-v2-461ca537d7b375f4b832404a69e1e91f` 在约 15.5 秒完成，retryCount 0、error null；返图为 1024 x 1024 JPEG、326066 字节，Chromium 解码成功。报告为 `work/qa-live-generation-1.6.133-results/20260912T005224448Z-39784/report.json`，图片为同目录 `image-654ee7e5a32c90ce.jpg`。该 live 请求运行于当时安装的 1.6.133 `app.asar` 哈希 `0FD678A4BE9257408F534B26834520DD7D79EA375BEE75B76A3630E08DC9FE62`；之后只增加主题显示和老项目目录迁移并重新打包，没有发送第二次付费请求。
- 最终安装版反推使用隔离零费用 provider 执行完整链：受管图片导入、反推节点创建、执行确认、provider analyze、完整结果回写与持久化均通过；请求和保存配置均精确包含 `analysisDepth: deep`，网络尝试 0，真实项目未触碰。证据为 `work/qa-installed-mcp-video-reverse-zero-cost-1.6.133-theme-final.json`。Gemini thought part 与额外 responsibility 字段的解析修复另有源代码回归覆盖；没有把零费用 fixture 写成真实上游反推成功。
- 最终安装版 Agent 原生剪贴板链通过：Windows 文件剪贴板粘贴后出现 1 个受管引用和 `@图片1`，视觉模型收到精确引用，已发送缩略图可加载；复制回系统剪贴板显示“图片已复制”，native image 与原图一致，剪贴板随后恢复。证据为 `work/qa-installed-agent-image-chat-1.6.133-theme-final/report.json`。粘贴边界为单边不超过 8192 像素、总像素不超过 6400 万、转码 PNG 不超过 64 MiB；普通 1K/2K/4K 不会因尺寸本身被拒绝。此前间歇失败主要来自空 MIME、`application/octet-stream`、DataTransfer wrapper 与 Electron 原生剪贴板格式差异。
- 最终 UI 安装版门禁确认生图节点为两行 8 个控件，质量改为“高”、清晰度改为 4K 后项目保存和进程重启仍保持；当前供应商为 Comfly 时选择器只显示 Comfly 路线。GPT Image 2.5 的 1K/2K/4K 内部路由在模型菜单合并为一个可见模型，由清晰度控件选择，不再列成三个模型。报告为 `work/qa-installed-gpt-multi-provider-1.6.133-theme-final-r4/report.json`。
- 最终源码验证为聚焦 Vitest 7 文件 799/799、反推安装门禁 helper 8/8、全 workspace typecheck、production build 与 `git diff --check` 通过。NSIS 安装器为 `apps/desktop-modern/dist-builder/desktop-modern/CanvasAtelier-Win10-11-x64-1.6.133.exe`，103312547 字节、SHA-256 `4F408490A695E317E66406A7FD02EED9A8C2B444F6B4FCB2B2ED5145D0E8848D`。正式安装目录 EXE 与候选同为 `BFE30FAD4EFFD3AAAEDCF50D2841230C11D16BCB51387D0062D1E8DFF41323EE`，`app.asar` 与候选同为 `05C0C831A22842A5462A4EEBD07297EA7E594E3491D72D6462D66F5489422CD7`。

## 2026-09-12 1.6.133 GPT 2.5 精确路由与反推强度安装版修复

- 对用户 09:28 的正式项目任务做只读取证：Flare 任务选中 4K、高画质、1:1、1 张，但提交路线仍是基础 `comfly-gpt-image-2-5-flare`，并在约 16 秒后收到 Comfly HTTP 502；同节点此前的 Flare、Sunburst 基础 4K 请求也收到 502，历史精确 `-4k` 路线另有 503。实时 Comfly 目录同时列出基础、2K、4K 路线，却没有静态审计目录中的 `constraints`，旧解析器因此无法按清晰度切到隐藏精确路线。
- `image-resolution-routing` 现在会从模型 route/model id 的 `-1k`、`-2k`、`-4k`、`-512px` 后缀恢复分辨率能力；模型菜单继续把同族路线合并为一个可见模型，清晰度按钮负责选择内部精确路线。生图节点还会移除已经断开且提示词不再引用的旧 `referenceAssetIds`；用户截图节点视觉上只有一张输入，但旧任务曾把两张素材发给供应商。Comfly 502 现在显示上游暂时异常，不再误导为本地 API 配置错误。
- 用户截图中的反推记录实际是约 148.6 秒后由用户取消，节点没有保存 provider error。10 张输入共 5,272,334 字节，最大 1448 x 1086，不属于图片过大；主要等待来自 `gemini-3.1-pro-preview-customtools`、深度结构化输出和十图视觉请求。快速、标准、深度现在分别使用 4096/8192/16384 输出 token 和 90/180/300 秒 provider 超时；Gemini native、chat completions、Responses 与创作 Agent 视觉分析都传递对应预算，强度按钮不再只改提示词。
- 完整 Vitest 为 235 个文件通过、2 个性能文件按设计跳过，3556 项通过、2 项跳过、0 失败；workspace typecheck 与 production build 通过。新 NSIS 安装器 103312789 字节、SHA-256 `BA87D9D1095130D2EFEF138A0C5BFCE8C028CA4EDAC8F2A62880E4606F0035EC`，12/12 安装载荷一致。正式安装目录 EXE 与候选 SHA-256 均为 `036DF7986A58E4D026B5700D9A5907DC21E5C6CEA9D5EFE9E068FF84A8D76486`，`app.asar` 均为 `9D87D51AAB8F857DB391479D12D78E01276F80114C1F9880422E4E4DF46C87A6`，注册表版本为 1.6.133。
- 新正式安装版门禁：`work/qa-installed-gpt25-resolution-route-1.6.133-final/report.json` 从 UI 选择 Flare 4K 并点击生成，菜单只显示一个 Flare，离线执行器实际收到 `comfly-gpt-image-2-5-flare-4k`、4K、高画质，网络尝试 0；主题、GPT 节点重启、反推完整链和 Agent 原生图片粘贴/复制分别由 `work/qa-installed-theme-switch-1.6.133-routing-final/report.json`、`work/qa-installed-gpt-multi-provider-1.6.133-routing-final/report.json`、`work/qa-installed-mcp-video-reverse-zero-cost-1.6.133-routing-final.json`、`work/qa-installed-agent-image-chat-1.6.133-routing-final/report.json` 通过。没有再次提交付费请求，因此用户同一密钥下精确 Flare 4K 参考图任务是否避开当前上游 502/503，仍需与供应商可用性分开判断。

## 2026-09-12 1.6.134 Comfly Gemini 原生反推与真实错误提示修复

- 用户正式项目中最近一次深度反推从 10:27:13 到 10:32:14，约 300 秒后失败；持久化层把实际 provider timeout/status 统一掩盖为 `Provider request failed`，应用重载又把所有运行中反推改成无错误的 `cancelled`，因此界面只看到“自动取消”或“模型服务暂时不可用”。现在安全保留超时毫秒数与 401/403/408/409/422/429/5xx 状态，节点和 Agent 转换成可操作的中文原因；重启中断保存为 `failed` 并明确提示重新执行，不再伪装成用户取消。
- 当前公开 Comfly `/api/pricing` 明确给 `gemini-3.1-pro-preview-customtools` 声明 `gemini` 与 `openai` 两种 endpoint type，但目录解析此前丢弃该字段，导致十图反推和 Agent 视觉分析只能走 `/v1/chat/completions`。目录现在保留并合并 `supported_endpoint_types`；对非媒体输出、带多模态证据且模型 ID 为 Gemini 的路线增加 `gemini_native`，反推和 Agent 视觉请求改走 `/v1beta/models/{model}:generateContent`，图片按顺序放入 `inlineData`，深度按钮仍真实控制 4096/8192/16384 token 与 90/180/300 秒预算。
- Comfly GPT Image 4K 遵循最大 8,294,400 像素限制，1:1 的精确映射是 2880 x 2880，与 3840 x 2160 同为约 8.29 百万像素。结果检查现在按 4K 像素面积接受该方图，不再用单边必须达到 3500 像素的错误规则提示“实际 2K”。这只修正清晰度判断，不会对供应商返回的图片进行虚假放大。
- 回归位置：`packages/provider-comfly/src/client.test.ts` 固定 endpoint type 目录合并；`packages/desktop-core/src/provider-model-catalog.test.ts` 固定 Gemini 原生能力；`packages/desktop-core/src/provider-skill-chat.test.ts` 固定 Agent 原生多图请求；`packages/desktop-core/src/provider-bridge.test.ts` 覆盖反推原生请求与深度预算；`apps/renderer/src/app/desktop-persistence.test.ts`、`app-store.test.ts` 与 `canvas/ModuleNodeCard.test.tsx` 固定安全错误、重载状态、持久化中文提示和 2880 方图 4K 判定。聚焦 507/507 通过；完整 Vitest 为 235 个文件、3564 项通过，2 个性能用例按配置跳过，0 失败；全 workspace typecheck、production build、密钥/路径扫描、`git diff --check` 和 12/12 安装载荷比对通过。
- 正式安装包为 `apps/desktop-modern/dist-builder/desktop-modern/CanvasAtelier-Win10-11-x64-1.6.134.exe`，103313703 字节，SHA-256 `7423007140A87E1609F979D929E67F5FFEE7E816E3741B38CDD71F611E3C1B25`；候选与独立安装目录 EXE SHA-256 均为 `65EE6F0174CA0E2602906A9A71B58A1EA645F2BD9417615E8C0025A1A957CD28`，`app.asar` 均为 `8AFB8CB93EDBD17388471273DCCC5DC0D385A712CCC538309C6CADEA9C7AAE29`。NSIS 实际安装到 `D:\CanvasAtelier-QA-1.6.134-20260912`，注册表、桌面和开始菜单均指向该 1.6.134 目录；日用目录中多个 WorkBuddy bundled MCP 进程仍在运行，因此没有强制覆盖或终止用户会话。
- 安装版门禁全部使用 1.6.134 已安装 EXE。主题切换、GPT 2.5 单模型菜单与精确 `-4k` 路由、GPT 4K/高质量结果跨重启持久化、反推完整深度链、Agent 原生图片粘贴/发送/复制均通过，页面错误为 0；涉及 provider 的受控门禁网络尝试为 0、没有读取真实凭据或触碰真实项目。报告分别为 `work/qa-installed-theme-switch-1.6.134-final/report.json`、`work/qa-installed-gpt25-resolution-route-1.6.134-final/report.json`、`work/qa-installed-gpt-multi-provider-1.6.134-final-r2/report.json`、`work/qa-installed-mcp-video-reverse-zero-cost-1.6.134-final.json`、`work/qa-installed-agent-image-chat-1.6.134-final/report.json`。综合 GPT 脚本首轮在文件选择器持久化等待中偶发失败，未提交生成；同一安装包第二轮完整通过。此前授权的一次真实付费生图已用完，本轮没有再发真实付费生图、反推或 Agent 请求，所以原生 Gemini 上游在用户账号下的实时成功仍需用户实际操作验收。

## 2026-09-12 1.6.135 Agent 提示词、返图、对话与配色修复

- 根因：draftReverseAgentConfig 未保存 analysisDepth；普通 Codex 工作流仍用 precedingMessage.content 写入生成提示词；空创作方案由前端兜底成用户原话。补充失败回归后修复为持久化深度，并只采用模型返回的 option.prompt / 结构化反推 prompts.zh / Codex generation.prompt。空方案与原话回显不执行。保留确认后才创建和运行节点的边界。
- 结果卡改为同一执行消息更新状态，关联节点摘要；终态提示不再作为下一次模型请求的需求内容。新方案在现有图右侧独立排布，节点带方案编号和摘要，参考输入就近创建且只连接明确选用的资产，不移动旧图或删除旧素材。
- 默认引用菜单只展示粘贴、当前选中和本对话用过的素材，用户主动选择“浏览项目图片”才展开项目全部素材；传给 provider 的引用仍严格来自发送消息的 citations。
- 返图支持全窗口 portal 预览、缩放和原生剪贴板复制。实际桌面复现过预览受侧栏限制及预览按钮被 composer 遮挡，修正 portal 层级；对话移除嵌套滚动，消息不再被 flex 压缩。深色消息气泡适配主题；方案按钮默认 #173c39 / #97f0df，选中 #41c7b5 / #072c2a，禁用不用整体透明度降低文字可读性。
- 回归文件：SkillChatWorkbench.test.tsx、creative-plan.test.ts、CanvasWorkspace.test.tsx、ModuleNodeCard.test.tsx、app-store.test.ts。最终 renderer 95 文件 1762 测试通过；desktop-shells 包装/入口 2 文件 21 测试通过；npm.cmd run build 包含全 workspace 类型检查与全部生产构建，通过；git diff --check 通过。
- 构建环境：根 package.json 错为 desktop manifest，先备份到 work/root-package-before-workspace-repair-20260912.json，再恢复与锁文件一致的 workspace manifest，解决 No workspaces found。根 node_modules/electron 实际为 22.3.27，现代包改用本地缓存 Electron 43.1.0。旧运行时候选未交付。最终安装包从通过 QA 的 win-unpacked 直接封装，载荷 11 文件一致。
- 最终候选桌面验收：work/qa-agent-repair-1.6.135-release/report.json 通过默认/选中配色、气泡、全窗口图片预览、125% 缩放、原生剪贴板、方案提示词写入、结果回写、窄窗口与重启恢复；work/qa-agent-repair-reverse-1.6.135-release.json 深度反推受控链通过。所有实测均隔离项目、无付费 provider 调用、无页面错误。对象为候选 win-unpacked 程序，不能描述为日用安装副本已更新。
- 交付：apps/desktop-modern/dist-builder/desktop-modern-1.6.135-agent-prompt-repair-release/CanvasAtelier-Win10-11-x64-1.6.135.exe，103315683 字节，SHA-256 4793C2A7C2FD61B2E8A66FBB4C051FDB5B9FBCCEF7FC780C987F097C0F555B0B。app.asar 为 E6B2071A0E69B850249201791B5C7B36E415ED901B6C261DD04F31272BA42F4C。本次未运行 NSIS、未覆盖日用安装目录、未改快捷方式。完整矩阵见 work/agent-repair-1.6.135-acceptance.md。
- 证据纠正：此前只读诊断中的 502/503/余额错误属于 image jobs，不足以认定反推上游故障。真实用户模型的实时成功仍未验证。

## 2026-09-12 GitHub v1.6.135 正式发布与后续反推诊断

- 用户明确要求“发布GH”后，已将 v1.6.135 发布为 GitHub 正式 Latest：https://github.com/19960726/canvas-atelier/releases/tag/v1.6.135 。发布时间 2026-09-12T08:52:48Z，非 draft、非 prerelease。三个资产大小与 SHA-256 在公开前逐项匹配；latest.yml 内版本、EXE 路径、大小与 SHA-512 一致。发布回执 work/release-1.6.135-published.json，上传核对 work/release-1.6.135-uploaded-assets.json。
- 本次沿用二进制发布，tag 指向远端 main 的 3bc58aeb911ced49eccddbf1be493df9798043fd；未把混合工作树批量提交。Release notes 明确 Source code 归档不代表安装包完整源码。未自动安装或覆盖用户日用副本。
- 发布期间用户继续报告真实反推失败。只读检查确认当前运行进程来自 D:/CanvasAtelier-QA-1.6.134-20260912/Canvas Atelier/Canvas Atelier.exe。活动项目稳定快照 revision 747 中，对应节点 module-reverse_agent-1789119887483-1 的 modelRoute=comfly-gemini-3-1-pro-preview-customtools，analysisDepth=deep，startedAt=2026-09-12T08:51:16.662Z，completedAt=2026-09-12T08:52:18.892Z，failed，reverseAgentError=Provider request failed，无结果。没有读取凭据、改动项目或发起模型请求。
- 截图“模型已返回内容，但反推结果格式无效”对应 PROVIDER_INVALID_RESPONSE 的兜底文案。上游响应 envelope 无效或反推结果校验失败均可能进入此路径；不能凭文案断言已获得完整可用分析，也不能断言是素材数量、超时或用户提示词导致。持久化错误缺少细分原因，尚未取得本次原始响应。1.6.135 的受控通过不构成本次真实失败已修复的证据。

## 2026-09-12 反推失败原因传递修复与真实请求限制

- 已复现的程序缺陷：desktop-persistence.createDisplaySafeProviderError 只保留 code/retryable，将后台 TRUNCATED、NO_TEXT、INVALID_JSON、CORE_SCHEMA_INVALID、IDENTITY_MISMATCH、MEDIA_RESPONSIBILITIES_INVALID 六种 reason 全部丢弃，app-store 再持久化为 Provider request failed。新增六项桌面边界回归均先失败；新增保存失败原因回归先失败。修复为只透传应用白名单 reason，使用共享 reverse-failure.ts 生成中文错误并持久化。ModuleNodeCard 即时与恢复后的错误说明一致；无明确 reason 时不再声称模型已经返回正文。
- 真实验证遇到 ERR_CONNECTION_CLOSED 后，又补了先失败的桌面边界回归。现在连接关闭、重置、代理连接/隧道失败、DNS 失败可保留有限错误代码并显示中文说明；URL、密钥、任意上游文案仍不进入错误气泡。未更改严格 JSON、核心结果、运行身份和素材职责校验，未将无结果伪装为成功。
- 用户先授权 1 次真实反推，隔离 UI 副本启动目标节点后主进程连接断开，没有取得可靠的请求/响应计数；work/reverse-real-20260912/intent.json 保存了提交意图，禁止重发。原项目没有写入，本次副本由 revision 747 克隆。不能宣称该次已计费，也不能宣称没有计费。
- 随后用户明确追加授权 1 次。独立 Electron 43.1.0 探针先以原 10 图、原任务、deep 模式在离线 fixture 上验证捕获链；再调用同一 comfly-gemini-3-1-pro-preview-customtools 路线。当前配置是 chat/vision/reverse_prompt，通过 /v1/chat/completions 请求，max_tokens=16384，10 张图共 5272334 字节。work/reverse-probe-live-20260912/network-intent.json 记录唯一请求，result.json 为 PROVIDER_ERROR / net::ERR_CONNECTION_CLOSED，未收到正文、未生成 response.json。没有自动再调用。相关探针默认离线，live 标记和独占意图文件防止误调用。
- 之后仅做未带凭据的 GET 连通性检查，系统代理与隔离 direct session 都得到 HTTP 401（work/reverse-network-preflight.json）。这只说明地址可达，不能证明 POST 生效或原格式失败已修复；没有修改系统代理。
- 最终验证：renderer 95 文件 / 1770 测试通过（work/reverse-failure-renderer-final.log）；npm run build（全 workspace 类型检查及全部生产构建）通过（work/reverse-failure-build-final.log）；git diff --check 正常配置下通过。切勿用临时关闭 core.autocrlf 的结果将既有 CRLF 文件整体转换。
- 本轮交付状态：源码错误传递/持久化修复完成；原截图那次模型正文的确切格式错误仍未知，真实反推成功未验证。本轮未制作新安装包、未覆盖安装副本、未更新 GitHub v1.6.135，不得标记为“反推彻底修复”。矩阵见 work/reverse-failure-20260912-acceptance.md。下一步需要实际反推响应作为固定离线回放样本；不可将本轮未成功捕获的请求偷偷重发或复用额度授权。

## 2026-09-12 单次隔离直连验证结果

- 在已明确说明“隔离直连、相同十图/任务/deep、只请求一次”的下一步后，用户回复“下一步”；按此范围执行一次，未修改系统代理、未额外重试。新请求目录 work/reverse-probe-direct-20260912，已有独占 network-intent.json，禁止覆盖后重新提交。
- 请求开始 2026-09-12T09:53:33.186Z（北京时间 17:53:33），在 09:58:33Z / 北京时间 17:58:33 超时。结果为 PROVIDER_ERROR，Comfly request timed out after 300000ms，count=1；无 response.json 或 transport-response.json，未取得完整模型正文。模型仍是 gemini-3.1-pro-preview-customtools，10 图，deep，max_tokens=16384。
- 系统代理路径曾返回 ERR_CONNECTION_CLOSED，本次隔离直连达到 300 秒超时：这是两个网络路径的观察结果，不能据此断言代理是唯一根因，也不能推断原截图的 JSON 解析问题已解决。计费情况无法由超时判断。
- 新增 work/replay-reverse-response.ts 离线诊断工具，读取已经捕获的响应而不访问模型；本次无正文，未对本次运行该回放。work/reverse-provider-support-20260912.md 为可交给服务方的脱敏排查摘要，未发送给外部人员。本轮未更改生产代码、未发布或安装新版本；此前源代码测试/构建记录仍保持原有验证边界。

## 2026-09-12 独立探针路由遗漏纠正

- 发现验证程序缺陷：work/reverse-probe.ts 未启用正式 main.ts 使用的 discoverModelCatalog，导致前两个独立付费探针按旧持久配置走 Chat。之前“当前配置是 chat”仅描述持久配置，不能推断生产实际路由。原截图响应和当时路由仍未捕获，不能把 Chat 超时当作原生反推失败根因。
- 只读审计 work/reverse-route-audit.ts 使用相同凭据存储和生产服务，在隔离 system/direct session 中调用 listAvailableModelIds 触发运行时目录发现（listProfiles 在已有配置时不会主动发现）。8 个 GET 均 200，两组运行时 profile 均有 gemini_native，当前正式路径应为 /v1beta/models/gemini-3.1-pro-preview-customtools:generateContent。证据 work/reverse-route-audit-20260912.json；本轮付费 POST 为 0。
- 先添加 work/verify-reverse-probe.mjs，旧探针因 Chat 路径不等于原生路径失败。探针现启用生产目录发现，GET 仅放行三种目录路径，POST 前核对发现的原生能力与确切路径，live 必须显式提供已核对路径；已有 network-intent.json 时在重写 request.json 前退出，意图文件始终独占创建。GET 响应不会覆盖模型正文捕获。未改变生产请求/解析行为。
- 零费用回归通过：原快照 10 张素材、deep、16384 输出预算、application/json、原生响应捕获及 thought 排除、再次启动拒绝且原请求证据不变。证据 work/reverse-probe-route-fixture-9em3UP；离线回放核心 schema 通过，缺少专业章节如实为 partial，不是完整深度成功。命令：设置隔离 REVERSE_QA_ROOT 后 node work/verify-reverse-probe.mjs；node work/replay-reverse-response.cjs work/reverse-probe-route-fixture-9em3UP。
- 验收矩阵和本地服务方摘要已纠正路由范围，未对外发送。本轮没有新增付费请求、安装或发布；不得复用已用完的真实验证授权，也不得宣称原模型反推已彻底修复。
- 本轮新验证：provider-model-catalog 与 provider-bridge 共 2 文件 / 158 测试通过，日志 work/reverse-route-regression-20260912.log；解析专项见 work/reverse-parser-regression-20260912.log；git diff --check 退出码 0。本轮仅修改诊断程序和记录，没有改变生产源码，未重新打包。

## 2026-09-12 真实原生回复定位 mention 合同缺陷

- 用户在明确说明单次原生调用范围后回复“下一步”，已执行这 1 次授权。work/reverse-probe-native-20260912/network-intent.json：10 张原图、deep、16384 输出预算、JSON MIME、原生 generateContent，2026-09-12T10:56:27.461Z 提交，11:01:10.060Z 收到 HTTP 200。count=1；无自动重试。原始脱敏 response.json 与初始失败 result.json 均保留。
- 本次真实结束原因为 STOP，正文 16515 字符，JSON 和结果 schema 均通过，但 domain 校验抛 MEDIA_RESPONSIBILITIES_INVALID。10 个 sourceId 全部正确；模型把 @图片N 放在 label，没有 mention。根因是 professional-reverse-analysis.ts 的 REQUIRED_OUTPUT.mediaResponsibilities 漏了 mention，而 domain 的逐张覆盖校验要求 mention。不是用户未启用深度，也不是缺图或本次回复被截断。
- 修复：输出模板明确要求复制 mediaManifest 的 mention；解析器仅在 mention 缺省且 sourceId 与本次 orderedMedia 唯一匹配时补齐编号。按素材 order 排序，图片/视频分别编号，不按回复数组顺序猜测。显式错误 mention、错误 ID、遗漏素材仍严格失败；重复 sourceId 的歧义不推断；不放宽运行身份和核心结构校验。
- 回归先红后绿：professional-reverse-analysis.test.ts 检查输出合同，reverse-provider-result.test.ts 复现真实缺字段、验证乱序/混合媒体/重复 ID，以及显式错误不被掩盖。focused 25 项通过；扩大 desktop-core/domain/desktop-modern：120 文件通过、2 性能文件按默认跳过，1617 测试通过。全 workspace 类型检查与构建通过（work/reverse-mention-build-20260912.log）；首次构建暴露测试 fixture 的视频联合类型不完整，已修正为真实区分结构后重新通过。
- 真实回复经新解析器离线回放成功，10 个 mention 全部恢复，正向提示词与分析保留；模型额外返回的 seedance25 视频章节结构不完整，completeness 仍如实为 partial，不影响可用图片结果。重放没有再次调用模型。可读恢复结果 work/reverse-restored-prompt-20260912.md。
- 版本推进至 1.6.136；候选构建脚本 work/build-reverse-mention-20260912.mjs 使用 Electron 43.1.0、独立输出目录，不覆盖原 1.6.135 发布文件。程序内回放脚本 work/qa-packaged-reverse-real-response-20260912.mjs 只复制项目素材/原始稳定点，不复制真实凭据，使用假 token 与本地 transport fixture；已核实打包解析器、反推按钮、10 图映射、提示词界面通过。保存/重启以最终报告为准，不能从源码通过推断安装验收。

## 2026-09-12 反推结果合同相邻边界收紧

- 归一化器原先会把空的标准列表字段视为已经命中，导致后续有效的 `keyword`、`negativePrompt` 或 `checklist` 别名被遮蔽。现在逐个候选提取，只有得到至少一项有效文本才停止；已有非空标准字段仍优先。
- 多素材运行现在必须返回 `mediaResponsibilities`，并与本次 `orderedMedia` 的图片/视频编号和 sourceId 一一对应；额外编号、重复编号、未知素材、无编号条目、错配和遗漏都会失败。单素材旧响应仍可省略该章节，真实响应中 mention 缺失时仍只按唯一 sourceId 恢复，不按回复顺序猜测。
- `materialsAndTextures`、`subjectScaleAndPlacement`、视频运行的 `videoTimeline` 以及 `evidence.observations` 为空时，完整度会把对应章节列入 `invalidSections`，不能标为 complete。允许为空的特效、流体和不确定项没有被误判为缺失。
- 若结果包含 Seedance 2.5 章节，其 `assetBindings` 必须对本次运行素材逐项且仅绑定一次；遗漏、重复或未知 sourceId 会沿用素材职责失败类型。未出现 Seedance 章节的旧结果不受影响。
- TDD 证据：`work/reverse-contract-red-20260912.log` 记录旧实现 4 项失败；最小修复后 `work/reverse-contract-green-20260912.log` 为 2 个文件、43 项全部通过。扩大回归首次发现 4 个 provider bridge 成功 fixture 仍返回“多素材但无职责表”，只更新共享 fixture 后 `work/reverse-contract-provider-bridge-20260912.log` 为 124/124，最终 `work/reverse-contract-broad-green-20260912.log` 为 domain/desktop-core 109 个文件、1555 项通过，2 个性能文件按设计跳过；两包 typecheck 见 `work/reverse-contract-typecheck-20260912.log`。该轮没有修改版本和打包脚本，也没有发起真实 provider 请求。

## 2026-09-12 Agent 返图预览键盘与缩放边界

- 根因：全屏返图预览虽已使用 portal，但打开后焦点仍留在被遮挡的底层缩略图，没有为该 modal 绑定 Escape 关闭和 Tab 边界；数值虽夹在 100%-300%，到达边界后缩放按钮仍显示为可操作。
- 保护行为：预览打开后焦点进入关闭按钮，Tab/Shift+Tab 不会逃出对话框；Escape、关闭按钮或背景关闭后均将焦点返还原缩略图。缩放仍以 25% 步进，并在 100%/300% 时禁用对应按钮；原生图片剪贴板复制路径不变。
- 回归位置：`apps/renderer/src/agent/SkillChatWorkbench.test.tsx` 的生成结果预览用例。聚焦命令为 `npm.cmd exec -- vitest run --config vitest.config.ts apps/renderer/src/agent/SkillChatWorkbench.test.tsx -t "opens and copies a generated image"`；`npm.cmd exec -- tsc -p apps/renderer/tsconfig.json --noEmit` 通过。本项没有调用真实 provider。

## 2026-09-12 Agent 深色对话运行时颜色门禁

- 截图中的白色 Agent 方案消息来自发布布局层对 assistant 气泡的硬编码 `#fff`；当前末端深色主题覆盖已改用 `--gate-card`、`--gate-card-muted`、`--gate-text` 与 `--gate-muted`，并同时覆盖用户气泡和思考状态。真实 DOM 计算样式验收确认该覆盖位于最终导入顺序且实际生效，本项无需再增加 CSS 覆盖。
- 新增 `tests/e2e/agent-dark-theme.spec.ts`，在本地存储注入包含用户消息和完整创作方案的对话，打开真实 Agent 面板后检查用户/assistant 气泡、要求卡、方案卡、流程卡及方案按钮的计算背景均为不透明深色；同时检查摘要、要求、观察、方案、流程、详情和按钮文字与逐层合成后的实际背景对比度均不低于 4.5:1。
- 验证：Playwright `agent-dark-theme.spec.ts` 1/1 通过；`main.styles.test.ts`、`theme-tokens.test.ts`、`release-layout-contract.test.ts` 共 3 文件 88/88 通过。全部使用本地持久化 fixture，未调用 provider、未打包、未安装或发布。

## 2026-09-12 Agent 上下文、提示词与长对话边界补强

- 真实桌面聊天合同限制每条消息最多 8000 字，但工作台先前把用户正文、创作规划说明和最多 6000 字反推上下文拼接后只按 16000 字检查，mock 测试会通过而真实 bridge 会拒绝。现在先完整保留用户正文与必要规划说明，再按剩余额度生成反推上下文；最终请求由 `ChatSkillBridgeRequestSchema` 直接回归，保证最后一条消息不超过 8000 字。正文与必要规划本身超限时明确要求分段，不静默截断用户要求。
- 反推上下文继续遵守选择边界：选中反推节点时最多使用三个；选中其他节点时不注入；无画布选择时只使用最近完成的一项。新的长度参数只压缩补充上下文，不改变可见节点筛选和完成时间排序。
- Agent 方案与 Codex 工作流共用生成提示词质量门禁：去除 `@图片/@视频` 标记、空白和标点后检测原话完全复制、原话外包聊天套话和高重合微改；同时拒绝只有“产品图”一类缺少执行细节的短提示词。有效提示词需有足够信息量和多项执行细节，确认后写入生成节点的仍是模型分析后的 prompt，不使用用户原话兜底。结构化反推结果仍需先通过独立反推合同。
- 手工导入或粘贴得到的默认图片引用在切换/新建任务时清空，其他任务的临时素材不会出现在新任务默认 `@图片` 菜单；项目全部图片仍只能由用户主动点“浏览项目图片”展开。已发送消息自己的引用快照仍随该对话保存。
- 长对话裁剪不再简单丢掉最旧 48 条之前的所有记录。每个 `canvas-result:<nodeId>` 结果标记保留最新一份，再用最近普通消息补足 48 条；节点摘要以 `canvasNodeLabel` 随标记持久化。重启后即使画布节点已删除，也会显示原任务名称并明确标为“节点或结果已不存在”，不会假装一直运行。
- TDD 证据：`work/reverse-boundary-red-20260912.log` 先稳定记录结果标记、提示词套话/过短、孤儿结果、跨任务素材六项失败；单独加长上下文后记录 8772 字真实合同失败。修复后 `work/reverse-boundary-green-20260912.log` 为 4 个文件 201 项通过，后续增加预算和纯函数断言后的最终聚焦日志以最新验证为准。本轮边界测试和修复均未调用真实 provider。

## 2026-09-12 NewAPI 与 RelayMe 深度反推预算一致性

- 根因：Comfly 的反推节点和 Agent 视觉分析已经按深度读取共享预算，但 4D/NewAPI 的反推节点把聊天超时固定为 180 秒且请求体没有 `max_tokens`；其 Agent `chatSkill` 分支又完全忽略 `visualAnalysis` 与 `reverseAnalysisDepth`。RelayMe 反推节点和 Agent 视觉分析虽固定使用 300 秒视觉超时，也都没有输出 token 预算；Agent 构造系统指令时还漏传了深度。用户选择“深度反推”后，这些独立 provider 路线因此没有完整使用 deep 档的 16384 token / 300 秒合同。
- 保护行为：4D/NewAPI 与 RelayMe 的反推节点，以及 `visualAnalysis=true` 的 Agent 对话，现在都通过 `resolveReverseAnalysisBudget` 读取同一 fast/standard/deep 映射；deep 请求明确发送 `max_tokens: 16384` 并把单次传输超时设为 300000 ms。RelayMe 同时把 `reverseAnalysisDepth` 写入视觉分析系统指令。4D 非视觉普通聊天仍是既有 180 秒且不发送 `max_tokens`；RelayMe 非视觉普通聊天仍使用客户端默认 30 秒且不发送 `max_tokens`，普通带图但未启用视觉分析的路径继续保持既有视觉超时。
- TDD 与验证：`packages/desktop-core/src/newapi-provider-service.test.ts` 和 `packages/desktop-core/src/relayme-provider-service.test.ts` 先分别复现反推节点的 180000 ms/缺少 `max_tokens`，随后又复现 Agent 深度视觉分析的两项 `max_tokens` 缺失；普通对话断言同时保护原预算。修复后连同 `newapi-client.test.ts`、`packages/provider-relayme/src/client.test.ts` 共 4 文件 150/150 通过。验证命令为 `npm.cmd exec -- vitest run --config vitest.config.ts packages/desktop-core/src/newapi-client.test.ts packages/desktop-core/src/newapi-provider-service.test.ts packages/desktop-core/src/relayme-provider-service.test.ts packages/provider-relayme/src/client.test.ts`；扩大到 desktop-core 和 provider-relayme 全套为 91 文件通过、2 个性能文件按设计跳过，1334 项通过、2 项跳过；两包 `tsc --noEmit` 均通过。全部响应来自本地 fixture，没有调用真实 provider、没有消耗额度，也没有改版本、打包、安装或发布。

## 2026-09-13 1.6.136 反推、Agent 工作流与整理画布发布候选

- 真实十图 Gemini 原生响应的失败根因已固定为 `mediaResponsibilities[].mention` 缺失：响应 HTTP 200、STOP、正文 16515 字符且 JSON/核心结构均有效，但严格素材职责校验拒绝了缺少编号的条目。解析器只在 `sourceId` 对当前有序素材唯一匹配时补齐 `@图片N/@视频N`，乱序、重复、错 ID、显式错误 mention 仍失败；离线回放不再重发模型。
- 快速/标准/深度反推按钮现在分别使用 4096/8192/16384 token 与 90/180/300 秒预算，Comfly Gemini 原生、Comfly chat fallback、4D/NewAPI、RelayMe 和 Agent 视觉分析都读取共享预算；Codex 路线显示实际 reasoning effort，不伪造反推深度。所有反推模型目录通过能力选择与 provider 合同回归，未调用真实 provider。
- Agent 创作对话先分析需求、参考证据、未知项、模型能力和验收标准，再生成 1 至 3 个有差异的方案；确认后只把模型生成的可执行 prompt 写入生图节点，不复制用户原话、聊天套话或 `@图片` 标记。默认引用只包括本次粘贴/导入、当前选择和本对话已用素材，浏览项目图片需用户主动展开；每个任务的引用编号独立从 `@图片1` 开始。节点按“方案 N · 摘要”命名，结果消息与节点一一对应，长对话不会把旧终态当作新需求。
- Agent 结果预览使用全窗口 portal，支持 100%–300% 缩放、Escape/Tab 焦点管理和原生剪贴板复制；深色气泡、方案按钮和输入区使用一致的 gate token。终态返图出现后消息流自动滚到底部，长方案不会被底部输入框遮住。
- 新增“整理画布”工具栏按钮：按连线依赖从左到右分层，断开节点和环也用稳定排序，所有节点含锁定节点都参与；一次点击生成单个可撤销事务并自动 fitView，位置持久化后重启保持。`auto-layout.test.ts` 覆盖 DAG、环和断开图，`visual-layout.spec.ts` 覆盖真实节点、撤销、保存和重开。
- TDD/验证：整理画布单测 2/2；Agent/模型/反推规划单测 249/249（其中 `SkillChatWorkbench` 172/172）；源级 Playwright 42/42；全 workspace Vitest 237 个文件通过、2 个按设计跳过，3,622 项通过、2 项跳过；根目录全 workspace typecheck 及 production build 通过。候选安装态反推回放 `work/qa-reverse-mention-packaged-r12-20260913/report.json`、Agent `work/qa-agent-repair-1.6.136-final3/report.json`、GPT 多供应商 `work/qa-installed-gpt-multi-provider-1.6.136-final3/report.json`、GPT 2.5 精确 4K `work/qa-installed-gpt25-resolution-route-1.6.136-final3/report.json`、图片路由 `work/qa-packaged-image-route-result-1.6.136-final3/report.json` 均通过；所有候选 QA 网络尝试为 0、付费调用为 0、真实项目未触碰。
- final3 候选位于 `apps/desktop-modern/dist-builder/desktop-modern-1.6.136-reverse-mention-repair-final3`。NSIS 安装器 `CanvasAtelier-Win10-11-x64-1.6.136.exe` 为 103320704 字节，SHA-256 `1CE03F62C07265FF3F0003C4EDD6531AA4B81DF9313CD2E8BAA465728AE2FF8`；blockmap 为 109646 字节，SHA-256 `6AD80129EE95720C9AFEF15063D3866313ABCC068BCEE2BD477663F66067CCEE`；`latest.yml` 为 375 字节，SHA-256 `FDC4E0B8BA2C766AAA0B66CE6E7CA4D0D6D36AEFA8D91177A1157C3EF57AC6F7`。安装器解包 11/11 载荷与 `win-unpacked` 一致，候选 EXE SHA-256 `272C314EAFB133FB94D66269E96205A1C92B426DF27D41FC2B1AB2B6C6CE1EAE`，`app.asar` SHA-256 `616B26E6A6AFB7D9F942AAAEB43F02FB44A8F0A0CD3084E96B45F5C9A81E1297`。
- 发布范围沿用二进制-only：GitHub tag 将锚定远端 main `3bc58aeb911ced49eccddbf1be493df9798043fd`，不把混合工作区批量提交；Release notes 明确 GitHub Source code 归档不等于此安装包的完整源码。真实模型账号、实时供应商可用性和用户日用安装目录仍需独立验证，本轮不以离线 fixture 冒充 live 成功。
- 已按用户“发布GH”要求发布 `v1.6.136` 为 GitHub 正式 Latest：<https://github.com/19960726/canvas-atelier/releases/tag/v1.6.136>。标签对象为远端 main 提交 `3bc58aeb911ced49eccddbf1be493df9798043fd`，非 draft、非 prerelease；安装器、blockmap、latest.yml 三项线上 digest 与本地 final3 完全一致。发布回执为 `work/release-1.6.136-published.json`，逐项上传核对为 `work/release-1.6.136-uploaded-assets.json`。未覆盖日用安装目录，未终止用户既有进程。

## 2026-09-13 1.6.137 反推原生兜底与历史非阻塞修复

- 用户截图来自仍在运行的 `D:\CanvasAtelier-QA-1.6.134-20260912\Canvas Atelier\Canvas Atelier.exe`。该版本早于 1.6.136 的真实 Gemini 响应 `mention` 恢复修复，因此截图中的失败不能用于判断新版仍失败。1.6.137 进一步修复旧缓存模型资料：当 Comfly 目录请求临时失败、持久 profile 尚未包含 `gemini_native` 时，精确模型 `gemini-3.1-pro-preview-customtools` 只要仍具备 vision/reverse_prompt 能力，就会恢复已验证的 Gemini 原生 generateContent 路由；不对其他模型做名称猜测。
- 稳定用户目录的 `generation-history/history.index.json` 实际已有 78 条活动记录，其中 42 条成功记录及 42 个原图文件；最新的 GPT Image 2.5 Sunburst 任务为 2880×2880 且 availability=available。空窗口根因是渲染器把 `list()` 与会逐个审计/哈希原图的 `getCapacity()` 放在同一个 `Promise.all`：容量审计完成前 records 一直保持空数组。现在列表和容量独立加载，记录先显示、容量稍后更新；安装态夹具让容量 Promise 永久挂起时，记录在 170 ms 内出现且页面无错误。新稳定根不存在时也会迁移旧产品根的 generation-history 目录，已有稳定历史绝不覆盖。
- GPT Image 2.5 的 `1:1 + 4K` 按供应商精确尺寸合同映射为 `2880x2880`，约 8.29 MP；`16:9 + 4K` 为 `3840x2160`。界面里的 4K 是同像素预算分档，不表示正方形必须为 3840×3840。本次真实本地历史也记录该任务实际为 2880×2880。
- 验证：相关 6 文件 265/265，通过后全 workspace Vitest 为 237 个文件通过、2 个按设计跳过，3629 项通过、2 项跳过；全 workspace typecheck 与 production build 均通过。1.6.137 打包回放使用保存的真实十图回复和假 token，目录接口全部失败且 profile 故意不含 gemini_native 时，原生路由、深度 16384 token、10 图映射、结果提交、保存和重启恢复全部通过；GPT 2.5 4K 安装态路由通过，网络尝试 0；所有验证付费请求 0。
- 候选位于 `apps/desktop-modern/dist-builder/desktop-modern-1.6.137-reverse-history-candidate`。安装器为 103320831 字节，SHA-256 `568D30044BBAAC4596E321993F40EC70606F00D1B86C72BDBF13FEF1326530DE`；blockmap 为 109786 字节，SHA-256 `FBAFB5D7DDFF3A1798B8CE4E9BF680854B3F95FCBAFE31F3403E841FF53882A9`；latest.yml 为 375 字节，SHA-256 `DB90C9514E2C7309015D89527705E47B425C283BCE4423FB69172E7DA360D76A`。候选 EXE SHA-256 `6C1FAD2FC3738922B20B2655C7630073FD5B4EB5C149EEA2663F5236ECF4E628`，app.asar SHA-256 `FA33BBED9B2DE808391B3F9864EEF3A92F075E39F088869ECF664B3E535B891E`；安装器解包 11/11 载荷一致。未覆盖或终止用户当前 1.6.134 进程。
- 已发布 GitHub 正式 Latest `v1.6.137`：<https://github.com/19960726/canvas-atelier/releases/tag/v1.6.137>。与此前二进制-only 发布不同，本次 97 个明确范围源码/测试/文档文件先在隔离副本提交并推送到 `feature/canvas-agent-mvp`，发布标签核实指向对应源码提交 `4698059a78dd873ab0349764a2005df18e0555f4`。干净副本全量结果为 237 个测试文件通过、2 个性能文件按设计跳过，3629 项通过、2 项跳过，typecheck 与 production build 通过；Windows 干净检出额外暴露的 1.6.136 版本断言和仅接受 LF 的旧壳测试已在发布前修正。Release 三项资产大小及 GitHub digest 与本地完全一致，回执见 `work/release-1.6.137-published.json`。

## 2026-09-13 1.6.138 深度反推超时与统一图片细节预览

- 用户节点保存的真实失败不是解析错误，而是 `Provider request timed out after 300000ms`：十图 deep 运行在 300 秒供应商传输边界被终止；同一真实 Gemini 原生回复历史耗时约 282.6 秒，原预算没有足够结算余量。源码还存在第二层固定 315 秒 renderer operation timeout，即使只延长供应商层，deep 仍会被外层提前截断。
- 快速/标准/深度反推现在分别使用 4096/8192/16384 输出 token 和 180/360/600 秒供应商超时；renderer 对应使用 195/375/615 秒，给 IPC、解析和持久化预留 15 秒。Comfly Gemini 原生与 chat、4D/NewAPI、RelayMe、Responses/Agent 视觉分析均通过共享预算；没有增加自动重试，不会因超时再次消耗额度。
- 画布新增持续可见的文字按钮“整理画布”，保留侧栏整理图标；侧栏正式为八按钮、442px 高。整理按连线层级排列全部节点，单次事务可撤销并持久化。素材输入、连接缩略图、结果节点和生成图片统一双击进入全屏细节预览，右上角显示受管资产精确 `宽 × 高 px`，支持滚轮缩放、放大后拖动、键盘重置、Escape 关闭、前后翻页和直接原生复制；复制失败会保留可见错误，不再静默关闭菜单。
- TDD 先复现旧 300/315 秒预算、缺少文字整理入口、素材双击无预览、预览无尺寸/直接复制；修复后聚焦 Vitest 6 文件 762/762，通过全 workspace Vitest 239 个文件、2 个性能文件按设计跳过，3635 项通过、2 项跳过；全 workspace typecheck 与 production build通过。源级 Playwright 新增生成图与 2400×1600 素材预览、尺寸、复制入口、焦点/Escape及整理持久化回归。全量 173 项首次运行有 168 项通过，5 项旧七按钮/390px 契约失败；更新为八按钮/442px 后对应 5/5 通过。全部 provider 验证使用本地 fixture 或已保存回复，新增真实付费请求为 0。
- 当前用户运行中的程序仍是 `D:\CanvasAtelier-QA-1.6.134-20260912\Canvas Atelier\Canvas Atelier.exe`，不包含上述 1.6.138 修复。源码、候选包、安装态和 GitHub 发布必须分别验收；不得把源码通过描述成旧运行进程已更新。
- 干净发布副本最终全量 Playwright 为 173/173；候选 `win-unpacked` 的隔离交互验收 `work/qa-packaged-reverse-preview-1.6.138-r15/report.json` 通过，确认持续可见的“整理画布”按钮会产生持久化提交，2400×1600 素材图与 1024×1024 生成图均可双击预览并显示精确尺寸，原生复制桥接收到图片字节。原十图 deep 项目使用已保存真实响应的离线回放 `work/qa-packaged-reverse-real-response-1.6.138/report.json` 通过：10 个素材映射、16384 输出预算、提示合同、结果写回、稳定点保存和重启恢复全部成立；两项候选验收的外网尝试和付费请求均为 0。
- 1.6.138 候选位于 `apps/desktop-modern/dist-builder/desktop-modern-1.6.138-reverse-preview`。NSIS 安装器为 103321514 字节，SHA-256 `ACD1A5D682840936DC984AB563D9CDBF4907DC15FDC191C83DDCE085C622CBE5`；blockmap 为 109900 字节，SHA-256 `F73F6793B4D78D0786A9582DDD06556CDC76D7335B70ED241286E5C2B41326F0`；`latest.yml` 为 375 字节，SHA-256 `9B13C2F604F40EB3690BDB76E6F152DA791F6B27044298C42A22AD3232D8A996`。候选 EXE SHA-256 `7029D3496DB5625366A93AFBB2D19E4C2E9620A23AA1BAC6BAF24A92CF7619E0`，`app.asar` SHA-256 `093AC332AC8CD380B0F502FD2C75B2C1A8A2B0DB9B251E7E8D5908A7FBA101C8`；安装器解包 11/11 载荷与已验收候选一致。安装器和候选 EXE 的 Authenticode 均为 `NotSigned`；当前尚未覆盖用户日用 1.6.134。
- 已发布 GitHub 正式 Latest `v1.6.138`：<https://github.com/19960726/canvas-atelier/releases/tag/v1.6.138>。标签指向已验收源码提交 `cbbc50e692d99fcea112a63ec0fe1988adfa3488`，非 draft、非 prerelease；安装器、blockmap 与 `latest.yml` 的 GitHub size/digest 和本地产物逐项一致，回执见 `work/release-1.6.138-published.json`。发布没有安装或终止用户当前 1.6.134 进程。

## 2026-09-14 1.6.139 画布整理、图片引用、Alt+Z 与持久化分类修复

- “整理画布”对同一依赖层中的多个节点按接近正方形的行列网格排布，单个素材仍对应单个节点；布局保持稳定、无重叠，一次点击仍只产生一个可撤销事务。真实浏览器回归覆盖整理、`Alt+Z`、保存和重开。
- 图片生成提示编辑器支持在原有正文任意光标位置插入多个不同的 `@图片N` 引用，重复操作不会覆盖正文或旧引用；提交时保持不同素材 ID 的有序集合。编辑器原生 `Alt+Z` 与画布全局 `Alt+Z` 各自作用于正确的撤销域。
- 获得 `executeAiGeneration` 权限的 MCP 客户端第一次调用 `canvas_run_node` 运行生图节点时直接开始任务，不再弹人工确认；视频与反推仍保留独立确认。1、4、9 张图片都拆为可追踪的独立单图任务，MCP 返回的任务总数和 ID 与实际入队完全一致；受保护工作流和删除确认没有放宽。
- journal 写入器把非法 project id、base revision、事务类型/结构以及同 transaction id 不同内容等调用方错误归类为不可重试 `INVALID_REQUEST`；磁盘校验和、序号、revision/project 不一致、损坏完整行和不确定回滚仍归类为 `CORRUPT_JOURNAL`。非法请求不会修改 journal 或稳定点，随后合法提交从 revision 1 正常继续。
- renderer 持久化入口在 IPC 前拒绝 foreign `projectId`、`previousProject.id`、`nextProject.id`；延迟到达的 `REVISION_CONFLICT`/`INVALID_REQUEST` 刷新结果由项目 session 与 generation 边界隔离，不能在切换项目后覆盖新项目。
- 干净发布副本的最终完整 Vitest 为 239 个文件通过、2 个性能文件按设计跳过，3659 项通过、2 项跳过；完整 Playwright 173/173、workspace typecheck、production build、QA 脚本语法检查与 `git diff --check` 通过。最终源码复审无 Critical/Important。
- 1.6.139 候选位于 `apps/desktop-modern/dist-builder/desktop-modern-1.6.139-canvas-bugfix`。NSIS 安装器 103322744 字节、SHA-256 `343278E01CA5F2F44584CF907ED28F3189836AFA9EA6AEADED5DF1562CC42D33`；blockmap 109883 字节、SHA-256 `F7CD036D541409B1E728D6BF1E624073666E2F5D770024A8B9C583CC311C1C6A`；`latest.yml` 375 字节、SHA-256 `D507100E97CB9C3B4FF67CE484E8AE1DA7A4A078D84905698DBA64384DF9DD4C`。候选 EXE 225448960 字节、SHA-256 `FA1CE39BE110A9B1ACB17DBDD1245A98F854044063D570238D931BEBD3C1229C`；`app.asar` 6073124 字节、SHA-256 `73249BD0B3A6674CCD9A6DA6D2814322C14C698F60277F30E4F2A93C2784E913`；安装器、候选 EXE 与安装版 EXE 均为 `NotSigned`。
- 候选隔离验收 `work/qa-packaged-canvas-bugfix-1.6.139-candidate-r13/report.json` 与独立安装版验收 `work/qa-packaged-canvas-bugfix-1.6.139-installed-r2/report.json` 均为 `passed`：近方形行列、两张不同引用及光标后中英文正文保留、编辑器/画布 Alt+Z、保存重开、真实主进程 `INVALID_REQUEST`、合法后续提交和稳定点恢复、素材/生成图预览与复制全部通过。两轮都以本地 harness 执行 MCP 生图，首次调用无确认并返回 9 个唯一任务 ID；它们与 9 个实际提交 ID 完全一致，每个提交 `outputCount=1`。外网尝试 0、页面错误 0；未调用真实付费 provider。
- NSIS 退出码 0，独立安装目录为 `D:\CanvasAtelier-QA-1.6.139-20260914`；候选 85 个文件与安装目录逐项同哈希，0 缺失、0 不一致，唯一额外文件为卸载器。HKLM 卸载项版本为 1.6.139，公共桌面与开始菜单快捷方式均指向该目录。该安装证据不等于真实供应商付费生成或 Photoshop COM 写入已验证。
- 已发布 GitHub 正式 Latest `v1.6.139`：<https://github.com/19960726/canvas-atelier/releases/tag/v1.6.139>。注释标签剥离后指向已验收源码提交 `711fd1c63b2c4d385849bd1950673e9ffaaf610f`，非 draft、非 prerelease；远端安装器、blockmap 与 `latest.yml` 的 size/digest 和本地产物逐项一致，回执见 `work/release-1.6.139-published.json`。

## 2026-09-14 1.6.140 GPT Image 2.5 异步恢复与工作流分组整理

- 1.6.139 的本地生成历史显示 GPT Image 2.5 在同一安装版本内先成功后连续失败，因此不是模型被版本删除。根因是六个 Flare/Sunburst 1K/2K/4K 缓存 profile 缺少 `async_tasks`，Provider Bridge 因而把 Comfly 已记录的异步模型错误地提交到长时间同步 `/v1/images/generations`。现在只对六个精确、完整且已有 `image_generation` 的 model id 补齐 `async_tasks`；旧缓存和新目录都会迁移到 `?async=true` 提交及既有任务轮询，不增加自动重试，也不扩大到名称相似模型。
- 1.6.139 的近方形布局按全画布依赖层统一排布，导致所有素材、生成节点和结果分别聚集在不同区域。现在先按无向连通关系划分工作流组，再在每组内按依赖从左到右分层、让短列垂直居中，最后把完整工作流作为不可交错的紧凑单元排布；共享素材、多对一、环和断开节点仍保持确定性、有限坐标与无重叠，整理仍是单次可撤销事务并可保存重开。
- 回归位置：`packages/desktop-core/src/provider-bridge.test.ts` 覆盖旧 GPT Image 2.5 profile 的能力迁移及精确 `?async=true` 提交；`apps/renderer/src/test-mode/comfly-audited-models.test.ts` 固定六个离线 profile；`apps/renderer/src/canvas/auto-layout.test.ts` 覆盖两条独立素材-节点-结果链不交错及多素材消费者居中。TDD 红灯分别复现缺少异步能力和全局层级交错。
- 验证：聚焦命令 `npm.cmd exec -- vitest run --config vitest.config.ts apps/renderer/src/canvas/auto-layout.test.ts packages/desktop-core/src/provider-model-catalog.test.ts packages/desktop-core/src/provider-bridge.test.ts` 为 3 文件 167/167；完整 `npm.cmd test` 为 239 个文件通过、2 个性能文件按设计跳过，3661 项通过、2 项跳过；`npm.cmd run typecheck`、`npm.cmd run build` 以及 Playwright `npm.cmd run e2e -- tests/e2e/visual-layout.spec.ts -g "整理画布"` 1/1 通过。全部 Provider 响应来自本地 fixture，没有真实付费请求。
- 1.6.140 候选位于 `apps/desktop-modern/dist-builder/desktop-modern-1.6.140-workflow-async`。NSIS 安装器 103323120 字节、SHA-256 `75A78905D95406E1368132736E845DBF888D3205351BEC2B24055F4D4F6CD64D`；blockmap 109768 字节、SHA-256 `F277A3840A41C023BDCC854BFEA5E86D09C3808BF90DCDDE253C8DAAA831E299`；`latest.yml` 375 字节、SHA-256 `62FA81F5A72BBF6F395C5E6A93E14A6410B08C93D7D514C2E6360AE2ABF40009`。候选 EXE SHA-256 `D3DECBD676CE8CB62178A522C8DD18C2C15F2CB547A39554AD3D65FB84D97AC2`，`app.asar` SHA-256 `A4FA44D2EF8E941EB0D8521D166FAE84130EB89DED5C4C5CC7BF5467DECBCB4F`；安装器与候选 EXE 均为 `NotSigned`。
- 候选离线验收 `work/qa-packaged-workflow-async-1.6.140-candidate-r2/report.json` 与独立安装版 `work/qa-packaged-workflow-async-1.6.140-installed-r1/report.json` 均为 `passed`：两条素材-生成-结果工作流整体不交错、组内依赖顺序正确、无重叠、撤销和保存重开通过，六个 GPT Image 2.5 profile 全部含 `async_tasks`。外网尝试 0、页面错误 0、付费请求 0。安装目录 `D:\CanvasAtelier-QA-1.6.140-20260914` 与候选 84/84 文件逐项同哈希，0 缺失、0 不一致、0 额外，另有正常卸载器。GitHub 提交和正式 Release 尚待完成。
- 已发布 GitHub 正式 Latest `v1.6.140`：<https://github.com/19960726/canvas-atelier/releases/tag/v1.6.140>。注释标签剥离后指向已验收源码提交 `1ecd48b6d3f241acb2369cd873969648f436f581`，非 draft、非 prerelease；安装器、blockmap 与 `latest.yml` 三项远端资产状态均为 `uploaded`，大小和 GitHub SHA-256 digest 与本地产物逐项一致。发布后仅追加本条项目记录，没有移动或强制覆盖公开标签。

## 2026-09-16 1.6.143 生图历史首屏与引用菜单修复

- 根因：历史抽屉首屏列表与容量审计在调用链上同时等待，默认 50 条记录会先逐个读取并 SHA-256 校验原始媒体，导致 UI 长时间停留在“正在校验本地素材”；引用选择后，节点状态更新又可能让旧的素材选择菜单继续挂在 DOM 上。竞品的快速体验本质是先返回可渲染的元数据，再异步校验媒体，而不是首屏阻塞完整文件审计。
- 修复：`GenerationHistoryStore.list()` 对默认活动记录首屏直接返回索引元数据，容量统计和协议媒体解析继续在后台/按需做完整存在性、大小、哈希校验；显式“可用/缺失/损坏”筛选仍先完成全量审计，保证筛选语义不变。图片、视频、反推节点在规范化 `@图片N` 引用写回后立即收起过期选择菜单，保留键盘输入 `@` 时的正常菜单。
- 回归：新增列表不等待原图哈希的锁定测试；引用菜单测试确认选择后不再存在。聚焦 `ModuleNodeCard` 为 277/277，历史抽屉与 store 为 55/55；全 workspace Vitest 为 241 个文件、3683 项通过、2 项跳过；typecheck 与 production build 通过。
- 安装态证据：1.6.143 候选直接列表从 1.6.142 的约 2012 ms 降至 275 ms；独立安装目录 `D:\CanvasAtelier-QA-1.6.143-20260916` 的实际运行版本为 1.6.143，列表为 316 ms。两轮首个 50 条记录均在 1 秒采样内可见，容量审计最终 576.3 MB、0 异常，页面错误和请求失败均为 0；安装版 EXE 与候选 EXE 的 SHA-256 同为 `3A9C8EF23F777772E595C2156AFB778D004FD11A277FA251A09C584CA6E3FB1D`，`app.asar` SHA-256 为 `77661EB3FEC044333CDBB89AC7E921CC3D5F1353E2CED2E7CA9D3BF63DF1E3D1`。安装器 `CanvasAtelier-Win10-11-x64-1.6.143.exe` 为 103324810 字节、SHA-256 `D25A17BDD41461A89FEEA1851511B17015A7DD8DED4191959FB33EF437D365CE`；blockmap SHA-256 `43F0CDB8E771F8F6CDA7FF6731747C31277C7883D4DE752F4918E6BA88834566`；`latest.yml` SHA-256 `8FC6C886A02673EFF382D1D5C880C6ADD2594773ADD183926A5217AF0EA58B09`。安装器和安装版 EXE 均为 `NotSigned`，未调用真实付费 provider。

## 2026-09-16 1.6.144 自动保存、图槽换位与 30ms 历史首屏

- 自动保存参考 Canvas Forge 可观察的“加载中、脏状态、单队列保存、关闭前 flush、失败不静默关闭”交互，但继续使用 Canvas Atelier 自己的 journal、revision、稳定点与恢复格式。桌面启动现在在持久项目完成 hydration 前显示 `加载中…`；正常编辑依次显示等待自动保存、自动保存中和所有修改已自动保存，冲突、只读和可重试失败保持独立状态。显式保存按钮仍用于立即 flush、建立稳定点或重试，不与后台写入开启第二条队列。
- 图槽卡死根因是组件局部 latest-only 队列和共享项目保存边界分离：大量换位会逐次等待持久化，组件卸载时还可能丢失最后顺序；旧 autosave drain 又最多处理两份草稿。现在图槽先以完整 edge-id 排列乐观更新内存项目，再进入共享 750 ms autosave；flush 会持续排空写入期间到达的所有新草稿。可见 20 槽重排仍附带隐藏 overflow edge，revision 冲突只允许重载一次后按当前边重试。
- 历史 30ms 路径采用两层暖缓存：主进程在创建首窗前校验并缓存 canonical index，默认 active/newest/all 列表无锁返回内存快照；renderer 在 App 挂载时按 bridge 身份预取 30 条，打开抽屉同步消费，再异步刷新列表、容量和媒体审计。30ms 验收口径是首批卡片及缩略图 `<img>` 已进入 DOM；实际像素解码仍按浏览器 lazy/async 进行。显式 availability 筛选、原图详情、导出与完整性审计仍走权威慢路径。
- 安装态真实历史证据位于 `work/qa-installed-history-real-144-installed-fast/report.json`：安装版 1.6.144 读取运行中的本地历史隔离副本共 159 条，默认 30 条 IPC 为 1.5 ms，打开抽屉第一帧 14.8 ms 已有 30 张卡片与 20 个图片节点，页面错误和请求失败为 0。复制 fixture 时必须删除复制品中的 `history.lock`；源应用活动锁 PID 仍存活时拒绝抢锁是正确行为。
- 图槽安装态证据位于 `work/qa-installed-slot-autosave-1.6.144/report.json`：20 个素材槽快速执行 38 次左右换位，结束时先显示等待自动保存，随后只产生 1 次 autosave commit，显示所有修改已自动保存；重开后 20 项最终顺序逐项一致，页面错误 0。综合安装验收 `work/qa-installed-canvas-bugfix-1.6.144/report.json` 也通过整理、撤销、双引用、MCP 生图无重复确认、INVALID_REQUEST 后合法保存、稳定点回读、预览尺寸和复制共 23 项，外网尝试 0。
- 最终源码门禁：workspace Vitest 242 文件通过、2 文件按设计跳过，3704 项通过、2 项跳过；typecheck、production build 和 `git diff --check` 通过。显式持久化性能门禁回放 10,000 个事务为 87.6 ms。安装器退出码 0，独立安装目录为 `D:\CanvasAtelier-QA-1.6.144-20260916`；候选 85/85 文件与安装目录逐项同 SHA-256，0 缺失、0 不同，唯一额外文件是正常卸载器。
- 1.6.144 候选位于 `apps/desktop-modern/dist-builder/desktop-modern-1.6.144-slot-history-autosave`。NSIS 安装器 103328467 字节、SHA-256 `EB9B0A54CE91FAAC20087193BD3BF8DB70E8FEF4259DC76FC66DDBE0F410C1C2`；blockmap 109635 字节、SHA-256 `89EB6F7363825356B99A3637F53A2DB1F529F7AA39F88A51B01E079B75A220B0`；`latest.yml` 375 字节、SHA-256 `7B3C57F8492A2D52D4B943D996773DDFB12F017A2CCCACCBCD070D758DBF3B5C`。候选及安装版 EXE SHA-256 均为 `3CB53BF6AE4188A59EB221CC663C1D4D44098F5E244711C34971A44EB9C4E00E`，`app.asar` SHA-256 为 `66EA00854FC51652B28A7D89D6DD6BCEE6927E1AFA850D412435347F4AC63A20`；Windows 二进制仍为 `NotSigned`。
- 本轮没有发送真实付费 RelayMe、Comfly 或 4D 生成请求，也没有执行 Photoshop COM 写入；fixture、只读目录与本地 harness 通过不等于这些外部边界已在线成功。正式 GitHub `v1.6.144` 发布与远端资产 digest 核对尚待完成。

## 2026-09-16 1.6.144 R2 画布流畅度、四宫格、颜色校正、引用收起与素材快传

- R2 取代上节早期 1.6.144 候选。画布性能参考视频的可验证目标被固定为大画布原生滚轮缩放时保持连续帧、侧栏稳定且节点细节随视口变化；独立安装版实际采样 90 帧，P50 16.7 ms、P95 16.8 ms、最大 16.8 ms、超过 34 ms 的帧为 0，画布变换从 1x 到 2.5x，未以静态页面冒充流畅度。
- 素材图片上传慢的本地根因是 `importProjectImage` 在素材复制、哈希和 journal commit 之后仍同步等待完整项目 snapshot。现在导入在受管素材与 journal 获得 durable acknowledgement 后立即把结果返回 renderer，snapshot 进入同一 session maintenance tail 后台执行；关闭项目仍等待该 tail，故没有牺牲退出前耐久性。回归测试先证明旧实现会被 snapshot gate 阻塞，修复后导入先完成、close 继续等待；安装版上传到预览为 53 ms。
- 图片生成四结果固定为紧凑正方形 2x2，缩略图用 `cover` 填满四个方格；横图/竖图的完整原图在节点详情查看器中继续用 `contain` 保留。节点头部与图片细节预览都提供同一颜色校正参数、预设、重置和点击保持的原图/校正图对比；复制校正图会烘焙当前参数。`@图片N` 选择、失焦或 Escape 后立即关闭，延迟到达的同值 change 不能重新打开旧引用栏。
- 最终安装态历史使用 180 条真实历史隔离副本：默认 30 条 IPC 0.8 ms，抽屉打开第一帧 14.9 ms 已有 30 张卡片和 25 个图片元素，加载状态结束；容量随后异步得到 808.2 MB，页面错误与请求失败均为 0。图槽 20 项、38 次快速换位只产生 1 次自动保存，重开顺序逐项一致。
- 最终源码门禁为 242 个测试文件通过、2 个按设计跳过，3707 项通过、2 项跳过；production build 与 `git diff --check` 通过。R2 候选和独立安装目录的 85 个 payload 文件逐项同哈希；候选/安装 EXE SHA-256 为 `A389937BF509A05CE4F6EEE06BF436091AD0F194881A863BFB252615B0A18AFC`，`app.asar` 为 `A9DA616D953E9BBD6490F60454B66A539003D459ED5861273D0DEB559D3B246C`。
- R2 产物位于 `apps/desktop-modern/dist-builder/desktop-modern-1.6.144-slot-history-autosave-r2`。安装器 103329030 字节、SHA-256 `F58C93893CDF6363DE59A38923434A0CE8B71AD8981CB36CD24B7A0374FFDA47`；blockmap 109749 字节、SHA-256 `760636D38630DFB87F5F45AB1111777D8CF0D75E2B08640B846AE04F6A3FC7AC`；`latest.yml` 375 字节、SHA-256 `E2F8186700E32F01F72E95A05011E77E741DD7B7132353ADC681EDC87CE7EBAC`。独立安装目录为 `D:\CanvasAtelier-QA-1.6.144-20260916-R2`。
- R2 自动验收阻断全部外网请求，没有提交真实付费 RelayMe、Comfly 或 4D 任务，也没有执行 Photoshop COM 写入；目录/能力/提交参数 fixture 通过只证明本地路由合同，不等于上游账号此刻可用。GitHub 正式发布及远端 digest 仍在下一发布步骤核对。

## 2026-09-16 1.6.145 真实项目性能与正式安装修复

- 接续 `E:\画布项目\canvas-atelier-1.6.145-formal-install-handoff-2026-09-16.md`，使用 142 节点、127 连线、190 素材真实项目的隔离副本。生产项目只读，校验原始 manifest 字节不变；隔离根目录启用 formal QA 外网拦截，不复制供应商凭据、不发付费请求。
- 引用栏根因是关闭状态仅比较整个 canonical value。contenteditable 的空白、选择区或正文规范化会让同一旧查询重新打开。现在以未解析 @ 查询及出现次数识别新意图；选择、Escape、失焦后的规范化保持关闭，新增/粘贴/编辑 @ 查询仍可打开。回归：`ModuleNodeCard.mentions.test.tsx` 27 项，旧版隔离真实项目也复现选择后 NBSP 规范化重开。
- 颜色默认从未标记的旧中性 original 升级为 auto，显式恢复原图用 version=1 保留选择。每张图片至多采样 96×96 像素，128 项参数缓存共享预览和导出；依据低饱和中性色估计红紫偏色，不再固定套用 -6/-10。中性、暖色、饱和或含糊场景保持原样，无实际调整时不挂 CSS filter。独立审查发现纯白背景被排除会误改浅粉商品，新增失败回归后把高亮中性区域作为否决证据。测试在 image-color-correction.test.ts 和 ImageColorCorrectionImage.test.tsx。
- 性能第一层根因是自定义逐帧裁剪与 React Flow 原生可见性裁剪重叠，屏外节点从 graph/minimap 消失，并在缩放中反复挂载。CanvasWorkspace 现在传完整且稳定的节点/边数组，原生 onlyRenderVisibleElements 负责 DOM；视口放入 ref，连接吸附半径由内部小组件订阅 zoom。实际 React Flow 回归确认完整 nodeLookup、小地图、连线端点和视口变化时数组稳定，large-canvas 集成同步完整图契约。
- 安装态真实项目进一步暴露复杂卡片在缩放中批量挂载图片、颜色处理与编辑控件，造成 DOM/GC 峰值：优化前 214 帧 P95 50 ms、最大 383.4 ms、11 帧超过 34 ms、7 个长任务。现在低于 45% 且未选中、未展开的节点只渲染标题、状态和端口轻量壳；选中、展开或放大立即恢复完整卡片。候选真实项目 142 节点、127 连线采样为 P95 16.7 ms、最大 16.8 ms、0 慢帧、0 长任务；小地图仍为 142 节点，原项目 manifest 字节不变。
- 真实四图验收使用生成过的方图、横图、竖图、长竖图，未用四色 SVG 代替真实图。四格缩略图改为 `cover`，以紧凑正方形 2×2 铺满可用区域；图片细节查看器继续使用 `contain` 显示完整原图。候选对 11 种比例的展开/收起共 23 个状态逐项检查，四张图均解码成功、两行完整、祖先可视交集完整、无尺寸提示遮挡；对齐的 2K 夹具不再显示伪 4K 警告。
- 已通过持久化性能 `npm.cmd run perf:persistence`：10,000 条事务 85.3 ms。真实源码交互已覆盖缩放、平移、拖动、输入、引用、21 次换位、autosave 和正常关闭重启；安装版最终指标与精确哈希见本轮正式验收报告，不能以此源码结果替代安装证据。
- 验证命令：`npm.cmd test`、`npm.cmd run build`（包含全 workspace typecheck）、`npm.cmd run perf:persistence`；真实项目运行器 `work/qa-real-project-145.mjs`；独立构建脚本 `work/build-formal-1.6.145.mjs` 输出到 desktop-modern-1.6.145-formal，不触碰原有 dirty latest.yml。仅在全部门禁通过后安装正式目录和发布。
- 候选包截图复核进一步发现尺寸不足的黄色提示条使用 absolute bottom 布局，覆盖了四图第二行；旧几何断言只看祖先裁剪，漏掉了此类遮挡。运行器增加提示条与每张图的交集断言后在 `work/qa-four-warning-145-red/report.json` 得到明确 RED。修复现有 canvas-layout.css 规则，让提示条参与独立 grid 行，图片区域按剩余高度缩放；没有删除尺寸告知。正式矩阵会同时检查裁剪和提示遮挡。
- 实际照片诊断派生图的截图像素门禁发现旧 `imageColorCorrectionMatrix` 只有 19 项（SVG 要求 20 项），浏览器忽略矩阵；补齐 alpha 行，并在像素一致性单测断言矩阵长度及 alpha 行。原截图平均色差 24.03，补齐后降到 4.60（约 80.9%），原图对比和返回校正的截图字节一致。诊断图明确区别于真实四个生成结果。
- 同一端到端校色门禁发现 CanvasWorkspace 的双击捕获会抢先打开通用原图查看器，导致生成图自己的校色查看器失效。新增展开/收起两项实际 CanvasWorkspace 回归先 RED，再让结果画廊交由节点处理，通用素材双击继续保留；portal 事件不会再被画布捕获重新替换。
- 最终像素门禁 `work/qa-adaptive-color-145-dist-r13/report.json` 通过：默认自动校正无需点击，显示色差从 24.03 降到 4.60（80.9%）；预览与导出的平均通道误差 0.83，复制与下载 PNG 像素完全一致。显式恢复原图写入 `version: 1`，正常关闭后 `cleanClose: true`，重启仍为原图且对比按钮禁用。三次退出均为正常 code 0，原始 manifest、snapshot、照片逐字节不变，外网请求 0。
- 最终安装版性能复跑使用 `D:\CanvasAtelier\Canvas Atelier\Canvas Atelier.exe`，报告 `work/qh145/report.json`：142 节点、127 连线、190 素材；低缩放总览 103 帧，P50/P95/最大值为 16.7/16.8/16.8 ms，超过 34 ms 的帧和长任务均为 0；可见 DOM 节点 77、节点图片 0、小地图节点 142，页面错误为空、网络拦截尝试为 0、退出码 0。并发运行导致的一次关闭超时已单独复跑排除。
- 最终正式目录 `D:\CanvasAtelier\Canvas Atelier` 与候选逐项核对为 85/85 文件同 SHA-256；安装版 EXE `59D543EAC2CFF388BC456F598E5B581748CF1789E462813F1301AA4D70764DCD`，`app.asar` `1E88C54C2F8E7EC60800C9C89EB49988897EB3A1EC8E93562105D5520BDC4D05`。注册表只有 1.6.145，公共桌面与开始菜单快捷方式均指向该目录。NSIS UAC 交互在本机被取消，因此本轮对已有正式目录做了候选资源的精确同步并完成同哈希验收，不能写成重新运行安装器成功。
- 正式安装版四宫格报告 `work/qg145/report.json` 通过：真实方图、横图、竖图、长竖图在初始/AUTO/1:1 至 21:9 的展开和收起共 23 状态均保持 2×2、`cover`、无祖先裁切和无 4K 尺寸提示；源项目字节不变，外网请求为 0，退出码 0。黄色“实际 2048x2048”提示的根因是旧 QA fixture 保留了 `requestedResolution=4K`，不是生产尺寸判断错误；fixture 已改为与注入 2K 图片一致并增加无提示断言。
- 最终 NSIS 产物位于 `apps/desktop-modern/dist-builder/desktop-modern-1.6.145-formal`：安装器 103329591 字节、SHA-256 `3B01B5F2DB0729AB9C851B9A8697A3199B510D312DE18BEB89D2B058B0975026`；blockmap 109718 字节、SHA-256 `0AE3AAF34FFAFBFCE94DB001E06CD80363BB49F85AEADFB3FBA14DC46BCFC768`；`latest.yml` 375 字节、SHA-256 `3694F4B1F8EEE190980983942505151FA915CAB2E61BEACE3D43186F04035694`。全量 Vitest 244 文件、3760 项通过、2 项跳过；typecheck、production build、持久化性能和安装版验收通过。未发送真实付费供应商任务、未执行 Photoshop COM 写入。

## 2026-09-17 1.6.146 四宫格参考布局与提示词相邻控件

- 用户补充要求是让图片四宫格接近参考图二/图三，并把模型、比例、清晰度、张数、画质、格式、背景和生成按钮紧贴提示词输入框。完成的图像生成节点使用无卡片边框的 448×448 正方形 2×2 画廊，横图/竖图缩略图仍用 `cover`，完整原图继续在详情查看器中用 `contain`；收起态保留标题在画廊上方，展开态保留结果工具栏在节点顶部。
- 颜色校正控件从预览区内部移到独立的 `module-node__generation-result-toolbar`，展开且有结果时显示在节点顶部，避免覆盖四张图；提示词区固定在结果画廊下方，生成控制栏从原节点底部改为提示词区的下边界。GPT 画质两行控件固定为 106px 高并使用同一锚点，旧 `bottom` 规则不再抢回位置。
- TDD 新增 `ModuleNodeCard` 参考布局断言：校正控件不属于预览区，四图画廊有两列两行、透明外壳、448px 正方形，控制栏为提示词相邻的 `top: 648px`。聚焦回归 283/283；全量 Vitest 244 文件通过、2 文件按设计跳过，3761 项通过、2 项跳过；typecheck 与 production build 通过。
- 1.6.146 候选真实项目隔离验收使用 142 节点、127 连线和四张真实生成照片。四图 23 个展开/收起与比例状态通过，源 manifest 未改变，外网拦截 0；低缩放性能 P95 16.8ms、最大 16.8ms、超过 34ms 的帧 0、长任务 0。候选报告分别为 `work/qa-reference-style-146-four/report.json` 和 `work/qa-reference-style-146-performance-r2/report.json`。
- 1.6.146 NSIS 产物位于 `apps/desktop-modern/dist-builder/desktop-modern-1.6.146-formal`：安装器 103330294 字节、SHA-256 `AC92910F3F0FBF6158A0CED0893F9366C25E038561FFC5A497613C96963C9ADB`；blockmap 109740 字节、SHA-256 `C5CA59E08FAAECD0ED0F86585A4B8628D0731BA9B8880842078BB34A7E03B021`；`latest.yml` SHA-256 `A2E844621913662CC7F4A20A338A602D97F206F354C5B7DAB6DFC793DB8C2BD5`。候选 EXE SHA-256 `9A24CD9EE6CE7792B5A24B14BD26E9D4C9C0D6D1FB83C7475AC6423BA30E4A93`，`app.asar` SHA-256 `330430EF5B5408566D541A8CF4382F25211190E3E3548585C0C4BA552F070C57`；asar 内版本为 1.6.146。
- 当前 `D:\CanvasAtelier\Canvas Atelier` 仍有用户进程运行，未强制结束或覆盖；因此本轮已完成源码、候选目录包和 NSIS 构建证据，正式安装目录的 1.6.146 更新与注册表验证留在用户正常退出后执行。未发送真实付费供应商任务，也未执行 Photoshop COM 写入。

## 2026-09-19：按单张结果保存校正及保存/图槽回归

- 用户要求四宫格选中哪张只调整哪张。原实现节点级 `colorCorrection` 会作用整个画廊；现在使用 `imageColorCorrections[assetId]`，选择/大图/右键复制下载和 Photoshop 均读取对应资产的参数。旧显式校正仅迁移首图，默认原图；已有映射优先，换位不改变归属。原图对比层和分割线限制在选中图格内，顶部显示颜色校正、前后对比、恢复原图。
- 复现保存缺陷：组件内 180ms 调色草稿尚未同步 store，立即关闭可能把旧状态认作已保存。新增 editor-draft-boundary，在原生关闭准备及显式保存边界先提交组件草稿，再走现有持久化 ACK。复现图槽缺陷：拖动到图槽外释放后残留 pointerDragIndex；现在全局 pointerup/cancel/blur 清理，避免下一次点击误换位。另修复保存层拒绝换位而 UI 仍展示新顺序：回调保留布尔/Promise 结果，失败回滚到外部确认顺序并显示提示，序列号避免迟到失败覆盖后续换位。
- 回归：ModuleNodeCard.test.tsx 的立即关闭调色案例先 RED 后 PASS；ConnectedAgentMediaSlots.test.tsx 的图槽外释放、保存拒绝案例先 RED 后 PASS；ImageColorCorrectionImage.test.tsx 覆盖选中第二张、单图分割线、仅还原选中图、序列化/重挂载/结果换序后校正仍跟随 assetId。保留已有快速 20 次换位、自动保存中再编辑和提示词引用测试。
- 2026-09-19 16:56 全量 `npx vitest run --config vitest.config.ts --maxWorkers=1`：245 文件通过、2 跳过；3813 项通过、2 跳过，300.54s。`npm run build`（含全工作区 typecheck）通过。新图片按钮需要显式取消通用控件 max-height=38px，以免铺图被裁成条；真实 Electron 截图已复现并修正，QA 新增按钮与图格等高断言。
- 正式安装与安装后证据仍需在最新候选包上单独核验；源码和 renderer override 截图不等同于正式安装通过。付费生成未调用，真实用户项目未写入。- 追加实机发现：Photoshop 27 Windows COM 的 Documents 集合只有 Count，length 为 undefined，旧脚本会误判已打开文档；新增 Count/length 兼容读取，photoshop-script.test.ts 先 RED 后 PASS，相关 65 项通过。实际 Photoshop 智能对象导入成功，导出 PNG 和预期校正 PNG 每通道最大误差 0，随后关闭唯一 QA 文档且不保存；当前无用户文档。
- 新关闭边界补充只读视图保护：只读状态不提交初始化草稿，保持可正常关闭。先 RED 后 PASS；ModuleNodeCard/app-store/App/autosave 585 项通过。单图图片控件按 contain 保留完整内容；新候选单图和四图/调色/换位/立即关闭重启通过。
- 安装器 /D 参数必须带路径内部引号：`/S /D="D:\CanvasAtelier\Canvas Atelier"`。未加引号会退出码 0 却装到 D:\CanvasAtelier\Canvas，必须核对最终注册表及 85 个 payload 文件，不能只依赖安装器退出码。
- 最终正式安装 1.6.149 完成：85 payload 文件完全匹配、注册信息与快捷方式正确。正式安装单图调色/5 次换位/最后一次调色后立即关闭/重启 PASS；145 节点 127 连线 190 素材交互及 21 次换位和重启 PASS。Photoshop 实机导出像素误差 0。完整矩阵见 E:\画布项目\canvas-atelier-1.6.149-color-save-slots-2026-09-19.md。

## 2026-09-19：1.6.150 节点 UI、真实对比拖动、自动分析状态与 API 延迟

- 真实手柄命中 RED：旧 range 受通用 max-height 限制，只在图片顶部接收事件，中央可见手柄命中 IMG。新增沿可见线的独立 pointer-capture 区域，按实际缩放边界计算位置，保留 range 键盘访问。安装版 50%/85%/125% 缩放、越界拖动、节点位置不变均通过。
- 自动分析增加 loading/applied/unchanged/unavailable 状态、8 秒超时和失败缓存淘汰；没有明显红紫偏色时保留原色并说明，不强制改变暖场景或红产品。手动校正和逐 assetId 保存继续工作。
- Comfly checkConnection 不再提前下载价格及模型目录，连接请求数从 4 降为 1；设置先显示连接成功再同步目录。目录 single-flight 缓存支持失败重试和配置变更失效，迟到旧响应不会替换新配置缓存。
- 图片/视频统一顶部标题、锁定、状态和收起；颜色工具栏位于标题上方；素材槽、提示词和参数栏组成 640px 连续编辑区。图片保持 448px 方形和逐图颜色；视频预览 448×252，清除旧偏移及最小宽度规则。
- 实机视频回归发现资源协议未处理 Range：同一 MP4 Blob 播放成功而 novus-asset 播放失败。增加 bytes 范围解析、206/416/HEAD 与 Content-Range，安装版已有 5.5MB H.264/AAC 文件播放和 seek 均通过，不靠整文件 Blob 绕过。
- 全量最终 3821 项通过/2 跳过，247 文件通过/2 跳过；完整 build/typecheck 通过。正式 1.6.150 安装器退出 0，85 文件哈希全部匹配；app.asar SHA-256 7924E1CDDD32992767EA634757988F2E5FABFD648598FDF48E81FF236E6AAA34。
- 安装版逐图校正/5 次图槽换位/立即关闭重开、长竖图/GPT 画质、视频结果/空态/播放/seek 均通过。145 节点/127 连线/190 素材性能及 21 次换位重开通过：各交互 P95 约 7ms，缩放最大 55.6ms/1 长任务，不能宣称零卡顿；真实源项目不变。
- Comfly 最终连接 2131ms，目录 874 个（852 完整），后续连接 1653/837/460ms；早期有网络失败后重试成功，不能承诺固定网络耗时。RelayMe 登录页可打开但无已登录账号；Julun/4dai 未配置，未调用付费任务。本轮未重做真实 Photoshop COM，源码导出回归通过，前版实机证据单独保留。
- 完整交接和精确报告：E:\画布项目\canvas-atelier-1.6.150-node-ui-provider-2026-09-19.md。正式安装证据在 work/qa-formal-install-1.6.150、q150installed-color、q150installed-portrait、q150installed-video-r2、q150installed-perf、q150installed-providers-final。受保护旧 latest.yml 的 7A267A44... 哈希未变；未提交/发布远程。

## 2026-09-19：1.6.151 GPT 提示词框横向越界

- 原因：1.6.150 640px 共享编辑区被旧 GPT 双 :has 的 760px/0 inset 提示词规则覆盖。回归曾只检查上下相接，漏掉左右边界。现在旧规则与共享编辑区读取同一组 --generation-composer-inset/width，保留旧节点 fallback。
- 回归：release-layout-contract.test.ts 新增案例先 RED 后 GREEN；work/qa-image-editor-layout-states-151.mjs 增加素材/提示词/参数 left/right/width 一致断言，正式 150 复现 RED，候选空 GPT、长竖图 GPT、四宫格和折叠展开 PASS。343 UI + 23 packaging 测试通过，完整 build/typecheck 通过。
- 测试副本不要带入真实项目在用 writer lock；复制过滤 recovery/project.lock，后续使用已关闭的 q150single 固定项目副本，测试窗口正常关闭并设置超时。早期并发素材加载超时保留为失败，未计入通过。
- 1.6.151 修复安装包已生成；正式安装首次因 Codex 自动重启 bundled MCP 占用退出 2，当前 installed app.asar 仍是 1.6.150。待用户关闭画布 MCP 后重试并校验 85 文件及正式布局。详见 E:\画布项目\canvas-atelier-1.6.151-composer-width-2026-09-19.md，不能将候选通过写成正式安装成功。
- 追加：最终候选视频结果/空态/真实播放/seek PASS（work/q151-video-r3/report.json），新增横向对齐断言均通过。QA 等项目初始化恢复视口和结果挂载完成再定位检查，避免将保存的画布缩放误判为节点尺寸错误。正式安装仍待解除 MCP 进程占用。
- 正式安装追加完成：用户要求直接安装后，脚本 work/install-formal-151.ps1 保留旧 EXE 为 .pre-1.6.151-install 并暂时腾空旧启动路径，停止仅 3 个 exact bundled MCP，解决自动重启与安装竞争；未终止 Codex/用户 GUI、未改连接配置。NSIS 退出 0，85 文件同哈希，注册表/快捷方式 1.6.151 正确，MCP 已重新启动。
- 正式 app.asar SHA-256 为 740ACBBDBA297259AC355999896DC684BAD10C9B071CF1CCCA00F6AFD5E66A88。安装版 work/q151installed-empty/report.json 通过用户原始 GPT 空节点两行参数场景：素材、提示词、控制栏 left=211/width=544（85% 缩放），接缝/左右对齐/正方形/折叠展开通过，pageErrors=[]、exitCode=0，源测试项目不变。前文等待 MCP 的状态已解除。
- GitHub 发布完成：用户要求“发布GH”后，v1.6.151 已在 19960726/canvas-atelier 设为正式 Latest（Release ID 392047302），URL https://github.com/19960726/canvas-atelier/releases/tag/v1.6.151。EXE/blockmap/latest.yml/SHA256SUMS 四资产大小及远端 SHA-256 全匹配，远端 latest.yml 逐字节匹配。沿用远端 main 二进制发布基准，未推送 dirty 源码。证据 work/release-1.6.151-published.json。
- 发布 secret/path scan 通过；Photoshop 测试中虚构路径的正则误报改为 URL 字段断言，生产代码/构建产物不变，26 项相关测试通过。未放宽扫描器或上传项目数据。

## 2026-09-21：1.6.152 图片/视频拖动与自动校正

- 用户明确是“拖图片或视频节点经常拖不起来”和“自动中和看不出变化”。生成图展开区、导入图片/视频区被整体 nodrag 阻断；移除媒体区域阻断，仍隔离提示词、参数、素材槽排序和替换控件。图片选择/展开按主指针位移判定，取消/失焦清理监听。
- 视频不再 pointerdown 就播放：画面拖动与点击播放分开，原生控件保留。全局 38px 按钮规则排除视频拖动面，防止可拖面积缩成窄条。候选真实 MP4 移动/保持暂停/点击播放/原生按钮暂停通过（work/q152-video-final-report.json）。
- 颜色校正仍默认原图、按 assetId 单张保存。显式自动中和新增明亮低彩度且一致的黄/蓝/绿偏色识别，保留中性锚点与饱和主体保护。关闭浮层后截图实测 RGB 232/218/191 → 216/214/208，其他三图滤镜为 none（work/q152color3/report.json）；早期浮层遮挡截图不作像素证据。
- GPU 实验在本机出现 116–200ms 缩放长帧；最终不默认启用 Windows GPU。保留软件兼容路径，CANVAS_ATELIER_ENABLE_GPU=1 显式选择，CANVAS_ATELIER_DISABLE_GPU=1 回退。不更改沙箱/驱动黑名单。
- 真正减负点：位置更新不再改变选中 ID 数组身份，避免逐帧 MCP selection 重置及 Agent 目标重算。十次位移通知从十次降至零，真正选中变化正常通知，CanvasWorkspace.test.tsx RED/GREEN。
- 全量 q152-full-final.log 3828 PASS / 2 SKIP；最终额外源码回归 q152-last-source-tests.log 573 PASS、q152-style-verified.log 91 PASS；完整构建 q152-build-verified.log；最终 NSIS q152-installer-verified.log。期间历史抽屉时序用例单次失败，独立与全量复跑通过，未改其实现。
- 最终候选 asar 7000A4BB942D60676D0D5419B02736330ACDB229234713381794AE5369E24B19，安装器 5D478E9E5C3D75D19E4E5C6E650D9ED1DD77E555D44C4919B6BA79878B107807。正式安装和最终性能复测待后文追加，不能据候选宣称安装成功。
- 交接 E:\画布项目\canvas-atelier-1.6.152-drag-color-performance-2026-09-21.md。所有 QA 用固定项目隔离副本，未改真实项目、未触发付费生成。
- 正式安装追加：1.6.152 NSIS 退出 0，work/qa-formal-install-1.6.152/report.json 的 85/85 文件与候选一致，注册表/快捷方式正确。安装前只停止两个已核验的旧 MCP，旧 EXE 保留为 .pre-1.6.152-install；未停止 Codex 或用户 GUI。
- 最终真实项目性能 work/q152benchfinal/report.json：三轮缩放/平移 p95 16.7–16.8ms、max 17ms，无 >34ms 帧或长任务；旧版同场景也约 60fps，因此只报告稳定性和去掉冗余更新，不宣称虚构帧率提升。
- 正式版 work/q152installedcompare3/report.json PASS：真实滚轮缩放 0.5/0.85/1.25，对比线均 20→100，拖出范围仍捕获、节点不移动。最后一次饱和度 119、七图槽顺序关闭重开一致。前两次 QA 直接改 DOM transform 未同步 React Flow 视口，不是有效缩放测试，已保留失败报告并改为实际滚轮/中键。
- 正式版 work/q152-installed-video.json PASS：拖画面移动且保持暂停，点击播放推进 0.58s，原生按钮暂停。安装文件身份仍为候选 asar 7000A4BB942D60676D0D5419B02736330ACDB229234713381794AE5369E24B19；保护的旧 latest.yml 未变。
- 最终安装版自动校正 work/q152installedcolor4/report.json PASS：原生 capturePage 等待实际合成帧后读取 RGB 232/218/191 → 216/214/208，仅当前图变化；图片拖动、四宫格、接缝、折叠重开、pageErrors=[]、退出 0，源项目不变。早期 CDP 全图截图超时和读取到浮层旧帧的失败保留；最终未放宽像素断言、未改生产逻辑。1.6.152 本轮交付完成，详情见对应交接文档。

## 2026-09-21：1.6.152 GitHub 正式发布

- 用户明确要求生成新安装包并发布 GH；发布本轮已构建、已安装和已测试的最终 1.6.152 文件，不改变候选身份。
- GitHub：https://github.com/19960726/canvas-atelier/releases/tag/v1.6.152 ，release ID 392654921，draft=false、prerelease=false、Latest=true。
- 发布四项：CanvasAtelier-Win10-11-x64-1.6.152.exe（103338414 bytes）、同名 .blockmap、latest.yml、SHA256SUMS-1.6.152.txt。
- 安装器 SHA-256：5d478e9e5c3d75d19e4e5c6e650d9ed1dd77e555d44c4919b6ba79878b107807。
- 发布前重新核对正式安装与候选全部 85 个文件，匹配原验证报告；安装器版本、大小、SHA-512 与 latest.yml 一致；secret/path scan 通过。
- 草稿上传后及正式发布后分别核对四项 GitHub digest/大小/状态；正式发布后从 API 下载 latest.yml 与本地逐字节一致，确认 /releases/latest 指向本版。
- 证据：work/release-1.6.152-draft.json、work/release-1.6.152-published.json；脚本 work/prepare-release-152.mjs、work/verify-release-152.mjs。
- 仅发布二进制资产及说明，标签基于远端既有 main 3bc58aeb911ced49eccddbf1be493df9798043fd；未推送本地 dirty 源码、测试项目或日志。旧 desktop-modern/latest.yml 保持原哈希。


## 2026-09-21：1.6.153 暖光校正与提示词输入阻塞

- 用户反馈自动中和大幅改变暖色厨房氛围，提示词打字仍卡顿。本轮不改节点布局或供应商调用。
- 根因一：仅靠低彩度亮部回退时仍使用 80% 全局白平衡；浅色暖光场景被当成偏色。现在该分支最多 20% 且限制增益约 2%，用户截图测得色温 -16→-4、最大通道变化 16→4。红/洋红广泛偏色分支、原图默认、单图归属、手动控制及预览/导出一致性保留。
- 根因二：MediaMentionTextarea 的选区偏移用 cloneContents 复制光标前的引用媒体；122 次输入产生 492 次 DOM 复制和超过 3,000 个临时媒体元素。现在遍历原 DOM 计算文本长度，折叠选区复用偏移。
- 根因三：主进程反复解析相同日志并从头回放已验证项目。JournalWriter 以完整原始日志行缓存成功验证结果（最多 256 行 / 8 Mi 字符），ProjectRepository 以快照哈希和完整校验和前缀复用当前项目，仅回放新增记录。磁盘读取、提交边界、归属、序列、修订、损坏检测仍每次检查；返回结果复制隔离，快照/历史变化失效。
- 进一步实测发现：大型项目存在 657 个历史快照，背景恢复扫描仍与界面 IPC 共用主线程。现代桌面壳注入 recovery-worker-runner，把同一 RecoveryScanner 算法搬到独立线程，顺序执行扫描，失败或无结果退出会拒绝，避免无限等待；恢复候选、镜像和完整性检查算法未变。
- 回归位置：image-color-correction.test.ts、MediaMentionTextarea.test.tsx、CanvasWorkspace.test.tsx、journal-writer.test.ts、project-repository.test.ts、新 recovery-worker-runner.test.ts。颜色/选区/解析/回放用先失败后通过确认；新线程测试验证主事件循环可响应、串行运行和异常退出。
- 验证命令：npm test；npm run build；npm run scan:e2e；node work/build-formal-1.6.153.mjs；候选 Electron 隔离输入和颜色 QA。最终结果见下方追加与根目录 1.6.153 交接文档。
- 未更改真实用户项目、账号、付费生成或 Photoshop COM；保留工作区原有未提交内容，仅发布二进制资产。


### Comfly GPT Image 2.5 补充修复

- 用户确认故障供应商为 Comfly。只读本地生成历史：2026-09-21 11:07–11:50 的 5 次 Sunburst 4K / 1:1 / 1 张任务均约 3–4 分钟后失败，历史只保存 provider_unavailable，不能据此断言具体 HTTP 状态或上游可用性。
- 已确认接入错误：ComflyClient.editImage 对 GPT multipart 请求去掉 async body 字段，却未将 async=true 加到 URL；generic edits 也未正确用 query 开关，且不接受只有 task_id 的异步确认。根据 Comfly 官方文档 https://gpt-best.apifox.cn/api-339685644，编辑异步开关应为 POST /v1/images/edits?async=true，后续 GET /v1/images/tasks/{task_id}。
- 修复：两个 edits 分支共同使用 async query；非 GPT JSON 分支也移除 body async，并在异步模式接受 task_id-only 提交回执；同步 URL/回执兼容不变，不做付费重试或切换模型。
- 测试先失败 6 项（work/q153-gpt25-red.log），修复后 Comfly client / bridge / capability 221 项通过（work/q153-gpt25-green.log）。覆盖 Flare/Sunburst 4K 和通用编辑，提交一次后只查询状态；无真实付费生图，不能标记 live supplier generation PASS。


### 最终候选验证（含 Comfly 修复）

- work/q153-full-gpt25-final.log：248 文件通过、2 跳过；3,842 测试通过、2 跳过。work/q153-typecheck-gpt25.log 全部类型检查通过；work/q153-build-gpt25-final.log 现代桌面完整构建通过；work/q153-installer-gpt25-final.log NSIS 构建通过。
- 最终包输入实测 work/q153-typing-after-release.json：1.6.153，122 次输入，cloneContents=0、临时媒体节点=0、超过 50ms 的界面长任务=0，输入到下一帧 P95 11.3ms / 最大 15.4ms。重开恢复 1,772 字完全一致（work/q153-typing-reopen.json）。此结果为加载稳定后的受控长提示词场景，不代表所有项目和启动阶段都无卡顿。
- 启动阶段早期候选仍记录少量 56–132ms 界面长任务；两次 QA 编辑器定位失败保留在 work/q153-typing-final.log / work/q153-typing-worker-settled.log，不计通过。显式重新聚焦及事件追踪补测通过（work/q153-typing-worker-diagnostic.log），最终包再次通过完整输入与保存重开；未对该失败臆测为已修复产品问题。
- 包身份检查 work/q153-package-identity.json：4 个 renderer 文件、11 个 desktop 文件与最终构建逐字节一致，含恢复工作线程；app.asar SHA-256 75e4cd57cbd23a915598caa587e2abc520b3c419904eca621845d855214bbc74。安装器 103609715 bytes，SHA-256 6b88ac79b5cb9c2c50fd2807e1249c648f34604b0f60b06a963b78d2e663ff73。旧 desktop-modern/latest.yml 原哈希不变。
- work/q153-scan-release.log secret/path scan 通过。当前正式安装尚未被本轮替换，不将候选 QA 说成正式安装 QA。


### 1.6.153 发布完成

- 最终候选颜色/四宫格/拖动门禁 work/q153-color-release/report.json PASS，原生预览 RGB 232/218/191 → 229/217/194，仅选中图片使用校正，其余三图 filter=none；手动参数有效；pageErrors=[]，正常退出 0，源项目 manifest/snapshot 未改变。
- GitHub 正式发布：https://github.com/19960726/canvas-atelier/releases/tag/v1.6.153；release ID 392689586；draft=false、prerelease=false、Latest=true。
- 四项资产 exe、blockmap、latest.yml、SHA256SUMS 上传前后大小与 SHA-256 digest 匹配，线上 latest.yml 下载后与本地逐字节一致。证据 work/release-1.6.153-draft.json、work/release-1.6.153-published.json。
- 仅二进制发行，标签基于既有 main 3bc58aeb911ced49eccddbf1be493df9798043fd，未推送 dirty 源码。正式安装注册仍为 1.6.152；1.6.153 候选/发布验证不等同于已经覆盖安装。Comfly 修复通过零费用模拟传输验证，未新增真实付费生成。


## 2026-09-21：1.6.153 正式安装阻塞已解除，覆盖安装完成

- 用户截图的“请保存并退出目标目录中的 Canvas Atelier”由旧 QA 残留进程触发。PID 5908 无主窗口，带 Playwright inspect 参数；两个子进程明确使用 work/q152installedcolor3/canvasforge-qa-user-data。核验 PID、父子关系、可执行文件和隔离目录后，只清理这组三个 QA 残留。未把安装器的未知进程保护放宽。
- 目标目录另有 Codex 启动的精确 MCP stdio 桥；按既有安装流程保留旧 exe，暂时移开启动路径防止桥重启竞争，停止已核验桥后运行正式 1.6.153 NSIS。installer exit=0，安装身份与已发布资产一致。MCP 随后重新启动。
- work/qa-formal-install-1.6.153/installation.json、report.json PASS：正式目录 D:/CanvasAtelier/Canvas Atelier；85 个安装文件与发布候选 SHA-256 一致，注册表版本 1.6.153，两处快捷方式均指向正式目录。
- work/qa-formal-install-1.6.153/startup.json PASS：运行正式安装 exe，隔离新建 QA 数据根，实测版本 1.6.153、workspace 可见、pageErrors=[]、正常退出 0。初次 smoke 脚本在 close 后调用 Playwright process() 导致报告错误；改为事前保留 child 句柄后重跑通过，未更改产品源码。
- 最后进程检查只剩正式 MCP 桥，无测试窗口或测试后台残留。此前“本轮尚未覆盖安装”的状态由本条更新为正式安装已完成。

## 2026-09-21：1.6.154 Nano Banana 单张去偏色

- 用户明确要求针对 Nano Banana，原图状态常发红、发紫；下载到系统照片/PS 的颜色尚未对比，不能声称已证明显示色彩管理故障。用户确认单张、主动启用、可调强度的方案；不得自动改原图或将暖光整图调冷。
- 现有通用 auto 没有模型专用设置。新增 opt-in profile=nano-banana，保留 mode=auto/version=2 与按 assetId 存储；strength 范围 0–100，默认 60。低色度像素至少占不透明像素 25%，至少 16 样本，80% 颜色比例一致且不存在大量中性锚点时，才估计红/洋红/黄偏色。通道增益最大约 4%（整数参数取整有微小误差），默认强度进一步降低；不声称能分割产品或做色卡标定。
- 分析缓存按 source URL 与 profile 区分，最大 128 项、96px 采样；强度变化复用基础分析。预览、下载/复制和 Photoshop 导入均通过同一 resolveImageColorCorrection 得到参数。原图仍默认无滤镜；手动调整将已解析的参数转为 custom；四宫格仅选中资产保存设置。
- RED：work/q154-nano-red.log 4 项预期失败，work/q154-nano-ui-red.log 缺少入口失败；用户补充发紫后 work/q154-purple-red.log 2 项预期失败。测试覆盖红/紫/黄、暖木材与红色产品保护、中性锚点/混合照明、0 强度、缓存隔离/复用、保存边界、导出参数一致和手动恢复。
- 最终源码验证：work/q154-final-focused.log 69/69；work/q154-full-final.log 249 文件通过、2 文件跳过，3,852 项通过、2 项按设计跳过。npm.cmd run build 包含完整 workspace typecheck，退出 0（work/q154-build.log）；scan:e2e 通过（work/q154-scan.log）。
- 运行候选：work/q154-nano-candidate/report.json PASS，四宫格受控紫偏色 RGB 204/180/201 -> 默认60% 201/184/199 -> 100% 199/187/198，其余三张 filter=none；节点拖动、对比线拖动与布局检查通过，pageErrors=[]，exitCode=0，源项目 manifest/snapshot 未改变。reopen.json PASS，重新启动 1.6.154 后强度100恢复，恢复原图后四图 filter=none。
- 用户暖色厨房截图只取图片区域分析，work/q154-warm-scene.json 在0/60/100强度下均没有足够的全局偏色依据，像素未改变；这是暖光保护证据，不代表真实偏色原文件已经完成色彩标定。未付费生图，未操作真实 PS 文档。

### 1.6.154 安装包与 GitHub 发布

- NSIS 生成通过（work/q154-installer.log）。安装器为 apps/desktop-modern/dist-builder/desktop-modern-1.6.154-formal-final/CanvasAtelier-Win10-11-x64-1.6.154.exe，103610159 bytes，SHA-256 dd15b7d9d56173342224d15518d449a9c03d2a661fbdafee81911758066d5d8f；app.asar 为 8f75b1f354bb870c3a6021bb286fd14ddf03f752c1e61d30b26b88195bab9405。work/q154-package-identity.json 验证4个 renderer 与11个 desktop 文件与构建逐字节一致，旧 desktop-modern/latest.yml 保持原哈希。
- GitHub 正式发布 https://github.com/19960726/canvas-atelier/releases/tag/v1.6.154，release ID 392734813，draft=false、prerelease=false、Latest=true。四个资产远端大小/SHA-256 与本地一致，线上 latest.yml 下载比对一致；初次下载遇到 TLS 握手超时，只读重试成功，证据 work/release-1.6.154-published.json / work/q154-release-verify.log。仅发行二进制，既有 dirty 源码没有推送。
- 正式覆盖安装未完成：Start-Process 启动 NSIS 被 Windows 返回“操作已被用户取消”，见 work/qa-formal-install-1.6.154/installation.json。脚本已恢复旧 exe；重新核验注册表仍为1.6.153，app.asar仍为75e4cd57cbd23a915598caa587e2abc520b3c419904eca621845d855214bbc74，pre-1.6.154-install 临时路径不存在，原MCP已自行重启。不得称1.6.154已安装；没有绕过系统取消或覆盖运行中的用户窗口。

## 2026-09-21：图片节点底部按钮间距

- 根因：图片生成控制栏的 `1张` 外层轨道在窄节点中约 90px，但嵌套 `.generation-parameter-popover` 仍继承旧的 `min-width:112px`，触发器实际宽度约 95px，向 `2K` 和 `生成` 两侧越界，覆盖了应有的间距。
- 修复：在最终 release layout contract 中让数量 popover 使用 `box-sizing:border-box`、`min-width:0`、`max-width:100%`，并将控制栏间距统一为 8px。只约束图片数量嵌套控件，不改变模型、比例、清晰度或生成行为。
- 回归：先用 `work/q155-spacing-red.log` 复现相邻 gap 断言失败；修复后 `work/q155-spacing-fixed/spacing.json` 显示 `1张` x=546.71/right=623.64，`生成` x=630.44，间距约 6.8px，单行所有按钮均在各自轨道内；QA 正常退出、源项目 manifest/snapshot 未改变。CSS 契约 24/24，renderer build 退出0（work/q155-renderer-build.log）。
- 本次只修源码和验证，尚未重建/发布新的安装包；现有 GitHub v1.6.154 包不包含这次按钮间距修复。

## 2026-09-23：1.6.155 透明输出、浮窗 Agent、分层 PSD 候选

- 按根目录 1.6.155 精简交接继续，保留 dirty 源码、所有用户资产与已安装应用。Comfly 分层官方协议仍缺证据；用户没有官方链接或账号内接口样例。`seedream-v5-pro/layer-decomposition` 只见公开模型目录，第三方 Apifox 的归属未证实。因此自动分层提交继续禁用，没有发送付费请求，不能把受控分层 fixture 说成真实 Comfly 分层。
- GPT Image 2.5 透明请求根因：透明 PNG 未显式传 `output_format=png`，透明 JPEG 可绕过 UI 提交。`comfly-image-submission.ts` 现对透明 PNG/WebP 显式传格式、透明 JPEG 在提交前拒绝；`comfly-image-submission.test.ts` 和 `comfly-gpt25-flow.test.ts` 覆盖 2.5 型号/编辑、受控有效 RGBA 的保存、预览与原始下载。未用真实账号做付费生图或验证上游实际 alpha。
- 折叠图片结果的重载警告曾盖住打开编辑器中心点击；最终样式把它移到预览底部。视频参数 128px 控件曾裁切比例/清晰度，现紧凑显示两项，完整时长/张数仍在标题和设置弹窗；浮窗 Agent 输入区底栏宽度也收回圆角边界。`image-generation-execution.spec.ts`、`generation-parameter-adaptation.spec.ts`、`release-agent-layout.spec.ts` 均覆盖真实点击/边界。
- 新增 `image_layering` 节点、透明层/合成预览、顺序与可见性持久化，使用 ag-psd 写真正 PSD v1、8bit RGB、独立 RGBA 图层。`layered-psd.test.ts` 读回像素/图层；`image-layering.spec.ts` 检查四个真实 RGBA 素材的隐藏、重排、重开、PSD 下载字节。未伪造供应商拆层结果。
- Photoshop 的“在 Photoshop 中打开”使用独立 PSD 桌面桥：先校验 PSD 头/尺寸/位深，在主进程查找已安装 Photoshop，用户明确选保存路径后写入原始多图层 PSD，再启动 Photoshop 打开该文件；不再把 PSD 展平为单图智能对象。`layered-psd-open.test.ts` 覆盖无效输入、取消、查找/保存对话框抛错、保存/启动失败；查找与对话框异常返回明确错误码，不泄露内部异常到界面。浏览器 E2E 验证传给桌面桥的字节与下载 PSD 完全一致。机器只读确认 Photoshop 2026 注册路径；未操作用户 PS 文档，真实打开兼容性仍待安装态验证。
- 反推强度并发回归暴露旧标准强度草稿晚于用户选择写回，覆盖了“深度反推”。`ModuleNodeCard.test.tsx` 先复现 RED，之后以先前外部值为基准合并，保留新本地选择；独立及全量浏览器反推用例通过。
- 300 节点/500 连线拖动超过 250ms 的根因之一是每个位置帧都重建 Agent 引用/记忆属性并重绘对话与记忆树。稳定这些输入并 memo 对话/时间线后，独立 6/6 压测最大拖动停顿 184ms；三并发全量回归最高 240ms，接近门槛，不能外推到所有真实项目或机器。临时性能探针已移除。
- 新鲜验证：最后一次源码修改后的 `npm.cmd test` 260 文件通过、2 跳过，3981 测试通过、2 跳过；此前完整浏览器回归 `npx.cmd playwright test --workers=3 --reporter=line` 180/180，修改后受影响 `image-layering.spec.ts` 1/1；`npm.cmd run build`（含全工作区 typecheck）通过；`npm.cmd run scan:e2e` 通过。扫描前一份旧测试报告的公开 1×1 base64 fixture 触发规则，完整移到 `work/qa-archive-q155-video-contract`，未删除。
- 最后源码的内部候选 `node work/build-formal-1.6.155.mjs` 通过；`node work/verify-candidate-155.mjs` 验证 11 个桌面文件、4 个 renderer 文件与当前构建逐字节一致，latest.yml 的 SHA-512 与 installer 一致。最终 `app.asar` SHA-256 `d7cf4b3b2cbca7340087ff86166753ae7c00d794aebfe20b1ba5b779f76d1a9d`；安装器 103689062 bytes，SHA-256 `bc9a6f19b129475aadb3e2a86f27eaaa5ac0843cbf9ecd69b2072803e4366c0e`；blockmap SHA-256 `0825372125db08719e98c78f6630c57b3907aa3fca9bd2e9eb9eed7b1b8b2dad`；候选 latest.yml SHA-256 `9dbb86f92735c804db0b9e8a19f4eb58fb95345d8d55676e0f05ea528c87a532`。原 `dist-builder/desktop-modern/latest.yml` SHA-256 仍为 `7a267a4413afae5800ce9208cba96d5f427b5c87d7e6e65ce3beb245bf169d5b`。旧内部候选哈希已作废，不作为交付身份。
- 修改后 `node work/qa-candidate-startup-155.mjs` 在隔离 QA 数据根重新启动 unpacked 1.6.155：workspace 可见、PSD 桌面桥对非法字节返回 `invalid_psd`、pageErrors=[]、退出码0。此为候选启动，不是正式安装，也不证明 Photoshop 真实打开/Comfly 生图。未覆盖现有正式安装、未发布 GitHub；完整需求与正式发布仍受缺失 Comfly 协议及真实外部验证阻塞。
- 2026-09-23 只读复核正式目录 `D:/CanvasAtelier/Canvas Atelier/resources/app.asar`：当前 SHA-256 为 `8f75b1f354bb870c3a6021bb286fd14ddf03f752c1e61d30b26b88195bab9405`，包内版本 `1.6.154`，与旧 1.6.154 候选身份吻合；这不同于交接中“1.6.154 安装被取消、正式版仍 1.6.153”的历史状态。未确定变更时间/操作者，也未做 1.6.154 正式安装验收；不把它写成当前 1.6.155 已安装。
- 再次公开检索发现第三方 `https://s.apifox.cn/apidoc/docs-site/3868318/api-515635662` 仍标记“开发中”，另有 ComfyUI 第三方节点对 `seedream-v5-pro-layer-decomposition` 的描述；都没有给出 Comfly 官方域名/账号合同与计费/异步/回包证明。继续保持自动提交关闭；此证据缺口不能靠其它供应商同名模型的协议填补。

### 1.6.155 生图/视频/反推 UI 与画布性能续做

- 用户批准以新界面截图为基础落地：生图保留四宫格，素材输入超过 7 张横向滚动而不是结果四宫格滚动；基础参数与 GPT 专属参数分层；视频参数摘要常显、细项可展开；反推与深浅色统一精简，生成按钮缩小。Agent 对话和颜色校正保持现有功能与界面，不做无关重构。
- 扩展生图/视频编辑器整合成 704px 卡片，结果、素材、提示词和控制栏连续排布。图槽 7/8/20/25 阈值、五次快速换位、显式保存、重开持久化在三类节点通过本地浏览器。视频模型/模式/比例/清晰度/时长/数量及 GPT 画质/格式/背景保留；用户参考截图与深浅色 Playwright 截图的对照记录见 `docs/design-qa-1.6.155-ui-perf.md`。
- 新增性能 RED：`CanvasWorkspace.test.tsx` 先证明连续拖动会每帧重建 `isValidConnection`，再改为从稳定 `flowNodes` 构建并让端点刷新器读取同一稳定图。10 次瞬态位置变化保持相同校验器，位置提交与连线端点测试通过。300 节点/500 连线、三分辨率×两主题 6/6 压测通过，观察到的拖动最长停顿 248ms，接近 250ms 门槛；不能据此保证所有真实项目均不卡顿。
- 全量源码测试 260 文件通过、2 跳过，3,985 项通过、2 跳过。局部 E2E：图像/视频/图槽 54/54；反推/Agent/连线 11/11；压力 6/6。最后 GPT 标题像素位置修正后，整合界面 3/3、样式契约 25/25，完整 `npm.cmd run build`（含 typecheck）和 `npm.cmd run scan:e2e` 通过。`git diff --check` 的旧 `provider-bridge.ts` EOF 空行属于交接前未提交改动，未擅自改该无关文件。
- 在全新 `desktop-modern-1.6.155-ui-perf-r2` 目录生成 NSIS 候选，保留旧候选和正式安装。`work/verify-candidate-155.mjs` 证明包内 11 个 desktop 和 4 个 renderer 文件与最终构建逐字节一致；installer SHA-256 `a45fdf0534ef83d0395054aca00782b035a43f469e800fd22c59bba1d2193069`，app.asar SHA-256 `d7cf4b3b2cbca7340087ff86166753ae7c00d794aebfe20b1ba5b779f76d1a9d`。隔离启动报告 `work/qa-candidate-155-ui-perf-r2-startup/report.json` PASS：版本 1.6.155、workspace 可见、pageErrors=[]、exitCode=0。未覆盖正式安装、未发布、未实测真实 Comfly 自动分层或 Photoshop 打开。

### 2026-09-23 UI 截图复核补修

- AI 分层弹窗透明根因：`LayeringDialog` 通过 portal 挂到 `document.body`，而 `--gate-*` 色板只定义在 `.workspace--canvas-layout`，弹窗后代取不到这些 token，`background: var(--gate-card)` 计算为透明。现于 backdrop 为浅/深主题分别定义弹窗所需的表面、文字、边框、强调色；对话卡片为实色，只有页面遮罩维持半透明。独立节点、layer order、PSD 导出边界未变。
- Agent 历史按钮的原透明态是 floating header 的高优先级规则强制覆盖背景/边框；现以 `aria-expanded` 给轻量柔和选中态，历史弹窗关闭控件统一 28px 图标尺寸、圆角、hover 与键盘 focus ring。未改 Agent 模式、消息或会话逻辑。
- 视频/图片结果四宫格原本已有固定两列布局，本轮只补真实 UI 验证夹具：4 个本地受管视频各自使用唯一 assetId，展开后确认没有“正在加载返回视频”且 columns=2。样式没有重复造另一套布局。Image generation 现有 image 输出端口服务图像后续连线/分层；更新过时的 `ModuleNodeCard.test.tsx` 断言，要求 input references + output result/image 三个明确端口。
- 截图：`work/qa-layering-ui-2026-09-23/layering-dialog-{light,dark}.png`；完成态视频四宫格浅/深截图位于 `work/qa-ui-audit-2026-09-23/video-four-grid-reviewed/`；生图四宫格及图片/视频节点主题截图位于 `work/qa-ui-audit-2026-09-23/image-generation-review/`；Agent 历史及视频节点参数截图位于 `work/qa-ui-audit-2026-09-23/e2e-review-final/`。
- 验证：`tests/e2e/image-layering.spec.ts`、`agent-floating-window.spec.ts`、`video-generation-ui.spec.ts` 共 51/51，另 `integrated-generation-card.spec.ts` 3/3、`video-inset-and-twenty-slots.spec.ts` 4/4、`node-drag-persistence.spec.ts` 1/1、`durable-canvas-stress.spec.ts` 6/6（合计 65/65）；覆盖浅/深色图片/视频节点、生图四宫格、25 个素材的缩略图保留/滚动/拖拽换位、注入一次保存失败后手动重试并重开画布、视频提示词与参数重开一致，以及 300 节点/500 连线的浅深色三视口交互压力矩阵。性能矩阵的最大观测卡顿 176ms（阈值 250ms）。相关 5 个 Vitest 文件 567/567；`npm.cmd run build`（含 workspace typecheck）通过；`npm.cmd run scan:e2e` 通过。build 有既存的大 chunk size warning；`git diff --check` 仅指出交接前 dirty `packages/desktop-core/src/provider-bridge.ts:1098` EOF 空行及多处 CRLF 转换提示，本轮未改该无关文件。
- 保存错误恢复在本地故障注入场景通过；但用户报告的真实机器长期旋转/多次连续调序卡顿仍未在正式安装或真实项目中重现、也未完成保存-重启验收，不能宣称此现场问题已修复。Playwright 的图片/视频画面均为本地合成夹具，不代表供应商生图或生视频结果。
- 本轮只修源码/测试并保存本地 QA 图，不打安装包、不安装、不发版；本地 E2E 构造素材不调用付费供应商。安装态行为仍未验证。

### 2026-09-23 视频五行展开菜单与统一视觉复核

- 按用户最新参考图，视频控制栏仍保持紧凑摘要；展开菜单改为比例、清晰度、时长滑块、生成音频、生成数量五行。滑块遵守所选供应商的离散时长限制，不能把 UI 的 1 秒刻度误认为所有模型都支持逐秒生成；音频能力不支持的路线不显示音频开关。开关增加明确的“开/关”字样及可见圆点边界，状态随草稿和提交参数传递。
- 弹层依据当前视口剩余空间选择向下或向上展开；1600×1100 的本地截图可在下方完整展开，不覆盖提示词。反推工作台标题、状态与边框收敛到同一表面规范；Agent 最窄宽度编辑区间距、圆角改为紧凑规格；颜色校正维持新版图片节点入口，预设及“更多调节”均可用。截图统一位于 `work/qa-ui-audit-2026-09-23/final-review-r1/`。
- 本地回归：视频时长 4→6 秒、音频开→关→开、深浅主题布局，连同生图、颜色校正、反推、Agent 共 25/25 Playwright 通过；300 节点/500 连线 6/6 压测本轮拖动最大观测停顿 144ms，另保存失败→重试→重开用例 1/1。完整 `npm.cmd run build` 含类型检查通过，末次 CSS 后 renderer 构建通过，限定文件 `git diff --check` 通过。压测的 zoom 事件零采样，不能称其延迟已量测；浏览器开发服务偶发 ResizeObserver loop 警告，相关测试仍通过。
- 以上是源码/本地浏览器证据，不是正式安装包、真实付费供应商或 Photoshop 验收。按用户约定先交截图检查，不打包；真实 Comfly 自动分层合同缺证据，继续禁用自动提交。
- 用户随后指出音频行内“开”字与圆点挤在一处显得奇怪；撤回字内嵌设计，改为独立“已开启/已关闭”文字 + 34×20px 标准滑块，圆点两端均保留内边距。新版深浅主题截图在 `work/qa-ui-audit-2026-09-23/video-audio-refine-r2/`；音频往返切换、时长滑块、视频参数弹层及图片四宫格 3/3 Playwright、`ModuleNodeCard.test.tsx` 294/294、完整 workspace typecheck 和 renderer build 均通过。此改动仍未打包或安装。

## 2026-09-24 干净交接：视频音频行整行居中与源码界面清单

- 根因：视频五行参数菜单的音频按钮容器被放在两列网格的右列并 `justify-content: flex-end`，按钮整体中心相对整行偏右 107px。现在音频行有独立 `--audio` 类，标签与跨整行的按钮容器固定在同一网格行；容器居中后，本地 Playwright 实测偏差 0px。音频开关值、图文内容和其它四行参数保持原逻辑。
- 回归位置：`tests/e2e/integrated-generation-card.spec.ts` 的深浅主题用例新增整行与按钮的中心坐标断言。先 RED（107px），修复后 3/3 通过。另 `tests/e2e/clean-handoff-ui-audit.spec.ts` 用本地夹具检查 26 种 domain 注册模块、8 种当前画布过滤的旧渲染器、AI 分层、Agent、生图和视频。新截图与逐项状态在 `work/qa-clean-handoff-2026-09-24-r4/report.md`；新证据不引用 2026-09-23 截图。
- 本轮相关 Playwright 15/15，旧项目迁移与反推 10/10；局部 Vitest 329/329，`npm.cmd run typecheck` 和限定文件 `git diff --check` 通过。AI 分层分析回复来自 E2E 本地 JSON，`modelSubmissions=0`，浏览器外部 HTTP 请求 0；没有真实供应商、额度消耗、打包或安装。
- 未解决：生图节点靠顶部展开时 AI 分层入口被顶栏 Agent 按钮挡住，命中记录见 r4 `layering-entry-hit.json`；适应视图后可点，本轮未改该独立布局。真实透明背景路由仍无已验证证据，确认生成保持禁用。程序化焦点探针在 11 种模块上未保持焦点，不能由此单独断定键盘不可达。
- 工作树边界：保留原有 dirty 源码与未跟踪文件，未清理。运行已有 `image-layering.spec.ts` 时该用例向固定 `work/qa-layering-ui-2026-09-23` 路径写图，可能刷新了该目录 8 张旧 PNG；运行前未记录哈希，不能保证原字节未变。正式安装与真实项目未验收。

### 2026-09-24 续查：浅色视频时长控件外观

- 用户截图中的浅青色框是时长滑块的键盘焦点框。复现时失焦滑块仅有裸滑轨，而获得焦点后出现一个 38px 高的圆角框；相邻下拉参数始终是 30px 高的浅色底框。根因是通用 `.workspace--canvas-layout .module-node :is(button, select, input)` 把 `input` 的最小高度强制为 38px，旧时长专用样式只指定 `height:20px` 且保持透明、无边框。
- `release-layout-contract.css` 的时长专用规则现明确限定高/最小高/最大高为 30px，加入与同菜单下拉框一致的底色、1px 边框和 7px 圆角；滑块横跨完整右侧参数区，时长值叠放在框内，滑轨为数值留出空间，键盘焦点框仍显示。没有改变时长值及音频开关逻辑。
- 回归在 `tests/e2e/video-duration-appearance.spec.ts`：先 RED（滑块实测 38px、下拉 30px），再为整块控件等宽要求 RED（148px 对 188px），最终 GREEN；失焦/键盘焦点/再失焦新截图、计算样式与报告在 `work/qa-duration-appearance-2026-09-24-r6/`。验证命令：`npx.cmd playwright test tests/e2e/video-duration-appearance.spec.ts tests/e2e/integrated-generation-card.spec.ts --workers=1`，4/4 通过，覆盖浅色焦点与深浅主题参数菜单、音频整行居中；`npm.cmd test -- apps/renderer/src/styles/release-layout-contract.test.ts` 26/26，`npm.cmd run typecheck` 通过。
- 此续查是源码与本地浏览器证据；没有打包、安装或调用真实供应商。原审计的 AI 分层入口与顶栏重叠、实际供应商及安装态未验证项仍见 `work/qa-clean-handoff-2026-09-24-r4/report.md`。

### 2026-09-24 未解决项续修：AI 分层入口与焦点清单

- AI 分层入口遮挡根因是最终 `release-layout-contract.css` 中共享生图布局把结果工具条设为 `top:-82px`；卡片 y=110px 时，按钮落在 y=36–70px，中心被固定顶栏的 Agent 按钮命中。`tests/e2e/unresolved-ui-regressions.spec.ts` 先在深浅主题复现 RED，再将工具条放到卡片顶部空白操作区（`top:9px`），同一摆位按钮变为 y=127–161px。普通 `locator.click()` 无需适应视图即可打开 AI 分层弹窗；顶栏与卡片头其他控件仍可见。保护行为是结果工具条保持在生图卡内，不改变分层提交门禁或画布视口。
- 视频时长通过 Playwright 真实鼠标拖动从 4s 变为 8s，并同步到参数摘要；此前仅有方向键证据的交互空缺已补。原 11 项“焦点未保持”是审计脚本优先选到隐藏但未禁用元素的误报；修正为可见可用控件后，26 种模块中 21 种控件聚焦成功，5 种空态没有可见可用控件。未把空态节点误称为可键盘操作，也未修改其产品代码。
- 验证：`npx.cmd playwright test tests/e2e/unresolved-ui-regressions.spec.ts tests/e2e/integrated-generation-card.spec.ts tests/e2e/video-generation-ui.spec.ts --workers=2` 为 50/50；`npx.cmd playwright test tests/e2e/clean-handoff-ui-audit.spec.ts --workers=1` 为 4/4，重生 26 种模块与 8 种旧渲染器截图，并在原摆位直接进入分层流程；`npm.cmd test -- apps/renderer/src/canvas/ModuleNodeCard.test.tsx apps/renderer/src/styles/release-layout-contract.test.ts apps/renderer/src/app/layering-route-evidence.test.ts apps/desktop-modern/src/layered-psd-open.test.ts` 为 326/326；`npm.cmd run typecheck` 通过。新截图与逐项报告在 `work/qa-clean-handoff-2026-09-24-r5/`，遮挡/拖动/焦点复核在 `work/qa-unresolved-ui-2026-09-24-r2/`；旧 r4 和 r1 证据保留。
- 生产分层路由证据 `PRODUCTION_LAYERING_ROUTE_EVIDENCE` 仍为空；本地 JSON 夹具只验证 UI/流程，真实透明像素与费用没有证据，确认生成继续禁用。Photoshop 桥的错误/保存路径单测通过，但真实打开、当前源码安装态仍受用户“未经检查不打包、不安装”和外部环境边界限制。此次没有请求供应商、消耗额度、打包、安装、清理工作区或重跑会写入 2026-09-23 固定目录的旧用例；此前 8 张旧 PNG 的原字节没有可验证的前置哈希。
- 2026-09-24 公开文档只读复核：OpenAI 官方 `https://developers.openai.com/api/docs/guides/image-prompting` 明示 GPT Image 的透明背景编辑与 PNG 参数；Comfly 官方 `https://ai.comfly.org/zh` 仅泛称 API 兼容，未给出当前 Comfly 精确路由的透明参数透传和 alpha 回包证明。因此不把 OpenAI 上游文档误记为 Comfly 生产路由证据，也不解开零费用门禁。

### 2026-09-24 YANZO Canvas AI 分层流程适配

- 用户确认参考软件为 YANZO Canvas，并选择适配参数到结果的全流程。本机参考资源显示智能/自定义模式、2–12 层、模型与分辨率选择、持久任务历史/恢复、原图/合成图、语义复核及 PSD 输出；本次是本地资源代码研究，不是参考软件供应商验收。
- Atelier 分层分析加入智能/自定义目标层数，自定义范围 2–12；解析器支持最多 12 层。合成节点新增完成数、原图/合成图切换、任务状态同步和失败单层重试确认。重试保留分层组及层 ID 并重绑画布图层；精确透明路由证据仍为唯一提交门禁。
- 新鲜截图与报告：`work/qa-layering-yanzo-2026-09-24/report.md`；浅/深参数（含 12 层）、确认门禁、进度、原图和合成图截图在同目录。Playwright 2/2，模型提交 0，外部 HTTP 0；定向 Vitest 32 项分层 UI/分析/计划工作台测试及 4 项 app-store/任务恢复测试通过，workspace typecheck 通过。
- 未验证真实供应商、计费、透明像素质量、正式安装、重启期间真实任务恢复和 Photoshop 打开。生产透明背景证据仍为空；没有独立历史下拉列表。未打包、未安装，保留工作区既有修改和未跟踪文件。

### 2026-09-24 续修：YANZO 语义分层与 Agent 空状态居中

- 对照本机 YANZO Canvas 分层面板的参数、计划复核和输出流程，Atelier 分析提示现在按实际画面语义逐项拆解：背景及遮挡处重建、每个产品/清晰摆件单独成层、对象接触阴影/投影各自单独成层并标注对应对象；对象像素不带投影，阴影层不重画对象，保留原图尺寸/位置/遮挡顺序。图层名称与说明在确认前均可逐层编辑；“主体/细节/前景/对象/图层”等泛称无法进入确认。每个被包含图层仍对应一个独立图像任务，阴影任务再次明确只绘阴影。
- 自定义层数不再诱导模型合并语义对象：当实际对象和阴影多于目标时，UI 提示增加目标；少于目标时提示降低目标，不编造空白/重复层。分层计划返回后右侧面板滚到顶部；长计划移除列表内层嵌套滚动，统一由右侧面板滚动。
- “开始对话”偏左根因：基础 CSS 将 intro 限宽300px且居中，高优先级浮窗规则把 margin 重置为零；父网格又将宽度受限的项目贴左放置。Playwright 在504×720浅/深主题复现球与输入框中心相差55px；改为受限宽度下显式 `justify-self:center` 和 `margin-inline:auto` 后球偏移0px、标题偏移约-0.008px。Agent 建议标题另受画布通用按钮子元素居中规则影响，浮窗专用样式现将标题恢复为左对齐，1024×900实测所有四行字形均始于图标右侧13px，且最右未越过行中心前36px。
- 新鲜截图/机器结果：`work/qa-layering-yanzo-semantic-20260924-r3/`（浅/深参数、五层方案、门禁、进度、原图/合成图；结果 JSON 的模型提交数与外部请求均为0）；`work/qa-agent-quicktask-alignment-20260924-r4/`；`work/qa-agent-empty-intro-20260924-r3/`（含前后偏移 JSON）。测试截图均由本轮最新源码与 Playwright 本地夹具生成。
- 验证：全量 Vitest 268文件通过、2跳过，4058项通过/2项跳过；完整 `npm.cmd run build`（含全工作区 typecheck）退出0，renderer 有既存 chunk>500KB 提醒；`npm.cmd run scan:e2e` 通过；Agent 空状态中心、Agent 建议行及 YANZO 参数/五层方案/预览共6/6 Playwright。候选 `win-unpacked` 隔离启动报告 `candidate-startup-r26-retry/report.json` PASS：版本1.6.156、无 pageError、退出0。`git diff --check` 仅报告 main.styles.test.ts 的 CRLF 转换提示。
- 新 NSIS 候选在 `work/qa-release-1.6.156-20260924/installer-output-r26-retry/CanvasAtelier-Win10-11-x64-1.6.156.exe`，105019229 bytes，SHA-256 `7e447b8b5b6b2881a30dabc71ba74d2448a4d7efce0a9b37b9247535f4bcb0d8`；app.asar SHA-256 `040336c4468e8dbcd0a750803784f16bf308fd2787d063136cfe6ef3c4f40794`。字节身份与 renderer、MCP、Photoshop、图标逐项核对见 `package-identity-r26-retry.json`；electron-builder 生成的 app-update 配置检查了 GitHub provider/repo/release keys。包未签名，未安装、未发布。第一次独立输出因 Windows `UNKNOWN` asar-integrity 文件写入失败，原 r26 失败目录保留；用新 retry 目录与既有短暂错误重试包装器后成功，没有覆盖 r25 或失败输出。
- 风险：上游 AI 对语义提示的遵循度、实际透明像素、边缘/阴影合成质量和计费均未由真实供应商验证；生产透明背景路由证据仍为空，确认生成按钮保持禁用。五层场景是本地 JSON fixture，证明界面和任务合同，不证明模型真实分割精度。安装器未安装/签名，正式安装态、真实项目和 Photoshop 打开仍未验证。完整源码、dirty 修改、未跟踪文件及旧 r25 均保留。

### 2026-09-24 1.6.157 Agent、节点与生图单端口交接

- 生图节点双圆点根因是域层保留 `generation_result` 和 `image_asset` 两种必要输出，但 UI 各自渲染一行；旧修复仅隐藏第二行，悬停又出现。新 UI 只渲染一个输出行和可见 `result` 端口，`image` 仍作为透明、不可点击的同坐标 React Flow handle 供旧连线定位；连接校验、提交和空白画布快速插入会按目标输入类型将可见端口映射成 `image` 或 `result`。先失败的组件/连接回归后 479/479 通过，本地从端口正向拖到图片自动分层与结果输出、从两类目标反向拖回均成功，悬停截图仅有一个圆点；没有删除域合同中的任一输出。
- Agent 模型菜单由大面板改为紧凑搜索式选择，推理强度弹层收小，素材槽随内容收紧并支持反推素材双击放大；Codex 模型档案从 CLI 动态读取 GPT-6 Astra/Sol/Luna。问问 AI 顶栏与对话空态共用玻璃球贴图，加外环旋转、内部移动高光、呼吸及减弱动态效果兼容；Playwright 直接取样两个位置的动画变换。Agent、布局、媒体与连接本地 3/3 通过，未发送对话。
- 本轮新截图及逐项验收为 `work/qa-agent-node-layout-20260924/report.md`：26 个注册模块节点、8 个过滤旧画布渲染类型，AI 分层七层场景夹具逐层编辑/排除到六层复核、无已验证透明背景路由的生成门禁；视频音频按钮整行中心偏差 0px，时长/音频控制及生图参数；颜色校正深浅色弹层无遮挡。分层/节点 10/10、Agent 与正反向连线 4/4、颜色 2/2、整合卡/300 节点与 500 边性能 9/9。语义与阴影质量只由本地夹具证明界面合同，不代表真实供应商效果；压力测试仍出现超过 100ms 的缩放帧间隔。
- 全套 Vitest 268 文件通过、2 跳过，4065 项通过、2 跳过。初次全量发现 `runtime-entry-contract.test.ts` 的版本预期停在 1.6.156，改为 1.6.157 后全量重跑绿。完整 `npm.cmd run build`、`npm.cmd run scan:e2e`、`git diff --check` 通过（只出现 LF/CRLF 提醒）。renderer 仍提示主包大于 500KB。
- 新 NSIS 候选 `work/qa-agent-node-layout-20260924/installer-output-r1/CanvasAtelier-Win10-11-x64-1.6.157.exe`，105020329 字节，SHA-256 `48a269826a04bd4b9b3ebe56438eb65d7f8e493b14101d2a7b54e574e071979e`；app.asar SHA-256 `064773a2774c75a0194a1035a4700c40c480becd58666991b834dad9432b8b16`。desktop、renderer、MCP、Photoshop、图标与包内容逐字节核对；隔离 `win-unpacked` 启动版本 1.6.157、页面错误 0、错误 PSD 返回 invalid_psd、退出码 0。未安装、未发布、未发起真实供应商请求。正式安装、真实项目、Photoshop COM、上游透明图质量与额度仍单列未验证。完整 dirty 工作树和未跟踪文件保留。

### 2026-09-24 1.6.158 用户海报分层、分层节点单输入与 Agent 控制栏

- 用户新截图指向的是 `image_layering`，并非上轮已修的 `image_generation`。分层节点内部 `image` 和 `layerImages` 仍保留，但左边合成一个可见接点、右边保留一个输出；同组独立子层映射到 `layerImages`，外部原图仍走 `image`。组件和连接测试先红后绿，正常缩放的新截图与 Playwright 均为左 1、右 1。没有抹去旧工程端口 ID。
- 本轮使用用户的加热杯广告图原文件：658×1208 PNG、625071 bytes、SHA-256 `63993fdcc46f070884691a76f0e83660422f3690d8313d12e208dcb5485f3d3c`。Playwright 验证导入 data URL 与原图字节相同，进入分层分析、显示 12 层本地可编辑方案与无路由生成门禁。方案覆盖背景、展台、产品、热光、蒸汽、两组标题、80W 文案和底部对比卡；未强加无法可靠辨认的投影。**该方案由本地测试回复提供，不是真实模型分析；透明 PNG/PSD 未生成**。模型提交和外部请求均为 0。生产分析提示新增海报文字/图表/热效规则。
- Agent 对话底栏模型按钮移除 78px 固定宽度，浅色新截图完整显示 `chatgpt-4o-latest`；浮窗、窄宽度、模型与推理控件、素材预览、小球动画 Playwright 9/9。另有本轮 26 注册节点、8 旧类型、Agent/生图/视频参数新截图与盘点，详见 `work/qa-layering-user-image-20260924/report.md`。
- 全量 Vitest 268 文件通过/2 跳过，4067 项通过/2 跳过；升版后包装入口定向测试 23/23。全工作区 typecheck/build、scan:e2e、diff check 通过。候选 NSIS `work/qa-layering-user-image-20260924/installer-output-r1/CanvasAtelier-Win10-11-x64-1.6.158.exe`，105020629 bytes，SHA-256 `2be87a27468a8e1a3b84a4d099f6a541b43ce881db516ee99e651ebf1a64c134`；资源逐字节核对，隔离 `win-unpacked` 启动版本 1.6.158、页面错误 0、退出 0。未安装、未发布；供应商真实分层、PSD、Photoshop COM、正式安装与真实项目重开仍未验证。

### 2026-09-24 1.6.160 图槽密度、Agent 合并控制与验收复盘

- 用户症状：12/20 张素材只显示少量图槽并在展开卡片右侧留大片空白；Agent 模型和反推强度分开占位。图槽根因是生图卡片素材条继承固定 474px 宽度及 7 张以后横向滚动。`ConnectedAgentMediaSlots.tsx` 现按数量标记布局；`release-layout-contract.css` 对展开生图卡片使用完整宽度，1–12 张一行、13–20 张两行，同步增加素材区及下方控件高度。反推和视频原滚动合同保持。`tests/e2e/image-slot-density.spec.ts` 旧 474px 布局 RED，修改后 GREEN；`video-inset-and-twenty-slots.spec.ts` 验证 20 张两行、25 张滚动、换位、保存重开。Agent 模型/反推强度合在一个弹层和底栏按钮，方案选择与聊天布局复测。截图和逐项报告见 `work/qa-release-1.6.160-20260924/report.md`。
- 源码层：`npm.cmd test -- --reporter=dot` 268 文件/4071 项通过、2 文件/2 项跳过；`npx.cmd playwright test --workers=2 --reporter=line` 223/223；`npm.cmd run scan:e2e` PASS。构建层：`npm.cmd run build` 含 typecheck PASS；限定 diff check 退出 0。包层：1.6.160 NSIS 105022583 字节，SHA-256 `fa4721d57da8586a9fdf74ac2b4bbd2f0eafa8ee8c421da9e555f0e502254253`；app.asar SHA-256 `3646e0141f24208fc58bd3b4644728ac5f252db7f7743e92615cea48700a9384`；desktop/renderer/MCP/Photoshop 与构建产物逐字节一致，包未签名。
- 解包候选隔离重验：首次 QA 脚本把目录命名 `canvas-160-*`，不符合 `resolveQaUserDataRoot` 要求的 `canvasforge-qa` basename，且未在 UI 操作前检查运行时 userData，三个 QA 项目误落真实用户数据。先前启动 PASS 不能作为隔离证据。现修正脚本命名，并在任何 UI 修改前断言 `app.getPath('userData')` 等于 QA 根。`candidate-startup-r2/report.json` 与 `package-persistence-qa-r2.json` PASS：启动、保存/重启恢复、MCP 14 工具、错误 PSD 拒绝、无页面错误、干净关闭/退出码 0；首次失败报告留存。
- 真实用户数据善后：仅三个带本轮唯一 `QA160-*` 标记的项目及 recovery 被移到可逆的 `accidental-real-userdata-qa-quarantine/`；recent 索引原件备份后仅移除三个测试项，其余四项保留。另一个已有 149 节点项目在错误隔离期间保存时间更新；缺少前置字节快照，不能断言它没有内容变化，故未回滚。以后所有安装包 QA 必须先断言隔离根，再允许创建或保存。
- 正式安装层 BLOCKED：NSIS 触发 Windows UAC，系统返回“操作已被用户取消”；`D:\CanvasAtelier\Canvas Atelier` 仍为 1.6.159，不能宣称安装成功。外部供应商/Photoshop 层 UNVERIFIED：真实 Comfly 透明层和 Photoshop COM 未实测，生产分层生成门禁不解开。GitHub Release/在线更新层 NOT DONE：1.6.160 未发布。下一接续点为用户允许 UAC 后运行 `work/qa-release-1.6.160-20260924/verify-formal-install-1.6.160.ps1`，正式安装态复验，并单独处理供应商与 Photoshop 证据。

### 2026-09-25 1.6.160 AI 分层正式验收接续

- 用户要求全部验收成功，包括真实 AI 分层。分层生产路由证据数组目前为空，不可把目录 capability 或本地 JSON 夹具当成透明像素实证。OpenAI 官方图像文档说明 `background=transparent` 与 PNG/WebP 的上游合同，但 Comfly 转发是否保留 alpha 仍需精确路由实测。本轮构造 1024×1024 蓝色杯子源图，SHA-256 `dbe5d59269c780f728690a4c0955335cbdd053e2757cb8e6fda7303bd938a563`；固定 `comfly-gpt-image-2-5-flare`、1K/low/PNG/transparent、单次提交且不自动重试的 live 意图，SHA-256 `6792842ecc850637ef33423d98f79a5cd5005e01b00da8318a5991a30d922d5e`。用户付费调用答复尚未收到，实际提交数 0。
- 零费用生产候选预检：`candidate-comfly-readonly-qa.json` 在独立 `canvasforge-qa-*` userData 中复制加密配置和 `Local State`，Comfly `checkConnection` 为 connected，Flare/Sunburst 生图、编辑、异步能力齐备，pageErrors=[]、退出 0；临时凭据副本经目标路径验证后清理。首次未复制 `Local State` 时凭据锁定，保留失败记录。`candidate-layering-preflight-qa-r2.json` 验证源图经真实文件桌面桥导入并持久保存；最初脚本的 operation ID 不符 `dropped_media_*` 合同，RED 记录保留，修正后 GREEN。`candidate-live-alpha-preflight.json` 固定了单次 live 合同，未发送生成请求。
- Photoshop 候选验收：`candidate-photoshop-open-qa-r2.json` 的双图层 PSD 字节及哈希一致，`photoshop-window-qa.json` 证明 Photoshop 2026 窗口实际显示该 QA PSD；`candidate-photoshop-placement-qa.json` 经应用桥导入 QA 图片到活动文档返回 `ok:true` 和新图层名。PowerShell 的独立 COM 探针报类型库错误，但它与应用桥是不同入口；应用入口真实通过。后续仍需在正式 1.6.160 安装态重验。
- 正式安装第二次尝试仍被 Windows UAC 返回“操作已被用户取消”，正式 app.asar 仍是 1.6.159；未再重复触发 UAC。1.6.160 GitHub Release 和在线更新仍未发布。此轮完整证据及自我复盘见 `work/qa-release-1.6.160-20260924/acceptance-20260925.md`。未通过的 AI 分层真实返图、完整两层任务链、正式安装和在线更新必须继续分层报告，不能合并为 PASS。

### 2026-09-25 1.6.161 设置页质感、真实状态与验收复盘

- 用户要求设置页有更强质感，并把其他问题一起处理。设置页现为 760px 自适应面板，统一字号、分类按钮、卡片边界／阴影、间距与焦点；480px 窗口分类两行、供应商两列。地址／缓存路径左对齐，连接与 MCP 按钮图标文字同行，模型保存按钮有独立间距。修复设置页低于浮动工具栏的层级，密钥和更新弹窗继续高于设置页。
- 功能展示根因：下载目录开关和数个按钮没有处理函数；activeBytes 同时被标成画布原图与作品输出；四个缓存分类按钮都调用同一个 purgeExpired；本机知识库检查被描述为跨设备同步已开启。移除空操作和未接通云同步选项，统计改为历史媒体／回收站，清理名称改为真实的过期回收站媒体，本机版本检查按实际能力描述。
- 回归先红后绿：`SettingsDrawer.test.tsx` 先复现 2 项错误展示；`settings-visual-acceptance.spec.ts` 先复现最小字号 8px、工具栏遮挡、连接按钮图文中心偏差 19px。最终截图覆盖 1680/1024/480px 与深浅色，含模型区和 MCP 底部。旧静态检查只证明控件存在／样式字符串，未验证最终级联和真实行为；初看 app.css 误判 428px，运行态实际为 720px，因此以后用计算样式和新截图定位。
- 源码层：全量 Vitest 268 文件／4071 项通过、2 项跳过；最终样式和升版后定向 168/168。首轮全量 Playwright 229/230：1920×1080 浅色缩放卡顿 250ms，门禁 `<250ms`，保留 `work/qa-settings-20260925-r1/full-e2e-before-final-polish.json`。单场景重验缩放 82ms，未改阈值；最终完整重跑 231/231、退出 0（`final-e2e.log`），首轮波动根因未确定。曾因进度截断误报全绿，已纠正；以后必须以最终退出码和完整汇总为结论依据。
- 构建层 PASS：最终 `npm.cmd run build` 含 typecheck；只有既有 chunk size 提示。包层 PASS：`work/qa-release-1.6.161-20260925/installer-output-r1/CanvasAtelier-Win10-11-x64-1.6.161.exe`，105022724 bytes，SHA-256 `a5f21332c8255787443d8dc6dd6e090e68f61c81917fbe2ce64faacc73c6c4ed`；app.asar SHA-256 `5f62a7b60852ea7e15b7ecfc9e6d70a6a1228f0543a92b4734d4f702b84b7990`。desktop/renderer/MCP/Photoshop 与构建逐字节一致，NSIS 解出 86 文件全部匹配，latest.yml 的版本／大小／SHA-512 一致，SHA256SUMS 已生成。
- 候选运行体 PASS：先断言独立 QA userData 再操作。1.6.161 启动、保存／重开、MCP 14 工具、错误 PSD 拒绝、正常退出均通过，pageErrors=[]；真实候选浅深色四个设置分类共 8 画面无横向溢出。证据 `candidate-startup-r2/report.json`、`package-persistence-qa-r2.json`、`candidate-settings-qa.json`。
- 正式安装／外部／发布仍分列：只读复核正式安装仍为 1.6.159，UAC 待用户处理，本轮未再触发。真实 Comfly 透明分层付费确认尚未收到，提交数 0，生产路由门禁未放开。1.6.160 候选 Photoshop 真机结果保留，1.6.161 未重复外部写入。GitHub v1.6.161 不存在，未发布／未验证旧版在线更新。完整报告与下一接续见 `work/qa-release-1.6.161-20260925/acceptance-20260925.md`；不可宣称全部交付 PASS。

### 2026-09-25 1.6.162 设置页整体重设计与审美验收复盘

- 用户明确指出 1.6.161 仍不够高级。此前验收只证明无溢出、控件可用，未证明信息结构和视觉主次已经满足设计目标；不能把功能 PASS 当作审美通过。重新查看真实界面后，将等权卡片堆叠与横向表单导航改为 176px 左侧分类、右侧独立内容区和页面标题；980px 自适应容器、暖白／石墨底色与低饱和青绿，弱化重复边框，地址重置改为文字操作，凭据摘要改为信息行。760px 以下导航放到顶部两列，功能入口与数据处理保留。
- 实现与回归：`SettingsDrawer.tsx` 增加导航／tabpanel 关联、组件 ref 重置滚动和分类页标题；最终样式集中在 `release-layout-contract.css` 末尾原设置区块。`settings-visual-acceptance.spec.ts` 先复现侧栏目标失败（758px），再复现旧高优先级 grid 样式导致图文中心差 26.5px。修正最终级联后，导航与正文左右位置、图文同行、浅深色／1680/1024/480px、溢出和弹窗层级通过。首次 scrollTo 调用在 jsdom 报错，改为组件 ref + scrollTop，新增分类滚动恢复行为断言；旧四列布局测试更新为新侧栏合同。以后必须检查计算样式与图文位置，不能只看源码是否存在 flex。
- 源码层 PASS：最终设置与打包入口 6 文件、110/110；设置相关浏览器 13/13、退出 0。构建层 PASS：全工作区 typecheck 与 build；scan:e2e、限定 diff check 通过。此次没有将上一版 231 项全量结果冒充新版本全量回归。命令和日志在 `work/qa-release-1.6.162-20260925/acceptance.md`。
- 包层 PASS：新独立 NSIS 候选 1.6.162，105024017 bytes，SHA-256 `a57314fac6d54d8ac50eba11f49dd730d465d98472d0ddda76deb786426fa10e`；app.asar SHA-256 `405a29fc0f9b4870472dd45c01a81e300f0fbe87ee79115e611f9aaad05665fd`。构建资源／更新元数据一致，NSIS 解出的 86 文件全部逐字节匹配。保留 1.6.161 包。
- 候选运行层 PASS：先断言独立 canvasforge-qa userData；1.6.162 实际浅深色四分类 8 个画面、保存／重开、14 MCP 工具、错误 PSD 拒绝、正常退出通过，pageErrors=[]。截图来自实际候选及受控浏览器；模型数不代表真实账户可用性。
- 正式安装层本轮未执行，先前 1.6.159／UAC 阻碍延续；真实 AI 分层付费确认仍待答复，提交数 0，未改生产路由证据。Photoshop 外部操作未重测。GitHub 未发布、用户在线更新未验证。下一接续应使用最新 1.6.162 候选，继续正式安装、获准后的真实分层和最终发布；不能宣称原始全量交付完成。

### 2026-09-25 1.6.163 统一全局深色主题

- 用户明确选定：所有深色界面采用新版设置页的石墨／灰绿色配色。以后新组件应复用全局变量：canvas #191e1c、surface #202523、surface-muted #272d2a、border #373e39、text #e8ece7、muted #a2aea6、accent #8ed5be、accent-soft #2b4238，保留错误／警告／端口语义色。浅色基础变量不改。
- 根因：全局 tokens、Canvas Gate 多轮后置覆盖、Agent action、设置局部变量和 body portal 分别定义深色，导致新设置与其余页面色调不同。修改 tokens，新增最后导入的 `atelier-dark-theme.css` 映射这些变量并处理保存按钮、知识库入口和图片菜单的硬编码。设置页改为读取共享色；分层浅青绿主按钮使用深色文字。
- 新鲜验证：主题旧画布色值先 RED，修改后 GREEN；对比度正文 13.02、辅助 6.11、主按钮 9.19。137/137 相关单测通过，全 workspace typecheck/build 通过。广浏览器 33/34，唯一历史遮挡未通过；最终修正后主题／历史／分层针对性 6/6，退出 0，其余已通过的界面不重复跑。不要称为一次完整 34/34。报告 `work/qa-release-1.6.163-20260925/acceptance.md` 保留每次结果。最终 renderer 重建、scan:e2e 与限定 diff check 通过。
- 复盘：实际看图发现历史筛选被浮动工具栏挡住。首次普通 class 设置 z-index 180 仍输给带 data-canvas-surface 的旧规则，运行态是 120；补充准确选择器后 elementFromPoint 命中 history、截图无遮挡。测试初稿误用不可见 fitview 控件和分析前不存在的分层生成按钮，按真实阶段修正。开发态曾有一次 ResizeObserver 通知警告，最终针对性和候选没有对应 pageerror；不冒称修复已知业务根因。
- 包与候选 PASS：1.6.163 NSIS 105024301 bytes，SHA-256 `1dc3533e1239cc4bf61143dc2a90fbf83fdde59a0446dc49051634b88991b271`；app.asar `b34c68f2f81cc01cc8d9f5378e701ef34a905cccd1165cc4e5c43e7430082a54`。构建资源和 updater metadata 一致，NSIS 解出 86 文件逐字节一致。独立 canvasforge-qa 根先断言再操作；实际深色画布／Agent 色值、设置 8 画面、保存／重开、14 MCP 工具、错误 PSD 拒绝、干净退出通过，pageErrors=[]。
- 正式安装未执行，先前正式 1.6.159／UAC 阻碍未解；真实分层付费确认仍待答复，提交数 0，Photoshop 外部未重测。未发布 GitHub，在线更新未验收。最新候选改用 1.6.163，旧包和用户工作区保留；不能宣称全量交付通过。

### 2026-09-25 1.6.164 模型强度统一、长消息上下文与工作流模型复盘

- 用户再次反馈强度入口仍是小面板、上下文被长气泡挡住、浅色层次不足，并追加工作流模型选择。根因是入口状态分叉、flex 占位未真正修正、原生选项无背景，以及固定工作流模型后搜索列表消失。短对话与仅验父框边界漏掉了内部内容溢出。
- 完成：所有模式底部统一模型面板，两段入口都直接完整展开；上下文不收缩、内部滚动，Agent 高于工具栏；浅色采用暖白灰绿共享变量，深色 option 明确背景。工作流固定后保留搜索和已选侧线、参数可展开、跨路线清旧参数、图片视频分别保存，同名路线可区分，少量目录按内容收紧。
- 自我纠错：长消息测试初稿被空项目 helper 清除，增加 12 条消息断言；测到详情 371 > 容器 354 后修正 flex。截图发现通用按钮规则让未选模型也高亮且按钮过矮，补实际高度和颜色差异断言。虚构 Comfly 视频被能力白名单正确拒绝，改合法 RelayMe 夹具，没有放宽生产边界。新增主题测试 tuple 首次 typecheck 失败，补 as const 后完整构建通过。
- 验收：源码 311/311；追加工作流前广回归 28/28，最终定向 10/10；全 build 与最终 renderer 重建。包及 latest.yml 一致，NSIS 86 文件逐字节一致。最终候选空目录和隔离 IPC 模拟目录均通过、无 pageErrors、退出 0；保存重开、MCP14、错误 PSD 拒绝、正常退出通过。模拟目录不代表真实提供商成功。完整证据：work/qa-release-1.6.164-20260925/acceptance.md。
- 最终候选 105024949 bytes，EXE SHA-256 03da31ed01baacc2ad6aa259410fc3b3df579b1a93d36d9338951705e1ae3803；app.asar 5a12b2d248ccb17cf282c93edbee97296a31114dddc958249c6fbb734e28f91e。最后 CSS 变化后已重新打包并重跑候选。
- 正式目录 app.asar 本轮刷新为 1.6.163，旧记录 1.6.159 已过时；1.6.164 未正式安装，当前执行令牌未提升。真实 AI 分层授权／验收仍待处理，本轮付费提交 0。未发布 GH、未验在线更新，不宣称全量交付完成。保留旧候选、全部用户脏工作区。
- 后续每次继续复盘：逐入口、长消息实际加载、子边界／命中／截图、固定与自动搜索、图片视频独立偏好及跨模型参数；源码变化后对应包重新验收。下一步正式安装／真实分层／GH 更新继续按层验收。


### 2026-09-25 1.6.165 沉浸图片预览、知识库与分层模型复盘

- 用户指出双击预览不符彦造参考、知识库仍旧蓝黑且空白过多、分层模型空列表。本轮统一素材／结果预览为全窗口，真实像素缩放、1:1、Shift／拖动／键盘、受限右键五操作；知识库使用共享深浅色变量，约390px。分层按已配置 Comfly GPT 编辑传输合同提供模型，保留返回像素和尺寸验收，禁用及不完整路线继续拒绝；未伪造生产实测证据。模型切换保持确认区并更新分辨率。
- 根因与漏检：旧主题只查部分入口；旧预览把fit当100%；静态空allowlist被误当产品门禁成功；菜单只测存在，未点复制；toBeVisible不保证滚入视野。新增测试先复现知识库颜色、空模型、复制data-fetch CSP、确认区在屏幕外及小图未放大，再修复。最后确认区滚动及小图修复后重新生成 final 包。
- 验收分层：全量单元4076通过/2跳过（末次修复前）；复制相关337，最终组件316；广UI19/19，最后预览/知识库/操作10/10、分层视野2/2；完整build后最后renderer typecheck/build。最终包与latest.yml一致，NSIS86文件匹配；实际候选EXE独立userData，预览/知识库/8设置画面/三模式、保存重开/MCP14/错误PSD拒绝/退出0，pageErrors=[]。剪贴板IPC在QA中拦截，仅证明PNG原生解码2400×1600；Photoshop浏览器为受控桥，不是外部实测。
- 最终候选：work/qa-release-1.6.165-20260925-final/installer-output-r1/CanvasAtelier-Win10-11-x64-1.6.165.exe，105026714 bytes，SHA-256 16af59eb3d2b9c3839ac57213d3bce750488533dd61dfd8117fadb130f6a54bc；app.asar 1b1450118472ea39db542f632b94561dfa5a65432a747fda20ecfd9c79d05187。完整逐项记录及复盘 work/qa-release-1.6.165-20260925-final/acceptance.md，接续 docs/checkpoints/2026-09-25-image-preview-layering-1.6.165.md。未带 final 的同版本目录为旧轮候选。
- 正式安装/外部/发布：本轮重新读取正式app.asar为1.6.164，修正前轮1.6.163记录；存在用户正式进程，没有强关或替换。本轮真实付费提交0，真实分层质量及当前版本Photoshop、安装态、GH/在线更新未验收，此前额度授权仍待处理。按最终候选继续这些项目，不能宣称全量交付完成。保留用户全部脏工作区和旧证据。

- 结束前已重新提出具体真实验收额度问题：最多4次Comfly调用（分析1、透明测试1张、分层2张，2K），按供应商实际收费、失败不自动重试。尚未答复，付费调用保持0。候选包及验收报告已可供审阅，后续先读取该答复再开展依赖额度的工作。

### 2026-09-25 1.6.166 Flare 4K 与知识库定位复盘

- 用户症状：基础 `GPT Image 2.5 Flare` 的分层分辨率缺少 4K；知识库选择层仍在上方，与输入区留大块空白。根因：分层确认只使用当前路由的分辨率合同，没按同系列已配置 `-4k` 变体映射到真实提交路由；知识库使用固定 `top: 52px`，内容缩短后不能贴近输入区。
- 为何上轮漏检：此前只选择 4K 专用模型，未从基础 Flare 切到 4K 并检查确认参数；只量知识库自身高度／颜色，没有量与输入区的距离。此次分层单测先红（缺 4K），旧 1.6.165 安装候选实测旧空隙 102.6px 后才改源码。
- 精确修复：分辨率列出同系列可用路由，4K 仅由通过门禁的精确 4K 路由提供；提交和摘要使用解析后的实际路由，缺少变体时不展示 4K。知识库用工作台与输入区的实际位置、`ResizeObserver` 及窗口尺寸重新定位，保留顶部任务栏。回归在 `apps/renderer/src/canvas/LayeringDialog.test.tsx`、`tests/e2e/layering-yanzo-adaptation.spec.ts`、`tests/e2e/immersive-image-preview.spec.ts` 和 `work/qa-knowledge-anchor-20260925.mjs`。
- 新鲜验收：全量单元 4079 通过／2 跳过（最后追加无 4K 路由边界用例前），最后分层定向 10／10；升版 1.6.166 后完整 `npm.cmd run build`；最终浏览器 22／22，前次 20／22 因两条旧“无透明路由”断言过期，更新后整组重跑。候选实际 EXE 独立 userData：700px／900px × 对话／创作／Codex 六组均距输入区 18px、顶部无遮挡，pageErrors=[]；浅深预览／知识库、设置 8 画面、三模式、图片原生解码、保存重开、MCP14、错误 PSD 拒绝、退出 0 通过。NSIS 解出 86 文件逐字节一致。
- 候选安装包 `work/qa-release-1.6.166-20260925-final/installer-output-r1/CanvasAtelier-Win10-11-x64-1.6.166.exe`，105027001 bytes，SHA-256 `80b888556703a2916629470835643c230c30245beda0130775fbed9efa6eeb18`；app.asar `0d64f4779d7be8631db541da138feafb58c6654ed67d2ee80011cfa616e0a067`。完整证据、首次失败与各层限制见 `work/qa-release-1.6.166-20260925-final/acceptance.md`，接续见 `docs/checkpoints/2026-09-25-flare-4k-knowledge-anchor-1.6.166.md`。
- 分层验收限制：源码、构建、包、候选 EXE 已通过；正式目录本轮只读为 1.6.165，仍有运行进程，1.6.166 未正式安装。真实 Comfly 分层付费调用 0，语义／透明边缘／4K 实际输出未验证；当前版真实 Photoshop 未验；GH 和在线更新未发布未验。已提出更新后的最多 4 次 Comfly 调用（含至少一次 4K）额度问题，仍待答复。不要用本地夹具或等候时间当作费用批准；通过外部质量门禁后再完成正式安装、GH 与在线升级。
- 自我复盘：扩展界面脚本包含两条遗留门禁文案，首次失败后没有放宽生产路由，改为真实可选能力检查并完整重跑。初次 Playwright 证据使用旧默认输出目录，最终完整重跑显式写到新版本证据目录；下轮先设置独立证据目录。每轮继续记录红灯、根因、各验收层与未完成动作。
- 第二版接续修正：继续审查发现基础 Flare 声明 1K、4K 变体却省略 `constraints.image.resolutions` 时，通用分辨率列表会提前过滤 4K。新增单测先红（只有 1K），改为对每档直接解析同系列精确路由并核对分层合同；有变体则显示，没变体仍隐藏。全量单元重跑 4081 通过／2 跳过；完整构建、最终界面 22／22、分层浏览器 2／2、新候选 EXE 与 86 个 NSIS 文件重验通过。原 r1 包已过时，**最终仅用** `work/qa-release-1.6.166-20260925-final/installer-output-r2/CanvasAtelier-Win10-11-x64-1.6.166.exe`，105026953 bytes，SHA-256 `b51c030b3e9255e77407ca111d951535d0021a1e784e1d0abce91fb7dde50b3f`；app.asar 仍为 `0d64f4779d7be8631db541da138feafb58c6654ed67d2ee80011cfa616e0a067`，因这次只改 renderer 资源。第二版验收见同目录 `acceptance.md`。
- 第二版中间界面整组 21／22：受控 Photoshop 回调断言偶发未收到，单条连续 10／10、最终整组 22／22；增加失败时的页面警报／按钮诊断，但尚未定位根因，不能宣称该间歇风险已修复。正式安装／真实供应商／Photoshop 外部／GH 更新仍按报告待验，真实付费请求 0。已向用户提出含至少一次 4K 的最多四次 Comfly 调用额度问题；无答复前不执行收费调用。

### 2026-09-25 1.6.167 分层节点布局、程序图标与供应商复盘

- 用户反馈七层输出离源图太远、整理画布仍成过长竖列，分层慢并要求核对 GPT 与其他供应商的图片／视频模型，还要求更高级的软件图标。初始图层使用全局最右位置、自动布局把同组七层放同一列；修成源图附近碰撞安全布局和最多三列分组自动排布。先红后绿的 `layering-graph.test.ts`、`auto-layout.test.ts`，真实浏览器七层节点边界／整理画布验收均通过；最终相关浏览器 19/19。
- 图标源更新为石墨与薄荷色 N。首次 r1 包的 `icon.ico` 是新的，exe 仍是 Electron 默认图标；根因是 `signAndEditExecutable: false`。新增 `desktop-icon-contract.test.ts` 配置断言及 `scripts/verify-windows-exe-icon.ps1` 实际 exe 32×32 像素检查；旧 exe 红、最终安装包解出 exe 绿。普通构建遇到 winCodeSign 的 macOS 符号链接权限和 `rcedit` 提交失败，最终使用隔离英文路径先生成目录、手工写入版本资源和图标、再 `--prepackaged` 生成 NSIS；没有覆盖旧包。
- 首次最终全量测试 4082 通过／1 失败／2 跳过，失败是历史图片 `onLoad` 之后 `src` effect 重置覆盖 `loaded`。改为按 `src` 存储状态，历史和图标定向 23/23，最后完整全量 4083 通过／2 跳过，完整 build、scan:e2e、浏览器 19/19 均通过。以前只核对图标资源和功能测试的即时断言，遗漏 exe PE 图标和异步状态竞争；往后从最终安装包提取 exe 验图标，并对源图变化的图片状态做回归。
- 最终只使用 **r6** 包：`work/qa-release-1.6.167-layering-icon-20260925/final-r6/CanvasAtelier-Win10-11-x64-1.6.167.exe`，105284203 字节，SHA-256 `3444a48334351950aa9ec457ede5616b827719ac176beb99c0bbdb0bf63e13d9`。`latest.yml` 哈希一致，NSIS 86 文件逐字节一致；候选实际 EXE 独立数据目录保存／重开、MCP14、错误 PSD 拒绝、正常退出及页面错误 0 全过。未签名。
- 供应商定向合同测试 Comfly/RelayMe/NewAPI 463/463；实际本机仅 Comfly 配置 29 图片／18 视频模型，47 条都启用且 `complete`，RelayMe 0 当前模型配置，聚轮／4DAI 无配置。历史 Comfly 图片、RelayMe 图片／视频成功不能证明当前全型号正常。当前七个 Flare 4K 分层任务历史仍 `running` 且无输出，正式 GUI 不在运行，只有 MCP helper；不重复提交或声称质量通过。此次新付费请求 0，真实透明像素、所有 GPT／其他供应商图片视频、4K 时延仍未验证；只读正式 `app.asar` 是 1.6.166，1.6.167 未正式安装，真实 Photoshop、GH 发布和旧版在线更新未执行。各层证据与下一接续见 `docs/checkpoints/2026-09-25-layering-icon-provider-audit-1.6.167.md`。

### 2026-09-25 1.6.169 模型系列／清晰度统一与最终包复盘

- 用户最新要求图片模型名不带 2K／4K，清晰度单独选择，AI 分层同理。按供应商和系列归并实际路由，设置、生图节点、Agent 固定偏好和方案确认、AI 分层都只显示系列名；清晰度仍解析至精确供应商路由。设置页同系列启用开关管理全组。补映射单测和浏览器回归。
- 保存故障单次有界重试、旧远距分层节点迁移至原图附近、整理节点保留视野及设置页骨架的前序修改继续纳入回归。最终源码 4090 通过／2 跳过，完整 typecheck/build，最终浏览器 18/18，scan:e2e／diff check 通过。重构后第一版 r1 包已过时，**仅使用 r2**：105286463 字节，SHA-256 `35bfe2555c7e4e8a98e298357f2e45cba92d742f384a8c1d8fd8054013e50c0c`，NSIS 解包 86/86 文件哈希匹配，PE 图标与版本 1.6.169 通过；包未签名。候选 EXE 隔离数据目录保存／正常退出／重开一致，MCP14，损坏 PSD 拒绝，pageErrors=[]。
- 自我复盘：之前逐条暴露供应商路由导致重复模型名；只覆盖设置页会漏掉 Agent、节点和分层。此次发现并修正同 modelId 不同系列的合并碰撞；先前 r1 包因后续源码变更失效，必须每次最终变更后重打包并重验。初次把 GUI 关闭后仍在的 MCP helper 误判为孤儿并结束，后续独立复核确认它由仍运行的 Codex 客户端持有，不是画布 GUI 自有泄漏；以后按父进程归属判断且不结束外部客户端的 helper。候选 EXE 自身进程退出后为 0，保存/退出/MCP 定向 274/274 通过。
- 正式安装没有通过：用户回复已退出，实际 GUI 已关，但 NSIS 在非提权会话返回“操作已被用户取消”，直接写安装目录亦被自动策略拒绝。正式目录仍 1.6.167；不能把候选验收冒充安装验收。真实 GPT／其他供应商付费生图视频、透明分层与 4K 成品、Photoshop 当前版、GitHub 发布及在线更新未通过。具体矩阵和交付物位于 `work/qa-release-1.6.169-model-family-20260925/acceptance.md`；下一步先以可提权会话安装 r2 并按哈希和实际功能验收，再发布。
- 验收习惯补充：设置页独立输出目录复跑 9/9，人工查看深色模型系列和 480px 浅色供应商页截图；首次使用旧固定截图目录可能刷新同名历史文件，随后给 E2E 增加 `CANVAS_SETTINGS_AUDIT_DIR` 并把最终截图隔离至本轮目录。今后截图测试先设置独立证据目录。

### 2026-09-25 1.6.170 终态回归、供应商错误恢复与大型项目保存复盘

- 用户追问未验收项后扩展检查，发现并修正三类遗漏：Comfly 视频 SUCCESS 无 output 或无效 MP4 的任务账本可能保持 running；Agent 同供应商同名 GPT Image 2 等别名出现重复按钮；1K 从 2K/4K 变体回退基础路由的 family key 判断失效。三者均先红后绿，并保留精确供应商路由。
- 供应商下载安全回归覆盖临时网络 TypeError、429/5xx、body stream 中断；可恢复错误继续原任务，不重复付费，确定坏结果持久失败。供应商/GPT 分层合同 437/437，当前没有真实付费提交。
- 源码全量 4102 通过/2 跳过，workspace typecheck/build 通过；当前 UI 定向 595/595，扩展 Playwright 20/20，工作流模型选择 1/1，更新流程 1/1。大型隔离副本 157 节点/199 图片/1 视频点击保存、重开、退出通过，保存状态属性 saved，约 285ms，pageErrors=0，cleanClose=true。
- 大型项目初次 45 秒保存失败是验收脚本误用默认可见等待：Canvas 折叠布局让 save-state 节点 display:none，但 data-save-state 已是 saved；修正为 attached/属性、manifest revision、recent index、退出码和 cleanClose 联合判断。不要把可见性误报成写盘失败。
- 正式安装仍未验证：D:\CanvasAtelier 当前 1.6.167；NSIS 需要可提权会话，之前返回操作被用户取消。最终 1.6.170 包在 work/qa-release-1.6.170-final-20260925/deliverables，105286594 字节，SHA-256 7c6e25cfd52b5fb6de3942a7989335d51f4c7b5f15bc3ec9ee944c783c2323e2，86/86 解包匹配，图标/版本通过，未签名。
- 自我纠错：扩展矩阵发现重复模型后没有沿用旧包，先修路由与测试类型，再完整 build 和重打包。曾误判外部 Codex 持有的 MCP helper 为画布泄漏，已纠正判断。仍未做真实供应商成品、透明 alpha/4K、当前 Photoshop、正式安装态和 GitHub/在线更新；下一步先管理员安装 1.6.170，核对 exe/app.asar 哈希后重跑安装矩阵，再决定发布。

### 2026-09-25 1.6.170 GitHub 发布复盘

- 成果：提交 `261fa8b` 已推送到 `feature/canvas-agent-mvp`；GitHub Release `v1.6.170` 已正式发布，EXE、`latest.yml`、`.blockmap` 均上传成功。
- 验证：tag 指向 `261fa8b65a7ba4a49a44eb0bb854ace597f4fb0a`；远端 `latest.yml` 为 1.6.170、105286594 bytes，SHA-512 与本地构建一致；EXE 远端 SHA-256 为 `7c6e25cfd52b5fb6de3942a7989335d51f4c7b5f15bc3ec9ee944c783c2323e2`。
- 边界：正式安装态、真实供应商成品、Photoshop 当前安装态、本地存储失败完整恢复仍未通过；发布不等于这些门禁已通过。
- 复盘：发布前筛除了 `work/` 历史 QA 目录和无关脏文件，只提交源码、测试、资源与项目记忆；远端资产下载第一次遇到 TLS 超时，重试后完成 `latest.yml` 内容核对。
- 下一步：新线程先读取 `work/qa-release-1.6.170-final-20260925/CONTINUATION_CHECKPOINT.md`，继续正式安装态验收；确认安装后再验证在线更新和未完成供应商门禁。

### 2026-09-25 1.6.171 GPT 分层提交后持续转圈修复

- 用户反馈七层生成一直转圈，要求 GPT 系列正常出图和分层。只读历史账本显示最近 7 个 Sunburst 4K 和此前 7 个 Flare 4K 分层任务均已提交、状态为 running，输出为空且更新时间停在提交后数秒；更早 Sunburst 有成功记录，不能据此断言 GPT 型号整体不能出图。另有旧任务，未重提交或取消。此前验收只测了 `processQueue()` 提交及手动调用 `pollActiveJobs()`，漏掉确认分层入口的持续运行环。
- 根因：`apps/renderer/src/app/app-store.ts` 的 `startConfirmedLayering` 在持久化绑定节点后调用 `void jobStore.processQueue()`；该方法只提交一次，不持续轮询。改为 `void jobStore.run()`，与普通生图入口一致，持续轮询至成功或明确失败；保留先持久化绑定、再释放任务调度的顺序。回归在 `apps/renderer/src/app/app-store.test.ts`：先让两层提交成功、模拟供应商失败，旧代码断言停在 running 为红；改动后两层均走到 failed 为绿。`apps/renderer/src/jobs/job-store.test.ts` 已覆盖重启后按已保存 providerTaskId 轮询而不重新提交。
- 源码/构建：定向红灯后绿灯 1/1；最终 `npm.cmd test` 为 4102 通过／2 预期跳过，`npm.cmd run build` 通过，`git diff --check` 无内容错误。桌面版本与 lockfile 改为 1.6.171。
- 包：正式候选 `work/qa-gpt-layering-171/installer-output-r2/CanvasAtelier-Win10-11-x64-1.6.171.exe`，105286386 字节，SHA-256 `2e50c0067377cbfbe349970c2a3fa970be0f020257f97a9421706b78e72ac811`。普通 electron-builder 遇到 winCodeSign 解压 macOS 符号链接权限问题，沿用隔离目录、缓存 rcedit 写版本/图标、`--prepackaged` 的既有流程；NSIS 解出 86/86 文件与候选目录逐字节一致，renderer/MCP/Photoshop 资源和 latest.yml 哈希一致。候选和安装包解出 EXE 的隔离数据目录启动、保存、重开、MCP14、损坏 PSD 拒绝、退出均通过，页面异常 0。
- 正式安装：用户明确已保存关闭窗口；检查确认旧窗口已无主句柄，只结束残留无窗口进程。NSIS 静默安装返回 0，`D:\CanvasAtelier\Canvas Atelier` 的 EXE 和 app.asar 哈希分别为 `bf4547a1b284a328b0d3af63a885d6e6b2f807185451c0cb436108b2c0c0bade`、`fffc2dd3f1e8cb22e89ce1405c03534cbacf2643da3ceefcd98ebfb6afeea6d6`，均与包中逐字节一致；注册表显示 1.6.171，图标核对通过。正式 EXE 用独立 QA 数据目录完成保存/重开/MCP14/正常退出，未操作用户项目或提交新付费任务。
- 外部供应商/用户项目：真实 Comfly 响应、透明 alpha、4K 图层质量和最近 14 个旧任务的终态仍未验证；当前历史账本还有 3 条非 GPT 旧 queued 记录，直接用真实配置启动可能触发旧队列付费提交，需先厘清归属。供应商配置被加密，未读取密钥或发起新请求。发布/在线更新：1.6.171 未发布，远端 1.6.170 不能作为本版验收。下一步优先以不重提交的只读方式核对已存在任务终态；真实新请求须明确额度和素材，再做图像及分层成品验收。
- 自我复盘：先前只确认“已提交”就把转圈归咎于模型，遗漏了调度环这一内因；本次以旧任务时间线和先红后绿测试定位。包和正式安装都做哈希同一性验证，但隔离环境不能证明实际供应商成功。正式 QA 退出码 0 后另见 Codex 父进程下无窗口 Canvas 进程，已结束一次；其来源未查明，不能将整个机器进程生命周期判为完全通过。

### 2026-09-25 1.6.172 GPT 真实出图、正式版和 QA 清理复盘

- 用户症状是 AI 分层七层长期转圈，要求 GPT 系列正常出图与分层，最终只保留正式版并清理历史 QA 目录。1.6.171 修复确认分层入口只执行 `processQueue()` 一轮的调度错误，改为 `jobStore.run()` 后持续轮询；`apps/renderer/src/app/app-store.test.ts` 先红后绿，`apps/renderer/src/jobs/job-store.test.ts` 保护重启后继续轮询已有任务、不重新提交。旧验收把“已提交”和手动 poll 当作完整运行环，漏掉入口状态。
- 真实 Comfly GPT Image 2.5 Sunburst 1K 第一次付费任务 SUCCESS，给出有效图片 URL 却同时返回空 `b64_json`，1.6.171 把空字符串当作坏内联数据，阻断下载。`packages/desktop-core/src/provider-inline-image.ts` 改为空字符串表示无内联数据，由 URL 下载；`provider-inline-image.test.ts` 与 `provider-bridge.test.ts` 先红后绿。旧受控响应没有覆盖此供应商返回组合。1.6.172 用原任务映射恢复同一生图结果，0 新提交，1024×1024 PNG 成功落地。
- 用户授权上限 3 次 1K Comfly 调用，实际恰好 3 次：正常生图 1、杯体透明层 1、投影透明层 1，均终态成功并下载；透明像素分别 874418 和 1002148（各总计 1048576），页面错误 0。实测证明该 1K 路线的真实出图、透明输出、任务轮询与下载；图层有轻微软化／光晕，不证明复杂商品图像素级保真，也不证明全部 GPT 型号、4K 或七层质量。历史 14 条旧 running 任务和 3 条非 GPT queued 任务未重提交、未改写；直接打开真实用户资料有触发旧队列的风险。
- 源码验收：相关 4 文件累计 473 项通过；最终全量 Vitest 两次卡住，未取得通过结果，绝不沿用 1.6.171 的 4102 项全量成绩冒充 1.6.172。`npm.cmd run build`（含全部 workspace typecheck）通过。正式本地 NSIS 1.6.172 为 105286487 bytes，SHA-256 `11fb42c1a74bf008defc527b3903f3bfbc625c55c682273a3ef5be6640c78e6c`；NSIS 解包 86/86 文件一致，PE 图标、版本和本地 latest.yml 一致。正式安装 EXE SHA-256 `1b797c60c4ee415eda3a966f2bc7aab5f29b6f1f6e1e686931ffc8c8092168b2`、app.asar `ee363c7eed2800e2172be3ce271817485c49163e2915c599eccdb6dc111856d7`，均与包内容一致。
- 正式安装态验收：独立数据目录新建／保存／重开图片生成节点及提示词、MCP 14 工具、损坏 PSD 拒绝、退出 0、cleanClose=true、pageErrors=[]。大型隔离项目 157 节点／199 图片／1 视频在正式 EXE 下保存、重开数量一致，离线防护生效，退出两次 0、无页面错误。实际 Photoshop 2026 桥接将已下载 GPT PNG 导入为图层，返回 ok:true；随后仅移除该 QA 图层，未保存或关闭原有 Photoshop 文档。完整矩阵与报告集中于 `work/formal-acceptance-1.6.172.md`、`work/formal-evidence-1.6.172`、`work/formal-large-project-172.json`、`work/formal-photoshop-172.json`。
- 发布／更新层：v1.6.172 未公开发布，在线更新未验证；本机正式安装通过不代表旧远端 1.6.170 已更新。用户明确选定清理本轮与历史 QA 目录，保留正式安装、源码工作树、用户项目及必要验收证据。清理结果见正式验收记录；后续若继续测其他 GPT 型号、4K、七层或其他供应商，需单独额度授权并按真实成品逐项验收。
- QA 清理终态：安全限定三个父目录与名称模式，先后删除源码 `work/qa-*` 336 个、项目根 `canvasforge-qa-*` 37 个、系统临时 `canvasforge-qa-*` 58 个，总计 431 个，三处剩余均为 0。临时目录第一轮因 `ADMINI~1` 与 `Administrator` 的短长路径不一致被校验安全跳过，改用 `$env:USERPROFILE` 下长路径后成功；记录 `work/formal-cleanup-stage1-1.6.172.json` 和 `work/formal-cleanup-1.6.172.json`。清理后正式安装 EXE/app.asar、离线安装包哈希重验未变，`git diff --check` 通过；用户 AppData、源码和正式版未删。
- 全量测试补正：普通 Vitest 并发两次停滞，`--maxWorkers=2 --no-file-parallelism` 完成后发现仅 `apps/desktop-modern/src/packaging-boundary.test.ts` 与 `runtime-entry-contract.test.ts` 写死 1.6.170，产生 4101 通过／2 失败／2 跳过。测试合同先红后绿：前者改为桌面 package.json 与 lockfile 版本相同、由当前版本派生安装包名，后者删去与渲染入口无关的版本断言；两文件 23/23 通过。最终完整 `npm.cmd test -- --maxWorkers=2 --no-file-parallelism --reporter=default` 为 **4103 通过／2 跳过、270 文件通过／2 文件跳过、退出 0**，日志 `work/formal-vitest-172-final.log`。这两处只改测试代码，既有正式安装二进制与产品构建未变；以后升版不要把版本号写死在非版本合同测试里。

### 2026-09-25 1.6.172 GitHub 正式发布复盘

- 用户明确要求生成安装包并发布 GH。沿用此前已通过安装态身份核对的 **同一** 1.6.172 NSIS 正式包，没有用重新打包的不同二进制冒充已验收版本；本轮补生成 gzip blockmap v2，5015 块的尺寸合计 105286487 字节，与安装包大小相同。`latest.yml` 的版本、大小和 SHA-512 与包一致。本轮新鲜 `npm.cmd run build`（含全部工作区 typecheck）、`npm.cmd run scan:e2e`、`git diff --cached --check` 均通过；全量 Vitest 沿用此前同一生产源码的 4103 通过／2 跳过，之后仅改发布记录。
- 只提交 1.6.172 修复、回归、版本和项目记忆 10 文件，保留预先脏的 `AGENTS.md` 与大量历史未追踪文件。源码提交 `39ae22ddf7ac0fb2d5e14ad2e348e21798e8f018` 推送到 `feature/canvas-agent-mvp`；Git tag 通过 GH Release 建立，远端 tag 与分支均指向该提交。普通 `git push` 分支成功，单独 `git push` tag 长时间无响应，核实远端无 tag 后停止，改用 GH 草稿发布并验证三项远端资产摘要，最后公开且设为 Latest。
- GitHub Release：<https://github.com/19960726/canvas-atelier/releases/tag/v1.6.172>，非 draft、非 prerelease。EXE 105286487 bytes / SHA-256 `11fb42c1a74bf008defc527b3903f3bfbc625c55c682273a3ef5be6640c78e6c`；`.blockmap` 110576 bytes / `8f8b88ae2372b562dde86aa3597e7cc3ee819f5de2c08362b4a1333fa60ee0b3`；`latest.yml` 375 bytes / `7095f16965aeb6ad5495c9d83096ed7d249271e666e69d5c1d7c0ebb281c6f91`。GH 资产 digest/大小与本地逐一匹配，公开网页和 Releases/latest API 均显示 1.6.172。
- 各验收层：源码回归 4103 通过／2 跳过；构建 PASS；包、安装态 PASS；外部 Comfly GPT Image 2.5 Sunburst 1K 生图 1 次和透明分层 2 次 PASS；Photoshop 真机导入 PASS；发布资产与 latest 元数据 PASS。旧版客户端到 1.6.172 的真实在线升级、其他 GPT 型号／4K／复杂七层／其他供应商付费成品仍未验证；历史旧任务未改动。发布说明明确这些边界，不能把 Latest 元数据存在当成客户端升级已成功。
