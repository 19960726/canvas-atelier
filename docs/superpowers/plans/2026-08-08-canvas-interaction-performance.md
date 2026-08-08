# Canvas Interaction Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep drag, selection, pan, zoom, and media-heavy canvases responsive without replacing React Flow.

**Architecture:** Coalesce transient position/viewport changes once per animation frame, preserve node object identity through structural reconciliation, and reduce media/MiniMap work during active interaction. Durable project commits remain confined to stable boundaries such as pointer-up.

**Tech Stack:** React 19, Zustand, React Flow, TypeScript, Vitest, Playwright PerformanceObserver.

## Execution Prerequisite

Complete and user-approve docs/superpowers/plans/2026-08-08-comfly-relayme-multi-provider-integration.md before executing this plan.

## Global Constraints

- No Canvas/WebGL rewrite.
- No project commit during pointermove, pan, zoom, selection preview, or connection preview.
- Selected, dragged, and connected endpoint nodes must never disappear through culling.
- 300 nodes, 500 edges, and 80 media assets are the required stress fixture.
- Report measured stalls honestly; target maximum long task below 100ms.

---

### Task 1: Coalesce draft node changes

**Files:**
- Modify: `apps/renderer/src/canvas/use-canvas-draft.ts`
- Modify: `apps/renderer/src/canvas/use-canvas-draft.test.tsx`

**Interfaces:**
- Produces: existing `onNodesChange(changes)` API with one React state publication per animation frame.
- Preserves: `onNodeDragStop` batch commit API.

- [ ] **Step 1: Write a failing rAF coalescing test**

Mock `requestAnimationFrame`, call `onNodesChange` three times with positions 20, 40, and 60, and assert no state publication until the frame runs; after the frame, the node position must be 60.

- [ ] **Step 2: Verify RED**

Run: `npm.cmd test -- apps/renderer/src/canvas/use-canvas-draft.test.tsx -t "coalesces drag position changes"`
Expected: FAIL because current code calls `setNodes` on every event.

- [ ] **Step 3: Implement a pending-change queue**

Add `pendingChangesRef` and `changeFrameRef`. Merge changes by node ID/type and execute one `setNodes(current => applyNodeChanges(merged, current))` in `requestAnimationFrame`. Flush pending changes synchronously at the start of `onNodeDragStop`, and cancel a pending frame on unmount.

- [ ] **Step 4: Verify GREEN and existing commit behavior**

Run: `npm.cmd test -- apps/renderer/src/canvas/use-canvas-draft.test.tsx`
Expected: all tests pass and position commits still occur once on drag stop.

- [ ] **Step 5: Commit**

```powershell
git add -- apps/renderer/src/canvas/use-canvas-draft.ts apps/renderer/src/canvas/use-canvas-draft.test.tsx
git commit -m "perf: coalesce canvas draft updates"
```

### Task 2: Preserve unchanged flow-node identity

**Files:**
- Create: `apps/renderer/src/canvas/reconcile-flow-elements.ts`
- Create: `apps/renderer/src/canvas/reconcile-flow-elements.test.ts`
- Modify: `apps/renderer/src/canvas/CanvasWorkspace.tsx`
- Modify: `apps/renderer/src/canvas/node-types.tsx`

**Interfaces:**
- Produces: `reconcileFlowNodes(previous: readonly Node[], next: readonly Node[]): Node[]`.
- Consumes: candidate nodes from `toFlowNodes`.

- [ ] **Step 1: Write failing structural-sharing tests**

```ts
expect(reconcileFlowNodes(previous, equivalent)[0]).toBe(previous[0]);
expect(reconcileFlowNodes(previous, moved)[0]).not.toBe(previous[0]);
expect(reconcileFlowNodes(previous, changedRuntimeData)[1]).not.toBe(previous[1]);
```

Cover primitive data, stable callback references, and equal connected-port arrays.

- [ ] **Step 2: Verify RED**

Run: `npm.cmd test -- apps/renderer/src/canvas/reconcile-flow-elements.test.ts`
Expected: FAIL because the helper does not exist.

- [ ] **Step 3: Implement shallow structural reconciliation**

Compare `id`, `type`, position, draggable/selectable/selected state, className, dimensions, and shallow data values. Treat arrays as equal when their primitive members match in order. Reuse the previous node object only when every rendered property is equivalent.

- [ ] **Step 4: Wire it into CanvasWorkspace**

Store the prior candidate array in a ref:

```tsx
const previousFlowNodesRef = useRef<readonly Node[]>([]);
const reconciledFlowNodes = useMemo(() => {
  const next = reconcileFlowNodes(previousFlowNodesRef.current, flowNodeState.nodes);
  previousFlowNodesRef.current = next;
  return next;
}, [flowNodeState.nodes]);
```

Pass reconciled nodes to `useCanvasDraft`. Wrap `ModuleNodeCard` in `memo` through a `SharedModuleNode` entry in `nodeTypes` so stable node data skips rendering.

- [ ] **Step 5: Verify and commit**

Run: `npm.cmd test -- apps/renderer/src/canvas/reconcile-flow-elements.test.ts apps/renderer/src/canvas/CanvasWorkspace.test.tsx apps/renderer/src/canvas/node-types.test.ts`
Expected: all pass.

```powershell
git add -- apps/renderer/src/canvas/reconcile-flow-elements.ts apps/renderer/src/canvas/reconcile-flow-elements.test.ts apps/renderer/src/canvas/CanvasWorkspace.tsx apps/renderer/src/canvas/node-types.tsx
git commit -m "perf: preserve unchanged flow nodes"
```

### Task 3: Interaction-aware rendering

**Files:**
- Create: `apps/renderer/src/canvas/use-canvas-interaction-state.ts`
- Create: `apps/renderer/src/canvas/use-canvas-interaction-state.test.ts`
- Modify: `apps/renderer/src/canvas/CanvasWorkspace.tsx`
- Modify: `apps/renderer/src/styles/figma-hybrid-canvas.css`

**Interfaces:**
- Produces: `{ interacting: boolean; markInteraction(): void; finishInteraction(): void }`.
- Consumes: React Flow move/drag/selection/connection lifecycle events.

- [ ] **Step 1: Write failing lifecycle tests**

Verify `markInteraction()` sets true immediately, repeated calls reuse one idle timer, and `finishInteraction()` clears the state after two animation frames.

- [ ] **Step 2: Verify RED**

Run: `npm.cmd test -- apps/renderer/src/canvas/use-canvas-interaction-state.test.ts`
Expected: FAIL because the hook does not exist.

- [ ] **Step 3: Implement and wire the hook**

Set `data-canvas-interacting="true"` on `canvas-stage` during pan, zoom, drag, selection, and connection preview. Use move/drag start to mark, and move/drag/connect end to finish.

- [ ] **Step 4: Add interaction-only CSS reductions**

While interacting:

```css
.canvas-stage[data-canvas-interacting='true'] .react-flow__minimap { visibility: hidden; }
.canvas-stage[data-canvas-interacting='true'] :is(img, video) { image-rendering: auto; }
.canvas-stage[data-canvas-interacting='true'] .module-node { transition: none !important; box-shadow: none !important; }
```

Do not hide nodes, ports, active edges, or selection rectangles.

- [ ] **Step 5: Verify and commit**

Run: `npm.cmd test -- apps/renderer/src/canvas/use-canvas-interaction-state.test.ts apps/renderer/src/canvas/CanvasWorkspace.test.tsx`
Expected: all pass.

```powershell
git add -- apps/renderer/src/canvas/use-canvas-interaction-state.ts apps/renderer/src/canvas/use-canvas-interaction-state.test.ts apps/renderer/src/canvas/CanvasWorkspace.tsx apps/renderer/src/styles/figma-hybrid-canvas.css
git commit -m "perf: reduce canvas work during interaction"
```

### Task 4: Media decode and lookup costs

**Files:**
- Create: `apps/renderer/src/canvas/media-summary-index.ts`
- Create: `apps/renderer/src/canvas/media-summary-index.test.ts`
- Modify: `apps/renderer/src/canvas/CanvasWorkspace.tsx`
- Modify: `apps/renderer/src/canvas/ModuleNodeCard.tsx`
- Modify: `apps/renderer/src/canvas/ConnectedAgentMediaSlots.tsx`

**Interfaces:**
- Produces: `createMediaSummaryIndex(images, videos)` returning `getImage(assetId)` and `getVideo(assetId)`.
- Consumes: project image/video summary arrays.

- [ ] **Step 1: Write failing lookup and media-attribute tests**

Verify duplicate IDs resolve deterministically, missing IDs return undefined, thumbnail images use `loading="lazy" decoding="async"`, and video thumbnails use `preload="none"` with an available poster.

- [ ] **Step 2: Verify RED**

Run: `npm.cmd test -- apps/renderer/src/canvas/media-summary-index.test.ts apps/renderer/src/canvas/ConnectedAgentMediaSlots.test.tsx apps/renderer/src/canvas/ModuleNodeCard.test.tsx`
Expected: FAIL because lookups currently call `.find` and video thumbnails preload metadata.

- [ ] **Step 3: Implement cached indexes and lightweight media attributes**

Build maps once in `CanvasWorkspace`, expose them through stable module runtime context, and replace repeated `.find` calls in per-node tray rendering. Add `loading="lazy" decoding="async" draggable={false}` to thumbnails and `preload="none"` to non-playing video slots.

- [ ] **Step 4: Verify GREEN and commit**

Run the command from Step 2.
Expected: all tests pass.

```powershell
git add -- apps/renderer/src/canvas/media-summary-index.ts apps/renderer/src/canvas/media-summary-index.test.ts apps/renderer/src/canvas/CanvasWorkspace.tsx apps/renderer/src/canvas/ModuleNodeCard.tsx apps/renderer/src/canvas/ConnectedAgentMediaSlots.tsx
git commit -m "perf: cache media lookups and defer decoding"
```

### Task 5: Stress verification

**Files:**
- Modify: `tests/e2e/durable-canvas-stress.spec.ts`
- Modify: `tests/e2e/helpers/app.ts`
- Modify: `tests/integration/large-canvas.test.ts`

**Interfaces:**
- Consumes: performance changes from Tasks 1–4.
- Produces: measured evidence for selection, drag, pan, zoom, connection preview, and marquee selection.

- [ ] **Step 1: Add marquee selection and frame-count evidence**

Extend the stress test to left-drag an empty pane rectangle across multiple nodes, assert no durable commit occurs, and record both long-task maximum and animation-frame interval.

- [ ] **Step 2: Run the stress suite**

Run:

```powershell
$env:NOVUS_E2E_PORT='43172'; npm.cmd run e2e -- tests/e2e/durable-canvas-stress.spec.ts
npm.cmd test -- tests/integration/large-canvas.test.ts
```

Expected: all six viewport/theme combinations complete; attach JSON evidence. Target `maxStallMs < 100`; if hardware exceeds it, report the measured value and failing operation.

- [ ] **Step 3: Run full type and focused regression checks**

```powershell
npm.cmd run typecheck
npm.cmd test -- apps/renderer/src/canvas/use-canvas-draft.test.tsx apps/renderer/src/canvas/use-viewport-culling.test.ts apps/renderer/src/canvas/reconcile-flow-elements.test.ts apps/renderer/src/canvas/use-canvas-interaction-state.test.ts apps/renderer/src/canvas/CanvasWorkspace.test.tsx tests/integration/large-canvas.test.ts
```

Expected: exit 0.

- [ ] **Step 4: Commit performance evidence updates**

```powershell
git add -- tests/e2e/durable-canvas-stress.spec.ts tests/e2e/helpers/app.ts tests/integration/large-canvas.test.ts
git commit -m "test: enforce canvas interaction performance"
```