# Formal Canvas Figma UI and Close Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Rebuild the formal desktop canvas shell and node/drawer surfaces to match the approved Novus Atelier Figma references, while making every desktop close path reliable.

**Architecture:** Keep the existing React state, IPC contracts, provider routing, and node actions. Replace only presentation structure/tokens where needed, add screenshot-level semantic hooks for visual verification, and harden the existing close coordinator at the Electron boundary so all exit sources share one idempotent flow.

**Tech Stack:** React 18, TypeScript, CSS, Vitest, Playwright, Electron, existing desktop-core close-flush contract.

## Global Constraints

- Preserve image-generation, reverse-agent, chat, knowledge-base, history, save/restore, and dual-token behavior.
- Do not change the explicitly deferred image distortion or intermittent-generation behavior.
- Match the supplied Figma node references and screenshots: dark dotted canvas, 56px shell, image-generation node, reverse-agent node, and Agent Chat drawer.
- Do not pass API secrets, base64 images, filesystem paths, or remote URLs through renderer IPC.
- Modify only task-related files in the existing dirty worktree; do not reset or clean unrelated user changes.

---

### Task 1: Capture Figma reference measurements

**Files:**
- Create: `docs/superpowers/specs/2026-07-26-formal-canvas-figma-reference.md`
- Test: none (reference capture)

- [ ] Record node IDs, dimensions, spacing, colors, typography, and component states from Figma nodes `9:2`, `71:2`, and the supplied Agent Chat reference.
- [ ] Record the implementation mapping to `CanvasWorkspace`, `ModuleNodeCard`, `ReversePromptAgent`, `SkillChatWorkbench`, and `app.css`.
- [ ] Mark any unavailable Figma-only details as explicit assumptions rather than inventing API behavior.

### Task 2: Rebuild canvas shell and node layout

**Files:**
- Modify: `apps/renderer/src/canvas/CanvasWorkspace.tsx`
- Modify: `apps/renderer/src/canvas/ModuleNodeCard.tsx`
- Modify: `apps/renderer/src/canvas/node-types.tsx`
- Modify: `apps/renderer/src/styles/app.css`
- Test: `apps/renderer/src/canvas/CanvasWorkspace.test.tsx`, `apps/renderer/src/canvas/ModuleNodeCard.test.tsx`, `apps/renderer/src/canvas/theme.behavior.test.tsx`

- [ ] Add failing structure assertions for shell landmarks, node title/subtitle, lock control, square image slot, 0/20 reference count, ratio controls, and reverse-agent action row.
- [ ] Implement the Figma-aligned DOM hierarchy without changing existing callbacks or module data contracts.
- [ ] Add responsive layout rules that keep labels and controls on separate rows at drawer and narrow-window widths.
- [ ] Run focused renderer tests and fix only regressions caused by the new structure.

### Task 3: Rebuild Agent Chat drawer and settings surfaces

**Files:**
- Modify: `apps/renderer/src/agent/SkillChatWorkbench.tsx`
- Modify: `apps/renderer/src/settings/SettingsDrawer.tsx`
- Modify: `apps/renderer/src/styles/app.css`
- Test: `apps/renderer/src/agent/SkillChatWorkbench.test.tsx`, `apps/renderer/src/settings/SettingsDrawer.test.tsx`

- [ ] Add failing assertions for the title bar, tabs, model status blocks, knowledge-base workbench, composer toolbar, and send button.
- [ ] Implement the drawer structure and spacing shown in the reference while preserving chat submission and model-selection behavior.
- [ ] Implement a non-overlapping one-column fallback for model override controls when the drawer is narrow.
- [ ] Run focused tests and renderer typecheck.

### Task 4: Harden close coordination

**Files:**
- Modify: `apps/desktop-modern/src/main.ts`
- Modify: `apps/desktop-modern/src/close-coordinator.test.ts`
- Modify: `packages/desktop-core/src/renderer-close-flush.ts`
- Modify: `packages/desktop-core/src/renderer-close-flush.test.ts`
- Test: `tests/e2e/close-flow.spec.ts` (create)

- [ ] Add failing tests for window close, menu quit, `window.close`, duplicate requests, renderer ACK, timeout, save failure, and renderer crash.
- [ ] Route all exit sources through one idempotent coordinator and one flush request.
- [ ] Ensure ACK permits project shutdown and background-service cleanup; timeout/failure exposes recoverable continue/abandon behavior.
- [ ] Add Playwright coverage for clean close and unsaved close paths.

### Task 5: Visual and functional verification

**Files:**
- Modify: `tests/e2e/visual-layout.spec.ts`
- Modify: `tests/e2e/formal-module-workbench.spec.ts`
- Test: existing renderer, integration, and desktop close suites

- [ ] Capture the formal canvas at a fixed viewport and compare shell/node/drawer landmarks to the Figma reference.
- [ ] Run focused Vitest suites.
- [ ] Run full typecheck and renderer build.
- [ ] Run Playwright canvas, agent, settings, save/restore, and close-flow suites.
- [ ] Record any remaining visual or platform limitations in a final verification note.

