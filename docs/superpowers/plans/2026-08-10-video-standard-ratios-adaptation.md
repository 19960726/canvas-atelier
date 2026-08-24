# Video Standard Ratios And Provider Adaptation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make video generation always display the same eight standard ratios as image generation while preserving provider-safe nearest-ratio adaptation and confirmation before paid submission.

**Architecture:** The renderer owns a stable standard ratio catalog independent of provider capability metadata. The existing domain parameter adapter remains the single compatibility boundary and maps unsupported selections to the nearest provider-supported ratio, returning `requires_confirmation` so the existing confirmation flow can show requested and actual values.

**Tech Stack:** TypeScript, React, Zustand, Vitest, Testing Library, Playwright.

## Global Constraints

- Video ratio options are always `AUTO`, `1:1`, `2:3`, `3:2`, `3:4`, `4:3`, `9:16`, `16:9`.
- Provider capability metadata must not hide standard video ratio choices.
- Unsupported requested ratios must be adapted by `adaptGenerationParameters` and must not be submitted silently.
- Automated tests must not submit a paid provider task.
- Preserve all unrelated dirty-worktree changes.

---

### Task 1: Stable Video Ratio Catalog

**Files:**
- Modify: `apps/renderer/src/canvas/ModuleNodeCard.test.tsx`
- Modify: `apps/renderer/src/canvas/ModuleNodeCard.tsx`
- Test: `apps/renderer/src/canvas/ModuleNodeCard.test.tsx`

**Interfaces:**
- Consumes: `VIDEO_ASPECT_RATIO_OPTIONS` and provider `constraints.video.aspectRatios`.
- Produces: `videoAspectRatioOptions` containing all eight standard UI choices.

- [ ] Change the constrained-model test to expect all eight video ratios.
- [ ] Run the focused test and verify it fails because only provider ratios are rendered.
- [ ] Make `videoAspectRatioOptions` independent of provider filtering.
- [ ] Run `ModuleNodeCard.test.tsx` and verify all tests pass.

### Task 2: Adaptation And Visual Acceptance

**Files:**
- Verify: `packages/domain/src/model-parameter-adapter.test.ts`
- Modify: `tests/e2e/generation-parameter-adaptation.spec.ts`
- Test: `packages/domain/src/model-parameter-adapter.test.ts`
- Test: `tests/e2e/generation-parameter-adaptation.spec.ts`

**Interfaces:**
- Consumes: `adaptGenerationParameters(target, constraints)`.
- Produces: `requires_confirmation` with requested-to-actual ratio adjustment text when the selected video model lacks the requested ratio.

- [ ] Assert the browser video ratio menu contains all eight standard options.
- [ ] Verify the existing domain adapter maps an unsupported video ratio to the nearest supported ratio with `requires_confirmation`.
- [ ] Run renderer, domain, and browser regression tests.
- [ ] Capture and visually inspect the refreshed dark-theme video ratio screenshot.