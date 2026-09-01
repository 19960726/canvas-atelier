# Media Playback and Photoshop Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore native video control input and provide truthful Photoshop COM diagnostics without changing provider generation behavior.

**Architecture:** A CSS-only adjustment makes the decorative playback glyph transparent to pointer input. The desktop adapter gains one explicit automation-unavailable result propagated through the existing narrow bridge to renderer copy. Prompt/result provenance stays descriptive rather than attempting an unsupported semantic guarantee.

**Tech Stack:** React, TypeScript, Vitest, Electron desktop core, CSS.

## Global Constraints

- No provider request, account credential, saved project, or managed asset is written during verification.
- Preserve `novus-asset` streaming and existing Photoshop CS6 compatibility.
- Do not claim semantic output validation when only prompt provenance exists.

---

### Task 1: Native video input

**Files:**
- Modify: `apps/renderer/src/main.styles.test.ts`
- Modify: `apps/renderer/src/styles/app.css`

- [x] Add a stylesheet assertion that `.module-node__video-preview-play` has `pointer-events: none`.
- [x] Run the focused stylesheet test and observe the missing declaration failure.
- [x] Add `pointer-events: none` to the decorative play glyph rule.
- [x] Rerun the focused stylesheet test and confirm pass.

### Task 2: Photoshop COM diagnostics

**Files:**
- Modify: `packages/desktop-core/src/photoshop-windows-adapter.ts`
- Modify: `packages/desktop-core/src/photoshop-windows-adapter.test.ts`
- Modify: `apps/renderer/src/app/photoshop-import.ts`
- Modify: `apps/renderer/src/app/photoshop-import.test.ts`

- [x] Add a failing adapter test for a runner response `automation_unavailable`.
- [x] Propagate that result through the adapter and bridge type.
- [x] Add a failing renderer copy assertion for the new code.
- [x] Add actionable Chinese copy that asks the user to run Photoshop and Canvas Atelier at the same permission level, then reopen the target PSD/PSB.
- [x] Run the focused adapter and renderer tests.

### Task 3: Verification and durable memory

**Files:**
- Modify: `docs/project-memory.md`

- [x] Run the video stylesheet, Photoshop adapter, and renderer import suites.
- [x] Run workspace typecheck.
- [x] Append the confirmed root causes, protected behavior, and exact verification commands to project memory.
