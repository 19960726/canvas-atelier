# Canvas Atelier Installed Full Acceptance Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the installed 1.6.90 media-rail, Reverse Agent naming, save/recovery, and CanvasForge coexistence regressions, then produce a new installer only after installed-app acceptance passes.

**Architecture:** Keep the current React/Zustand/Electron/project-repository layers, but remove duplicated renderer naming and media-rail styling ownership. Preserve the repository's durable project format while exposing precise save/recovery states, and move Canvas Atelier's mutable MCP runtime under its own user-data root. An installed-runtime acceptance harness uses isolated project copies and current-run screenshots so package startup, visual state, persistence, and coexistence are proven separately.

**Tech Stack:** TypeScript, React 19, Zustand, React Flow, Electron 43, Vite, Vitest, React Testing Library, Playwright Electron, Electron Builder NSIS, PowerShell.

## Global Constraints

- Work only in `E:\画布项目\staging-canvas-build`; preserve every unrelated tracked and untracked change.
- Keep CanvasForge 1.8.2 installed and able to run simultaneously with Canvas Atelier.
- Do not read, print, modify, migrate, or delete real provider credentials or user projects.
- Installed acceptance uses `canvasforge-qa-*` temporary data roots and copied project data only.
- The user authorizes one minimal-cost real image generation and one minimal-cost real video generation against the final installed candidate. Do not expand the count without a proven retry requirement.
- Every production change starts with a regression that fails for the expected current behavior.
- Source tests, browser E2E, packaged smoke, installed-app behavior, provider behavior, and machine integrations are separate evidence rows.
- Do not produce or hand off a formal installer while any required local row is failed or blocked.

---

### Task 1: Capture The 1.6.90 Installed Baseline

**Files:**
- Create: `work/qa-installed-full-acceptance.mjs`
- Create at runtime: `work/qa-installed-full-acceptance-1.6.90/`

**Interfaces:**
- Consumes: installed executable path, `CANVASFORGE_QA_MODE=1`, `CANVASFORGE_QA_USER_DATA_ROOT`, and an isolated copied project.
- Produces: `result.json`, `01-canvas.png`, `02-image-node.png`, `03-video-node.png`, `04-reverse-node.png`, and sanitized page/console errors.

- [ ] **Step 1: Implement an isolated Electron capture harness**

Use `_electron.launch` with this environment and reject any data root outside a `canvasforge-qa-*` directory:

```js
const env = {
  ...process.env,
  CANVASFORGE_QA_MODE: '1',
  CANVASFORGE_QA_USER_DATA_ROOT: qaRoot,
  CANVASFORGE_QA_HIDDEN: '1',
};
const app = await electron.launch({ executablePath, env });
```

Capture the visible node states after creating one image-generation, one video-generation, and one Reverse Agent node. Store only DOM geometry, computed border/background values, visible labels, save-state text, app version, and page errors.

- [ ] **Step 2: Add hard baseline assertions for the reported failures**

The 1.6.90 baseline must report:

```js
assert.equal(reverse.title, '反推anget');
assert.ok(imageRail.visibleBorderLayers > 1);
assert.ok(videoRail.visibleBorderLayers > 1);
```

Save these as reproduction evidence; do not treat the expected failing baseline as a release pass.

- [ ] **Step 3: Capture the installed save path**

In the isolated profile, create and edit a project, invoke the real Save command, close through the real close coordinator, relaunch, and report project id, revision, node count, prompt values, lock existence, clean-close state, and sanitized error code.

- [ ] **Step 4: Run the baseline harness**

Run:

```powershell
node work/qa-installed-full-acceptance.mjs --exe "D:\Canvas Atelier\Canvas Atelier.exe" --expect-version 1.6.90 --mode baseline
```

Expected: process exit 0 because all three known defects were captured, not because the candidate passed acceptance.

---

### Task 2: Make Module Definitions The Only Node-Name Source

**Files:**
- Modify: `apps/renderer/src/canvas/ModuleNodeCard.test.tsx`
- Modify: `apps/renderer/src/canvas/ModuleNodeCard.tsx`
- Modify: `packages/domain/src/formal-module-catalog.test.ts`

**Interfaces:**
- Consumes: `CanvasModuleDefinition.primaryName` and `.secondaryName`.
- Produces: card and workbench headings that exactly match the canonical module definition.

- [ ] **Step 1: Write the failing Reverse Agent naming regression**

Add a component test using the real module definition:

```tsx
it('uses the canonical Reverse Agent name in the card and workbench', () => {
  const node = createCanvasModuleNode('reverse-name', 'reverse_agent', { x: 0, y: 0 });
  renderModuleNode(node, { expandedNodeId: node.id });
  const definition = getCanvasModuleDefinition('reverse_agent');
  expect(screen.getByRole('strong', { name: definition.primaryName })).toBeVisible();
  expect(screen.getByLabelText(definition.primaryName)).toBeVisible();
  expect(document.body).not.toHaveTextContent(/反推anget/iu);
});
```

- [ ] **Step 2: Verify RED**

Run:

```powershell
npm.cmd exec vitest -- --config vitest.config.ts apps/renderer/src/canvas/ModuleNodeCard.test.tsx --run
```

Expected: FAIL because the current component renders `反推anget`.

- [ ] **Step 3: Remove renderer-owned names**

Delete `displayPrimaryName` and `displaySecondaryName`. Render `definition.primaryName` and `definition.secondaryName` directly. Pass the same canonical primary name to `ExecutableNodeWorkbench`.

- [ ] **Step 4: Add a production-source typo guard**

In the formal catalog test, scan renderer source files and reject `/anget/iu`. Keep the guard limited to production `.ts`/`.tsx` files so the regression test description does not trigger itself.

- [ ] **Step 5: Verify GREEN**

Run the component and formal catalog suites; expected zero failures.

- [ ] **Step 6: Commit the scoped naming repair**

```powershell
git add -- apps/renderer/src/canvas/ModuleNodeCard.tsx apps/renderer/src/canvas/ModuleNodeCard.test.tsx packages/domain/src/formal-module-catalog.test.ts
git commit -m "fix: use canonical reverse agent name"
```

---

### Task 3: Collapse Media Rails To One Visible Border Layer

**Files:**
- Modify: `apps/renderer/src/canvas/ModuleNodeCard.test.tsx`
- Modify: `apps/renderer/src/styles/release-layout-contract.test.ts`
- Modify: `apps/renderer/src/main.styles.test.ts`
- Modify: `apps/renderer/src/styles/release-layout-contract.css`
- Modify only if structural classes require it: `apps/renderer/src/canvas/ModuleNodeCard.tsx`

**Interfaces:**
- Consumes: `.module-node__generation-control-bar`, picker wrappers, visible triggers, parameter-popover triggers, and run action.
- Produces: one outer rail surface and one border per interactive control, without bordered wrapper nesting.

- [ ] **Step 1: Write failing structural tests**

For image and video rails, assert each picker contains exactly one visible trigger, that native selects have `aria-hidden` or an accessibility-only class, and that wrappers do not carry visible-surface classes.

- [ ] **Step 2: Write failing computed-style E2E assertions**

Evaluate the installed-equivalent rendered DOM:

```ts
const layers = await picker.evaluate((node) => {
  const chain = [node, node.firstElementChild].filter(Boolean);
  return chain.filter((item) => {
    const style = getComputedStyle(item);
    return parseFloat(style.borderTopWidth) > 0 && style.borderTopStyle !== 'none';
  }).length;
});
expect(layers).toBe(1);
```

Assert the five control bounding boxes share the same `y` and do not exceed the rail bounds.

- [ ] **Step 3: Verify RED**

Run:

```powershell
npm.cmd exec vitest -- --config vitest.config.ts apps/renderer/src/canvas/ModuleNodeCard.test.tsx apps/renderer/src/styles/release-layout-contract.test.ts apps/renderer/src/main.styles.test.ts --run
```

Expected: FAIL on the current nested visible borders or conflicting terminal selectors.

- [ ] **Step 4: Replace conflicting expanded media rules with one terminal contract**

Make picker wrappers layout-only:

```css
.workspace--ui-gate .module-node .module-node__generation-control-bar > :is(
  .module-node__video-model-picker,
  .module-node__video-mode-picker,
  .module-node__video-settings-picker
) {
  background: transparent !important;
  border: 0 !important;
  box-shadow: none !important;
  padding: 0 !important;
}
```

Keep the visible trigger as the only bordered child. Remove obsolete repeated expanded selectors rather than adding another contradictory EOF block. Preserve a 60px rail envelope and 38px interactive controls unless current visual measurement proves the reference requires a different value.

- [ ] **Step 5: Verify GREEN and inspect screenshots**

Run the focused suites, then capture image/video nodes at 1366x768, 1440x900, and 1920x1080 in light and dark themes. Reject screenshots with nested outlines, uneven baselines, clipped text, or overflow.

- [ ] **Step 6: Commit the scoped media-rail repair**

Commit only the media component/style/tests changed by this task.

---

### Task 4: Reproduce And Classify Installed Save Failures

**Files:**
- Modify: `work/qa-installed-full-acceptance.mjs`
- Create at runtime: isolated project copies under `work/qa-installed-save-*`

**Interfaces:**
- Consumes: real desktop bridge, copied project folders, lock and clean-close fixtures.
- Produces: a sanitized matrix for normal save, stale lock, active lock, revision conflict, write failure, close during save, and crash recovery.

- [ ] **Step 1: Add deterministic save scenarios**

Create separate isolated roots for:

```text
normal-save
stale-local-lock-dead-owner
active-local-lock-live-owner
revision-conflict
write-failure
close-during-save
unclean-restart
```

Each scenario records `projectId`, starting/ending revision, `saveStatus`, `saveErrorCode`, `recoveryRequired`, `canRetry`, `canReload`, lock state, clean-close state, and restored node/prompt counts.

- [ ] **Step 2: Reproduce the user's visible failure**

Run the scenarios against installed 1.6.90. The diagnostic must identify one concrete state transition that leaves the UI at save failure, or report that the screenshot symptom cannot be reproduced from the available copied state. Do not alter production code until a concrete failing case exists.

- [ ] **Step 3: Map the failing state to the owning layer**

Classify the first failure as repository lock ownership, bridge session/revision handling, renderer retry state, close coordinator, or UI presentation. Record the exact error code and event sequence in the QA result.

---

### Task 5: Repair Save, Lock, Retry, And Recovery Behavior

**Files:**
- Modify as proven by Task 4: `packages/desktop-core/src/project-repository.test.ts`
- Modify as proven by Task 4: `packages/desktop-core/src/project-repository.ts`
- Modify as proven by Task 4: `packages/desktop-core/src/bridge-contract.test.ts`
- Modify as proven by Task 4: `packages/desktop-core/src/bridge-handlers.ts`
- Modify as proven by Task 4: `apps/renderer/src/app/app-store.test.ts`
- Modify as proven by Task 4: `apps/renderer/src/app/app-store.ts`
- Modify: `apps/renderer/src/canvas/CanvasWorkspace.test.tsx`
- Modify: `apps/renderer/src/canvas/CanvasWorkspace.tsx`
- Modify if close path is implicated: `apps/desktop-modern/src/close-coordinator.test.ts`
- Modify if close path is implicated: `apps/desktop-modern/src/close-coordinator.ts`

**Interfaces:**
- Consumes: existing persistence error codes and project/session identity.
- Produces: accurate user-facing recovery actions without weakening concurrent-writer protection.

- [ ] **Step 1: Write one failing regression for each reproduced cause**

The test must assert the entire transition, for example:

```ts
expect(useAppStore.getState()).toMatchObject({
  saveStatus: 'error',
  saveErrorCode: 'REVISION_CONFLICT',
  canReloadDurableProject: true,
});
await useAppStore.getState().reloadDurableProject();
expect(useAppStore.getState()).toMatchObject({
  saveStatus: 'saved',
  saveErrorCode: null,
});
```

- [ ] **Step 2: Verify RED for the proven cause**

Run only the owning suite and confirm the failure is the reported bad transition, not test setup.

- [ ] **Step 3: Apply the smallest compatible repair**

Preserve these invariants:

- a live external writer remains read-only;
- a dead local stale owner can be reclaimed only after the injected process check confirms it is dead;
- a revision conflict never silently overwrites disk state;
- explicit retry reuses the exact failed request only when the project/session identity still matches;
- close does not destroy a failed-save session unless the user explicitly chooses discard.

- [ ] **Step 4: Present actionable save labels**

Extend `saveStatusLabel` so `CONCURRENT_WRITER`, `RECOVERY_REQUIRED`, `SAVE_TIMEOUT`, durable write failure, and revision conflict each explain the next available action. Keep the raw sanitized code available in an accessible status description.

- [ ] **Step 5: Verify GREEN and run the save matrix**

Run repository, bridge, store, workspace, App, and close-coordinator suites. Then run every installed save scenario against the rebuilt packaged app and require the expected recovery outcome.

- [ ] **Step 6: Commit the scoped persistence repair**

Commit only the proven save/recovery production and regression files.

---

### Task 6: Isolate Canvas Atelier MCP Runtime From CanvasForge

**Files:**
- Modify: `apps/desktop-modern/src/mcp-main-lifecycle-contract.test.ts`
- Modify: `apps/desktop-modern/src/main.ts`
- Modify: `work/qa-mcp-config-coexistence.mjs`
- Modify: `work/qa-live-mcp-node-roundtrip.mjs`
- Modify: `work/qa-cleanup-mcp-node.mjs`

**Interfaces:**
- Consumes: Canvas Atelier stable user-data root and existing `canvas_atelier` config key.
- Produces: `%APPDATA%\\Canvas Atelier\\mcp\\runtime-modern-v1.json`; preserves CanvasForge files and config entries unchanged.

- [ ] **Step 1: Write the failing runtime-path contract**

Require modern main source to contain:

```ts
join(app.getPath('userData'), 'mcp', 'runtime-modern-v1.json')
```

and reject modern writes under `join(app.getPath('appData'), 'CanvasForge', 'mcp', ...)`.

- [ ] **Step 2: Verify RED**

Run the lifecycle contract; expected FAIL because 1.6.90 writes to the legacy CanvasForge folder.

- [ ] **Step 3: Use one resolved modern runtime path**

Define one constant after the user-data path is finalized and pass it to both `createMcpRuntimeService` and `CANVASFORGE_MCP_RUNTIME_FILE`.

- [ ] **Step 4: Verify simultaneous coexistence**

Start CanvasForge and isolated Canvas Atelier concurrently. Assert both remain alive, their runtime files are different, the existing `canvasforge` client entry is byte-for-byte unchanged, and connect/disconnect only adds/removes `canvas_atelier`.

- [ ] **Step 5: Verify Codex and WorkBuddy configuration transactions**

For each client, cover first connect, repeated connect, route replacement, disconnect, malformed source config, write failure, backup creation, and temporary-file cleanup. Hash the unrelated configuration before and after and require it to remain byte-for-byte unchanged.

- [ ] **Step 6: Run installed MCP health and canvas roundtrip**

Against the installed candidate, require `state=running`, `rendererConnected=true`, the expected tool count, and matching app/server version. Through MCP, read the current canvas, create two safe local nodes, connect them, save, restart the installed app, and read the same nodes/edge back. Run the cleanup script through the same durable API and verify the original canvas state is restored. Reject any tool list containing arbitrary shell execution.

- [ ] **Step 7: Commit the scoped coexistence repair**

Commit only main lifecycle, coexistence script, and tests.

---

### Task 7: Expand Browser And Installed Node Acceptance

**Files:**
- Modify: `tests/e2e/release-ui-audit.spec.ts`
- Modify: `tests/e2e/generation-parameter-adaptation.spec.ts`
- Modify: `tests/e2e/project-save-manager.spec.ts`
- Modify: `work/qa-installed-full-acceptance.mjs`
- Create: `work/qa-installed-formal-module-catalog.mjs`

**Interfaces:**
- Consumes: E2E harness and installed app.
- Produces: separate image, video, Reverse Agent, and persistence result tables plus accepted screenshots.

- [ ] **Step 1: Add image-node state coverage**

Cover empty, editing, references connected, running, 1/2/3/4 results, failed, retry, collapsed, reopened, light/dark, and three desktop viewports. Assert one border layer and saved prompt/route/parameters.

- [ ] **Step 2: Add video-node state coverage**

Cover empty, editing, media connected, running, result, failed, stop/retry, collapsed/reopened, model constraints, one border layer, and five-control alignment. For an existing managed MP4, sample start, middle, and near-end playback positions and assert no media error.

- [ ] **Step 3: Add Reverse Agent state coverage**

Cover empty media, one/many ordered media, role/task, knowledge selection, route selection, running, success fixture, provider error fixture, interrupted retry, result editing, and reopen. Assert the exact canonical name and no provider fallback.

- [ ] **Step 4: Add visual inspection outputs**

Write each accepted installed screenshot under a versioned directory. Open every generated PNG after capture and reject blank, cropped, loading, or wrong-window frames.

- [ ] **Step 5: Cover the complete formal module catalog**

Enumerate `listCanvasModuleDefinitions()` through a generated fixture. For every formal node type, create the node, open and close it, inspect title/ports, attempt one valid connection when a compatible partner exists, reject an incompatible connection, save, restart, verify it persists, delete, and undo. Assert legacy aliases are absent from creation UI but migrate through domain tests.

- [ ] **Step 6: Cover whole-product workflows**

Run and record project create/open/recent-project, selection, pan/zoom, minimap, move/lock/delete, copy/paste, undo/redo, image/video import, clipboard, drag/drop, media ordering, generation history lifecycle, Agent task/mode/attachment/reference flows, settings/model catalog, cache controls, update check, Photoshop diagnostic boundary, theme, long text, and close/reopen.

- [ ] **Step 7: Run focused E2E**

Run the three modified specs with one worker. Expected: zero failures and no unexpected skips.

---

### Task 8: Version, Build, And Package The Candidate

**Files:**
- Modify: `apps/desktop-modern/package.json`
- Modify: `package-lock.json`
- Modify: `apps/desktop-modern/src/packaging-boundary.test.ts`
- Modify: `apps/desktop-modern/src/runtime-entry-contract.test.ts`

**Interfaces:**
- Produces: patch version `1.6.91` and `CanvasAtelier-Win10-11-x64-1.6.91.exe`.

- [ ] **Step 1: Advance all version contracts to 1.6.91**

Update desktop package metadata, lockfile workspace package version, installer filename assertions, and runtime version assertions together.

- [ ] **Step 2: Run focused release contracts**

```powershell
npm.cmd exec vitest -- --config vitest.config.ts apps/desktop-modern/src/packaging-boundary.test.ts apps/desktop-modern/src/runtime-entry-contract.test.ts --run
```

Expected: zero failures.

- [ ] **Step 3: Run complete deterministic verification**

```powershell
npm.cmd run scan:e2e
npm.cmd test -- --run
npm.cmd run typecheck
npm.cmd run build
npm.cmd run e2e
```

Record exact pass, skip, and failure counts. Designed performance skips remain explicit and do not prove performance; run the dedicated stress suites separately.

- [ ] **Step 4: Run performance verification**

Run the 300-node/500-edge stress and visual-layout suites at their supported viewports. Require the repository's stall and render-count thresholds.

- [ ] **Step 5: Run the complete formal-module and security scans**

Run the formal module catalog, MCP bridge/security, preload allowlist, secret-path scan, clipboard boundary, provider routing, recent-project, recovery, updater, Photoshop adapter, and media asset suites. Require zero unexpected skips and zero leaked credential/path findings.

- [ ] **Step 6: Build NSIS with publishing disabled**

```powershell
npx.cmd electron-builder --projectDir apps/desktop-modern --config electron-builder.yml --win nsis --x64 --publish never
```

Expected: installer, blockmap, `latest.yml`, and `win-unpacked` are all freshly generated from version 1.6.91.

- [ ] **Step 7: Record artifact identity**

Record size, LastWriteTime, SHA-256, Authenticode status, blockmap hash, `latest.yml` hash, and packaged `app.asar` version/hash.

---

### Task 9: Perform Final Installed Full Acceptance

**Files:**
- Create at runtime: `work/qa-installed-full-acceptance-1.6.91/`
- Modify: `docs/project-memory.md`

**Interfaces:**
- Consumes: exact 1.6.91 installer and isolated install/data roots.
- Produces: final installed-app evidence and installer handoff decision.

- [ ] **Step 1: Install the candidate to an isolated directory**

Use an explicit QA install directory that does not overwrite `D:\Canvas Atelier` or `D:\CanvasForge`. Verify the installed `app.asar` hash equals `win-unpacked` before launch.

- [ ] **Step 2: Run image, video, Reverse Agent, and persistence matrices**

Execute `work/qa-installed-full-acceptance.mjs` against the installed 1.6.91 EXE. Require all local rows to pass and generate current-run screenshots/result JSON.

- [ ] **Step 3: Run CanvasForge coexistence acceptance**

Keep the currently installed CanvasForge running, launch Canvas Atelier, and verify separate processes, separate user-data roots, separate MCP runtime files, preserved client config, and no cross-product project locks.

- [ ] **Step 4: Run installed full-function and formal-node acceptance**

Run every workflow and formal-module row from Task 7 through the installed EXE. Produce a machine-readable table with `passed`, `failed`, `blocked`, or `not_executed` for every row; absence of a row is a release failure.

- [ ] **Step 5: Run installed MCP configuration and roundtrip acceptance**

Execute both client configuration transactions, simultaneous CanvasForge coexistence, runtime health, durable canvas roundtrip, restart verification, and cleanup. Preserve hashes of all pre-existing config sections and user canvas state.

- [ ] **Step 6: Run one real installed image generation**

Use the configured active provider and the smallest supported output count/resolution. From the installed UI, enter a unique harmless prompt, click Generate once, wait through the provider's real terminal state, and record sanitized provider/model/task identity, elapsed time, output dimensions/type, managed asset id, node gallery state, page errors, and screenshots before/after completion. Save, close, relaunch, and require the same result asset and prompt to restore.

- [ ] **Step 7: Run one real installed video generation**

Use the configured active provider and the shortest/smallest supported video settings. From the installed UI, enter a unique harmless prompt, click Generate once, wait through the real terminal state, and record sanitized provider/model/task identity, elapsed time, MP4 asset id/type/size, node result state, and screenshots. Save, close, relaunch, then play and sample start, middle, and near-end `currentTime`, `readyState`, `duration`, and media error. Do not call a second paid task unless the first failure proves a repair regression and a retry is necessary.

- [ ] **Step 8: Compare the repaired screenshots with the reported references**

Inspect the image rail, video rail, and Reverse Agent captures at matching states. Confirm the visible defects are absent; DOM results alone are insufficient.

- [ ] **Step 9: Update durable project memory**

Append confirmed root causes, exact files, red/green tests, full command outputs, installed screenshot directory, artifact hashes, and every residual external boundary to `docs/project-memory.md`.

- [ ] **Step 10: Decide installer handoff**

Handoff is allowed only when all local required rows pass. If paid provider generation, Photoshop active-document import, signing, or remote release remain unexecuted, list them plainly as external/manual rows and do not describe them as passed.

---

## Final Self-Review Checklist

- [ ] Every requirement in the approved design maps to one task above.
- [ ] Every production edit has a test observed failing before the edit.
- [ ] Installed 1.6.90 baseline and installed 1.6.91 result use different versioned evidence directories.
- [ ] No formal user project or credential file was modified.
- [ ] No CanvasForge process or data directory was deleted.
- [ ] Image, video, Reverse Agent, persistence, and coexistence each have separate pass/fail tables.
- [ ] Whole-product functions, every formal module, and MCP configuration/runtime each have separate pass/fail tables.
- [ ] One real image generation and one real video generation include installed UI, provider terminal state, asset persistence, reopen, and playback evidence.
- [ ] The final claim names all skipped, blocked, manual, paid, external-service, signing, and machine-dependent rows.
