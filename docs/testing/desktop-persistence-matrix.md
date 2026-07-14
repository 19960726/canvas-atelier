# Desktop Persistence Test Matrix

Status values:

- `pass`: manually exercised on the named runtime.
- `automated-pass`: covered by an automated test, not a GUI/runtime claim.
- `not-run`: unavailable or not exercised; no pass is implied.

## Automated Evidence

| Check | Status | Evidence |
| --- | --- | --- |
| Force-kill recovery at all eight fault points | automated-pass | `crash-recovery.integration.test.ts`: 8/8 passing on 2026-07-15 |
| ACK-gated recovery | automated-pass | Recovered revision equals the last durable acknowledgement for every fault point |
| Partial journal tail rejection | automated-pass | `during_append` leaves a partial final line and recovery does not apply it |
| Chinese project path | automated-pass | Crash harness creates and reopens a project under a Chinese-character directory name |
| Pointermove persistence prohibition | automated-pass | Existing renderer/domain tests remain in the full suite; Task 9 adds no pointermove persistence |
| 10,000 transaction replay | automated-pass | 95.9 ms on Node 24.14.0, Windows build 10.0.26100.4349; budget is less than 1,000 ms |

## Manual Windows Runtime Matrix

The current host is Windows build `10.0.26100.4349` (Windows 11 generation). The OS product label reports `Windows 10 Pro`, which is a known stale-label pattern on some Windows 11 installations; the build number is the recorded runtime evidence.

| Runtime | Create | Save | Force-kill | Auto recovery | Choice recovery | Read-only | Export | Import | Chinese paths | Removable storage | 1366x768 | 1440x900 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Windows 7 SP1 x64, Electron 22 legacy | not-run | not-run | not-run | not-run | not-run | not-run | not-run | not-run | not-run | not-run | not-run | not-run |
| Windows 10 x64, modern shell | not-run | not-run | not-run | not-run | not-run | not-run | not-run | not-run | not-run | not-run | not-run | not-run |
| Windows 11 x64, Electron 22 legacy | not-run | not-run | not-run | not-run | not-run | not-run | not-run | not-run | not-run | not-run | not-run | not-run |
| Windows 11 x64, Electron 43 modern | not-run | not-run | not-run | not-run | not-run | not-run | not-run | not-run | not-run | not-run | not-run | not-run |

## Availability Notes

- No Windows 7 physical machine or approved VM was available.
- No Windows 10 physical machine or approved VM was available.
- The Electron 22.3.27 legacy executable is present, but GUI automation/native-dialog control was unavailable, so its runtime rows remain `not-run`.
- The Electron 43.1.0 modern package is present, but its executable binary is unavailable in this worktree.
- GUI automation and screenshot capture were not available in this Task 9 session, so normal canvas load, forced renderer failure safe mode, 1366x768, and 1440x900 remain `not-run`.
- Removable storage was not available.
- Automated force-kill coverage is not promoted to a manual runtime `pass`.

Snapshot-plus-journal persistence is automated-test complete. Release completion remains gated on the unavailable manual runtime rows above.
