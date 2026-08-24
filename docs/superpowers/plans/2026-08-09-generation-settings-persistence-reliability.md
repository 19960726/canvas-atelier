# Generation Settings and Persistence Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make image/video parameter controls match the approved references and make model selection, credential saving, explicit project saving, and one-click close reliable.

**Architecture:** Introduce one reusable generation parameter popover used by both image and video nodes. Separate explicit user save from autosave flushing, add bounded provider operations with visible state, and route close through the Electron lifecycle bridge instead of raw browser close behavior.

**Tech Stack:** React 19, TypeScript, Zustand, Electron IPC, Vitest, Testing Library, Vite, electron-builder.

## Global Constraints

- Image and video generation use the same ratio and clarity control components.
- Ratio options are AUTO, 1:1, 2:3, 3:2, 3:4, 4:3, 9:16, and 16:9, filtered by model support.
- Clarity options are 1K, 2K, and 4K, filtered by model support.
- Provider names do not appear in generation model dropdown labels.
- API secrets remain confined to the Electron main process secure credential store.
- Explicit save must create an empty untitled project; cancellation and failure must be visible.
- One close click creates at most one close transaction.
- Preserve unrelated dirty worktree changes.

---

### Task 1: Shared Generation Parameter Popovers

**Files:**
- Create: `apps/renderer/src/canvas/GenerationParameterPopover.tsx`
- Create: `apps/renderer/src/canvas/GenerationParameterPopover.test.tsx`
- Modify: `apps/renderer/src/canvas/ModuleNodeCard.tsx`
- Modify: `apps/renderer/src/canvas/ModuleNodeCard.test.tsx`
- Modify: `apps/renderer/src/styles/figma-hybrid-canvas.css`

**Interfaces:**
- Produces: `AspectRatioPopover` and `ClarityPopover` controlled React components.
- Consumes: model-filtered option arrays already calculated by `ModuleNodeCard`.

- [ ] Write failing tests proving ratio opens as an in-node two-column list with icons, selection, and outside-click close.
- [ ] Write failing tests proving clarity opens as a single-column 1K/2K/4K list with selected check.
- [ ] Run focused tests and verify failures are caused by the current native selects/segmented controls.
- [ ] Implement controlled popover components with buttons, `aria-expanded`, keyboard Escape, and theme-token styling.
- [ ] Replace both image and video ratio/clarity controls with the shared components.
- [ ] Verify selected values reach image/video submit payloads unchanged.
- [ ] Run focused component and style tests.

### Task 2: Provider Settings and Model Selection

**Files:**
- Modify: `apps/renderer/src/settings/SettingsDrawer.tsx`
- Modify: `apps/renderer/src/settings/SettingsDrawer.test.tsx`
- Modify: `apps/renderer/src/settings/ProviderModelCatalog.tsx`
- Modify: `apps/renderer/src/settings/ProviderModelCatalog.test.tsx`
- Modify: `apps/renderer/src/styles/figma-hybrid-canvas.css`

**Interfaces:**
- Consumes: `window.novusDesktop.provider.getStatus/configure/checkConnection/listProfiles/updateProfiles`.
- Produces: compact provider status surface and persistent selectable default routes.

- [ ] Add failing tests for compact section ordering and usable model selectors after profile discovery.
- [ ] Add a failing test for selecting a model and persisting it through `updateProfiles`.
- [ ] Implement the compact provider/status/endpoint/credential/model layout.
- [ ] Keep model labels model-only and preserve capability-based grouping.
- [ ] Run settings and catalog tests.

### Task 3: Bounded Credential Save

**Files:**
- Create: `apps/renderer/src/settings/provider-operation-timeout.ts`
- Create: `apps/renderer/src/settings/provider-operation-timeout.test.ts`
- Modify: `apps/renderer/src/settings/SettingsDrawer.tsx`
- Modify: `apps/renderer/src/settings/SettingsDrawer.test.tsx`

**Interfaces:**
- Produces: `withProviderOperationTimeout<T>(operation, timeoutMs)`.
- Consumes: provider configure/check/list IPC promises.

- [ ] Add a failing test where `provider.configure()` never settles and the dialog shows a timeout error without losing input.
- [ ] Add a failing test that the submit button immediately changes to saving and blocks duplicate submissions.
- [ ] Implement a bounded credential save and verification sequence.
- [ ] On success close the dialog, refresh status/catalog, and emit the catalog-changed event.
- [ ] On error retain the dialog/input and show the actionable failure.
- [ ] Run settings tests.

### Task 4: Explicit Empty-Project Save

**Files:**
- Modify: `apps/renderer/src/app/app-store.ts`
- Modify: `apps/renderer/src/app/app-store.test.ts`
- Modify: `apps/renderer/src/app/workspace-api.ts`
- Modify: `apps/renderer/src/app/workspace-api.test.ts`
- Modify: `apps/renderer/src/canvas/CanvasWorkspace.tsx`
- Modify: `apps/renderer/src/canvas/CanvasWorkspace.test.tsx`

**Interfaces:**
- Produces: `saveProjectExplicitly(): Promise<boolean>` store action.
- Consumes: `ProjectPersistenceClient.stablePoint()` which creates the first desktop project session when none exists.

- [ ] Add a failing store test: empty untitled/saved state still calls `stablePoint()` and becomes durable.
- [ ] Add a failing workspace test for saving status and visible success/cancel/failure feedback.
- [ ] Implement explicit save independent of pending autosave state.
- [ ] Update workspace API and topbar button to call explicit save.
- [ ] Refresh `availableSnapshotIds`, lifecycle, revision, and save status after success.
- [ ] Run store, persistence, workspace API, and CanvasWorkspace tests.

### Task 5: Single-Click Desktop Close

**Files:**
- Modify: `packages/desktop-core/src/preload-api.ts`
- Modify: `packages/desktop-core/src/preload-api.test.ts`
- Modify: `apps/desktop-modern/src/preload.ts`
- Modify: `apps/desktop-legacy/src/preload.ts`
- Modify: `apps/desktop-modern/src/main.ts`
- Modify: `apps/desktop-legacy/src/main.ts`
- Modify: `apps/renderer/src/canvas/CanvasWorkspace.tsx`
- Modify: `apps/renderer/src/canvas/CanvasWorkspace.test.tsx`
- Modify: `packages/desktop-core/src/renderer-close-flush.test.ts`

**Interfaces:**
- Produces: `window.novusDesktop.lifecycle.requestClose(): void`.
- Consumes: existing `RendererCloseFlushCoordinator.requestClose()`.

- [ ] Add a failing preload contract test for the typed close request channel.
- [ ] Add a failing workspace test proving repeated button clicks send only one close request while closing.
- [ ] Wire renderer close action to the main-process coordinator instead of direct `window.close()`.
- [ ] Disable the button while a close request is active and restore it only after cancellation/failure.
- [ ] Verify clean, dirty-save, discard, cancel, timeout, and unavailable-renderer cases.
- [ ] Run lifecycle and desktop shell tests.

### Task 6: Full Verification and Packaging

**Files:**
- Modify only if verification exposes a scoped regression.
- Output: `apps/desktop-modern/dist-builder/desktop-modern/CanvasAtelier-Win10-11-x64-0.0.0.exe`

- [ ] Run focused tests for Tasks 1-5.
- [ ] Run the existing provider, persistence, renderer, bridge, and lifecycle regression suites.
- [ ] Run `npm.cmd run typecheck`.
- [ ] Run `npm.cmd run build`.
- [ ] Run `npx.cmd electron-builder --projectDir apps/desktop-modern --config electron-builder.yml --win nsis --x64`.
- [ ] Record installer size, timestamp, SHA-256, and signing status.
- [ ] Report live-provider validation limitations if no real API credential is available.