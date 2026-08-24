# Codex MCP Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Settings panel section that lets WorkBuddy/Codex connect to CanvasForge, understand canvas node capabilities, and generate workflow plans safely.

**Architecture:** Domain exports a read-only workflow contract derived from `CANVAS_MODULE_DEFINITIONS`. Renderer Settings shows an MCP connection/status card, copyable MCP config, and permission toggles with safe defaults. The UI does not expose credentials and does not execute paid AI jobs directly.

**Tech Stack:** React, TypeScript, Vitest, Testing Library, CSS.

## Global Constraints

- Figma/user screenshot is the visual source for this Settings feature.
- Put this feature inside Settings, not inside canvas nodes or Agent chat.
- Do not expose API keys.
- Codex-generated workflows must be plans/transactions for user confirmation, not direct paid execution.
- External file writes and dangerous operations are disabled by default.

---

### Task 1: Domain workflow contract

**Files:**
- Create: `packages/domain/src/codex-workflow-contract.ts`
- Modify: `packages/domain/src/index.ts`
- Test: `packages/domain/src/codex-workflow-contract.test.ts`

**Interfaces:**
- Produces: `createCodexWorkflowContract(): CodexWorkflowContract`
- Produces: `DEFAULT_MCP_PERMISSION_FLAGS`

- [ ] Write failing tests that contract lists real canvas modules and strips unsafe data.
- [ ] Run the targeted domain test and verify failure.
- [ ] Implement the contract from existing module definitions.
- [ ] Export the contract from domain index.
- [ ] Run targeted domain test and verify pass.

### Task 2: Settings MCP UI

**Files:**
- Modify: `apps/renderer/src/settings/SettingsDrawer.tsx`
- Modify: `apps/renderer/src/settings/SettingsDrawer.test.tsx`
- Modify: `apps/renderer/src/styles/app.css`

**Interfaces:**
- Consumes: `createCodexWorkflowContract()`
- Shows: `MCP 联动` tab, status card, copy config button, permission switches.

- [ ] Write failing Settings tests for the new MCP tab, permission defaults, and copy config.
- [ ] Run the targeted Settings test and verify failure.
- [ ] Implement the tab and compact UI.
- [ ] Add CSS matching the screenshot style.
- [ ] Run targeted Settings test and verify pass.

### Task 3: Verification

**Files:**
- No production changes expected.

- [ ] Run domain + Settings tests.
- [ ] Run renderer TypeScript check.
- [ ] If dev server is available, capture a Settings screenshot for user review.
