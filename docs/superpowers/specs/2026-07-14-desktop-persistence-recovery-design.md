# Novus Atelier Desktop Persistence and Recovery Design

**Date:** 2026-07-14  
**Status:** Approved design  
**Scope:** Windows desktop project persistence, crash recovery, project packaging, and the renderer-to-desktop storage bridge

## Purpose

Novus Atelier must save large infinite-canvas projects without interrupting interaction, recover after crashes without producing a blank window, and keep one project format compatible across Windows 7 through Windows 11.

This design replaces the renderer-only `localStorage` bundle with a desktop-owned project repository. The existing bundle remains only as migration input until desktop persistence is fully adopted.

## Confirmed Product Decisions

1. Projects use a hybrid location model. User projects live in a user-selected folder; AppData stores unsaved drafts, recovery mirrors, cache, settings, and redacted diagnostics.
2. Live work uses a project directory. Sharing and archival use a single `.novuspack` export.
3. Recovery is automatic only when there is one unambiguous valid chain. Damage, incomplete writes, concurrent access, or multiple recovery candidates open a recovery window.
4. Every committed operation appends a small journal transaction. Stable snapshots are created on pointer release, transaction completion, idle time, explicit save, or compaction boundaries. `pointermove` never serializes the project.
5. Desktop delivery uses two runtime channels: Windows 7 uses Electron 22 Legacy; Windows 10/11 use maintained Modern Electron.
6. Both channels share the same domain code, project schema, journal format, Agent and Skill contracts, provider adapters, and `.novuspack` format.

## Scope Boundaries

This phase includes the desktop storage bridge, live project directory, incremental journal, immutable snapshots, atomic asset import, locking, recovery, safe mode, read-only opening, package import/export, and compatibility and fault-injection tests.

This phase does not implement generation-history UI, Agent conversation-history UI, the full cache-management settings UI, Photoshop integration, signed updates, or Comfly model compatibility. Safe mode still includes emergency clearing of disposable cache categories. The larger features consume this foundation in separate phases.

## Runtime Architecture

The desktop code has three ownership boundaries:

- `desktop-legacy`: Electron 22 shell, Windows 7 packaging, Legacy update channel, and Legacy smoke tests.
- `desktop-modern`: maintained Electron shell, Windows 10/11 packaging, Modern update channel, and Modern smoke tests.
- `desktop-core`: shared storage bridge, project repository, journal, snapshot scheduling, recovery, locking, and package import/export.

The renderer never receives unrestricted filesystem access. A context-isolated preload exposes a narrow typed bridge. Every request validates project identity, revision, operation schema, and allowed path ownership in the desktop main process.

Core services:

- `ProjectRepository`: create, open, close, save-as, read-only mode, manifest updates, and atomic replacement.
- `JournalWriter`: serialized per-project append queue, idempotent transaction IDs, durable acknowledgements, and journal rotation.
- `SnapshotScheduler`: stable-boundary scheduling, background replay, snapshot verification, and compaction.
- `RecoveryScanner`: lock inspection, snapshot and journal validation, recovery candidates, and quarantine.
- `AssetStore`: temporary staging, SHA-256 hashing, metadata extraction, content-addressed placement, and reference validation.
- `NovusPackExporter`: revision-pinned export and hostile-package-safe import.

## Live Project Directory

Every live project uses a `.novus-project` directory:

```text
ProjectName.novus-project/
|-- project.novus.json
|-- assets/
|-- snapshots/
|-- journal/
|   |-- active.ndjson
|   `-- archive/
|-- recovery/
|   |-- project.lock
|   |-- clean-close.json
|   `-- quarantine/
`-- indexes/
```

`project.novus.json` contains the project ID and name, format version, stable snapshot ID and revision, active journal segment, next sequence, asset inventory summary, clean-close state, and minimum compatible writer version.

The manifest contains no API keys, Authorization values, original image Base64, device secrets, or absolute paths. Project-internal paths are normalized relative paths. `indexes/` is rebuildable; deleting it cannot damage authoritative project data.

## AppData Ownership

AppData contains unsaved drafts, recovery mirrors, disposable cache, application settings, and redacted diagnostics. It never becomes the only authoritative location for a named project. Cache clearing cannot delete projects, approved knowledge, project memory, generation history, or Agent history.

## Journal Contract

Each committed canvas or Agent transaction is one UTF-8 NDJSON line. Asset bytes never enter the journal.

A record contains `schemaVersion`, `projectId`, monotonic `sequence`, resulting `revision`, unique `transactionId`, UTC `committedAt`, transaction `kind`, validated domain operations, and a SHA-256 checksum.

The checksum covers the canonical UTF-8 JSON transaction payload and excludes the checksum field. Canonical JSON uses stable key ordering shared by Legacy and Modern runtimes. Transaction IDs are idempotency keys: retrying an already committed transaction returns its existing revision instead of applying it twice.

## Save Data Flow

1. `pointermove` and continuous interaction update renderer memory only.
2. `pointerup` collapses the interaction into one final domain transaction.
3. Renderer submits `projectId`, `baseRevision`, `transactionId`, and operations through the desktop bridge.
4. `desktop-core` validates the request and rejects revision conflicts.
5. `JournalWriter` assigns the next sequence and appends one complete journal line.
6. The writer performs the required durable flush.
7. The bridge returns an acknowledgement with the committed revision.
8. Renderer shows saved only after that acknowledgement.

Revision conflicts never overwrite newer data. Renderer reloads the desktop-owned state and either rebases a supported operation or asks the user to resolve the conflict.

Stable boundaries include pointer release after transform editing, asset changes, Agent confirmation, generation-result insertion, explicit save, approximately five seconds of idle time, and project close.

Ordinary durable flushes may be grouped for no more than approximately 250 milliseconds. Explicit save, asset commit, Agent transaction, and normal close require immediate durable flush. The UI remains in a saving state until acknowledgement.

## Asset Commit Flow

1. Stream bytes into a temporary file on the destination volume.
2. Validate size and supported media type.
3. Calculate SHA-256 and inspect dimensions without loading the full image into renderer memory.
4. Assign a short ASCII content-addressed filename.
5. Atomically rename the temporary file into `assets/`.
6. Append a transaction referencing asset ID, relative path, media type, dimensions, byte size, and checksum.

If journal append fails, the unreferenced asset is quarantined. If asset rename fails, no project transaction is committed.

## Snapshot and Compaction Flow

Snapshots are immutable gzip-compressed JSON containing project state, revision, snapshot ID, previous snapshot ID, creation time, and the SHA-256 of uncompressed canonical project JSON.

Snapshot creation does not pause journal writes:

1. Rotate `active.ndjson` to an immutable segment.
2. Immediately create a new active journal.
3. Rebuild the target revision from the last verified snapshot and rotated segments.
4. Write a temporary snapshot on the same volume.
5. Decompress and validate it.
6. Atomically rename it into `snapshots/`.
7. Atomically replace `project.novus.json` to reference it.
8. Gzip eligible old journal segments.

A snapshot is scheduled near 200 committed transactions, near 4 MB of active journal, after a large Agent transaction, on a user stable point, after about five idle seconds with pending changes, or on normal close. Only one snapshot worker runs per project. Later transactions remain in newer journal segments.

## Locking and Concurrent Access

Write opening uses exclusive lock-file creation. The lock records project, device, process, application channel, session, opened time, and heartbeat.

A second local process cannot write the same project. It may open read-only or create a copy. A stale local lock is reclaimed only after heartbeat expiration and local process verification. For network or removable locations where ownership is unreliable, an existing lock defaults to read-only and is never silently broken.

## Intelligent Recovery

Normal close performs final flush, creates a close snapshot when needed, writes `clean-close.json`, and removes the lock.

After an unclean shutdown, `RecoveryScanner`:

1. Validates snapshots newest to oldest.
2. Selects the newest valid supported snapshot.
3. Validates journal segments from that revision forward.
4. Requires continuous sequences, matching project IDs, valid checksums, and valid domain operations.
5. Replays complete transactions only.
6. Writes the candidate result into AppData before changing the project.
7. Verifies the candidate and referenced assets.

Automatic recovery is allowed only for one valid chain where damage is limited to an incomplete final line or stale local lock. Original damaged files remain until the recovered state passes validation.

The recovery window appears for checksum failure before the tail, sequence or revision gaps, damaged latest snapshots, multiple candidates, possible concurrent ownership, or a newer writer format.

Actions are recover to the final valid transaction, return to the latest stable snapshot, open read-only, or reveal quarantine. Read-only mode permits inspection, export, and save-as but cannot mutate the original.

## Safe Mode and Nonblank Failure UI

Recovery and safe mode use a minimal desktop page that does not load the infinite canvas, Agent, providers, plugins, or project assets.

If renderer startup, cache metadata, or project hydration fails, the shell still displays safe mode. It supports opening another project, read-only opening, selecting a stable point, clearing disposable cache categories, exporting redacted diagnostics, and revealing quarantine and recovery folders. A blank unrecoverable window is a release-blocking defect.

## `.novuspack` Export and Import

`.novuspack` is a ZIP64 archive with a package manifest and SHA-256 inventory.

Export pins one stable revision, selects or creates its verified snapshot, collects only referenced assets and authoritative history, builds in the background, validates the archive, and atomically moves it to the destination. Later edits do not enter the pinned export.

Packages exclude credentials, AppData drafts, caches, absolute paths, diagnostics, device identity, and unapproved cross-device knowledge queues.

Import extracts into AppData isolation and rejects absolute paths, parent traversal, symbolic links, executable payloads, unsupported schemas, excessive counts or sizes, checksum mismatches, invalid references, and missing assets. Only a fully validated project is atomically moved to the selected destination. Existing projects are never silently overwritten.

## Performance Budgets

- Storage calls during `pointermove`: exactly zero.
- Renderer-to-IPC enqueue: p95 below 4 ms, excluding disk acknowledgement.
- No synchronous filesystem work in the renderer event loop.
- Saving creates no interaction stall longer than one rendered frame.
- Replay of 10,000 lightweight transactions targets below 1 second on a modern reference machine.
- Windows 7 mechanical-disk recovery targets below 5 seconds with visible progress.
- Saving 1,000 lightweight nodes and 200 image nodes does not load every image into memory.
- Compaction starts near 4 MB or 200 transactions and never runs multiple snapshot workers for one project.

## Windows Compatibility Rules

- Shared persistence uses only Electron 22-compatible APIs unless isolated behind a runtime adapter.
- No symbolic links, hard links, or newer-Windows-only project operations.
- Atomic rename and replacement occur on the same volume.
- Internal filenames are short ASCII names.
- Unsafe Win7 project-root path lengths are rejected before creation or import.
- Legacy and Modern use identical schema and package fixtures.
- Legacy may read a supported subset of newer projects read-only but never overwrites a project requiring a newer writer.

## Error Handling

Typed failures include disk full, permission denied, read-only volume, revision conflict, concurrent writer, missing asset, corrupt snapshot, corrupt journal, unsupported project version, and package validation failure.

Every failure preserves the last verified state. Retry never duplicates a transaction. Messages expose no credentials, raw image bytes, or unrelated private paths.

## Testing Strategy

### Domain Tests

Test sequences, revisions, transaction idempotency, canonical checksums, snapshot-plus-journal equivalence, supersede and recovery semantics, and shared Legacy/Modern fixtures.

### Filesystem Integration Tests

Test temporary write and rename, partial final lines, corrupt snapshot/manifest/journal, missing assets, disk full, permission denial, read-only directories, journal rotation during writes, and concurrent opening.

### Crash Injection Tests

Terminate before append, during append, after append before flush, after temporary snapshot before rename, before and after manifest replacement, during compaction, and during export. Restart must recover exactly through the last acknowledged transaction; half a transaction never appears.

### Bridge and Renderer Tests

Verify zero persistence requests on `pointermove`, one final transaction on `pointerup`, pending/saving/saved/failed states, acknowledgement-gated saved status, revision-conflict protection, no arbitrary filesystem access, and recoverable UI instead of a blank window.

### Package Security Tests

Test path traversal, absolute paths, symbolic links, zip bombs, configured size limits, checksum mismatch, newer versions, Chinese names, spaces, removable drives, path limits, and export while later edits continue.

### Runtime Matrix

Run start, save, forced termination, recovery, export, and import on Windows 7 Legacy, Windows 10 Modern, and Windows 11 Modern. Verify recovery and safe-mode UI at 1366x768 and 1440x900.

## Acceptance Criteria

1. Every transaction acknowledged as saved exists after restart.
2. Incomplete transactions never partially change state.
3. Damage leads to automatic recovery, a recovery choice, or read-only opening, never a blank window.
4. Cache cleanup and recovery never delete authoritative project files.
5. Projects, journals, snapshots, packages, logs, and diagnostics contain no API keys, Authorization values, raw image Base64, or unintended absolute paths.
6. Legacy and Modern open the same supported fixtures and produce compatible packages.
7. Canvas interaction remains responsive during journaling, snapshots, compaction, export, and recovery scanning.