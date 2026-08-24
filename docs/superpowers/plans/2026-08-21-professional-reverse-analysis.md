# Professional Reverse Analysis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Return production-grade single-image, multi-reference, and video reverse analysis with effect, fluid, lighting, camera, and white-background product adaptation.

**Architecture:** Define one structured domain contract with legacy summary compatibility. Build a provider-independent instruction document from media mode and a fixed professional persona; render the structured sections in the existing reverse result UI without requiring separate UI-specific prompts.

**Tech Stack:** TypeScript, Zod, Electron provider bridge, React, Vitest.

## Global Constraints

- Do not make paid live provider calls in tests.
- Preserve legacy `analysis`, `keywords`, `positivePrompt`, `negativeConstraints`, and `executionChecklist` fields.
- Treat focal length and hidden construction as estimates with confidence/uncertainty.
- User role text is additive and numeric-only input cannot replace the professional persona.

---

### Task 1: Define the professional result schema

**Files:**
- Modify: `packages/domain/src/reverse-prompt-agent.ts`
- Modify: `packages/domain/src/reverse-prompt-agent.test.ts`

**Interfaces:**
- Produces: expanded `ReversePromptResult` and `normalizeReverseRolePreference(role: string): string | undefined`.

- [ ] **Step 1: Add failing schema tests**

Test a complete single-image result, multi-source responsibilities, effect/fluid/light entries, white-background adaptation, and a video timeline shot. Test that numeric-only role input normalizes to `undefined`.

- [ ] **Step 2: Run tests and verify failure**

Run: `npm.cmd exec vitest -- --config vitest.config.ts packages/domain/src/reverse-prompt-agent.test.ts --run`

- [ ] **Step 3: Add strict nested Zod schemas**

Add named schemas for responsibilities, scene, camera, depth, material, lighting, effects, fluids, white-background adaptation, placement, video shots, bilingual prompts, and uncertainties. Keep existing summary fields required and make mode-specific arrays structurally validated.

- [ ] **Step 4: Run domain tests**

Run the Task 1 command and expect all tests to pass.

### Task 2: Build provider-independent professional instructions

**Files:**
- Create: `packages/desktop-core/src/professional-reverse-analysis.ts`
- Create: `packages/desktop-core/src/professional-reverse-analysis.test.ts`
- Modify: `packages/desktop-core/src/provider-bridge.ts`
- Modify: `packages/desktop-core/src/provider-bridge.test.ts`

**Interfaces:**
- Produces: `buildProfessionalReverseRequest(run, knowledge): ProfessionalReverseRequest`.
- Consumes: expanded `ReversePromptResult` schema and ordered media.

- [ ] **Step 1: Add failing request tests**

Assert single-image instructions contain spatial layout, proportions, depth, texture, focal length, perspective, effects, fluids, light sweep, and white-background adaptation. Assert multi-image instructions require per-source responsibility/inheritance/conflict. Assert video instructions require timecoded shots, camera movement, speed curves, transitions, sweep light, effects, and product adaptation.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `npm.cmd exec vitest -- --config vitest.config.ts packages/desktop-core/src/professional-reverse-analysis.test.ts packages/desktop-core/src/provider-bridge.test.ts --run`

- [ ] **Step 3: Implement the request builder**

Always prepend a fixed senior commercial visual-director/VFX-supervisor persona. Include sanitized user role as `userPreference`. Select `single_image`, `multi_reference`, or `video` from ordered media. Declare every required JSON section and minimum evidence expectations.

- [ ] **Step 4: Integrate both provider paths**

Use the same built request for Gemini native and vision chat. Strengthen the system message so it requires evidence-grounded production analysis and valid JSON, not merely generic JSON.

- [ ] **Step 5: Run focused tests**

Run the Task 2 command and expect all tests to pass.

### Task 3: Render structured results without losing legacy output

**Files:**
- Modify: `apps/renderer/src/agent/ReversePromptAgent.tsx`
- Modify: `apps/renderer/src/agent/ReversePromptAgent.test.tsx`
- Modify: `apps/renderer/src/canvas/ModuleNodeCard.tsx`
- Modify: `apps/renderer/src/canvas/ModuleNodeCard.test.tsx`

**Interfaces:**
- Consumes: expanded `ReversePromptResult`.
- Produces: sectioned reverse-result presentation and copyable bilingual prompts.

- [ ] **Step 1: Add failing UI tests**

Render a professional result and assert visible sections for source responsibilities, scene/camera, materials, effects/fluids, lighting, white-background adaptation, video timeline, Chinese prompt, English prompt, negative constraints, and checklist.

- [ ] **Step 2: Run UI tests and verify failure**

Run: `npm.cmd exec vitest -- --config vitest.config.ts apps/renderer/src/agent/ReversePromptAgent.test.tsx apps/renderer/src/canvas/ModuleNodeCard.test.tsx --run`

- [ ] **Step 3: Implement sectioned rendering**

Render compact headings and lists, retain the existing summary block, and omit an empty video timeline for image-only results. Provide independent copy controls for Chinese and English prompts.

- [ ] **Step 4: Run UI tests**

Run the Task 3 command and expect all tests to pass.
