# Figma Delivery UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the remaining delivery UI surfaces match the supplied Figma dark and light references without breaking desktop actions.

**Architecture:** Keep current bridge and store actions in their components, but replace legacy layout classes with semantic delivery-surface classes backed by theme tokens. Capture each final state through Playwright at the supplied 1440×900 desktop viewport.

**Tech Stack:** React, TypeScript, CSS custom properties, Vitest, Playwright.

## Global Constraints

- Retain existing user-facing desktop bridge action handlers.
- Use `data-theme` semantic tokens for every visual color.
- Do not create a release installer until visual audit screenshots and functional tests pass.

---

### Task 1: Correct shared dark/light delivery tokens

**Files:**
- Modify: `apps/renderer/src/styles/app.css`
- Test: `tests/e2e/release-ui-audit.spec.ts`

- [ ] Replace hard-coded drawer/overlay colors with `--surface-*`, `--text-*`, and `--border-*` tokens in both theme blocks.
- [ ] Verify the light canvas background, drawer cards, controls, and modal surfaces are visibly light at 1440×900.

### Task 2: Rebuild the settings delivery panel

**Files:**
- Modify: `apps/renderer/src/settings/SettingsDrawer.tsx`
- Modify: `apps/renderer/src/styles/app.css`
- Test: `apps/renderer/src/settings/SettingsDrawer.test.tsx`

- [ ] Preserve API, storage, guide, other/sync tab state and handlers.
- [ ] Render the 396px Figma panel header, four tabs, storage cards, and sync source choices.
- [ ] Add tests for storage and sync tabs using existing accessible labels.

### Task 3: Rebuild generation history as a delivery modal

**Files:**
- Modify: `apps/renderer/src/history/GenerationHistoryDrawer.tsx`
- Modify: `apps/renderer/src/styles/app.css`
- Test: `apps/renderer/src/history/GenerationHistoryDrawer.test.tsx`

- [ ] Preserve search, filter, export, reuse, canvas, favorite, trash, and comparison handlers.
- [ ] Render the Figma modal geometry and chronological asset grid; use the empty state when no records exist.
- [ ] Add an E2E capture for populated and empty history states.

### Task 4: Implement knowledge selection and generated-image menu

**Files:**
- Modify: `apps/renderer/src/agent/SkillChatWorkbench.tsx`
- Modify: `apps/renderer/src/canvas/ModuleNodeCard.tsx`
- Modify: `apps/renderer/src/styles/app.css`
- Test: `apps/renderer/src/agent/SkillChatWorkbench.test.tsx`
- Test: `apps/renderer/src/canvas/ModuleNodeCard.test.tsx`

- [ ] Provide the selectable knowledge list and context handoff from the supplied panel states.
- [ ] Provide the generated-image action menu while keeping existing delivery actions callable.
- [ ] Test keyboard-accessible open, selection, close, and action dispatch.

### Task 5: Release visual audit

**Files:**
- Modify: `tests/e2e/release-ui-audit.spec.ts`
- Create: `artifacts/release-ui-audit/`

- [ ] Capture knowledge selection, history, settings storage, settings sync, generated-image menu, and hybrid canvas in light and dark themes.
- [ ] Compare screenshots against supplied Figma references; correct P0–P2 visible differences before handoff.
- [ ] Run renderer typecheck and relevant Vitest/Playwright suites.
