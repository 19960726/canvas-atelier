# Canvas Atelier 1.6.185 当前发布验收记录

当前状态：2026-10-03 R8F 后续继续修复和验收。独立 RGBA 与本地复核闭环已完成聚焦源码回归，巨轮新增模型及参数接入正在实施；最终仍须冻结后完整重验。用户明确要求先模型和之前问题、再 MCP，实际验收通过后直接制作新安装包、安装和发布。保留原项目，不新增付费调用。当前完整五层、最终候选、安装版和 Photoshop 门禁尚未全部完成，未发布本轮安装包。

当前逐项凭据见 `work/repair-185/acceptance-matrix.md`。下面保留历史 r6 验收事实；旧候选被后续源码修改取代，不能作为当前交付通过或安装依据。用户保存并正常退出后，2026-10-01 最新保护回执绑定 revision 570 和全部 6 个项目。旧七层在 545 由用户删除，542 只用作独立历史回归，不恢复覆盖 570；当前五层实际质量另行核验。

## 2026-10-03 R8F4 后续：独立 RGBA 合同与证明失效门禁

- R8F4 的完整源/浏览器/压力/构建/解包流水线和 candidate Common 9/9 只对应历史候选 `formal-185-output-r8f4-footer-20261002-0912-b71c`；源码随后增加了独立 RGBA 候选和证明失效门禁，因此该候选不能作为当前发布凭据。R8F4 记录保留作阶段证据，不能直接安装或发布。
- renderer 到 native bridge 的分层合同现在严格传递 `source-alpha-matte-v1`、`source-independent-rgba-v2` 或 `opaque-background-v2` 及成对的 64 位小写确认摘要；普通图片/视频任务和未绑定图层任务拒绝这些字段。内部合同不会注入 Comfly HTTP body，默认透明路线仍是 `source-alpha-matte-v1`，没有新增付费或在线生成调用。
- `source-independent-rgba-v2` 只表示候选返图按直 RGBA 保留和预览，不等于语义通过。候选必须逐层接受白底/棋盘/隐藏其他层/原坐标与背景归属检查，并以当前分层确认摘要绑定；未接受、摘要缺失或方案重新分析/排序/校正后，工作台显示“需重新确认”，正式合成、PSD 和 Photoshop 按钮均被阻止。旧返图不会继续携带过期证明。
- 本地复核入口对照当前候选逐层检查并保存独立 assembly 摘要，保留生成合同摘要；正式 PSD、Photoshop 和 MCP 在导出前重新计算当前证明。异步解码期间内容变更或组件关闭均阻止旧快照交付。失效操作保留当前资产的物理 RGB/alpha 表示，清除旧语义证明；新返图同时使兄弟层证明失效，新资产格式不能继承旧资产。
- 多 RGBA 候选自动验证队列已取得真实 RED/GREEN：格式通过仍语义 pending 的首层不再阻塞后续图层。源码本地闭环 437、队列相关 429、UI/PSD/readiness 46 项分别通过，互相有重叠不求和。完整源、浏览器、标准压力与新解包最终凭据尚待冻结后执行。
- 新浏览器明暗2/2实际验证三图层自动格式检查、本地复核、持久化重开和UI PSD原RGBA回读，包含alpha128和alpha32，不预填格式证明。巨轮目录/参数阶段联合177项和非增量类型检查通过：28预置=公开24+历史4，新增17精确ID；不丢旧route/选择，未认证的新目录项不自动启用。完整参数证据5条，旧缓存按对应规格只读归一化；文生/单图之外的多媒体协议未被巨轮实例具体证实，视频编辑保持未完成。
- 177项之后的独立复查又复现停用模型刷新、已接受任务恢复顺序、未知旧缓存虚构默认值3类边界（新测试11项RED），正在补修。已中止该轮最终流水线，修复后重新冻结运行；不能将中止前阶段通过作为本轮最终候选验收。
- 最终模型边界闭合联合199项通过，另真实存储双refresh/restart RED5项后补修：显式空选择/disabled和顺序持久，重新勾选才启用，认证新增项false；已接受原任务严格按身份恢复，始终不重复POST。独立集中review完成。设置空选择UI实际RED后最小补修，104项和renderer类型检查通过，保留其他provider默认。下一新完整流水线以此冻结状态为准。
- 用户要求在新安装版画布中做分层。先制作独立注册身份、无日常快捷方式的QA安装副本，以同一冻结EXE/asar打开修订570的保护副本，实际检查已有分析/图层、本地修整、合成和UI PSD。该QA安装副本不等于日常安装验收或公开发布；新增付费调用保持0，实图未通过不发布。
- scope-v20隐藏杯身局部实验补104575估计像素（估计mask与供体映射保留），实际图层仍有指缘闭环接缝和纹理跳变；杯盖供体全局注册未通过。该实验继续FAIL，不进入安装发布门禁，后续联合边界修复使用新的独立副本。
- 当前五层 v19 仍是语义 FAIL：组合字节差 0 仅证明序列化；exactRatio `0.9654598441942794`、maxChannelDifference `184`、uncoveredByteDifferences `882`，且背景柜门拼缝、杯身/水层混入、手部镂空和水层光晕仍存在。实际五层 PNG 有 RGBA；用于白底/深底观察的裁剪图按脚本被铺底，因此 alpha=255，不能据此判断真实图层缺透明通道。阻断的是实际语义瑕疵；未建立 v20，未安装或发布。

## R8F 当前修复范围与验收边界

- 重新分析及执行请求共享全部前景的归属和排除关系，等待前固定计划、路由和确认输入；禁止把手持物体混入手层、按其他对象矩形整块挖空，保留真实连续透明贡献。
- 原图与多个透明蒙版无法唯一确定独立颜色时，明确定位需要精修的原始图层，保留待修整 PSD。新增真实物理反例证实：单个蒙版的背景颜色不匹配时，旧原图回填也会制造全合成正确、隐藏图层后物体仍在背景的错误；现一并阻断原始前景与阴影的这条回填路径，不分配假颜色。
- 正式 PSD 继续通过既有内容重叠、像素、坐标及颜色门槛。新增物理组合检查发现可信本地阴影被跳过、重估或挖空，原始阴影漏检透明叠加、上下次序被强制改变；现可信阴影保留独立 RGBA，按实际顺序处理，原始阴影参与透明和背景匹配检查。256 种组合与独立显隐检查通过，不能将格式检查或整图相似度当成内容独立证明。
- PNG 经过浏览器画布会量化低透明度独立颜色，编码和解码均已实测复现。现在使用保留存储 RGBA 的 PNG 编解码工作线程；原尺寸字节不变，缩小使用覆盖面积计算，放大使用浮点透明颜色计算，避免中途 8 位预乘。损坏、不支持的 PNG 和工作线程失败明确拒绝；16 位 PNG 需要先转换为 8 位 PNG，不静默使用画布替代。已有 pako 2.1.0 通过离线锁文件操作声明为直接依赖，没有新增模型或网络下载。
- 四个底部动作使用两列和自适应高度，原真实错误态的文字溢出已复现并验证修复。
- 修订 570 原计划要求手和白衣袖、水流、水花、杯身水痕、水珠及杯底滴水。完整本地修复仍在独立副本中验收；保留准确的承载表面估计区域，不能以旧七层回归或合成误差为零代替完整五层语义检查。
- R8D 完整源码 4872 项和 R8E 完整源码 4880 项实际通过，各自 9 个工作区类型检查、浏览器 307 项及 12 组标准压力、完整构建、扫描及源码指纹一致亦通过。随后阴影及 PNG 独立像素缺陷要求 R8F 再次冻结并执行完整流水线；旧候选只保留为阶段记录，不继承为最终安装验收。
- 新在线 AI 返图未支付验证。请求合同、本地修复、候选、安装版和 Photoshop 的实证分别记录，不保证未来供应商每次请求都会通过语义质量检查。新增付费调用为 0。

## 历史 r6 验收

历史状态：r6 候选实际验收通过，后续修改后作废；尚未公开发布。

## 修复范围

- 生图与历史：排队唤醒、取消竞态、结果暂存、项目绑定、下载/落盘/历史同步异常后的恢复。已接受任务不因同步失败重复提交付费调用；上游 503 等故障继续明确提示。
- Agent：需求形成可选执行方案，确认后建立工作流；给图和追问继承的参考图实际连接生图节点。修复 JSON 展示、创作/分析指令冲突、通用 2K 覆盖模型默认清晰度、模型过滤和长列表反推控件。
- 项目：新建空项目身份分裂、版本冲突、打开等待媒体校验、导入后最近项目计数未更新；辅助索引异步更新，正常关闭等待持久化。
- PS：放置成功但回执丢失时不重复导入。GPT/非 GPT 智能对象只新增一层，4K 非中性校色、位置与比例实际验收。
- PSD：修正底到顶输入错误反转。PS 实际切换可见性并重算合成验证，不只检查预存预览。
- 导航/设置：顶部按内容宽度显示保存、新建、AI、主题和关闭；项目管理从保存下拉进入。左栏图标/提示/选中态一致，AI 图标居中；设置和画布统一明暗色系。
- 分层工作台：等比例紧凑预览，更大缩略图与列表，默认收起背景/分析；滚动内容与底部导出分離，不改变背景模式、排序或质量门禁。

## 源码证据

| 检查 | 结果 | 本地凭据 |
| --- | --- | --- |
| 本轮完整回归，早于后续补修 | Vitest 4427 通过/2 跳过，浏览器 257 通过/1 跳过 | vitest-new-defects-final.log、e2e-new-defects-full.log |
| r4 索引与 Agent 默认分辨率补修 | 351 项通过 | candidate-discoveries-regression.log |
| r5/r6 PSD、源像素、工作台与精修 | 39 项通过 | layering-ui-green.log |
| r6 七层布局/比例/显隐/排序/导出和导航明暗 | 9 项通过 | layering-ui-browser-r6-final.log |
| 完整类型检查/构建 | 退出 0，按钮主题补修后最终 renderer 构建退出 0 | build-r6-receipt.json、build-r6-renderer-final.log |

定向测试单列，不把早于补修的完整测试称为最新完整测试。

## r6 候选实际验收

EXE SHA-256：d3625fdb5836f7cb2ada856e15e96174263d0505bb3bed67923676409efe9dbf。app.asar：6c6bffb9fb02ad49e75a851a974088f94c98e62dd6277cd68a49b328eee74d6b。六份 renderer 文件规范清单：49a670eec55ba41a8740bbda9a26aa908937951de38541acba32a6ef53f74238。r6 renderer 与 r5 不同，不能只核对 EXE/asar。

| 范围 | 结果 |
| --- | --- |
| 设置明暗、粘贴、分层入口显隐、三种范围、保存重开 | 通过 |
| 250 历史及视频/全部媒体切换 | 通过；首次 2067ms，主线程最大事件间隔 324.5ms |
| 八工具/顶部、撤销、整理、Agent、设置、历史、主题、保存 | 通过；AI 图标中心 x/y 偏差 0 |
| Agent 确认后建节点/参考图连线并保存、追问图片继承 | 通过 |
| 4K 校色下载落盘和原生复制调用 | 通过，输出 4096 方形 |
| 本地独立七层修复副本真实 UI PSD | 通过；2196 方形，坐标/比例/透明通道、不透明前景颜色通过 |
| 原污染返图、待修整 PSD | 正式合成继续拒绝；草稿原图默认可见且像素不变，候选层独立隐藏 |
| PS 非 GPT 4096 校色、GPT 2880 原图智能对象 | 实际通过；只新增一层，位置/比例/颜色正确 |
| PS 实开 UI PSD 并重算合成 | 通过，逐通道与预存合成相同 |

候选全部使用隔离资料目录与网络阻断，日志为 work/repair-185/candidate-r6-*.log。

## 项目保护与本机剪贴板

此前最新备份为 user-project-backup-185-2026-09-30T00-26-44-089Z，三项目 2981 文件；当前七层副本 revision 479、188 节点、331 图片、1 视频。安装前需按用户最新正常保存退出状态重新核对/备份，不能以旧修订覆盖新修改。

r5 安装版实际 UI 复制 4096 方形图片→Windows 剪贴板→自建 sRGB PS 文档通过：边界 0,0–4096,4096，逐通道最大差 0，PS 文档前后 0；原剪贴板仅保存在内存，恢复后验证。复制 2586ms，renderer/main 最大间隔 61.8/816.4ms。4K 图片格式先发布、位图稍后可读，验收有限等待读回；r5 不能代替最终 r6 安装证据。

## 待完成

最终修复版的完整源与浏览器回归、标准压力检查、构建和扫描；候选实际门禁；安装包 latest/blockmap/NSIS 逐文件核对；最新项目保护与包含内部引号的正确目录正常安装；安装版所有约定离线及本机门禁和完整五层验收；源码提交和 GitHub 草稿资源大小/SHA-256 与本地一致，再公开 Latest。

在线新生成质量未验，用户禁止新增付费调用。离线故障注入和已有返图只能证明客户端处理及本地成品，不能保证供应商未来每次请求成功。七层副本使用补全背景，厨房细节可能不同，界面保留提示；原污染返图不能伪报正式质量通过。项目、备份、QA 资料与凭据不公开。

### R12 continuation correction (2026-10-04)

The previous note that independent RGBA required analysis-route `independentRgba:true` evidence is superseded. Analysis evidence describes ownership only and must not certify generation pixels. New analysis requires an explicit unique element ownership registry, then requests an independent-RGBA candidate; local layer and composite review still gates formal PSD. Existing saved plans remain compatible. Source focused tests and typecheck passed after this correction; the old R12 candidate and installed copy do not contain it, so no release or installer claim changes.

### 2026-10-04 ownership candidate gate

- Isolated unpacked candidate built from the ownership-registry source: staging-canvas-build/formal-185-ownership-r12-20261004-2020/win-unpacked/Canvas Atelier.exe (EXE SHA $exe, app.asar SHA $asar). PE icon verification passed and the build exited 0.
- Candidate functional runner used a fresh offline profile and no paid/provider calls. It failed the strict history loop gate with historyMainLoopMaxGapMs=1305.4644ms (threshold remains <1000ms); receipt/log: work/repair-185/verify-candidate-ownership-r12.log. The failure is retained; no installer was made, installed app was not touched, and GitHub was not published.

- The final rebuilt ownership candidate (`formal-185-ownership-r12-20261004-2045`) was rerun against the strict offline candidate gate. It failed only the unchanged history main-loop threshold at `1038.8621ms` (required `<1000ms`; paid/provider/external/page-error counts were 0), receipt `work/repair-185/verify-candidate-ownership-r12-r5.log`. No installer/install/publish followed.

### 2026-10-04 ownership candidate rerun: strict gate green, semantic gate remains blocked

- The same final unpacked candidate `staging-canvas-build/formal-185-ownership-r12-20261004-2045/win-unpacked/Canvas Atelier.exe` was rerun with a fresh offline profile. Strict candidate gate **PASS**: `history250OpenMs=2176`, `historyMainLoopMaxGapMs=845.2863ms` (threshold `<1000ms`), `paidCalls=0`, external requests `0`, page errors `0`, coordinated close `true`. Receipt: `work/repair-185/candidate-rerun-20261004-2117`.
- Identity is fixed for this receipt: EXE SHA-256 `db6b78f0b726d3d6ff0eac12116f4be55e228da6c0ed3e469eb387d2ded2ac87`; app.asar SHA-256 `eeab6c513de539ef11667b47c31734cbe27482e29e0ed0d337ef9b54d9b05b3d`.
- This does not close the material layering gate. The latest visible-owner report still rejects the five-layer result because the water seam/gray band, body/contact hidden-RGB contamination, and native/UI PSD/Photoshop evidence are unresolved. No installer or public release is claimed until those semantic and installed gates pass.
