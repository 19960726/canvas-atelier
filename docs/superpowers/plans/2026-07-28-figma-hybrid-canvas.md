# Figma Hybrid Canvas Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the 1440 × 900 canvas workspace follow Figma frame `179:2` (`Delivery · Hybrid Canvas · Dark`) while retaining existing canvas, node-run, history, settings, and Agent behavior.

**Architecture:** Keep `CanvasWorkspace` as the behavioral owner and use its existing `data-testid` hooks. Add only layout/test hooks needed to establish the Figma three-column work area: narrow tool rail, free canvas, and 396px Agent surface. Scope visual rules to `.workspace--ui-gate` and use theme tokens so the Figma light frame remains the same layout.

**Tech Stack:** React, TypeScript, React Flow, Zustand, CSS custom properties, Vitest, Playwright.

## Global Constraints

- Reference: Figma file `OX4ARPlzEa0gYuEX8xN4Md`, canvas frame `179:2` and its light counterpart `182:2`.
- Do not change API contracts, persistence formats, or node execution actions.
- Keep existing keyboard focus, responsive layout, and E2E selectors working.
- Do not build or distribute an installer until the visual review is accepted.

---

### Task 1: Lock the Figma canvas shell geometry

**Files:**
- Modify: `apps/renderer/src/styles/app.css`
- Test: `tests/e2e/release-ui-audit.spec.ts`

**Interfaces:**
- Consumes: existing `data-testid="workspace"`, `topbar`, `toolrail`, `canvas-stage`, and `agent-panel` DOM hooks.
- Produces: a 1440px desktop layout with 14px rail inset, 396px Agent width, and an unobscured canvas stage.

- [x] **Step 1: Write the failing visual geometry assertions**

```ts
const agentBox = await page.getByTestId('agent-panel').boundingBox();
expect(agentBox).toMatchObject({ width: 396, x: 1020, y: 86 });
const railBox = await page.getByTestId('toolrail').boundingBox();
expect(railBox).toMatchObject({ x: 14, y: 74, width: 48 });
```

- [x] **Step 2: Run the audit to verify the current canvas differs**

Run: `npm.cmd run e2e -- tests/e2e/release-ui-audit.spec.ts`

Expected: FAIL on the new Figma geometry assertion before changing layout rules.

- [x] **Step 3: Add token-based desktop layout overrides**

```css
.workspace--ui-gate .agent-panel {
  top: 86px;
  right: 24px;
  bottom: 24px;
  width: min(396px, calc(100vw - 72px));
}
.workspace--ui-gate .toolrail { top: 74px; left: 14px; width: 48px; }
```

- [x] **Step 4: Run the audit to verify the geometry and screenshot capture pass**

Run: `npm.cmd run e2e -- tests/e2e/release-ui-audit.spec.ts`

Expected: PASS and captures `01-canvas-dark`, `06b-agent-light`, and `07-canvas-light`.

### Task 2: Align canvas workbench composition to the Figma frame

**Files:**
- Modify: `apps/renderer/src/styles/app.css`
- Test: `tests/e2e/visual-layout.spec.ts`

**Interfaces:**
- Consumes: `module-node--workbench[data-module-type='image_generation']`, `module-node--workbench[data-module-type='reverse_agent']`, and the existing Agent component surface.
- Produces: two readable workbench cards in the free canvas area without changing module type, ports, job state, or Agent chat request fields.

- [x] **Step 1: Write the failing workbench geometry checks**

```ts
await expect(page.locator('[data-module-type="image_generation"]')).toHaveCSS('width', '404px');
await expect(page.locator('[data-module-type="reverse_agent"]')).toHaveCSS('width', '426px');
await expect(page.getByTestId('agent-panel')).toHaveCSS('width', '396px');
```

- [x] **Step 2: Run the visual layout test to verify the current workbench sizes differ**

Run: `npm.cmd run e2e -- tests/e2e/visual-layout.spec.ts`

Expected: FAIL only on the new Figma size checks.

- [x] **Step 3: Keep executable controls and reshape only the visual workbench layer**

```css
.workspace--ui-gate .module-node--workbench[data-module-type='image_generation'] { width: 404px; }
.workspace--ui-gate .module-node--workbench[data-module-type='reverse_agent'] { width: 426px; }
.workspace--ui-gate .canvas-stage { padding-right: 430px; }
```

- [x] **Step 4: Run behavior and visual regression tests**

Run: `npm.cmd test -- apps/renderer/src/canvas/CanvasWorkspace.test.tsx`

Expected: PASS with existing interaction behavior unchanged.

Run: `npm.cmd run e2e -- tests/e2e/visual-layout.spec.ts`

Expected: PASS across 1366 × 768, 440 × 900, and 920 × 1080.

### Task 3: Capture dark/light review evidence

**Files:**
- Modify: `tests/e2e/release-ui-audit.spec.ts`
- Output: `test-results/e2e/release-ui-audit-captures--*/01-canvas-dark.png`
- Output: `test-results/e2e/release-ui-audit-captures--*/06b-agent-light.png`
- Output: `test-results/e2e/release-ui-audit-captures--*/07-canvas-light.png`

**Interfaces:**
- Consumes: the completed geometry from Tasks 1–2.
- Produces: latest screenshots at the same 1440 × 900 viewport as the Figma reference.

- [ ] **Step 1: Ensure the Agent knowledge picker is closed before the light capture**

```ts
await page.getByRole('button', { name: '关闭知识库' }).click();
await expect(page.getByTestId('knowledge-library-toolbar')).toBeHidden();
```

- [ ] **Step 2: Run the release audit and inspect image outputs side-by-side with Figma `179:2` and `182:2`**

Run: `npm.cmd run e2e -- tests/e2e/release-ui-audit.spec.ts`

Expected: PASS; no open overlay, cropped panel, hidden toolbar, or dark-only color token remains in the light screenshot.

- [ ] **Step 3: Present only the Figma reference and current dark/light runtime images for user review**

Expected: user accepts or requests a specific visual correction before any other UI module is touched.

### Task 4: Make the Figma workbench visible in the release audit

**Files:**
- Modify: `tests/e2e/release-ui-audit.spec.ts`

**Interfaces:**
- Consumes: `window.__NOVUS_E2E__.createModule(moduleType, position)` from the existing test harness.
- Produces: dark and light audit images that exercise actual image-generation and reverse-Agent cards instead of an empty canvas.

- [ ] **Step 1: Write a failing audit assertion for the two Figma workbench nodes**

```ts
await expect(page.locator('[data-module-type="image_generation"]')).toBeVisible();
await expect(page.locator('[data-module-type="reverse_agent"]')).toBeVisible();
```

- [ ] **Step 2: Run the release audit to confirm empty-canvas capture fails the new assertion**

Run: `npm.cmd run e2e -- tests/e2e/release-ui-audit.spec.ts`

Expected: FAIL because `openEmptyApp` has no module nodes.

- [ ] **Step 3: Seed only the Figma inspection composition in the E2E audit**

```ts
await page.evaluate(async () => {
  await window.__NOVUS_E2E__?.createModule('image_generation', { x: 90, y: 112 });
  await window.__NOVUS_E2E__?.createModule('reverse_agent', { x: 542, y: 88 });
});
```

- [ ] **Step 4: Run the audit and present Figma/current dark and light workbench screenshots**

Run: `npm.cmd run e2e -- tests/e2e/release-ui-audit.spec.ts`

Expected: PASS; runtime application startup remains empty while audit evidence uses only the test harness composition.

### Task 5: Keep the formal canvas viewport at its authored scale

**Files:**
- Modify: `apps/renderer/src/canvas/CanvasWorkspace.tsx`
- Test: `tests/e2e/release-ui-audit.spec.ts`

**Interfaces:**
- Consumes: the existing React Flow viewport and the Figma audit composition.
- Produces: authored node sizes rendered at 1× rather than a `fitView`-amplified inspection view.

- [ ] **Step 1: Add a failing runtime viewport assertion after the two audit nodes are seeded**

```ts
const viewportTransform = await page.locator('.react-flow__viewport').evaluate((element) => element.style.transform);
expect(viewportTransform).toContain('scale(1)');
```

- [ ] **Step 2: Run the audit and record the failing viewport transform**

Run: `npm.cmd run e2e -- tests/e2e/release-ui-audit.spec.ts`

Expected: FAIL because `fitView` changes the viewport scale for the sparse workbench composition.

- [ ] **Step 3: Remove automatic fit-to-content from the formal workspace**

Keep explicit centering/focus behavior; do not change module dimensions, data contracts, or E2E node seeding.

- [ ] **Step 4: Run the audit and inspect node bounding boxes and deep/light capture**

Run: `npm.cmd run e2e -- tests/e2e/release-ui-audit.spec.ts`

Expected: PASS at 1×, with 404px and 426px visual card widths no longer amplified.
