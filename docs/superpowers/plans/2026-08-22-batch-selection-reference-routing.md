# 批量框选素材连接与反推逐图引用实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the video-style flow that creates a function node from a multi-node selection, connects selected media in deterministic order, sends every referenced image to reverse analysis with per-image responsibilities, and regressions-test the previously reported UI issues.

**Architecture:** Keep selection ordering and compatibility decisions in a pure renderer helper. `CanvasWorkspace` owns selection and target-node creation, while the existing app-store transaction API remains the only persistence boundary. Reverse execution consumes the durable ordered edges and produces one structured responsibility record per referenced media item. Existing `MediaMentionTextarea` remains the editable surface; only its active-mention and scroll contracts are extended.

**Tech Stack:** React 19, React Flow/XyFlow, Zustand app store, TypeScript, Vitest/Testing Library, Vite, Electron Builder NSIS.

## Global Constraints

- Preserve all existing modified and untracked files; never reset, clean, or overwrite unrelated work.
- Sort selected media by `position.y`, then `position.x`, then node id.
- Append new edges after existing target input order; never overwrite existing references.
- Enforce the existing domain port compatibility and project-wide 20-media limit.
- Every `@图片N` / `@视频N` reference sent to reverse analysis must have a corresponding ordered media payload and responsibility record.
- `@` must work before, between, and after existing mention chips; the editor must consume its own wheel events.
- Run tests before claiming completion and rebuild the Windows NSIS installer.

---

### Task 1: Pure selection ordering and batch connection planning

**Files:**
- Create: `apps/renderer/src/canvas/batch-selection-routing.ts`
- Create: `apps/renderer/src/canvas/batch-selection-routing.test.ts`
- Modify: `apps/renderer/src/canvas/CanvasWorkspace.test.tsx` only if shared fixtures are needed

**Interfaces:**
- Produces `sortSelectedMediaNodes(nodes: readonly CanvasNode[]): CanvasNode[]`.
- Produces `planBatchConnections(input: { selectedNodes; targetNode; existingEdges }): { connections; skipped }` where each connection is a `Connection` with `source`, `sourceHandle`, `target`, `targetHandle`, and deterministic `order`.
- Consumes `getCanvasModuleDefinition`, `canConnectCanvasPorts`, and the existing `CanvasNode`/`CanvasEdge` domain types.

- [ ] **Step 1: Write failing tests**

Add tests for: (a) y/x/id ordering, (b) image inputs to image generation references, (c) mixed image/video inputs to reverse references, (d) incompatible nodes reported in `skipped`, (e) existing target order preserved and new order appended, and (f) 20-item limit.

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```powershell
npm.cmd exec vitest -- --config vitest.config.ts apps/renderer/src/canvas/batch-selection-routing.test.ts --run
```

Expected: FAIL because the helper module and planning behavior do not exist.

- [ ] **Step 3: Implement the minimal pure helper**

Use stable sorting and the existing port validator. Do not mutate nodes or edges. Derive the next input order from the maximum existing order on the target port, then emit only valid connections until the media limit is reached.

- [ ] **Step 4: Run the focused test and verify it passes**

Run the same Vitest command. Expected: all ordering, compatibility, append, and limit tests PASS.

- [ ] **Step 5: Preserve the isolated change**

Record the test output and do not stage unrelated files. If the repository index lock is available, commit only these two files with `feat: plan batch media connections`; if it is unavailable, leave the files intact and continue without altering other work.

### Task 2: Wire selection-to-function-node creation in CanvasWorkspace

**Files:**
- Modify: `apps/renderer/src/canvas/CanvasWorkspace.tsx`
- Modify: `apps/renderer/src/canvas/CanvasWorkspace.test.tsx`
- Modify: `apps/renderer/src/canvas/ModuleLibrary.tsx` or `QuickInsert.tsx` only where the existing module-choice callback is defined

**Interfaces:**
- Consumes `planBatchConnections` from Task 1.
- Produces one user action that creates the target node, discovers its durable id, commits all planned edges, and reports skipped nodes once.

- [ ] **Step 1: Write failing component tests**

Add a React Flow workspace test that selects three media nodes, chooses `image_generation`, and asserts one new target node plus three ordered edges. Add tests for `reverse_agent`, incompatible selection feedback, and an existing target reference that remains first.

- [ ] **Step 2: Run tests to verify the new flow fails**

Run:

```powershell
npm.cmd exec vitest -- --config vitest.config.ts apps/renderer/src/canvas/CanvasWorkspace.test.tsx --run -t "batch|selection|ordered"
```

Expected: FAIL because module choice currently only creates a node or handles one pending connection.

- [ ] **Step 3: Implement the smallest integration**

Capture selected node ids from the existing React Flow selection state before opening the module choice menu. On module choice, create the node at the safe placement, reload durable state only through the existing helper when required, plan connections against the newly discovered node, and call `connectModulePorts` in planned order. Keep selection state and canvas focus stable after completion.

- [ ] **Step 4: Run focused CanvasWorkspace tests**

Expected: all new batch tests and existing CanvasWorkspace tests PASS; no React Flow selection test regresses.

- [ ] **Step 5: Add interaction guard tests**

Verify a second batch action does not duplicate an existing edge, a target with 20 references reports a limit, and clicking a normal single node still uses the existing focus behavior.

### Task 3: Ensure reverse analysis sends every referenced image and records each role

**Files:**
- Inspect/modify: `apps/renderer/src/jobs/desktop-model-executor.ts`
- Inspect/modify: `apps/renderer/src/app/app-store.ts`
- Modify: `packages/domain/src/reverse-prompt-agent.ts` only if the existing result schema lacks a required per-media responsibility field
- Modify: `apps/renderer/src/canvas/ModuleNodeCard.test.tsx`
- Modify: relevant `packages/domain/src/reverse-prompt-agent.test.ts`

**Interfaces:**
- Consumes durable target edges ordered by `order`, mention tokens, project image/video asset summaries, and the existing reverse-agent request contract.
- Produces an ordered model request containing every referenced media item and a structured result with one `mediaResponsibility` entry per item.

- [ ] **Step 1: Write failing tests**

Create a reverse node with at least three connected images, task text mentioning `@图片1`, `@图片2`, and `@图片3`, and assert the executor request contains all three assets in order. Add a schema test asserting a missing responsibility entry makes the result incomplete/retryable rather than silently successful.

- [ ] **Step 2: Run the tests and verify the expected failure**

Run:

```powershell
npm.cmd exec vitest -- --config vitest.config.ts apps/renderer/src/canvas/ModuleNodeCard.test.tsx packages/domain/src/reverse-prompt-agent.test.ts --run -t "every referenced|responsibility|ordered media"
```

Expected: FAIL because the current path either drops references or does not enforce per-media output.

- [ ] **Step 3: Implement ordered request construction**

Derive references from durable edges, map each to its canonical mention, and pass the complete ordered list into `orderedMedia` and the provider request. Keep labels and managed asset identities; never pass local filesystem paths or raw provider URLs.

- [ ] **Step 4: Implement/extend per-media result validation**

Require each ordered mention to appear exactly once in the structured responsibility list. Preserve the existing role, inheritance, conflict, and usable-elements fields. Mark incomplete model output as a visible retryable error.

- [ ] **Step 5: Run focused reverse tests and then the full domain reverse suite**

Expected: new tests and all existing reverse-agent tests PASS.

### Task 4: Make `@` editing caret-safe and independently scrollable

**Files:**
- Modify: `apps/renderer/src/mentions/MediaMentionTextarea.tsx`
- Modify: `apps/renderer/src/mentions/MediaMentionTextarea.test.tsx`
- Modify: `apps/renderer/src/canvas/ModuleNodeCard.tsx`
- Modify: `apps/renderer/src/canvas/ModuleNodeCard.test.tsx`
- Modify: `apps/renderer/src/styles/figma-hybrid-canvas.css`

**Interfaces:**
- Consumes the existing canonical mention parser and connected media list.
- Produces an active mention anchored to the current editor/caret, replacement of only that mention, and a fixed-height editor with internal wheel scrolling.

- [ ] **Step 1: Write failing tests**

Cover `@` before an existing chip, `@` between chips, punctuation immediately after `@`, no-match prose after `@`, and wheel events that must not reach a parent canvas handler. Assert the selected token replaces the active mention only.

- [ ] **Step 2: Run tests and confirm failure**

Run the two focused test files. Expected: the pre-existing-chip and wheel cases fail before implementation.

- [ ] **Step 3: Implement caret-aware mention state**

Track the canonical caret range from the contenteditable surface when emitting changes. Determine the unresolved mention nearest the caret, not the final mention in the whole string. Keep the picker open for unmatched prose and use connected media as the fallback candidate list.

- [ ] **Step 4: Implement scroll isolation**

Give the reverse task editor a fixed visual height with `overflow-y: auto`, `overscroll-behavior: contain`, and a wheel handler that stops propagation without preventing the editor’s native scroll.

- [ ] **Step 5: Run all mention and node tests**

Expected: all `MediaMentionTextarea` and `ModuleNodeCard` tests PASS, including existing chip deletion and paste behavior.

### Task 5: Audit previously reported UI and performance regressions

**Files:**
- Inspect/modify: `apps/renderer/src/canvas/QuickInsert.tsx`
- Inspect/modify: `apps/renderer/src/canvas/CanvasWorkspace.tsx`
- Inspect/modify: `apps/renderer/src/canvas/ModuleNodeCard.tsx`
- Inspect/modify: `apps/renderer/src/styles/app.css`
- Inspect/modify: `apps/renderer/src/styles/figma-hybrid-canvas.css`
- Modify/add focused tests under `apps/renderer/src/canvas/` and `tests/e2e/`

**Interfaces:**
- Consumes the existing node, selection, mini-map, paste, and visibility-culling contracts.
- Produces no new user-facing API; it hardens existing behavior with explicit regression assertions.

- [ ] **Step 1: Reproduce each reported issue in tests**

Add or update tests for direct Ctrl+C/Ctrl+V media replacement, no duplicate plus buttons, aligned generation/video control rails, node-boundary containment, mini-map navigation, 20+ image responsiveness, video node interaction, and Quick Insert pointer/wheel behavior.

- [ ] **Step 2: Run the focused regression set and record failures**

Run the existing canvas, module, mention, and visual-layout suites. Group failures by root cause; do not patch screenshots without a behavior assertion.

- [ ] **Step 3: Apply one root-cause fix per group**

Keep React Flow event guards on interactive controls, use one canonical asset replacement path for paste, preserve the thresholded visibility culling, and keep generation rails inside their node geometry. Do not add duplicate UI controls as a workaround.

- [ ] **Step 4: Run focused regression tests and visual checks**

Expected: all grouped tests pass and no node control is outside its card at the supported zoom levels.

### Task 6: Full verification and installer

**Files:**
- No intentional source changes; generated output only under `apps/desktop-modern/dist-builder/desktop-modern/`

- [ ] **Step 1: Run the related test suites**

```powershell
npm.cmd exec vitest -- --config vitest.config.ts apps/renderer/src/canvas/ModuleNodeCard.test.tsx apps/renderer/src/canvas/CanvasWorkspace.test.tsx apps/renderer/src/mentions/MediaMentionTextarea.test.tsx packages/domain/src/reverse-prompt-agent.test.ts --run
```

- [ ] **Step 2: Run production build**

```powershell
npm.cmd run build
```

Expected: typecheck and all workspace builds succeed. Existing chunk-size/deprecation warnings may remain, but no errors are acceptable.

- [ ] **Step 3: Build NSIS installer**

```powershell
Set-Location apps/desktop-modern
npm.cmd exec electron-builder -- --win nsis --config electron-builder.yml
```

- [ ] **Step 4: Verify installer metadata**

Record the absolute installer path, byte size, timestamp, and SHA256. Do not delete older installers or any existing uncommitted artifact.

- [ ] **Step 5: Final acceptance report**

Report the tests passed, the reverse per-image payload guarantee, the batch connection order, any intentionally unchanged legacy behavior, and the installer link/hash.

