# Desktop Bridge, Project, Provider, and Generation Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the packaged desktop bridge so project persistence, provider credentials/models, single-click close, and fixed-shell 1–4 grid image/video nodes work in the installed application.

**Architecture:** Keep Electron sandboxing and context isolation enabled, but emit sandbox-compatible CommonJS preload artifacts. Treat the preload bridge as the shared root dependency, then verify project/provider/lifecycle behavior through the real bridge. Keep generation result count as presentation state inside one fixed node shell.

**Tech Stack:** Electron 43, TypeScript, React 19, Zustand, Vitest, Playwright, electron-builder/NSIS.

## Global Constraints

- Keep `sandbox: true`, `contextIsolation: true`, and `nodeIntegration: false`.
- Preserve user project and credential data; do not delete application data during migration or reinstall.
- Comfly and RelayMe each use their own hidden key.
- Image and video output count is 1–4; default is 1.
- Empty, single-result, and multi-result generation nodes keep the same outer dimensions and port positions.

---

### Task 1: Sandbox-compatible preload build

**Files:**
- Modify: `apps/desktop-modern/package.json`
- Modify: `apps/desktop-legacy/package.json`
- Modify: `apps/desktop-modern/src/runtime-entry-contract.test.ts`
- Test: `apps/desktop-modern/src/runtime-entry-contract.test.ts`

**Interfaces:**
- Produces: `dist/preload.js` and `dist/safe-preload.js` executable by Electron sandbox preload.
- Preserves: `window.novusDesktop` contract from `packages/desktop-core/src/preload-api.ts`.

- [ ] Add a failing artifact test that builds both desktop shells and asserts neither preload begins with an ESM `import` statement.
- [ ] Run `npm.cmd test -- apps/desktop-modern/src/runtime-entry-contract.test.ts` and confirm the new assertion fails against the current ESM output.
- [ ] Change both preload and safe-preload esbuild commands from `--format=esm` to `--format=cjs` while keeping the `.js` filenames used by `main.ts`.
- [ ] Re-run the focused test and both desktop typechecks.

### Task 2: Packaged bridge health and one-click close

**Files:**
- Modify: `apps/desktop-modern/src/main.ts`
- Modify: `apps/renderer/src/app/App.tsx`
- Modify: `apps/renderer/src/app/App.test.tsx`
- Modify: `packages/desktop-core/src/renderer-close-flush.ts`
- Modify: `packages/desktop-core/src/renderer-close-flush.test.ts`
- Create: `tests/e2e/packaged-desktop-bridge.spec.ts`

**Interfaces:**
- Consumes: `window.novusDesktop.lifecycle.onCloseFlushRequest` and `ackCloseFlush`.
- Produces: one in-flight close request and one terminal ACK per window close action.

- [ ] Add failing tests for duplicate close events: a second request while one is active must reuse the active promise and must not open a second dialog.
- [ ] Add a packaged bridge smoke assertion covering `projects`, `recentProjects`, `providers`, and `lifecycle` API presence.
- [ ] Implement idempotent close coordination and renderer-side request de-duplication keyed by `requestId`.
- [ ] Run focused lifecycle tests and the packaged bridge smoke test.

### Task 3: Explicit save and recent-project refresh

**Files:**
- Modify: `apps/renderer/src/app/app-store.ts`
- Modify: `apps/renderer/src/app/app-store.test.ts`
- Modify: `apps/renderer/src/canvas/ProjectManagerPopover.tsx`
- Modify: `apps/renderer/src/canvas/ProjectManagerPopover.test.tsx`
- Modify: `packages/desktop-core/src/recent-project-store.ts`
- Modify: `packages/desktop-core/src/recent-project-store.test.ts`
- Modify: `tests/e2e/project-save-manager.spec.ts`

**Interfaces:**
- Produces: successful `saveProjectExplicitly()` followed by a recent-project list refresh event.
- Preserves: `newProject()` does not modify the recent project index.

- [ ] Add failing tests proving a saved untitled project appears immediately, persists across a new project, and reopens with nodes, edges, media references, prompts, and results.
- [ ] Add a failing test proving save failure returns a visible Chinese error and does not pretend success.
- [ ] Refresh `recentProjects.list()` after successful explicit save and after opening/relocating a project.
- [ ] Add safe discovery of recognizable prior user-data project indexes without overwriting the current index.
- [ ] Run store, popover, recent-project, and Playwright save-manager tests.

### Task 4: Provider credential persistence and model discovery

**Files:**
- Modify: `apps/renderer/src/settings/SettingsDrawer.tsx`
- Modify: `apps/renderer/src/settings/SettingsDrawer.test.tsx`
- Modify: `apps/renderer/src/settings/ProviderModelCatalog.tsx`
- Modify: `apps/renderer/src/settings/ProviderModelCatalog.test.tsx`
- Modify: `packages/desktop-core/src/provider-ipc-handlers.ts`
- Modify: `packages/desktop-core/src/provider-bridge.test.ts`
- Modify: `tests/e2e/multi-provider-models.spec.ts`

**Interfaces:**
- Consumes: provider-scoped `saveCredential`, `testConnection`, and `listModels` bridge calls.
- Produces: categorized, deduplicated model choices for image, video, chat, reverse, vision, and video understanding.

- [ ] Add failing tests that save different Comfly and RelayMe keys and verify each provider calls only its own credential route.
- [ ] Add failing UI tests for successful save, authentication failure, network failure, and empty catalog states.
- [ ] After credential save, run connection detection and refresh only that provider's catalog.
- [ ] Deduplicate equal display models while retaining the provider route internally; show only model names in node controls.
- [ ] Replace the six oversized capability cards with a compact grouped model list, one shared empty state, and visible configure/retry actions.
- [ ] Run provider bridge, settings, catalog, and multi-provider Playwright tests.

### Task 5: Fixed-shell image/video generation nodes

**Files:**
- Modify: `apps/renderer/src/canvas/ModuleNodeCard.tsx`
- Modify: `apps/renderer/src/canvas/ModuleNodeCard.test.tsx`
- Modify: `apps/renderer/src/canvas/video-generation-results.ts`
- Modify: `apps/renderer/src/canvas/video-generation-results.test.ts`
- Modify: `apps/renderer/src/styles/figma-hybrid-canvas.css`
- Modify: `apps/renderer/src/main.styles.test.ts`
- Modify: `tests/e2e/generation-parameter-adaptation.spec.ts`
- Modify: `tests/e2e/video-generation-ui.spec.ts`

**Interfaces:**
- Consumes: generation output count `1 | 2 | 3 | 4` and ordered image/video result arrays.
- Produces: fixed-size empty/1/2/3/4-result shell with attached editor and stable ports.

- [ ] Add failing component tests for empty, 1, 2, 3, and 4 image/video results with invariant outer dimensions and port positions.
- [ ] Add failing tests that the empty state contains only the compact icon, not the large preview panel.
- [ ] Render one fixed preview stage: one result fills it, two results use two cells, three use a balanced three-cell layout, four use a 2×2 grid.
- [ ] Keep the connected-media thumbnail tray above the prompt and the editor attached directly below the selected node.
- [ ] Keep the unified parameter order: model, AUTO ratio, resolution, quantity, generate/stop.
- [ ] Run focused component/style tests and image/video Playwright screenshots in light and dark themes.

### Task 6: Full verification, package, and reinstall

**Files:**
- Verify: all modified files above
- Output: `apps/desktop-modern/dist-builder/desktop-modern/CanvasAtelier-Win10-11-x64-0.0.0.exe`

- [ ] Run `npm.cmd test` and require zero failures.
- [ ] Run `npm.cmd run perf:persistence` and `npm.cmd run perf:knowledge`.
- [ ] Run `npm.cmd run build` and require exit code 0.
- [ ] Run the focused Playwright acceptance suite for packaged bridge, project save, provider models, generation nodes, and close behavior.
- [ ] Build the NSIS installer with `npm.cmd exec electron-builder -- --win nsis` from `apps/desktop-modern`.
- [ ] Install visibly, verify the installed executable exposes the bridge, and provide the installer path plus light/dark screenshots.
