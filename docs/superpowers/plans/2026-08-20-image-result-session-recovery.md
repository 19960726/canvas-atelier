# Image Result Session Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make completed image-generation results survive an internally rotated desktop project session, write into the original generation node, complete the model job, and recover the currently stuck result without weakening stale-job protection.

**Architecture:** Keep the existing session-ID guard, but add a second, durable ownership proof based on the active formal generation node's exact `lastResultJobId`. A session mismatch is accepted only while the current source node still claims that same running job; generation invalidation, node deletion, a newer job, or an unrelated project remains blocked. Startup recovery retains only those node-owned `running` jobs, cancels every other interrupted non-terminal job as before, and restarts polling after hydration.

**Tech Stack:** TypeScript, Zustand, Vitest, Electron desktop persistence, IndexedDB model-job storage.

## Global Constraints

- Preserve all unrelated dirty-worktree changes.
- Keep generated image results inside the source `image_generation` node in `data.config.resultAssetIds`.
- Keep at most four results and preserve original aspect ratio in the existing renderer contract.
- Keep legacy `image_result` nodes compatibility-only.
- Do not remove or globally relax project-session protection.
- Use `npm.cmd` in PowerShell.
- Do not read or expose stored provider credentials.

---

### Task 1: Reproduce the rotated-session result loss

**Files:**
- Modify: `apps/renderer/src/app/app-store.test.ts:1297-1459`
- Test: `apps/renderer/src/app/app-store.test.ts`

**Interfaces:**
- Consumes: `runImageGenerationNode`, `replaceProjectPersistenceClientForTests`, `replaceModelJobExecutorForTests`, `createTestModelJobStorage`.
- Produces: regression coverage proving same-job node ownership permits a result retry after session rotation while stale ownership remains blocked.

- [ ] **Step 1: Split the current combined guard test**

Keep generation invalidation as a blocked case, and replace the current session-invalidated expectation with a positive same-owner recovery test. The positive test must rotate `currentSession` from `desktop-session-a` to `desktop-session-b` while `reloadDurableProject` is pending, resolve the same durable project containing the generated asset and unchanged `lastResultJobId`, then expect:

```ts
expect(resultCommitAttempts).toBe(2);
expect((await storage.list())[0]).toMatchObject({
  status: 'completed',
  resultAssetId: generatedAsset.assetId,
});
expect(useAppStore.getState().project.nodes.find((node) => node.id === generation.id)).toMatchObject({
  type: 'module',
  data: {
    config: {
      resultAssetIds: [generatedAsset.assetId],
      resultState: 'fresh',
    },
    execution: { state: 'completed' },
  },
});
```

- [ ] **Step 2: Add a stale-owner rejection test**

During the pending reload, rotate the session and replace the durable source node's marker with a newer task ID:

```ts
const staleDurableProject = {
  ...durableProject!,
  nodes: durableProject!.nodes.map((node) => node.id === generation.id && node.type === 'module'
    ? {
        ...node,
        data: {
          ...node.data,
          config: { ...node.data.config, lastResultJobId: 'newer-model-job' },
        },
      }
    : node),
};
```

Expect only one inline commit attempt, no asset ID on the source node, and the original job to remain non-terminal.

- [ ] **Step 3: Add persisted-job hydration coverage before production changes**

Seed `createTestModelJobStorage` with a `running` image job whose `projectSessionId` is `old-session`. Hydrate a durable project under `new-session` whose source node stores the same job ID in `lastResultJobId`; make `poll` return the completed asset and assert recovery completes the job and writes `resultAssetIds`. Add the inverse case with `lastResultJobId: 'newer-model-job'` and assert no inline result transaction occurs.

- [ ] **Step 4: Run the focused test and verify RED**

Run:

```powershell
npm.cmd exec vitest -- --config vitest.config.ts apps/renderer/src/app/app-store.test.ts --run
```

Expected: the same-owner session-rotation and persisted-job hydration tests fail because `canContinueResult` rejects the new session. Both stale-owner cases must remain blocked.

- [ ] **Step 5: Commit the failing regression tests**

```powershell
git add -- apps/renderer/src/app/app-store.test.ts
git commit -m "test: reproduce generated result session rotation"
```

---

### Task 2: Add durable source-node ownership to the continuation guard

**Files:**
- Modify: `apps/renderer/src/app/app-store.ts:3162-3176`
- Test: `apps/renderer/src/app/app-store.test.ts`

**Interfaces:**
- Consumes: `CanvasProject`, `ModelJob`, current Zustand project state, and the existing `isOwnerRunning` callback.
- Produces: `projectOwnsModelResult(project: CanvasProject, ownerJob: ModelJob): boolean`, used only by `canContinueResult`.

- [ ] **Step 1: Add the minimal ownership helper**

Add a focused private helper near `getModelJobStore`:

```ts
function projectOwnsModelResult(project: CanvasProject, ownerJob: ModelJob): boolean {
  const sourceNode = project.nodes.find((node) => node.id === ownerJob.promptNodeId);
  if (sourceNode?.type !== 'module') return false;
  if (ownerJob.kind === 'video') {
    if (sourceNode.data.moduleType !== 'video_generation') return false;
  } else if (sourceNode.data.moduleType !== 'image_generation') {
    return false;
  }
  return sourceNode.data.config.lastResultJobId === ownerJob.id;
}
```

- [ ] **Step 2: Preserve strict session matching and add the scoped fallback**

Replace the duplicated direct session comparisons with a local predicate:

```ts
const ownsActiveResult = () => (
  ownerJob.projectSessionId === undefined
  || projectPersistenceClient.getSessionId?.() === ownerJob.projectSessionId
  || projectOwnsModelResult(useAppStore.getState().project, ownerJob)
);
```

Use `ownsActiveResult()` both before and after `await isOwnerRunning()`. Keep the model-job-store generation checks on both sides of the await.

- [ ] **Step 3: Run the focused test and verify GREEN**

Run:

```powershell
npm.cmd exec vitest -- --config vitest.config.ts apps/renderer/src/app/app-store.test.ts --run
```

Expected: all `app-store` tests pass; same-owner session rotation reaches a second inline commit and completes, while generation invalidation and changed `lastResultJobId` remain blocked.

- [ ] **Step 4: Run adjacent result pipeline tests**

Run:

```powershell
npm.cmd exec vitest -- --config vitest.config.ts apps/renderer/src/app/model-result-commit.test.ts apps/renderer/src/jobs/job-store.test.ts apps/renderer/src/app/desktop-persistence.test.ts --run
```

Expected: all selected suites pass with zero failures.

- [ ] **Step 5: Commit the minimal fix**

```powershell
git add -- apps/renderer/src/app/app-store.ts apps/renderer/src/app/app-store.test.ts
git commit -m "fix: recover generated results after session rotation"
```

---

### Task 3: Resume only node-owned running jobs after startup

**Files:**
- Modify: `apps/renderer/src/jobs/job-store.ts:241-254`
- Modify: `apps/renderer/src/app/app-store.ts:3249-3262`
- Modify: `apps/renderer/src/jobs/job-store.test.ts:75-118`
- Test: `apps/renderer/src/jobs/job-store.test.ts`
- Test: `apps/renderer/src/app/app-store.test.ts`

**Interfaces:**
- Consumes: `ModelJobStoreOptions.canContinueResult`, `jobStore.recover()`, and `jobStore.run()`.
- Produces: selective restart recovery for a `running` job that is still owned by its source node.

- [ ] **Step 1: Write failing recovery tests**

Extend the restart test with two running jobs. Configure `canContinueResult` to return true only for `job-running-owned`. After `recover()`, expect queued, submitting and unowned running jobs to be `cancelled`, while `job-running-owned` remains `running`. Add an app-store hydration test proving background recovery calls the provider for the owned job and materializes its inline result under the new session.

- [ ] **Step 2: Verify RED**

```powershell
npm.cmd exec vitest -- --config vitest.config.ts apps/renderer/src/jobs/job-store.test.ts apps/renderer/src/app/app-store.test.ts --run
```

Expected: the owned running job is cancelled by the current unconditional recovery map, and no provider poll completes it after hydration.

- [ ] **Step 3: Implement selective recovery**

Change `recover()` to evaluate running jobs asynchronously. Keep a running job only when `canContinueResult(job, isStillRunning)` returns true; transition all queued/submitting jobs and unowned running jobs to `cancelled`. After `recoverModelJobsInBackground()` completes recovery, call `jobStore.run()` so retained running jobs resume polling.

- [ ] **Step 4: Verify GREEN**

```powershell
npm.cmd exec vitest -- --config vitest.config.ts apps/renderer/src/jobs/job-store.test.ts apps/renderer/src/app/app-store.test.ts --run
```

Expected: owned running recovery completes; all stale recovery cases remain cancelled.

- [ ] **Step 5: Commit startup recovery**

```powershell
git add -- apps/renderer/src/jobs/job-store.ts apps/renderer/src/jobs/job-store.test.ts apps/renderer/src/app/app-store.ts apps/renderer/src/app/app-store.test.ts
git commit -m "fix: resume owned generation jobs after restart"
```

---

### Task 4: Verify, build, and recover the current real project

**Files:**
- Verify: `apps/renderer/src/app/app-store.ts`
- Verify: `apps/renderer/src/app/app-store.test.ts`
- Runtime project: `C:\Users\Administrator\AppData\Roaming\CanvasForge\projects\16b485e8-f2aa-4c0d-b20e-f9047e70d367.novus-project`

**Interfaces:**
- Consumes: packaged or development desktop runtime, existing IndexedDB model job `model-job-v2-51ac85d5e22c82301cb7c14019ebbce0`, and project asset `11afb75350f8a20b`.
- Produces: fresh test/build evidence plus real durable-state evidence that the node contains the result and the timer stopped.

- [ ] **Step 1: Run the complete targeted verification set**

```powershell
npm.cmd exec vitest -- --config vitest.config.ts apps/renderer/src/app/model-result-commit.test.ts apps/renderer/src/jobs/job-store.test.ts apps/renderer/src/app/app-store.test.ts apps/renderer/src/app/desktop-persistence.test.ts apps/renderer/src/canvas/ModuleNodeCard.test.tsx --run
```

Expected: zero failed tests.

- [ ] **Step 2: Run type checking and build**

```powershell
npm.cmd run typecheck
npm.cmd run build
```

Expected: both commands exit with code 0.

- [ ] **Step 3: Launch the fixed desktop runtime against the existing CanvasForge user data**

Close only the scoped CanvasForge/Canvas Atelier test instance after identifying its executable path and PID. Launch the newly built runtime using its normal CanvasForge user-data location so `hydratePersistence()` reads the existing project and IndexedDB job. Do not expose provider credentials in logs.

- [ ] **Step 4: Verify the current stuck job and durable project**

Wait for the recovered job to reach a terminal state, then verify the durable project journal/snapshot contains a `Store image generation result inline` transaction for `model-job-v2-51ac85d5e22c82301cb7c14019ebbce0`. Confirm the source node contains:

```json
{
  "resultAssetIds": ["11afb75350f8a20b"],
  "resultState": "fresh",
  "lastResultJobId": "model-job-v2-51ac85d5e22c82301cb7c14019ebbce0",
  "execution": { "state": "completed" }
}
```

Confirm IndexedDB reports the job as `completed`, the node preview renders the image, and the generation timer is absent.

- [ ] **Step 5: Run one fresh live generation**

In an isolated test project, generate one image through the configured provider. Verify the history record succeeds, the source node receives its asset ID, the timer stops, and reopening the project preserves the inline preview.

- [ ] **Step 6: Review the final scoped diff**

```powershell
git diff -- apps/renderer/src/app/app-store.ts apps/renderer/src/app/app-store.test.ts
git status --short
```

Confirm only the intended hunks in these already-dirty files belong to this fix; preserve every unrelated user change.
