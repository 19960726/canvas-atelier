# Windows Compatibility Matrix

Task 12 evidence date: 2026-07-16.

This matrix records automated renderer acceptance separately from target operating-system compatibility. The automated rows below were run on the current local renderer with installed Microsoft Edge. They are not evidence that Windows 7, Windows 10, Windows 11, portable packaging, or installer targets passed.

## Automated Renderer Evidence

| Area | Status | Command evidence | Notes |
| --- | --- | --- | --- |
| Playwright renderer acceptance | passed | `npm run e2e` -> 6 passed | Used local Vite server, one worker, installed Edge executable, no Playwright browser download. |
| Reference workflow | passed | `npm run e2e -- tests/e2e/agent-reference-workflow.spec.ts` -> 1 passed | Generated local PNG product, scene, and prop fixtures; covered upload, order, placement, ghost plan, confirm, undo, reconfirm, and model confirmation. |
| Skill guarded sync | passed | `npm run e2e -- tests/e2e/skill-sync-guard.spec.ts` -> 1 passed | In-memory fake knowledge adapter; source/managed/proposed diff; no sync write before `确认同步`. |
| Model confirmation and route switching | passed | `npm run e2e -- tests/e2e/model-confirmation.spec.ts` -> 1 passed | Same Agent conversation while switching GPT Image and Nano Banana 2; no queue before confirmation; cancel/retry deterministic. |
| Renderer layout screenshots | passed | `npm run e2e -- tests/e2e/visual-layout.spec.ts` -> 3 passed | Captured 1440x900, 1920x1080, and 1366x768 screenshots in Playwright output only. |
| Pan/zoom frame marks | passed | `npm run e2e -- tests/e2e/visual-layout.spec.ts` -> 3 passed | Median frame interval recorded through `performance.mark('novus-pan-zoom-frame')` attachments; conservative renderer CI threshold only. |
| Unit/integration suite | passed | `npm test` -> 715 passed, 2 skipped | Performance-only suites remain skipped unless their explicit perf env vars are set. |
| TypeScript | passed | `npm run typecheck` -> passed | Includes renderer e2e test-mode types. |
| Build verification | passed | `npm run build` -> passed | Initial sandbox run hit `EPERM` writing `dist`; identical unsandboxed rerun passed. No pack or installer command was run. |
| Secret/path scan | passed | `npm run scan:e2e` -> passed | Scanned Playwright config, e2e specs/helpers, renderer test-mode harness, and this matrix. |
| Whitespace diff check | passed | `git diff --check` -> passed | Line-ending warnings only; no whitespace errors. |

## Target Windows Rows

| Target | Capability | Status | Evidence | Notes |
| --- | --- | --- | --- | --- |
| Windows 7 SP1 x64 | Launch | pending | not available | Not run on physical or VM Windows 7 target. |
| Windows 7 SP1 x64 | Chinese path open/save | pending | not available | Not run on physical or VM Windows 7 target. |
| Windows 7 SP1 x64 | Comfly HTTPS | pending | not available | No live provider/network target run. |
| Windows 7 SP1 x64 | Pan/zoom | pending | not available | Current renderer marks are not Win7 FPS evidence. |
| Windows 7 SP1 x64 | 200-image navigation | pending | not available | Not run on physical or VM Windows 7 target. |
| Windows 7 SP1 x64 | Recovery | pending | not available | Not run on physical or VM Windows 7 target. |
| Windows 7 SP1 x64 | Safe mode | pending | not available | Not run on physical or VM Windows 7 target. |
| Windows 7 SP1 x64 | Installer/portable | pending | not available | Pack/installer was intentionally not run. |
| Windows 10 x64 | Launch | pending | not available | Not run on physical or VM Windows 10 target. |
| Windows 10 x64 | Chinese path open/save | pending | not available | Not run on physical or VM Windows 10 target. |
| Windows 10 x64 | Comfly HTTPS | pending | not available | No live provider/network target run. |
| Windows 10 x64 | Pan/zoom | pending | not available | Current renderer marks are not Win10 FPS evidence. |
| Windows 10 x64 | 200-image navigation | pending | not available | Not run on physical or VM Windows 10 target. |
| Windows 10 x64 | Recovery | pending | not available | Not run on physical or VM Windows 10 target. |
| Windows 10 x64 | Safe mode | pending | not available | Not run on physical or VM Windows 10 target. |
| Windows 10 x64 | Installer/portable | pending | not available | Pack/installer was intentionally not run. |
| Windows 11 x64 | Launch | pending | not available | Not run on physical or VM Windows 11 target. |
| Windows 11 x64 | Chinese path open/save | pending | not available | Not run on physical or VM Windows 11 target. |
| Windows 11 x64 | Comfly HTTPS | pending | not available | No live provider/network target run. |
| Windows 11 x64 | Pan/zoom | pending | not available | Current renderer marks are not Win11 FPS evidence. |
| Windows 11 x64 | 200-image navigation | pending | not available | Not run on physical or VM Windows 11 target. |
| Windows 11 x64 | Recovery | pending | not available | Not run on physical or VM Windows 11 target. |
| Windows 11 x64 | Safe mode | pending | not available | Not run on physical or VM Windows 11 target. |
| Windows 11 x64 | Installer/portable | pending | not available | Pack/installer was intentionally not run. |

## Delivery Gates

| Gate | Status | Evidence | Notes |
| --- | --- | --- | --- |
| Figma editable delivery | pending | not available | No Figma connection/editable file approval was completed; renderer screenshots are not a substitute. |
| Portable package | pending | not available | Packaging was explicitly deferred. |
| Installer package | pending | not available | Packaging was explicitly deferred. |
