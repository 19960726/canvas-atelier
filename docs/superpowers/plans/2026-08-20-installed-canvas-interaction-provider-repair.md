# Installed Canvas Interaction and Provider Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the installed canvas delete selected nodes, open Quick Insert on a real blank-canvas double click, route Comfly generation through the selected live model, and use the RelayMe workflow host supplied by the user.

**Architecture:** Preserve React Flow draft state but move keyboard selection ownership into an explicit ref that is updated by selection events. Accept blank-canvas double clicks from the pane and its non-interactive renderer layers. Keep provider identity attached to every visible generation route, surface the real start error, and migrate only the obsolete RelayMe host toward `www.ml.relayme.uk`.

**Tech Stack:** React 19, React Flow, Zustand, Electron IPC, TypeScript, Vitest, Testing Library, electron-builder.

## Global Constraints

- Preserve unrelated dirty-worktree changes and project/user credential data.
- Do not read, log, or expose API keys.
- Do not submit a paid generation request without explicit user approval.
- Write a failing regression test before every production behavior change.

---

### Task 1: RelayMe workflow host migration

**Files:**
- Modify: `packages/provider-relayme/src/client.test.ts`
- Modify: `packages/provider-relayme/src/client.ts`
- Modify: `packages/desktop-core/src/relayme-provider-service.test.ts`
- Modify: `packages/desktop-core/src/relayme-provider-service.ts`
- Modify: `apps/renderer/src/settings/SettingsDrawer.test.tsx`
- Modify: `apps/renderer/src/settings/SettingsDrawer.tsx`

**Interfaces:**
- Consumes: persisted RelayMe provider configuration and settings reset action.
- Produces: canonical base URL `https://www.ml.relayme.uk/api/ai-tools/v1`, including migration from `api.relayme.ai`.

- [ ] Change tests to require the workflow host and verify they fail against the old default.
- [ ] Reverse the retired-host migration and update every default/reset value.
- [ ] Run RelayMe service, client, and settings tests.

### Task 2: Reliable selected-node deletion

**Files:**
- Modify: `apps/renderer/src/canvas/CanvasWorkspace.test.tsx`
- Modify: `apps/renderer/src/canvas/CanvasWorkspace.tsx`

**Interfaces:**
- Consumes: React Flow `onSelectionChange`, window `Delete`/`Backspace`, and editable-target protection.
- Produces: deletion of the latest selected node IDs when focus is on canvas chrome, without deleting while typing.

- [ ] Add a test selecting a node through React Flow and pressing Delete from canvas chrome; verify failure.
- [ ] Store current selection in a ref updated synchronously by `onSelectionChange` and use it in the key handler.
- [ ] Verify Delete and Backspace, including editable-target protection.

### Task 3: Real blank-canvas double click

**Files:**
- Modify: `apps/renderer/src/canvas/CanvasWorkspace.test.tsx`
- Modify: `apps/renderer/src/canvas/CanvasWorkspace.tsx`

**Interfaces:**
- Consumes: double clicks from React Flow pane, background, renderer, viewport, and selection layers.
- Produces: Quick Insert at the pointer while excluding nodes, edges, controls, minimap, dialogs, and menus.

- [ ] Add failing tests for the renderer/selection-layer targets seen in packaged Electron.
- [ ] Replace the pane-ancestor-only guard with an explicit blank-canvas target predicate.
- [ ] Re-run the canvas interaction suite.

### Task 4: Comfly generation routing and actionable errors

**Files:**
- Modify: `apps/renderer/src/app/provider-profiles.test.ts`
- Modify: `apps/renderer/src/app/provider-profiles.ts`
- Modify: `apps/renderer/src/app/app-store.test.ts`
- Modify: `apps/renderer/src/app/app-store.ts`
- Modify: `apps/renderer/src/canvas/ModuleNodeCard.test.tsx`
- Modify: `apps/renderer/src/canvas/ModuleNodeCard.tsx`

**Interfaces:**
- Consumes: visible model selection, provider/model route, configured provider catalog, generation-start exception.
- Produces: stable provider-qualified route selection and a sanitized specific start error instead of the generic fallback.

- [ ] Add regression tests reproducing a duplicate visible model across Comfly and RelayMe and a failed start.
- [ ] Keep the selected provider identity stable across catalog refreshes and route lookup.
- [ ] Preserve safe provider error codes/messages in the node feedback.
- [ ] Run provider profile, store, node-card, and desktop executor suites.

### Task 5: Verify and repackage

**Files:**
- Verify only; regenerate `CanvasAtelier-Win10-11-x64-1.6.38.exe` after all checks pass.

**Interfaces:**
- Consumes: Tasks 1-4.
- Produces: focused tests, full typecheck/build, new NSIS installer, SHA-256, and explicit live-API limits.

- [ ] Run focused regression suites.
- [ ] Run `npm.cmd run typecheck` and `npm.cmd run build`.
- [ ] Build NSIS with `npx.cmd electron-builder --projectDir apps/desktop-modern --config electron-builder.yml --win nsis --x64`.
- [ ] Copy the verified installer to `E:\画布项目` and report its hash.
