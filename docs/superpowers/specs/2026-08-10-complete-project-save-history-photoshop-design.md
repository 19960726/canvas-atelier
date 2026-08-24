# Complete Project Save, Unified History, and Photoshop Smart Object Design

## Status

Approved direction on August 10, 2026. This specification defines the required behavior before implementation planning.

## Goal

Canvas Atelier must let users save a complete workspace as an independent project, reopen it from a recent-project list, retain every managed input and output, display real Comfly and RelayMe image/video results in unified history, and import generated images into an active Photoshop 2019+ document as embedded Smart Objects.

## Current Gaps

- The Save Project chevron exposes recovery snapshots for the active project, not a true list of independently saved projects.
- Comfly image results use the durable generation-history sink, but RelayMe results do not yet enter the same history store.
- Video results are stored as managed project assets, while the history UI still presents video history as an empty count.
- Generated-image context menus contain a disabled Photoshop action. No Photoshop discovery, desktop bridge, JSX automation, or Smart Object placement exists.

## Independent Project Saving

### First Save

1. Clicking **Save Project** on an untitled canvas opens the native project-location chooser.
2. The user chooses a project name and destination directory.
3. The application creates one independent project directory.
4. The active canvas becomes durable only after the initial write validates successfully.
5. The top bar displays the saved project name and the project is added to Recent Projects.

Cancelling the chooser leaves the canvas untitled and must not report success.

### Subsequent Save

Clicking **Save Project** for a durable project updates that project in place without another chooser. Metadata writes use a temporary file, validation, flush, and atomic replacement. A failed update preserves the last valid project and keeps all unsaved work available for retry.

### Recent Projects And Recovery Versions

The chevron beside **Save Project** opens a project manager containing:

- the current project summary;
- independently saved recent projects, newest first;
- project thumbnail, name, last-saved time, node count, image count, and video count;
- reopen action;
- remove-from-list action that never deletes project files;
- missing-project state with **Relocate** and **Remove from list**;
- a separate collapsed **Recovery versions** section for the current project.

Recent projects and recovery versions are different objects and must never share the same list or terminology.

### Opening A Project

Opening a recent project closes transient panels, safely flushes the current project when possible, acquires the selected session, restores the graph and media summaries, and updates its recent-project timestamp. A write-locked project may open read-only with a visible status.

## Complete Saved Contents

A saved project includes:

- every node, node position, durable presentation state, and connection;
- prompts, selected models, ratios, clarity/resolution, duration, output count, and other generation parameters;
- uploaded images and videos in their original managed form;
- generated images and generated videos in project-managed storage;
- completed result nodes and the model-job summaries needed to reconstruct previews;
- reverse-agent task text, model selection, knowledge-base identities, ordered media references, and completed reverse-analysis content;
- project memory and approved Skill-growth state already owned by the project;
- one generated thumbnail for the recent-project list.

Secrets, provider credentials, temporary URLs, raw authorization data, provider raw task IDs, and unrestricted external source paths must never be written into public project metadata.

## Project Directory

```text
Project Name/
├─ project.json
├─ preview.png
├─ assets/
│  ├─ images/
│  └─ videos/
├─ generated/
│  ├─ images/
│  └─ videos/
├─ reverse/
│  └─ results/
├─ history/
│  └─ project-index.json
└─ recovery/
```

`project.json` is the canonical workspace state. Media files are immutable and addressed by managed asset identity. History and recovery records reuse those managed identities instead of duplicating large files.

## Recent-Project Index

The trusted desktop process maintains a recent-project index outside project directories. Each entry contains:

- stable project ID;
- display name;
- trusted project-root locator;
- last-opened and last-saved timestamps;
- preview locator;
- availability state.

The renderer receives an opaque recent-project ID and sanitized summary, never unrestricted filesystem paths.

## Unified Comfly And RelayMe History

### Required Provider Pipeline

For Comfly and RelayMe image and video jobs:

1. Reserve one history record before a paid submission.
2. Record queued and running states.
3. Poll through the selected provider implementation.
4. Validate remote result locations or decode supported inline image data only in the trusted desktop process.
5. Store the real output as a managed image or MP4 asset.
6. Mark history succeeded with provider, model, prompt summary, dimensions or duration, project identity, and managed output identity.
7. Record failed and cancelled terminal states without fake media.
8. Prevent duplicate paid submissions when the same durable job ID is replayed.

### History Interface

The history drawer provides real image and video filters or tabs. Successful records display the managed image thumbnail or video poster, creation date, model name, project name, dimensions or duration, and file availability.

Available results support adding back to canvas, reusing parameters, exporting, favoriting, trashing, and restoring. Compatible image results may be compared. Deleting a history result referenced by a saved project remains blocked.

History is globally available after a project closes. Each project retains references to the history outputs it currently uses.

## Generation Parameter And Model-List UI Contract

### Image Generation Parameters

- Aspect ratio uses the icon-based popover and offers `AUTO`, `1:1`, `2:3`, `3:2`, `3:4`, `4:3`, `9:16`, and `16:9`, filtered only when a selected model explicitly declares a smaller supported set.
- `AUTO` derives the nearest supported ratio from the first connected managed image and omits an explicit ratio when no reference dimensions exist.
- Clarity displays exactly `2K` and `4K`; `1K` never appears in the current UI.
- Legacy persisted `1K` selections migrate to `2K`.
- A valid user-selected `4K` value remains selected when provider catalog metadata refreshes.

### Video Generation Parameters

- Video ratio uses the same icon-based popover contract as image generation and always displays `AUTO`, `1:1`, `2:3`, `3:2`, `3:4`, `4:3`, `9:16`, and `16:9`, regardless of the selected model's narrower provider capability list.
- `AUTO` derives the nearest standard ratio from the first connected managed image or video.
- When the selected video model does not support the requested standard ratio, the existing model-parameter adapter maps it to the nearest supported ratio and returns `requires_confirmation`; the UI must show the requested and actual ratios before paid submission and must never silently change them.
- Video model, mode, ratio, resolution, duration, audio, quantity, and Generate action remain in one centered control rail.
- Ratio selection must never display empty side gutters caused by a mismatched preview wrapper.

### Settings Model Lists

- Each model row contains only a centered checkbox and the model display name.
- Provider/site names, duplicate capability badges, resolution tags, quantity tags, and duration tags do not appear inside model rows.
- Model groups remain separated by capability: image, video, conversation, reverse prompt, vision, and video understanding.
- The selected provider filters the catalog without changing the visual row contract.
- Default-model selectors show model display names only and preserve the saved route after reopening settings.
- Both light and dark themes use the same spacing, row height, alignment, and hierarchy.
## Photoshop 2019+ Smart Object Import

### Entry Point

Right-clicking a completed generated image opens the existing result context menu. When the desktop bridge reports a supported Photoshop installation, the menu exposes **Import to Photoshop (Smart Object)** as an enabled action.

The action is not shown as successful until Photoshop confirms placement.

### Placement Rules

- Target Photoshop versions: Photoshop 2019 and later on Windows.
- Target document: the currently active PSD/PSB document.
- Placement type: embedded Smart Object, not a linked object.
- The managed original generated file is used; preview thumbnails are never imported.
- Images smaller than the active Photoshop canvas keep their original pixel size and are centered.
- Images larger than the active canvas are scaled down proportionally to fit within the canvas and centered.
- Aspect ratio is always preserved; no stretching or cropping is allowed.
- The new layer name uses the generated asset label or a safe model-and-time fallback.

### Trusted Desktop Flow

1. Renderer sends only the managed asset ID and an opaque project/session identity.
2. Desktop validates that the asset belongs to the active project or durable history.
3. Desktop resolves the confined original file.
4. Desktop detects a supported Photoshop installation or running instance.
5. Desktop runs a confined ExtendScript/JSX placement command compatible with Photoshop 2019+.
6. Photoshop places the file as an embedded Smart Object into the active document.
7. Desktop returns a sanitized success or error result.

No renderer-provided path, arbitrary script, shell fragment, or Photoshop command is executed.

### Photoshop Failure States

- Photoshop not installed: show **Photoshop 2019+ was not found**.
- Photoshop not running: offer to launch Photoshop, but do not silently create a document.
- No active document: show **Open a PSD or PSB document first**.
- Unsupported version: show the detected version and minimum requirement.
- Missing/corrupt generated asset: disable the action and show the file state.
- Placement failure: keep the result in Canvas Atelier and provide retry.

## Failure Handling

- Failed first save leaves the canvas untitled and preserves in-memory work.
- Failed update retains the last valid durable project.
- Missing project directories remain in Recent Projects until relocated or removed.
- Missing/corrupt media leaves nodes intact with an unavailable state.
- Provider success is not reported until output validation and managed storage succeed.
- Application close cannot report a successful save while a required stable-point write is unresolved.

## Browser Test Mode

Browser mode may use a confined local-storage project catalog and mocked Photoshop capability for interaction tests. Formal acceptance of complete project media persistence, provider history, and Photoshop placement requires the desktop bridge and filesystem-backed repository. Browser mode must not claim native Photoshop integration.

## Acceptance Criteria

1. First save creates a named independent project directory.
2. Repeated save updates the same project without reopening the chooser.
3. Project manager lists at least two independently saved projects and reopens either one.
4. Recovery versions are visibly separate from Recent Projects.
5. Reopened projects preserve uploaded images/videos, generated images/videos, reverse results, prompts, parameters, node positions, and edges.
6. Comfly and RelayMe successful image jobs appear in image history with real thumbnails.
7. Comfly and RelayMe successful video jobs appear in video history with real posters and playable managed MP4 files.
8. Failed and cancelled jobs appear without manufactured previews.
9. History and project persistence survive application restart.
10. Right-clicking a completed generated image exposes the Photoshop Smart Object action when supported.
11. Photoshop 2019+ receives the original managed image as an embedded Smart Object in the active document.
12. Placement preserves aspect ratio, keeps original size when possible, and proportionally fits oversized images.
13. Missing Photoshop, missing documents, unsupported versions, and placement errors produce clear recoverable messages.
14. Project files, history summaries, and renderer messages contain no credentials, unsafe URLs, unrestricted paths, or arbitrary scripts.
15. Unit, integration, renderer interaction, desktop bridge, restart, Photoshop-adapter contract, and end-to-end tests pass.

## Out Of Scope

- cloud project synchronization;
- collaborative multi-user editing;
- deleting project directories from Recent Projects;
- linked Photoshop Smart Objects;
- creating a new Photoshop document automatically;
- embedding provider credentials inside a project.