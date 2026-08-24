# Canvas Connection, Agent Model, and Sidebar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Bring the formal canvas interaction shell in line with the Figma UI Gate by fixing the left rail, adding connect-to-blank Quick Insert, and restoring real Agent model and knowledge-base selection.

**Architecture:** Keep one Quick Insert component and one provider profile source. A pending connection is held in `CanvasWorkspace` until a compatible module is chosen, then the existing domain connection path persists the edge. Agent model and knowledge selection stay in `SkillChatWorkbench`, using real bridge profiles and knowledge summaries; no fallback or fabricated provider route is added.

**Tech Stack:** React, TypeScript, React Flow (`@xyflow/react`), Vitest, Playwright, CSS tokens in `figma-hybrid-canvas.css`.

## Global Constraints

- Modify only `E:\画布项目\staging-canvas-build` formal source.
- Preserve existing uncommitted user changes.
- Do not install software, delete user files, build/install NSIS, or fabricate provider/knowledge data.
- Dark and light themes share structure and geometry; only tokens change.

---

### Task 1: Normalize the Figma left rail

**Files:**
- Modify: `apps/renderer/src/styles/figma-hybrid-canvas.css`
- Modify: `apps/renderer/src/canvas/CanvasWorkspace.tsx`
- Test: `apps/renderer/src/main.styles.test.ts`
- Test: `tests/e2e/release-ui-audit.spec.ts`

**Interfaces:** Preserve existing `toolrail`, `tool-modules`, `agent-toggle`, `history-toggle`, `tool-more-actions`, and `settings-toggle` test IDs. The rail remains a 48px fixed shell at screen `(8,80)` with 32px controls.

- [ ] Add a terminal CSS contract for rail width/height, screen offset, inner padding, control size, group spacing, active state, and more-menu anchor. Keep icon-only controls centered with `display:grid; place-items:center`.
- [ ] Remove conflicting legacy spacing/transform rules only for `.workspace--ui-gate .toolrail--floating`; do not touch non-UI-Gate layouts.
- [ ] Add stylesheet assertions for exact geometry and a Playwright assertion that the rail and each visible control are centered inside their 32px cells in both themes.
- [ ] Run the focused style and release audit tests; expected: all pass.

### Task 2: Connect a dragged line to a module chosen from blank-canvas Quick Insert

**Files:**
- Modify: `apps/renderer/src/canvas/CanvasWorkspace.tsx`
- Modify: `apps/renderer/src/canvas/QuickInsert.tsx`
- Modify: `apps/renderer/src/canvas/module-catalog.ts`
- Test: `apps/renderer/src/canvas/CanvasWorkspace.test.tsx`
- Test: `apps/renderer/src/canvas/QuickInsert.test.tsx` (create if missing)
- Test: `tests/e2e/module-library-workflow.spec.ts`

**Interfaces:** Add a `PendingCanvasConnection` value containing `source`, `sourceHandle`, and flow-space `position`. Extend `QuickInsertProps` with an optional compatible-module filter and an `onCreate` callback that receives the selected module type and returns the created node ID when available.

- [ ] Write a failing unit test for a source handle released on `.react-flow__pane`: Quick Insert opens at the release point and stores the source port; releasing over a real target continues to use normal `onConnect`.
- [ ] Add `onConnectStart`/`onConnectEnd` handlers to `ReactFlow`. On an invalid blank release, convert the pointer to flow coordinates, calculate compatible module definitions from the source port, and open the existing Quick Insert without persisting an edge.
- [ ] Update Quick Insert to show the same Figma surface and only compatible module rows while a pending connection exists. Escape/close clears the pending state.
- [ ] After module creation, resolve the new node ID, select its compatible input handle, and call `connectModulePorts` through the existing validation/persistence path. If no compatible handle exists, remove the just-created node through the normal store operation and show an inline error.
- [ ] Add E2E coverage for image input → blank menu → image generation and verify one persisted edge, plus Escape cancellation with zero new edges.
- [ ] Run focused Vitest and the module-library workflow test; expected: all pass.

### Task 3: Restore Agent model selection and real conversation routes

**Files:**
- Modify: `apps/renderer/src/agent/SkillChatWorkbench.tsx`
- Modify: `apps/renderer/src/agent/SkillChatWorkbench.test.tsx`
- Modify: `packages/desktop-core/src/provider-skill-chat.ts`
- Modify: `packages/desktop-core/src/provider-skill-chat.test.ts` (or the existing provider bridge test that covers Skill chat)
- Modify: `apps/renderer/src/styles/figma-hybrid-canvas.css`
- Test: `tests/e2e/release-ui-audit.spec.ts`

**Interfaces:** Keep `ProviderBridgeProfile` as the source of truth. The UI may list profiles with `chat` capability and, when supported by the bridge, `responses`; it must never invent a route. `SkillChatRequest.modelRoute` remains the selected route.

- [ ] Add a failing component test proving the Agent model trigger is visible in the Figma shell, opens a populated route sheet, updates the selected model, and enables the composer.
- [ ] Keep the route sheet visible even when the header is visually collapsed by exposing one labeled footer control; preserve the existing icon affordance as a secondary control.
- [ ] Update bridge execution to select the real endpoint based on profile capabilities (`chat` uses `/v1/chat/completions`; `responses` uses the existing responses client contract) and return a normalized `ChatSkillBridgeResult`. If neither capability exists, return the existing provider-unavailable error.
- [ ] Add provider tests for route selection and for rejecting a reverse-only/image-only profile without making a fake chat route.
- [ ] Add dark/light E2E assertions for model-sheet visibility, selected route, and enabled send control.

### Task 4: Restore the Knowledge Base selection surface

**Files:**
- Modify: `apps/renderer/src/agent/SkillChatWorkbench.tsx`
- Modify: `apps/renderer/src/agent/SkillChatWorkbench.test.tsx`
- Modify: `apps/renderer/src/styles/figma-hybrid-canvas.css`
- Test: `tests/e2e/release-ui-audit.spec.ts`

**Interfaces:** Use the existing `knowledgeBases`, `selectedKnowledgeBaseIds`, `writeSkillChatSession`, and `context.knowledgeBaseIds` flow; do not add a second knowledge store.

- [ ] Add a failing test for the visible “知识库” trigger opening the search/category/multi-select sheet and toggling a real knowledge base.
- [ ] Restore the trigger in the Agent composer/header using the Figma dark shell; keep the light theme structurally identical.
- [ ] Ensure selection changes update session storage and the next `chat` request context, while inactive/unavailable bases remain excluded.
- [ ] Add E2E coverage for open, search, select, close, and persisted selection in dark and light themes.

### Task 6: Verification and formal screenshots

**Files:**
- No new product files; write screenshots under `artifacts/` only.

- [ ] Run `npm.cmd run typecheck`.
- [ ] Run focused Vitest for `main.styles`, `CanvasWorkspace`, `QuickInsert`, `SkillChatWorkbench`, and provider Skill chat tests.
- [ ] Run `module-library-workflow.spec.ts`, `video-generation-ui.spec.ts`, `release-ui-audit.spec.ts`, and `visual-layout.spec.ts` with a fresh port; do not delete or overwrite locked report files.
- [ ] Capture formal dark/light screenshots of the left rail, drag-to-blank menu, Agent model sheet, and Knowledge Base sheet. Confirm screenshots are from `staging-canvas-build`, not the stale `127.0.0.1` process.
- [ ] Do not create an NSIS installer.

### Task 5: Restore the Figma image-generation history surface

**Files:**
- Modify: `apps/renderer/src/history/GenerationHistoryDrawer.tsx`
- Modify: `apps/renderer/src/styles/figma-hybrid-canvas.css`
- Test: `apps/renderer/src/history/GenerationHistoryDrawer.test.tsx`
- Test: `tests/e2e/release-ui-audit.spec.ts`

**Interfaces:** Keep the existing `window.novusDesktop.history` bridge, pagination, detail, compare, favorite, reuse, add-to-canvas, and trash operations. The history surface must render real bridge records only.

- [ ] Add a failing UI test asserting the drawer has the Figma history heading, search/filter row, record grid, and empty state in both themes.
- [ ] Add a terminal UI-Gate history shell rule: centered 800px surface, fixed header/filter/body/footer rhythm, token-only colors, and no legacy compact 520px drawer geometry.
- [ ] Ensure the topbar button, left-rail history button, and Quick Insert history action all open the same surface and close without leaving stale overlays.
- [ ] Add dark/light E2E assertions for opening history, real empty/record states, detail navigation, and returning to the canvas.
- [ ] Run focused history tests before moving to final verification.
