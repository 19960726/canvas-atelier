# Task 7 Report: Narrow Knowledge Bridge and Dual-Shell Events

Status: pending

## RED Evidence

- Command: `npm test -- packages/desktop-core/src/bridge-contract.test.ts`
- Result: exit `1`.
- Expected failure reason: the new Task 7 bridge contract tests failed because `createPreloadApi` did not expose knowledge methods, `subscribeKnowledgeState` did not exist, `createDesktopBridgeHandlers` did not implement knowledge handlers, and `registerDesktopBridgeHandlers` did not register knowledge invoke channels.
- Failure summary: `6` tests failed and `9` passed.

## GREEN Evidence

- Focused GREEN:
  - Command: `npm test -- packages/desktop-core/src/bridge-contract.test.ts`
  - Result: exit `0`; `15` tests passed.
- Typecheck:
  - Command: `npm run typecheck`
  - Result: exit `0`.
- Build:
  - First command: `npm run build`
  - First result: exit `1` with `TS5033` `EPERM: operation not permitted` writing files under `packages/desktop-core/dist`.
  - Elevated rerun: `npm run build`
  - Elevated result: exit `0`; renderer build emitted the existing Vite chunk-size warning.
- Full tests:
  - Command: `npm test`
  - Result: exit `0`; `40` files passed, `1` skipped; `381` tests passed, `1` skipped.
- Diff sanity:
  - Command: `git diff --check`
  - Result: exit `0`; Git emitted LF-to-CRLF working-copy warnings only.

## Modified Files

- `packages/desktop-core/src/contracts.ts`
- `packages/desktop-core/src/preload-api.ts`
- `packages/desktop-core/src/bridge-handlers.ts`
- `packages/desktop-core/src/bridge-contract.test.ts`
- `packages/desktop-core/src/index.ts`
- `apps/desktop-legacy/src/main.ts`
- `apps/desktop-legacy/src/preload.ts`
- `apps/desktop-modern/src/main.ts`
- `apps/desktop-modern/src/preload.ts`
- `.superpowers/sdd/knowledge-task-7-report.md`

## Self-Review

- The preload API exposes the existing methods plus `configureKnowledgeBase`, `getKnowledgeState`, `reviewSkillCandidate`, and `subscribeKnowledgeState`; it still exposes no raw filesystem methods.
- Knowledge configuration accepts only public metadata from renderer and uses the main-process directory picker result for the trusted root.
- Knowledge state results and service-forwarded events are re-shaped as public `KnowledgeBaseStateSummary` payloads before leaving desktop-core/main.
- Candidate review resolves exactly one writable active project session by `projectId`, rejects missing sessions/projects/candidates with `INVALID_REQUEST`, and persists reviewed candidates through the existing project journal writer.
- Both Electron shells create one managed knowledge store/service, forward service events via `webContents.send`, and unsubscribe/stop during shutdown through `closeAllProjects`.

## Commit

- Commit: pending until commit is created.

## Concerns

- `npm run build` still needs elevated filesystem permission to write `packages/desktop-core/dist` in this managed worktree.
- Git reports LF-to-CRLF working-copy warnings for touched files on Windows.
