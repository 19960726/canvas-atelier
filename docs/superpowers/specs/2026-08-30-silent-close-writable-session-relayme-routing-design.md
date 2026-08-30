# Canvas Atelier silent close, writable session, and RelayMe routing design

## Scope

This change addresses three related production failures without deleting project data, clearing locks, closing unrelated processes, or submitting a paid generation request:

1. Closing Canvas Atelier must not display a confirmation dialog. A writable project saves durably before exit; a read-only project with no accepted edits releases its session and exits.
2. A project opened read-only because another live writer exists must automatically become writable after that writer releases the lock. Delete and Backspace then use the existing durable node-deletion transaction.
3. RelayMe generation must preserve a provider-local model identity. A RelayMe node or job must never carry a Comfly route, even when both providers expose the same visible model name.

## Evidence and root causes

### Close failure

The renderer close path calls `closePersistence()`, which calls `flushPendingProjectSave('close')`. In a read-only session with no pending draft, that flush currently returns `false`. The renderer reports a failed close ACK, and the desktop coordinator opens the native "unable to save before closing" dialog. A read-only session cannot have accepted durable edits, so treating the absence of a writable flush as data loss is incorrect.

### Delete failure

CanvasWorkspace already captures Delete and Backspace and sends selected node IDs through `deleteCanvasNodes()`. The screenshot shows the current project in read-only mode; durable mutations are intentionally rejected in that state. In addition, the current `refreshProject` bridge only summarizes the existing read-only session. It never retries lock acquisition, so the UI can remain read-only after the original writer has exited.

The canvas-management surface is modal. While it is open, canvas deletion shortcuts remain disabled so a background selection cannot be deleted accidentally. This behavior remains unchanged.

### RelayMe failure

The persisted project contains generation nodes whose `providerDisplayName` is `relayme` while `modelRoute` is `comfly-nano-banana-pro-2k`. Those jobs remain queued or running. Visible-name deduplication is allowed for presentation, but it must not collapse provider identity or create a cross-provider route alias.

## Considered approaches

### Recommended: repair persistence and routing invariants

- Make read-only close a successful session release rather than a failed save.
- Retry write-lock acquisition through the existing refresh boundary and automatically promote the same logical renderer session.
- Keep Delete and Backspace on the existing durable transaction path.
- Identify generation profiles by provider plus canonical route/model ID, and reject cross-provider routes before enqueue.

This preserves data safety and fixes the causes instead of bypassing them.

### Rejected: force close and optimistic local deletion

Closing regardless of a failed writable flush or deleting nodes only in renderer memory would appear responsive but could lose project changes or restore deleted nodes after restart.

### Rejected: delete lock files or terminate competing processes

The project lock may belong to a live production or QA process. Deleting it or terminating a process would violate the multi-writer safety boundary and the user's process-preservation constraints.

## Detailed design

### 1. Silent durable close

- The renderer classifies the active session as writable, read-only, untitled, or recovery-blocked.
- Writable sessions retain the current sequence: flush pending autosave, create the stable point, close the bridge session, then acknowledge `saved`.
- Read-only sessions skip the writable flush, close the bridge session, and acknowledge `saved` because no renderer mutation was accepted in that mode.
- The desktop main process removes the native recovery-choice dialog. A failed or timed-out writable save cancels the close silently and leaves the application open with the existing save-state indicator. It never converts a failure into discard.
- Both modern and legacy desktop entry points keep the existing close-choice IPC shape for compatibility, but resolve a valid untitled dirty close to `save` without showing a dialog. The renderer then uses the same autosave/stable-point boundary; invalid or untrusted callers still receive `cancel`.
- Duplicate close events continue sharing one coordinator promise.

### 2. Automatic read-only promotion

- The desktop refresh handler detects a read-only session and attempts to open the same confined project root in write mode.
- If the lock is still live, refresh returns the same read-only summary and changes nothing.
- If write acquisition succeeds, the handler opens the journal writer, atomically replaces the in-memory session entry, closes the obsolete read-only session, and returns a writable summary without changing the project ID.
- The renderer runs one bounded polling loop only while `saveStatus === 'read_only'`. It calls the existing reload boundary with backoff and stops when the session becomes writable, the project changes, recovery is required, or the component unmounts.
- No lock file is removed directly. Stale-lock reclamation remains owned by `ProjectRepository` and its existing liveness checks.

### 3. Delete and Backspace behavior

- Keep the current capture-phase Delete/Backspace handler and editable-target protections.
- Keep modal-surface protection: a node is not deleted while settings, canvas management, Agent, or another overlay owns keyboard focus.
- Once automatic promotion succeeds, selected nodes are deleted through `deleteCanvasNodes`, including connected edges, and the transaction is journaled before the UI treats deletion as complete.
- A failed durable delete leaves the node visible and reports through the existing save-state path.

### 4. RelayMe provider-local routing

- Canvas route lists retain provider identity in their deduplication key. The same visible model name may appear once per active provider, but routes are never merged across providers.
- Model selection stores a composite identity internally: provider plus canonical route/model ID. The visible label remains the real model name only.
- Image and video run paths resolve the requested profile inside the requested/active provider. A RelayMe request with a `comfly-*` route is not enqueued.
- Existing mixed nodes are repaired only when an unambiguous RelayMe profile with the same normalized real model name or model ID exists. Otherwise the node is marked as requiring model reselection; it is never silently routed to Comfly.
- RelayMe execution remains direct image/video generation plus task polling. Workflow APIs remain discovery-only.
- Diagnostic verification may call login, model discovery, connection checks, and task listing, but never a paid generation endpoint.

## Error handling

- Close failures remain non-destructive and silent: no dialog and no discard path.
- Read-only promotion failures are retried with bounded backoff and do not mutate the project.
- Provider/route mismatches produce a sanitized local error that tells the user to reselect a model. Tokens, remote URLs, base64, raw workflow data, and raw remote payloads do not cross IPC.
- Existing Comfly and other provider routing remains unchanged because validation is scoped to the selected provider.

## Tests

TDD adds failing tests before production edits:

1. Read-only close releases the session and ACKs success without a flush.
2. Desktop close failure does not invoke a dialog or discard changes.
3. Refresh keeps a live competing writer read-only, then promotes after release without changing project identity.
4. The renderer polls only while read-only and stops after promotion/unmount.
5. Delete and Backspace remove selected nodes after promotion and remain blocked for editable targets and modal surfaces.
6. Canvas route construction and profile selection never pair RelayMe with a Comfly route.
7. Existing mixed RelayMe nodes are repaired only with an unambiguous same-provider model.
8. RelayMe image/video service tests continue asserting direct generation endpoints, official video fields, task polling, and sanitized IPC.
9. Focused suites, Photoshop CS6 regression tests, full workspace tests, typecheck, and build run before completion.

## Non-goals

- Do not delete, migrate, overwrite, or roll back the user's project.
- Do not clean the worktree or remove untracked assets.
- Do not operate or close Photoshop.
- Do not trigger a paid RelayMe generation.
- Do not publish another installer or GitHub release without explicit user authorization.
