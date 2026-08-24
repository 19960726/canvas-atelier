# Project Recovery and Save Repair Design

## Goal

When CanvasForge starts from a recovery candidate whose original managed project directory or recent-project entry is missing, present an explicit recovery state and let the user restore the candidate into a writable durable project without losing canvas content, generated assets, or recoverable model jobs.

## Confirmed Runtime Failure

- The active canvas project is `16b485e8-f2aa-4c0d-b20e-f9047e70d367` with three nodes and generated asset `11afb75350f8a20b`.
- Its managed project directory is no longer present under `CanvasForge/projects` and `recent-projects.index.json` contains no entries.
- Complete recovery mirrors still exist under the matching `CanvasForge/recovery/project-*` directory at revision 5.
- The renderer therefore shows the candidate as a recovery preview: recent saved projects are `0`, recovery versions are `1`, and normal persistence is blocked by `RECOVERY_REQUIRED`.
- The recovery mirror still owns running image job `model-job-v2-51ac85d5e22c82301cb7c14019ebbce0`, whose result asset already exists but has not been committed into the source node.

## Chosen Experience

Use explicit one-click recovery rather than automatic startup restoration.

- Recovery state must be visually distinct from an ordinary untitled canvas.
- The recovery section is expanded when recovery is required.
- The primary action reads `恢复并继续` and explains that it will recreate a writable project.
- Normal save, new-project, and open-project actions remain blocked until recovery is restored or explicitly discarded.
- No recovery candidate, project asset, or provider job is deleted as part of merely viewing the recovery state.

## Architecture

### 1. Recovery source is independent of the missing project root

The desktop bridge must retain enough trusted metadata when it selects a recovery mirror to restore it even if the original managed project directory has disappeared. The bridge session records:

- the validated recovery candidate payload;
- the original project ID and candidate revision;
- the intended managed project root;
- whether the root and manifest currently exist.

The recovery candidate remains validated through the existing project schema and project-ID checks.

### 2. Restore recreates a durable managed project when necessary

The restore command has two paths:

- If the original project root and manifest exist, use the existing restore-in-place behavior.
- If they are missing, create a new managed project root for the same project ID from the validated recovery candidate, write the stable snapshot and manifest atomically, open a writable session, and preserve the candidate revision as the restored revision.

After either path succeeds, update the recent-project store with the recreated/opened root and current project summary. The operation is idempotent: retrying after an acknowledged restore must reopen the same durable project rather than create duplicates.

### 3. Renderer recovery state

`ProjectManagerPopover` receives an explicit `recoveryRequired` flag in addition to snapshot IDs.

- The recovery `<details>` element opens by default while recovery is required.
- It renders a warning explaining that the current canvas is a protected recovery preview.
- Its selected/latest candidate exposes a `恢复并继续` action.
- The action reports a visible error if desktop restoration fails and remains retryable.
- Recent projects reload after successful recovery, so the restored project appears immediately.

The current canvas name and node counts remain visible throughout recovery.

### 4. Resume the owned image job only after durable recovery

While `recoveryRequired` is true, model-job recovery must not write into the preview. After restoration returns a durable writable session, the existing selective job recovery runs again. It may retain and poll only a running job whose formal source node has the exact matching `lastResultJobId`.

For the current project this should commit asset `11afb75350f8a20b` into the original image-generation node, set `resultState` to `fresh`, set execution state to `completed`, complete the IndexedDB job, render the preview, and stop the timer.

## Error Handling and Data Safety

- Never overwrite a different existing project with the same destination path.
- Never delete recovery mirrors as a prerequisite for restoration.
- If atomic project creation fails, roll back only the newly created incomplete managed root and leave recovery mirrors intact.
- If recent-project indexing fails after durable restoration, keep the restored project open and surface an index warning; do not roll back valid project data.
- A stale candidate whose project ID does not match the active recovery session is rejected.
- A removed source node or newer `lastResultJobId` prevents stale model-result continuation.
- Discard recovery remains a separate explicit action and must not be triggered by Save, New, Open, or closing the manager.

## Adjacent Bug Audit

The implementation review covers the same persistence boundary only:

- startup hydration with existing and missing managed roots;
- recovery list visibility and retry behavior;
- restoring in place and rebuilding a missing root;
- recent-project upsert, missing-entry display, relocation, and duplicate prevention;
- Save/Save As after recovery;
- New and Open actions while recovery is unresolved;
- clean close versus forced termination;
- generated asset catalog preservation;
- selective model-job resumption after recovery.

Unrelated canvas editing, provider configuration, and visual redesign are out of scope.

## Verification

Automated coverage must include:

- a missing-root recovery candidate restores into a new durable managed project;
- restored project metadata and assets match the recovery candidate;
- recent-project index contains exactly one available entry after restoration;
- recovery UI is expanded and shows `恢复并继续` while blocked;
- failed restoration leaves the action retryable and the candidate intact;
- Save/New/Open remain blocked before restore and work after restore;
- the exact owned running image job resumes after restore;
- stale or unrelated running jobs remain cancelled/rejected;
- existing-root recovery behavior remains compatible.

Run focused renderer and desktop-core suites, then full type checking and production build. Finally restore the current real recovery candidate and verify the durable node result, IndexedDB terminal state, inline preview, timer removal, recent-project entry, and reopen persistence.
