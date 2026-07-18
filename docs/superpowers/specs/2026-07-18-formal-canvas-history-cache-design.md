# Novus Atelier Formal Canvas, History, and Cache Design

**Status:** Approved design baseline
**Scope:** Novus Atelier desktop canvas productization
**Compatibility:** Electron 22, Node 16, ES2019, React 18, TypeScript, Zustand, React Flow, Zod, and Lucide

## Product direction

Novus Atelier is a bilingual, professional desktop workbench for designing and executing visual-generation workflows on an infinite canvas. It provides a clean, intentional starting state, durable project work, controlled provider execution, and explainable image and video reverse analysis. It is an original product: CanvasForge / 桥豆麻辣配? is observation-only and supplies neither implementation, branding, UI, source code, credentials, nor trade dress.

The visual system supports `system`, `light`, and `dark` themes. `system` is the default; a user's device-local override is retained independently from project data. Both explicit themes use the same semantic token model and retain visible focus, disabled, and error states. The product mark is an original geometric N composed of canvas nodes and connections, legible at 16 pixels. Every executable module has a real Lucide icon; different semantics never share an indistinguishable icon without a visible differentiating badge.

## Startup and workbench behavior

Normal launch opens an untitled project with zero nodes and zero edges. It does not reopen a recent project automatically. An abnormal-close candidate is offered only through an explicit recovery choice. The empty canvas presents restrained actions to open a project, begin a workflow, or activate a module.

The workbench is bilingual: module names are Chinese-primary and English-secondary, with Chinese descriptions, categories, favorites, recents, and bilingual search. A single click selects and describes a module; a double click adds exactly one node at the viewport center; a drag adds it at the drop point. Browsing and transient placement activity do not persist. When an unnamed dirty project closes, the desktop boundary presents save, discard, and cancel.

Nodes communicate a Chinese-primary/English-secondary title, category, purpose, configuration, state, typed ports, model route, results, and actionable errors. Nodes use proper empty-media visuals rather than textual image placeholders. The Agent is a collapsible dock that reflows the safe canvas area; it cannot cover nodes or ports.

## Module contracts and intended catalog

The domain owns strict Zod schemas and stable internal type identifiers. Typed module contracts cover existing image upload, library, text, generation, editor, OpenPose, Agent, material, and output workflows while keeping them backward compatible. The catalog additionally includes storyboard sheet/chart, drawing mask, image comparison, local redraw, controlled Comfy workflow, and video reverse analysis.

Each module specifies its purpose, usage, limitations, capabilities, typed inputs and outputs, and recommended downstream connections. Execution is routed by declared capability rather than an implicit vendor choice. The recommender proposes a compatible route; a confirmation screen permits an explicit override, then freezes the selected route for the run.

## Persistence and performance

Projects persist nodes, edges, configuration, managed assets, results, jobs, knowledge references, and approved growth candidates only at stable transaction boundaries. Pointer movement, pan, zoom, connection previews, sort previews, and transient drag state are never persisted. “已保存” is displayed only after a durable main-process acknowledgement.

Image and video assets are held as managed files addressed by opaque IDs; project files never embed Base64 originals. The desktop core makes disk-full, read-only, missing-asset, duplicate-open, corrupt-snapshot, and abnormal-exit cases explicit and recoverable. A conservative automated acceptance scenario exercises 300 nodes and 500 edges with real thumbnail shapes, long bilingual names, mixed execution states, the module library, and Agent dock. No measured interaction stall may exceed 250 ms in that scenario.

## Generation history and trash

Generation history is an authoritative durable record, not a disposable cache. An entry contains an opaque ID, timestamp, project label and ID, provider/model display metadata, status, dimensions, file size, sanitized prompt summary and parameters, favorite state, availability, and project-reference count. It supports page/filter listing, favorites, add/copy to a project library, reuse-safe parameters, compare selection, export through a picker, soft delete, restoration, and purge.

History views support date, project, model, status, and favorite filters, previews, reuse, comparison, export, batch favorite/delete/restore, and totals. Deleted history moves to app-controlled trash for seven days; immediate purge requires explicit confirmation. A project-referenced copy survives deletion of its originating history entry. No raw provider URL, credential, raw payload, Base64, object URL, or private absolute path is persisted in history metadata or crosses IPC.

## Storage, cache, cleanup, and migration

History and cache have separate, user-configurable local locations. History is protected and durable; cache is disposable. The application rejects drive and system roots, project directories, installation directories, network shares, symlinks, junctions, and every other reparse point. A destination is accepted only when the application owns it through an ownership marker.

Cache inventory categories are thumbnails, canvas previews, video-analysis frames, provider temporary downloads, failed/cancelled job residue, rebuildable model/knowledge indexes, and disposable Chromium cache. The default cache quota is 10 GB. Automatic cleanup selects least-recently-used disposable entries that are older than 30 days or required to satisfy the quota. It returns a preview with count, bytes, and protected-reference information before execution. Cleanup never deletes projects, history, favorites, knowledge, memory, or referenced assets.

Changing a location validates capacity, copies data, verifies size and hash, atomically switches configuration, and retains the old location until success. Any migration failure rolls back without data loss. The settings workbench exposes both paths, category and total bytes, last and next cleanup, quota, migration/cleanup progress, reveal location, change location, cleanup preview, and cleanup execution. Destructive actions disclose exact item count, bytes, and reference impact and are disabled while a conflicting migration or cleanup operates.

## Provider and Comfy boundaries

Provider profiles advertise chat, vision, structured output, long-video, image-generation/edit, pose, and Comfy-workflow capabilities. The renderer receives neither provider tokens, raw provider task IDs, arbitrary URLs, arbitrary filesystem access, process access, credential access, keychain access, nor unrestricted network access. Desktop-core owns provider execution, polling, timeout, authentication, rate limiting, cancellation, retry, acknowledgement, stale-result handling, and redaction behind narrow preload bridges.

Comfy import is controlled rather than general-purpose. It rejects credentials, absolute paths, scripts, protected payloads, and unknown/custom nodes outside the allowlist. Its sanitized schema is the only admitted workflow form. Durable logs, snapshots, packages, tests, and data do not contain API keys, authorization headers, Base64 originals, object URLs, raw provider payloads, or private absolute paths.

## Reverse analysis and growth

Image/text reverse analysis provides a default commercial/e-commerce template plus general-visual and film templates. A run binds a project/node revision, ordered inputs, approved knowledge lease and citations, project memory, frozen model route, execution identity, and nonce. It returns subject, scene depth, props, materials, lighting, camera/composition, color, effects, post-processing, typography, positive prompt, negative constraints, reproduction steps, evidence source, and confidence. Image evidence, knowledge rules, and model inference remain distinct. Results are previewed first; only explicit confirmation materializes prompt, constraint, and generation nodes. Mismatched route, input order, knowledge version, execution identity, or nonce is rejected.

Video reverse analysis binds a video revision and time range and uses only long-video-capable profiles. It produces a shot timeline, camera movement, composition, scene/prop changes, materials, lighting, effects, transitions, rhythm, keyframes, audio-visual relationship, confidence, and citations. It supports partial success, retry by segment, replacement invalidation, cancellation, and stale-result isolation. Explicit confirmation materializes a storyboard sheet/chart, prompts, and optional shot-level generation nodes.

Each reverse run records a nonblocking local growth candidate with sanitized goal, knowledge version, route, output summary, accepted edits, reruns, deletion, and failure causes. Only explicitly approved sanitized snapshots enter the durable cross-device outbox. Raw images/videos, history files, and private prompts never synchronize. An outbox item clears only after authoritative `accepted: true`; rejected, conflicted, and offline work remains durable.

## Security boundaries

Domain owns strict typed schemas and contains no privileged desktop capability. Desktop-core owns confined filesystem access, durable acknowledgements, provider execution, history/cache lifecycle, migration, and growth acknowledgement. The preload bridge exposes narrow typed operations only. The renderer has no arbitrary filesystem, process, keychain, token, credential, or unrestricted network access.

All path choices are confined and app-owned; all sensitive provider data is redacted before storage or IPC; all assets use opaque identifiers; and every destructive operation exposes its concrete scope before confirmation. Reference software remains observation-only: it must not be unpacked, decompiled, copied, credential-inspected, or used as a basis for copied branding or trade dress.

## Release gates

Release eligibility requires focused domain, desktop, renderer, persistence, provider, history, cache, migration, redaction, and performance verification; root typecheck and build; Playwright flows; a secret/path scan; and `git diff --check`. Visual evidence covers light and dark themes at 1366×768, 1440×900, and 1920×1080 for empty canvas, module library, history, storage, reverse preview, video timeline, and 300/500 stress. Review confirms intended nonempty views, readable ports, no panel overlap, no placeholder art, and restrained professional desktop quality.

Figma editable frames and physical Windows/user acceptance are external release gates and are recorded as such until evidence exists. Packaging, portable, and installer commands do not run before all functional, performance, security, Windows, Figma, and user-acceptance gates are complete.
