# History, RelayMe, Workflow, and Canvas Performance Design

## Goal

Make generation history visibly fast, make every provider-backed canvas node honor RelayMe capabilities, simplify Agent-created workflows, expose model-specific clarity choices, focus newly created workflows, and remove avoidable canvas-wide updates during typing and reference reordering.

## Confirmed Product Decisions

- History cards use derived previews. Originals remain the only authoritative media and are used for detail, export, add-to-canvas, and integrity audits.
- Existing history is repaired lazily. Visible previews are generated first with bounded concurrency; missing previews never block metadata rendering.
- An Agent-created generation workflow contains reference input nodes plus one generation node. It does not add separate `text_prompt`, `result_output`, or `video_result` nodes.
- After confirmation, the generation node is selected and the new workflow is fitted into view. The Agent panel remains open.
- The confirmation card displays a clarity selector next to the model selector. A model without a verified clarity contract exposes only `模型默认` and does not send a synthetic tier.
- RelayMe is supported by capability, not by node name. Every provider-backed node must receive RelayMe profiles when RelayMe declares the required capability, while unsupported operations fail closed with an explicit reason.
- No automatic paid retry is added. Fixture tests and authenticated read-only catalog checks may run without spending credits; live generation remains a separately reported gate.

## Generation History Architecture

### Current cause

The first page renders up to 50 media elements against `novus-history://asset/<id>`. Resolving every URL serializes through the history index lock and hashes the complete original before Chromium decodes it. On the current user dataset, 26 visible originals total about 213.6 MiB compressed and about 806.5 MiB after RGBA decode.

### New path

1. `novus-history://preview/<id>` resolves only a confined derived preview.
2. Preview resolution reads record metadata under the history lock, then releases the lock before image decoding or preview creation.
3. Preview creation is deduplicated per asset and limited to two concurrent jobs.
4. The desktop shell injects an Electron `nativeImage` preview encoder into `GenerationHistoryStore`; desktop-core remains Electron-independent.
5. Preview files are written to a confined temporary path and atomically renamed into `generation-history/previews`.
6. The preview cache may be deleted and regenerated. Originals and the history index are never rewritten merely to create a preview.
7. Image cards use the preview URL with lazy loading and asynchronous decoding. Detail view keeps the original asset URL.
8. Videos keep metadata-only preload; a later dedicated poster pipeline is out of scope.

### 30 ms first-page path

The 30 ms requirement applies to a usable first page: record cards and image elements must exist in the DOM. Network/protocol image decode may finish afterward and is represented by the stable card skeleton.

1. The desktop history store warms and validates the canonical index before the first window is created.
2. Default active/newest/all-availability list requests are served from an in-memory index snapshot without reopening the lock or reparsing the index.
3. The renderer starts a bridge-identity-scoped first-page preload as soon as the application mounts.
4. Opening the drawer consumes that preloaded page synchronously, then refreshes metadata and capacity in the background.
5. Mutations update the desktop cache only after the atomic index commit succeeds; single-instance ownership prevents cross-process writers.
6. Availability filters, integrity audits, originals, export, and detail media remain authoritative and do not use the fast metadata shortcut.

### Failure behavior

- While a preview is outside the viewport or pending, the card shows a stable skeleton.
- Failed generation, queued generation, missing original, corrupt original, and preview-generation failure have distinct visible states.
- A malformed or unconfined preview URL resolves to no file.
- A corrupt derived preview is replaced; it does not change original availability.

## RelayMe Capability Architecture

RelayMe profiles remain authoritative. Renderer route lists are derived from exact capabilities:

| Canvas operation | Required RelayMe capability |
| --- | --- |
| Text/Agent chat | `chat` |
| Image generation | `image_generation` |
| Image generation with references | `image_edit` or a verified image-generation workflow accepting references |
| Video generation | `video_generation` |
| Reverse image analysis | `reverse_prompt` plus a verified visual transport, or `chat` plus `vision` |
| Reverse video analysis | A verified video reverse transport; otherwise explicit unsupported state |

Model-declared aspect ratios, resolutions, durations, and workflow input schemas flow into the node controls. The renderer must not invent `2K`, `4K`, aspect ratios, edit support, or video reverse support. Submitted jobs retain exact provider, route, model ID, parameters, task identity, terminal result, and history metadata.

## Agent Workflow and Focus

`ensureAgentGenerationNode` becomes a lean workflow transaction:

- Reuse or create reference input nodes as needed.
- Create exactly one image or video generation node.
- Persist prompt, model route, clarity, ratio, output count, and ordered references in that node.
- Connect reference input nodes directly to the generation node.
- Return the generation node ID and all created/reused workflow node IDs.

After the durable transaction succeeds, `CanvasWorkspace` selects the generation node and fits the returned workflow IDs with bounded padding and a short animation. Provider submission begins only after the stable save boundary already required by the application.

## Clarity Contract

The confirmation card derives clarity options from the selected profile. Changing models reconciles the selected value:

- Keep the current value when the next profile supports it.
- Otherwise choose the profile default.
- When the profile has no verified resolution list, display `模型默认` and omit `resolution` from submission.

This same normalization is shared by Agent creation and the generation node editor so a confirmed value cannot silently change during node creation.

## Canvas Performance

- Keep keystrokes in component-local drafts and debounce durable project writes.
- Keep provider/job/runtime callbacks stable so unrelated job, history, or Agent state does not invalidate all flow-node props.
- Apply reference reorders optimistically in memory and send the newest complete permutation through the shared debounced project autosave controller.
- Create Agent workflows in one project transaction instead of three-node staged updates.
- Run the explicit persistence performance suite and large-canvas integration tests in addition to normal unit tests.

## Automatic Save Model

The save behavior follows the observable coordinator pattern used by the reference application without copying its storage format:

- Startup exposes `加载中…` until the durable project has hydrated; editing cannot masquerade as ready during this phase.
- Every edit updates the in-memory project immediately and marks it pending. One shared 750 ms idle timer keeps only the latest complete project draft.
- A flush drains all drafts that arrive while a write is in flight, so a third edit cannot be lost behind two commits.
- Window blur, close coordination, model execution boundaries, and explicit Save force the same queue to flush instead of starting parallel writers.
- The top bar distinguishes waiting, saving, saved, read-only, conflict, and actionable failure states. Explicit Save remains as a stable-point and retry action.
- Media-slot reordering always persists an exact edge-id permutation, including hidden overflow inputs. A failed revision reloads the durable project once and retries against the current edge set.
- Close is allowed only after the renderer flush contract resolves or the existing failure guard reports an actionable error; failed writes are never reported as saved.

## Material Import Latency

The normal image-upload action has two different durability boundaries and must not expose the slower one as picker latency:

1. Copy and validate the selected file inside the managed project asset root.
2. Commit the asset and project mutation to the append-only journal.
3. Return the managed asset summary to the renderer immediately after that acknowledgement so the thumbnail can appear.
4. Generate the consolidated project snapshot through the session maintenance queue in the background.
5. Keep close coordination attached to the maintenance tail so the application cannot exit while that acknowledged snapshot is still pending.

Concurrent imports remain serialized per writable session, and a session change before the journal boundary still fails closed. This changes response latency only; it does not weaken file confinement, hashing, revision checks, journal durability, snapshot recovery, or close-time flushing.

## Acceptance

- On a warm installed fixture, the default history list IPC completes within 30 ms and the first 30 record cards appear within 30 ms of opening the drawer; visible image preview P95 is under 800 ms after a warm cache.
- The first history page does not hash originals and reads less than 5 MiB of preview media for the initial viewport.
- Blank unexplained history cards do not appear.
- RelayMe fixture coverage proves chat, image, reference-image, video, task polling, result storage, Agent routing, history recording, and unsupported video reverse behavior.
- Agent confirmation creates no prompt/result nodes and focuses the generated workflow.
- A model without resolution evidence submits no resolution; a model with evidence submits the selected exact value.
- Twenty-slot burst reordering coalesces into one autosave commit, survives reopen with the exact final order, and produces no page error or save deadlock.
- A normal managed image import resolves before the automatic snapshot finishes, while project close still waits for that snapshot.

## Installed R2 Evidence

- Real-history isolated copy: 180 records, 30-record IPC in 0.8 ms, first frame in 14.9 ms with 30 cards and 25 image elements.
- Canvas wheel-zoom sample: 90 frames, 16.8 ms P95, 0 frames above 34 ms, and a verified transform change from 1x to 2.5x.
- Material import interaction: 53 ms from upload action to managed image preview in the installed application fixture.
- Twenty-slot stress path: 38 rapid moves, one autosave commit, exact final order after reopen, and no page error.
- Four-image result view: compact square 2x2 geometry with every item contained; color correction and persistent original/corrected comparison work both above the node and in the detail viewer.
