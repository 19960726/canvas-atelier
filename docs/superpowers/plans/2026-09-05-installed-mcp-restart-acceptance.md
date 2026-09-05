# Installed MCP Restart Acceptance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove every bundled MCP tool works in the installed application and prove MCP-created workflow state survives an exact-process shutdown and restart inside one isolated QA root.

**Architecture:** The runner uses two sequential hidden Electron lifecycles sharing one redirected `APPDATA`, `LOCALAPPDATA`, and QA user-data root. It closes the first MCP client, destroys hidden windows, exits Electron, verifies all first-lifecycle PIDs stopped, removes only the isolated stale runtime descriptor, launches a second lifecycle, connects a fresh bundled MCP client, and verifies persisted nodes, edge, imported managed media, revision, and prior deletion. After the read-only restart proof it stops the second lifecycle and removes the QA-owned isolation root; it does not add a redundant post-restart graph mutation that can be affected by the deliberately forced no-dialog shutdown semantics.

**Tech Stack:** Node.js test runner, Playwright Electron, MCP TypeScript SDK, installed Canvas Atelier desktop bridge, PowerShell verification.

## Global Constraints

- Use `E:\画布项目\staging-canvas-build`.
- Use `apply_patch` for edits.
- Do not package, install, access external networks, or touch real projects/user configuration.
- Preserve `CANVASFORGE_*` internal protocol compatibility names.
- Never call `app.close()`; destroy hidden windows, call `app.exit(0)`, wait, and terminate only captured QA PIDs if needed.
- The installed gate must exercise all 14 MCP tools and report exact invocation counts.

---

### Task 1: Restart Evidence Contract

**Files:**
- Modify: `work/qa-installed-mcp-zero-cost-full-chain-lib.mjs`
- Test: `work/qa-installed-mcp-zero-cost-full-chain.test.mjs`

**Interfaces:**
- Consumes: first and second public workflow snapshots plus expected node, edge, media, and deleted-node identities.
- Produces: `assertRestartPersistenceEvidence(beforeRestart, afterRestart, expected)` returning revision and persisted identity evidence.

- [x] **Step 1: Write the failing test**

Add a fixture whose second snapshot preserves the first snapshot revision, prompt node, generation nodes, edge, and imported `image_input` asset while omitting the already deleted selection node. Assert failures for revision or asset drift.

- [x] **Step 2: Run test to verify it fails**

Run: `node --test work/qa-installed-mcp-zero-cost-full-chain.test.mjs`

Expected: FAIL because `assertRestartPersistenceEvidence` is not exported.

- [x] **Step 3: Write minimal implementation**

Validate exact revision equality, required node module/config identities, edge endpoints/ports, imported media `assetId`, and absence of the deleted node; return a bounded evidence object.

- [x] **Step 4: Run test to verify it passes**

Run: `node --test work/qa-installed-mcp-zero-cost-full-chain.test.mjs`

Expected: all tests PASS.

### Task 2: Two-Lifecycle Installed Runner

**Files:**
- Modify: `work/qa-installed-mcp-zero-cost-full-chain.mjs`
- Test: `work/qa-installed-mcp-zero-cost-full-chain.test.mjs`

**Interfaces:**
- Consumes: `assertRestartPersistenceEvidence`, the shared isolated environment, and exact first/second lifecycle PIDs.
- Produces: `checks.restartPersistence`, `isolation.firstLifecycle`, `isolation.secondLifecycle`, aggregate all-tool counts, and verified cleanup evidence.

- [x] **Step 1: Write the failing static safety test**

Require two `electron.launch` lifecycles, two fresh MCP transports, an isolated runtime-descriptor removal, a second `canvas_read_workflow`, and exact first/second PID cleanup without `app.close()`.

- [x] **Step 2: Run test to verify it fails**

Run: `node --test work/qa-installed-mcp-zero-cost-full-chain.test.mjs`

Expected: FAIL because the runner has only one lifecycle.

- [x] **Step 3: Implement the lifecycle helpers and restart gate**

Add helpers that wrap tool counting, close a client with timeout, destroy all hidden windows plus `app.exit(0)`, and verify/terminate only captured PIDs. Before restart remove only `runtime-modern-v1.json` below the isolated root, launch with the same environment, reconnect the installed bridge, read and validate persistence, then stop the second lifecycle and remove the entire QA-owned isolation root.

- [x] **Step 4: Run deterministic verification**

Run:

```powershell
node --test work/qa-installed-mcp-zero-cost-full-chain.test.mjs
node --check work/qa-installed-mcp-zero-cost-full-chain.mjs
$env:CANVASFORGE_QA_EXPECTED_VERSION='1.6.99'
node work/qa-installed-mcp-zero-cost-full-chain.mjs 'D:\CanvasAtelier\Canvas Atelier.exe'
```

Expected: unit tests PASS; installed report status is `passed`; 14/14 call counts are nonzero; both lifecycle PID groups are stopped; isolation root is removed.

### Task 3: Evidence Documentation

**Files:**
- Create: `work/qa-installed-mcp-zero-cost-full-chain.md`
- Modify: `docs/project-memory.md`

**Interfaces:**
- Consumes: final unit/source/installed command outputs.
- Produces: truthful acceptance scope, exact counts, PIDs, isolation cleanup, and explicit no-network/no-real-project boundaries.

- [x] **Step 1: Run related source tests**

Run the MCP adapter/domain/desktop bridge test files discovered from package scripts, then run all `work/qa-installed-mcp-zero-cost-full-chain*.test.mjs` tests.

- [x] **Step 2: Record exact evidence**

Document only observed pass/fail output, including selection confirmation/apply, provider completion/cancel, trusted picker import, restart persistence, and exact process cleanup.

- [x] **Step 3: Validate the patch**

Run: `git diff --check -- work/qa-installed-mcp-zero-cost-full-chain.mjs work/qa-installed-mcp-zero-cost-full-chain-lib.mjs work/qa-installed-mcp-zero-cost-full-chain.test.mjs work/qa-installed-mcp-zero-cost-full-chain.md docs/project-memory.md docs/superpowers/plans/2026-09-05-installed-mcp-restart-acceptance.md`

Expected: exit code 0.
