# Silent Close and Writable Session Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close without native prompts while preserving durable saves, automatically promote read-only projects after a competing writer exits, and restore durable Delete/Backspace behavior.

**Architecture:** Keep the existing renderer-to-main close handshake and project repository lock ownership. Correct read-only close semantics, teach the main-process refresh boundary to promote a read-only session safely, and add a renderer polling hook that retries only while read-only.

**Tech Stack:** TypeScript, React 18, Zustand, Electron IPC, Vitest, ProjectRepository journal persistence.

## Global Constraints

- Preserve `E:\画布项目\staging-canvas-build` and all untracked assets; never reset, clean, or checkout.
- Do not delete project lock files or terminate user processes.
- Do not modify, migrate, overwrite, or roll back the formal project.
- Do not operate or close Photoshop.
- Do not commit, push, package, or publish without separate explicit authorization.
- Every production edit follows red-green TDD.

---

## File map

- `apps/renderer/src/app/app-store.ts`: classify read-only close as a clean session release and expose read-only refresh eligibility.
- `apps/renderer/src/app/app-store.test.ts`: renderer close and hydration/reload state tests.
- `packages/desktop-core/src/bridge-handlers.ts`: promote an existing read-only bridge session through `ProjectRepository.open(..., { mode: 'write' })`.
- `packages/desktop-core/src/bridge-contract.test.ts`: same-session promotion and live-writer retention tests.
- `apps/renderer/src/app/use-read-only-write-promotion.ts`: bounded read-only retry hook.
- `apps/renderer/src/app/use-read-only-write-promotion.test.tsx`: timer, cancellation, and success tests.
- `apps/renderer/src/canvas/CanvasWorkspace.tsx`: install the promotion hook without changing the existing Delete capture handler.
- `apps/renderer/src/canvas/CanvasWorkspace.test.tsx`: Delete after promotion and modal/editable-target regression coverage.
- `apps/desktop-modern/src/main.ts`: remove close dialogs while retaining a silent auto-save-compatible close-choice bridge.
- `apps/desktop-modern/src/close-coordinator.test.ts`: assert failed close stays open silently and valid untitled closes select save without a dialog.
- `apps/desktop-legacy/src/main.ts`: mirror the silent close behavior in the compatible desktop entry point.
- `apps/desktop-legacy/src/close-coordinator.test.ts`: keep modern and legacy close contracts aligned.

### Task 1: Make read-only close succeed without a save dialog

**Files:**
- Modify: `apps/renderer/src/app/app-store.test.ts`
- Modify: `apps/renderer/src/app/app-store.ts`
- Modify: `apps/desktop-modern/src/close-coordinator.test.ts`
- Modify: `apps/desktop-modern/src/main.ts`
- Modify: `apps/desktop-legacy/src/close-coordinator.test.ts`
- Modify: `apps/desktop-legacy/src/main.ts`

**Interfaces:**
- Consumes: `AppState.closePersistence(): Promise<boolean>` and `RendererCloseFlushCoordinatorOptions.onCloseBlocked`.
- Produces: read-only close returns `true` after `projectPersistenceClient.close()`; failed writable close has no native dialog or discard path; a valid untitled dirty close-choice request resolves to `save` without user interaction.

- [ ] **Step 1: Write failing renderer close tests**

Add a test that hydrates a desktop session with `saveStatus: 'read_only'`, invokes `closePersistence()`, and asserts:

```ts
expect(await useAppStore.getState().closePersistence()).toBe(true);
expect(close).toHaveBeenCalledOnce();
expect(stablePoint).not.toHaveBeenCalled();
expect(commit).not.toHaveBeenCalled();
```

Keep a writable failure test asserting `closePersistence()` returns `false` and does not discard pending state.

- [ ] **Step 2: Run the renderer test and verify RED**

Run:

```powershell
npm.cmd test -- apps/renderer/src/app/app-store.test.ts
```

Expected: the read-only close assertion fails because `flushPendingProjectSave('close')` returns `false` before `projectPersistenceClient.close()`.

- [ ] **Step 3: Implement the minimal read-only close branch**

In `closePersistence`, branch before the writable flush:

```ts
const state = get();
if (state.recoveryRequired) return false;
const readOnly = state.saveStatus === 'read_only';
if (!readOnly && !await flushPendingProjectSave(get, set, 'close')) return false;
// stop model jobs and knowledge subscriptions using the existing sequence
await projectPersistenceClient.close();
return true;
```

Do not mark a writable save failure as success.

- [ ] **Step 4: Write and run the desktop RED test**

Extend both close-coordinator tests to read their matching `main.ts` and assert:

```ts
expect(source).not.toContain('showCloseRecoveryChoice');
expect(source).not.toContain('放弃更改并关闭');
expect(source).not.toContain('关闭未命名工作流');
expect(source).not.toContain("buttons: ['保存', '不保存', '取消']");
```

Add a small exported/testable decision helper, or the existing contract-level equivalent, proving a valid dirty untitled request returns `save`, while an invalid request or untrusted sender returns `cancel`. The helper must not receive `dialog` as a dependency.

Run:

```powershell
npm.cmd test -- apps/desktop-modern/src/close-coordinator.test.ts apps/desktop-legacy/src/close-coordinator.test.ts
```

Expected: FAIL while the recovery dialog, untitled-choice dialog, and `onCloseBlocked` callbacks remain.

- [ ] **Step 5: Remove only the native failure-choice path and verify GREEN**

In both desktop entry points:

- remove `showCloseRecoveryChoice` and omit `onCloseBlocked` when constructing the coordinator;
- keep `BRIDGE_CHANNELS.closeChoice` registered for preload/API compatibility;
- validate the request and sender, return `save` for a valid dirty untitled project, and return `cancel` otherwise;
- remove every `dialog.showMessageBox` call from the close paths.

The coordinator already cancels silently when a failed/timeout/unavailable result has no callback.

Run both focused files and expect all tests to pass.

- [ ] **Step 6: Review checkpoint without commit**

Run `git diff --check` and inspect only the six Task 1 files. Do not commit.

### Task 2: Promote a read-only bridge session after lock release

**Files:**
- Modify: `packages/desktop-core/src/bridge-contract.test.ts`
- Modify: `packages/desktop-core/src/bridge-handlers.ts`

**Interfaces:**
- Consumes: `ProjectRepositoryLike.open(root, { mode: 'write' })`, `openJournalWriter(session)`, and `BridgeSessionContext`.
- Produces: `refreshProject` may replace a read-only context with a writable context while preserving `sessionId` and `projectId`.

- [ ] **Step 1: Write the live-lock and promotion tests**

Create a repository double whose first project open returns read-only, first promotion attempt returns read-only, and second promotion attempt returns write. Assert:

```ts
expect((await handlers.refreshProject({}, { sessionId })).mode).toBe('read_only');
const promoted = await handlers.refreshProject({}, { sessionId });
expect(promoted).toMatchObject({ sessionId, projectId: starterProject.id, mode: 'write' });
expect(openJournalWriter).toHaveBeenCalledWith(expect.objectContaining({ mode: 'write' }));
```

Then commit a harmless transaction through the same session ID and assert the new writer receives it.

- [ ] **Step 2: Run the bridge test and verify RED**

Run:

```powershell
npm.cmd test -- packages/desktop-core/src/bridge-contract.test.ts
```

Expected: refresh remains read-only because it only calls `summarizeSession`.

- [ ] **Step 3: Implement same-session promotion**

In `refreshProject`, when `session.session.mode === 'read_only'`:

```ts
const candidate = await repository.open(session.session.root, { mode: 'write' });
if (candidate.mode === 'write') {
  const writer = await repository.openJournalWriter(candidate);
  session.session = candidate;
  session.writer = writer;
}
```

If the candidate remains read-only, discard the returned value: `ProjectRepository.close()` is explicitly a no-op for read-only sessions because they own no lock or journal state. If opening the writer fails after write acquisition, call `repository.close(candidate)` to release its lock/journal state, then retain the original read-only context. Never remove a lock directly.

- [ ] **Step 4: Run bridge and repository lock suites and verify GREEN**

Run:

```powershell
npm.cmd test -- packages/desktop-core/src/bridge-contract.test.ts packages/desktop-core/src/project-repository.test.ts
```

Expected: all tests pass, including existing live-lock and stale-lock safety cases.

- [ ] **Step 5: Review checkpoint without commit**

Inspect the two Task 2 files and run `git diff --check`. Do not commit.

### Task 3: Poll read-only sessions and restore durable Delete/Backspace

**Files:**
- Create: `apps/renderer/src/app/use-read-only-write-promotion.ts`
- Create: `apps/renderer/src/app/use-read-only-write-promotion.test.tsx`
- Modify: `apps/renderer/src/app/app-store.ts`
- Modify: `apps/renderer/src/app/app-store.test.ts`
- Modify: `apps/renderer/src/canvas/CanvasWorkspace.tsx`
- Modify: `apps/renderer/src/canvas/CanvasWorkspace.test.tsx`

**Interfaces:**
- Produces: `useReadOnlyWritePromotion({ projectId, readOnly, reload, retryMs }): void`.
- Consumes: `reloadDurableProject(): Promise<boolean>` and `saveStatus === 'read_only'`.

- [ ] **Step 1: Write failing state eligibility tests**

Assert hydration and project-open results set `canReloadDurableProject: true` when `saveStatus` is read-only, and normal saved sessions keep it false.

- [ ] **Step 2: Write the hook tests**

With fake timers, assert the hook:

```ts
expect(reload).not.toHaveBeenCalled();
await vi.advanceTimersByTimeAsync(1_000);
expect(reload).toHaveBeenCalledOnce();
```

Return `false` once to schedule another attempt, then `true` and verify polling stops. Unmount and verify no further calls.

- [ ] **Step 3: Run focused tests and verify RED**

Run the new hook test and relevant app-store tests. Expected: missing hook and missing read-only eligibility assertions fail.

- [ ] **Step 4: Implement the minimal hook and state changes**

Use one `useEffect` and one timeout at a time:

```ts
useEffect(() => {
  if (!readOnly) return;
  let cancelled = false;
  let timer = window.setTimeout(async function attempt() {
    if (cancelled) return;
    const promoted = await reload();
    if (!cancelled && !promoted) timer = window.setTimeout(attempt, retryMs);
  }, retryMs);
  return () => { cancelled = true; window.clearTimeout(timer); };
}, [projectId, readOnly, reload, retryMs]);
```

Set `canReloadDurableProject` from read-only hydration/open state. Install the hook once in `CanvasWorkspace`.

- [ ] **Step 5: Add the Delete-after-promotion regression test**

Start the store read-only, make the reload mock adopt a saved writable state, advance the poll timer, select a node, press Delete, and assert the durable delete removes the node. Retain existing editable-target and modal-surface protections.

- [ ] **Step 6: Run renderer persistence and canvas suites and verify GREEN**

Run:

```powershell
npm.cmd test -- apps/renderer/src/app/use-read-only-write-promotion.test.tsx apps/renderer/src/app/app-store.test.ts apps/renderer/src/canvas/CanvasWorkspace.test.tsx apps/renderer/src/app/desktop-persistence.test.ts
```

- [ ] **Step 7: Review checkpoint without commit**

Inspect all Task 3 files and run `git diff --check`. Do not commit.

### Task 4: Persistence verification gate

**Files:** No new production files.

- [ ] Run Photoshop CS6 regression tests:

```powershell
npm.cmd test -- packages/desktop-core/src/photoshop-script.test.ts packages/desktop-core/src/photoshop-windows-adapter.test.ts apps/renderer/src/app/photoshop-import.test.ts
```

- [ ] Run the full workspace test suite and require exit code 0:

```powershell
npm.cmd test
```

- [ ] Run full typecheck/build and require exit code 0:

```powershell
npm.cmd run build
```

- [ ] Confirm `git status --short` contains only intended source, test, spec, and plan files. Do not package, commit, or publish.
