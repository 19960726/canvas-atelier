# Inline Generation Result Durability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent a generation job from becoming completed until its asset is durably attached to the originating generation node.

**Architecture:** Keep provider decoding and project-asset storage separate from canvas result materialization. Add an explicit post-commit ownership check in the job store and make completed-job recovery repair source nodes whose project asset exists but whose inline result list is missing.

**Tech Stack:** TypeScript, Zustand, Vitest, Zod domain models.

## Global Constraints

- Preserve the dirty worktree and all unrelated files.
- Do not mutate AppData project data or call paid providers.
- Use `npm.cmd` on Windows.
- Keep at most four inline image or video results.

---

### Task 1: Reproduce asset-present/node-missing completion

**Files:**
- Modify: `apps/renderer/src/jobs/job-store.test.ts`
- Modify: `apps/renderer/src/jobs/job-store.ts`

**Interfaces:**
- Consumes: `createModelJobStore`, `ModelJobStoreOptions.getProject`, `commitProjectTransaction`.
- Produces: `projectContainsMaterializedResult(project, job, assetId): boolean` used as the terminal completion gate.

- [ ] **Step 1: Write the failing test**

Create a running image job whose decoder adds the asset to `project.assets`, while the source node still has `resultAssetIds: []`. Make `commitProjectTransaction` apply the inline transaction. Assert the job is not completed until the updated project contains the asset ID in the source node, and assert the transaction id is `model-job-inline-result-${job.id}`.

- [ ] **Step 2: Run the focused test and verify failure**

Run: `npm.cmd exec vitest -- --config vitest.config.ts apps/renderer/src/jobs/job-store.test.ts --run`

Expected before implementation: the job can become completed without the post-commit node verification, or recovery skips the missing inline binding.

- [ ] **Step 3: Implement the terminal gate**

Add a helper that locates the formal generation source and checks only `resultAssetIds` or `videoResults`; do not inspect `project.assets`. After a reported successful commit, re-read `options.getProject?.()` and return without terminal transition if the node binding is absent.

- [ ] **Step 4: Repair completed jobs with missing inline binding**

In `repairCompletedCanvasResults`, treat only a node-level binding as existing. Run the existing repair transaction even when the project asset record already exists.

- [ ] **Step 5: Run focused tests**

Run: `npm.cmd exec vitest -- --config vitest.config.ts apps/renderer/src/jobs/job-store.test.ts apps/renderer/src/app/model-result-commit.test.ts apps/renderer/src/app/app-store.test.ts --run`

Expected: all selected tests pass and the regression observes a durable source-node binding.
