# Bridge-style Node Workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Apply the approved bridge-style reference consistently to all canvas workbench nodes while preserving existing behavior.

**Architecture:** Keep `ModuleNodeCard` and existing node data contracts unchanged. Centralize the visual treatment in the UI Gate CSS selectors and add focused renderer assertions for shared geometry and slot limits.

**Tech Stack:** React, TypeScript, CSS, Vitest, Playwright, Electron Builder.

## Global Constraints

- Preserve the Figma UI Gate shell and 530px workbench geometry.
- Preserve node ports, drag/drop, uploads, API routing, persistence, and execution state behavior.
- Reference slots must remain square and support up to 20 linked images.

### Task 1: Audit existing node structure

**Files:**
- Inspect: `apps/renderer/src/canvas/ModuleNodeCard.tsx`
- Inspect: `apps/renderer/src/styles/app.css`
- Test: `apps/renderer/src/canvas/formal-module-workbench.test.tsx`

- [ ] Confirm existing DOM class names for preview, prompt, reference slots, ratio picker, model controls, reverse task, knowledge base, and actions.
- [ ] Confirm no data/port changes are required.

### Task 2: Align shared visual geometry

**Files:**
- Modify: `apps/renderer/src/styles/app.css`
- Test: `apps/renderer/src/canvas/formal-module-workbench.test.tsx`

- [ ] Set shared node card width, radius, border, padding, and vertical rhythm to the approved reference.
- [ ] Set image generation order to preview → prompt → references → ratios → parameters → action/status.
- [ ] Set reverse-agent order to media slots → model → role → task → knowledge → actions/results.
- [ ] Keep narrow-screen width `min(530px, calc(100vw - 32px))`.

### Task 3: Verify slots and controls

**Files:**
- Modify: `apps/renderer/src/canvas/formal-module-workbench.test.tsx`
- Modify: `apps/renderer/src/canvas/ModuleNodeCard.test.tsx`

- [ ] Assert square image/reference slots, linked-image rendering, empty-slot rendering, and 20-item cap.
- [ ] Assert ratio buttons, model/quality/count controls, and reverse knowledge/action controls remain visible.

### Task 4: Run verification and package

**Files:**
- Build: `apps/desktop-modern/dist-builder/desktop-modern/CanvasAtelier-Win10-11-x64-0.0.0.exe`

- [ ] Run focused renderer tests.
- [ ] Run typecheck and full build.
- [ ] Build the Windows NSIS installer with a selectable installation directory.
