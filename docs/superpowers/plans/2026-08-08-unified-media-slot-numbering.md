# Unified Media Slot Numbering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every real image/video slot in generation, reverse analysis, and Agent chat show a readable `1–20` order badge that updates after reordering.

**Architecture:** Add one presentation-only `MediaSlotOrderBadge` component and use it in every media tray. The ordered media arrays remain the source of truth; badge numbers are derived from the current array index and are never persisted.

**Tech Stack:** React 19, TypeScript, Vitest, Testing Library, Playwright, CSS.

## Execution Prerequisite

Complete and user-approve docs/superpowers/plans/2026-08-08-comfly-relayme-multi-provider-integration.md before executing this plan.

## Global Constraints

- Support exactly 1 through 20 real media references.
- Empty/pending slots do not display a real order badge.
- Light and dark themes use identical badge geometry and high-contrast white text.
- Preserve original media identity when reordering; only edge/order state changes.
- Do not modify unrelated dirty-worktree files.

---

### Task 1: Shared order badge

**Files:**
- Create: `apps/renderer/src/canvas/MediaSlotOrderBadge.tsx`
- Create: `apps/renderer/src/canvas/MediaSlotOrderBadge.test.tsx`
- Modify: `apps/renderer/src/styles/figma-hybrid-canvas.css`

**Interfaces:**
- Produces: `MediaSlotOrderBadge({ position }: { readonly position: number }): JSX.Element`
- Consumes: one-based position from an ordered media array.

- [ ] **Step 1: Write the failing component and CSS-contract tests**

```tsx
it.each([1, 9, 10, 20])('renders media order %s', (position) => {
  render(<MediaSlotOrderBadge position={position} />);
  expect(screen.getByLabelText(`素材序号 ${position}`)).toHaveTextContent(String(position));
});

it('uses a fixed high-contrast badge instead of an undefined theme token', () => {
  const css = readFileSync('apps/renderer/src/styles/figma-hybrid-canvas.css', 'utf8');
  const rule = css.match(/\.module-node__media-slot-order\s*\{[^}]+\}/u)?.[0] ?? '';
  expect(rule).toContain('color: #fff');
  expect(rule).toContain('background: #10181b');
  expect(rule).toContain('font-variant-numeric: tabular-nums');
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm.cmd test -- apps/renderer/src/canvas/MediaSlotOrderBadge.test.tsx`
Expected: FAIL because `MediaSlotOrderBadge.tsx` does not exist.

- [ ] **Step 3: Add the minimal component**

```tsx
export function MediaSlotOrderBadge({ position }: { readonly position: number }) {
  if (!Number.isInteger(position) || position < 1 || position > 20) return null;
  return <small className="module-node__media-slot-order" aria-label={`素材序号 ${position}`}>{position}</small>;
}
```

Add a terminal CSS rule with explicit colors, `min-width: 14px`, `height: 14px`, centered grid layout, `z-index: 5`, and `font-size: 8px`.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `npm.cmd test -- apps/renderer/src/canvas/MediaSlotOrderBadge.test.tsx`
Expected: 5 tests pass.

- [ ] **Step 5: Commit only this task**

```powershell
git add -- apps/renderer/src/canvas/MediaSlotOrderBadge.tsx apps/renderer/src/canvas/MediaSlotOrderBadge.test.tsx apps/renderer/src/styles/figma-hybrid-canvas.css
git commit -m "fix: add readable media slot order badges"
```

### Task 2: Replace tray-specific number markup

**Files:**
- Modify: `apps/renderer/src/canvas/ConnectedAgentMediaSlots.tsx`
- Modify: `apps/renderer/src/canvas/ConnectedAgentMediaSlots.test.tsx`
- Modify: `apps/renderer/src/canvas/ModuleNodeCard.tsx`
- Modify: `apps/renderer/src/canvas/ModuleNodeCard.test.tsx`
- Modify: `apps/renderer/src/agent/SkillChatWorkbench.tsx`
- Modify: `apps/renderer/src/agent/SkillChatWorkbench.test.tsx`

**Interfaces:**
- Consumes: `MediaSlotOrderBadge` from Task 1.
- Produces: the same badge DOM in image generation, video generation, reverse Agent, and Agent selected-reference trays.

- [ ] **Step 1: Add failing integration tests**

```tsx
expect(within(screen.getByLabelText('Image generation reference slots')).getByLabelText('素材序号 1')).toBeVisible();
expect(within(screen.getByLabelText('Connected video media')).getByLabelText('素材序号 1')).toBeVisible();
expect(within(screen.getByLabelText('Connected reverse media slots')).getByLabelText('素材序号 1')).toBeVisible();
expect(within(screen.getByLabelText('Selected image references')).getByLabelText('素材序号 1')).toBeVisible();
```

Add a 20-item reverse tray test that expects `素材序号 20` and verifies no `素材序号 21` exists.

- [ ] **Step 2: Run tests and verify RED**

Run: `npm.cmd test -- apps/renderer/src/canvas/ConnectedAgentMediaSlots.test.tsx apps/renderer/src/canvas/ModuleNodeCard.test.tsx apps/renderer/src/agent/SkillChatWorkbench.test.tsx`
Expected: FAIL because the current `<small>` nodes have no shared class or accessible order label.

- [ ] **Step 3: Replace each raw `<small>{index + 1}</small>`**

```tsx
<MediaSlotOrderBadge position={index + 1} />
```

For the Agent selected-reference tray, derive the position from the displayed ordered citation array. Do not add a badge to pending placeholders.

- [ ] **Step 4: Run tests and verify GREEN**

Run the same command from Step 2.
Expected: all existing tests plus the new numbering tests pass.

- [ ] **Step 5: Commit only this task**

```powershell
git add -- apps/renderer/src/canvas/ConnectedAgentMediaSlots.tsx apps/renderer/src/canvas/ConnectedAgentMediaSlots.test.tsx apps/renderer/src/canvas/ModuleNodeCard.tsx apps/renderer/src/canvas/ModuleNodeCard.test.tsx apps/renderer/src/agent/SkillChatWorkbench.tsx apps/renderer/src/agent/SkillChatWorkbench.test.tsx
git commit -m "fix: unify media numbering across canvas and Agent"
```

### Task 3: Reordering and visual acceptance

**Files:**
- Modify: `apps/renderer/src/canvas/ConnectedAgentMediaSlots.test.tsx`
- Modify: `tests/e2e/agent-multi-video-media.spec.ts`
- Modify: `tests/e2e/video-generation-ui.spec.ts`

**Interfaces:**
- Consumes: shared badges from Tasks 1–2.
- Produces: browser evidence that order badges follow current media order.

- [ ] **Step 1: Write a failing reorder test**

Create 20 slot items, drag item 20 onto item 1, and assert the reordered callback begins with asset 20 while the rendered first badge remains `素材序号 1` after rerender.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm.cmd test -- apps/renderer/src/canvas/ConnectedAgentMediaSlots.test.tsx`
Expected: FAIL until the test rerenders using the reordered array and the shared badge is present.

- [ ] **Step 3: Make the minimal reorder adjustments**

Keep `assetId` as the drag identity, call `onReorder(next)`, and let the parent-provided array determine numbering. Do not store badge numbers in component state.

- [ ] **Step 4: Run unit and browser checks**

Run:

```powershell
npm.cmd test -- apps/renderer/src/canvas/MediaSlotOrderBadge.test.tsx apps/renderer/src/canvas/ConnectedAgentMediaSlots.test.tsx apps/renderer/src/canvas/ModuleNodeCard.test.tsx apps/renderer/src/agent/SkillChatWorkbench.test.tsx
$env:NOVUS_E2E_PORT='43171'; npm.cmd run e2e -- tests/e2e/agent-multi-video-media.spec.ts tests/e2e/video-generation-ui.spec.ts
```

Expected: unit tests pass; light/dark screenshots show visible numbers 1 and 10+ without clipping.

- [ ] **Step 5: Commit browser acceptance updates**

```powershell
git add -- tests/e2e/agent-multi-video-media.spec.ts tests/e2e/video-generation-ui.spec.ts apps/renderer/src/canvas/ConnectedAgentMediaSlots.test.tsx
git commit -m "test: verify ordered media badges"
```