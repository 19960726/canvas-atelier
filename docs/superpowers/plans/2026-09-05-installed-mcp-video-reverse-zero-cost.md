# Installed MCP Video and Reverse Zero-Cost Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an independent, offline installed-app MCP acceptance runner that proves `video_generation` and `reverse_agent` complete through `canvas_run_node` and persist their results.

**Architecture:** A new runner launches the installed app in a fresh QA-owned profile, installs strict provider IPC handlers in that isolated Electron main process, and drives only public bundled MCP tools plus the real confirmation UI. A focused library validates provider-ledger, job, persistence, network, and cleanup evidence without changing the existing 14-tool/restart gate.

**Tech Stack:** Node.js test runner, Playwright Electron, MCP TypeScript SDK, installed Canvas Atelier bundled bridge, Vitest source regressions.

## Global Constraints

- Work only in `E:\画布项目\staging-canvas-build`.
- Add new `video-reverse` gate files; do not edit `work/qa-installed-mcp-zero-cost-full-chain*`.
- Use `apply_patch` for edits and strict red-green TDD.
- Use installed version 1.6.99 for qualification; root task reruns against 1.6.100.
- Disable network and require exactly zero attempts.
- Do not package, install, make paid calls, configure clients, or touch real user data.
- Never call `app.close()`; destroy hidden windows, call `app.exit(0)`, stop exact captured PIDs, then remove only the isolated QA root.

---

### Task 1: Evidence assertion library

**Files:**
- Create: `work/qa-installed-mcp-video-reverse-zero-cost-lib.mjs`
- Test: `work/qa-installed-mcp-video-reverse-zero-cost.test.mjs`

**Interfaces:**
- Consumes: executor ledger, MCP confirmation/job snapshots, workflow nodes, and isolation cleanup fields.
- Produces: `assertVideoExecutionEvidence`, `assertReverseExecutionEvidence`, `assertOfflineCleanupEvidence`, and bounded evidence objects.

- [x] **Step 1: Write failing tests for exact video and reverse evidence**

Tests require one exact video submit/poll/completed ACK with persisted `videoResults`, one exact reverse request/result with persisted `reverseAgentRunId` and result identity, zero network attempts, and stopped/removed cleanup flags.

- [x] **Step 2: Verify RED**

Run: `node --test work/qa-installed-mcp-video-reverse-zero-cost.test.mjs`

Expected: failure because the new assertion module does not exist.

- [x] **Step 3: Implement minimal bounded assertions**

Reject duplicate requests, wrong provider/route/task IDs, result identity drift, absent confirmation stages, absent terminal job reads, nonzero network count, or incomplete cleanup.

- [x] **Step 4: Verify GREEN**

Run the same command and require every test to pass.

### Task 2: Installed two-branch runner

**Files:**
- Create: `work/qa-installed-mcp-video-reverse-zero-cost.mjs`
- Modify: `work/qa-installed-mcp-video-reverse-zero-cost.test.mjs`

**Interfaces:**
- Consumes: installed executable, `CANVASFORGE_QA_EXPECTED_VERSION`, bundled MCP bridge, and Task 1 assertions.
- Produces: one JSON report containing video, reverse, provider-ledger, network, process, and isolated-root evidence.

- [x] **Step 1: Add failing runner safety tests**

Require video submit/poll/cancel/ACK handlers, reverse analyze handler, trusted `filechooser`, three-phase confirmation for both nodes, MCP job-status reads, no `app.close()`, exact PID ownership, and isolated-root cleanup.

- [x] **Step 2: Verify RED**

Run the target node test and require failure because the runner is absent.

- [x] **Step 3: Implement isolated launch and QA executor**

Create strict video and reverse profiles, record every IPC request, reject all unapproved identities, override `fetch`, and expose only copied evidence to the runner.

- [x] **Step 4: Implement the public MCP flows**

Create and execute video, import one managed image, create and execute reverse, perform the two UI confirmations, read both terminal job states and both persisted node results, then apply the assertion library.

- [x] **Step 5: Implement dialog-free exact cleanup**

Close MCP, stop bridge, destroy hidden windows, call `app.exit(0)`, wait/terminate only captured PIDs, remove the isolated root, and fail the report if any cleanup field is incomplete.

- [x] **Step 6: Verify runner contracts**

Run the target node tests and `node --check` for runner and library.

### Task 3: Installed qualification and report

**Files:**
- Create: `work/qa-installed-mcp-video-reverse-zero-cost.md`
- Modify: `docs/project-memory.md`

**Interfaces:**
- Consumes: final unit/source/installed outputs.
- Produces: exact 1.6.99 qualification evidence and explicit 1.6.100 rerun boundary.

- [x] **Step 1: Run related source regressions**

Run MCP adapter/App, job store/executor, reverse domain, provider contract/preload, and runtime lifecycle tests.

- [x] **Step 2: Run installed qualification**

```powershell
$env:CANVASFORGE_QA_EXPECTED_VERSION='1.6.99'
node work/qa-installed-mcp-video-reverse-zero-cost.mjs 'D:\CanvasAtelier\Canvas Atelier.exe'
```

Require exit 0, both branches completed, zero network attempts, exact captured PIDs stopped, and isolated root removed.

- [x] **Step 3: Record exact evidence and boundaries**

Write observed IDs/counts/results only. State that this is a controlled provider fixture, not a live paid-generation result, and that 1.6.100 must rerun the same gate.

- [x] **Step 4: Validate target files**

Run target tests, syntax checks, whitespace checks, and `git diff --check` for tracked documentation.
