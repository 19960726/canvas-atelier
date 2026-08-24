# Canvas UI Gate Code Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align the desktop canvas shell with Figma frame `9:5` while preserving existing behavior.

**Architecture:** Keep `CanvasWorkspace` as the behavioral owner. Add stable semantic classes and test assertions there; apply geometry and visual tokens in `app.css` so existing module and chat components continue to work unchanged.

**Tech Stack:** React, TypeScript, Vitest, React Testing Library, CSS.

## Global Constraints

- Preserve existing canvas, model, Agent, history, and settings behavior.
- Use Figma `9:5` only as the visual reference for this slice.
- Do not reset or overwrite unrelated uncommitted changes.

---

### Task 1: Specify the Figma shell contract

**Files:**
- Modify: `apps/renderer/src/canvas/CanvasWorkspace.test.tsx`
- Modify: `apps/renderer/src/canvas/CanvasWorkspace.tsx`

- [ ] Write a failing test asserting the workspace uses the Figma shell marker, the tool rail is marked floating, and the Agent workbench has the Skill Chat marker.
- [ ] Run the focused CanvasWorkspace test and confirm the new assertion fails.
- [ ] Add only the required semantic classes/data attributes to `CanvasWorkspace`.
- [ ] Re-run the focused test and confirm it passes.

### Task 2: Apply the Canvas UI Gate geometry

**Files:**
- Modify: `apps/renderer/src/styles/app.css`
- Test: `apps/renderer/src/canvas/CanvasWorkspace.test.tsx`

- [ ] Add a failing test for the shell markers from Task 1 if it does not already exist.
- [ ] Run the focused test and confirm the expected failure before markup is added.
- [ ] Style the approved 56px top bar, floating 48px tool rail, right-inset 376px Agent panel, and dark canvas using the new markers.
- [ ] Run the focused test, `npm.cmd run typecheck`, and the complete test/e2e verification commands.
