# Reverse Action And Media Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make reverse actions visually consistent and keep every connected-media reorder control clickable within its own slot.

**Architecture:** Add terminal rules to `release-layout-contract.css` so they override the accumulated legacy canvas experiments without restructuring the node. Protect those final cascade decisions with component-adjacent source contract tests.

**Tech Stack:** React 19, TypeScript, CSS, Vitest, Playwright, Electron.

## Global Constraints

- Preserve all existing node behavior and unrelated dirty changes.
- Do not submit paid provider jobs during verification.
- Rebuild the Windows 1.6.56 installer only after tests, build, and screenshot verification pass.

---

### Task 1: Reverse action buttons

- [ ] Add a failing CSS contract test for equal columns, 34px buttons, secondary copy styling, primary reverse styling, and disabled state.
- [ ] Add the minimal terminal reverse-action CSS rules.
- [ ] Run focused component tests and inspect a real canvas screenshot.

### Task 2: Connected media reorder hit targets

- [ ] Add a failing CSS contract test that constrains the reorder overlay and buttons inside each 40px slot.
- [ ] Add the minimal terminal slot interaction rules and preserve hover/focus visibility.
- [ ] Re-run the mixed image/video reorder Playwright flow.

### Task 3: Release verification

- [ ] Run renderer typecheck/build and relevant Agent/reverse/image/video E2E flows.
- [ ] Update project memory with exact evidence.
- [ ] Build NSIS 1.6.56 and record size, timestamp, SHA-256, and packaged runtime smoke.

