# Canvas Atelier Full Acceptance Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repair the reported media-node, provider-routing, connection, and save/exit regressions, then produce a fresh installer only after full source, build, packaged, and legacy-project acceptance passes.

**Architecture:** Keep the existing React/Zustand/Electron boundaries. Make the visible media rail single-source-of-truth in `ModuleNodeCard`, make the terminal CSS contract apply to the actual expanded runtime without contradictory rules, keep provider route filtering in `provider-profiles`, and make close-flush ACKs read post-save store state. Add regression coverage at component, store, and installed-package boundaries rather than relying on stylesheet text alone.

**Tech Stack:** React 19, TypeScript, Zustand, Electron 43, Vite, Vitest, React Testing Library, Playwright, Electron Builder NSIS.

## Global Constraints

- Preserve every unrelated modification and untracked QA asset in the dirty linked worktree.
- Do not read or expose real provider credentials.
- Do not trigger paid RelayMe generation; validate catalogs, request guards, routing, and persistence only.
- Do not overwrite the user's production Canvas Atelier data; all installed-runtime tests use a copied or temporary data root.
- Do not call an installer complete while any required test is skipped, blocked, or based only on historical output.
- Visible image/video generation controls use one 38px height; video has five visible participants: model, mode, settings, duration, generate.

---

### Task 1: Establish failing regressions for the reported runtime symptoms

**Files:**
- Modify: `apps/renderer/src/canvas/ModuleNodeCard.test.tsx`
- Modify: `apps/renderer/src/styles/release-layout-contract.test.ts`
- Modify: `apps/renderer/src/main.styles.test.ts`
- Modify: `apps/renderer/src/app/App.test.tsx`

**Interfaces:**
- Consumes existing `ModuleNodeCard`, close-flush listener, and stylesheet loaders.
- Produces failing assertions for duplicate visible model controls, forbidden video utility actions, computed-height contract, and post-save error-code propagation.

- [ ] **Step 1: Add component assertions before production edits**

Assert that a rendered image generation rail has exactly one visible model trigger and no visible native model select, and that a video rail does not render `视频脚本`, `翻译提示词`, or `视频高级设置`. Keep hidden compatibility controls explicitly excluded from the visible participant query.

- [ ] **Step 2: Add close ACK regression before production edits**

Extend the failed-close test so the mocked commit returns `INVALID_REQUEST` and the completed ACK must include `{ errorCode: 'INVALID_REQUEST' }` after the store changes asynchronously.

- [ ] **Step 3: Add terminal CSS assertions before production edits**

Assert that the last applicable expanded image/video rules use 38px rows and controls, contain exactly five video columns, and do not reintroduce a later 30px expanded media rule.

- [ ] **Step 4: Run only the new tests and confirm RED**

Run:

```powershell
npm.cmd exec vitest -- --config vitest.config.ts apps/renderer/src/canvas/ModuleNodeCard.test.tsx apps/renderer/src/styles/release-layout-contract.test.ts apps/renderer/src/main.styles.test.ts apps/renderer/src/app/App.test.tsx --run
```

Expected: the new assertions fail for the current duplicate controls, utility buttons, conflicting 30px contract, and stale ACK state.

### Task 2: Remove forbidden controls and make model selection single-source

**Files:**
- Modify: `apps/renderer/src/canvas/ModuleNodeCard.tsx`
- Modify: `apps/renderer/src/canvas/ModuleNodeCard.test.tsx`

**Interfaces:**
- `GenerationModelPicker` continues to accept provider routes and `onChange`.
- The visible DOM exposes one model trigger per generation rail; native state compatibility, if retained, is hidden and not a second visible control.

- [ ] **Step 1: Delete the three unused video utility buttons**

Remove the `module-node__video-utility-actions` block and its icon imports. Do not replace it with another visible text control.

- [ ] **Step 2: Make the custom model trigger the only visible model control**

Retain the native select only as an accessibility/state bridge if existing consumers require it, but mark it non-visible and ensure the trigger is the sole visible hit target. Keep route changes synchronized in both directions.

- [ ] **Step 3: Run component regressions and confirm GREEN**

Run:

```powershell
npm.cmd exec vitest -- --config vitest.config.ts apps/renderer/src/canvas/ModuleNodeCard.test.tsx --run
```

Expected: component tests pass, including exact visible participant counts and no forbidden utility actions.

### Task 3: Collapse conflicting media CSS into one runtime contract

**Files:**
- Modify: `apps/renderer/src/styles/figma-hybrid-canvas.css`
- Modify: `apps/renderer/src/styles/release-layout-contract.css`
- Modify: `apps/renderer/src/styles/release-layout-contract.test.ts`
- Modify: `apps/renderer/src/main.styles.test.ts`

**Interfaces:**
- Runtime selectors target `.workspace--ui-gate` expanded image/video nodes and their actual classes.
- Visible controls and wrappers resolve to 38px; video fallback selects are clipped/removed from layout; video grid has five visible columns.

- [ ] **Step 1: Remove or override every later expanded 30px media rule**

Make the terminal expanded selectors use equal-or-greater specificity than the legacy `:has(...)` selectors, set `grid-template-rows: 38px`, `height/min-height/max-height: 38px` for the rail and visible children, and preserve the 60px outer rail only where the existing bottom-anchor contract requires it.

- [ ] **Step 2: Set five video columns and hide fallback controls from layout**

Use columns for model, mode, settings, duration, and generate. Set `.module-node__video-fallback-control` to clipped/non-participating layout and ensure utility-action selectors are absent because the elements are removed.

- [ ] **Step 3: Run stylesheet regressions and confirm GREEN**

Run:

```powershell
npm.cmd exec vitest -- --config vitest.config.ts apps/renderer/src/styles/release-layout-contract.test.ts apps/renderer/src/main.styles.test.ts --run
```

Expected: all terminal-contract assertions pass without accepting contradictory 30px rules.

### Task 4: Fix close-flush error propagation and preserve recovery choices

**Files:**
- Modify: `apps/renderer/src/app/App.tsx`
- Modify: `apps/renderer/src/app/App.test.tsx`
- Modify: `apps/renderer/src/app/app-store.test.ts`

**Interfaces:**
- `closePersistence(): Promise<boolean>` remains unchanged.
- Completed renderer ACK uses a fresh `useAppStore.getState()` read after awaiting close persistence.
- Main-process recovery dialog continues to offer cancel/discard and displays the propagated sanitized error code.

- [ ] **Step 1: Change the ACK to read post-save state**

After `await state.closePersistence()`, read `const completedState = useAppStore.getState()` and use `completedState.saveErrorCode` in the completed ACK. Do not weaken the refusal-to-close-on-failed-save behavior.

- [ ] **Step 2: Run App and app-store regressions**

Run:

```powershell
npm.cmd exec vitest -- --config vitest.config.ts apps/renderer/src/app/App.test.tsx apps/renderer/src/app/app-store.test.ts --run
```

Expected: failed saves remain blocked, retries can succeed, and failed close ACKs contain the real sanitized code.

### Task 5: Verify provider routing and legacy media connections

**Files:**
- Modify: `apps/renderer/src/app/provider-profiles.test.ts`
- Modify: `apps/renderer/src/canvas/ConnectedAgentMediaSlots.test.tsx`
- Modify: `tests/e2e/generation-parameter-adaptation.spec.ts`
- Modify: `tests/e2e/release-ui-audit.spec.ts`
- Create: `work/qa-installed-legacy-project-acceptance.mjs`

**Interfaces:**
- `buildCanvasProviderRouteSets(profiles, reverseProfiles)` keeps generation and reverse catalogs separate.
- Installed QA script copies a real old project into a temporary user-data root and reports only sanitized state, DOM geometry, route labels, edge count, close/reopen outcome, and page errors.

- [ ] **Step 1: Add provider and media-slot regressions**

Assert that RelayMe reverse routes cannot be populated from the Comfly generation catalog when separate reverse profiles are supplied, and that connected image media remains represented in the reverse slot order after node reload.

- [ ] **Step 2: Add normal-runtime E2E assertions**

Assert computed heights, visible model-trigger count, absence of forbidden utility controls, image-source-to-generation connection, and reverse route labels in the normal app path, not only the UI gate harness.

- [ ] **Step 3: Run focused provider/media tests**

Run:

```powershell
npm.cmd exec vitest -- --config vitest.config.ts apps/renderer/src/app/provider-profiles.test.ts apps/renderer/src/canvas/ConnectedAgentMediaSlots.test.tsx --run
```

Expected: all routing and media-slot tests pass.

- [ ] **Step 4: Run installed legacy acceptance without paid generation**

Run the new script against the freshly built installed executable and a copied old project. It must validate open, route/catalog separation, image connection, save/close/reopen, and sanitized page errors. Any network-unavailable provider result is reported as an external gate and does not trigger a paid retry.

### Task 6: Full source verification and package production

**Files:**
- Modify: `docs/project-memory.md`
- No unrelated source edits.

- [ ] **Step 1: Run focused regression bundle**

Run all focused suites from Tasks 1-5 and record exact pass/skip counts.

- [ ] **Step 2: Run complete Vitest**

Run:

```powershell
npm.cmd test -- --run
```

Expected: zero failures; any designed performance skips are listed explicitly.

- [ ] **Step 3: Run typecheck and production build**

Run:

```powershell
npm.cmd run typecheck
npm.cmd run build
```

Expected: both exit 0 with no source or packaging errors.

- [ ] **Step 4: Build fresh NSIS installer**

Run the repository's desktop packaging command with publishing disabled. Verify `latest.yml`, installer size, SHA-256/SHA-512, and matching installed `app.asar`/renderer hashes.

- [ ] **Step 5: Install into isolated QA data and run packaged acceptance**

Launch the fresh executable with temporary user-data, run normal startup, media geometry, model route, legacy project, save-failure recovery, close, and reopen checks. Confirm no project-owned process remains.

- [ ] **Step 6: Update project memory with root cause and evidence**

Append the exact fixes, test commands, artifact hash, and any remaining external blockers to `docs/project-memory.md`. Do not claim completion if any required gate is unresolved.
