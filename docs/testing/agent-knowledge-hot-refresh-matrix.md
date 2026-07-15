# Agent Knowledge Hot Refresh Runtime Matrix

Task 10 verification was executed in the current Codex Windows workspace only. Physical/VM runtime rows below are marked `not-run` unless that exact environment was actually exercised.

| Environment | local edit | no-restart refresh | active-run pinning | next-run update | offline fallback | cross-device approved update | reorder persistence | `@image` | approve | reject | rollback | task/history preservation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Windows 7 Legacy | not-run | not-run | not-run | not-run | not-run | not-run | not-run | not-run | not-run | not-run | not-run | not-run |
| Windows 10 Modern | not-run | not-run | not-run | not-run | not-run | not-run | not-run | not-run | not-run | not-run | not-run | not-run |
| Windows 11 Modern | not-run | not-run | not-run | not-run | not-run | not-run | not-run | not-run | not-run | not-run | not-run | not-run |
| Codex Windows workspace | pass | pass | pass | pass | pass | not-run | pass | pass | pass | pass | pass | pass |

Notes:
- `cross-device approved update` requires a second device or approved VM sync fixture and was not executed here.
- Windows 7 is not claimed without an approved Windows 7 VM or physical runtime.
