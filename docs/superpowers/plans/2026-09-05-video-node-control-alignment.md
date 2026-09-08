# Video Node Control Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Align video-generation controls with image-generation controls and remove custom video preview overlays.

**Architecture:** Keep the existing video-specific class names and JSX structure. Add only video-scoped CSS for the control row and remove the two custom overlay buttons from the completed video result renderer; native `<video controls>` remains the playback surface.

**Tech Stack:** React, TypeScript, CSS, Vitest, Playwright.

## Global Constraints

- Do not change image-generation styles or behavior.
- Do not change provider payloads, job state, persistence, or MCP behavior.
- Keep native video playback controls enabled.

---

### Task 1: Lock the video-only contract

**Files:**
- Modify: `apps/renderer/src/canvas/ModuleNodeCard.test.tsx`
- Modify: `apps/renderer/src/canvas/ModuleNodeCard.tsx`

- [ ] Add assertions for the video result contract: a completed video keeps the native `video[controls]` element, does not render `.module-node__video-preview-play`, and does not render `.module-node__video-preview-expand`.
- [ ] Remove only the two custom overlay buttons from the completed video result JSX.
- [ ] Run the focused ModuleNodeCard tests and confirm they pass.

### Task 2: Align the video control row

**Files:**
- Modify: `apps/renderer/src/styles/app.css`

- [ ] Keep `.module-node__video-control-bar` scoped to video nodes and set its child controls to the same 34px height and centered alignment as the image control row.
- [ ] Preserve the existing video grid columns and responsive overflow behavior; do not alter shared `.module-node__generation-control-bar` rules.
- [ ] Run the focused UI tests and the video generation E2E spec.

### Task 3: Verify visual and regression behavior

**Files:**
- No additional source files.

- [ ] Run `npm.cmd exec vitest -- --config vitest.config.ts apps/renderer/src/canvas/ModuleNodeCard.test.tsx --run`.
- [ ] Run `npm.cmd exec playwright test tests/e2e/video-generation-ui.spec.ts tests/e2e/video-generation-execution.spec.ts --reporter=line`.
- [ ] Capture a fresh video-node screenshot and verify the controls sit on one baseline and no custom play/fullscreen overlays appear.
