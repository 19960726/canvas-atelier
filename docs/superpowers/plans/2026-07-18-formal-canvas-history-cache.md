# Novus Atelier Formal Canvas, History, and Cache Implementation Plan

**Goal:** Deliver an original bilingual infinite-canvas desktop app with durable projects, controlled capability-routed execution, unified image generation and Reverse Agent workflows, generation history, safe storage/cache controls, and approved cross-device growth.

**Architecture:** Domain owns strict schemas and migrations. Desktop-core owns managed assets, provider execution, confined filesystem/process bridges, history, cache, and durable acknowledgement. The renderer uses narrow typed preload APIs only. Reference software is observation-only and can inform public capability categories only; it must never supply source, UI, branding, secrets, credentials, endpoints, private model IDs, or trade dress.

**Compatibility:** Electron 22, Node 16, ES2019, React 18, TypeScript, Zustand, React Flow, Zod, Vitest, Playwright, Lucide, and existing electron-builder configuration.

## Global constraints

- Work only in `E:\画布项目\.worktrees\canvas-agent-mvp` on `feature/canvas-agent-mvp`; do not modify the main checkout.
- The renderer has no arbitrary filesystem, process, credential, token, keychain, or unrestricted-network access.
- Pointer move, pan, zoom, connection preview, sort preview, and transient drag state never persist. `已保存` appears only after durable main-process acknowledgement.
- Durable data, logs, snapshots, packages, and tests contain no API keys, authorization headers, Base64 originals, object URLs, raw provider payloads, or private absolute paths.
- Use only public/compatible providers and user-authorized credentials. Do not unpack/decompile reference software, inspect credentials, copy source/UI/copy/branding, or reproduce private endpoints.
- New behavior follows RED → GREEN → refactor, focused verification, self-review, and a task commit. The release task receives independent full-branch review.
- Do not run pack, portable, or installer commands until all functional, performance, security, Windows, Figma, and user-acceptance gates have evidence.

---

### Task 0: Baseline, approved design, and public capability matrix

**Requirements:** Record current evidence without discarding unrelated work; document all approved module, reverse, history, cache, security, performance, and release decisions. Map publicly visible authorized categories—image, text, storyboard, painting/mask, video, Agent, Comfy, compare, local redraw, music, and speech—to original Novus contracts and safety boundaries. Music and speech have planned capability-routed modules. Reproduce the provider cross-process lock test five focused times before production changes.

**Verification:** `git diff --check`; focused provider lock test.

**Commit:** `docs: specify formal canvas productization`

---

### Task 1: Dual-theme tokens and complete product icon chain

**Requirements:** Implement system/light/dark semantic tokens, original geometric-N icon assets, and distinct Lucide module icon treatments while preserving existing packaged-renderer layout contracts.

**Verification:** Focused icon/theme and desktop-configuration tests; typecheck; renderer build; `git diff --check`.

**Commit:** `feat: establish Novus themes and icon system`

---

### Task 2: Clean startup, recovery choice, and bilingual activation

**Requirements:** Start with an untitled zero-node project; offer recovery only by explicit choice; provide restrained empty-canvas actions; implement Chinese-primary module library/search activation; and retain safe unnamed-dirty-project close behavior.

**Verification:** Focused startup, module, recovery, typecheck/build, and visual E2E tests.

**Commit:** `feat: add clean startup and bilingual modules`

---

### Task 3: Unified module catalog, migrations, and node workbench

**Requirements:** Replace user-visible V1/V2 image generation entries with exactly one `图片生成 / Image Generation` module; preserve `image_generation_v1` and `image_generation_v2` only as migrations, with no loss of ordered references, mask/pose, route, configuration, job, or result identity. Replace visible image/text and video analysis entries with exactly one `Agent 反推 / Reverse Agent` node that accepts ordered image assets, video ranges, text/tasks, line-art, and approved knowledge/project memory; migrate the verified legacy serialized `video_analysis` type to the unified node without loss of video ranges, results, or execution identity. Add contracts for storyboard, drawing mask, compare, local redraw, controlled Comfy, music, speech, and line-art analysis, with typed ports and explicit confirmation/execution/error states. Build original bilingual node presentation and an Agent dock that reflows the safe canvas area.

**Verification:** Domain module/migration tests for `image_generation_v1`, `image_generation_v2`, and `video_analysis`; catalog-uniqueness tests; renderer node/module tests; light/dark visual E2E at 1366x768, 1440x900, and 1920x1080.

**Commit:** `feat: unify Novus module catalog`

---

### Task 4: Durable project semantics, free placement, and 300/500 performance

**Requirements:** Persist only stable transactions for nodes, edges, configuration, managed assets, results, jobs, knowledge, conversations, and growth candidates. Keep Reverse Agent, image generation, and result nodes freely draggable after completion or failure. Make reference reordering show ordinals/responsibilities and persist exactly one drop transaction; execution snapshots freeze order for that run only. Connections never auto-layout; optional layout is undoable; locks are explicit and reversible. Exercise recoverable disk/full, read-only, missing asset, duplicate-open, corrupt snapshot, and abnormal-exit paths and the 300-node/500-edge scenario under 250 ms interaction-stall threshold.

**Verification:** Persistence/recovery, drag/order/snapshot/lock, performance, Playwright stress, typecheck/build, scan, and diff-check suites.

**Commit:** `perf: harden durable canvas projects`

---

### Task 5: Generation history domain and desktop store

**Requirements:** Add strict history schemas and confined atomic store with pagination, filters, favorites, project references, safe reuse/comparison/export, trash/restore/purge, and redaction. History remains durable and separate from cache.

**Verification:** Domain/store/bridge contract, restart, concurrency, redaction, and confinement tests.

**Commit:** `feat: add durable generation history`

---

### Task 6: Storage locations, cache inventory, and safe migration

**Requirements:** Add app-owned history/cache locations; reject roots, project/install locations, network shares, symlinks, junctions, and reparse points. Provide capacity/hash-verified atomic migration with rollback; cache inventory and 10 GB LRU cleanup previews; and protect projects, history, favorites, knowledge, memory, and referenced assets.

**Verification:** Path rejection, migration interruption/disk-full/hash-mismatch, concurrency, preview/actual-byte, and Windows-path tests.

**Commit:** `feat: add safe storage and cache controls`

---

### Task 7: Generation history and cache-management UI

**Requirements:** Provide history filters, previews, reuse, comparison, export, batch favorite/delete/restore, totals, and seven-day trash; provide settings paths, bytes, quota, migration/cleanup progress, reveal/change location, cleanup preview, and confirmed cleanup. Show exact destructive scope and disable conflicting actions.

**Verification:** Renderer tests and full history/cache Playwright flow, including restore and migration failure.

**Commit:** `feat: add history and storage workspace`

---

### Task 8: Dynamic capability routing and controlled Comfy adapter

**Requirements:** Build inventory-driven profiles for chat, vision, structured output, image generation/edit, pose, long video, Comfy, music generation, speech synthesis, and speech/audio analysis. Profiles declare display identity, provider, route/model id, modalities, output, structured-output support, Chinese capability, limits, async behavior, and available cost metadata. Recommend compatible routes, permit compatible override at confirmation, freeze the revision for execution, and expose incompatible profiles with reasons. Keep public/compatible provider contracts only; sanitize Comfy imports and keep all tokens, raw task IDs/payloads, arbitrary URLs, and filesystem access out of the renderer.

**Verification:** Provider/Comfy domain, desktop bridge, confirmation, redaction, scan, typecheck, and build tests.

**Commit:** `feat: add dynamic capability routing`

---

### Task 9: Unified Reverse Agent, conversation workbench, Skills, and quality loop

**Requirements:** Implement the dedicated right-dock `反推 / Reverse` conversation workbench opened from the unified node. Bind durable conversation state to project/node revision, ordered managed references, Skill/version, approved knowledge snapshot, project-memory ids, prompt-library source, route, and run identity. Use field order route, compatibility mode, Skill/version, prompt source, `角色 / Role`, `任务需求 / Task Requirements`, managed references, structured preview; support managed `@image` and `@video-range` mentions, progress stages, field-level follow-up diffs, and current-run-only replace/continue. Implement Scene Keyword, Poster/KV, Line-art Material & Color, Product Commercial, Composition & Camera, Material & Lighting, Ecommerce Detail, and Effects Skills with structured evidence/citations/confidence, full effects taxonomy, line-art region/material/control constraints, and poster/KV recommendations.

Every run gets new identity, nonce, input fingerprint, knowledge version, Skill version, and frozen route. Returned reverse results carry that exact nonce. Parser and orchestration reject a mismatch in nonce, run identity, input fingerprint, knowledge version, Skill version, or route. Mark earlier output stale on a new run; set `suspected_stale_output` and block materialization when changed inputs return identical normalized keywords; allow same-input reruns. Route mixed media only to fully compatible profiles or show a composite plan. Require confirmation before paid work or materializing prompt, poster/KV, storyboard, generation, edit, compare, or local-redraw nodes. Add structured brief fields, KEEP/CHANGE/NEVER, estimated bounded spending, scored review, compare/targeted redraw, and local approved-failure learning candidates.

**Verification:** Image-only, video-only, mixed-media, ordered-reference, `video_analysis` migration, capability mismatch/composite-plan, stale/fresh, late-result, nonce mismatch, same-input rerun, Skill/version, knowledge-citation, confirmation, quality-loop, durability, redaction, renderer, and E2E tests.

**Commit:** `feat: add unified reverse agent workbench`

---

### Task 10: Long-video Reverse Agent orchestration and storyboard materialization

**Requirements:** Implement long-video chunking/timeline aggregation for the unified Reverse Agent with video revision/range binding, partial success, segment retry, replacement invalidation, cancellation, stale-result isolation, and confirmed storyboard/prompt/shot-node materialization. It is not a separate user-visible video-analysis module.

**Verification:** Chunk aggregation, partial failure, cancellation/retry, stale result, materialization, and E2E workflows.

**Commit:** `feat: add long-video reverse orchestration`

---

### Task 11: Per-run growth candidates and cross-device approval

**Requirements:** Capture nonblocking sanitized run goals, knowledge versions, routes, output summaries, accepted edits, reruns, deletions, failures, corrections, prevention rules, and evidence. Sync only user-approved sanitized knowledge; never sync raw images/videos, history, or private conversation/prompt text. Retain rejected, conflicted, and offline work until authoritative acceptance.

**Verification:** Reverse and quality-loop candidate integration, approval/rejection, offline restart, duplicate/conflict, dual-device HTTP, and security-scan tests.

**Commit:** `feat: grow reverse knowledge across devices`

---

### Task 12: Prompt library and user-owned prompt import

**Requirements:** Build an original editable common-prompt library for generation and Reverse Agent workflows. Include the approved capability-equivalent template families with stable ids/versions, Chinese-primary metadata, compatible capabilities/models, parameter fields, previewed diffs, and user/project scopes. Support apply, duplicate, edit, favorite, organize, approve into project knowledge, and validated user-owned/exported JSON, CSV, and text import. Never bundle proprietary prompt text; imports and applications never spend until confirmation.

**Verification:** Domain/import validation, copyright-boundary, migration, renderer diff/confirmation, project-scope, redaction, and E2E tests.

**Commit:** `feat: add original prompt library`

---

### Task 13: Standard Photoshop 2019+ image-result handoff

**Requirements:** Add `在 Photoshop 中打开 / Open in Photoshop` for managed PNG/JPEG/WebP results. Pass opaque asset IDs only; desktop-core validates and exports confined temporary/project copies, detects standard registered installations where available, validates a user-selected compatible executable, launches via a narrow bridge, and tracks copies as disposable cache. Do not inspect licensing, bypass activation, modify executables, or implement crack-specific behavior. Layered PSD/document exchange remains outside this task.

**Verification:** Missing/multiple installs, cancellation, invalid executable/path, launch failure, temporary-copy cleanup, original protection, and renderer-path-leakage tests.

**Commit:** `feat: add Photoshop result handoff`

---

### Task 14: Music and speech capability modules

**Requirements:** Implement the explicit music-generation, speech-synthesis, and speech/audio-analysis module execution adapters promised by the dynamic capability contracts. Use compatible public providers, route only compatible profiles, confirm cost and job count, freeze execution snapshots, surface safe cancellation/retry/error states, and retain sanitized durable results. No private reference endpoints, credentials, or model IDs enter code or renderer data.

**Verification:** Capability routing, confirmation, execution/error/cancel/retry, snapshot/redaction, provider-contract, and E2E tests.

**Commit:** `feat: add music and speech capability modules`

---

### Task 15: Full acceptance, documentation, and whole-branch review

**Requirements:** Run full Vitest, typecheck, build, Playwright, scans, and diff check. Capture light/dark evidence at 1366x768, 1440x900, and 1920x1080 for empty canvas, catalog, history, storage, unified image generation, Reverse Agent workbench, long-video timeline, prompt library, Photoshop action, music/speech states, and 300/500 stress. Inspect intended nonempty views, ports, overlap, placeholder art, and desktop quality. Record Figma and physical Windows/user acceptance as external gates unless evidence exists. Obtain independent whole-branch review and resolve Critical/Important findings. Do not package.

**Verification:** `npm test`; `npm run typecheck`; `npm run build`; `npm run e2e`; `npm run scan:e2e`; `git diff --check`.

**Commit:** `test: verify formal Novus Atelier workflows`
