# Agent 节点与视频直传反推 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a configurable Agent node that runs real, compatible multimodal reverse analysis over managed images and original MP4 video.

**Architecture:** The domain owns serializable node/run configuration and validation. The renderer persists node drafts through an explicit action and scopes its knowledge lease. Desktop-core exposes a capability-gated provider reverse-analysis call; the Comfly adapter encodes managed media as provider input. Canvas UI consumes these contracts without mutating viewport or node position.

**Tech Stack:** TypeScript, React, React Flow, Zod, Vitest, Playwright, Electron preload IPC.

## Global Constraints

- Work only in `E:\画布项目\.worktrees\canvas-agent-mvp` on `feature/canvas-agent-mvp`.
- Use tests before production changes; no paid provider calls in verification.
- Do not copy third-party brands, icons, assets, or code.
- Never submit uncontrolled local file paths or URLs; video must be a managed MP4 asset.

---

### Task 1: Domain node/run contracts

**Files:** `packages/domain/src/reverse-prompt-agent.ts`, its tests, `packages/domain/src/project-schema.ts`, canvas node tests.

- [ ] Add failing tests for exact-two distinct knowledge IDs, required role/task/model route, and a managed MP4 input snapshot.
- [ ] Run the focused tests and observe validation failures.
- [ ] Add Zod-backed config/run fields and validation, preserving old project migration defaults.
- [ ] Re-run focused tests until green.

### Task 2: Scoped knowledge leases and provider reverse-analysis bridge

**Files:** `apps/renderer/src/app/knowledge-client.ts`, tests; desktop provider contracts/preload/bridge tests; `packages/provider-comfly/src/client.ts`, tests.

- [ ] Add failing tests proving lease selection is exactly the requested ready bases and that a video-capable route receives only managed MP4 media.
- [ ] Run focused tests and observe the missing API/behavior.
- [ ] Implement scoped lease API, IPC request/response schemas, capability selection and media-safe request mapping.
- [ ] Re-run focused tests until green.

### Task 3: Agent node configuration and execution

**Files:** `apps/renderer/src/canvas/ModuleNodeCard.tsx`, node types/workspace/store, `ReversePromptAgent.tsx`, and focused tests.

- [ ] Add failing tests for draft-only edits, explicit apply persistence, node-selected execution, and all blocked reasons.
- [ ] Run focused tests and observe failure.
- [ ] Implement node-local drafts, route/knowledge selectors, selected-node-only Agent execution, run snapshot persistence and error states.
- [ ] Re-run focused tests until green.

### Task 4: Node visual cleanup and reliability repairs

**Files:** canvas CSS/components, `GenerationHistoryDrawer.tsx`, settings/history tests, bridge-contract test, visual layout test.

- [ ] Add failing tests for reuse single-flight, pagination request generations, connection contract and 264px node width.
- [ ] Implement minimal reliability fixes and compact image-first/form Agent UI without altering drag/viewport state.
- [ ] Run affected tests until green.

### Task 5: End-to-end verification and visual QA

**Files:** E2E specs and ignored progress/review reports only when findings require them.

- [ ] Add/adjust E2E coverage for a video-to-Agent configuration and blocked validation path.
- [ ] Run focused Vitest, npm test permission A/B, typecheck, build, scan:e2e, Playwright and diff checks.
- [ ] Capture 1366x768, 1440x900 and 1920x1080 light/dark screenshots for empty canvas, Agent, Settings and History; check ports, media, focus, overlap and viewport stability.
