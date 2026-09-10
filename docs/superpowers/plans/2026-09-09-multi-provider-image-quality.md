# Canvas Atelier Multi-provider Image Quality Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development while implementing independent packages, and keep every task test-first.

**Goal:** Complete the existing image-return and stale-reconfiguration repair, add an explicit GPT image quality control, connect Julun as a video-only New API provider, connect 4D AI for supported image generation and reverse analysis, and redesign provider settings so each site keeps separate credentials and model catalogs.

**Architecture:** Keep project ownership as the source of truth for generation jobs. Replace the single active-provider assumption with provider-scoped configuration and routing. Reuse the typed provider bridge, secure credential vault, durable task ledger, managed-media resolver, and result materialization boundary. Add an OpenAI-compatible New API transport whose endpoint family is explicit per model capability; never infer a runnable image endpoint from a model name alone. Seed public catalogs from the providers' read-only pricing metadata and replace or enrich them after an authenticated `/v1/models` refresh.

**Tech Stack:** Electron 43, React, TypeScript, Zod, Vitest, Playwright, electron-builder/NSIS.

## Global Constraints

- Preserve every unrelated dirty-worktree change, untracked artifact, user project, credential, and generated asset. Do not reset, clean, delete, or overwrite them.
- Do not submit paid or live generation requests without explicit authorization. Connection checks, public catalogs, and controlled zero-cost fixtures remain separate evidence.
- Add or update a failing regression before every production change.
- Treat source, build, package, installed application, provider configuration, and live provider output as separate acceptance layers.

### Task 1: GPT image quality and stale-job identity

**Files:**
- Modify: `packages/domain/src/model-job.test.ts`
- Modify: `packages/domain/src/model-job.ts`
- Modify: `packages/desktop-core/src/provider-bridge.test.ts`
- Modify: `packages/desktop-core/src/provider-contracts.ts`
- Modify: `packages/desktop-core/src/relayme-provider-service.test.ts`
- Modify: `packages/desktop-core/src/relayme-provider-service.ts`
- Modify: `apps/renderer/src/jobs/desktop-model-executor.test.ts`
- Modify: `apps/renderer/src/jobs/desktop-model-executor.ts`
- Modify: `apps/renderer/src/jobs/project-model-jobs.test.ts`
- Modify: `apps/renderer/src/jobs/project-model-jobs.ts`
- Modify: `apps/renderer/src/app/app-store.test.ts`
- Modify: `apps/renderer/src/app/app-store.ts`

- [x] Prove that `low | medium | high` was dropped across draft, durable job, IPC, executor, and provider mapping.
- [x] Persist quality in the job and node draft, forward it through the strict bridge, and include it in failed-job identity.
- [x] Keep the control GPT-only and default a GPT image request to `medium` when the draft has no explicit quality.
- [x] Add OpenAI image-size regressions for every supported aspect ratio and tier; map GPT Image 2 requests to exact pixel dimensions that satisfy the official edge, multiple-of-16, ratio, and pixel-count constraints.

### Task 2: GPT-specific node control and visual acceptance

**Files:**
- Modify: `apps/renderer/src/canvas/ModuleNodeCard.test.tsx`
- Modify: `apps/renderer/src/canvas/ModuleNodeCard.tsx`
- Add: `apps/renderer/src/app/image-generation-quality.ts`
- Modify: `apps/renderer/src/styles/release-layout-contract.css`
- Modify: `tests/e2e/image-generation-execution.spec.ts`

- [x] Add a failing component regression for the GPT-only `低 / 中 / 高` selector and the submitted `high` value.
- [x] Render the quality selector beside model, ratio, resolution, count, and generate controls only for GPT Image routes.
- [x] Add an E2E draft/save/restart assertion and capture the final GPT Image interface from the packaged app.

### Task 3: Provider identities and per-site configuration

**Files:**
- Modify: `packages/desktop-core/src/provider-contracts.test.ts`
- Modify: `packages/desktop-core/src/provider-contracts.ts`
- Modify: `packages/desktop-core/src/provider-credential-vault.test.ts`
- Modify: `packages/desktop-core/src/provider-credential-vault.ts`
- Modify: `packages/desktop-core/src/provider-configuration-store.test.ts`
- Modify: `packages/desktop-core/src/provider-configuration-store.ts`
- Modify: `packages/desktop-core/src/provider-registry.test.ts`
- Modify: `packages/desktop-core/src/provider-registry.ts`
- Modify: `apps/desktop-modern/src/main.ts`

- [x] Add RED contracts for `julun` and `4dai`, including provider-scoped base URL, credentials, status, model profiles, and simultaneous readiness.
- [x] Store each provider independently and route every job by `job.provider`; remove the global active-provider gate.
- [x] Keep existing Comfly and RelayMe encrypted data compatible across restart and token rotation.

### Task 4: Reusable New API transport and catalog parser

**Files:**
- Add: `packages/desktop-core/src/newapi-provider-client.test.ts`
- Add: `packages/desktop-core/src/newapi-provider-client.ts`
- Add: `packages/desktop-core/src/newapi-model-catalog.test.ts`
- Add: `packages/desktop-core/src/newapi-model-catalog.ts`
- Modify: `packages/desktop-core/src/electron-net-fetch.ts`

- [x] Add fixture tests for `/api/pricing`, authenticated `/v1/models`, strict endpoint-family metadata, duplicates, malformed responses, private hosts, timeouts, and sanitized errors.
- [x] Implement GET-only discovery plus explicit OpenAI image, chat/reverse, and Sora/OpenAI-video request helpers.
- [x] Mark a profile runnable only when its capability and endpoint family are both proven; keep name-derived candidates visible as incomplete.

### Task 5: Julun video-only provider

**Files:**
- Add: `packages/desktop-core/src/julun-provider-service.test.ts`
- Add: `packages/desktop-core/src/julun-provider-service.ts`
- Modify: `packages/desktop-core/src/provider-bridge.ts`
- Modify: `packages/desktop-core/src/provider-registry.ts`

- [x] Seed the current public Julun video catalog and assert every exposed route has only video capabilities.
- [x] Submit with `POST /v1/videos`, poll with `GET /v1/videos/{id}`, and materialize content through `GET /v1/videos/{id}/content` using the existing managed-video boundary.
- [x] Reject image, reverse, chat, and storyboard operations before transport for this provider.

### Task 6: 4D AI image and reverse provider

**Files:**
- Add: `packages/desktop-core/src/fourdai-provider-service.test.ts`
- Add: `packages/desktop-core/src/fourdai-provider-service.ts`
- Modify: `packages/desktop-core/src/provider-model-catalog.ts`
- Modify: `packages/desktop-core/src/provider-registry.ts`

- [x] Seed public 4D models with their declared endpoint families and add authenticated enrichment tests.
- [x] Run only models explicitly declaring `image-generation` through `/v1/images/generations`; keep GPT Image 2 aliases, Gemini, and Grok incomplete until the configured catalog proves their transport.
- [x] Route image-capable chat models through the managed-media reverse-analysis request and strict reverse response parser.
- [x] Preserve managed media, exact GPT quality, requested size, result-byte confinement, and sanitized provider task identities.

### Task 7: Provider settings redesign

**Files:**
- Modify: `apps/renderer/src/settings/SettingsDrawer.test.tsx`
- Modify: `apps/renderer/src/settings/SettingsDrawer.tsx`
- Modify: `apps/renderer/src/styles/release-layout-contract.css`
- Modify: `apps/renderer/src/app/App.test.tsx`
- Modify: `apps/renderer/src/app/App.tsx`

- [x] Add RED tests for four independent cards: Comfly, RelayMe, Julun API, and 4D AI.
- [x] Show each site's purpose, base URL, credential state, connection check, model refresh, discovered counts, and capability badges without displaying secrets.
- [x] Allow Julun video and 4D image/reverse routes to be selected in the same project and survive app restart.
- [x] Clearly label incomplete catalog entries and prevent selection until a verified endpoint is available.

### Task 8: Existing Canvas regressions

**Files:**
- Modify: `apps/renderer/src/test-mode/e2e-harness.test.ts`
- Modify: `apps/renderer/src/test-mode/e2e-harness.ts`
- Modify: `tests/e2e/connection-snap.spec.ts`
- Modify: `tests/e2e/module-library-workflow.spec.ts`
- Modify: `apps/renderer/src/canvas/CanvasWorkspace.test.tsx`
- Modify: `apps/renderer/src/canvas/CanvasWorkspace.tsx`

- [x] Add fixture ownership regressions and include the active project ID in generated-result E2E jobs so the harness mirrors production.
- [x] Add a React Flow internals-ready marker backed by initialized node and handle internals, and wait for it before connection drags.
- [x] Keep the 48-screen-pixel connection radius and verify all four `±32` directions at normal and changed zoom, plus 20 repeated exact-handle drags.

### Task 9: Full release acceptance

**Files:**
- Modify version files only after source gates pass.
- Update: `docs/project-memory.md`
- Produce a new formal installer under `apps/desktop-modern/dist-builder/`.

- [x] Run all targeted provider, renderer, project-job, and E2E suites; then full Vitest, typecheck, build, Playwright, `git diff --check`, and secret scan.
- [x] Package and install the exact build, fingerprint the executable and `app.asar`, and rerun save/restart/image/video/reverse/MCP/result/connection/exit gates against that fingerprint.
- [x] Record public-catalog evidence, configured-provider evidence, and live-generation evidence separately; leave paid live generation unverified unless the user explicitly authorizes it.
