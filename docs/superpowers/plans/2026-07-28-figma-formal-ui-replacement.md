# Figma Formal UI Replacement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the renderer's legacy visual surfaces with the approved Figma UI Gate treatment while keeping all canvas, desktop bridge, persistence, media, history, settings, and Agent behavior intact.

**Architecture:** `CanvasWorkspace` remains the behavioral root. Visual replacement is restricted to the renderer's existing canvas, node, history, settings, Agent, library, and context-menu components; it is driven by the shared light/dark CSS tokens and does not alter store or desktop API contracts. Figma delivery frames `179:2`, `182:2`, `184:2`, `188:2`, `188:175`, `191:2`, `192:2`, `197:2`, `197:139`, `202:2`, `202:190`, `206:2`, `206:163`, `226:2`, `226:64`, and `330:2` are the visual authority.

**Tech Stack:** React, TypeScript, React Flow, Zustand, CSS custom properties, Vitest, Playwright.

## Global Constraints

- Preserve all existing public renderer, store, persistence, provider, and desktop IPC interfaces.
- Keep current test IDs, accessible names, keyboard flows, and responsive behavior unless a test is updated alongside an equivalent replacement hook.
- Use the Figma token palette for both `light` and `dark`; no dark-only colors in light mode.
- Primary actions are horizontally centered inside their module; content text is left aligned unless it is an intentional empty/result headline.
- Do not package or install until focused tests, typecheck, and the dark/light visual audit pass.

---

### Task 1: Replace formal canvas and node presentation

**Files:**
- Modify: `apps/renderer/src/canvas/ModuleNodeCard.tsx`
- Modify: `apps/renderer/src/canvas/ModuleNodeCard.test.tsx`
- Modify: `apps/renderer/src/styles/app.css`
- Modify: `tests/e2e/release-ui-audit.spec.ts`

- [ ] Write failing component tests for a Figma-style video composer without a credit suffix, inline `@` image reference, a centered primary action, a real preview/result stage, and a minimal scrollable reverse-output node.
- [ ] Run `npm.cmd test -- apps/renderer/src/canvas/ModuleNodeCard.test.tsx` and verify the new assertions fail before changing renderer markup.
- [ ] Implement the approved video preview/composer/result layout and the minimal connected reverse long-text output; retain current run callbacks and payload shapes.
- [ ] Move all visual-only legacy overrides out of node markup and scope Figma rules under `.workspace--ui-gate`.
- [ ] Run the component tests and `npm.cmd run e2e -- tests/e2e/release-ui-audit.spec.ts`.

### Task 2: Replace all secondary Figma UI Gate surfaces

**Files:**
- Modify: `apps/renderer/src/history/GenerationHistoryDrawer.tsx`
- Modify: `apps/renderer/src/settings/SettingsDrawer.tsx`
- Modify: `apps/renderer/src/canvas/ModuleLibrary.tsx`
- Modify: `apps/renderer/src/canvas/CanvasWorkspace.tsx`
- Modify: `apps/renderer/src/styles/app.css`
- Modify: `apps/renderer/src/history/GenerationHistoryDrawer.test.tsx`
- Modify: `apps/renderer/src/settings/SettingsDrawer.test.tsx`
- Modify: `tests/e2e/release-ui-audit.spec.ts`

- [ ] Add failing test assertions for Figma surface headings, close controls, tokens, tab treatments, and mutually exclusive presentation state.
- [ ] Run the focused drawer tests to verify the new visual assertions fail.
- [ ] Apply the Figma settings, history, knowledge, module-library, double-click menu, and generated-image menu structure using existing events and actions.
- [ ] Remove superseded legacy visual selectors only once no production component references them.
- [ ] Run focused component tests and audit captures for each secondary surface in dark and light themes.

### Task 3: Verify the whole formal UI and release candidate

**Files:**
- Modify: `tests/e2e/release-ui-audit.spec.ts`
- Modify: `tests/e2e/visual-layout.spec.ts`
- Modify: `tests/e2e/video-generation-ui.spec.ts`

- [ ] Extend the visual audit to capture the Figma default canvas, video node/result, reverse output, history, settings, knowledge, and context menu in both themes.
- [ ] Run `npm.cmd test -- apps/renderer/src/canvas/ModuleNodeCard.test.tsx apps/renderer/src/history/GenerationHistoryDrawer.test.tsx apps/renderer/src/settings/SettingsDrawer.test.tsx`.
- [ ] Run `npm.cmd run typecheck`.
- [ ] Run `npm.cmd run e2e -- tests/e2e/release-ui-audit.spec.ts tests/e2e/visual-layout.spec.ts tests/e2e/video-generation-ui.spec.ts`.
- [ ] Inspect generated screenshots against their Figma delivery frames; report any remaining mismatch before packaging.
