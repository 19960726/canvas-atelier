# Canvas Agent MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a locally runnable Windows infinite-canvas MVP with editable reference placement, a canvas-aware Agent confirmation transaction, guarded Skill memory import, and Comfly image jobs.

**Architecture:** Use an npm workspace with a shared React renderer, framework-independent TypeScript domain packages, a Node service layer, and two Electron shells. The first production slice stores projects locally, previews Agent graph mutations before applying them, and requires confirmation before model execution.

**Tech Stack:** TypeScript, React, Vite, @xyflow/react, Zustand, Vitest, React Testing Library, Playwright, Zod, Dexie, Node.js, Electron 22.3.27 for Windows 7, `electron@latest` resolved and locked for Windows 10/11, npm workspaces.

## Global Constraints

- Original product; do not copy CanvasForge UI, branding, proprietary code, wording, node design, or product identity.
- Runtime canvas belongs to the app; Figma is the editable design source only.
- Support Windows 7 SP1 64-bit through Windows 11 on a 4-core CPU, 8 GB RAM, and integrated GPU.
- Target 60 FPS normally and stable 30 FPS on old Windows 7 hardware.
- Canvas budget: 1000 lightweight nodes or 200 image nodes.
- Agent changes require confirmation and apply as one undoable transaction.
- Model execution always requires explicit confirmation.
- Import `D:\场景skill` into an app-managed copy; reviewed diff confirmation is required for source writeback.
- Comfly base URL is `https://ai.comfly.org`; model capabilities are configurable and dynamically loaded.
- API keys never enter canvas JSON, Skill files, logs, or exports.
- User-facing operational copy is Chinese.

## File Map

```text
apps/renderer/src/{app,canvas,agent,placement,jobs,styles}
apps/desktop-modern/src
apps/desktop-win7/src
packages/domain/src
packages/provider-comfly/src
packages/skill-store/src
packages/desktop-bridge/src
tests/{fixtures,integration,e2e}
```

- `packages/domain`: serializable project, canvas, placement, Agent plan, transaction, and job types.
- `apps/renderer`: UI, viewport, React Flow adapters, panels, and interactions.
- `packages/skill-store`: imported Skill copies, hashes, diffs, and guarded writeback.
- `packages/provider-comfly`: HTTP requests, normalized responses, polling, and redaction.
- `packages/desktop-bridge`: typed IPC only; Electron main processes implement it.

---

### Task 1: Workspace Scaffold and Shared Contracts

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `vitest.workspace.ts`
- Create: `apps/renderer/package.json`
- Create: `packages/domain/package.json`
- Create: `packages/domain/src/index.ts`, `packages/domain/src/project-schema.ts`
- Test: `packages/domain/src/project-schema.test.ts`

**Interfaces:**
- Produces: `CanvasProject`, `CanvasNode`, `CanvasEdge`, `ReferenceRole`, `PlacementBoard`, `AgentPlan`, `ModelJob`.
- Produces: `parseCanvasProject(input: unknown): CanvasProject`.

- [ ] **Step 1: Create workspace manifests**

Root `package.json` uses npm workspaces `apps/*` and `packages/*` with scripts `test`, `typecheck`, `build`, and `e2e`. `tsconfig.base.json` sets `target: "ES2019"`, `module: "ESNext"`, `moduleResolution: "Bundler"`, `strict: true`, `noUncheckedIndexedAccess: true`, and `skipLibCheck: true`.

- [ ] **Step 2: Write the failing schema test**

```ts
it('rejects a reference node without a role', () => {
  expect(() => parseCanvasProject({
    version: 1,
    id: 'p1',
    name: '测试项目',
    nodes: [{ id: 'r1', type: 'reference', position: { x: 0, y: 0 }, data: {} }],
    edges: [],
  })).toThrow(/role/);
});
```

- [ ] **Step 3: Verify RED**

Run: `npm install && npm test -- packages/domain/src/project-schema.test.ts`

Expected: FAIL because the parser does not exist.

- [ ] **Step 4: Implement Zod schemas**

```ts
export const referenceRoleSchema = z.enum([
  'product_identity',
  'scene_composition',
  'prop_reference',
  'material_lighting',
  'placement_preview',
]);
```

Use discriminated unions for node data. Image-bearing nodes store `assetId`, never credentials.

- [ ] **Step 5: Verify and commit**

Run: `npm test -- packages/domain/src/project-schema.test.ts && npm run typecheck`

```bash
git add package.json package-lock.json tsconfig.base.json vitest.workspace.ts apps/renderer/package.json packages/domain
git commit -m "build: scaffold canvas workspace and domain schema"
```

---

### Task 2: Atomic Canvas Transactions

**Files:**
- Create: `packages/domain/src/canvas-transaction.ts`
- Test: `packages/domain/src/canvas-transaction.test.ts`
- Modify: `packages/domain/src/index.ts`

**Interfaces:**
- Consumes: Task 1 domain types.
- Produces: `CanvasOperation`, `CanvasTransaction`, `applyTransaction`, `revertTransaction`.

- [ ] **Step 1: Write failing atomicity tests**

```ts
const result = applyTransaction(emptyProject, {
  id: 'tx1',
  label: 'Agent 创建方案',
  operations: [
    { kind: 'create_node', node: referenceNode },
    { kind: 'create_node', node: promptNode },
    { kind: 'create_edge', edge: { id: 'e1', source: 'r1', target: 'p1' } },
  ],
});
expect(result.project.nodes).toHaveLength(2);
expect(revertTransaction(result.project, result.inverse)).toEqual(emptyProject);
```

Also assert invalid edges produce no partial mutation.

- [ ] **Step 2: Verify RED**

Run: `npm test -- packages/domain/src/canvas-transaction.test.ts`

- [ ] **Step 3: Implement immutable application**

Support `create_node`, `update_node`, `delete_node`, `create_edge`, and `delete_edge`. Validate a cloned draft and build inverse operations in reverse order.

- [ ] **Step 4: Verify and commit**

Run: `npm test -- packages/domain/src/canvas-transaction.test.ts`

```bash
git add packages/domain/src/canvas-transaction* packages/domain/src/index.ts
git commit -m "feat: add atomic canvas transactions"
```

---

### Task 3: Infinite Canvas Workspace

**Files:**
- Create: `apps/renderer/index.html`, `apps/renderer/vite.config.ts`
- Create: `apps/renderer/src/main.tsx`, `apps/renderer/src/app/App.tsx`, `apps/renderer/src/app/app-store.ts`
- Create: `apps/renderer/src/canvas/CanvasWorkspace.tsx`, `apps/renderer/src/canvas/node-types.tsx`
- Create: `apps/renderer/src/styles/tokens.css`, `apps/renderer/src/styles/app.css`
- Test: `apps/renderer/src/canvas/CanvasWorkspace.test.tsx`

**Interfaces:**
- Consumes: Task 1-2 domain APIs.
- Produces: `useAppStore`, `CanvasWorkspace`, React Flow node adapters.

- [ ] **Step 1: Write failing shell test**

```tsx
render(<CanvasWorkspace />);
expect(screen.getByRole('application', { name: '无限画布' })).toBeVisible();
expect(screen.getByLabelText('选择工具')).toBeVisible();
expect(screen.getByLabelText('Agent 面板')).toBeVisible();
expect(screen.getByLabelText('任务队列')).toBeVisible();
```

- [ ] **Step 2: Verify RED**

Run: `npm test -- apps/renderer/src/canvas/CanvasWorkspace.test.tsx`

- [ ] **Step 3: Install renderer dependencies and implement shell**

```bash
npm install -w @agent-canvas/renderer react react-dom @xyflow/react zustand dexie zod lucide-react
npm install -D -w @agent-canvas/renderer vite @vitejs/plugin-react @testing-library/react @testing-library/jest-dom jsdom
```

Use a full-window grid: 44 px top bar, 48 px left rail, flexible canvas, 360 px collapsible Agent panel, 36 px job strip. Use Lucide icons. Keep domain nodes separate from React Flow view props and memoize node renderers.

- [ ] **Step 4: Verify and commit**

Run: `npm test -- apps/renderer/src/canvas/CanvasWorkspace.test.tsx && npm run build -w @agent-canvas/renderer`

```bash
git add apps/renderer package.json package-lock.json
git commit -m "feat: build canvas-first renderer shell"
```

---

### Task 4: Reference Upload and Placement Preview

**Files:**
- Create: `packages/domain/src/placement.ts`, `packages/domain/src/placement.test.ts`
- Create: `apps/renderer/src/placement/PlacementBoard.tsx`, `PlacementInspector.tsx`
- Test: `apps/renderer/src/placement/PlacementBoard.test.tsx`

**Interfaces:**
- Produces: `normalizePlacementObject`, `placementToPromptConstraints`, editable `PlacementBoard`.

- [ ] **Step 1: Write failing conversion tests**

```ts
expect(placementToPromptConstraints(board)).toEqual(expect.arrayContaining([
  '主产品位于画面水平 34% 至 66% 区间',
  '主产品约占画面宽度 32%',
  '顶部 8% 至 23% 为文案安全区，禁止产品和道具侵入',
]));
```

Test precedence: locked placement overrides scene composition; product identity retains logo readability.

- [ ] **Step 2: Verify RED**

Run: `npm test -- packages/domain/src/placement.test.ts`

- [ ] **Step 3: Implement normalized transforms**

Clamp `x/y/w/h` to `[0,1]`, rotation to `[-180,180]`, preserve `zIndex`, lock, visibility, flips, and semantic layer. Exclude hidden objects from prompt constraints.

- [ ] **Step 4: Test and implement UI interactions**

Test drag, eight-handle resize, rotate, flip, lock, hide, rename, layer order, role selection, thirds/safe-area guides, and snapping. Use pointer capture and one fixed-aspect coordinate system.

- [ ] **Step 5: Verify and commit**

Run: `npm test -- packages/domain/src/placement.test.ts apps/renderer/src/placement/PlacementBoard.test.tsx`

```bash
git add packages/domain/src/placement* packages/domain/src/index.ts apps/renderer/src/placement
git commit -m "feat: add editable reference placement board"
```

---

### Task 5: Agent Plan Preview, Confirmation, and Undo

**Files:**
- Create: `packages/domain/src/agent-plan.ts`, `packages/domain/src/agent-plan.test.ts`
- Create: `apps/renderer/src/agent/AgentPanel.tsx`, `PlanPreview.tsx`, `use-agent-plan.ts`
- Test: `apps/renderer/src/agent/PlanPreview.test.tsx`

**Interfaces:**
- Consumes: canvas transactions and placement constraints.
- Produces: `AgentPlanState`, `validateAgentPlan`, `confirmAgentPlan`, `cancelAgentPlan`.

- [ ] **Step 1: Write failing permission tests**

```ts
expect(validateAgentPlan(planWithoutConfirmation)).toMatchObject({
  canPreview: true,
  canExecuteModels: false,
});
expect(validateAgentPlan(confirmedPlan)).toMatchObject({
  canApplyTransaction: true,
  canExecuteModels: true,
});
```

Reject deletion, Skill source sync, and model calls without their explicit capability confirmation.

- [ ] **Step 2: Verify RED**

Run: `npm test -- packages/domain/src/agent-plan.test.ts`

- [ ] **Step 3: Implement states and gates**

Use exact states: `idle`, `reading_canvas`, `drafting_plan`, `waiting_for_confirmation`, `applying_transaction`, `running_models`, `reviewing_results`, `waiting_for_memory_sync`, `error_needs_user`.

- [ ] **Step 4: Implement visual preview**

Map creates to translucent ghost nodes and proposed links to dashed edges. Show create/connect/update/hide/lock/run operations, conflicts, model route, job count, `确认执行`, and `取消方案`.

- [ ] **Step 5: Apply one transaction**

`confirmAgentPlan(planId)` calls `applyTransaction` exactly once, pushes one inverse transaction, and queues models only when model confirmation exists.

- [ ] **Step 6: Verify and commit**

Run: `npm test -- packages/domain/src/agent-plan.test.ts apps/renderer/src/agent/PlanPreview.test.tsx`

```bash
git add packages/domain/src/agent-plan* apps/renderer/src/agent
git commit -m "feat: add confirmed agent canvas plans"
```

---

### Task 6: Skill Import Copy and Memory Diff

**Files:**
- Create: `packages/skill-store/package.json`
- Create: `packages/skill-store/src/types.ts`, `hash.ts`, `import-skill.ts`, `memory-diff.ts`, `index.ts`
- Test: `packages/skill-store/src/import-skill.test.ts`, `memory-diff.test.ts`
- Create: `tests/fixtures/scene-skill/`

**Interfaces:**
- Produces: `importSkillCopy(sourceRoot, managedRoot)`, `computeMemoryDiff(base, app, source)`, `approveSkillWriteback(diffId, approvalToken)`.

- [ ] **Step 1: Write failing import tests**

Fixtures contain `main-memory.md`, `latest-project-memory.md`, `PROJECT_CHECKPOINT.md`, requirement ledger, iteration log, prompt framework, and prompt history. Assert the manifest stores relative path, SHA-256, timestamp, source root, and managed-copy version.

- [ ] **Step 2: Verify RED**

Run: `npm test -- packages/skill-store/src/import-skill.test.ts`

- [ ] **Step 3: Implement managed-copy import**

Copy only allowlisted paths. Resolve every target and reject traversal outside `managedRoot`. Never mutate `D:\场景skill` during import or normal Agent work.

- [ ] **Step 4: Implement three-way diff**

```ts
type MemoryDiffState =
  | 'unchanged'
  | 'app_changed'
  | 'source_changed'
  | 'conflict';
```

Writeback remains `pending_review` until a one-use approval token is presented. Append every approved change to internal history.

- [ ] **Step 5: Verify and commit**

Run: `npm test -- packages/skill-store/src/import-skill.test.ts packages/skill-store/src/memory-diff.test.ts`

```bash
git add packages/skill-store tests/fixtures/scene-skill
git commit -m "feat: import skill memory through guarded copies"
```

---

### Task 7: Independent Comfly Provider Adapter

**Files:**
- Create: `packages/provider-comfly/package.json`
- Create: `packages/provider-comfly/src/types.ts`, `client.ts`, `model-registry.ts`, `redact.ts`, `index.ts`
- Test: `packages/provider-comfly/src/client.test.ts`, `redact.test.ts`

**Interfaces:**
- Produces: `ComflyClient`, `ComflyModelCapability`, `normalizeBaseUrl`, `redactProviderLog`.
- Methods: `chat`, `responses`, `generateImage`, `editImage`, `getImageTask`, `generateGeminiContent`.
- Consumes: injected `fetch` and token supplier from desktop secure storage.

- [ ] **Step 1: Write failing request tests**

```ts
await client.generateImage({ model: 'image-model', prompt: '产品海报', async: true });
expect(fetchSpy).toHaveBeenCalledWith(
  'https://ai.comfly.org/v1/images/generations?async=true',
  expect.objectContaining({ method: 'POST' }),
);
```

Also assert `/v1/chat/completions`, `/v1/responses`, `/v1/images/edits`, `/v1/images/tasks/{taskId}`, and `/v1beta/models/{model}:generateContent`.

- [ ] **Step 2: Verify RED**

Run: `npm test -- packages/provider-comfly/src/client.test.ts`

- [ ] **Step 3: Implement client and normalization**

Remove trailing base URL slashes. Inject timeout signal and token supplier. Validate success and error bodies with Zod. Support OpenAI-compatible `image_url`. Never log authorization headers or raw base64 image bodies.

- [ ] **Step 4: Implement capability registry**

Capabilities: `chat`, `vision`, `image_generation`, `image_edit`, `responses`, `gemini_native`, `async_tasks`. Merge provider-discovered models with a user-editable local profile; do not hardcode one model ID.

- [ ] **Step 5: Verify and commit**

Run: `npm test -- packages/provider-comfly/src/client.test.ts packages/provider-comfly/src/redact.test.ts`

```bash
git add packages/provider-comfly
git commit -m "feat: add independent comfly provider adapter"
```

---

### Task 8: Persistent Model Job Queue and Result Nodes

**Files:**
- Create: `packages/domain/src/model-job.ts`, `packages/domain/src/model-job.test.ts`
- Create: `apps/renderer/src/jobs/job-store.ts`, `JobStrip.tsx`, `ImageResultNode.tsx`
- Test: `apps/renderer/src/jobs/job-store.test.ts`

**Interfaces:**
- Consumes: Comfly client, transaction API, confirmed Agent plan.
- Produces: `enqueueConfirmedJobs`, `pollAsyncJob`, `retryJob`, `cancelQueuedJob`.

- [ ] **Step 1: Write failing transition tests**

Allow `queued -> submitting -> running -> completed`, `submitting/running -> failed`, and `failed -> queued`. Reject `queued -> completed` and enqueue without `confirmedAt`.

- [ ] **Step 2: Verify RED**

Run: `npm test -- packages/domain/src/model-job.test.ts apps/renderer/src/jobs/job-store.test.ts`

- [ ] **Step 3: Implement Dexie persistence and polling**

Limit provider polling concurrency to four and image decode concurrency to two. Store request metadata without secrets. On completion, create a result node linked to prompt, references, model ID, and provider task ID.

- [ ] **Step 4: Implement bottom job strip**

Show active count, progress, model, retry count, compact Chinese error, retry, and cancel where supported. Keep canvas interaction unblocked.

- [ ] **Step 5: Verify and commit**

Run: `npm test -- packages/domain/src/model-job.test.ts apps/renderer/src/jobs/job-store.test.ts`

```bash
git add packages/domain/src/model-job* apps/renderer/src/jobs
git commit -m "feat: add persistent image job queue"
```

---

### Task 9: Typed Desktop Bridge and Secure Services

**Files:**
- Create: `packages/desktop-bridge/package.json`
- Create: `packages/desktop-bridge/src/channels.ts`, `contracts.ts`, `preload.ts`, `index.ts`
- Test: `packages/desktop-bridge/src/contracts.test.ts`
- Create: `apps/desktop-modern/src/services.ts`, `apps/desktop-win7/src/services.ts`

**Interfaces:**
- Produces: `window.agentCanvas` with `project`, `assets`, `provider`, `skill`, and `secrets` namespaces.
- Consumes: provider and Skill packages.

- [ ] **Step 1: Write failing validation tests**

Validate every IPC request and response with Zod. Reject unknown channels, paths outside selected roots, and renderer-supplied raw authorization headers.

- [ ] **Step 2: Verify RED**

Run: `npm test -- packages/desktop-bridge/src/contracts.test.ts`

- [ ] **Step 3: Implement context-isolated preload**

Expose only typed methods via `contextBridge`. Renderer receives no Node filesystem, process, or keychain primitive. Normalize errors as `{ code, message, retryable }`.

- [ ] **Step 4: Implement secret storage**

Use OS-protected storage where available. In legacy Win7, use Electron safe storage when available; otherwise require a passphrase and store an authenticated encrypted blob. Never fall back to plaintext.

- [ ] **Step 5: Verify and commit**

Run: `npm test -- packages/desktop-bridge/src/contracts.test.ts`

Run secret scan: `Get-ChildItem apps,packages -Recurse -Include *.ts,*.tsx | Select-String -Pattern 'Authorization: Bearer','apiKey:' -SimpleMatch`

Expected: only redacted construction sites and test fixtures.

```bash
git add packages/desktop-bridge apps/desktop-modern/src/services.ts apps/desktop-win7/src/services.ts
git commit -m "feat: add secure typed desktop bridge"
```

---

### Task 10: Dual Electron Shells and Runtime Profiles

**Files:**
- Create: `apps/desktop-modern/package.json`, `src/main.ts`, `electron-builder.yml`
- Create: `apps/desktop-win7/package.json`, `src/main.ts`, `electron-builder.yml`
- Create: `packages/domain/src/runtime-profile.ts`
- Test: `packages/domain/src/runtime-profile.test.ts`

**Interfaces:**
- Produces: `RuntimeProfile` values `modern` and `legacy-win7`.
- Consumes: renderer build and preload bridge.

- [ ] **Step 1: Write failing profile tests**

Legacy profile: reduced thumbnail edge, shadows disabled during pan, two provider polls, one image decode, 30 FPS floor. Modern profile: larger thumbnails, four polls, two decodes, 60 FPS target.

- [ ] **Step 2: Verify RED**

Run: `npm test -- packages/domain/src/runtime-profile.test.ts`

- [ ] **Step 3: Install shell dependencies**

```bash
npm install -D -w @agent-canvas/desktop-win7 electron@22.3.27 electron-builder
npm install -D -w @agent-canvas/desktop-modern electron@latest electron-builder
```

Commit the resolved modern Electron version in `package-lock.json`. Both shells load the same renderer. Set `contextIsolation: true`, `nodeIntegration: false`, explicit CSP, and no remote module.

- [ ] **Step 4: Configure packaging**

Legacy artifact: `AgentCanvas-Win7-x64-${version}.exe`. Modern artifact: `AgentCanvas-Win10-11-x64-${version}.exe`. Keep separate output directories.

- [ ] **Step 5: Verify and commit**

Run: `npm run build && npm run pack -w @agent-canvas/desktop-win7 && npm run pack -w @agent-canvas/desktop-modern`

Expected: both unpacked applications launch on the build machine.

```bash
git add apps/desktop-modern apps/desktop-win7 packages/domain/src/runtime-profile* package-lock.json
git commit -m "build: add win7 and modern electron shells"
```

---

### Task 11: Performance, Autosave, and Recovery

**Files:**
- Create: `apps/renderer/src/canvas/use-viewport-culling.ts`, `use-interaction-quality.ts`
- Create: `apps/renderer/src/app/autosave.ts`, `recovery.ts`
- Test: corresponding `*.test.ts`
- Create: `tests/integration/large-canvas.test.ts`

**Interfaces:**
- Consumes: runtime profile, project parser, app store.
- Produces: viewport culling, quality downgrade, debounced autosave, recovery journal.

- [ ] **Step 1: Write failing scale and recovery tests**

Generate 1000 lightweight nodes and assert only viewport plus overscan nodes mount. Simulate interrupted save and assert the last valid journal restores.

- [ ] **Step 2: Verify RED**

Run: `npm test -- apps/renderer/src/canvas/use-viewport-culling.test.ts apps/renderer/src/app/recovery.test.ts tests/integration/large-canvas.test.ts`

- [ ] **Step 3: Implement performance controls**

Cull offscreen DOM-heavy nodes, preserve selected/connected handles, pause shadows and high-resolution thumbnails during pan/zoom, restore after 120 ms idle, and batch Agent ghost insertion into one store update.

- [ ] **Step 4: Implement autosave**

Debounce normal saves at 750 ms, flush on blur/close, journal before replacing the project file, and validate recovery through `parseCanvasProject`.

- [ ] **Step 5: Verify and commit**

Run: `npm test -- tests/integration/large-canvas.test.ts apps/renderer/src/app/recovery.test.ts`

```bash
git add apps/renderer/src/canvas apps/renderer/src/app tests/integration/large-canvas.test.ts
git commit -m "perf: virtualize canvas and add crash recovery"
```

---

### Task 12: End-to-End Acceptance

**Files:**
- Create: `playwright.config.ts`
- Create: `tests/e2e/agent-reference-workflow.spec.ts`
- Create: `tests/e2e/skill-sync-guard.spec.ts`
- Create: `tests/e2e/model-confirmation.spec.ts`
- Create: `tests/e2e/visual-layout.spec.ts`
- Create: `docs/testing/windows-compatibility-matrix.md`

**Interfaces:**
- Consumes: all prior tasks.
- Produces: executable acceptance suite and Windows compatibility record.

- [ ] **Step 1: Test the complete workflow**

Upload separate product, scene, and prop fixtures; assign roles; position and resize product on a 4:5 board; request an Agent plan; verify ghost nodes and dashed edges; confirm; verify one undo removes the full plan; re-confirm; verify model job queues only after model confirmation.

- [ ] **Step 2: Test Skill sync guard**

Modify managed and source fixtures independently. Verify a three-way diff and no source write before `确认同步`.

- [ ] **Step 3: Test layouts and performance**

Capture 1440x900, 1920x1080, and 1366x768. Assert no overlap among Agent panel, top bar, left rail, job strip, and canvas. Record median pan/zoom frame interval with Playwright performance marks.

- [ ] **Step 4: Run full verification**

Run: `npm test && npm run typecheck && npm run build && npm run e2e`

Expected: all tests pass, TypeScript has zero errors, and Vite exits 0.

- [ ] **Step 5: Complete manual Windows matrix**

Record launch, Chinese-path open/save, Comfly HTTPS, pan/zoom, 200-image navigation, recovery, and installer behavior on Windows 7 SP1 x64, Windows 10 x64, and Windows 11 x64. No release is approved with an unverified required row.

- [ ] **Step 6: Commit**

```bash
git add playwright.config.ts tests/e2e docs/testing/windows-compatibility-matrix.md
git commit -m "test: cover agent canvas acceptance workflow"
```

---

## Figma Delivery Gate

Before Task 3 visual implementation is accepted, create one Figma design file with four editable 1440x900 frames:

1. `01 Canvas Workspace`.
2. `02 Placement Preview` with product, scene, prop, safe area, handles, and layer inspector.
3. `03 Agent Plan Confirmation` with ghost nodes, dashed edges, KEEP / CHANGE / NEVER, model route, confirm/cancel.
4. `04 Skill Memory Sync` with base/app/source diff and guarded sync.

Use a 44 px top bar, 48 px left rail, 340-380 px Agent panel, and 36 px job strip. Validate each frame by screenshot. This gate is waiting for the Figma MCP connection to become available in this Codex task.

## Execution Checkpoints

- A after Task 3: runnable canvas shell.
- B after Task 5: editable placement plus confirmed Agent transaction.
- C after Task 8: guarded Skill memory plus Comfly image queue.
- D after Task 10: both desktop shells package.
- E after Task 12: acceptance and Windows matrix complete.
