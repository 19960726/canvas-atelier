# Project Recovery and Save Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore a recovery preview into a writable durable project even when its managed root was deleted, rebuild recent-project state, resume only the exact owned generation job, and prevent accidental project deletion.

**Architecture:** Keep the validated recovery mirror as the source of truth. The desktop bridge recreates only the missing managed project root, writes a stable snapshot, journal boundary, and manifest atomically, then reopens persistence and upserts the recent-project index. The renderer keeps recovery explicit, retries failures in place, and restarts selective model-job recovery only after the durable session is restored.

**Tech Stack:** TypeScript, Electron IPC bridge, React, Zustand, Vitest, Testing Library.

## Global Constraints

- Preserve all unrelated dirty-worktree changes.
- Never expose provider credentials or run billed generation without a user-driven runtime test.
- Keep image results in the original `image_generation` node, maximum four, with uncropped aspect ratio.
- Do not delete recovery mirrors during restore.

---

### Task 1: Recreate a missing managed project root

**Files:**
- Modify: `packages/desktop-core/src/bridge-handlers.ts`
- Test: `packages/desktop-core/src/bridge-contract.test.ts`

**Interfaces:**
- Consumes: `BridgeSessionContext.session.manifest`, the opaque candidate path retained by `getRecoveryPlan`, and `RecentProjectStoreLike.upsert`.
- Produces: a writable `RestoreBridgeResult` at the candidate revision and one available recent-project entry.

- [ ] Add a failing bridge test that opens a recovery preview, removes the managed root, restores the retained candidate, and asserts snapshot, journal, manifest, writable writer, and recent-project upsert.
- [ ] Run `npm.cmd exec vitest -- --config vitest.config.ts packages/desktop-core/src/bridge-contract.test.ts --run` and verify the new case fails because `project.novus.json` is missing.
- [ ] Add a managed-root guard and recreate `snapshots/` plus `journal/` from the retained session manifest before writing the restored envelope.
- [ ] Keep existing-root restore behavior unchanged; roll back only a newly created incomplete managed root on failure.
- [ ] Upsert the restored project into recent projects after the durable summary succeeds.
- [ ] Re-run the focused bridge test and verify it passes.

### Task 2: Make recovery explicit and retryable in the project manager

**Files:**
- Modify: `apps/renderer/src/canvas/ProjectManagerPopover.tsx`
- Modify: `apps/renderer/src/canvas/CanvasWorkspace.tsx`
- Test: `apps/renderer/src/canvas/ProjectManagerPopover.test.tsx`

**Interfaces:**
- Consumes: `recoveryRequired: boolean`, recovery snapshot IDs, and async `onRestoreSnapshot(snapshotId)`.
- Produces: an expanded recovery warning, primary `恢复并继续` action, visible retry error, and successful recent-project reload.

- [ ] Add failing component tests for default-expanded recovery, warning copy, primary action, failed restore retry, and successful reload.
- [ ] Run the component test and verify the new expectations fail.
- [ ] Add the explicit recovery prop and pending/error state without changing ordinary snapshot restore copy.
- [ ] Stop closing the manager before restore completes; close only after a successful restore.
- [ ] Re-run the component test and verify it passes.

### Task 3: Resume the exact owned model job after durable recovery

**Files:**
- Modify: `apps/renderer/src/app/app-store.ts`
- Test: `apps/renderer/src/app/app-store.test.ts`

**Interfaces:**
- Consumes: restored project state where the formal generation node has exact `lastResultJobId` ownership.
- Produces: a call to selective `jobStore.recover()`/`run()` only after `recoveryRequired` becomes false.

- [ ] Add a failing store test showing a recovery preview does not resume the job before restore but does resume it afterward.
- [ ] Run the focused store test and verify it fails because restore currently stops after state adoption.
- [ ] Invoke background model-job recovery after the restored project and image catalog are adopted.
- [ ] Re-run the focused store test and verify it passes.

### Task 4: Protect recent projects from accidental deletion

**Files:**
- Modify: `packages/desktop-core/src/recent-project-store.ts`
- Modify: `apps/renderer/src/canvas/ProjectManagerPopover.tsx`
- Test: `packages/desktop-core/src/recent-project-store.test.ts`
- Test: `apps/renderer/src/canvas/ProjectManagerPopover.test.tsx`

**Interfaces:**
- Consumes: recent-project removal requests.
- Produces: removal from the recent list only; project files remain intact, with explicit UI wording.

- [ ] Change the existing managed-root deletion test to require the project directory to remain.
- [ ] Run it and verify it fails against recursive deletion.
- [ ] Remove filesystem deletion from `RecentProjectStore.remove` and change the UI action/copy to `从列表移除`.
- [ ] Re-run both focused suites and verify they pass.

### Task 5: Surface RelayMe string errors correctly

**Files:**
- Modify: `packages/provider-relayme/src/client.ts`
- Test: `packages/provider-relayme/src/client.test.ts`

**Interfaces:**
- Consumes: RelayMe error bodies shaped as `{ success: false, error: string }`.
- Produces: a sanitized useful error message without leaking keys or local paths.

- [ ] Add a failing test that expects a harmless string error to appear in the thrown message.
- [ ] Run the provider test and verify it fails with the invalid-response fallback.
- [ ] Teach `extractRelayMeErrorMessage` to accept both object and string `error` forms before sanitization.
- [ ] Re-run the provider test and verify it passes.

### Task 6: Verification and real recovery

**Files:**
- Verify only; no broad cleanup.

**Interfaces:**
- Consumes: all fixes above.
- Produces: automated and real-runtime evidence with passed, failed, and unverified boundaries.

- [ ] Run the focused desktop-core, renderer, job-store, and RelayMe suites.
- [ ] Run `npm.cmd run typecheck`.
- [ ] Run `npm.cmd run build`.
- [ ] Launch the rebuilt Electron runtime and restore the current recovery candidate.
- [ ] Verify the recreated project root, recent-project entry, inline result/timer state, and reopen persistence.
- [ ] Continue the broader canvas function audit using fresh runtime evidence; do not claim untested paths passed.
