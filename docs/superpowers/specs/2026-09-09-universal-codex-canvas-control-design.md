# Universal Codex Canvas Control Design

Date: 2026-09-09
Workspace: `E:\画布项目\staging-canvas-build`
Status: Architecture A approved by the user; written specification awaiting review

## 1. Goal

Make Canvas Atelier's complete safe MCP workflow usable by every local Windows user who installs the product and connects their own Codex client. The integration must not depend on the developer account, an Administrator-specific path, the staging checkout, or credentials copied from another user.

This design fixes the current local-media dead end by extending the existing `canvas_import_media` tool with a safe direct-path mode while preserving the current native-picker mode. It also makes the already configured, non-secret provider/model choices discoverable to Codex so that a user can create and run a valid image, video, or reverse-prompt workflow without guessing internal route identifiers.

"All functions" in this design means that every installed user receives the same 14-tool safe canvas workflow surface and the same permission/confirmation flow:

- inspect supported nodes, configured generation profiles, workflow state, selection, and jobs;
- plan, confirm, create, update, connect, move, and delete canvas content;
- import local image and video media;
- run confirmed image, video, and reverse-prompt jobs, inspect status, and cancel jobs;
- persist changes through the existing project-save pipeline and recover them after an application restart.

Desktop administration, arbitrary filesystem access, secret extraction, arbitrary shell execution, and bypassing destructive or paid-action confirmations are not canvas workflow functions and remain unavailable to MCP.

## 2. Current Behavior and Root Cause

The installed application currently exposes 14 MCP tools. Most of the workflow can already be read and edited after the user grants the relevant permissions. Local media import is the exception.

The current request chain is:

1. `packages/domain/src/mcp-workflow.ts` defines `canvas_import_media` with only `expectedRevision`, `mediaKind`, and `position`.
2. `packages/mcp-bridge/src/server.ts` tells Codex that a successful result only means that Canvas Atelier opened its native picker and that the user must finish selecting a file.
3. `apps/renderer/src/app/mcp-workspace-adapter.ts` calls `requestMediaImport` and returns `{ pickerOpened: true }`.
4. `apps/renderer/src/app/App.tsx` creates a hidden browser file input and returns immediately after calling `input.click()`; the actual import occurs later only if a human chooses a file.
5. The desktop bridge foregrounds the Canvas Atelier window but intentionally does not pass a caller-supplied local path into the renderer.

Therefore, the screenshot behavior is contractually correct but does not satisfy Codex automation. Foregrounding the picker cannot solve it. A safe, product-owned path-import channel is required.

The existing dropped-file path is not directly reusable as a public MCP path API. It trusts an Electron `File` obtained from an operating-system drag action, whereas an MCP string is untrusted input and needs independent validation, permission checks, race protection, and privacy-safe responses.

## 3. Scope

### 3.1 Included

- Keep all 14 existing MCP tool names stable.
- Extend `canvas_import_media` with an optional `sourcePaths` array.
- Keep native-picker behavior fully backward compatible when `sourcePaths` is omitted.
- Import one to 25 local image or video files in one call when `sourcePaths` is supplied.
- Perform path handling and security checks in the desktop main process, not in the renderer.
- Require a new, explicit `directLocalFileAccess` grant for unattended path import; existing picker-era grants never acquire this authority automatically.
- Copy accepted source files into the project's managed asset store and create normal managed canvas nodes.
- Expose a bounded, redacted catalog of configured generation profiles through `canvas_describe_nodes`.
- Validate MCP model/profile selection against the currently exposed catalog and the target node capability.
- Configure the bundled MCP runtime separately for each operating-system user through the product's existing Connect Codex action.
- Preserve per-device MCP permissions and all current workflow, destructive-action, and paid-job confirmations.
- Add source, integration, packaged, installed, isolated-directory, two-real-user, save/reopen, and restart-recovery acceptance gates.

### 3.2 Excluded from this specification

- Adding Julun/New API video routes, 4dai image/reverse routes, or changing provider settings UI.
- Adding GPT-specific quality controls or correcting GPT image resolution/quality routing.
- Repairing missing thumbnails or images in generation history.
- Adding a general-purpose filesystem, terminal, browser, clipboard, window-control, settings-edit, credential-edit, or provider-account tool.
- Importing remote URLs, UNC paths, device paths, network shares, directories, archives, project bundles, or unsupported media formats.
- Treating a path from a cloud or remote Codex host as a path on that remote host. Direct-path mode always resolves the path on the Windows machine running Canvas Atelier and its local MCP bridge.
- Revealing API keys, authorization headers, provider secrets, private base URLs, raw local source paths, application logs, or another Windows user's configuration.
- Starting paid work or applying destructive changes without the existing user confirmation.

The three excluded product requests will receive separate implementation specifications after this universal MCP foundation is reviewed, so their API and UI concerns do not become coupled to the security boundary in this change.

## 4. Public MCP Contract

### 4.1 Tool count and compatibility

The public tool count remains 14. No new MCP tool is required. Existing Codex clients can continue using the old request:

```json
{
  "expectedRevision": 99,
  "mediaKind": "image",
  "position": { "x": 320, "y": 180 }
}
```

This continues to open the native picker and returns only after the application confirms that the picker was opened:

```json
{
  "ok": true,
  "result": {
    "mode": "picker",
    "pickerOpened": true,
    "mediaKind": "image",
    "position": { "x": 320, "y": 180 }
  }
}
```

The response adds `mode: "picker"` for disambiguation. Existing response fields remain present.

### 4.2 Direct-path request

`canvas_import_media` accepts the following optional field:

```ts
sourcePaths?: string[] // 1..25 entries when present
```

Example:

```json
{
  "expectedRevision": 99,
  "mediaKind": "image",
  "position": { "x": 320, "y": 180 },
  "sourcePaths": [
    "D:\\reference\\product-front.png",
    "D:\\reference\\product-side.webp"
  ]
}
```

Rules:

- An omitted `sourcePaths` means picker mode.
- A present `sourcePaths` means direct-path mode and must contain one to 25 non-empty path strings.
- Every entry must match the requested `mediaKind` after content validation. Mixed image/video batches are rejected before canvas mutation.
- Duplicate canonical file identities within the same request are rejected before canvas mutation.
- After unavoidable MCP request parsing/transport, `expectedRevision` is checked before creating a retained broker record or opening any source file. After preflight, the importer maintains an internal `expectedNextRevision`, initialized from that value and advanced from each successful commit result.
- Every managed import compares the live project revision with `expectedNextRevision` immediately before commit. The batch never reuses the caller's original revision after its own first successful mutation.
- The caller must obtain a fresh revision with `canvas_read_workflow` before retrying a conflict or partial result.

Successful direct import returns managed identifiers, not source paths:

```json
{
  "ok": true,
  "result": {
    "mode": "paths",
    "complete": true,
    "mediaKind": "image",
    "imported": [
      {
        "assetId": "asset-managed-1",
        "nodeId": "node-image-1",
        "position": { "x": 320, "y": 180 },
        "revision": 100
      },
      {
        "assetId": "asset-managed-2",
        "nodeId": "node-image-2",
        "position": { "x": 584, "y": 180 },
        "revision": 101
      }
    ],
    "currentRevision": 101
  }
}
```

The response must not contain an absolute path, canonical path, drive root, user profile name, access token, or provider secret.

### 4.3 Deterministic batch placement

The requested `position` is the top-left anchor for the first node. Further nodes use a deterministic five-column grid:

```text
x = anchor.x + (index % 5) * 264
y = anchor.y + floor(index / 5) * 176
```

This avoids complete overlap while producing stable, testable layouts. The values describe node origins, not media dimensions. Users and Codex can move the resulting nodes with `canvas_move_nodes`.

### 4.4 Failure behavior

Validation and source staging are performed for the entire batch before the first project mutation. Preflight reads each source through a validated stable handle into a verified, unpublished temporary copy inside the project store. Subsequent commits consume only those staged copies and never reopen the caller's path. A rejected path, unsupported type, duplicate identity, unreadable file, changed source, staging failure, or stale starting revision results in zero published assets and zero new nodes. All request-scoped staging files are then removed by exact known path.

After successful preflight, each staged file is published and committed through the existing managed asset/node transaction. Asset publication and node/project-state commit must be recoverable as one logical unit: a failed item cannot leave a published orphan asset without a recovery-journal entry that deterministically attaches or removes it on restart. A storage failure, commit failure, cancellation, timeout, application shutdown, or external revision change after one or more durable successes must not pretend to roll those successes back. It returns a sanitized partial result when the connection is still available:

```json
{
  "ok": false,
  "error": {
    "code": "MCP_MEDIA_IMPORT_PARTIAL",
    "message": "Canvas Atelier imported part of the media batch before a later operation failed.",
    "details": {
      "imported": [
        {
          "assetId": "asset-managed-1",
          "nodeId": "node-image-1",
          "position": { "x": 320, "y": 180 },
          "revision": 100
        }
      ],
      "failedIndex": 1,
      "causeCode": "PROJECT_REVISION_CONFLICT",
      "currentRevision": 101
    }
  }
}
```

Before the first successful item, a revision mismatch returns the ordinary `PROJECT_REVISION_CONFLICT` response with no new mutation. After the first successful item, any failure is reported as `MCP_MEDIA_IMPORT_PARTIAL`; `causeCode` contains a bounded public error code such as `PROJECT_REVISION_CONFLICT`, `MCP_LOCAL_MEDIA_UNAVAILABLE`, `MCP_IMPORT_CANCELLED`, or `MCP_IMPORT_TIMEOUT`. `currentRevision` is always the live project revision observed while constructing the response, including any intervening external mutation, and the public message is selected from the sanitized `causeCode` rather than assuming a storage failure.

The failed path and its basename are not returned. Codex must reread the workflow before deciding whether to retry only the remaining inputs. Unpublished staging files for the failed and remaining items are removed by their request-scoped identifiers; cleanup must never enumerate or delete unrelated project-store content.

## 5. Safe Main-Process Import Architecture

### 5.1 Trust boundary

Raw MCP paths necessarily exist briefly in the inbound MCP request process and the desktop main process. Beyond that unavoidable request ingestion, they must never be added to the general renderer preload API, project JSON, workflow snapshots, MCP responses, analytics, or normal application logs. Tool-argument diagnostics in the bundled bridge and desktop transport must redact `sourcePaths`. The browser renderer remains unable to request an arbitrary operating-system path.

Canvas Atelier cannot prevent the invoking Codex client from storing the `sourcePaths` that its user or agent placed in the tool call or task transcript. The permission UI and tool description must state this boundary: Canvas Atelier redacts paths from its downstream responses, state, and diagnostics, but users should not submit a sensitive path name to a Codex task they do not trust.

Direct import uses an internal, one-time main-process broker:

```text
Codex MCP request
    -> bundled MCP bridge parses bounded public request
    -> desktop main process registers an expiring pending import
    -> renderer receives only requestId/count/kind/anchor/revision
    -> renderer adapter verifies permissions, session, and live revision
    -> desktop main consumes requestId once and validates/copies files
    -> renderer commits managed asset/node results
    -> MCP returns only sanitized managed identifiers
```

After strict request parsing and transport, the bridge must discard its request-local path references. The longer-lived broker record contains the raw paths only in main-process memory and is bound to:

- a cryptographically random request identifier;
- the active Canvas Atelier desktop session;
- the current project identifier;
- the initial expected project revision;
- the requested media kind and anchor;
- the exact requesting MCP connection;
- one-time consumption semantics.

The broker has two explicit lifecycle states:

- `pending`: not yet consumed by the trusted renderer; expires after 60 seconds.
- `active`: consumed exactly once; the pending TTL stops and a cancellation-aware import operation starts with a 120-second execution deadline.

Direct-path mode accepts no more than 512 MiB of encoded source bytes per batch, in addition to the existing per-file limits. This keeps the active deadline and MCP transport behavior bounded. Larger work must use smaller direct batches or the native picker.

A pending record is removed on success, error, expiry, renderer reload, project change, MCP disconnect, or application shutdown. An active operation is marked non-replayable immediately. MCP cancellation or disconnect, permission revocation, project change, renderer loss, or application shutdown signals cancellation: the current staging/publish unit reaches a recoverable boundary, no new item begins, remaining staging files are removed by exact request scope, and any earlier durable success is preserved. If the client connection is gone, the next Codex task discovers those successes through `canvas_read_workflow`; the operation is never replayed automatically.

### 5.2 Permission and revision order

For direct-path mode the application must check, in order:

1. The request matches the strict public schema.
2. The MCP connection is authenticated to the active desktop session.
3. `externalFileAccess` is granted.
4. `directLocalFileAccess` is granted.
5. `editCanvas` is granted.
6. `expectedRevision` equals the active project revision.
7. A pending broker record is created and bound to that context.
8. The trusted renderer acknowledges the same active project, session, permissions, and revision.
9. The main process consumes the record and performs safe preflight.
10. Immediately before publication and every serial commit, the active operation rechecks session, project, both file permissions, edit permission, cancellation, and revision continuity.
11. Managed asset/node commits compare against the internal `expectedNextRevision`, then advance it from the returned revision.

Denied permissions or a revision conflict occur before source files are opened. A denied or stale request cannot be saved for later execution.

### 5.3 File validation

Every direct-path source is untrusted. Preflight must enforce all of the following:

- Windows local drive absolute path only.
- Limit each textual path to 4,096 UTF-16 code units and the aggregate `sourcePaths` payload to 65,536 UTF-16 code units, within the stricter one-MiB MCP frame limit.
- Reject relative, drive-relative, UNC, all extended/device namespaces including `\\?\`, `\\.\`, `\??\` and `GLOBALROOT`, named pipe, URI, directory, and alternate-data-stream forms.
- Walk every path component and reject a symlink, junction, mount-point, or other reparse component rather than checking only the final entry.
- After opening, obtain the final handle path, file identity, and volume type. Accept only local fixed or removable volumes; reject network-backed, remote, redirected, virtual-device, and mapped-network sources even when the input begins with a drive letter.
- Enforce the existing project path-length and media-size limits before copying.
- Before staging, require free project-volume space for the full encoded batch plus a reserve equal to the larger of 256 MiB or ten percent of the batch size.
- `lstat` must identify a regular file and reject symlink/reparse-point input.
- Resolve and compare canonical identity; reject duplicate identities.
- Open a Windows handle that allows other readers but denies write and delete sharing, and hold it for the complete staging copy. If an existing writer, filesystem, or platform cannot provide that exclusion, fail with `MCP_LOCAL_MEDIA_UNAVAILABLE`. Compare identity and size before and after reading, hash the staged bytes, and decode/probe those exact staged bytes. Preflight never reopens the textual path. This guarantees the committed content comes from one write-excluded handle and closes path-swap and same-file in-place-write windows covered by the supported Windows filesystems.
- Validate image content as one of the currently supported GIF, JPEG, PNG, or WebP formats using signature and decoder checks rather than extension alone.
- Validate video content as a supported local MP4 using the existing MP4/source validation protections rather than extension alone.
- Bound MP4 probing to ten seconds per file and 32 media tracks; reject external data references, encrypted tracks, malformed box sizes/nesting, or a probe that exceeds its byte/time budget.
- Reject a file whose validated content does not match `mediaKind`.
- Enforce explicit image decode limits in addition to encoded-byte limits: ten-second decode/probe deadline, maximum dimension 32,768 px, maximum 100 megapixels, maximum 500 animated GIF/WebP frames, and maximum 512 MiB estimated decoded memory per file.
- Stream-copy from the validated handle into a request-scoped temporary file inside the managed project store, verify size/content digest and decoder result on the completed copy, and only then make it eligible for managed-asset publication.

The temporary file name, source path, and canonical identity are operational data only and must not enter the public project model. Request-scoped staging and recovery-journal entries are removed by exact identifier after success or failure; recovery never relies on broad filesystem cleanup.

The managed asset may retain the same sanitized basename-derived display label used by existing picker/drop imports. That filename is explicitly classified as public canvas content and may appear in later `canvas_read_workflow` results; it must not retain a parent directory, drive, path separator, URI, or canonical identity. The permission UI must make this filename-visibility rule clear.

### 5.4 Picker mode remains trusted UI interaction

Picker mode continues through the existing foreground/focus/native file-input path. It does not create a pending raw-path broker record. The response means only that the picker opened, not that media was imported. The MCP server instructions must distinguish the two modes:

- `mode: "picker"`: ask the user to finish native selection and then reread the workflow.
- `mode: "paths"`: use the returned managed identifiers; do not ask the user to choose the same file again.

## 6. Configured Provider and Model Discovery

Codex cannot safely build runnable generation nodes if it has to guess a provider ID, route, supported input type, or model-specific constraints. `canvas_describe_nodes` will therefore include a redacted `generationProfiles` collection obtained from the active user's current Canvas Atelier configuration.

Each entry may contain only public routing metadata. The response also includes a non-secret `profileCatalogRevision` so diagnostics can identify settings churn without exposing configuration contents:

```json
{
  "profileCatalogRevision": "profiles-opaque-revision",
  "generationProfiles": [
    {
      "profileId": "configured-profile-opaque-id",
      "displayName": "Configured Image Profile",
      "providerKind": "openai-compatible",
      "modelRoute": "configured-image-model-route",
      "capabilities": ["image_generation"],
      "acceptedInputs": ["prompt", "image"],
      "constraints": {
        "aspectRatios": ["1:1", "4:5", "16:9"],
        "maxReferenceImages": 4
      },
      "configured": true,
      "available": true
    }
  ]
}
```

The example is generic. This specification only transports constraints that the current profile catalog already knows; it does not implement GPT quality controls, GPT resolution routing, or new provider capability metadata.

The collection must not expose API keys, headers, account identifiers, balances, raw provider responses, private base URLs, local cache paths, or profiles belonging to another user. An unavailable profile may appear only when referenced by the active workflow and is marked `available: false`; it cannot be newly selected. The collection is capped by the existing public collection limit and sorted deterministically.

`profileId` is an opaque but stable identifier for one profile record in the current Windows user's settings. Rename keeps the identifier but advances `profileCatalogRevision`. Disable, delete, or incompatible capability change advances the catalog revision and makes the profile unavailable for new selection. Existing project nodes retain the identifier and a public route/display snapshot for understandable rendering, but their execution state becomes `profile_unavailable`; `canvas_run_node` fails closed until the user selects an available profile. Recreating a deleted profile receives a new identifier.

Any `canvas_create_node`, `canvas_update_node`, or `canvas_plan_workflow` request that creates or changes `generationProfileId` must also supply the `profileCatalogRevision` most recently returned to that same authenticated MCP connection. A changed catalog, revoked read permission, project switch, or disconnect invalidates that observation. `canvas_apply_workflow` remains bound to the already validated plan hash, profile catalog revision, project revision, and one-time confirmation token.

The three request schemas add an optional top-level `profileCatalogRevision` string for backward compatibility. It is required by semantic validation only when the request's public configuration changes `generationProfileId`; requests unrelated to model selection remain valid without it. The revision is control metadata and must not be stored inside node `config`.

New or changed profile selections are accepted only when the profile was returned to that connection, remains enabled, and is compatible with the node's capability. Invalid, stale, or incompatible selections return `INVALID_WORKFLOW` with a sanitized reason and current catalog revision. They do not silently fall back to another model.

For MCP-authored generation nodes, the public configuration field is `generationProfileId`. The workspace adapter resolves it to the application's existing internal provider/model identifiers. MCP input cannot set a base URL, API key, authorization header, credential record identifier, or other private provider field through the generic `config` object.

All MCP mutation paths share one module-specific public configuration validator and profile resolver. This includes direct create/update calls, every `create_node` or `update_node` inside `canvas_plan_workflow`, confirmation-time plan revalidation, and any future MCP batch endpoint. The validator uses explicit allowlists, rejects unknown nested keys, dotted/bracket aliases, case variants, prototype-pollution keys, legacy internal provider fields, credential/provider record identifiers, headers, and URLs. A plan cannot bypass a restriction that applies to a direct mutation.

Project restore uses the application's internal persisted-project schema, not the permissive MCP public-value schema. Restored unknown/private aliases are quarantined as invalid or migrated by an explicit versioned migration; they can never become executable provider configuration merely because they appeared in saved JSON.

Profile discovery does not prove that a provider request succeeds. Live connectivity and paid generation remain separate acceptance rows.

## 7. Per-User Product Installation and Codex Connection

Canvas Atelier ships one supported MCP bridge with the installed product. The supported release target for this specification is a per-user installation: each standard Windows user installs, updates, runs, connects, disconnects, and uninstalls their own copy without administrator elevation. A per-machine installer may be designed later but is not evidence for this acceptance row. The Connect Codex action configures only the currently signed-in Windows user's Codex client; it does not modify another user's profile.

Requirements:

- Resolve the installed runtime from the current installation, not the staging checkout and not a hard-coded `C:\Users\Administrator` path.
- Merge the Canvas Atelier MCP entry into that user's Codex configuration without replacing unrelated MCP servers or settings.
- If `canvas_atelier` is absent, add it. If it exactly matches a recognized product-managed current or prior entry, update it. If an unrecognized user-owned entry already uses that name, show a conflict and leave the file unchanged; never silently take ownership.
- Record an owner-only sidecar fingerprint of the exact product-owned TOML span and surrounding anchors. Reconnect/disconnect may edit that span only when its current hash matches the sidecar or it matches a versioned, known prior Canvas Atelier template whose executable resolves to a signed per-user installation. A comment or server name alone is not proof of ownership.
- Treat the Codex TOML as concurrent user data: acquire a bounded cooperative lock where supported, reread immediately before commit, and use compare-and-swap against the bytes that were parsed. A concurrent change causes a safe retry from fresh bytes or a clear no-write conflict.
- Resolve the supported Codex configuration location for the current user and reject a reparse/symlink target or parent. Parse before writing and fail closed on malformed, unreadable, or read-only TOML. Never replace malformed content with a generated minimal file and never truncate on failure.
- Use surgical span editing: bytes outside the owned Canvas Atelier table remain byte-for-byte unchanged, including BOM, newline style, comments, whitespace, Unicode, and unrelated table ordering. Write a temporary file in the same directory, flush file contents and directory metadata as supported, then atomically replace the target. On interruption, the original remains usable and a request-scoped temporary file is recoverable by exact name.
- Quote executable/resource paths correctly when the installation path contains spaces or non-ASCII characters.
- Store the runtime descriptor under the current user's local application-data directory with an explicit owner-SID-only DACL plus required SYSTEM access; do not rely only on inherited permissions or best-effort `chmod`.
- Bump the runtime descriptor/pipe protocol for this stronger contract. The versioned descriptor carries an owner-SID fingerprint and logon-session identifier in addition to the instance, pipe, process, expiry, and server version; old protocol descriptors are rejected rather than partially trusted.
- Use the existing local Windows named-pipe transport with an owner-SID/session-scoped pipe DACL. The pipe rejects clients from another Windows user or login session before application request handling.
- Generate at least 256 bits of cryptographic authentication entropy. Bind the token to the descriptor's user SID, login session, instance, pipe, process, and protocol version; compare it without timing-sensitive early exit; reject duplicate request identifiers; and rotate it on every app start and at least every 15 minutes while running.
- Publish descriptors atomically with a maximum 15-minute expiry. The bridge rereads a current descriptor on reconnect and rejects expired descriptors, dead process IDs, wrong SID/session, wrong protocol, old tokens, and replayed request identifiers. Tokens, pipe names, and raw descriptors never cross into the renderer or normal diagnostics.
- Rotation publishes a new descriptor/pipe generation first, then stops accepting new frames on the old generation. Idle old connections close and the bridge automatically rereads/reconnects once on the next tool call. Pending, not-yet-consumed direct imports on the old generation are cancelled. An already active import may finish its current bounded call under its authenticated in-memory connection for at most the remaining 120-second active deadline; no second request can use that old token, and the old pipe closes immediately after the active response/recoverable termination.
- Do not store provider API keys in Codex configuration or the runtime descriptor.
- Reconnecting is idempotent and updates an obsolete Canvas Atelier command/schema entry without duplicating it.
- Disconnecting removes only a still-matching product-managed Canvas Atelier MCP entry and the current user's session descriptor. If the entry changed concurrently or is no longer recognized as product-managed, disconnect reports a conflict and leaves it untouched.
- If a Codex client caches MCP schemas, the UI must state that the user needs a new Codex task after reconnecting to see the updated `sourcePaths` field.
- Update from the immediately preceding supported release must replace the managed executable path/schema and invalidate old runtime descriptors. Per-user uninstall removes the current user's managed MCP entry and runtime descriptor while preserving projects, provider settings, unrelated Codex configuration, and other users' installations.
- Standard-user installation and connection must work without relying on the developer account or elevation.

The release matrix records at least one exact supported Codex desktop build. Config write, bridge launch, named-pipe attachment/authentication, any Codex trust prompt, and MCP schema enumeration are separate gates; one passing gate cannot stand in for another. If a Codex version or trust policy prevents one of them, that row is blocked or unverified rather than inferred from the config file.

An isolated-directory test profile is useful for deterministic config tests but is not sufficient proof of cross-user support. Release acceptance requires two real, non-administrator Windows accounts on the same test machine. Each account must connect through its own UI, receive its own runtime descriptor, tokens, permissions, profile catalog, and instance route, and be unable to read or reuse the other account's state. Both accounts must also be exercised while their Canvas Atelier and Codex processes are running concurrently. If the release environment cannot run this test, the cross-user row remains blocked or unverified and the product cannot be described as universally verified.

## 8. Permissions and Confirmations

The current deny-by-default permission model remains authoritative.

| Operation | Required permissions | Additional confirmation |
| --- | --- | --- |
| Describe nodes/profiles, read workflow/selection/job | `readCanvas` | None |
| Create/update/connect/move without profile selection | `editCanvas` | None |
| Create/update that selects a generation profile | `readCanvas` + `editCanvas` | Matching observed profile catalog revision |
| Picker media import | `externalFileAccess` + `editCanvas` | Native picker interaction |
| Direct-path media import | `externalFileAccess` + `directLocalFileAccess` + `editCanvas` | Explicit new consent when enabled; no picker interaction |
| Plan/apply destructive mutations | `readCanvas` + `editCanvas` + `dangerousOperations` | Existing one-time workflow confirmation |
| Run image/video/reverse node | `executeAiGeneration` | Existing one-time paid-job confirmation |
| Cancel managed job | `executeAiGeneration` | None beyond existing permission |

`directLocalFileAccess` defaults to false even when an existing installation already granted `externalFileAccess`. The first upgraded version must show a new consent explanation before enabling it; migration may not infer consent. One user's grants do not transfer to another Windows user, installation, machine, or desktop session. Revoking `externalFileAccess`, `directLocalFileAccess`, or `editCanvas` aborts any pending or active direct-import operation at the next recoverable boundary.

The MCP integration must never:

- approve its own workflow or paid-job request;
- expose or accept a reusable confirmation token;
- infer permission from filesystem readability;
- retain a request for later execution after a denial, conflict, disconnect, or expiry;
- change provider credentials or settings on the user's behalf.

## 9. Public Errors

Existing error codes remain stable. The feature adds only narrowly scoped errors:

| Code | Meaning | Mutation allowed |
| --- | --- | --- |
| `MCP_INVALID_REQUEST` | Public schema is invalid | No |
| `MCP_PERMISSION_DENIED` | Required user permission is absent | No |
| `PROJECT_REVISION_CONFLICT` | Expected revision is stale | No new mutation |
| `MCP_INTERACTION_UNAVAILABLE` | Installed desktop session cannot receive the request | No |
| `MEDIA_PICKER_NOT_OPENED` | Picker mode could not open trusted UI | No |
| `MCP_LOCAL_MEDIA_INVALID` | Path, identity, type, size, or content failed preflight | No |
| `MCP_LOCAL_MEDIA_UNAVAILABLE` | Local file became unreadable or changed before import | No |
| `MCP_IMPORT_CANCELLED` | Caller/session/user cancellation stopped the active import | No later mutation; earlier durable items may be partial |
| `MCP_IMPORT_TIMEOUT` | The bounded active-import deadline elapsed | No later mutation; earlier durable items may be partial |
| `MCP_MEDIA_IMPORT_PARTIAL` | Durable failure occurred after one or more successful imports | Durable successes only |
| `INVALID_WORKFLOW` | Model profile or node configuration is stale/incompatible | No |

Before any successful item, cancellation and timeout return their direct error code. After a successful item they appear only as the bounded `causeCode` inside `MCP_MEDIA_IMPORT_PARTIAL`. Messages and `details` must be useful without echoing the raw path. A diagnostic correlation identifier may be returned if it cannot be used to retrieve secrets or another user's data.

## 10. Persistence and Recovery

Path imports use the same managed asset/node state as drag, paste, and native-picker imports. They are not a parallel persistence format.

Acceptance requires:

- imported bytes are present in the managed project asset store before success is returned;
- the project revision advances monotonically for every committed import;
- autosave observes the same state as the canvas workflow adapter;
- save/reopen restores the imported nodes and their media;
- application restart restores the same project and media without the original source files being present;
- moving or deleting the original source after successful import does not break the managed asset;
- partial imports persist exactly the managed identifiers reported in the partial error;
- no source path is serialized into the public workflow snapshot or project document.

## 11. Test Strategy

Implementation follows regression-first development. Every failing test must demonstrate the previous limitation or a security boundary before production code changes.

### 11.1 Domain contract tests

- Existing picker request still parses and produces the legacy fields plus `mode: "picker"`.
- Direct request parses with one and 25 paths.
- Present-but-empty, more than 25, non-string, overlength, and unexpected fields are rejected.
- Response schemas accept complete and sanitized partial results.
- The public tool list remains exactly the existing 14 tool names.
- `canvas_describe_nodes` profile output obeys collection and public-value limits.
- Create/update/plan schemas accept top-level `profileCatalogRevision`, while semantic validation requires it only when `generationProfileId` changes.

### 11.2 MCP server instruction tests

- Picker success still instructs Codex to wait for human selection.
- Direct-path success does not instruct Codex to open or complete a picker.
- Partial result instructs Codex to reread workflow state before retry.
- Server text never claims that `pickerOpened` means an import completed.

### 11.3 Desktop broker and security tests

- Raw paths are never forwarded through the generic renderer preload contract.
- Pending records are session/project/connection/revision bound, expire after 60 seconds, and are consumable once; active records stop using pending TTL and honor the 120-second deadline.
- Renderer reload, project switch, permission revoke, disconnect, and shutdown invalidate pending records.
- Cancellation/disconnect during staging and between serial commits stops new items, cleans exact remaining staging files, and preserves/reports only durable successes.
- Relative, drive-relative, UNC, extended UNC/device/GLOBALROOT, URI, directory, alternate stream, mapped network, symlink, parent junction, mount point, and reparse paths are rejected.
- Handle final-path and volume checks reject a drive-letter path that resolves to a redirected or remote volume.
- Extension/content mismatch, unsupported image, non-MP4 video, over-limit encoded bytes, more than 512 MiB per batch, excessive image dimensions/pixels/GIF frames/decoded memory, duplicate identity, and path-swap race are rejected.
- Rejection produces no managed asset, no node, and no revision increase.
- Preflight publishes no asset; injected publish/state failures leave either an attached asset/node or an exact recovery-journal action, never an untracked orphan.
- Logs, bridge argument diagnostics, errors, workflow snapshots, and MCP results contain no raw test path.

### 11.4 Workspace and integration tests

- Missing `externalFileAccess` or `editCanvas` denies both modes; missing `directLocalFileAccess` independently denies direct mode while picker mode remains available.
- Upgrade a persisted prior-version grant with `externalFileAccess: true` but no new field; migration must materialize `directLocalFileAccess: false`, deny direct mode before new UI consent, persist explicit enablement across restart, and persist revocation across another restart.
- Stale starting revision denies direct import before file access.
- One image and one video import without opening the picker.
- A 25-file batch uses the specified grid and reports each revision.
- Serial commits advance `expectedNextRevision`; an external mutation before item one returns plain conflict, while an external mutation after item one returns partial with `causeCode: PROJECT_REVISION_CONFLICT`.
- Managed nodes participate in normal connect, move, delete-confirmation, save, and reopen flows.
- Simulated durable failure returns only actual successes and the live revision.
- Configured compatible profile can be selected with the observed catalog revision; rename, disable, delete, recreate, stale revision, unknown profile, and incompatible profile fail or recover according to the specified identity rules without fallback.
- Profile selection is denied without current `readCanvas` and `editCanvas` grants, even if the same connection observed the catalog before revocation.
- Direct create/update, planned create/update, confirmation-time revalidation, nested aliases, legacy internal fields, URL/header/credential keys, and persisted-project restore all exercise the same public/private configuration boundary.
- Image, video, and reverse jobs keep the current explicit confirmation flow.

### 11.5 Per-user connection tests

Use isolated temporary values for user profile, application data, local application data, and Codex configuration:

- Start with no Canvas Atelier MCP entry and preserve unrelated entries.
- Connect from an installation path containing spaces and Chinese characters.
- Verify no `Administrator`, staging, repository, or developer-machine path is written.
- Reconnect twice and verify a single current entry.
- Disconnect and verify all bytes outside the product-owned span are identical to the pre-connect file; if connect added the only product-owned span, the original file bytes are restored exactly.
- An unrecognized pre-existing `canvas_atelier` entry produces a visible no-write conflict; a recognized previous-version entry upgrades in place.
- Verify comments, BOM, CRLF/LF style, Unicode, and unrelated table ordering survive; malformed and read-only TOML fail without truncation.
- Reparse config files/parents are rejected, and temporary/config/runtime files receive the intended current-user DACL.
- Inject a concurrent config edit between parse and commit and verify compare-and-swap retries safely or reports a no-write conflict.
- Interrupt temporary-file write and atomic replacement separately; the prior config remains parseable and request-scoped recovery leaves no broad cleanup requirement.
- Start a fresh Codex task and verify the 14 tools and new `sourcePaths` schema are visible.
- Run two isolated-directory configurations for deterministic checks, then repeat critical connection/import checks under two real standard Windows accounts.
- With both accounts running concurrently, verify OS-level read denial plus protocol rejection for user B attempting user A's permissions, session tokens, descriptors, pipe, model profiles, instance discovery, and pending import identifiers.
- Verify token entropy, constant-time comparison wrapper, 15-minute expiry/rotation, restart rotation, dead-process rejection, wrong-session rejection, duplicate request rejection, and old-token replay rejection.
- Across scheduled rotation, verify idle bridge auto-reconnect, pending-import cancellation, active-import bounded completion/partial behavior, rejection of all new old-token frames, and final old-pipe closure.
- Upgrade from the preceding supported release with a moved installation path, verify the old bridge/schema/runtime is no longer launched, then disconnect and uninstall without changing projects, provider settings, unrelated config, or the second user's installation.

### 11.6 Packaged and installed acceptance

Installed acceptance must run against the exact candidate executable and `app.asar`, with their version and SHA-256 recorded. Passing source tests or unpacked package tests does not count as installed success.

Using an isolated standard-user configuration:

1. As a real standard Windows account, install/start the exact per-user Canvas Atelier candidate and connect a fresh supported Codex build through the real Canvas Atelier UI.
2. Through the real settings UI, add a controlled loopback mock-provider profile with non-secret fixture credentials, grant the required MCP permissions, and verify all 14 tools plus the redacted profile catalog.
3. Import at least two controlled local image fixtures and one controlled MP4 fixture by path, without native picker interaction.
4. Read managed assets/nodes; create, update, connect, and move nodes.
5. Exercise delete planning and one-time confirmation.
6. Through the real confirmation UI, exercise zero-cost image, video, and reverse requests against the loopback mock provider; read status and cancel a controlled running request. The production binary contains no hidden confirmation bypass or test-only provider route.
7. Save, close, restart, and reopen; verify node, edge, media, and job state.
8. Scan public responses, saved project data, runtime descriptor, and Codex config for fixture paths and secrets.
9. Revoke permissions through the real UI and verify denied permissions, stale revision, invalid path, and unsupported content fail closed.
10. Verify no external provider charge/network call, Photoshop action, or unrelated user configuration change occurred during controlled acceptance; loopback mock traffic is recorded separately.
11. Repeat the critical install/connect/catalog/path-import/isolation rows with a second real standard Windows account while both accounts' application and Codex processes are running.
12. Record installer hash/version, install scope/path, executing user SID, actual spawned MCP bridge path/hash, runtime protocol, installed executable hash, and installed `app.asar` hash; prove that Codex launched this payload rather than a repository or stale version.

Live provider generation is recorded separately as verified, failed, blocked, or unverified. Configuration and zero-cost fixtures are not evidence of provider success.

## 12. Acceptance Matrix

Release reporting must separate the following evidence:

| Layer | Required evidence |
| --- | --- |
| Source | Focused contract, broker, validation, adapter, persistence, and config tests pass |
| Wider regression | Existing MCP, project, media, provider, and permission suites pass |
| Build | Renderer, desktop, domain, bridge, typecheck, and production build pass |
| Package payload | Bundled MCP runtime and schemas are present in candidate payload |
| Candidate app | Exact unpacked candidate passes controlled MCP/media tests |
| Formal installed app | Exact installed executable/`app.asar` identity and installed gates pass |
| Cross-user | Two real standard Windows accounts connect concurrently and cannot cross-read/reuse descriptors, tokens, permissions, profiles, imports, or instance routes |
| Persistence | Save/reopen and close/restart retain managed media/workflow state |
| Live providers | Reported separately; never inferred from configuration or fixtures |
| Machine-dependent integrations | Photoshop, native clipboard, and other host dependencies remain separate rows |

No release may be described as universally usable if only the developer account, source checkout, package payload, or an older installed build passed.

## 13. Implementation Sequence

1. Add failing domain/server tests for the dual-mode contract and instructions.
2. Add failing desktop security tests and implement the pending/active one-time main-process broker plus handle-bound safe local image/video staging.
3. Add failing adapter/integration/recovery tests and connect serial broker results to atomic-or-journaled managed asset/node transactions.
4. Add failing catalog and bypass tests, then expose redacted configured generation profiles through one shared public-config/profile validator for every MCP mutation path.
5. Add failing isolated-directory, config-concurrency, and two-real-account tests; make Connect Codex installation-relative, atomically merged, and user-scoped.
6. Run focused suites, then the wider regression and production build.
7. Build and inspect the candidate package; do not infer success from source output.
8. Run candidate and formal-installed acceptance with isolated directories and then with two real standard Windows accounts.
9. Record exact artifact identities and update project memory with separate source/build/package/installed/provider results.
10. Only after all required rows pass, publish the new installer and tell users to reconnect Canvas Atelier and start a fresh Codex task.

Existing unrelated working-tree changes and QA artifacts are preserved. Version bump, rebuild, package, installation, or release publication occurs only during implementation after the written specification is approved.

## 14. Design Decisions

- Extend `canvas_import_media` instead of adding a fifteenth tool, preserving client compatibility and the existing capability model.
- Preserve native-picker mode for human workflows and add explicit `mode` in results to eliminate false claims of completed import.
- Beyond unavoidable parsing in the bundled MCP bridge, keep retained raw paths solely in an expiring main-process broker; redact argument logging and never introduce a general raw-path renderer API.
- Add a separately consented direct-path permission; never migrate picker-era file grants into unattended read authority.
- Stage the entire batch from validated handles before the first mutation, serialize commits through `expectedNextRevision`, and report unavoidable durable partial success truthfully.
- Import into the managed project store so the canvas is independent of source-file lifetime.
- Expose only redacted, currently configured profile metadata so Codex can select valid routes without seeing credentials.
- Use a per-user installation and configure Codex per Windows user, with no developer-user, cross-user state, or repository dependency.
- Preserve all existing permission and confirmation barriers; universal availability means equal capability for each user, not shared trust or reduced safeguards.

## 15. Success Criteria

This design is complete when a fresh standard Windows user can install Canvas Atelier, connect a fresh Codex client, start a new Codex task, and use the same 14 tools to:

- discover valid canvas nodes and configured generation profiles without secrets;
- import controlled local images and MP4 files directly by absolute local path;
- read and manipulate the resulting managed workflow;
- execute the confirmation-protected zero-cost job matrix;
- save, close, restart, and recover the project;
- receive accurate errors without path or credential leakage in Canvas-owned responses, persistence, or diagnostics, while recognizing that the caller's own Codex request/transcript already contains submitted paths;
- do all of the above without the developer account, staging checkout, copied API keys, manual picker interaction in direct-path mode, or hidden machine-specific configuration.
