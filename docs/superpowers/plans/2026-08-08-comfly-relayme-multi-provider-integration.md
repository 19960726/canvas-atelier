# Comfly 与 RelayMe 双供应商接入实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 同时接入 Comfly 与 RelayMe 的真实聊天、反推、生图和视频能力，并为所有已发现模型提供安全、可验证的智能参数适配。

**Architecture:** 扩展供应商合同，保留独立客户端包，通过桌面供应商注册表路由请求；模型目录返回能力和参数约束，渲染端使用统一 `ModelParameterAdapter` 生成供应商专属请求。

**Tech Stack:** TypeScript 5.8、Zod、Electron IPC、React 19、Vitest、Playwright。

## Global Constraints

- Comfly 与 RelayMe 并存，不能互相替换。
- 模型名称、能力和参数必须来自真实接口或明确配置，禁止按名称猜测能力。
- 密钥仅存桌面安全凭据库，禁止进入项目、日志、截图或测试快照。
- 所有用户错误文案使用中文。
- 先浏览器页面验收，不制作安装包。
- 不清理或覆盖工作区无关用户修改。

---

### Task 1: 扩展多供应商合同

**Files:**
- Modify: `packages/desktop-core/src/provider-contracts.ts`
- Modify: `packages/desktop-core/src/provider-service-types.ts`
- Modify: `packages/desktop-core/src/preload-api.ts`
- Modify: `packages/desktop-core/src/bridge-contract.test.ts`
- Modify: `packages/domain/src/model-job.ts`
- Modify: `packages/domain/src/model-job.test.ts`

**Interfaces:**
- Produces: `ProviderId = 'comfly' | 'relayme'`
- Produces: `ProviderModelProfile` with capabilities and parameter constraints.
- Produces: provider-scoped status/config/list requests.

- [ ] **Step 1: 写失败合同测试**

新增断言：`relayme` 可通过配置、聊天、生图、视频和轮询 schema；未知供应商必须失败；`ModelJob.provider` 接受两家供应商。

- [ ] **Step 2: 运行 RED**

Run: `npm.cmd test -- packages/desktop-core/src/bridge-contract.test.ts packages/domain/src/model-job.test.ts`
Expected: FAIL，错误指向 `z.literal('comfly')` 和视频合同缺失。

- [ ] **Step 3: 最小实现合同**

定义：

```ts
export const ProviderIdSchema = z.enum(['comfly', 'relayme']);
export type ProviderId = z.infer<typeof ProviderIdSchema>;
```

所有请求显式携带 `provider`。新增视频提交、轮询、取消、终态确认合同；结果包含 `assetId`、`posterAssetId?`、`width?`、`height?`、`durationSeconds?`。

- [ ] **Step 4: 运行 GREEN**

Run: `npm.cmd test -- packages/desktop-core/src/bridge-contract.test.ts packages/domain/src/model-job.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```powershell
git add -- packages/desktop-core/src/provider-contracts.ts packages/desktop-core/src/provider-service-types.ts packages/desktop-core/src/preload-api.ts packages/desktop-core/src/bridge-contract.test.ts packages/domain/src/model-job.ts packages/domain/src/model-job.test.ts
git commit -m "feat: add multi-provider bridge contracts"
```

### Task 2: 新建 RelayMe 客户端包

**Files:**
- Create: `packages/provider-relayme/package.json`
- Create: `packages/provider-relayme/tsconfig.json`
- Create: `packages/provider-relayme/src/types.ts`
- Create: `packages/provider-relayme/src/client.ts`
- Create: `packages/provider-relayme/src/client.test.ts`
- Create: `packages/provider-relayme/src/index.ts`
- Modify: `package.json`
- Modify: `packages/desktop-core/package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Produces: `RelayMeClient` with `checkConnection`, `listModels`, `chat`, `generateImage`, `generateVideo`, `getTask`, `cancelTask`.
- Consumes: Bearer token supplier and bounded fetch adapter.

- [ ] **Step 1: 写响应解析失败测试**

覆盖 `/models`、聊天、生图、视频、运行中/成功/失败任务、401、超时、错误响应、密钥脱敏和重复 deployment 去重。

- [ ] **Step 2: 运行 RED**

Run: `npm.cmd test -- packages/provider-relayme/src/client.test.ts`
Expected: FAIL，包不存在。

- [ ] **Step 3: 实现最小客户端**

默认地址固定为 `https://www.ml.relayme.uk/api/ai-tools/v1`，请求头为：

```ts
{ authorization: `Bearer ${token}`, 'content-type': 'application/json' }
```

Zod 只解析需要字段，保留供应商元数据但不把原始响应写日志。

- [ ] **Step 4: 运行 GREEN 与类型检查**

Run: `npm.cmd test -- packages/provider-relayme/src/client.test.ts; npm.cmd exec tsc -p packages/provider-relayme/tsconfig.json -- --noEmit`
Expected: PASS / exit 0。

- [ ] **Step 5: 提交**

```powershell
git add -- packages/provider-relayme package.json packages/desktop-core/package.json package-lock.json
git commit -m "feat: add RelayMe provider client"
```

### Task 3: 供应商隔离凭据与服务注册表

**Files:**
- Create: `packages/desktop-core/src/provider-registry.ts`
- Create: `packages/desktop-core/src/provider-registry.test.ts`
- Modify: `packages/desktop-core/src/provider-credential-vault.ts`
- Modify: `packages/desktop-core/src/provider-credential-vault.test.ts`
- Modify: `packages/desktop-core/src/provider-configuration-store.ts`
- Modify: `packages/desktop-core/src/provider-bridge.ts`
- Modify: `packages/desktop-core/src/provider-ipc-handlers.ts`
- Modify: `packages/desktop-core/src/provider-ipc-registration.ts`

**Interfaces:**
- Produces: `ProviderRegistry.get(provider: ProviderId): ProviderService`.
- Produces: provider-scoped credential/config paths.

- [ ] **Step 1: 写隔离测试**

配置 Comfly 后 RelayMe 仍未配置；RelayMe 解锁不能解锁 Comfly；相同模型路由按供应商分发到不同客户端；未知供应商返回 `INVALID_REQUEST`。

- [ ] **Step 2: 运行 RED**

Run: `npm.cmd test -- packages/desktop-core/src/provider-registry.test.ts packages/desktop-core/src/provider-credential-vault.test.ts`
Expected: FAIL，当前只有单一服务与单一凭据文件。

- [ ] **Step 3: 实现注册表与隔离存储**

使用 provider ID 生成固定受限文件名，不接受任意路径输入。IPC handler 先解析 provider，再取对应服务。

- [ ] **Step 4: 运行 GREEN**

Run: `npm.cmd test -- packages/desktop-core/src/provider-registry.test.ts packages/desktop-core/src/provider-credential-vault.test.ts packages/desktop-core/src/provider-bridge.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```powershell
git add -- packages/desktop-core/src/provider-registry.ts packages/desktop-core/src/provider-registry.test.ts packages/desktop-core/src/provider-credential-vault.ts packages/desktop-core/src/provider-credential-vault.test.ts packages/desktop-core/src/provider-configuration-store.ts packages/desktop-core/src/provider-bridge.ts packages/desktop-core/src/provider-ipc-handlers.ts packages/desktop-core/src/provider-ipc-registration.ts
git commit -m "feat: isolate provider services and credentials"
```

### Task 4: 动态模型能力与参数约束

**Files:**
- Create: `packages/desktop-core/src/provider-model-catalog.ts`
- Create: `packages/desktop-core/src/provider-model-catalog.test.ts`
- Modify: `packages/provider-comfly/src/types.ts`
- Modify: `packages/provider-comfly/src/client.ts`
- Modify: `packages/provider-comfly/src/client.test.ts`
- Modify: `packages/provider-relayme/src/types.ts`
- Modify: `packages/provider-relayme/src/client.ts`
- Modify: `packages/provider-relayme/src/client.test.ts`

**Interfaces:**
- Produces: `ProviderModelProfile[]` with `capabilities` and `constraints`.
- Produces: deterministic duplicate merge keyed by provider + deployment/model ID + capabilities.

- [ ] **Step 1: 写能力映射测试**

确保没有 vision 字段的文字模型不会进入反推；没有 video generation 字段的模型不会进入视频；同名跨供应商保留两项；RelayMe 特价重复条目只显示一条并保留元数据。

- [ ] **Step 2: 运行 RED**

Run: `npm.cmd test -- packages/desktop-core/src/provider-model-catalog.test.ts packages/provider-comfly/src/client.test.ts packages/provider-relayme/src/client.test.ts`
Expected: FAIL，当前 UI 仍靠名称正则猜测能力。

- [ ] **Step 3: 实现能力目录**

只映射接口明确字段；缺失能力返回空集合和 `capabilityStatus: 'incomplete'`，不猜测。

- [ ] **Step 4: 运行 GREEN**

Run: 同 Step 2。
Expected: PASS。

- [ ] **Step 5: 提交**

```powershell
git add -- packages/desktop-core/src/provider-model-catalog.ts packages/desktop-core/src/provider-model-catalog.test.ts packages/provider-comfly/src packages/provider-relayme/src
git commit -m "feat: discover provider model capabilities"
```

### Task 5: 智能比例、尺寸、数量与时长适配

**Files:**
- Create: `packages/domain/src/model-parameter-adapter.ts`
- Create: `packages/domain/src/model-parameter-adapter.test.ts`
- Modify: `packages/domain/src/index.ts`
- Modify: `packages/domain/src/model-job.ts`
- Modify: `apps/renderer/src/canvas/ModuleNodeCard.tsx`
- Modify: `apps/renderer/src/canvas/ModuleNodeCard.test.tsx`

**Interfaces:**
- Produces: `adaptGenerationParameters(target, profile): AdaptedGenerationParameters`.
- Result states: `exact | requires_confirmation | unsupported`.

- [ ] **Step 1: 写参数矩阵测试**

覆盖方图、横图、竖图、1K/2K/4K、1–4 张；视频固定 4/6/8 秒、连续 3–15 秒步长 1；模型切换导致旧值失效；未知能力不得假装支持。

- [ ] **Step 2: 运行 RED**

Run: `npm.cmd test -- packages/domain/src/model-parameter-adapter.test.ts apps/renderer/src/canvas/ModuleNodeCard.test.tsx`
Expected: FAIL，适配器不存在。

- [ ] **Step 3: 实现纯函数适配器**

返回目标值、实际值、供应商请求字段、是否裁剪/补边/放大、中文说明。只有 `exact` 可直接提交；`requires_confirmation` 必须用户确认。

- [ ] **Step 4: 运行 GREEN**

Run: 同 Step 2。
Expected: PASS。

- [ ] **Step 5: 提交**

```powershell
git add -- packages/domain/src/model-parameter-adapter.ts packages/domain/src/model-parameter-adapter.test.ts packages/domain/src/index.ts packages/domain/src/model-job.ts apps/renderer/src/canvas/ModuleNodeCard.tsx apps/renderer/src/canvas/ModuleNodeCard.test.tsx
git commit -m "feat: adapt generation parameters by model"
```

### Task 6: 接通聊天、反推、生图与视频执行

**Files:**
- Modify: `packages/desktop-core/src/provider-bridge.ts`
- Create: `packages/desktop-core/src/relayme-provider-service.ts`
- Create: `packages/desktop-core/src/relayme-provider-service.test.ts`
- Modify: `apps/renderer/src/jobs/desktop-model-executor.ts`
- Modify: `apps/renderer/src/jobs/job-store.ts`
- Modify: `apps/renderer/src/app/desktop-persistence.ts`
- Modify: `apps/renderer/src/canvas/video-generation-results.ts`

**Interfaces:**
- Consumes: provider registry, model profile, adapted parameters.
- Produces: real image/video result records and independent input slots.

- [ ] **Step 1: 写双供应商执行测试**

同一提示词分别路由到 Comfly/RelayMe；RelayMe 视频任务轮询返回真实视频；一个结果只显示一个；输入图槽不进入结果数组；取消任务保持供应商一致。

- [ ] **Step 2: 运行 RED**

Run: `npm.cmd test -- packages/desktop-core/src/relayme-provider-service.test.ts apps/renderer/src/jobs/desktop-model-executor.test.ts apps/renderer/src/canvas/video-generation-results.test.ts`
Expected: FAIL，视频与 RelayMe 服务未接通。

- [ ] **Step 3: 实现最小执行链**

每个任务保存 provider；轮询和取消使用原 provider；结果写入受控媒体存储；禁止把 URL、Base64 或本地路径直接写项目。

- [ ] **Step 4: 运行 GREEN**

Run: 同 Step 2，加 `npm.cmd run typecheck`。
Expected: PASS / exit 0。

- [ ] **Step 5: 提交**

```powershell
git add -- packages/desktop-core/src/provider-bridge.ts packages/desktop-core/src/relayme-provider-service.ts packages/desktop-core/src/relayme-provider-service.test.ts apps/renderer/src/jobs apps/renderer/src/app/desktop-persistence.ts apps/renderer/src/canvas/video-generation-results.ts
git commit -m "feat: execute Comfly and RelayMe generation jobs"
```

### Task 7: 设置页与所有模型选择器

**Files:**
- Modify: `apps/renderer/src/settings/SettingsDrawer.tsx`
- Modify: `apps/renderer/src/settings/SettingsDrawer.test.tsx`
- Create: `apps/renderer/src/settings/ProviderModelCatalog.tsx`
- Create: `apps/renderer/src/settings/ProviderModelCatalog.test.tsx`
- Modify: `apps/renderer/src/app/App.tsx`
- Modify: `apps/renderer/src/canvas/ModuleNodeCard.tsx`
- Modify: `apps/renderer/src/agent/SkillChatWorkbench.tsx`
- Modify: `apps/renderer/src/agent/ReversePromptAgent.tsx`
- Modify: `apps/renderer/src/styles/figma-hybrid-canvas.css`

**Interfaces:**
- Produces: two active provider cards and capability-filtered selectors.
- Consumes: provider-scoped status and model catalog.

- [ ] **Step 1: 写 UI 失败测试**

断言 Comfly、RelayMe 均可点击；GLM 占位不存在；密钥字段为 password；四类选择器显示供应商；无能力模型不出现；适配确认文案可见。

- [ ] **Step 2: 运行 RED**

Run: `npm.cmd test -- apps/renderer/src/settings/SettingsDrawer.test.tsx apps/renderer/src/settings/ProviderModelCatalog.test.tsx apps/renderer/src/canvas/ModuleNodeCard.test.tsx apps/renderer/src/agent/SkillChatWorkbench.test.tsx apps/renderer/src/agent/ReversePromptAgent.test.tsx`
Expected: FAIL，当前只有 Comfly 激活且依赖名称正则。

- [ ] **Step 3: 实现 UI**

移除 `groupAvailableModels` 名称猜测，使用真实 profile capabilities。供应商切换只切换编辑面板，不禁用另一家。

- [ ] **Step 4: 运行 GREEN**

Run: 同 Step 2。
Expected: PASS。

- [ ] **Step 5: 提交**

```powershell
git add -- apps/renderer/src/settings apps/renderer/src/app/App.tsx apps/renderer/src/canvas/ModuleNodeCard.tsx apps/renderer/src/agent apps/renderer/src/styles/figma-hybrid-canvas.css
git commit -m "feat: add dual-provider settings and selectors"
```

### Task 8: 浏览器验收与安全门

**Files:**
- Modify: `apps/renderer/src/test-mode/e2e-harness.ts`
- Create: `tests/e2e/multi-provider-models.spec.ts`
- Create: `tests/e2e/generation-parameter-adaptation.spec.ts`
- Modify: `tests/e2e/helpers/secret-path-scan.mjs`
- Modify: `tests/secret-scan-token-red.test.ts`

**Interfaces:**
- Produces: 用户可操作的双供应商测试页面和浅/深色证据。

- [ ] **Step 1: 增加浏览器合同数据**

模拟两家真实形状的模型目录、聊天、生图、视频任务和能力不足错误，不模拟付费成功声明。

- [ ] **Step 2: 运行页面验收**

```powershell
$env:NOVUS_E2E_PORT='43180'; npm.cmd run e2e -- tests/e2e/multi-provider-models.spec.ts tests/e2e/generation-parameter-adaptation.spec.ts
```

Expected: 两个主题、四类模型选择、智能适配确认、真实结果数量和中文错误全部通过。

- [ ] **Step 3: 运行最终门禁**

```powershell
npm.cmd run typecheck
npm.cmd test -- packages/provider-comfly/src packages/provider-relayme/src packages/desktop-core/src/provider-registry.test.ts packages/desktop-core/src/provider-model-catalog.test.ts packages/domain/src/model-parameter-adapter.test.ts apps/renderer/src/settings/SettingsDrawer.test.tsx
npm.cmd run scan:e2e
```

Expected: 全部 exit 0，密钥扫描无泄漏。

- [ ] **Step 4: 提供用户测试链接**

启动 renderer，仅报告实际端口，并附浅色/深色截图；等待用户验收后才进入下一阶段。

- [ ] **Step 5: 提交验收覆盖**

```powershell
git add -- apps/renderer/src/test-mode/e2e-harness.ts tests/e2e/multi-provider-models.spec.ts tests/e2e/generation-parameter-adaptation.spec.ts tests/e2e/helpers/secret-path-scan.mjs tests/secret-scan-token-red.test.ts
git commit -m "test: verify dual-provider generation workflows"
```