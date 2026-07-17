# Novus Atelier Professional Workbench UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refine the existing Novus Atelier renderer into a professional light creative workstation with a reusable, semantically distinct canvas-node system and verified responsive visual quality.

**Architecture:** Keep domain state, transactions, persistence, and Agent workflows unchanged. Introduce one renderer-only shared node presentation component, enrich flow-node view data, and apply the approved hierarchy through CSS tokens and narrowly scoped markup classes. Verify each presentation slice with component tests before visual Playwright evidence.

**Tech Stack:** React 19, TypeScript, Zustand, `@xyflow/react`, Lucide React, CSS, Vitest, Testing Library, Playwright, Vite.

## Global Constraints

- Work only in `E:\画布项目\.worktrees\canvas-agent-mvp` on `feature/canvas-agent-mvp`; never modify the main checkout.
- Preserve the existing 44 px top bar, 48 px tool rail, 360 px Agent panel, and 36 px job strip.
- Use Segoe UI with Microsoft YaHei UI fallback and zero letter spacing.
- Use restrained radii: 4-5 px controls and 6-7 px panels/nodes.
- No gradients, blur-heavy effects, decorative orbs, oversized radii, or marketing-style card composition.
- No layout animation, animated blur, large shadow animation, or continuous decorative motion.
- Do not add React state during pan, zoom, pointermove, or node hover when CSS can express the state.
- No full persistence on pointermove; saved state is shown only after durable ACK.
- Preserve viewport culling, interaction-quality downgrade, fixed node dimensions, and fixed toolbar dimensions.
- Renderer receives no arbitrary filesystem, process, keychain, token, or Authorization access.
- No API key, Authorization, raw Base64 image, or private absolute path in durable project/log/snapshot/package/memory/Skill/e2e artifacts.
- Preserve one Agent conversation while switching GPT Image and Nano Banana 2 routes; model execution remains explicitly confirmed.
- Do not copy CanvasForge source, UI, assets, secrets, branding, or proprietary interactions.
- Figma editable delivery remains pending while Starter MCP quota is exhausted; screenshots are not a substitute.
- Do not stage or commit the existing Task 10C dirty files under `apps/desktop-*`, `scripts/`, or `apps/desktop-modern/src/runtime-entry-contract.test.ts`.

---

### Task 1: Reusable Semantic Canvas Node System

**Files:**
- Create: `apps/renderer/src/canvas/CanvasNodeCard.tsx`
- Create: `apps/renderer/src/canvas/CanvasNodeCard.test.tsx`
- Modify: `apps/renderer/src/canvas/node-types.tsx`
- Modify: `apps/renderer/src/canvas/node-types.test.ts`
- Modify: `apps/renderer/src/jobs/ImageResultNode.tsx`
- Create: `apps/renderer/src/jobs/ImageResultNode.test.tsx`
- Modify: `apps/renderer/src/styles/app.css`

**Interfaces:**
- Consumes: domain `CanvasNode`, React Flow `NodeProps`, fixed left/right handles, and existing `ImageResultNode` routing.
- Produces: `CanvasNodePresentation`, `CanvasNodeCard`, and enriched `CanvasNodeData` used by all flow node families.

- [ ] **Step 1: Write failing shared-node and view-data tests**

Create `CanvasNodeCard.test.tsx` with real DOM assertions:

```tsx
render(<CanvasNodeCard
  kind="prompt"
  tone="teal"
  eyebrow="Agent plan"
  title="Hero product composition"
  subtitle="3 references"
  status="Ready"
  selected
/>);

const node = screen.getByTestId('canvas-node-card');
expect(node).toHaveAttribute('data-node-kind', 'prompt');
expect(node).toHaveAttribute('data-tone', 'teal');
expect(node).toHaveClass('is-selected');
expect(screen.getByText('Agent plan')).toBeVisible();
expect(screen.getByText('Ready')).toBeVisible();
expect(node.querySelector('.canvas-node__type-icon')).not.toBeNull();
```

Extend `node-types.test.ts` to assert `toFlowNodes()` produces semantic fields for at least reference, placement, prompt, model job, review, memory diff, and Agent plan nodes:

```ts
expect(toFlowNodes([promptNode])[0]?.data).toMatchObject({
  kind: 'prompt',
  eyebrow: 'Agent plan',
  tone: 'teal',
  status: 'Ready',
});
```

Create `ImageResultNode.test.tsx` and assert it uses the same shared anatomy plus the durable asset label.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```powershell
npm test -- apps/renderer/src/canvas/CanvasNodeCard.test.tsx apps/renderer/src/canvas/node-types.test.ts apps/renderer/src/jobs/ImageResultNode.test.tsx
```

Expected: FAIL because `CanvasNodeCard`, semantic view-data fields, and shared image-result anatomy do not exist.

- [ ] **Step 3: Implement the renderer-only presentation contract**

Create the exact presentation types in `CanvasNodeCard.tsx`:

```tsx
export type CanvasNodeTone = 'teal' | 'blue' | 'amber' | 'slate' | 'red';

export interface CanvasNodePresentation {
  kind: CanvasNode['type'];
  tone: CanvasNodeTone;
  eyebrow: string;
  title: string;
  subtitle: string;
  status: string;
  resultAssetId?: string;
}

interface CanvasNodeCardProps extends CanvasNodePresentation {
  selected?: boolean;
  children?: ReactNode;
}
```

Use a fixed Lucide icon map keyed by `CanvasNode['type']`. Render:

```tsx
<div
  className={`canvas-node tone-${tone}${selected ? ' is-selected' : ''}`}
  data-testid="canvas-node-card"
  data-node-kind={kind}
  data-tone={tone}
>
  <Handle type="target" position={Position.Left} />
  <span className="canvas-node__rail" aria-hidden="true" />
  <header className="canvas-node__header">
    <span className="canvas-node__type-icon" aria-hidden="true"><Icon size={15} /></span>
    <span className="canvas-node__heading">
      <span className="canvas-node__eyebrow">{eyebrow}</span>
      <strong className="canvas-node__title">{title}</strong>
    </span>
  </header>
  <div className="canvas-node__body">{children ?? <p className="canvas-node__meta">{subtitle}</p>}</div>
  <footer className="canvas-node__footer">
    <span>{subtitle}</span><b>{status}</b>
  </footer>
  <Handle type="source" position={Position.Right} />
</div>
```

Update `CanvasNodeData` to extend `CanvasNodePresentation`. Map tones and statuses without changing domain data:

- reference: tone by role (`product_identity` teal, `scene_composition` blue, props/material amber), status `Reference`
- placement preview: blue, status `${objectCount} layers`
- prompt: teal, status `Ready` or `Draft`
- model job: red only for failed, otherwise slate/teal, status from job state
- review: amber, status `Review`
- memory diff: blue or amber based on status, status from domain value
- Agent plan: blue, status from plan state
- image result: teal, status `Result`

Replace the old `BaseNode` with `CanvasNodeCard`. Update `ImageResultNode` to render `CanvasNodeCard` and place the asset ID in a child preview block.

Add CSS with fixed dimensions:

```css
.canvas-node {
  position: relative;
  width: 236px;
  min-height: 96px;
  padding: 11px 12px 9px 15px;
  overflow: hidden;
  background: var(--surface);
  border: 1px solid var(--border-strong);
  border-radius: 7px;
  box-shadow: var(--shadow-node);
  transition: border-color 120ms ease, box-shadow 120ms ease, opacity 120ms ease;
}
.canvas-node__rail { position: absolute; inset: 0 auto 0 0; width: 3px; background: var(--node-tone); }
.canvas-node__header { display: grid; grid-template-columns: 28px minmax(0, 1fr); gap: 8px; align-items: center; }
.canvas-node__footer { min-height: 20px; display: flex; align-items: center; justify-content: space-between; gap: 8px; border-top: 1px solid var(--border-subtle); font-size: 9px; }
```

Keep handles at fixed 8 px geometry and preserve interaction-low-quality shadow removal.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the Step 2 command.

Expected: all focused tests PASS.

- [ ] **Step 5: Run node-adjacent regression tests**

Run:

```powershell
npm test -- apps/renderer/src/canvas/node-types.test.ts apps/renderer/src/canvas/CanvasWorkspace.test.tsx apps/renderer/src/jobs/job-store.test.ts
```

Expected: PASS with no transaction, routing, or viewport behavior changes.

- [ ] **Step 6: Self-review and commit only Task 1 files**

```powershell
git add -- apps/renderer/src/canvas/CanvasNodeCard.tsx apps/renderer/src/canvas/CanvasNodeCard.test.tsx apps/renderer/src/canvas/node-types.tsx apps/renderer/src/canvas/node-types.test.ts apps/renderer/src/jobs/ImageResultNode.tsx apps/renderer/src/jobs/ImageResultNode.test.tsx apps/renderer/src/styles/app.css
git commit -m "feat: refine semantic canvas nodes"
```

---

### Task 2: Professional Editor Shell and Job Strip

**Files:**
- Modify: `apps/renderer/src/styles/tokens.css`
- Modify: `apps/renderer/src/styles/app.css`
- Modify: `apps/renderer/src/canvas/CanvasWorkspace.tsx`
- Modify: `apps/renderer/src/canvas/CanvasWorkspace.test.tsx`
- Modify: `apps/renderer/src/jobs/JobStrip.tsx`
- Create or modify: `apps/renderer/src/jobs/JobStrip.test.tsx`

**Interfaces:**
- Consumes: existing workspace geometry, `saveStatusLabel`, model status, active tool, and model job states.
- Produces: stable semantic class/data attributes for shell controls and save/job status styling.

- [ ] **Step 1: Write failing shell and job-state tests**

Add assertions that the shell exposes stable visual-state hooks without changing behavior:

```tsx
expect(screen.getByTestId('workspace')).toHaveClass('workspace');
expect(screen.getByTestId('topbar')).toHaveAttribute('data-surface', 'chrome');
expect(screen.getByTestId('tool-placement')).toHaveAttribute('aria-pressed', 'false');
```

After selecting placement, assert `aria-pressed="true"`. In `JobStrip.test.tsx`, assert:

```tsx
expect(screen.getByTestId('job-strip')).toHaveAttribute('data-has-active-jobs', 'true');
expect(screen.getByTestId('save-state')).toHaveAttribute('data-save-state', 'saved');
```

Pass `saveState` as a presentation-only prop derived from the existing store status; do not infer durable save from text.

- [ ] **Step 2: Run focused tests and verify RED**

```powershell
npm test -- apps/renderer/src/canvas/CanvasWorkspace.test.tsx apps/renderer/src/jobs/JobStrip.test.tsx
```

Expected: FAIL because the new state hooks and `saveState` presentation prop do not exist.

- [ ] **Step 3: Add the approved design tokens**

Update `tokens.css` with exact semantic variables from the spec:

```css
--surface: #ffffff;
--surface-muted: #f6f8f9;
--surface-elevated: #fbfcfd;
--canvas: #edf1f3;
--text: #17212b;
--text-secondary: #53616c;
--muted: #7a8791;
--border: #d5dde3;
--border-subtle: #e7ecef;
--border-strong: #aeb9c2;
--accent: #0f766e;
--accent-soft: #e1f3f0;
--blue: #2563eb;
--amber: #b45309;
--danger: #b42318;
--success: #16865f;
--shadow-node: 0 2px 7px rgba(23, 33, 43, 0.09);
--shadow-panel: 0 10px 28px rgba(23, 33, 43, 0.13);
```

- [ ] **Step 4: Implement shell and task-strip hierarchy**

In `CanvasWorkspace.tsx`:

- add `data-surface="chrome"` to the top bar
- add `aria-pressed={activeTool === id}` to tool buttons
- split provider status and run action with stable classes; retain the same text and click behavior
- pass `saveState={saveStatus}` to `JobStrip`

In `JobStrip.tsx`, extend props with:

```ts
saveState: 'pending' | 'saving' | 'saved' | 'error' | 'read_only';
```

Render stable attributes:

```tsx
<footer data-has-active-jobs={activeJobs.length > 0 ? 'true' : 'false'} ...>
  ...
  <span data-testid="save-state" data-save-state={saveState} className="job-strip__save">{saveLabel}</span>
</footer>
```

Refine CSS for top bar, project button, centered history group, rail active indicator, canvas controls/minimap, context readout, job chips, focus-visible rings, and disabled states. Keep all existing geometry unchanged.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run the Step 2 command.

Expected: PASS.

- [ ] **Step 6: Run shell regression tests**

```powershell
npm test -- apps/renderer/src/canvas/CanvasWorkspace.test.tsx apps/renderer/src/jobs/JobStrip.test.tsx apps/renderer/src/app/app-store.test.ts
```

Expected: PASS; saved presentation remains bound to durable ACK-backed store status.

- [ ] **Step 7: Self-review and commit only Task 2 files**

```powershell
git add -- apps/renderer/src/styles/tokens.css apps/renderer/src/styles/app.css apps/renderer/src/canvas/CanvasWorkspace.tsx apps/renderer/src/canvas/CanvasWorkspace.test.tsx apps/renderer/src/jobs/JobStrip.tsx apps/renderer/src/jobs/JobStrip.test.tsx
git commit -m "feat: polish professional editor shell"
```

---

### Task 3: Agent Status, Plan, and Placement Workbench Hierarchy

**Files:**
- Modify: `apps/renderer/src/agent/KnowledgeStatus.tsx`
- Modify: `apps/renderer/src/agent/KnowledgeStatus.test.tsx`
- Modify: `apps/renderer/src/agent/ReversePromptAgent.tsx`
- Modify: `apps/renderer/src/agent/ReversePromptAgent.test.tsx`
- Modify: `apps/renderer/src/agent/PlanPreview.tsx`
- Modify: `apps/renderer/src/agent/PlanPreview.test.tsx`
- Modify: `apps/renderer/src/placement/PlacementInspector.tsx`
- Modify or create: `apps/renderer/src/placement/PlacementInspector.test.tsx`
- Modify: `apps/renderer/src/styles/app.css`

**Interfaces:**
- Consumes: current knowledge state selection, reverse-prompt behavior, explicit plan confirmations, upload handlers, placement updates, and fixed workbench geometry.
- Produces: structured status markup and semantic role hooks for professional styling.

- [ ] **Step 1: Write failing structured-status and inspector tests**

In `KnowledgeStatus.test.tsx`, assert state and detail are separate:

```tsx
const status = screen.getByRole('status');
expect(status).toHaveAttribute('data-knowledge-status', 'syncing');
expect(within(status).getByTestId('knowledge-status-label')).toHaveTextContent(/syncing/i);
expect(within(status).getByTestId('knowledge-status-detail')).toHaveTextContent(/No active knowledge/i);
```

In `ReversePromptAgent.test.tsx`, assert section hooks exist for Skill controls, context, knowledge, and run action. In `PlanPreview.test.tsx`, assert the preview carries `data-plan-state` and operation rows carry `data-operation-kind`.

In `PlacementInspector.test.tsx`, render a selected product object and assert upload controls expose `data-reference-role`, properties are grouped, and layer actions remain enabled/disabled exactly as before.

- [ ] **Step 2: Run focused tests and verify RED**

```powershell
npm test -- apps/renderer/src/agent/KnowledgeStatus.test.tsx apps/renderer/src/agent/ReversePromptAgent.test.tsx apps/renderer/src/agent/PlanPreview.test.tsx apps/renderer/src/placement/PlacementInspector.test.tsx
```

Expected: FAIL because structured presentation hooks do not exist.

- [ ] **Step 3: Implement structured Agent and knowledge markup**

Update `KnowledgeStatus`:

```tsx
<aside className={`knowledge-status is-${displayStatus}`} data-knowledge-status={displayStatus} role="status" aria-live="polite">
  <span className="knowledge-status__indicator" aria-hidden="true" />
  <span className="knowledge-status__copy">
    <strong data-testid="knowledge-status-label">{formatStatus(displayStatus)}</strong>
    <span data-testid="knowledge-status-detail">{activeLabel}</span>
  </span>
  {pinnedLease && <span className="knowledge-status__pinned">Pinned {pinnedLease.versionKey}</span>}
</aside>
```

Retain `selectDisplayStatus`, active-version selection, and all state precedence.

Add section classes in `ReversePromptAgent` without changing callbacks or state. Add `data-plan-state={plan.state}` and `data-operation-kind={operation.kind}` in `PlanPreview`.

- [ ] **Step 4: Implement placement inspector presentation hooks**

Extend `UploadField` with `role` and an icon component, then render:

```tsx
<label className={`placement-upload role-${role}`} data-reference-role={role}>
  <input ... />
  <Icon size={15} aria-hidden="true" />
  <span>{label}</span>
</label>
```

Group selected-object controls with presentation-only wrappers:

- `placement-properties__identity`
- `placement-properties__transform`
- `placement-properties__visibility`
- `placement-properties__layers`

Do not change `updateSelected`, upload, lock, visibility, flip, or z-index behavior.

- [ ] **Step 5: Apply Agent and workbench CSS**

In `app.css`:

- strengthen Agent header/tabs while preserving widths and keyboard behavior
- make `knowledge-status` a two-column status row with semantic indicator and readable detail, eliminating concatenated text
- align reverse Skill header, persona selector, context metrics, run action, plan rows, and composer route controls
- preserve dark memory/Skill views but align their borders, text levels, and radii with the light shell
- refine workbench header, board background, inspector dividers, role upload controls, selected object handles, rotate affordance, safe area, and rule-of-thirds guides
- use only color/border/opacity transitions of 100-160 ms

- [ ] **Step 6: Run focused tests and verify GREEN**

Run the Step 2 command.

Expected: PASS.

- [ ] **Step 7: Run Agent and placement regressions**

```powershell
npm test -- apps/renderer/src/agent apps/renderer/src/placement apps/renderer/src/references/ReferenceOrderList.test.tsx apps/renderer/src/history/SkillCandidateReview.test.tsx
```

Expected: PASS with no confirmation, memory, reference-order, or pointer interaction behavior changes.

- [ ] **Step 8: Self-review and commit only Task 3 files**

```powershell
git add -- apps/renderer/src/agent/KnowledgeStatus.tsx apps/renderer/src/agent/KnowledgeStatus.test.tsx apps/renderer/src/agent/ReversePromptAgent.tsx apps/renderer/src/agent/ReversePromptAgent.test.tsx apps/renderer/src/agent/PlanPreview.tsx apps/renderer/src/agent/PlanPreview.test.tsx apps/renderer/src/placement/PlacementInspector.tsx apps/renderer/src/placement/PlacementInspector.test.tsx apps/renderer/src/styles/app.css
git commit -m "feat: refine agent and placement workbench"
```

---

### Task 4: Responsive Visual and Performance Acceptance

**Files:**
- Modify: `tests/e2e/visual-layout.spec.ts`
- Modify: `tests/e2e/helpers/app.ts` only if a reusable geometry assertion is required
- Modify: `docs/testing/windows-compatibility-matrix.md` only to record the new renderer visual command evidence; do not alter manual OS rows

**Interfaces:**
- Consumes: stable test IDs and semantic hooks from Tasks 1-3.
- Produces: current screenshots and measurable no-overlap/performance evidence for the user.

- [ ] **Step 1: Write failing visual anatomy assertions**

Before screenshot capture, assert the professional node and structured status are present in test mode:

```ts
const visibleNode = page.locator('[data-testid="canvas-node-card"]').first();
await expect(visibleNode).toBeVisible();
await expect(visibleNode).toHaveAttribute('data-node-kind', /.+/);
await expect(visibleNode.locator('.canvas-node__footer')).toBeVisible();

const knowledge = page.locator('[data-knowledge-status]').first();
await expect(knowledge).toBeVisible();
await expect(knowledge.getByTestId('knowledge-status-detail')).toBeVisible();
```

Add bounding-box checks that node title/footer content stays inside the node and the placement inspector stays inside the workbench at all three viewports.

- [ ] **Step 2: Run the visual spec and verify RED before Tasks 1-3 are present**

```powershell
npm run e2e -- tests/e2e/visual-layout.spec.ts
```

Expected: FAIL when the new node/status anatomy is missing. If Tasks 1-3 have already landed, demonstrate RED by adding the assertions before the final missing visual hook, then implement that hook minimally.

- [ ] **Step 3: Complete only the missing test hooks or CSS containment fixes**

Do not add new product behavior. Use stable dimensions, `minmax(0, 1fr)`, text overflow rules, and fixed control tracks to correct clipping or overlap found by the test.

- [ ] **Step 4: Run focused renderer verification**

```powershell
npm test -- apps/renderer/src/canvas apps/renderer/src/agent apps/renderer/src/placement apps/renderer/src/jobs apps/renderer/src/references apps/renderer/src/history
npm run typecheck
npm run build -w @agent-canvas/renderer
```

Expected: focused renderer tests, the root repository typecheck, and the renderer build PASS. Existing Vite chunk warning may remain; no new error is allowed.

- [ ] **Step 5: Run current visual acceptance with fresh screenshots**

```powershell
npm run e2e -- tests/e2e/visual-layout.spec.ts
```

Expected: 3 passed for 1440x900, 1920x1080, and 1366x768. Screenshots must show no blank area, clipped text, incoherent overlap, or layout shift. Median pan/zoom interval remains below 150 ms in the conservative local renderer test.

- [ ] **Step 6: Run the full renderer workflow acceptance**

```powershell
npm run e2e
npm run scan:e2e
git diff --check
```

Expected: 7 e2e tests pass, secret/path scan passes, and diff check has no whitespace error. Full repository build/package verification remains deferred until Task 10C is resolved; do not run pack.

- [ ] **Step 7: Update automated renderer evidence only**

In `docs/testing/windows-compatibility-matrix.md`, update the automated renderer layout row with the 2026-07-17 command evidence and screenshot sizes. Keep Windows 7/11, Figma editable, portable, and installer rows pending.

- [ ] **Step 8: Self-review and commit only Task 4 files**

```powershell
git add -- tests/e2e/visual-layout.spec.ts tests/e2e/helpers/app.ts docs/testing/windows-compatibility-matrix.md
git commit -m "test: verify professional workbench visuals"
```

---

## Final Review Gate

After Task 4:

1. Generate one review package for the full UI range starting from `35b84a3`.
2. Dispatch an independent reviewer on the most capable available model.
3. Require `Spec Compliance: pass`, `Task Quality: Approved`, and no Critical/Important findings.
4. Fix and re-review any Critical/Important issue.
5. Inspect the fresh 1440x900 screenshot and at least one wide/short viewport screenshot with the image viewer.
6. Start the renderer dev server and give the user the local URL for hands-on testing.
7. Preserve the Task 10C dirty files and resume that task only after the UI task is cleanly committed and reviewed.