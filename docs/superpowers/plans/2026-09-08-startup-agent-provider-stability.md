# Canvas Atelier Startup, Agent, and Provider Stability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship one formal 1.6.114 build that opens the current canvas promptly, bounds recovery mirrors, prevents false Agent timeouts and duplicate retries, improves Codex MCP errors, and revalidates provider/media/save flows.

**Architecture:** Adopt recent projects before recovery scanning and reuse the existing guarded background refresh. Keep recovery choices intact while pruning only verified derived scan sessions. Give provider chat an inner abort deadline shorter than the Renderer watchdog, and update failed requests in place on an identical retry.

**Tech Stack:** Electron 43, React, TypeScript, Vitest, Playwright, electron-builder/NSIS.

## Global Constraints

- Preserve every unrelated dirty-worktree change and every real user project/asset/provider file.
- Do not submit paid provider work without separate authorization.
- Test the failing cause before each production edit.
- Source, packaged, installed, and live-provider evidence remain separate.
- Install only to `D:\CanvasAtelier\Canvas Atelier` and keep one formal installed version.

---

### Task 1: Non-blocking startup recovery

**Files:**
- Modify: `apps/renderer/src/app/desktop-persistence.test.ts`
- Modify: `apps/renderer/src/app/desktop-persistence.ts`

- [ ] Add a regression whose recent-project `getRecoveryPlan()` never settles and whose `hydrate()` must still return the selected project within 100 ms.
- [ ] Run the test and record that the current synchronous adoption times out.
- [ ] Pass `{ deferRecoveryRefresh: true }` only for normal recent-project startup adoption; keep unresolved orphan recovery synchronous.
- [ ] Rerun the focused persistence suite.

### Task 2: Bounded derived recovery mirrors

**Files:**
- Modify: `packages/desktop-core/src/recovery-scanner.test.ts`
- Modify: `packages/desktop-core/src/recovery-scanner.ts`

- [ ] Add regressions that four successful scans retain at most three verified sessions, keep current candidates restorable, preserve unknown/malformed directories, and ignore cleanup failure.
- [ ] Run the tests and record the unbounded-session failure.
- [ ] After a successful non-empty scan, rank verified same-project sessions, retain three, and best-effort remove older confined non-link directories.
- [ ] Rerun RecoveryScanner and bridge recovery suites.

### Task 3: Agent timeout and retry identity

**Files:**
- Modify: `packages/desktop-core/src/provider-skill-chat.test.ts`
- Modify: `packages/desktop-core/src/provider-skill-chat.ts`
- Modify: `apps/renderer/src/agent/SkillChatWorkbench.test.tsx`
- Modify: `apps/renderer/src/agent/SkillChatWorkbench.tsx`

- [ ] Assert ordinary chat receives 180000 ms at the provider client and Renderer remains sending until 194999 ms.
- [ ] Assert an identical retry after failure leaves one user bubble and sends one copy of that user turn; edited retry creates a new bubble.
- [ ] Run and record the old 30000 ms/duplicate-message failures.
- [ ] Add 180000 ms inner and 195000 ms outer deadlines and reuse the last failed message when request identity matches.
- [ ] Rerun Agent, Comfly, RelayMe and provider skill-chat suites.

### Task 4: Actionable Codex MCP failures

**Files:**
- Modify: `packages/desktop-core/src/codex-cli-service.test.ts`
- Modify: `packages/desktop-core/src/codex-cli-service.ts`
- Modify only if required by a failing UI test: `apps/renderer/src/agent/SkillChatWorkbench.tsx`

- [ ] Add event-exit and runner-rejection cases containing private MCP diagnostics; assert `CODEX_CLI_MCP_FAILED` and no private text.
- [ ] Run and record the current generic-code failure.
- [ ] Route runner errors through the existing sanitizer and map explicit MCP startup/connect/handshake/tool transport patterns.
- [ ] Rerun Codex service, IPC and Agent error suites.

### Task 5: Existing clipboard, delete, save and provider gates

**Files:**
- Modify production files only if a current regression fails.
- Update: `docs/project-memory.md`

- [ ] Run focused current suites for `CanvasWorkspace`, `ModuleNodeCard`, `SkillChatWorkbench`, app store, desktop persistence, bridge handlers, Comfly and RelayMe.
- [ ] Run zero-cost provider capability and MCP image/video/reverse gates.
- [ ] Verify native image copy, 25-file paste, cancellation, individual/batch deletion, explicit save, close and reopen on isolated copies.
- [ ] Record any live credential or paid-call boundary separately.

### Task 6: Formal 1.6.114 release

**Files:**
- Modify: `apps/desktop-modern/package.json`
- Modify: `package-lock.json`
- Modify: current version contract tests.
- Produce: `apps/desktop-modern/dist-builder/desktop-modern-1.6.114-formal-20260908/CanvasAtelier-Win10-11-x64-1.6.114.exe`

- [ ] Run full Vitest, typecheck, build, Playwright, secret scan and `git diff --check`.
- [ ] Advance version contracts to 1.6.114 only after source gates pass, then rebuild and package.
- [ ] Record installer, EXE and app.asar size/SHA-256/version, then install over `D:\CanvasAtelier\Canvas Atelier`.
- [ ] Rerun installed startup timing and Task 5 gates against the exact installed fingerprint.
- [ ] Update project memory with root cause, protected behavior, tests, installed evidence and remaining external blockers.
