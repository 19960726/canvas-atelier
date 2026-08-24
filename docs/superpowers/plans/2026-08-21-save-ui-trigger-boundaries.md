# Save UI Trigger Boundaries Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure save-related windows and popovers appear only after explicit matching user actions.

**Architecture:** Keep the main save button and project-manager chevron as separate controls with isolated event handlers. Test unrelated canvas and model operations against save UI state, and retain the existing dirty-new-project confirmation as the only automatic in-app save decision.

**Tech Stack:** React, Testing Library, Electron dialog adapter, Vitest.

## Global Constraints

- Autosave and explicit main-button save do not open a dialog.
- Do not remove the unsaved-new-project confirmation.
- Native dialogs remain available for explicit import/export/diagnostic operations.

---

### Task 1: Lock down renderer save UI triggers

**Files:**
- Modify: `apps/renderer/src/canvas/CanvasWorkspace.test.tsx`
- Modify: `apps/renderer/src/canvas/CanvasWorkspace.tsx`

**Interfaces:**
- Consumes: `saveManagerOpen`, `newProjectConfirmationOpen`, `workspaceApi.save()`.
- Produces: explicit `openSaveManager`, `closeSaveManager`, and isolated main-save behavior if extraction is needed.

- [ ] **Step 1: Add failing interaction tests**

Assert main save calls save and does not show `ProjectManagerPopover`; chevron alone opens it; image/reverse job completion does not open it; canvas double-click and paste/drop do not open it; unsaved New Project opens only the confirmation.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `npm.cmd exec vitest -- --config vitest.config.ts apps/renderer/src/canvas/CanvasWorkspace.test.tsx --run`

- [ ] **Step 3: Isolate event handlers**

Stop propagation on the chevron and main button where necessary, close transient save manager state when unrelated canvas actions start, and never derive `saveManagerOpen` from save status or job status.

- [ ] **Step 4: Run renderer tests**

Run the Task 1 command and expect all tests to pass.

### Task 2: Lock down native save dialogs

**Files:**
- Modify: `apps/desktop-modern/src/runtime-entry-contract.test.ts`
- Modify: `packages/desktop-core/src/bridge-contract.test.ts`

**Interfaces:**
- Consumes: `createDialogAdapter`, desktop bridge save/create operations.
- Produces: a regression contract proving ordinary project save and model operations do not invoke `showSaveDialog`.

- [ ] **Step 1: Add failing contract assertions**

Assert normal managed-project creation/save uses the app-managed project root and does not call `chooseCreateProjectRoot`; assert only explicit import/export/diagnostic paths expose native save-dialog calls.

- [ ] **Step 2: Run focused tests**

Run: `npm.cmd exec vitest -- --config vitest.config.ts apps/desktop-modern/src/runtime-entry-contract.test.ts packages/desktop-core/src/bridge-contract.test.ts --run`

- [ ] **Step 3: Remove accidental native-dialog call paths if found**

Keep `showSaveDialog` only in named explicit adapter methods; normal save must call the repository with the managed project session/root.

- [ ] **Step 4: Re-run focused tests**

Run the Task 2 command and expect all tests to pass.
