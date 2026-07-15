# Task 8 Report: Renderer Knowledge Client, Status, and Run Pinning

Status: pending

## RED Evidence

- Command: `npm test -- apps/renderer/src/app/knowledge-client.test.ts apps/renderer/src/agent/KnowledgeStatus.test.tsx apps/renderer/src/agent/ReversePromptAgent.test.tsx apps/renderer/src/app/app-store.test.ts`
- Result: exit `1`.
- Expected failure reason: new renderer knowledge tests failed because `apps/renderer/src/app/knowledge-client.ts` and `apps/renderer/src/agent/KnowledgeStatus.tsx` did not exist, `replaceKnowledgeClientForTests` did not exist in `app-store`, and `ReversePromptAgent` had not yet called an injected `getKnowledgeLease`.
- Failure summary after test cleanup: `4` files failed; missing `knowledge-client`, missing `KnowledgeStatus`, `replaceKnowledgeClientForTests` was not a function, and the new ReversePromptAgent lease test observed `getKnowledgeLease` called `0` times.

## GREEN Evidence

- Focused GREEN:
  - Command: `npm test -- apps/renderer/src/app/knowledge-client.test.ts apps/renderer/src/agent/KnowledgeStatus.test.tsx apps/renderer/src/agent/ReversePromptAgent.test.tsx apps/renderer/src/app/app-store.test.ts`
  - Result: exit `0`; `4` files passed; `30` tests passed.
- Typecheck:
  - Command: `npm run typecheck`
  - Result: exit `0`.
- Full test suite:
  - Command: `npm test`
  - Result: exit `0`; `42` files passed, `1` skipped; `394` tests passed, `1` skipped.
- Diff sanity:
  - Command: `git diff --check`
  - Result: exit `0`; Git emitted LF-to-CRLF working-copy warnings only.

## Modified Files

- `apps/renderer/src/app/knowledge-client.ts`
- `apps/renderer/src/app/knowledge-client.test.ts`
- `apps/renderer/src/agent/KnowledgeStatus.tsx`
- `apps/renderer/src/agent/KnowledgeStatus.test.tsx`
- `apps/renderer/src/app/app-store.ts`
- `apps/renderer/src/app/app-store.test.ts`
- `apps/renderer/src/agent/ReversePromptAgent.tsx`
- `apps/renderer/src/agent/ReversePromptAgent.test.tsx`
- `apps/renderer/src/types/novus-desktop.d.ts`
- `.superpowers/sdd/knowledge-task-8-report.md`

## Self-Review

- `KnowledgeClient` reads only `window.novusDesktop` bridge methods, hydrates public summaries, applies subscription/review/configure updates, and uses browser fallback with an offline public summary plus unconfigured leases.
- Lease creation pins the currently available active/fallback/rolled-back public active versions at call time; existing run objects keep their original lease after later refresh events.
- `ReversePromptAgent.startAnalysis()` calls `getKnowledgeLease()` exactly once per run before `createReversePromptRun()` and displays the latest pinned lease without clearing history when knowledge status changes to fallback.
- App store knowledge actions delegate to the renderer client by knowledge base id/display name or review payload only; no root path is stored in renderer state.
- The renderer type boundary now exposes a project-persistence-only bridge overload so existing persistence tests can continue using their narrow bridge doubles while `Window.novusDesktop` remains the full bridge API.

## Commit

- Commit hash: pending until commit is created; final task response contains the actual commit hash.

## Concerns

- `CanvasWorkspace.tsx` is outside the Task 8 write scope, so this task did not thread store knowledge props through that parent. `ReversePromptAgent` now supports the lease/status injection and preserves its safe unconfigured fallback when the parent does not supply it.
- Git reports LF-to-CRLF working-copy warnings for touched renderer files on Windows.
