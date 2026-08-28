# Settings Layered Workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Rework the API/model settings tab into a layered workbench with clear status, provider actions, model catalog controls, and diagnostics/update affordances.

**Architecture:** Keep `SettingsDrawer` as the stateful orchestration component and use semantic wrappers/classes for the four layers. Keep `ProviderModelCatalog` responsible for model grouping and selection. Add a small visual contract stylesheet at the end of `release-layout-contract.css` so late cascade rules protect the responsive layout.

**Tech Stack:** React, TypeScript, CSS, Vitest, Playwright, Electron packaging.

## Global Constraints

- Preserve provider behavior and existing accessible labels.
- Do not expose credentials in renderer state or project files.
- Preserve dirty worktree changes; do not reset unrelated files.
- Do not commit or publish until the user inspects the verified build.

---

### Task 1: Lock the layered layout contract with tests

**Files:**
- Modify: `apps/renderer/src/settings/SettingsDrawer.test.tsx`
- Modify: `apps/renderer/src/styles/release-layout-contract.test.ts`
- Modify: `tests/e2e/current-settings-ui.spec.ts`

- [ ] Add assertions for four API-tab layers and grouped primary/secondary actions.
- [ ] Run the focused tests and confirm the new assertions fail before implementation.

### Task 2: Implement the layered API/model settings markup

**Files:**
- Modify: `apps/renderer/src/settings/SettingsDrawer.tsx`
- Modify: `apps/renderer/src/settings/ProviderModelCatalog.tsx`

- [ ] Add stable layer classes and visible status summary without changing provider state transitions.
- [ ] Group connection, save, compatibility, and update actions with explicit primary/secondary semantics.
- [ ] Add chat-model adaptation copy that identifies the active conversation model route.

### Task 3: Implement responsive visual treatment

**Files:**
- Modify: `apps/renderer/src/styles/app.css`
- Modify: `apps/renderer/src/styles/release-layout-contract.css`

- [ ] Style the four layers with hierarchy, badges, spacing, focus states, and responsive action wrapping.
- [ ] Keep compatibility actions horizontal at desktop width and usable at narrow widths.
- [ ] Add reduced-motion-safe transitions only where existing tokens support them.

### Task 4: Verify UI and package only after inspection

**Files:**
- No source changes unless verification exposes a regression.

- [ ] Run targeted Vitest, full typecheck, and API settings E2E.
- [ ] Capture and inspect the settings screenshot at desktop and narrow viewport.
- [ ] Present the screenshot and verification evidence for user inspection.
- [ ] After approval, run production build/package and verify installer metadata and checksums.
- [ ] Publish only after explicit release approval.
