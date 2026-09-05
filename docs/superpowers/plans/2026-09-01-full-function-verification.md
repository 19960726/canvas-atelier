# Full Function Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Verify every user-reported Canvas Atelier workflow in new and previously saved canvases, repair reproducible product defects, and withhold release while any required function is unverified or unavailable.

**Architecture:** Use three evidence layers: focused regression tests for causes, browser/Electron interaction tests for UI wiring and persistence, and isolated packaged-runtime checks against copied user data for real desktop/provider boundaries. Paid RelayMe requests are minimized by reusing completed managed assets first; unsupported provider capabilities are reported as blocked rather than simulated.

**Tech Stack:** TypeScript, React, Vitest, Playwright, Electron 43, electron-builder, Windows Photoshop COM/WSH bridge, RelayMe HTTP API, MCP stdio runtime.

**Spec:** `docs/project-memory.md` plus the user-reported requirements in the current task.

## Global Constraints

- Preserve every unrelated dirty-worktree change and untracked asset.
- Do not read, log, or embed the user's RelayMe password or saved token.
- Do not submit repeated paid generation jobs when an existing completed asset proves the same boundary.
- Do not publish, push, tag, or call the installer complete until every applicable gate has fresh evidence.
- Mark provider- or machine-blocked functions explicitly; never convert a clear failure into a pass.

---

### Task 1: Build the acceptance inventory

**Files:**
- Inspect: `tests/e2e/*.spec.ts`
- Inspect: `work/*.mjs`
- Modify: `docs/superpowers/plans/2026-09-01-full-function-verification.md`

**Interfaces:**
- Consumes: user-reported workflow list and existing regression inventory.
- Produces: one matrix mapping each function to a concrete command and expected evidence.

- [ ] **Step 1:** Map old/new canvas persistence, RelayMe session persistence, image/video generation, MP4 playback, media slots, clipboard actions, Photoshop, Agent mentions, and MCP coexistence to existing tests or a missing-test gap.
- [ ] **Step 2:** Record which checks are local, packaged, external-provider, or machine-dependent.
- [ ] **Step 3:** Refuse release if any required row is failed or untested.

### Task 2: Verify deterministic local behavior

**Files:**
- Test: `apps/renderer/src/**/*.test.ts*`
- Test: `packages/desktop-core/src/**/*.test.ts`
- Test: `apps/desktop-modern/src/**/*.test.ts`

**Interfaces:**
- Consumes: current dirty worktree.
- Produces: fresh focused and full-suite pass/fail counts.

- [ ] **Step 1:** Run focused suites for old-project route repair, credential migration, media slots, clipboard, Photoshop, Agent mentions, video asset playback, and MCP isolation.
- [ ] **Step 2:** Run the complete Vitest suite and record exact failures/skips.
- [ ] **Step 3:** Run typecheck/build and record exit status.

### Task 3: Verify browser UI workflows

**Files:**
- Test: `tests/e2e/*.spec.ts`
- Modify only if a workflow defect is reproduced.

**Interfaces:**
- Consumes: renderer build and the E2E harness.
- Produces: interaction evidence for generation, result actions, slots, mention references, project save/reopen, and settings flows.

- [ ] **Step 1:** Run the existing Playwright suite.
- [ ] **Step 2:** For any failed user workflow, add a focused regression that reproduces the symptom before production edits.
- [ ] **Step 3:** Re-run the focused test and then the full E2E suite.

### Task 4: Verify isolated packaged old-canvas behavior

**Files:**
- Run: `work/release-1.6.61-smoke.mjs`
- Run: `work/qa-real-saved-video-playback.mjs`
- Inspect/fix: `work/qa-real-old-project-relayme-generation.mjs`

**Interfaces:**
- Consumes: copied user data and the packaged executable.
- Produces: restart/reopen, real managed MP4 playback, and old-project provider-state evidence without modifying production data.

- [ ] **Step 1:** Package a fresh isolated candidate only after Tasks 2 and 3 pass.
- [ ] **Step 2:** Reopen a copied saved canvas twice and confirm its nodes, prompts, assets, and provider state persist.
- [ ] **Step 3:** Play an existing managed MP4 and prove `currentTime` advances with no media error.
- [ ] **Step 4:** Confirm RelayMe reference-image requests are blocked before submission when the catalog lacks image-edit capability.

### Task 5: Verify external and machine-dependent integrations

**Files:**
- Run/inspect: `packages/desktop-core/src/photoshop-windows-runner.js`
- Run/inspect: MCP runtime/config checks.
- Use sanitized RelayMe task/catalog inspection.

**Interfaces:**
- Consumes: current machine Photoshop and MCP client state, saved RelayMe session.
- Produces: truthful pass/fail/block status for Photoshop COM, provider capabilities, and MCP coexistence.

- [ ] **Step 1:** Test Photoshop connection and smart-object import only when an active PSD/PSB and compatible COM instance are available; otherwise record the exact blocker.
- [ ] **Step 2:** Confirm Canvas Atelier uses its own MCP config key/runtime file and preserves the other CanvasForge entry.
- [ ] **Step 3:** Verify saved RelayMe session can unlock after restart without exposing credentials.
- [ ] **Step 4:** Reuse completed RelayMe image/video tasks for download/playback; submit at most one fresh task per missing external boundary.

### Task 6: Final gate and release decision

**Files:**
- Modify: `docs/project-memory.md`
- Inspect: installer, blockmap, `latest.yml`, Git refs, and release assets only if release is authorized after all gates pass.

**Interfaces:**
- Consumes: every result from Tasks 1-5.
- Produces: a pass/fail/block table and a release/no-release decision.

- [ ] **Step 1:** Update durable project memory with each confirmed cause, regression location, and fresh command.
- [ ] **Step 2:** Run final full tests, build, packaging, packaged smoke, hash, and process-cleanup checks.
- [ ] **Step 3:** Do not publish while any required row remains failed or unverified.
- [ ] **Step 4:** If all required rows pass and the user has separately authorized publication, verify repository/branch/commit/remote/auth/assets/updater metadata before GitHub Release.
