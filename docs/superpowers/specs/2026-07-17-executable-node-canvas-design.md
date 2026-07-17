# Novus Atelier Executable Node Canvas Architecture

Date: 2026-07-17
Status: User-approved architecture direction (option 1)

## Goal

Rebuild the Novus Atelier central canvas as a real executable creative workflow rather than a collection of presentation cards. The canvas must support modular image generation, image editing, reverse analysis, Skill conversation, video analysis, pose guidance, line-art reasoning, ordered references, and result routing while retaining the secure desktop runtime, durable persistence, project memory, and right-side Novus Agent.

The target is workflow depth comparable to the observed reference products, implemented with original Novus code, visual language, contracts, and branding. CanvasForge remains observation-only. Infinite-Canvas source and UI must not be copied because its license and architecture do not fit this product's commercial desktop, security, or runtime requirements.

## Product Outcome

The first screen remains the usable canvas. A user can:

1. Add modules from a searchable left module library.
2. Connect compatible typed ports to form an executable graph.
3. Upload or select images from the project library.
4. Reorder every reference list by dragging.
5. Cite references in prompts and Agent messages with `@image` mentions.
6. Run image generation V1 or V2 after explicit execution confirmation.
7. Switch between GPT Image and Nano Banana 2 without starting a new Agent conversation.
8. Ask the Agent to reverse-analyze images, video, line art, materials, textures, lighting, camera movement, transitions, and effects.
9. Use a detail-page knowledge specialist inside the same Agent conversation to plan layout, information hierarchy, image sequence, selling-point expression, and visual finish.
10. Review outputs, give feedback, and have that feedback become structured project growth memory.
11. Reopen the project or continue on another approved device without losing requirements, task state, feedback history, or execution evidence.

## Existing Baseline To Preserve

- React Flow canvas rendering, viewport culling, and interaction-quality downgrade.
- Electron 22 Legacy runtime for Windows 7 and the Modern runtime for Windows 10/11.
- Project transactions, undo, autosave, recovery, snapshots, and save acknowledgement semantics.
- A confined desktop bridge with no arbitrary renderer filesystem, process, credential, or token access.
- Provider task submission, polling, cancellation, terminal acknowledgement, replay, and credential vault boundaries.
- Ordered references, image mentions, reverse-prompt run identity, knowledge leases, project memory, Skill promotion review, and sanitized cross-device sync.

These foundations are extended, not replaced.

## Current Capability Gap

The current canvas schema contains a small fixed union of reference, placement, prompt, model-job, image-result, review, memory-diff, and Agent-plan nodes. Node rendering is mostly presentation mapping. There is no extensible module registry, typed input/output contract, graph compiler, node-level execution state, reusable node inspector, or complete execution chain.

Image generation is initiated indirectly through an Agent plan. Reverse analysis is wired to a local draft implementation in the renderer. Skill chat, video analysis, OpenPose, image editing, line-art/material reasoning, and canvas-library modules do not yet exist as executable nodes. This architecture gap, rather than visual styling, caused the rejected workbench to feel incomplete.

## Design Principles

- Canvas first: the graph and its outputs dominate the workspace.
- Real modules: every executable node has validated inputs, outputs, configuration, and lifecycle state.
- One Agent: model-route changes do not fragment conversation or memory.
- Explicit execution: provider work never starts from an accidental click or graph connection.
- Stable interaction: pan, zoom, drag, selection, and reference reordering remain responsive.
- Durable truth: the UI shows saved only after the desktop durability acknowledgement.
- Original implementation: match capability and workflow depth without copying proprietary source, UI, assets, branding, credentials, or trade dress.
- Sanitized memory: learning preserves decisions and reasoning, not secrets or private local data.

## System Architecture

### 1. Module Registry

A domain-owned module registry describes each available module without importing renderer components or provider implementations. Each definition contains a stable module type and version, category, icon key, search aliases, supported runtime profiles, typed ports, configuration schema, default factory, execution mode, capability requirements, reference support, mention support, and migration function.

The renderer maps presentation keys to Novus components and Lucide icons. Runtime executors map the same stable module type to a local or desktop handler. This prevents the toolbar, schema, node UI, and executor from drifting into separate hard-coded lists.

Module discovery is local and deterministic. Remote knowledge refresh may update approved analysis knowledge and Skill instructions, but it cannot install executable code or silently add modules.

### 2. Typed Graph Model

The project schema advances to a versioned graph format while preserving migration from version 1. Each graph node stores only public, serializable state: identity, module type and version, position, user-visible configuration, ordered input bindings, output asset references, compact execution summary, and durable job references.

Initial port types are:

- `image_asset`
- `image_list`
- `mask_asset`
- `pose_data`
- `text_prompt`
- `analysis_document`
- `video_asset`
- `camera_timeline`
- `material_plan`
- `generation_request`
- `generation_result`

Edges identify source and target ports. Validation rejects incompatible types, duplicate single-input bindings, forbidden cycles, missing required outputs, and runtime-profile-incompatible modules. List inputs preserve explicit edge order. Reordering changes only ordered binding metadata and commits as one stable project transaction.

### 3. Graph Compiler And Execution Engine

Running a node or downstream chain creates an immutable execution snapshot. The compiler resolves dependencies, validates ports and configuration, freezes reference order, citations, model route, knowledge lease and project-memory IDs, produces a public execution manifest, displays confirmation for provider work, and enqueues jobs only after explicit confirmation.

The engine executes a directed acyclic subgraph in dependency order. Independent ready nodes may run concurrently within a conservative queue limit. Provider nodes reuse the durable model-job ledger and terminal acknowledgement rules. Local nodes use cancellable renderer workers or confined desktop services.

Node states are `idle`, `invalid`, `ready`, `waiting_confirmation`, `queued`, `running`, `blocked`, `completed`, `failed`, and `cancelled`. Existing durable output may remain visible during a new run, but it must be marked stale. Execution identity includes project revision, node revision, graph snapshot hash, knowledge snapshot version, and model route so late results cannot overwrite newer work.

### 4. Asset And Project Library Boundary

Uploaded and generated media enter through the confined desktop asset API. Renderer code receives public asset IDs and safe display URLs, never arbitrary local paths. Projects store asset IDs, metadata, hashes, dimensions, and origin classification, not Base64 media or private paths.

The canvas image library is project-scoped with search, source, dimensions, usage count, and insert/replace actions. Cross-device transfer uses sanitized approved manifests and the existing snapshot/outbox model. Another user's image, layout, or learning contribution requires approval before it can affect shared knowledge.

### 5. Provider Capability Layer

Provider access remains in desktop core. The renderer requests capabilities and public profiles through strict IPC. Initial image routes are GPT Image and Nano Banana 2 where configured through the approved provider. Future adapters must not expose secrets or raw responses to the renderer.

Profiles declare chat, vision, image-generation, image-edit, video-understanding, responses, and asynchronous-task capabilities. A module requests capabilities and route selection resolves a compatible profile. Unsupported combinations appear before confirmation.

Confirmation displays the route name, operation, reference count and order, output settings, and whether a remote request occurs. It never displays credentials, Authorization, raw task IDs, private paths, or provider payload dumps.

### 6. Unified Novus Agent

The right panel remains a full-height Novus Agent workspace with one persistent conversation per project. Conversation, Plan, Reverse, Skill, and Memory are views of the same context rather than separate bots.

Changing GPT Image or Nano Banana 2 changes only the route for the next confirmed action. Conversation history, image mentions, references, accepted requirements, project memory, and Skill context remain continuous.

The Agent can inspect selected nodes and propose a graph transaction. Proposed nodes and edges appear as ghost changes and require confirmation before entering project state. Provider work created by the graph plan requires a separate execution confirmation; accepting a plan does not silently spend provider resources.

A Detail Page specialist is an approved knowledge/persona route inside this same Agent, not a separate memory silo. It reasons about content hierarchy, product selling points, image sequence, layout rhythm, typography, material and lighting consistency, conversion-focused detail sections, and reference quality. Approved contributions from other devices or users may improve this knowledge only through sanitized provenance, review, and conflict handling.

## Initial Module Catalog

### Image And Input

- **Image / Import**: one project asset, metadata, preview, and `image_asset` output.
- **Upload Image**: confined import picker that creates or replaces a project asset.
- **Canvas Image Library**: selects existing assets and outputs an ordered image list.
- **Text / Prompt**: positive prompt, constraints, variables, and `@image` mentions.

### Generation

- **Image Generation V1**: compact prompt, ordered references, aspect ratio, quantity, route, and supported seed controls.
- **Image Generation V2**: role-aware references, composition/identity/material weighting, edit-mask input, quality settings, and richer result metadata.
- **Result / Output**: durable assets, provenance summary, rerun lineage, compare, keep, change, and send-to-editor actions.

V1 and V2 share the secure job engine. They differ in configuration depth and request compilation, not provider implementation.

### Image Editing And Guidance

- **Image Editor**: non-destructive crop, transform, mask, annotation, and revision output. Heavy pixel work uses a worker or confined service and writes a new asset revision.
- **OpenPose / Pose**: accepts image or pose data, exposes body/hand/face guidance where supported, and outputs normalized pose data with optional preview.
- **Line Art / Material Reasoning**: analyzes scene structure, depth layers, floor, walls, openings, object zones, materials, texture scale, color plan, and lighting intent. It outputs an analysis document and material plan for prompt or generation nodes.

### Agent Analysis

- **AI Reverse Analysis Agent**: ordered images produce composition, lens/camera, lighting, material, texture, typography, liquid behavior, particles, smoke, glow, distortion, motion cues, positive prompt, negative constraints, and an execution checklist.
- **Skill Agent Conversation**: a scoped node linked to the unified project conversation. It uses selected Skill knowledge, references, and memory without creating a separate memory silo.
- **Detail Page Knowledge Agent**: uses the same conversation and growth memory to plan product-detail-page hierarchy, section sequencing, image requirements, copy emphasis, layout quality, and visual consistency. It can consume approved cross-device examples and user feedback without copying private assets or unreviewed requirements.
- **Video / Script / Camera / VFX Analysis**: a video produces shot boundaries, sampled-frame evidence, script structure, camera timeline, lens/framing estimates, subject motion, transitions, speed ramps, compositing layers, liquid and particle effects, lighting changes, sound/design notes when available, and a reproducible production plan.

Video analysis is evidence-based rather than claiming perfect certainty. It records sample rate, shot boundaries, confidence, route, and unsupported observations. A user may request denser frame sampling for a selected interval.

## Ordered References And Image Mentions

Every multi-reference module uses one ordered-reference contract. Users can drag thumbnails, reorder connected image edges, assign identity/composition/prop/material/lighting/pose/mask/style roles, replace or remove references without shifting unrelated content, and use `@` in supported prompts and Agent composers.

Mentions store asset ID, display label, and insertion range. They never store object URLs or paths. Before execution, citations must resolve to assets in the frozen ordered reference list.

## Analysis Contracts

Reverse, video, and line-art analysis return structured documents rather than short answers. Schemas require relevant sections and allow explicit `not_observed` values instead of fabricated details.

Every analysis run binds its ordered references or video revision, persona or Skill, project-memory IDs, approved knowledge lease and version, model route and capability, nonce, and graph execution identity. Mismatched results are rejected. Provider text is sanitized before entering project state, logs, snapshots, or memory candidates.

## Growth Memory And Project Task Memory

Every explicit correction or feedback submission from any Agent capability, including reverse analysis, Skill conversation, detail-page planning, video analysis, line-art reasoning, and generation review, creates a structured record containing user request, affected result, cause, missed requirement, correction, prevention rule, verification evidence, applicable reference/citation/knowledge/route IDs, and review/promotion status.

Accepted requirements become project memory even when they are not eligible for cross-project Skill promotion. Repeated feedback becomes a Skill candidate only through review and approval.

Project task memory separately records accepted scope, current task, commits, reviews, tests, blockers, runtime gates, packaging gates, and external dependencies. It survives conversation compaction and project reopening. Chat text is never the only task truth.

Cross-device sync transfers sanitized records and approved snapshots. Remote contributions cannot automatically change executable modules, provider configuration, credentials, or approved Skills. Conflicts remain reviewable diffs.

## Data Flows

### Manual Generation

1. User connects prompt and ordered references to a generation node.
2. Graph validation reports invalid inputs inline.
3. User selects a compatible route.
4. The compiler freezes an execution manifest.
5. Confirmation shows the public request summary.
6. User confirms.
7. Desktop core submits, polls, and acknowledges the task.
8. Result media enters the confined asset store.
9. A result node updates through one project transaction.
10. Saved appears only after durable project ACK.

### Agent-Proposed Generation

1. User describes the change and may cite images.
2. Agent reads selected nodes, approved memory, Skill knowledge, and references.
3. Agent proposes ghost nodes and edges.
4. User accepts or rejects the graph transaction.
5. Provider execution waits for separate model confirmation.
6. Results and feedback return to the same conversation and memory pipeline.

### Analysis And Learning

1. User runs reverse, video, or line-art analysis.
2. The run pins evidence and knowledge versions.
3. Structured results appear in the node and Agent thread.
4. User marks keep/change/never or writes a correction.
5. A retrospective memory record is created.
6. Skill promotion remains pending until explicitly reviewed.

## Error Handling And Recovery

- Invalid graphs never enqueue work.
- Credential-locked tasks remain blocked and recoverable without losing manifests.
- Network failures distinguish submission, polling, and terminal-ACK phases.
- Cancelled and failed jobs replay only through legal transitions.
- Restart restores queued, running, cancelled-replay, and ACK-pending states.
- Stale results remain available for comparison but never impersonate newer output.
- Errors are short, sanitized, actionable, and linked to retry or configuration actions.
- Failed migrations use existing recovery and snapshots instead of partially loading.

## Persistence And Performance

Node drag, pan/zoom, image transform, reorder preview, mask drawing, and placement pointermove update ephemeral UI only. Persistence occurs at drag stop, reorder drop, edit commit, mask-stroke batch, configuration commit, and graph transaction commit.

Retain viewport culling and Legacy quality degradation. Add stable node dimensions and ports, memoized node bodies and selectors, runtime thumbnail budgets, worker-backed expensive work, virtualized module and asset lists, conservative job and decode limits, no continuous decorative animation, and performance marks for large graph interaction.

Acceptance covers at least 100 mixed nodes, 150 edges, 20 ordered references, multiple result thumbnails, and an open Agent panel on supported profiles.

## Security And Privacy Boundaries

- Renderer has no arbitrary filesystem, shell, process, keychain, token, or unrestricted network access.
- Desktop IPC uses strict schemas and rejects unknown keys.
- Credentials remain encrypted in the vault and never return to renderer.
- Projects, journals, snapshots, packs, logs, task memory, growth memory, and sync payloads contain no API keys, Authorization, Base64 originals, object URLs, raw provider payloads, or private absolute paths.
- Asset access uses confined IDs and approved display URLs.
- Media is not uploaded until a user confirms a remote operation.
- Cross-device knowledge and layouts are sanitized, approval-guarded, and provenance-labeled.
- CanvasForge and installed software are never modified, instrumented, decompiled, or used as credential sources.

## Desktop Runtime Compatibility

Shared domain and renderer code must support Electron 22 and Node 16 build targets. Legacy provider networking continues through Electron `net.request`. Unsupported APIs need a tested fallback or a Modern-only capability gate.

Modules declare runtime support. A Modern-only local feature may degrade to provider-backed or disabled on Legacy, but graph editing, Agent conversation, reference ordering, confirmation, recovery, and persistence work in both runtimes.

## UI Direction

Use an original Novus professional desktop creative-tool interface: searchable left module rail, large inspectable media nodes with stable ports, quiet infinite canvas, compact minimap, contextual inspector, persistent right-side Agent, restrained semantic colors, compact controls, and a complete Lucide icon system.

Do not use a marketing hero, decorative card stacks, gradient decoration, or copied CanvasForge branding/trade dress. Product Design and Figma workflows are used during implementation acceptance. Runtime screenshots and Playwright verify behavior; editable Figma delivery remains an external gate when quota permits.

## Implementation Slices

1. Registry, typed ports, graph migration, connection validation, and module library.
2. Image/import, upload, canvas library, prompt, ordered references, and `@image`.
3. Generation V1/V2, compiler, confirmation, GPT Image/Nano Banana 2, and results.
4. Unified Agent, graph proposals, Skill conversation, and project task memory.
5. Provider reverse analysis including liquid, VFX, material, texture, lighting, and camera.
6. Image editor and OpenPose.
7. Video/script/camera/VFX analysis with sampled-frame evidence and timeline.
8. Line-art structure, color, material, texture, floor, wall, and lighting reasoning.
9. Approved cross-device learning, retrospectives, performance, visual acceptance, and runtime validation.

Each slice follows RED -> GREEN -> self-review -> commit -> independent review. Critical and Important findings are fixed before continuing.

## Verification

- Domain tests for registry, ports, migration, graph validation, identity, and analysis schemas.
- Renderer tests for creation, configuration, connections, ordering, mentions, inspectors, Agent continuity, and confirmation.
- Desktop-core tests for routing, confinement, sanitization, replay, cancellation, ACK, and credentials.
- Integration tests from compilation through durable result persistence.
- Restart recovery tests across submit, poll, cancel, import, commit, and save ACK.
- Cross-device tests proving protected data exclusion and approval requirements.
- Playwright flows for generation, Agent plans, analyses, feedback learning, undo, recovery, and large canvas.
- Screenshot inspection at 1366x768, 1440x900, and 1920x1080.
- Legacy Electron 22 and Modern Electron smoke tests.
- Full `npm test`, `npm run typecheck`, `npm run build`, E2E, secret/path scan, and `git diff --check`.

## Release Gates

No portable build, installer, or release package is produced until all slices and reviews complete; model routes and real execution are safely tested; performance passes; Windows 7/10/11 evidence is complete; recovery and durable ACK are verified; secret, Authorization, Base64, private-path, and proprietary-copy scans pass; and the user completes integrated functional and visual testing.

## Non-Goals

- Pixel-for-pixel cloning of CanvasForge or Infinite-Canvas.
- Importing proprietary code, UI assets, branding, credentials, or hidden provider behavior.
- Allowing remote knowledge to install executable code automatically.
- Uploading user media without explicit operation confirmation.
- Packaging before functionality, performance, security, runtime, and user-acceptance gates are complete.