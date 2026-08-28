# Executor Follow-up Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the canvas manager opaque, remove unusable/duplicate Comfly profiles, and expose actionable RelayMe image-generation errors.

**Architecture:** Keep the existing renderer/provider boundaries. The canvas manager receives an explicit theme surface; catalog normalization filters invalid entries before profile construction; RelayMe translates provider failures at the desktop-core boundary into existing structured bridge errors.

**Tech Stack:** React, TypeScript, CSS, Vitest, Playwright.

## Global Constraints

- Preserve all existing dirty and untracked worktree changes.
- Do not expose credentials, provider tokens, filesystem paths, or raw task ids in UI errors.
- Do not commit or push changes unless explicitly requested.

### Task 1: Opaque Canvas Manager

**Files:** Modify `apps/renderer/src/styles/figma-hybrid-canvas.css`; Test `apps/renderer/src/styles/release-layout-contract.test.ts`.

- [ ] Add a failing CSS contract asserting `.canvas-manager` uses `var(--gate-panel-surface)` and that both light and dark themes define it as an opaque color.
- [ ] Run the focused contract test and observe failure if the token is missing or transparent.
- [ ] Define opaque light/dark `--gate-panel-surface` tokens and retain the existing manager border/shadow geometry.
- [ ] Run the focused test and verify it passes.

### Task 2: Comfly Catalog Filtering

**Files:** Modify `packages/desktop-core/src/provider-model-catalog.ts`; Test `packages/desktop-core/src/provider-model-catalog.test.ts`.

- [ ] Add failing cases for blank keys, blank display names, incomplete entries, and duplicate model keys.
- [ ] Run the focused provider-model-catalog test and verify the new cases fail.
- [ ] Filter invalid/incomplete Comfly entries before schema parsing and deduplicate by normalized model key while retaining the first valid route.
- [ ] Run the focused test and verify existing capability mapping remains unchanged.

### Task 3: RelayMe Image Error Mapping

**Files:** Modify `packages/desktop-core/src/relayme-provider-service.ts`; Test `packages/desktop-core/src/relayme-provider-service.test.ts`.

- [ ] Add failing cases for quota/rate-limit, unsupported-model, authentication, timeout, and network failures during image submission.
- [ ] Run the focused service test and verify the new cases fail.
- [ ] Extend `translateRelayMeError` with stable structured codes/messages: `CREDENTIALS_LOCKED` for authentication expiry, `CAPABILITY_UNSUPPORTED` for model/feature rejection, retryable `PROVIDER_ERROR` for quota/rate-limit/network/timeout, and non-retryable `PROVIDER_ERROR` for other provider failures.
- [ ] Run service tests and typecheck.

### Task 4: Integration Verification

- [ ] Run the focused renderer and desktop-core Vitest suites.
- [ ] Run TypeScript typecheck.
- [ ] Run image-generation and multi-provider Playwright specs.
- [ ] Record pass/fail evidence and remaining external-network risks in the handoff.
