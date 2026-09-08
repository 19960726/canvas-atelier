# Agent Creative Execution Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Codex authentication guidance accurate, make Creative Agent selection and confirmation visibly responsive, create a fresh generation node for every confirmed plan, and report result/save state truthfully.

**Architecture:** Keep provider planning separate from canvas execution. The Agent component owns selection feedback and always emits a new-node request; CanvasWorkspace translates save failures into stable action errors. Generation cards derive success/error from the latest job and available result assets, so an older failure cannot override a newer success.

**Tech Stack:** React, TypeScript, Zustand, Vitest, Testing Library, CSS, Electron.

## Global Constraints

- Preserve all unrelated dirty-worktree changes and user projects.
- Every Creative Agent confirmation creates an independent image/video node and connects only the current request references.
- Never report a result as written back until a result asset exists and the project transaction completes.
- Codex supports ChatGPT and API Key authentication; never expose keys or private diagnostic paths.
- Automated acceptance uses local fixtures and isolated user data, with no paid provider request.

---

### Task 1: Codex API authentication guidance

**Files:**
- Modify: `packages/desktop-core/src/codex-cli-service.test.ts`
- Modify: `apps/renderer/src/agent/SkillChatWorkbench.test.tsx`
- Modify: `apps/renderer/src/agent/SkillChatWorkbench.tsx`

**Interfaces:**
- Consumes: existing `CODEX_CLI_AUTH_REQUIRED` error mapping.
- Produces: accurate ChatGPT/API Key status text and a regression for invalid API keys.

- [ ] **Step 1: Write failing tests**

Add a service case whose CLI returns `401 Incorrect API key` and assert `CODEX_CLI_AUTH_REQUIRED`. Add a component assertion for `支持 ChatGPT / API Key · 调用时验证`.

- [ ] **Step 2: Verify RED**

Run: `npm.cmd exec vitest -- --config vitest.config.ts packages/desktop-core/src/codex-cli-service.test.ts apps/renderer/src/agent/SkillChatWorkbench.test.tsx --run`

Expected: the new status-copy assertion fails; the authentication mapping test confirms or exposes the current mapper boundary.

- [ ] **Step 3: Implement minimal copy/error mapping**

Use this visible copy for local Codex profiles:

```tsx
'支持 ChatGPT / API Key · 调用时验证'
```

If required by RED, extend `mapCodexFailure` only for sanitized `incorrect api key`/`invalid_api_key` text and return `CODEX_CLI_AUTH_REQUIRED`.

- [ ] **Step 4: Verify GREEN**

Run the Task 1 command and require zero failures.

### Task 2: Independent plan selection and confirmation

**Files:**
- Modify: `apps/renderer/src/agent/SkillChatWorkbench.test.tsx`
- Modify: `apps/renderer/src/agent/SkillChatWorkbench.tsx`

**Interfaces:**
- Consumes: `SkillCanvasActionRequest` and current request references.
- Produces: new `nodeId`, `createNode: true`, selected-option feedback, and confirmation focus.

- [ ] **Step 1: Write failing behavior tests**

Change the existing Creative Agent test to pass a selected old target but expect:

```ts
expect(executeCanvasAction).toHaveBeenCalledWith(expect.objectContaining({
  createNode: true,
  nodeId: expect.stringMatching(/^agent-image-/),
  modelRoute: 'image/only',
  prompt: '产品居中，柔和棚灯',
}));
expect(executeCanvasAction).not.toHaveBeenCalledWith(expect.objectContaining({ nodeId: 'image-node' }));
```

After selecting, assert the option button has `aria-pressed="true"`, reads `已选择`, and the confirmation card says `将新建独立节点并执行生图`.

- [ ] **Step 2: Verify RED**

Run the single Creative Agent test and require failures on old-node reuse and missing selection state.

- [ ] **Step 3: Implement minimal independent-node flow**

Store the selected option identity in component state. In `chooseCreativeOption`, remove `resolveCanvasActionTarget` and always build:

```ts
{
  kind,
  nodeId: `agent-${option.kind}-${createMessageId()}`,
  createNode: true,
  projectId,
  prompt: option.prompt,
  modelRoute: profile.modelRoute,
  parameters,
  referenceAssetIds: references.map(({ assetId }) => assetId),
}
```

Attach a ref to the confirmation article and call `scrollIntoView({ block: 'nearest' })` after selection. Clear selection on cancel, mode/task change, new request, or successful submission.

- [ ] **Step 4: Verify GREEN**

Run the focused Creative Agent test, then the complete `SkillChatWorkbench.test.tsx` suite.

### Task 3: Truthful start and result state

**Files:**
- Modify: `apps/renderer/src/canvas/ModuleNodeCard.test.tsx`
- Modify: `apps/renderer/src/canvas/ModuleNodeCard.tsx`
- Modify: `apps/renderer/src/canvas/CanvasWorkspace.test.tsx`
- Modify: `apps/renderer/src/canvas/CanvasWorkspace.tsx`
- Modify: `apps/renderer/src/agent/SkillChatWorkbench.test.tsx`
- Modify: `apps/renderer/src/agent/SkillChatWorkbench.tsx`

**Interfaces:**
- Consumes: latest `ModelJob`, `saveErrorCode`, and `SkillCanvasActionResult.assetIds`.
- Produces: latest-job error selection and stable save/start feedback.

- [ ] **Step 1: Write failing tests**

Add a node case with an older failed job and newer completed job and assert the old error is absent. Add a workspace case where fresh-node creation returns false while `saveErrorCode='PERMISSION_DENIED'` and assert the Agent receives an error with that code. Add an Agent case where a completed job has no assets and assert it does not say `结果已回写`.

- [ ] **Step 2: Verify RED**

Run the three focused test files and confirm each failure matches the current false-state behavior.

- [ ] **Step 3: Implement minimal state rules**

Change `selectLatestFailedGenerationJob` to inspect the latest matching job and return it only when `status === 'failed'`. When new-node creation fails, read the current save error and throw a stable action error. Render completed-without-assets as `结果已生成，但尚未回写画布`; render `结果已回写` only when `assetIds.length > 0`.

- [ ] **Step 4: Verify GREEN**

Run the Task 3 focused files and require zero failures.

### Task 4: Plan and confirmation controls

**Files:**
- Modify: `apps/renderer/src/main.styles.test.ts`
- Modify: `apps/renderer/src/styles/release-layout-contract.css`

**Interfaces:**
- Consumes: `.creative-plan__option`, `.is-selected`, and `.skill-chat-workbench__confirmation-actions` classes.
- Produces: final-cascade accessible button geometry and visible primary/secondary hierarchy.

- [ ] **Step 1: Write failing CSS contract test**

Assert the final release stylesheet defines 36px minimum controls, an emphasized selected option, a solid primary confirm button, a quiet cancel button, focus-visible outlines, and disabled-state opacity/cursor.

- [ ] **Step 2: Verify RED**

Run `npm.cmd exec vitest -- --config vitest.config.ts apps/renderer/src/main.styles.test.ts --run` and confirm the new contract fails.

- [ ] **Step 3: Add final-cascade styles**

Append one named Agent confirmation block to `release-layout-contract.css`, using existing color variables and the new semantic classes. Do not modify global button rules.

- [ ] **Step 4: Verify GREEN**

Run the stylesheet test and `SkillChatWorkbench.test.tsx`.

### Task 5: Verification and release evidence

**Files:**
- Modify: `docs/project-memory.md`
- Produce: focused test/typecheck/build logs under `work/`

**Interfaces:**
- Consumes: Tasks 1-4.
- Produces: source-level acceptance evidence and a clean handoff for packaging.

- [ ] **Step 1: Run focused and wider verification**

Run the Agent, CanvasWorkspace, ModuleNodeCard, job-store, Codex service, and stylesheet suites; then run Renderer/Desktop Core typechecks and the production build.

- [ ] **Step 2: Check changed-file integrity**

Run `git diff --check` for only the files changed by this plan and inspect their diff so unrelated dirty changes remain untouched.

- [ ] **Step 3: Record root causes and evidence**

Append the confirmed auth, node reuse, selection-feedback, latest-job, and save/result boundaries to `docs/project-memory.md`, including exact test commands and remaining packaged/live limits.

- [ ] **Step 4: Package only after source gates pass**

Advance the release version, rebuild a separate unpacked candidate and NSIS installer, verify payload identity, run the isolated Creative Agent fixture, and publish the online update only after those fresh gates pass.
