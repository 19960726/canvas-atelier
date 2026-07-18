# Novus Atelier Formal Canvas, History, and Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Every production behavior follows RED -> GREEN -> refactor, each task is committed independently, and each task receives spec-compliance plus code-quality review.

**Goal:** Deliver a professional bilingual infinite-canvas desktop application with dual themes, an original Windows icon chain, clean startup, typed visual modules, durable projects, generation history, user-configurable storage/cache locations, knowledge-grounded image/video reverse analysis, and approved cross-device growth.

**Architecture:** Preserve the existing domain/desktop-core/renderer boundaries. Domain owns strict schemas and typed module contracts, desktop-core owns filesystem, provider, history, cache, migration, and durable-ACK behavior, and the renderer consumes only narrow preload bridges. Reference software is observation-only and may inform capability mapping, never code, secrets, branding, UI, or trade dress.

**Tech Stack:** TypeScript, React 18, Zustand, React Flow, Zod, Vitest, Playwright, Electron 22-compatible shared code, Node 16, ES2019, Lucide, electron-builder configuration.

## Global Constraints

- Work only in `E:\画布项目\.worktrees\canvas-agent-mvp` on `feature/canvas-agent-mvp`; never modify `E:\画布项目` main checkout.
- Shared behavior must remain compatible with Electron 22, Node 16, and ES2019.
- Renderer has no arbitrary filesystem, process, credential, token, keychain, or unrestricted network access.
- Pointer move, pan, zoom, connection preview, sort preview, and transient drag state are never persisted.
- Show “已保存” only after a durable main-process ACK.
- Durable data, logs, snapshots, packages, and tests must not contain API keys, Authorization, Base64 originals, object URLs, raw provider payloads, or private absolute paths.
- CanvasForge / 桥豆麻衣酱 is observation-only; do not unpack, decompile, copy source/UI/branding, extract credentials, or reproduce trade dress.
- `.superpowers/sdd/*` is never committed.
- Do not run pack, portable, or installer commands until every functional, performance, security, Windows, Figma, and user-acceptance gate is complete.
- Every task uses RED -> GREEN -> self-review -> focused verification -> commit -> independent task review. Critical and Important findings must be fixed and re-reviewed before continuing.

---

### Task 0: Baseline, Approved Design Spec, and Reference Capability Matrix

**Files:**
- Create: `docs/superpowers/specs/2026-07-18-formal-canvas-history-cache-design.md`
- Create: `docs/research/canvasforge-module-compatibility.md`
- Update ignored ledger: `.superpowers/sdd/progress.md`

**Requirements:**
- Record the current dirty UI/icon draft by status, base SHA, diff stat, and untracked-file hashes in ignored evidence without discarding it.
- Document the approved UI, module, reverse-analysis, history, cache, persistence, performance, security, and release decisions with no TBD/TODO placeholders.
- Map the visible reference categories (image, text, storyboard, painting/mask, video, Agent, Comfy UI, compare, local redraw) to original Novus modules, typed ports, execution modes, and safety boundaries.
- Explicitly state that music and speech are researched but disabled in this delivery.
- Reproduce the existing provider cross-process lock test at least five focused runs; record whether it is flaky or deterministic. Do not change production code without an independent failing regression test.

**Verification:**
- `git diff --check`
- `npm test -- packages/desktop-core/src/provider-bridge.test.ts -t "uses cross-process file locking"`

**Commit:** `docs: specify formal canvas productization`

---

### Task 1: Dual-Theme Tokens and Complete Product Icon Chain

**Files:**
- Modify renderer theme/tokens and shell styles under `apps/renderer/src/styles/`.
- Modify `apps/desktop-modern/src/main.ts`, `apps/desktop-legacy/src/main.ts`, and both builder configurations.
- Create the single brand SVG source plus generated PNG sizes 16/24/32/48/64/128/256/512 and multi-frame ICO assets.
- Complete icon and theme contract tests.

**Requirements:**
- Themes are `system`, `light`, and `dark`; system is the default and device-local override is persisted without changing project data.
- Light/dark themes share semantic tokens and WCAG-visible focus/disabled/error states.
- Brand icon is an original geometric N formed by canvas nodes/connections, legible at 16px, with no emoji or copied mark.
- Every executable canvas module resolves to a real Lucide icon; no duplicate semantic signatures for distinct modules unless explicitly differentiated by a visible badge.
- Development BrowserWindow and future Windows build config use valid shared icons while preserving the existing packaged renderer layout contract.

**Verification:**
- Focused icon/theme tests, root typecheck, both desktop configuration contract tests, renderer build, `git diff --check`.

**Commit:** `feat: establish Novus themes and icon system`

---

### Task 2: Clean Startup, Recovery Choice, and Bilingual Module Activation

**Files:**
- Modify renderer initial state/hydration and workspace/module-library components.
- Extend domain module labels/search metadata without changing stable internal type IDs.
- Add focused renderer and desktop recovery tests.

**Requirements:**
- Normal startup presents an untitled project with zero nodes and zero edges.
- An abnormal-close recovery candidate is shown only as an explicit user choice; normal startup never auto-opens the recent project.
- The empty canvas shows restrained actions for open project, new workflow, and module activation.
- Module library uses Chinese primary names, English secondary names, Chinese descriptions, categories, favorites, recent items, and bilingual search.
- Single click selects/describes; double click creates exactly one node at viewport center; drag creates at the drop point; browsing never persists.
- Closing an unnamed dirty project exposes save/discard/cancel through the existing safe desktop boundary.

**Verification:**
- Focused App/store/workspace/module/recovery tests, typecheck, renderer build, visual E2E for empty startup and double-click creation.

**Commit:** `feat: add clean startup and bilingual modules`

---

### Task 3: Complete Professional Module Catalog and Node Workbench

**Files:**
- Extend `packages/domain/src/canvas-module.ts` and migrations/tests.
- Update module icon/node/rendering components and workbench styles.
- Update visual-layout/module-library E2E coverage.

**Requirements:**
- Add original typed modules for storyboard sheet/chart, drawing-mask, compare images, local redraw, Comfy workflow, and video reverse analysis.
- Keep current image/upload/library/text/generation/editor/OpenPose/Agent/material/output modules backward compatible.
- Each module documents purpose, usage, limitations, capabilities, typed inputs/outputs, and recommended downstream connections.
- Nodes show Chinese primary/English secondary labels, category, real icon, configuration, state, typed ports, model route, results, and actionable errors.
- Remove `IMG` text placeholders; use proper empty-media visuals.
- Agent is a collapsible dock that reflows the safe canvas area instead of covering ports/nodes.

**Verification:**
- Domain module/migration tests, renderer node/module tests, 1366x768/1440x900/1920x1080 visual E2E in light and dark themes.

**Commit:** `feat: complete professional canvas modules`

---

### Task 4: Durable Project Semantics and 300/500 Canvas Performance

**Files:**
- Extend project schemas/repository only where required by new modules and assets.
- Update canvas culling, thumbnail loading, store selectors, and performance tests.

**Requirements:**
- Persist node/edge/configuration/assets/results/jobs/knowledge references/growth candidates only at stable transaction boundaries.
- Project images/videos remain managed assets referenced by opaque IDs; no Base64 project originals.
- Disk-full, read-only, missing-asset, duplicate-open, corrupt-snapshot, and abnormal-exit behaviors are explicit and recoverable.
- Stress acceptance uses 300 nodes, 500 edges, real thumbnail shapes, long bilingual titles, mixed execution states, module library, and Agent dock.
- No measured interaction long stall over 250ms in the conservative automated scenario.

**Verification:**
- Persistence/recovery suites, performance suite, 300/500 Playwright stress, typecheck/build, scan, diff check.

**Commit:** `perf: harden large durable canvas projects`

---

### Task 5: Generation History Domain and Desktop Store

**Files:**
- Add strict generation-history schemas to domain.
- Add desktop-core history index/store with confined files, atomic metadata, pagination/filtering, favorites, project-reference counts, and redaction.
- Add narrow preload/bridge contracts and tests.

**Requirements:**
- Entries expose opaque IDs, timestamp, project label/id, provider/model display metadata, status, dimensions, file size, sanitized prompt summary/parameters, favorite, availability, and reference count.
- History is authoritative and never a disposable cache.
- Support list/filter/page, favorite, add/copy to project library, reuse-safe parameters, compare selection, export through picker, soft-delete, restore, and purge.
- Provider URLs, credentials, raw payloads, Base64, object URLs, and private paths never cross IPC or enter history metadata.

**Verification:**
- Domain/store/bridge contract tests, restart durability, concurrent updates, redaction and confinement tests.

**Commit:** `feat: add durable generation history`

---

### Task 6: Storage Locations, Cache Inventory, and Safe Migration

**Files:**
- Add desktop-core storage-settings, cache-inventory, cleanup-preview, and migration services.
- Add strict bridge/preload contracts and settings UI.

**Requirements:**
- Separate protected history location from disposable cache location; both are user-configurable local directories.
- Reject drive/system roots, project directories, install directories, network shares, symlinks, junctions, and other reparse points.
- Destination must be app-owned through an ownership marker.
- Migration validates space, copies, verifies size/hash, atomically switches configuration, and retains the old location until success; failure rolls back without data loss.
- Cache categories: thumbnails, canvas previews, video-analysis frames, provider temporary downloads, failed/cancelled job residue, rebuildable model/knowledge indexes, and disposable Chromium cache.
- Default quota is 10GB; automatic cleanup selects LRU entries older than 30 days or over quota.
- Cleanup preview returns count/bytes/protected references. Cleanup never deletes projects, history, favorites, knowledge, memory, or referenced assets.

**Verification:**
- Path rejection matrix, migration interruption/disk-full/hash-mismatch rollback, concurrent cleanup, preview/actual byte agreement, Windows path tests.

**Commit:** `feat: add safe storage and cache controls`

---

### Task 7: Generation History and Cache Management UI

**Files:**
- Add renderer history workspace, trash, filters, storage settings, and cache cleanup components.
- Add renderer state/client bindings and Playwright workflows.

**Requirements:**
- History supports date/project/model/status/favorite filters, previews, add to canvas/library, reuse, compare, export, batch favorite/delete/restore, and usage totals.
- Deleted history enters app-controlled trash for seven days; immediate purge requires explicit confirmation.
- Project-referenced copies survive history deletion.
- Settings show history/cache paths, category bytes, total bytes, last/next cleanup, quota, migration/cleanup progress, reveal-location, change-location, preview, and execute cleanup.
- Destructive actions show exact item count/bytes/reference impact and remain disabled while conflicting migrations/cleanups run.

**Verification:**
- Renderer component tests and full history/cache Playwright flow including restore and path-migration failure.

**Commit:** `feat: add history and storage workspace`

---

### Task 8: Capability-Based Provider Routing and Controlled Comfy Adapter

**Files:**
- Extend provider profile capability contracts and dynamic registry.
- Add controlled Comfy workflow schemas, sanitizer, provider bridge, and module execution adapter.

**Requirements:**
- Capabilities cover chat, vision, structured output, long video, image generation/edit, pose, and Comfy workflow.
- Recommender selects a compatible route but confirmation UI permits explicit override and freezes the route.
- Renderer never receives provider tokens, raw task IDs, arbitrary URLs, or filesystem access.
- Comfy workflow import rejects credentials, absolute paths, scripts, unknown/custom nodes outside the allowlist, and protected payloads.
- Timeout, auth, rate-limit, cancel, retry, polling, ACK, and stale-result behavior remain durable and sanitized.

**Verification:**
- Provider/Comfy domain and desktop bridge tests, renderer confirmation tests, scan, typecheck/build.

**Commit:** `feat: add capability routing and safe Comfy workflows`

---

### Task 9: Knowledge-Grounded Image/Text Reverse Agent

**Files:**
- Extend reverse-analysis domain schemas and desktop/provider orchestration.
- Replace renderer draft-only analysis with provider-capable structured preview/materialization.

**Requirements:**
- Default commercial/e-commerce template plus general-visual and film templates.
- Bind project/node revisions, ordered inputs, approved knowledge lease/citations, project memory, model route, execution identity, and nonce.
- Output subject, scene depth, props, materials, lighting, camera/composition, color, effects, post, typography, positive prompt, negative constraints, reproduction steps, evidence source, and confidence.
- Distinguish image evidence, knowledge rule, and model inference.
- Preview first; only explicit confirmation materializes prompt/constraint/generation nodes.
- Reject mismatched route, input order, knowledge version, execution identity, or nonce.

**Verification:**
- Domain schemas, orchestration, renderer preview/materialization, stale-result, redaction, and knowledge-citation integration tests.

**Commit:** `feat: add knowledge-grounded reverse analysis`

---

### Task 10: Video Reverse Analysis and Storyboard Materialization

**Files:**
- Add video-analysis schemas/orchestration, chunk/timeline aggregation, renderer node UI, and materialization tests.

**Requirements:**
- Bind video revision and time ranges; route only to long-video-capable profiles.
- Output shot timeline, camera motion, composition, scene/prop changes, materials, lighting, effects, transitions, rhythm, keyframes, audio-visual relationship, and confidence/citations.
- Support partial success, retry by segment, replacement invalidation, cancellation, and stale-result isolation.
- Explicit confirmation materializes storyboard sheet/chart, prompts, and optional shot-level generation nodes.

**Verification:**
- Chunk aggregation, partial failure, cancellation/retry, stale results, renderer materialization, and E2E workflow.

**Commit:** `feat: add video reverse breakdowns`

---

### Task 11: Per-Run Growth Candidates and Cross-Device Approval

**Files:**
- Extend feedback/candidate schemas and renderer/desktop integration for image/video reverse usage signals.

**Requirements:**
- Every reverse run records sanitized goal, knowledge version, route, output summary, accepted edits, reruns, deletion, and failure causes as a local candidate.
- Candidate capture never blocks the active workflow.
- Only explicitly approved sanitized snapshots enter the existing durable outbox/cross-device pull flow.
- Raw images/videos/history files/private prompts never sync.
- Queue clears only on authoritative `accepted:true`; rejected/conflicted/offline tasks remain durable.

**Verification:**
- Image and video candidate integration, approval/rejection, offline restart, duplicate/conflict, dual-device HTTP integration, security scan.

**Commit:** `feat: grow reverse knowledge across devices`

---

### Task 12: Full Acceptance, Documentation, and Whole-Branch Review

**Files:**
- Extend Playwright helpers/specs and compatibility evidence only as required.
- Update `.superpowers/sdd/progress.md` with exact commits, tests, screenshots, reviews, and remaining external gates.

**Requirements:**
- Full Vitest, typecheck, build, Playwright, scan, and diff check.
- Light/dark screenshots at 1366x768, 1440x900, and 1920x1080 for empty canvas, module library, real history, storage settings, reverse preview, video timeline, and 300/500 stress.
- Inspect screenshots for nonempty intended views, readable ports, no panel overlap, no placeholder art, and professional restrained desktop quality.
- Independent final reviewer checks the full implementation range; fix and re-review all Critical/Important findings.
- Record Figma editable frames and physical Windows/user acceptance as external gates when unavailable; never claim them complete without evidence.
- Do not package.

**Verification:**
- `npm test`
- `npm run typecheck`
- `npm run build`
- `npm run e2e`
- `npm run scan:e2e`
- `git diff --check`

**Commit:** `test: verify formal Novus Atelier workflows`
