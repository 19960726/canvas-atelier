# Browser Acceptance Interactions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the manual browser canvas page exercise the same model, generation, storage, Agent, and connected-media interactions as the desktop UI while keeping native Electron behavior unchanged.

**Architecture:** Install a narrow browser-only acceptance bridge when `novusHarness=novus-e2e-codex-ui-gate` is present. Reuse the existing desktop bridge contracts and renderer stores, with in-memory provider/storage/media implementations. Keep the visual fixes in the existing Figma hybrid stylesheet and components, and add focused regression tests before each production change.

**Tech Stack:** React, TypeScript, Zustand, Vitest, Testing Library, Playwright, existing `@agent-canvas/desktop-core` bridge contracts, Figma hybrid CSS.

## Global Constraints

- Browser bridge is active only for the explicit manual acceptance query and never exposes a secret.
- Electron builds continue using the real `window.novusDesktop` preload bridge.
- Model selectors must show only routes compatible with the node capability.
- Image/video slot thumbnails use complete previews and preserve source aspect ratio.
- Light and dark themes must share geometry and centered labels/icons.
- Do not reset or clean unrelated dirty worktree changes.

---

### Task 1: Browser acceptance bridge for providers and storage

**Files:**
- Create: `apps/renderer/src/test-mode/manual-acceptance-bridge.ts`
- Modify: `apps/renderer/src/main.tsx`
- Modify: `apps/renderer/src/types/novus-desktop.d.ts`
- Test: `apps/renderer/src/test-mode/manual-acceptance-bridge.test.ts`

**Interfaces:**
- Produces `installManualAcceptanceBridge(): void`.
- Reads the existing `DesktopBridgeApi` contracts and returns non-secret sample provider profiles for chat, image, reverse, and video routes.
- Returns in-memory `CacheDirectoryState` for open/choose/reset actions.

- [ ] Write a failing test that installs the bridge in a browser-like window and asserts `provider.listProfiles()` returns at least one route for each capability and `storage.chooseCacheDirectory()` changes the displayed path.
- [ ] Run the focused Vitest test and verify it fails because the installer does not exist.
- [ ] Implement the narrow bridge with explicit `window.__NOVUS_MANUAL_ACCEPTANCE__` gating and no API key fields.
- [ ] Call the installer in `main.tsx` before `App` renders, after the query flag is set.
- [ ] Run the focused test and typecheck it.

### Task 2: Generation model and resolution selectors

**Files:**
- Modify: `apps/renderer/src/canvas/ModuleNodeCard.tsx`
- Modify: `apps/renderer/src/canvas/node-types.tsx`
- Test: `apps/renderer/src/canvas/ModuleNodeCard.test.tsx`
- Test: `tests/e2e/video-generation-ui.spec.ts`

**Interfaces:**
- Existing `imageGenerationRoutes` and `videoGenerationRoutes` remain the route source.
- Image resolution values remain `1K | 2K | 4K`; video route selection uses `videoGenerationRoutes`.

- [ ] Add failing component assertions that image resolution can change from `1K` to `2K`/`4K`, image model select is enabled with acceptance profiles, and video model select lists a selectable video route.
- [ ] Run the component test and verify the expected disabled/empty behavior fails.
- [ ] Wire acceptance provider profiles into node runtime context and ensure each select preserves the selected route on change.
- [ ] Add visible selected-value assertions for light and dark E2E states.
- [ ] Run focused component and E2E tests.

### Task 3: Storage and backup interactions

**Files:**
- Modify: `apps/renderer/src/settings/SettingsDrawer.tsx`
- Modify: `apps/renderer/src/styles/figma-hybrid-canvas.css`
- Test: `apps/renderer/src/settings/SettingsDrawer.test.tsx`
- Test: `tests/e2e/current-settings-ui.spec.ts`

**Interfaces:**
- Existing `SettingsStorageBridge` methods remain `getCacheDirectory`, `chooseCacheDirectory`, `resetCacheDirectory`, and `openCacheDirectory`.

- [ ] Add failing browser-mode assertions that refresh, open, choose, reset, and cleanup controls are enabled and expose status text.
- [ ] Run settings tests and verify they fail because the browser bridge is absent/controls disabled.
- [ ] Use the bridge from Task 1 without changing native desktop behavior; make busy/success/error state visible.
- [ ] Align button text/icon centering in both themes.
- [ ] Run focused settings tests and E2E states.

### Task 4: Agent composer controls

**Files:**
- Modify: `apps/renderer/src/agent/SkillChatWorkbench.tsx`
- Modify: `apps/renderer/src/styles/figma-hybrid-canvas.css`
- Test: `apps/renderer/src/agent/SkillChatWorkbench.test.tsx`
- Test: `tests/e2e/current-agent-knowledge-ui.spec.ts`

**Interfaces:**
- Existing `onImportReferenceImage`, model popover, knowledge popover, and composer submit form remain the public behavior.

- [ ] Add failing tests for plus-button import, actual model/knowledge popover opening, submit enablement after text entry, and no extra text node/counter under the send icon.
- [ ] Run tests and confirm the failure is caused by missing browser bridge or stale CSS content.
- [ ] Wire import through the existing managed image persistence path, ensure the acceptance bridge returns a thumbnail, and remove any generated `::after` content from submit.
- [ ] Keep knowledge/model buttons below the textarea and center all icon geometry.
- [ ] Run component and E2E tests in light/dark themes.

### Task 5: Connected media thumbnails

**Files:**
- Modify: `apps/renderer/src/canvas/ConnectedAgentMediaSlots.tsx`
- Modify: `apps/renderer/src/canvas/ModuleNodeCard.tsx`
- Modify: `apps/renderer/src/styles/app.css`
- Modify: `apps/renderer/src/styles/figma-hybrid-canvas.css`
- Test: `apps/renderer/src/canvas/ConnectedAgentMediaSlots.test.tsx`
- Test: `apps/renderer/src/canvas/ModuleNodeCard.test.tsx`
- Test: `tests/e2e/module-library-workflow.spec.ts`

**Interfaces:**
- `ConnectedAgentMediaSlotItem.previewUrl` is used for both image and video items.
- Video items render a poster/first-frame preview when a managed preview URL exists.

- [ ] Add failing assertions for complete image thumbnails (`object-fit: contain`), video poster thumbnails, and immediate connected slot rendering.
- [ ] Run focused tests and confirm current cover/fallback behavior fails the new assertions.
- [ ] Resolve image/video preview URLs from project asset summaries and render the shared 32px slot contract; keep drag reorder unchanged.
- [ ] Run focused component/E2E tests and capture a screenshot.

### Task 6: Full verification and manual handoff

**Files:**
- Modify: `tests/e2e/current-settings-ui.spec.ts` only if a regression assertion needs a stable locator.
- Create: `artifacts/2026-08-08-user-test-gate/acceptance-light.png`
- Create: `artifacts/2026-08-08-user-test-gate/acceptance-dark.png`

- [ ] Run `npm.cmd run typecheck` and record exit code 0.
- [ ] Run focused Vitest files for bridge, settings, Agent, ModuleNodeCard, and ConnectedAgentMediaSlots.
- [ ] Run Playwright module, settings, Agent, and video suites against the reusable acceptance server.
- [ ] Open `http://127.0.0.1:5173/` and capture blank startup plus the two theme screenshots.
- [ ] Re-check the manual checklist: model/resolution selection, storage actions, Agent import/send, connected image/video thumbnails, drag reorder, node dragging, and collapse behavior.
- [ ] Deliver the local link and clearly separate automated evidence from user manual acceptance.