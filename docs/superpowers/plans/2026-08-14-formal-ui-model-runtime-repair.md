# Formal UI Model Runtime Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the Canvas Atelier 1.6.38 formal UI unchanged while restoring image generation, video generation, reverse analysis, Agent-confirmed execution, restart recovery, and a modern-only installer.

**Architecture:** The renderer must establish a writable desktop project session before any provider operation that reads or writes managed assets. Provider errors remain structured across IPC and are converted to readable public text only at the model-job boundary. RelayMe public task handles are persisted under provider-scoped app data, and Agent chat adds a confirmation layer that calls the existing formal canvas node actions.

**Tech Stack:** TypeScript, React 19, Zustand, Electron 43, Vitest, Playwright, electron-builder.

## Global Constraints

- The visual baseline is `CanvasAtelier-Win10-11-x64-1.6.38.exe` only.
- Do not replace `CanvasWorkspace`, formal node cards, CSS tokens, top bar, side rail, project manager, or Agent panel layout.
- New controls must reuse the existing formal Agent message and button styles.
- Do not ship or build the legacy desktop interface.
- Every behavior change must have a failing regression test before implementation.

---

### Task 1: Writable Session Boundary

**Files:**
- Modify: `apps/renderer/src/app/desktop-persistence.ts`
- Modify: `apps/renderer/src/app/app-store.ts`
- Test: `apps/renderer/src/app/desktop-persistence.test.ts`
- Test: `apps/renderer/src/app/app-store.test.ts`

- [ ] Add failing tests proving reverse analysis and model jobs create a writable desktop project from an untitled canvas.
- [ ] Run the focused tests and verify failure is caused by the missing session boundary.
- [ ] Expose the existing writable-session operation through `ProjectPersistenceClient` and use it before image/video job enqueue and reverse analysis.
- [ ] Run the focused tests and verify the provider requests receive the created session id.

### Task 2: Readable Provider Errors

**Files:**
- Modify: `packages/domain/src/model-job.ts`
- Test: `packages/domain/src/model-job.test.ts`

- [ ] Add a failing test for `{ code, message, retryable }` provider errors.
- [ ] Update `sanitizeModelJobError` to prefer safe object `message` and `code` fields without exposing secrets.
- [ ] Verify job chips never render `[object Object]`.

### Task 3: RelayMe Task Recovery

**Files:**
- Create: `packages/desktop-core/src/relayme-task-store.ts`
- Modify: `packages/desktop-core/src/relayme-provider-service.ts`
- Modify: `packages/desktop-core/src/index.ts`
- Modify: `apps/desktop-modern/src/main.ts`
- Test: `packages/desktop-core/src/relayme-provider-service.test.ts`

- [ ] Add a failing restart test that submits a RelayMe task with one service instance and polls it with a second instance.
- [ ] Implement provider-scoped encrypted task persistence using credential mapping secrets and atomic confined writes.
- [ ] Persist image and video running/terminal mappings until renderer terminal ACK.
- [ ] Verify restart, token rotation fallback, and terminal cleanup.

### Task 4: Agent Confirmation Execution

**Files:**
- Modify: `apps/renderer/src/agent/SkillChatWorkbench.tsx`
- Modify: `apps/renderer/src/canvas/CanvasWorkspace.tsx`
- Modify: `apps/renderer/src/styles/app.css` only if an existing formal class cannot express the confirmation row
- Test: `apps/renderer/src/agent/SkillChatWorkbench.test.tsx`
- Test: `apps/renderer/src/canvas/CanvasWorkspace.test.tsx`

- [ ] Add failing tests for image, video, and reverse intents that do not execute before confirmation.
- [ ] Add formal-canvas action targets, deterministic intent selection, confirmation, cancellation, and execution callbacks.
- [ ] Reuse existing node actions and preserve the current Agent panel structure.
- [ ] Verify normal advice chat remains unchanged.

### Task 5: Modern-Only Release

**Files:**
- Modify: `package.json`
- Remove from active build: `apps/desktop-legacy`
- Verify: `apps/desktop-modern/electron-builder.yml`
- Verify: `tests/e2e/release-ui-audit.spec.ts`

- [ ] Remove the legacy desktop package from workspace typecheck/build scripts and ensure electron-builder packages only the formal renderer.
- [ ] Run focused tests, related full suites, typecheck, build, and release UI screenshots.
- [ ] Compare dark/light screenshots with the existing 1.6.38 release audit captures.
- [ ] Build the NSIS installer and run two packaged starts to verify project, credentials, profiles, model routes, and active jobs recover.
- [ ] Record installer path, size, timestamp, and SHA256 only after every gate passes.
