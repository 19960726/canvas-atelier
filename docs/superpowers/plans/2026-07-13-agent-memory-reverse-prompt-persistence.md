# Agent Memory, Reverse Prompt, and Canvas Persistence Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to implement this plan step by step. Keep the work TDD-first, keep the writeback path reviewable, and do not stage unrelated changes in the worktree.

**Goal:** Build a canvas-aware Agent system that can reverse-prompt from approved knowledge, enforce a 20-reference budget for the same combined product/scene/prop/material/placement reference list across the UI, persisted project, and generation request boundaries, persist canvas work through snapshot-plus-journal recovery, and gate Skill writeback through a one-use token with offline outbox retry.

**Architecture:** Use the shared domain package for request envelopes, persona/session metadata, reference validation, canvas snapshots, and journals. Keep the renderer responsible for UX, the skill store responsible for import/writeback orchestration, and the recovery path strictly append-only until the user explicitly confirms a writeback target.

**Tech Stack:** TypeScript, React, Zod, Zustand, Dexie or IndexedDB-backed storage, Vitest, React Testing Library, Playwright, and the existing Electron desktop shells. Keep the implementation compatible with the current workspace layout and preserve the approved Chinese user-facing copy.

## Global Constraints

- Do not overwrite or stage unrelated package, skill-store, or config changes in this worktree.
- Preserve the original `D:\场景skill` source tree as a protected destination; use managed copies and reviewable diffs first.
- Skill writeback must use a one-use token that expires after a successful write, a failed write, or a timeout.
- The Agent must run from the newest approved knowledge snapshot on every execution.
- The default reverse-prompt persona is `高级商业视觉设计师 + 产品摄影指导 + 提示词工程师`.
- The canvas must recover from crashes through snapshots plus an incremental journal, not full serialization on pointermove.
- Win7 compatibility keeps a 30 FPS floor, even under degradation.
- Full verification is required before completion.

## File Map

```text
packages/domain/src
packages/skill-store/src
apps/renderer/src/agent
apps/renderer/src/canvas
apps/renderer/src/app
tests/e2e
docs/testing
```

- `packages/domain`: reference budget rules, request envelopes, persona/session metadata, canvas snapshot/journal types, and recovery contracts.
- `packages/skill-store`: import copy metadata, approved knowledge snapshots, one-use writeback tokens, offline outbox, retry, and target selection.
- `apps/renderer`: dedicated Agent UI, validation feedback, canvas persistence hooks, and interaction quality controls.
- `tests/e2e`: end-to-end coverage for references, memory writeback, persona runs, and crash recovery.

---

### Task 1: Reference Budget, Request Validation, and Knowledge Snapshot Contracts

**Files:**
- Create: `packages/domain/src/reference-budget.ts`, `packages/domain/src/request-envelope.ts`, `packages/domain/src/knowledge-snapshot.ts`
- Create: `packages/domain/src/reference-budget.test.ts`, `packages/domain/src/request-envelope.test.ts`
- Modify: `packages/domain/src/index.ts`

**Interfaces:**
- Produces: `ReferenceBudget`, `ReferenceScope`, `RequestEnvelope`, `ApprovedKnowledgeSnapshot`, `validateReferenceBudget`, `validateRequestEnvelope`, `selectNewestApprovedSnapshot`.
- Consumes: the same combined product/scene/prop/material/placement reference list as surfaced in the UI, persisted in the project, and attached to the generation request.

- [ ] **Step 1: Write the failing budget and validation tests**

```ts
it('rejects a shared reference list that exceeds 20 items at any boundary', () => {
  const result = validateReferenceBudget({
    references: combinedReferences,
  });
  expect(result.ok).toBe(false);
  expect(result.reason).toMatch(/20/);
});
```

Also assert that UI, project, and request validators each inspect the same shared list, reject missing roles, duplicate identifiers, stale approved-snapshot ids, and mismatched request hashes, and fail whenever the combined list contains more than 20 references.

- [ ] **Step 2: Verify RED**

Run:

```bash
npm test -- packages/domain/src/reference-budget.test.ts packages/domain/src/request-envelope.test.ts
```

- [ ] **Step 3: Implement the budget ledger and request checks**

Use a hard ceiling of 20 references total. Split the validation surface into:

1. UI validation for drag-and-drop reference intake.
2. Project validation for persisted project manifests.
3. Request validation for the Agent execution envelope.

The envelope must carry the selected approved knowledge snapshot id, the current project revision, and the shared reference list. Reject requests that exceed the budget or that reference a snapshot other than the newest approved one.

- [ ] **Step 4: Verify and commit**

Run:

```bash
npm test -- packages/domain/src/reference-budget.test.ts packages/domain/src/request-envelope.test.ts
npm run typecheck
```

---

### Task 2: One-Use Skill Writeback Token, Base/App/Source Flow, and Offline Outbox Retry

**Files:**
- Create: `packages/skill-store/src/writeback-token.ts`, `packages/skill-store/src/writeback-flow.ts`, `packages/skill-store/src/offline-outbox.ts`
- Create: `packages/skill-store/src/writeback-token.test.ts`, `packages/skill-store/src/offline-outbox.test.ts`
- Modify: `packages/skill-store/src/index.ts`

**Interfaces:**
- Produces: `createWritebackToken`, `consumeWritebackToken`, `planWritebackTargets`, `enqueueWritebackJob`, `drainWritebackOutbox`, `retryWritebackJob`.
- Consumes: managed-copy knowledge snapshots, approved source diffs, and network availability state.

- [ ] **Step 1: Write the failing writeback tests**

```ts
it('consumes the token once and rejects reuse', () => {
  const token = createWritebackToken({ target: 'source', ttlMs: 30000 });
  expect(consumeWritebackToken(token.id)).toBe(true);
  expect(consumeWritebackToken(token.id)).toBe(false);
});
```

Cover base/app/source routing, offline queue persistence, retry backoff, and token expiry. Assert that writeback jobs survive app restart but remain blocked until the user reauthorizes the single-use token.

- [ ] **Step 2: Verify RED**

Run:

```bash
npm test -- packages/skill-store/src/writeback-token.test.ts packages/skill-store/src/offline-outbox.test.ts
```

- [ ] **Step 3: Implement the writeback flow**

Treat `base` as the immutable imported snapshot, `app` as the managed local working copy, and `source` as the guarded `D:\场景skill` destination. The outbox must:

1. Persist pending jobs locally.
2. Retry after transient offline or provider failures.
3. Preserve the review diff until the user confirms the next attempt.
4. Invalidate the token after one successful write or one failed terminal attempt.

No direct source write should occur without a reviewed diff and a fresh token.

- [ ] **Step 4: Verify and commit**

Run:

```bash
npm test -- packages/skill-store/src/writeback-token.test.ts packages/skill-store/src/offline-outbox.test.ts
npm run typecheck
```

---

### Task 3: Reverse-Prompt Personas, Session Isolation, and Structured Outputs

**Files:**
- Create: `packages/domain/src/agent-persona.ts`, `packages/domain/src/reverse-prompt.ts`
- Create: `packages/domain/src/agent-persona.test.ts`, `packages/domain/src/reverse-prompt.test.ts`
- Create: `apps/renderer/src/agent/persona-presets.ts`, `apps/renderer/src/agent/reverse-prompt-view.tsx`

**Interfaces:**
- Produces: `AgentPersona`, `AgentRunContext`, `buildReversePromptInput`, `createAgentRunEnvelope`, `parseStructuredAgentOutput`.
- Consumes: the newest approved knowledge snapshot, reference ledger, and current project state.

- [ ] **Step 1: Write the failing persona and output tests**

```ts
it('creates a new session id and nonce for every run', () => {
  const first = createAgentRunEnvelope(baseContext);
  const second = createAgentRunEnvelope(baseContext);
  expect(first.sessionId).not.toEqual(second.sessionId);
  expect(first.nonce).not.toEqual(second.nonce);
});
```

Also assert the default persona text is exactly `高级商业视觉设计师 + 产品摄影指导 + 提示词工程师`, and that the parser rejects freeform answers when a structured output is required.

- [ ] **Step 2: Verify RED**

Run:

```bash
npm test -- packages/domain/src/agent-persona.test.ts packages/domain/src/reverse-prompt.test.ts
```

- [ ] **Step 3: Implement reverse-prompt construction**

Every run must:

1. Read the newest approved knowledge snapshot.
2. Generate a unique `sessionId` and `nonce`.
3. Bind the current reference ledger and budget.
4. Produce structured output fields for intent, constraints, conflicts, recommended actions, and writeback candidates.

The reverse prompt should turn canvas state plus approved memory into a deterministic work brief instead of a vague chat transcript.

- [ ] **Step 4: Verify and commit**

Run:

```bash
npm test -- packages/domain/src/agent-persona.test.ts packages/domain/src/reverse-prompt.test.ts
npm run typecheck
```

---

### Task 4: Dedicated Agent UI for Persona, Memory, and Writeback Control

**Files:**
- Create: `apps/renderer/src/agent/AgentDock.tsx`, `apps/renderer/src/agent/AgentHeader.tsx`, `apps/renderer/src/agent/KnowledgeSnapshotPanel.tsx`
- Create: `apps/renderer/src/agent/ReferenceBudgetPanel.tsx`, `apps/renderer/src/agent/WritebackOutboxPanel.tsx`, `apps/renderer/src/agent/AgentDock.test.tsx`
- Modify: `apps/renderer/src/app/App.tsx`

**Interfaces:**
- Produces: a dedicated Agent surface with persona selection, session metadata, approved snapshot display, writeback queue controls, and conflict summaries.

- [ ] **Step 1: Write the failing UI test**

```tsx
render(<AgentDock />);
expect(screen.getByRole('complementary', { name: 'Agent 工作台' })).toBeVisible();
expect(screen.getByText('高级商业视觉设计师 + 产品摄影指导 + 提示词工程师')).toBeVisible();
expect(screen.getByText(/20\/20/)).toBeVisible();
```

Also verify the UI exposes session id, nonce, newest approved snapshot id, source/app/base writeback status, and an outbox retry control.

- [ ] **Step 2: Verify RED**

Run:

```bash
npm test -- apps/renderer/src/agent/AgentDock.test.tsx
```

- [ ] **Step 3: Implement the dedicated panel**

Keep the Agent UI separate from the canvas, pinned by default on desktop, and dense enough for operational use. The visual direction should feel like a premium, restrained professional creative tool: precise typography and hierarchy, quiet neutral surfaces with only limited accents, compact controls, polished empty/loading/error/history states, no marketing framing, and no excessive gradients or round-card decoration. The panel must show:

1. Persona preset and the active reverse-prompt session.
2. Reference budget state.
3. Approved knowledge snapshot provenance.
4. Writeback target selection and token-gated sync actions.
5. Retry status for offline outbox jobs.

Use compact controls, clear status chips, and no marketing-style framing.

- [ ] **Step 4: Verify and commit**

Run:

```bash
npm test -- apps/renderer/src/agent/AgentDock.test.tsx
npm run typecheck
```

---

### Task 5: Canvas Snapshot, Incremental Journal, and Crash Recovery

**Files:**
- Create: `packages/domain/src/canvas-snapshot.ts`, `packages/domain/src/canvas-journal.ts`
- Create: `packages/domain/src/canvas-snapshot.test.ts`, `packages/domain/src/canvas-journal.test.ts`
- Create: `apps/renderer/src/canvas/use-canvas-snapshot.ts`, `apps/renderer/src/app/recovery.ts`, `apps/renderer/src/app/recovery.test.ts`

**Interfaces:**
- Produces: `CanvasSnapshot`, `CanvasJournalEntry`, `appendCanvasJournal`, `materializeCanvasState`, `recoverCanvasState`.
- Consumes: discrete canvas operations and throttled persistence triggers.

- [ ] **Step 1: Write the failing snapshot and journal tests**

```ts
it('does not serialize the full project on pointermove', () => {
  const saveSpy = vi.fn();
  const journal = createJournal({ save: saveSpy });
  journal.onPointerMove({ x: 10, y: 10 });
  expect(saveSpy).not.toHaveBeenCalled();
});
```

Also assert that recovery replays the latest snapshot plus journal entries, preserves undo boundaries, and restores after a simulated crash without losing committed operations.

- [ ] **Step 2: Verify RED**

Run:

```bash
npm test -- packages/domain/src/canvas-snapshot.test.ts packages/domain/src/canvas-journal.test.ts apps/renderer/src/app/recovery.test.ts
```

- [ ] **Step 3: Implement snapshot plus journal recovery**

Use incremental journal entries for committed canvas changes, and capture a snapshot only at stable boundaries such as pointerup, transaction commit, autosave, or idle time. Pointermove should update transient interaction state only. Recovery must:

1. Load the latest durable snapshot.
2. Replay journal entries after that snapshot.
3. Validate the result before hydration.
4. Fall back to the last good snapshot if replay fails.

- [ ] **Step 4: Verify and commit**

Run:

```bash
npm test -- packages/domain/src/canvas-snapshot.test.ts packages/domain/src/canvas-journal.test.ts apps/renderer/src/app/recovery.test.ts
npm run typecheck
```

---

### Task 6: Viewport Culling, Lazy Image Loading, and Win7 Degradation Floors

**Files:**
- Create: `apps/renderer/src/canvas/use-viewport-culling.ts`, `apps/renderer/src/canvas/use-lazy-image.ts`, `apps/renderer/src/canvas/use-interaction-quality.ts`
- Create: `apps/renderer/src/canvas/use-viewport-culling.test.ts`, `apps/renderer/src/canvas/use-interaction-quality.test.ts`
- Modify: `packages/domain/src/runtime-profile.ts`

**Interfaces:**
- Produces: `ViewportCullingPlan`, `LazyImageRequest`, `InteractionQualityMode`, `RuntimeProfile`.
- Consumes: canvas bounds, scroll/zoom state, image metadata, and legacy Win7 profile flags.

- [ ] **Step 1: Write the failing performance tests**

Generate a canvas with 1000 lightweight nodes and 200 image nodes, then assert that only viewport-plus-overscan nodes mount, offscreen images remain lazy, and the quality mode drops during active pan or zoom.

Also assert the legacy profile clamps to a 30 FPS floor, reduces thumbnail resolution, and lowers concurrency for image loading and provider polling.

- [ ] **Step 2: Verify RED**

Run:

```bash
npm test -- apps/renderer/src/canvas/use-viewport-culling.test.ts apps/renderer/src/canvas/use-interaction-quality.test.ts
```

- [ ] **Step 3: Implement culling and quality degradation**

Apply viewport culling to DOM-heavy nodes, lazy-load image content only when approaching the viewport, and switch to degraded interaction mode during motion. The degraded mode should:

1. Disable expensive visual effects while panning.
2. Lower decode and fetch concurrency.
3. Use smaller thumbnails on legacy hardware.
4. Preserve selected nodes and interaction handles.
5. Restore the full quality mode after idle settles.

The legacy Win7 profile must keep the app usable at 30 FPS floor even when the scene is busy.

- [ ] **Step 4: Verify and commit**

Run:

```bash
npm test -- apps/renderer/src/canvas/use-viewport-culling.test.ts apps/renderer/src/canvas/use-interaction-quality.test.ts
npm run build
```

---

### Task 7: Full Verification and Release-Grade Sanity Checks

**Files:**
- Create: `tests/e2e/agent-memory-reverse-prompt.spec.ts`, `tests/e2e/canvas-recovery.spec.ts`, `tests/e2e/win7-degradation.spec.ts`
- Create: `docs/testing/windows-compatibility-matrix.md`

**Interfaces:**
- Consumes: all prior tasks.
- Produces: full workflow verification for reference budgeting, reverse prompting, writeback gating, crash recovery, and Windows compatibility.

- [ ] **Step 1: Cover the end-to-end flows**

Verify that:

1. The UI/project/request validators reject reference budget overflow beyond 20.
2. Each Agent run creates a unique session id and nonce.
3. The newest approved knowledge snapshot is selected every run.
4. The dedicated Agent UI shows the active persona and outbox state.
5. The writeback token cannot be reused.
6. Recovery restores the canvas after a forced restart.
7. Win7 mode still respects the 30 FPS floor.

- [ ] **Step 2: Run the full verification suite**

Run:

```bash
npm test
npm run typecheck
npm run build
npm run e2e
```

Then run the manual Windows matrix for Windows 7 SP1 x64, Windows 10 x64, and Windows 11 x64, including Chinese-path open/save and recovery checks.

- [ ] **Step 3: Self-review before completion**

Confirm there are no placeholders, TODOs, or contradictory rules in the implementation plan. Confirm the plan never asks for full serialization on pointermove, never allows source writeback without a fresh one-use token, and never exceeds the 20-reference cap.

---

## Figma Gate

If the Figma tools are available in this task, create and verify the design file. If they are not available, keep the gate explicitly pending rather than substituting a mock approval.

Runtime verification still requires screenshots of the shipped app, including the Agent panel, reference budget state, writeback outbox, and recovery behavior.

---

## Execution Order

1. Lock the reference budget and request validation contracts.
2. Add the one-use writeback token and offline outbox.
3. Implement reverse-prompt personas and structured outputs.
4. Build the dedicated Agent UI.
5. Add canvas snapshots, incremental journal entries, and crash recovery.
6. Add viewport culling, lazy image loading, and degradation modes.
7. Run the full verification suite and manual compatibility matrix.

## Self-Review Notes

- No placeholder file names remain in the plan.
- The plan keeps `base`, `app`, and `source` writeback roles distinct.
- The plan resolves the only hard constraint conflict by making pointermove transient and committing persistence only at stable boundaries.
- The plan keeps the Agent UI dedicated instead of embedding it in generic canvas chrome.
