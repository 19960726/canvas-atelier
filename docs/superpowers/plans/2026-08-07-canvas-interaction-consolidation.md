# Canvas Interaction Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the current Figma UI Gate canvas open blank and provide consistent marquee selection, generation-node expansion, media upload, transient popover, reverse-result, and left-rail behavior without restoring legacy UI.

**Architecture:** Keep React Flow as the interaction engine. Centralize temporary UI ownership in focused state modules: selection persistence in `use-canvas-draft`, generation editor focus in a shared reducer, and popovers in one workspace-level controller. Separate browser file selection from the desktop managed-asset bridge so the manual acceptance harness can use a real picker even when it exposes a mocked desktop object.

**Tech Stack:** React 19, TypeScript, Zustand, `@xyflow/react` 12, Vitest, Testing Library, Playwright, Electron preload bridge.

## Global Constraints

- First launch/new project contains zero starter nodes; persisted projects retain their nodes and edges.
- Blank-canvas left drag is marquee selection; pan uses `Space + left drag` or middle mouse.
- Intersecting unlocked nodes select; locked nodes are excluded from group move/delete.
- Image/video generation cards share click-to-expand and blank-click-to-collapse behavior.
- Double-clicking generated media opens original-ratio preview only and never changes canvas zoom.
- Expanded video always shows `生成视频`; an active job shows `停止生成`.
- Browser acceptance accepts PNG/JPEG/WebP/GIF through a real file picker.
- Desktop managed import, image clipboard, and MP4 clipboard remain isolated.
- Only one temporary popover may be open; knowledge/model triggers remain under Agent composer.
- Reverse result shows analysis, prompt, and copy only.
- Do not restore the legacy theme selector or starter workflow.

---

### Task 1: Blank project contract

**Files:**
- Modify: `apps/renderer/src/app/app-store.ts`
- Modify: `apps/renderer/src/app/app-store.test.ts`
- Modify: `apps/renderer/src/canvas/CanvasWorkspace.test.tsx`
- Test: `tests/e2e/clean-startup-module-activation.spec.ts`

**Interfaces:**
- Produces: `createBlankCanvasProject(now?: string): Project` for first launch and explicit new-project creation.
- Preserves: persisted-project hydration/migration without injecting example nodes.

- [ ] **Step 1: Write failing store tests**

```ts
it('creates a true blank project', () => {
  const project = createBlankCanvasProject('2026-08-07T00:00:00.000Z');
  expect(project.nodes).toEqual([]);
  expect(project.edges).toEqual([]);
});

it('keeps a persisted empty project empty', async () => {
  persistence.openProject.mockResolvedValue({ project: emptyProject, revision: 4 });
  await useAppStore.getState().openProject();
  expect(useAppStore.getState().project.nodes).toEqual([]);
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `npm.cmd test -- apps/renderer/src/app/app-store.test.ts apps/renderer/src/canvas/CanvasWorkspace.test.tsx`

Expected: FAIL where current initialization or test fixtures inject starter modules.

- [ ] **Step 3: Implement the blank factory and replace only initial/new-project creation**

```ts
export function createBlankCanvasProject(now = new Date().toISOString()): Project {
  return {
    schemaVersion: CURRENT_PROJECT_SCHEMA_VERSION,
    projectId: createProjectId(),
    title: '未命名项目',
    createdAt: now,
    updatedAt: now,
    nodes: [],
    edges: [],
  };
}
```

Do not call it from hydration or migration.

- [ ] **Step 4: Add E2E assertions**

```ts
await expect(page.getByTestId('canvas-stage')).toHaveAttribute('data-graph-node-count', '0');
await expect(page.getByText('双击空白处添加模块')).toBeVisible();
```

- [ ] **Step 5: Verify and commit**

Run: `npm.cmd test -- apps/renderer/src/app/app-store.test.ts apps/renderer/src/canvas/CanvasWorkspace.test.tsx`

Run: `npx.cmd playwright test tests/e2e/clean-startup-module-activation.spec.ts --project=chromium`

Expected: PASS.

```bash
git add apps/renderer/src/app/app-store.ts apps/renderer/src/app/app-store.test.ts apps/renderer/src/canvas/CanvasWorkspace.test.tsx tests/e2e/clean-startup-module-activation.spec.ts
git commit -m "fix: start canvas projects without template nodes"
```

### Task 2: Marquee selection and durable group actions

**Files:**
- Modify: `apps/renderer/src/canvas/CanvasWorkspace.tsx`
- Modify: `apps/renderer/src/canvas/CanvasWorkspace.test.tsx`
- Modify: `apps/renderer/src/canvas/use-canvas-draft.ts`
- Modify: `apps/renderer/src/canvas/use-canvas-draft.test.tsx`
- Modify: `apps/renderer/src/app/app-store.ts`
- Modify: `apps/renderer/src/app/app-store.test.ts`
- Test: `tests/e2e/durable-canvas-stress.spec.ts`

**Interfaces:**
- Replaces: `onCommitPosition(nodeId, position)`.
- Produces: `onCommitPositions(updates: readonly { nodeId: string; position: XYPosition }[]): Promise<boolean>`.
- React Flow settings: `selectionOnDrag`, `SelectionMode.Partial`, `multiSelectionKeyCode="Shift"`, `panActivationKeyCode="Space"`, middle-button panning.

- [ ] **Step 1: Write failing group-drag and locked-node tests**

```ts
expect(onCommitPositions).toHaveBeenCalledWith([
  { nodeId: 'image-1', position: { x: 120, y: 80 } },
  { nodeId: 'video-1', position: { x: 420, y: 80 } },
]);
expect(onCommitPositions.mock.calls[0][0]).not.toContainEqual(
  expect.objectContaining({ nodeId: 'locked-1' }),
);
```

Add store tests proving multi-delete removes unlocked selected nodes and their edges in one transaction while preserving locked nodes.

- [ ] **Step 2: Run and confirm failure**

Run: `npm.cmd test -- apps/renderer/src/canvas/use-canvas-draft.test.tsx apps/renderer/src/app/app-store.test.ts`

Expected: FAIL because only the drag leader is committed and locked filtering is incomplete.

- [ ] **Step 3: Implement batch position persistence**

```ts
export interface CanvasDraftOptions<TNode extends Node = Node> {
  nodes: readonly TNode[];
  onCommitPositions: (
    updates: readonly { readonly nodeId: string; readonly position: XYPosition }[],
  ) => Promise<boolean>;
}
```

Collect all selected, moved, unlocked nodes from the final draft state; maintain pending tokens per node; reconcile after the single batch promise settles.

- [ ] **Step 4: Configure React Flow**

```tsx
<ReactFlow
  selectionOnDrag
  selectionMode={SelectionMode.Partial}
  panOnDrag={[1]}
  panActivationKeyCode="Space"
  multiSelectionKeyCode="Shift"
/>
```

Keep wheel zoom. Pane click clears selection and temporary UI without calling zoom helpers.

- [ ] **Step 5: Add E2E coverage and verify**

Marquee two unlocked nodes plus one locked node, group-drag, reload, and assert only unlocked positions persisted. Verify Shift toggles selection and Delete ignores locked nodes.

Run: `npm.cmd test -- apps/renderer/src/canvas/CanvasWorkspace.test.tsx apps/renderer/src/canvas/use-canvas-draft.test.tsx apps/renderer/src/app/app-store.test.ts`

Run: `npx.cmd playwright test tests/e2e/durable-canvas-stress.spec.ts --project=chromium`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/renderer/src/canvas/CanvasWorkspace.tsx apps/renderer/src/canvas/CanvasWorkspace.test.tsx apps/renderer/src/canvas/use-canvas-draft.ts apps/renderer/src/canvas/use-canvas-draft.test.tsx apps/renderer/src/app/app-store.ts apps/renderer/src/app/app-store.test.ts tests/e2e/durable-canvas-stress.spec.ts
git commit -m "feat: add durable marquee group selection"
```

### Task 3: Unified generation editor focus and video action

**Files:**
- Create: `apps/renderer/src/canvas/generation-editor-state.ts`
- Create: `apps/renderer/src/canvas/generation-editor-state.test.ts`
- Modify: `apps/renderer/src/canvas/ModuleNodeCard.tsx`
- Modify: `apps/renderer/src/canvas/ModuleNodeCard.test.tsx`
- Modify: `apps/renderer/src/canvas/CanvasWorkspace.tsx`
- Test: `tests/e2e/video-generation-ui.spec.ts`

**Interfaces:**
- Produces: `GenerationEditorState = { expandedNodeId: string | null }` and reducer actions `open`, `canvas-click`, `escape`.
- Both image/video summaries consume `expanded` and `onRequestExpand`.

- [ ] **Step 1: Write failing reducer/card tests**

```ts
expect(reduceGenerationEditorState(initial, { type: 'open', nodeId: 'video-1' }))
  .toEqual({ expandedNodeId: 'video-1' });
expect(reduceGenerationEditorState(open, { type: 'canvas-click' }))
  .toEqual({ expandedNodeId: null });
```

Click image/video card bodies and expect prompt controls. Click controls and expect the editor to remain open. Double-click preview and expect only the original-ratio viewer.

- [ ] **Step 2: Run and confirm failure**

Run: `npm.cmd test -- apps/renderer/src/canvas/generation-editor-state.test.ts apps/renderer/src/canvas/ModuleNodeCard.test.tsx`

Expected: FAIL before shared ownership exists.

- [ ] **Step 3: Implement shared state and remove per-summary expansion flags**

```ts
export type GenerationEditorAction =
  | { readonly type: 'open'; readonly nodeId: string }
  | { readonly type: 'canvas-click' }
  | { readonly type: 'escape' };

export function reduceGenerationEditorState(
  state: GenerationEditorState,
  action: GenerationEditorAction,
): GenerationEditorState {
  return action.type === 'open' ? { expandedNodeId: action.nodeId } : { expandedNodeId: null };
}
```

Stop propagation only for controls/ports. Remove the custom global collapse event after workspace ownership is wired.

- [ ] **Step 4: Implement the video primary action**

```tsx
<button
  type="button"
  className="module-node__generate-action nodrag"
  disabled={!canRun && !isRunning}
  onClick={isRunning ? () => onCancel(activeJobId!) : () => void onRun(id, request)}
>
  {isRunning ? '停止生成' : '生成视频'}
</button>
```

Keep it visible when disabled and show the missing requirement nearby. Collapsed previews render no bottom action buttons.

- [ ] **Step 5: Verify and commit**

Run: `npm.cmd test -- apps/renderer/src/canvas/generation-editor-state.test.ts apps/renderer/src/canvas/ModuleNodeCard.test.tsx apps/renderer/src/canvas/CanvasWorkspace.test.tsx`

Run: `npx.cmd playwright test tests/e2e/video-generation-ui.spec.ts tests/e2e/visual-layout.spec.ts --project=chromium`

Expected: PASS in light/dark; node click leaves viewport zoom unchanged.

```bash
git add apps/renderer/src/canvas/generation-editor-state.ts apps/renderer/src/canvas/generation-editor-state.test.ts apps/renderer/src/canvas/ModuleNodeCard.tsx apps/renderer/src/canvas/ModuleNodeCard.test.tsx apps/renderer/src/canvas/CanvasWorkspace.tsx tests/e2e/video-generation-ui.spec.ts
git commit -m "fix: unify generation node expansion and actions"
```

### Task 4: Explicit browser/manual media picker

**Files:**
- Create: `apps/renderer/src/app/media-import-capability.ts`
- Create: `apps/renderer/src/app/media-import-capability.test.ts`
- Modify: `apps/renderer/src/canvas/ModuleNodeCard.tsx`
- Modify: `apps/renderer/src/canvas/ModuleNodeCard.test.tsx`
- Modify: `apps/renderer/src/app/app-store.ts`
- Modify: `apps/renderer/src/app/app-store.test.ts`
- Modify: `apps/renderer/src/test-mode/e2e-harness.ts`
- Test: `tests/e2e/module-library-workflow.spec.ts`

**Interfaces:**
- Produces: `resolveMediaImportMode({ desktopBridge, manualAcceptance }): 'browser-picker' | 'desktop-managed'`.
- Harness exposes `window.__NOVUS_MANUAL_ACCEPTANCE__ = true`; bridge presence alone does not select native import.

- [ ] **Step 1: Write failing capability and file-input tests**

```ts
expect(resolveMediaImportMode({ desktopBridge: mockBridge, manualAcceptance: true }))
  .toBe('browser-picker');
expect(resolveMediaImportMode({ desktopBridge: mockBridge, manualAcceptance: false }))
  .toBe('desktop-managed');
```

Upload `new File([pngBytes], 'sample.png', { type: 'image/png' })` while a mock desktop bridge exists and assert `onImport(file)`.

- [ ] **Step 2: Run and confirm failure**

Run: `npm.cmd test -- apps/renderer/src/app/media-import-capability.test.ts apps/renderer/src/canvas/ModuleNodeCard.test.tsx apps/renderer/src/app/app-store.test.ts`

Expected: FAIL because `chooseFile()` follows mocked native import.

- [ ] **Step 3: Implement capability resolution and picker details**

```ts
export function resolveMediaImportMode(input: {
  readonly desktopBridge: typeof window.novusDesktop;
  readonly manualAcceptance: boolean;
}): 'browser-picker' | 'desktop-managed' {
  return input.manualAcceptance || input.desktopBridge === undefined
    ? 'browser-picker'
    : 'desktop-managed';
}
```

Use `accept="image/png,image/jpeg,image/webp,image/gif"`; reset input value after change. Provide explicit Chinese errors for MIME, size/read, persistence, and preview failures. Cancel is silent.

- [ ] **Step 4: Prove clipboard isolation**

Add tests asserting picker import never calls `pasteClipboardImage` or `pasteClipboardVideo`; retain the desktop bridge tests for both adapters.

- [ ] **Step 5: Verify and commit**

Run: `npm.cmd test -- apps/renderer/src/app/media-import-capability.test.ts apps/renderer/src/canvas/ModuleNodeCard.test.tsx apps/renderer/src/app/app-store.test.ts packages/desktop-core/src/project-image-bridge.test.ts packages/desktop-core/src/project-video-bridge.test.ts`

Run: `npx.cmd playwright test tests/e2e/module-library-workflow.spec.ts --project=chromium`

Expected: PASS with the image visible in its source node and connected slot.

```bash
git add apps/renderer/src/app/media-import-capability.ts apps/renderer/src/app/media-import-capability.test.ts apps/renderer/src/canvas/ModuleNodeCard.tsx apps/renderer/src/canvas/ModuleNodeCard.test.tsx apps/renderer/src/app/app-store.ts apps/renderer/src/app/app-store.test.ts apps/renderer/src/test-mode/e2e-harness.ts tests/e2e/module-library-workflow.spec.ts
git commit -m "fix: use real browser picker in manual acceptance mode"
```

### Task 5: One transient-popover coordinator

**Files:**
- Create: `apps/renderer/src/app/transient-popover.ts`
- Create: `apps/renderer/src/app/transient-popover.test.ts`
- Modify: `apps/renderer/src/canvas/CanvasWorkspace.tsx`
- Modify: `apps/renderer/src/canvas/QuickInsert.tsx`
- Modify: `apps/renderer/src/agent/ImageMentionComposer.tsx`
- Modify: `apps/renderer/src/agent/ReversePromptAgent.tsx`
- Modify: `apps/renderer/src/agent/ReversePromptAgent.test.tsx`
- Test: `tests/e2e/current-agent-knowledge-ui.spec.ts`
- Test: `tests/e2e/quick-insert-ui-gate.spec.ts`

**Interfaces:**
- Produces: `TransientPopoverId = 'knowledge' | 'model' | 'reference' | 'quick-insert' | 'project-menu' | null`.
- Child surfaces consume `open` and `onOpenChange`.

- [ ] **Step 1: Write failing exclusivity/closure tests**

```ts
expect(reduceTransientPopover('knowledge', { type: 'open', id: 'model' })).toBe('model');
expect(reduceTransientPopover('reference', { type: 'close-external' })).toBeNull();
expect(reduceTransientPopover('knowledge', { type: 'internal-interaction' })).toBe('knowledge');
```

- [ ] **Step 2: Run and confirm failure**

Run: `npm.cmd test -- apps/renderer/src/app/transient-popover.test.ts apps/renderer/src/agent/ReversePromptAgent.test.tsx`

Expected: FAIL before the coordinator exists.

- [ ] **Step 3: Implement the reducer and close matrix**

```ts
export type TransientPopoverAction =
  | { readonly type: 'open'; readonly id: Exclude<TransientPopoverId, null> }
  | { readonly type: 'toggle'; readonly id: Exclude<TransientPopoverId, null> }
  | { readonly type: 'close-external' }
  | { readonly type: 'internal-interaction' };
```

Close on canvas/node/topbar/rail/panel click, Escape, send, Agent tab switch/collapse, settings close, and completed selection. Keep open for internal search, filters, scroll, and multiselect. Keep model/knowledge triggers below composer.

- [ ] **Step 4: Verify and commit**

Run: `npm.cmd test -- apps/renderer/src/app/transient-popover.test.ts apps/renderer/src/agent/ReversePromptAgent.test.tsx apps/renderer/src/canvas/CanvasWorkspace.test.tsx`

Run: `npx.cmd playwright test tests/e2e/current-agent-knowledge-ui.spec.ts tests/e2e/quick-insert-ui-gate.spec.ts --project=chromium`

Expected: PASS in both themes with no residual overlay.

```bash
git add apps/renderer/src/app/transient-popover.ts apps/renderer/src/app/transient-popover.test.ts apps/renderer/src/canvas/CanvasWorkspace.tsx apps/renderer/src/canvas/QuickInsert.tsx apps/renderer/src/agent/ImageMentionComposer.tsx apps/renderer/src/agent/ReversePromptAgent.tsx apps/renderer/src/agent/ReversePromptAgent.test.tsx tests/e2e/current-agent-knowledge-ui.spec.ts tests/e2e/quick-insert-ui-gate.spec.ts
git commit -m "fix: coordinate temporary canvas popovers"
```

### Task 6: Reverse-result cleanup and left-rail geometry

**Files:**
- Modify: `apps/renderer/src/canvas/ModuleNodeCard.tsx`
- Modify: `apps/renderer/src/canvas/ModuleNodeCard.test.tsx`
- Modify: `apps/renderer/src/canvas/CanvasWorkspace.tsx`
- Modify: `apps/renderer/src/canvas/CanvasWorkspace.test.tsx`
- Modify: `apps/renderer/src/styles/figma-hybrid-canvas.css`
- Test: `tests/e2e/left-rail-figma.spec.ts`
- Test: `tests/e2e/visual-layout.spec.ts`

**Interfaces:**
- `ReverseResultPreview` consumes only `result`; remove `routes` and `onGenerateImage`.
- Rail has main/bottom groups; fixed-size buttons and `12px` internal gaps.

- [ ] **Step 1: Write failing cleanup/layout tests**

```ts
expect(screen.queryByText('生图模型')).not.toBeInTheDocument();
expect(screen.queryByText('生图节点')).not.toBeInTheDocument();
expect(screen.queryByRole('button', { name: '用结果生图' })).not.toBeInTheDocument();
```

Measure equal rail button boxes and 12px adjacent main-tool gaps in both themes.

- [ ] **Step 2: Run and confirm failure**

Run: `npm.cmd test -- apps/renderer/src/canvas/ModuleNodeCard.test.tsx apps/renderer/src/canvas/CanvasWorkspace.test.tsx`

Expected: FAIL while the duplicate generation section remains.

- [ ] **Step 3: Remove the entire reverse-result action section**

```tsx
function ReverseResultPreview({ result }: { result: ReversePromptResult | null }) {
  return (
    <section className="module-node__reverse-result">
      <ReverseAnalysis result={result} />
      <PromptResult result={result} />
      <CopyResultAction result={result} />
    </section>
  );
}
```

Delete related state, model/target selectors, footer divider, CSS, and hidden form.

- [ ] **Step 4: Normalize rail CSS**

```css
.toolrail__group { display: flex; flex-direction: column; gap: 12px; }
.toolrail__group--bottom { margin-top: auto; }
.tool-button { inline-size: 40px; block-size: 40px; flex: 0 0 40px; }
```

Do not use full-column `justify-content: space-between`.

- [ ] **Step 5: Verify and commit**

Run: `npm.cmd test -- apps/renderer/src/canvas/ModuleNodeCard.test.tsx apps/renderer/src/canvas/CanvasWorkspace.test.tsx`

Run: `npx.cmd playwright test tests/e2e/left-rail-figma.spec.ts tests/e2e/visual-layout.spec.ts --project=chromium`

Expected: PASS with fresh light/dark screenshots.

```bash
git add apps/renderer/src/canvas/ModuleNodeCard.tsx apps/renderer/src/canvas/ModuleNodeCard.test.tsx apps/renderer/src/canvas/CanvasWorkspace.tsx apps/renderer/src/canvas/CanvasWorkspace.test.tsx apps/renderer/src/styles/figma-hybrid-canvas.css tests/e2e/left-rail-figma.spec.ts tests/e2e/visual-layout.spec.ts
git commit -m "fix: simplify reverse results and normalize tool rail"
```

### Task 7: Full interaction regression gate

**Files:**
- Modify: `tests/e2e/release-ui-audit.spec.ts`
- Modify: `tests/e2e/ui-polish-screenshots.spec.ts`
- Create: `artifacts/2026-08-07-canvas-interaction-consolidation/README.md`

**Interfaces:**
- Produces a repeatable acceptance matrix and screenshots bound to the tested commit.

- [ ] **Step 1: Add one acceptance flow**

Cover blank startup, real picker upload, connected thumbnail, marquee selection, locked exclusion, durable group move, card-body expansion, blank collapse, original-ratio double-click preview, video generate/stop, popover closure, reverse-result cleanup, and rail geometry in both themes.

- [ ] **Step 2: Run verification**

Run: `npm.cmd run typecheck`

Run: `npm.cmd test -- apps/renderer/src/app/app-store.test.ts apps/renderer/src/canvas/CanvasWorkspace.test.tsx apps/renderer/src/canvas/ModuleNodeCard.test.tsx apps/renderer/src/canvas/use-canvas-draft.test.tsx packages/desktop-core/src/project-image-bridge.test.ts packages/desktop-core/src/project-video-bridge.test.ts`

Run: `npx.cmd playwright test tests/e2e/release-ui-audit.spec.ts tests/e2e/ui-polish-screenshots.spec.ts --project=chromium`

Expected: all PASS; paired screenshots written under `artifacts/2026-08-07-canvas-interaction-consolidation/`.

- [ ] **Step 3: Record evidence and commit**

The README records exact commit, commands, pass counts, screenshot names, and desktop-only unverified behavior. Browser evidence must not be described as desktop bridge verification.

```bash
git add tests/e2e/release-ui-audit.spec.ts tests/e2e/ui-polish-screenshots.spec.ts artifacts/2026-08-07-canvas-interaction-consolidation/README.md
git commit -m "test: gate consolidated canvas interactions"
```