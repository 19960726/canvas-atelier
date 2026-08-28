# Settings Action Button Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Display the connection check, update check, and local refresh button icons beside their labels using the current settings-page visual system.

**Architecture:** Extend the terminal settings-button CSS contract rather than changing component markup or older style layers. Protect the cascade contract with the existing source-level `SettingsDrawer` style regression test.

**Tech Stack:** React 19, TypeScript, CSS, Vitest, Testing Library, Vite, Electron.

## Global Constraints

- Do not change button position, width, copy, event handlers, or surrounding layout.
- Preserve all pre-existing dirty workspace changes.
- Do not submit paid model generation jobs during functional verification.

---

### Task 1: Lock and repair horizontal button content

**Files:**
- Modify: `apps/renderer/src/settings/SettingsDrawer.test.tsx`
- Modify: `apps/renderer/src/styles/release-layout-contract.css`

**Interfaces:**
- Consumes: `.settings-update-action`, `.settings-connection-check`, and `.settings-storage-refresh` classes already emitted by `SettingsDrawer.tsx`.
- Produces: a terminal CSS rule forcing row direction and a non-shrinking direct SVG icon.

- [ ] **Step 1: Write the failing regression assertions**

Add expectations for `flex-direction: row !important` and a direct-child SVG contract containing `flex: 0 0 auto !important` to the existing final settings-button contract test.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm.cmd exec vitest -- --config vitest.config.ts apps/renderer/src/settings/SettingsDrawer.test.tsx --run`

Expected: the final settings-button contract test fails because the horizontal direction and SVG flex rule are absent.

- [ ] **Step 3: Add the minimal terminal CSS contract**

Add `flex-direction: row !important` to the existing shared action selector and add a matching direct SVG selector with `flex: 0 0 auto !important`.

- [ ] **Step 4: Verify GREEN and the renderer build**

Run the focused `SettingsDrawer` test, renderer typecheck, and renderer production build. Expected: all exit 0.

- [ ] **Step 5: Capture the real UI**

Launch the Electron shell with isolated temporary data, open the settings sync/diagnostics area, capture a screenshot showing all three repaired buttons, inspect it, close the app, and remove the temporary profile.

- [ ] **Step 6: Record verification**

Append exact test/build/screenshot evidence to `docs/project-memory.md`. Do not commit because the shared worktree already contains unrelated uncommitted project work.

