# Figma Release Rebuild Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current patchwork canvas presentation with a release-ready UI that matches Figma node `179:2`, while preserving every supported canvas, persistence, provider, history, and Agent capability behind stable renderer contracts.

**Architecture:** The renderer shell becomes a small composition layer: top bar, rail, canvas stage, one mutually-exclusive secondary surface, and the floating Agent workbench. Domain and desktop functionality remain in the store and desktop bridge, but UI components receive typed action facades instead of reaching into window APIs. Figma geometry is encoded as CSS tokens and Playwright visual contracts; a release gate requires both visual and functional scenarios.

**Tech Stack:** React, TypeScript, Zustand, React Flow, Electron desktop bridge, Vitest, Playwright.

## Global Constraints

- The Figma desktop frame `179:2` is the only visual authority for default 1440px desktop state.
- Preserve existing project schema, persistence, model execution, managed media, knowledge, history, and desktop IPC behavior.
- Do not reset, delete, or overwrite unrelated uncommitted work.
- At most one secondary surface is visible at a time: module library, Agent, history, or settings.
- Ship only after focused unit tests, renderer typecheck, functional desktop E2E, and Figma visual layout E2E pass.

---

### Task 1: Establish the release UI contract and typed renderer facade

**Files:**
- Create: `apps/renderer/src/app/workspace-actions.ts`
- Create: `apps/renderer/src/app/workspace-actions.test.ts`
- Modify: `apps/renderer/src/canvas/CanvasWorkspace.tsx`
- Modify: `apps/renderer/src/canvas/CanvasWorkspace.test.tsx`

- [ ] Write tests specifying the facade methods for canvas node creation, media import, generation, reverse prompt, Agent chat, persistence, and drawer state.
- [ ] Make the tests fail because the facade does not exist.
- [ ] Implement `createWorkspaceActions(state)` as the only bridge between presentation components and the Zustand store.
- [ ] Replace direct visual-surface state changes with a discriminated `WorkspaceSurface` controller that closes the current surface before opening the next one.
- [ ] Run `npm.cmd test -- apps/renderer/src/app/workspace-actions.test.ts apps/renderer/src/canvas/CanvasWorkspace.test.tsx` and require zero failures.

### Task 2: Rebuild the Figma desktop shell and overlay model

**Files:**
- Create: `apps/renderer/src/canvas/WorkspaceShell.tsx`
- Create: `apps/renderer/src/canvas/WorkspaceShell.test.tsx`
- Modify: `apps/renderer/src/canvas/CanvasWorkspace.tsx`
- Modify: `apps/renderer/src/styles/app.css`
- Modify: `tests/e2e/visual-layout.spec.ts`

- [ ] Write viewport tests for the 56px top bar, 48x548 rail at (14,74), uninterrupted canvas, and a single visible overlay.
- [ ] Implement `WorkspaceShell` with named slots for toolbar, rail, canvas, surface, and job strip; preserve existing accessible names and keyboard operations.
- [ ] Encode the Figma colors, 1px borders, 16px panel radius, z-index layers, and responsive width tokens in one `workspace-*` CSS section; remove superseded shell selectors only after every caller moves to the new class names.
- [ ] Add Playwright assertions at 1440x900, 1366x768, and 440x900 that module library and Agent cannot coexist.
- [ ] Run `npm.cmd run e2e -- tests/e2e/visual-layout.spec.ts` and require all screenshots and layout assertions to pass.

### Task 3: Rebuild executable canvas nodes from Figma specifications

**Files:**
- Modify: `apps/renderer/src/canvas/ModuleNodeCard.tsx`
- Modify: `apps/renderer/src/canvas/node-types.tsx`
- Modify: `apps/renderer/src/canvas/ModuleNodeCard.test.tsx`
- Modify: `apps/renderer/src/styles/app.css`
- Modify: `tests/e2e/formal-module-workbench.spec.ts`

- [ ] Write node-specific UI contracts for Image Generation (404x420), Reverse Prompt (426x594), managed reference import, model selection, validated parameters, and execution feedback.
- [ ] Replace module-card presentation markup with Figma-aligned header, body, input, result, and footer primitives while retaining existing callbacks supplied by `ModuleNodeRuntimeContext`.
- [ ] Preserve generation and reverse-Agent request payloads exactly; assert that UI changes do not change route, model, reference, prompt, or confirmation data.
- [ ] Run focused node tests plus `npm.cmd run e2e -- tests/e2e/formal-module-workbench.spec.ts`.

### Task 4: Rebuild the Agent workbench and surface-specific views

**Files:**
- Modify: `apps/renderer/src/agent/SkillChatWorkbench.tsx`
- Modify: `apps/renderer/src/agent/SkillChatWorkbench.test.tsx`
- Modify: `apps/renderer/src/history/GenerationHistoryDrawer.tsx`
- Modify: `apps/renderer/src/settings/SettingsDrawer.tsx`
- Modify: `apps/renderer/src/styles/app.css`
- Modify: `tests/e2e/agent-reference-workflow.spec.ts`

- [ ] Write contracts for Agent geometry (396px wide, 86px top, 24px right/bottom), tabs, composer, managed-media mention menu, and keyboard focus restoration.
- [ ] Rebuild Agent header, tabs, timeline, empty state, and composer using the Figma panel primitives; keep `chatSkill`, knowledge, plan confirmation, and memory actions through the facade.
- [ ] Bring history and settings into the same mutually-exclusive surface system; do not show a second drawer over Agent or the module library.
- [ ] Run Agent and drawer component tests, then the reference-workflow E2E.

### Task 5: Make the desktop API boundary release-safe

**Files:**
- Modify: `apps/renderer/src/app/desktop-persistence.ts`
- Modify: `apps/renderer/src/app/knowledge-client.ts`
- Modify: `apps/renderer/src/jobs/desktop-model-executor.ts`
- Modify: `apps/renderer/src/types/novus-desktop.d.ts`
- Modify: `packages/desktop-core/src/preload-api.ts`
- Modify: `packages/desktop-core/src/public-api.test.ts`

- [ ] Write contract tests for every renderer capability consumed by the new facade: persistence, managed image/video import, provider status, model jobs, Agent chat, knowledge, history, and close flush.
- [ ] Remove presentation-level desktop access from rebuilt components and ensure all calls pass through typed renderer clients.
- [ ] Verify unavailable desktop capabilities resolve to existing safe browser/offline behavior and surface a visible, actionable error rather than throwing.
- [ ] Run package contract tests and `npm.cmd run typecheck`.

### Task 6: Run the release gate and produce a reviewable candidate

**Files:**
- Modify: `tests/e2e/visual-layout.spec.ts`
- Modify: `tests/e2e/durable-canvas-stress.spec.ts`
- Modify: `docs/superpowers/plans/2026-07-27-figma-release-rebuild.md`

- [ ] Capture the normal default workspace, image node, reverse node, and Agent-only states; do not use an overlapping stress state as UI evidence.
- [ ] Run `npm.cmd test`, `npm.cmd run typecheck`, `npm.cmd run e2e -- tests/e2e/visual-layout.spec.ts tests/e2e/formal-module-workbench.spec.ts tests/e2e/agent-reference-workflow.spec.ts tests/e2e/durable-canvas-stress.spec.ts`, and `npm.cmd run build`.
- [ ] Record every command result in this plan and mark each completed task only when its visual and functional assertions pass.
- [ ] Present the normal-state screenshots against Figma `179:2`; only then prepare a desktop package candidate if the user requests packaging.
