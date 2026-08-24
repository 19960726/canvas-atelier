# Generation Parameter Rail Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make image and video generation parameter controls share one readable, centered UI contract without changing generation behavior.

**Architecture:** Keep the existing React popover component and generation forms. Add one terminal UI Gate CSS contract after historical rules so both node families share geometry, while retaining image/video-specific column counts. Protect the contract with stylesheet tests and verify the actual dark/light rendered states through the existing Playwright scenario.

**Tech Stack:** React, TypeScript, CSS, Vitest, Playwright.

## Global Constraints

- Preserve model routing, API calls, generation parameter adaptation and node data structures.
- Ratio choices must show without ellipsis.
- Control height is 38px with 10px corners in both themes.
- The ratio menu remains a 226px two-column popover above its trigger.
- Do not modify unrelated canvas, Agent, settings or history behavior.

---

### Task 1: Lock the shared parameter-rail geometry

**Files:**
- Modify: `apps/renderer/src/main.styles.test.ts`
- Modify: `apps/renderer/src/styles/figma-hybrid-canvas.css`

**Interfaces:**
- Consumes: existing `.module-node__generation-control-bar`, `.module-node__video-control-bar`, and `.generation-parameter-popover` class contracts.
- Produces: terminal `Unified generation parameter rail` CSS contract used by image and video nodes.

- [ ] **Step 1: Write the failing stylesheet test**

Add a test that slices the terminal unified rule and checks image/video selectors, 38px controls, 10px corners, centered text, a minimum 112px ratio trigger, and no ellipsis on ratio values.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm.cmd run test -- apps/renderer/src/main.styles.test.ts`

Expected: FAIL because the terminal unified contract does not exist.

- [ ] **Step 3: Add the minimal terminal CSS contract**

Append a single named rule group to `figma-hybrid-canvas.css`. Use separate grid templates for image and video while sharing control geometry. Override the image legacy multi-row grid, give ratio popovers 112px minimum width, and set trigger text overflow to visible.

- [ ] **Step 4: Run the stylesheet test**

Run: `npm.cmd run test -- apps/renderer/src/main.styles.test.ts`

Expected: PASS.

### Task 2: Verify interaction and both themes

**Files:**
- Modify only if needed: `tests/e2e/generation-parameter-adaptation.spec.ts`
- Output: `artifacts/2026-08-11-generation-rail/`

**Interfaces:**
- Consumes: accessible labels from `GenerationParameterPopover.tsx`.
- Produces: dark/light screenshots and an interaction result for ratio and clarity selection.

- [ ] **Step 1: Run the existing generation parameter E2E**

Run: `npm.cmd run e2e -- tests/e2e/generation-parameter-adaptation.spec.ts`

Expected: ratio menus expose all eight values and clarity exposes 2K/4K.

- [ ] **Step 2: Capture both theme states**

Use the existing Playwright harness to capture expanded image and video controls in dark and light themes after opening the ratio menu.

- [ ] **Step 3: Inspect screenshots**

Confirm no value is truncated, controls are centered, popovers remain attached to their triggers, and both theme palettes use existing tokens.

- [ ] **Step 4: Run focused component tests**

Run: `npm.cmd run test -- apps/renderer/src/canvas/GenerationParameterPopover.test.tsx apps/renderer/src/main.styles.test.ts`

Expected: PASS with no new failures.
