# Canvas Port Connectivity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore obvious, usable canvas connection ports in the Figma UI Gate so images, prompts, analysis and results can be wired by dragging between compatible nodes.

**Architecture:** Keep the existing React Flow `Handle` elements and domain-level `canConnectCanvasPorts` validation. Replace the UI Gate CSS that collapses workbench ports into a zero-height, invisible overlay with an explicit port rail: visible source/target sockets sit at the corresponding card edge and retain their port data type color. The connection flow continues to use `CanvasWorkspace.isValidCanvasConnection`, so incompatible types, duplicate links and cycles remain blocked.

**Tech Stack:** React 19, @xyflow/react, TypeScript, CSS, Playwright E2E.

## Global Constraints

- Preserve existing domain port types and cardinality validation.
- Do not change provider/API behavior or saved project schema.
- Keep dark and light UI Gate tokens; use the same connection affordance in both themes.
- A visible port must remain a real React Flow handle and must not be a decorative element.
- Verify the interaction by pointer drag, not only the E2E harness's direct graph helper.

---

### Task 1: Lock the broken port interaction with an E2E regression

**Files:**
- Modify: `tests/e2e/module-library-workflow.spec.ts`
- Test: `tests/e2e/module-library-workflow.spec.ts`

**Interfaces:**
- Consumes: `[data-module-type]`, `[data-port-id]`, and `.react-flow__handle` emitted by `ModuleNodeCard`.
- Produces: a pointer-level proof that `image_input.image` can connect to `reverse_agent.references` and creates exactly one `.react-flow__edge`.

- [ ] **Step 1: Write the failing test**

```ts
test('connects an image input to the reverse agent by dragging visible ports', async ({ page }) => {
  await openEmptyApp(page);
  await page.evaluate(async () => {
    await window.__NOVUS_E2E__!.createModule('image_input', { x: 120, y: 180 });
    await window.__NOVUS_E2E__!.createModule('reverse_agent', { x: 620, y: 180 });
  });
  const source = page.locator('[data-module-type="image_input"] [data-port-id="image"].react-flow__handle');
  const target = page.locator('[data-module-type="reverse_agent"] [data-port-id="references"].react-flow__handle');
  await expect(source).toBeVisible();
  await expect(target).toBeVisible();
  const [sourceBox, targetBox] = await Promise.all([source.boundingBox(), target.boundingBox()]);
  expect(sourceBox).not.toBeNull();
  expect(targetBox).not.toBeNull();
  await page.mouse.move(sourceBox!.x + sourceBox!.width / 2, sourceBox!.y + sourceBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(targetBox!.x + targetBox!.width / 2, targetBox!.y + targetBox!.height / 2, { steps: 12 });
  await page.mouse.up();
  await expect.poll(async () => (await e2eState(page)).edgeCount).toBe(1);
  await expect(page.locator('.react-flow__edge')).toHaveCount(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm.cmd run e2e -- tests/e2e/module-library-workflow.spec.ts`

Expected: failure because UI Gate's collapsed port rail does not provide a stable pointer target for the source-to-target drag.

### Task 2: Restore visible Figma-aligned connection rails

**Files:**
- Modify: `apps/renderer/src/styles/app.css:4243-4700`
- Test: `tests/e2e/module-library-workflow.spec.ts`

**Interfaces:**
- Consumes: `ModuleNodeCard` generated `.module-node__ports`, `.module-node__port-row`, and `.react-flow__handle` elements.
- Produces: left-side input sockets and right-side output sockets with at least 12×12px interactive hit targets.

- [ ] **Step 1: Write the minimal implementation**

Remove the UI Gate declarations that make workbench/foundation port containers `height: 0`, port rows `height: 1px`, or hide the port containers. Keep the card content styling intact. Add UI Gate rules that place `.module-node__ports` in the normal card flow, give each port row a 24px height, and give each `.react-flow__handle` a 12px square hit target, 2px token-colored border, and a high z-index. Retain `pointer-events: auto` for handles and do not stack different ports at one coordinate.

- [ ] **Step 2: Run the failing interaction test again**

Run: `npm.cmd run e2e -- tests/e2e/module-library-workflow.spec.ts`

Expected: the new pointer-drag test passes and existing module-library tests remain green.

### Task 3: Verify theme parity and release screenshots

**Files:**
- Modify: `tests/e2e/release-ui-audit.spec.ts`
- Test: `tests/e2e/release-ui-audit.spec.ts`, `tests/e2e/module-library-workflow.spec.ts`, `tests/e2e/visual-layout.spec.ts`

**Interfaces:**
- Consumes: the corrected port rail and production renderer build.
- Produces: current dark/light screenshots that visibly show a connected image-to-agent workflow.

- [ ] **Step 1: Add a dark/light visual assertion**

Create an image input, a reverse agent, connect the two using the same pointer helper, and assert that the edge path has a non-transparent stroke in each theme.

- [ ] **Step 2: Run verification**

Run: `npm.cmd test -- apps/renderer/src/canvas/CanvasWorkspace.test.tsx apps/renderer/src/canvas/ModuleNodeCard.test.tsx`

Run: `npm.cmd run e2e -- tests/e2e/module-library-workflow.spec.ts tests/e2e/release-ui-audit.spec.ts tests/e2e/visual-layout.spec.ts`

Expected: all requested tests pass and fresh screenshot captures show visible sockets and one connected workflow in dark and light themes.

