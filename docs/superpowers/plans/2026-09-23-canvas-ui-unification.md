# Canvas Node and Agent UI Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On the existing 1.6.155 interface, unify image, video, reverse, Agent, color and save controls without losing parameters or behavior.

**Architecture:** Keep the current node components, durable store, and provider routes. Put shared compact-control tokens in the final renderer style cascade, then adjust each surface independently and pin behavior with component and local Playwright tests. This plan produces source-tested UI; the separate layering plan consumes its image toolbar and performs the final package gate.

**Tech Stack:** React, TypeScript, Zustand, React Flow, CSS, Vitest, Playwright, Electron.

**Spec:** `docs/superpowers/specs/2026-09-23-gpt-assisted-image-layering-design.md`

## Global Constraints

- Read `AGENTS.md` and all of `docs/project-memory.md` before product edits; preserve the dirty worktree and stage only owned files/hunks.
- Keep the 1.6.155 2×2 result grid unscrollable; the **material strip alone** begins horizontal wheel scrolling at item eight.
- Keep image base model/ratio/resolution/count and GPT quality/format/background; video model/mode/ratio/resolution/duration/count/audio; reverse model/depth/role/task/knowledge/results; Agent's three modes and all existing tools.
- The compact visual icon is about 28–32 px, but its interactive hit region remains easy to click; light and dark geometry must match.
- No live provider submission, real-project write, formal daily install, or GitHub release is part of this plan.
- Any discovered bug uses RED test → minimal fix → focused/wide verification → append root cause and command to `docs/project-memory.md`.
- Several 1.6.155 behaviors already have passing tests. Run those as baseline first; if a row already satisfies the approved spec, record the evidence and do not force a production edit merely to make a test red. Only new or failing behavior enters RED/GREEN.

## Review Focus

1. Eight to 20 connected assets: wheel scrolls only the material strip, and rapid reorder persists after reopen (Task 2).
2. GPT JPEG plus transparent background: disabled with an explanation; changing model preserves compatible stored values (Task 2).
3. Reverse depth changed during a delayed draft save: the new choice wins, not stale state (Task 3).
4. Narrow Agent floating panel with Codex reasoning and every tool visible: no clipped send or popup (Task 4).
5. Save error or blocked close immediately after typing/reordering: no infinite spinner, no false saved label, no lost final draft (Task 5).

## File Map

- `apps/renderer/src/styles/release-layout-contract.css`: final shared node/button geometry and save-state styling; avoid an earlier override that later CSS defeats.
- `apps/renderer/src/styles/agent-floating.css`: last-imported floating Agent geometry only; preserve the existing mode and popover behavior.
- `apps/renderer/src/canvas/ModuleNodeCard.tsx`: image/video/reverse grouping and accessible labels; do not move provider logic into CSS.
- `apps/renderer/src/canvas/ConnectedAgentMediaSlots.tsx`: material-strip keyboard/wheel/reorder behavior shared by the three node types.
- `apps/renderer/src/agent/SkillChatWorkbench.tsx`: Agent footer grouping and focus/disabled semantics.
- `apps/renderer/src/canvas/ImageColorCorrectionControls.tsx`, `apps/renderer/src/canvas/CanvasWorkspace.tsx`: compact color entry and truthful save action/state.
- Existing matching `*.test.tsx`, `release-layout-contract.test.ts`, and `tests/e2e/*.spec.ts`: RED/GREEN behavior and visual-contract coverage.

---

### Task 1: Shared compact control contract

**Files:** Modify `apps/renderer/src/styles/release-layout-contract.css`, `apps/renderer/src/styles/release-layout-contract.test.ts`, `apps/renderer/src/main.styles.test.ts`; append verified findings to `docs/project-memory.md` if a pre-existing style bug is fixed.

**Interfaces:** Produces CSS custom properties `--canvas-compact-control`, `--canvas-compact-hit`, `--canvas-compact-gap` for Task 2–5. No runtime TypeScript API.

- [ ] **Step 1: Write RED tests.** Add a style contract that reads the final CSS and checks the three tokens, focus-visible outline, light/dark token use and `main.tsx` import order (`release-layout-contract.css` before the last floating-Agent override). Example assertion:

```ts
expect(css).toContain('--canvas-compact-control: 30px');
expect(css).toContain('--canvas-compact-hit: 38px');
expect(css).toMatch(/:focus-visible\s*\{[^}]*outline:/u);
```

- [ ] **Step 2: Run RED.** `npm.cmd exec -- vitest run --config vitest.config.ts apps/renderer/src/styles/release-layout-contract.test.ts apps/renderer/src/main.styles.test.ts` must fail on the new contract.
- [ ] **Step 3: Implement only shared tokens and states.** Add scoped variables and an accessible hit area, without globally shrinking native inputs:

```css
.workspace--canvas-layout {
  --canvas-compact-control: 30px;
  --canvas-compact-hit: 38px;
  --canvas-compact-gap: 6px;
}
.workspace--canvas-layout :is(.module-node, .agent-panel) button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
```

- [ ] **Step 4: Run GREEN and inspect computed styles in both themes.** Same Vitest command; use the existing local Playwright renderer, not a static mock. Confirm the final cascade wins at 85% and 125% canvas zoom.
- [ ] **Step 5: Commit only owned changes.** `git add -- apps/renderer/src/styles/release-layout-contract.css apps/renderer/src/styles/release-layout-contract.test.ts apps/renderer/src/main.styles.test.ts` then `git commit -m "style: unify compact canvas control tokens"`.

### Task 2: Image, video and material-strip controls

**Files:** Modify `apps/renderer/src/canvas/ModuleNodeCard.tsx`, `apps/renderer/src/canvas/ConnectedAgentMediaSlots.tsx`, `apps/renderer/src/styles/release-layout-contract.css`; test `apps/renderer/src/canvas/ModuleNodeCard.test.tsx`, `apps/renderer/src/canvas/ConnectedAgentMediaSlots.test.tsx`, `tests/e2e/generation-parameter-adaptation.spec.ts`, `tests/e2e/video-inset-and-twenty-slots.spec.ts`.

**Interfaces:** Consumes Task 1 tokens; preserves existing `onReorder(edgeIds): boolean | Promise<boolean>` and all generation config fields. Produces no changed provider request contract.

- [ ] **Step 1: Write RED tests.** Pin image base/GPT fields and 2×2 no-scroll gallery; video visible summary and popup details; 7/8/20-slot scroll, five quick moves, failed reorder rollback. Add the narrow-layout condition where count and generate controls remain separated. Representative assertions:

```ts
expect(screen.getByLabelText('GPT 参数')).toHaveTextContent('画质');
expect(screen.getByLabelText('Video preview parameter controls')).toHaveTextContent('比例');
expect(screen.getByLabelText('Connected reverse media slots')).toHaveTextContent('8');
```

Measure actual `scrollWidth > clientWidth` at eight assets in Playwright, because jsdom has no layout geometry.

- [ ] **Step 2: Run the baseline/new test.** `npm.cmd exec -- vitest run --config vitest.config.ts apps/renderer/src/canvas/ModuleNodeCard.test.tsx apps/renderer/src/canvas/ConnectedAgentMediaSlots.test.tsx`; keep any already-passing 1.6.155 row unchanged. A new failing geometry/interaction assertion, not a provider fixture error, is the reason to edit.
- [ ] **Step 3: Apply the compact layout.** Keep base controls visible and GPT extras grouped, video summary visible and full settings in its existing popover. Restrict overflow to the slot track:

```css
.workspace--canvas-layout .connected-agent-media-slots__row {
  overflow-x: auto;
  overflow-y: hidden;
  overscroll-behavior-inline: contain;
}
.workspace--canvas-layout [data-module-type='image_generation'] .module-node__generation-preview-gallery--4 {
  overflow: hidden;
}
```

These selectors match the existing shared slot row and four-result gallery; do not create a second track. Preserve the existing JPEG/transparent capability guard and add its disabled explanation to the test.
- [ ] **Step 4: Run GREEN and local browser.** Focused Vitest above, then `npm.cmd run e2e -- tests/e2e/generation-parameter-adaptation.spec.ts tests/e2e/video-inset-and-twenty-slots.spec.ts`. Inspect dark/light and 7/8/20 slots; reopen the isolated project and assert final edge-ID order.
- [ ] **Step 5: Commit the scoped change.** Stage only the three production files and tests named in this task; commit `style: refine image video and material controls`.

### Task 3: Reverse-node hierarchy and result scrolling

**Files:** Modify `apps/renderer/src/canvas/ModuleNodeCard.tsx`, `apps/renderer/src/styles/release-layout-contract.css`; test `apps/renderer/src/canvas/ModuleNodeCard.test.tsx`, `tests/e2e/reverse-selectable-result.spec.ts`.

**Interfaces:** Consumes Task 1 tokens and Task 2 strip. Preserves persisted `modelRoute`, `analysisDepth`, `role`, `task`, `knowledgeBaseIds` and existing structured result keys.

- [ ] **Step 1: Write RED tests.** Assert model/status, fast/standard/deep, role/task, selected knowledge count and all six result sections remain accessible in both themes. Reproduce the delayed standard-depth draft after a new deep selection; assert deep remains selected. For long results, assert the result region scrolls internally and copy/run controls remain visible.
- [ ] **Step 2: Run RED.** `npm.cmd exec -- vitest run --config vitest.config.ts apps/renderer/src/canvas/ModuleNodeCard.test.tsx` must fail at the new contract.
- [ ] **Step 3: Reorder presentation, not data flow.** Give `ReverseAgentSummary` four visual regions with an independent result scroll cap:

```css
.workspace--canvas-layout [data-module-type='reverse_agent'] .module-node__agent-result-scroll {
  max-height: min(42vh, 420px);
  overflow-y: auto;
}
.workspace--canvas-layout [data-module-type='reverse_agent'] .module-node__agent-actions {
  position: relative;
  z-index: 1;
}
```

Keep depth selection merged against the latest external config as the current source does; fix only if RED proves regression. Keep errors visible without covering the task editor.
- [ ] **Step 4: Run GREEN.** Focused Vitest then `npm.cmd run e2e -- tests/e2e/reverse-selectable-result.spec.ts`; check result editing/copy and save/reopen with isolated data.
- [ ] **Step 5: Commit owned hunks.** Commit `style: simplify reverse node without losing result sections`.

### Task 4: Agent floating panel controls

**Files:** Modify `apps/renderer/src/agent/SkillChatWorkbench.tsx`, `apps/renderer/src/styles/agent-floating.css`, `apps/renderer/src/styles/release-layout-contract.css`; test `apps/renderer/src/agent/SkillChatWorkbench.floating.test.tsx`, `apps/renderer/src/agent/SkillChatWorkbench.test.tsx`, `tests/e2e/agent-floating-window.spec.ts`.

**Interfaces:** Consumes Task 1 tokens. No changes to `ChatSkillBridgeRequest` or the proposal/confirmation state machine.

- [ ] **Step 1: Write RED tests.** At narrow and normal floating widths, assert all three mode tabs, add-media, model, reasoning (when supported), generation preferences, knowledge, new conversation and send have reachable focus and no clipping. Pin send disabled while sending and previous mode's temporary media cleared on switch. Example:

```ts
expect(within(panel).getByRole('tab', { name: 'Codex' })).toBeVisible();
expect(within(panel).getByRole('button', { name: '发送' })).toBeVisible();
expect(within(panel).getByRole('button', { name: '添加素材' })).toBeEnabled();
```

- [ ] **Step 2: Run RED.** `npm.cmd exec -- vitest run --config vitest.config.ts apps/renderer/src/agent/SkillChatWorkbench.floating.test.tsx apps/renderer/src/agent/SkillChatWorkbench.test.tsx`.
- [ ] **Step 3: Group the existing buttons in two visual rows.** Preserve their DOM actions and accessible names; set the mode group and primary send as never-clipped, low-frequency tools as a wrapping group. In the last-imported floating CSS:

```css
.workspace--canvas-layout .agent-panel--floating .skill-chat-workbench__composer-footer {
  display: flex;
  flex-wrap: wrap;
  min-width: 0;
}
.workspace--canvas-layout .agent-panel--floating .skill-chat-workbench__composer-actions {
  margin-inline-start: auto;
  flex-shrink: 0;
}
```

Keep popovers inside viewport and restore focus to trigger on close; no workflow bypass.
- [ ] **Step 4: Run GREEN and browser.** Focused Vitest plus `npm.cmd run e2e -- tests/e2e/agent-floating-window.spec.ts`; capture dark/light narrow/normal screenshots and inspect actual clickable bounds.
- [ ] **Step 5: Commit owned files.** Commit `style: group compact Agent conversation actions`.

### Task 5: Color entry, save-state truth and wide UI verification

**Files:** Modify `apps/renderer/src/canvas/ImageColorCorrectionControls.tsx`, `apps/renderer/src/canvas/ModuleNodeCard.tsx`, `apps/renderer/src/canvas/CanvasWorkspace.tsx`, `apps/renderer/src/styles/release-layout-contract.css`; test `apps/renderer/src/canvas/ModuleNodeCard.test.tsx`, `apps/renderer/src/canvas/CanvasWorkspace.test.tsx`, `tests/e2e/project-save-manager.spec.ts`, `tests/e2e/image-layering.spec.ts`.

**Interfaces:** Exposes a compact, keyboard-accessible color toolbar entry for the layering plan to pair with AI-layering icon. Keeps `imageColorCorrections[assetId]` and existing `saveStatus` transitions unchanged.

- [ ] **Step 1: Write RED tests.** Color icon opens the existing modes/sliders and keeps per-asset before/after/download semantics; save button reports pending/saving/saved/error/read-only and never stays at saving after a failed ACK. A final typed character and last of five rapid slot swaps survive explicit save and restart. Include no-op route where no selected image disables the color entry with a reason.
- [ ] **Step 2: Run RED.** `npm.cmd exec -- vitest run --config vitest.config.ts apps/renderer/src/canvas/ModuleNodeCard.test.tsx apps/renderer/src/canvas/CanvasWorkspace.test.tsx`.
- [ ] **Step 3: Apply scoped controls.** Make the color icon a labelled button that toggles the existing controls; do not replace the correction engine. Keep saving driven by the store's actual state:

```tsx
<button type="button" aria-label="颜色校正" aria-expanded={colorOpen} onClick={() => setColorOpen(open => !open)}>
  <Palette size={16} aria-hidden="true" />
</button>
```

Add `Palette` to the existing lucide-react import. For save errors, leave the error status visible with retry, not a synthetic timeout-to-success. Do not change journal/revision semantics unless the RED test proves a persistence defect and that defect gets its own focused fix.
- [ ] **Step 4: Run GREEN and broad checks.** Focused Vitest; `npm.cmd run e2e -- tests/e2e/project-save-manager.spec.ts tests/e2e/image-layering.spec.ts`; then `npm.cmd test`, `npm.cmd run build`, `npm.cmd run scan:e2e`, `git diff --check`. Record any baseline unrelated failures rather than altering protected files.
- [ ] **Step 5: Document and commit.** Append root cause/behavior/test/commands for any actual bug fix to `docs/project-memory.md`. Stage only owned hunks and commit `style: align color and save controls with compact UI`.

## Handoff to the layering plan

The reviewer checks a real local renderer in light/dark, the full parameter inventory, Agent buttons at narrow width, and save/reopen. If all pass, execute `2026-09-23-gpt-assisted-layering.md`; that plan adds the second toolbar icon and finishes the candidate installer. Do not mark this plan as installed or provider-verified.
