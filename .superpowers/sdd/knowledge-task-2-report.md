# Task 2 Report: Structured Feedback Memory and Candidate Lifecycle

## Scope

- Worktree: `E:\画布项目\.worktrees\canvas-agent-mvp`
- Branch: `feature/canvas-agent-mvp`
- Task brief: `E:\画布项目\.worktrees\canvas-agent-mvp\.superpowers\sdd\knowledge-task-2-brief.md`

## Files Changed

- `packages/domain/src/project-memory.ts`
- `packages/domain/src/project-memory.test.ts`
- `packages/domain/src/project-schema.ts`
- `packages/domain/src/project-schema.test.ts`
- `packages/domain/src/project-transaction.test.ts`
- `packages/domain/src/index.ts`
- `E:\画布项目\.worktrees\canvas-agent-mvp\.superpowers\sdd\knowledge-task-2-report.md`

## RED Evidence

Command:

```bash
npm test -- packages/domain/src/project-memory.test.ts packages/domain/src/project-schema.test.ts packages/domain/src/project-transaction.test.ts
```

Result:

- Exit code: `1`
- `project-memory.test.ts`: missing `createUserFeedbackMemory` and `reviewSkillPromotionCandidate`
- `project-transaction.test.ts`: missing `createUserFeedbackMemory`
- `project-schema.test.ts`: candidate schema still only accepted `pending_review` and did not allow lifecycle metadata

Representative failures:

- `TypeError: (0 , createUserFeedbackMemory) is not a function`
- `TypeError: (0 , reviewSkillPromotionCandidate) is not a function`
- schema rejection for `reviewStatus: 'approved'` plus unrecognized `reviewedAt`

## GREEN Implementation

Implemented:

- Structured user feedback memory creation with:
  - lease provenance
  - ordered references
  - citations
  - structured visual observations
  - existing secret/private-path sanitization through collection validation
- Backward-compatible `SkillPromotionCandidate` lifecycle schema with:
  - `pending_review`
  - `approved`
  - `rejected`
  - `superseded`
  - `rolled_back`
- Explicit review helpers:
  - `createUserFeedbackMemory`
  - `reviewSkillPromotionCandidate`
  - `rollbackSkillPromotionCandidate`
- Optional candidate metadata:
  - `sourceProjectMemoryIds`
  - `targetKnowledgeBaseId`
  - `targetKnowledgeSection`
  - `beforeRule`
  - `counts`
  - `confidence`
  - `affectedCapabilities`
  - `reviewedAt`
  - `publishedKnowledgeVersion`
  - `rolledBackAt`
- Project schema support for promoting active `user_feedback` memories
- Public export of `skillPromotionCandidateSchema` for downstream consumers

## Verification Commands and Results

### Focused Task 2 command

```bash
npm test -- packages/domain/src/project-memory.test.ts packages/domain/src/project-schema.test.ts packages/domain/src/project-transaction.test.ts
```

Result:

- Exit code: `0`
- `3` test files passed
- `34` tests passed

### Typecheck

```bash
npm run typecheck
```

Result:

- Exit code: `0`

### Full test suite

```bash
npm test
```

Result:

- Exit code: `0`
- `35` test files passed
- `1` test file skipped
- `306` tests passed
- `1` test skipped

## Self-Review Notes

- Kept all new candidate fields optional so old fixtures still parse.
- Preserved the snapshot+journal transaction model by limiting changes to domain schemas and helpers.
- Avoided filesystem/network behavior.
- Kept candidate transitions explicit in helper APIs and schema validation.
- Allowed `user_feedback` as a promotable active memory kind without widening unrelated memory behavior.

## Concerns

- `createUserFeedbackMemory` currently synthesizes `snapshots.beforeId` and `snapshots.afterId` from the memory id because the brief did not supply snapshot ids. This keeps the existing memory schema intact without altering transaction storage shape.
- The updated tests intentionally avoid depending on mojibake error text and instead assert behavior.

## Commit

- Requested commit message: `feat: add feedback memory lifecycle`
- Final commit: `feat: add feedback memory lifecycle` (see task response for the exact hash)
