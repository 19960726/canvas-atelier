# CanvasForge MCP Workflow Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provide a real bundled stdio MCP server that lets Codex and WorkBuddy describe, read, plan, confirm, edit, and run CanvasForge workflows through the current desktop instance with strict permissions and no secret/path leakage.

**Architecture:** Add a bundled `@agent-canvas/mcp-bridge` process using the stable `@modelcontextprotocol/sdk@1.30.0` stdio API. Each client starts its own bridge; the bridge discovers the active desktop instance through an app-owned runtime file and connects over a random Windows named pipe rather than a fixed TCP port. The desktop main process authenticates requests, forwards strict tool operations to the active renderer workspace adapter, and returns bounded structured results. Canvas mutations require a one-time workflow confirmation token; paid AI execution requires a second one-time confirmation.

**Tech Stack:** TypeScript, `@modelcontextprotocol/sdk@1.30.0`, Zod 3.25+, Node `net` named pipes, Electron IPC/contextBridge, React/Zustand, Vitest, Playwright.

## Global Constraints

- Tools are exactly: `canvas_describe_nodes`, `canvas_read_workflow`, `canvas_get_selection`, `canvas_get_job_status`, `canvas_plan_workflow`, `canvas_apply_workflow`, `canvas_create_node`, `canvas_update_node`, `canvas_connect_nodes`, `canvas_move_nodes`, `canvas_delete_selection`, `canvas_run_node`, `canvas_cancel_job`, `canvas_import_media`.
- No fixed TCP port and no dependency on legacy `D:\CanvasForge` paths.
- No API keys, authorization headers, absolute asset paths, base64 media, knowledge private content, arbitrary shell commands, arbitrary scripts, or arbitrary file reads in tool results.
- The desktop main process is the only canvas write authority.
- All writes use the current project version, existing durable transaction/undo path, and conflict detection.
- Workflow plans are previewed in CanvasForge and require one-time confirmation before mutation.
- Paid reverse/image/video jobs require separate one-time confirmation before execution.
- WorkBuddy/Codex config writes create timestamped backups and merge only the `canvasforge` entry.
- Settings show real server/client status and support Connect WorkBuddy, Connect Codex, Copy config, Test connection, Disconnect.
- Browser/manual acceptance shows desktop-only state rather than fake controls.

---

### Task 1: MCP schemas, tool catalog, and dependency boundary

**Files:**
- Create: `packages/domain/src/mcp-workflow.ts`
- Create: `packages/domain/src/mcp-workflow.test.ts`
- Modify: `packages/domain/src/codex-workflow-contract.ts`
- Modify: `packages/domain/src/codex-workflow-contract.test.ts`
- Modify: `packages/domain/src/index.ts`

**Interfaces:**
- Produces Zod schemas/types: `CanvasMcpToolName`, `CanvasWorkflowSnapshot`, `CanvasWorkflowPlan`, `CanvasWorkflowMutation`, `CanvasMcpRequest`, `CanvasMcpResponse`, `CanvasConfirmationGrant`.
- Produces `CANVAS_MCP_TOOL_DEFINITIONS` with exactly 14 entries.

- [ ] **Step 1: Write failing catalog/schema tests**

```ts
expect(CANVAS_MCP_TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual([
  'canvas_describe_nodes', 'canvas_read_workflow', 'canvas_get_selection',
  'canvas_get_job_status', 'canvas_plan_workflow', 'canvas_apply_workflow',
  'canvas_create_node', 'canvas_update_node', 'canvas_connect_nodes',
  'canvas_move_nodes', 'canvas_delete_selection', 'canvas_run_node',
  'canvas_cancel_job', 'canvas_import_media',
]);
expect(() => CanvasMcpResponseSchema.parse({ absolutePath: 'C:\\secret.png' })).toThrow();
```

Add tests rejecting unknown tools, unknown keys, base64-sized strings, absolute paths, and mutation requests without `expectedRevision`.

- [ ] **Step 2: Run and confirm failure**

Run: `npm.cmd test -- packages/domain/src/mcp-workflow.test.ts packages/domain/src/codex-workflow-contract.test.ts`

Expected: FAIL before schemas/catalog exist.

- [ ] **Step 3: Implement strict discriminated unions**

```ts
export const CanvasMcpRequestSchema = z.discriminatedUnion('tool', [
  CanvasDescribeNodesRequestSchema,
  CanvasReadWorkflowRequestSchema,
  CanvasGetSelectionRequestSchema,
  CanvasGetJobStatusRequestSchema,
  CanvasPlanWorkflowRequestSchema,
  CanvasApplyWorkflowRequestSchema,
  CanvasCreateNodeRequestSchema,
  CanvasUpdateNodeRequestSchema,
  CanvasConnectNodesRequestSchema,
  CanvasMoveNodesRequestSchema,
  CanvasDeleteSelectionRequestSchema,
  CanvasRunNodeRequestSchema,
  CanvasCancelJobRequestSchema,
  CanvasImportMediaRequestSchema,
]);
```

`CanvasWorkflowSnapshot` exposes node IDs/types, public config, ports, positions, selection, execution states, and managed result IDs only. Add `redactMcpValue(value)` that recursively rejects secret keys, absolute paths, data URLs/base64 payloads, and oversized strings before serialization.

- [ ] **Step 4: Verify and commit**

Run: `npm.cmd test -- packages/domain/src/mcp-workflow.test.ts packages/domain/src/codex-workflow-contract.test.ts`

Run: `npm.cmd run typecheck`

Expected: PASS.

```bash
git add packages/domain/src/mcp-workflow.ts packages/domain/src/mcp-workflow.test.ts packages/domain/src/codex-workflow-contract.ts packages/domain/src/codex-workflow-contract.test.ts packages/domain/src/index.ts
git commit -m "feat: define strict canvas mcp contracts"
```

### Task 2: Desktop runtime discovery and named-pipe broker

**Files:**
- Create: `packages/desktop-core/src/mcp-runtime-service.ts`
- Create: `packages/desktop-core/src/mcp-runtime-service.test.ts`
- Create: `packages/desktop-core/src/mcp-runtime-file.ts`
- Create: `packages/desktop-core/src/mcp-runtime-file.test.ts`
- Modify: `packages/desktop-core/src/contracts.ts`
- Modify: `packages/desktop-core/src/preload-api.ts`
- Modify: `packages/desktop-core/src/index.ts`
- Modify: `apps/desktop-modern/src/main.ts`
- Modify: `apps/desktop-modern/src/preload.ts`
- Modify: `apps/desktop-legacy/src/main.ts`
- Modify: `apps/desktop-legacy/src/preload.ts`

**Interfaces:**
- Runtime file: `%APPDATA%\CanvasForge\mcp\runtime-v1.json`.
- Pipe: `\\.\pipe\canvasforge-mcp-<instanceId>-<random>`.
- Runtime file fields: `protocol`, `instanceId`, `pipeName`, `authToken`, `serverVersion`, `startedAt`, `expiresAt`, `processId`.
- Preload API: `mcpRuntime.onRequest(listener)`, `mcpRuntime.respond(response)`, `mcpRuntime.getStatus()`.

- [ ] **Step 1: Write failing runtime-file tests**

Cover atomic write/rename, owner-only best-effort permissions, 15-minute token expiry/rotation, stale PID rejection, file deletion on clean shutdown, and no provider credentials in serialized JSON.

```ts
expect(parseMcpRuntimeFile(json)).toMatchObject({
  protocol: 'canvasforge.mcp.runtime.v1',
  pipeName: expect.stringMatching(/^\\\\\.\\pipe\\canvasforge-mcp-/),
});
```

- [ ] **Step 2: Write failing broker tests**

Cover valid authentication, invalid/expired token, malformed frames, >1 MiB frame rejection, request timeout, renderer disconnect, duplicate request ID, and clean server shutdown. Use newline-delimited JSON only inside the authenticated local pipe.

- [ ] **Step 3: Run and confirm failure**

Run: `npm.cmd test -- packages/desktop-core/src/mcp-runtime-file.test.ts packages/desktop-core/src/mcp-runtime-service.test.ts`

Expected: FAIL before the runtime service exists.

- [ ] **Step 4: Implement atomic runtime discovery**

```ts
export interface CanvasMcpRuntimeDescriptor {
  readonly protocol: 'canvasforge.mcp.runtime.v1';
  readonly instanceId: string;
  readonly pipeName: string;
  readonly authToken: string;
  readonly serverVersion: string;
  readonly startedAt: string;
  readonly expiresAt: string;
  readonly processId: number;
}
```

Rotate token and rewrite the descriptor before expiry. The token authenticates only the local pipe; it is never returned to renderer UI or MCP tool results.

- [ ] **Step 5: Implement main-to-renderer request forwarding**

The broker validates/authenticates the pipe envelope, then sends a fixed IPC event to the active renderer. Maintain `Map<requestId, pending>` with a 15-second timeout. Preload exposes only typed subscribe/respond methods; it exposes neither pipe names nor auth tokens.

- [ ] **Step 6: Wire lifecycle and verify**

Start after the desktop window is ready, mark status `waiting_for_canvas` until a renderer registers, rotate token on timer, and stop/delete descriptor during app shutdown.

Run: `npm.cmd test -- packages/desktop-core/src/mcp-runtime-file.test.ts packages/desktop-core/src/mcp-runtime-service.test.ts packages/desktop-core/src/bridge-contract.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/desktop-core/src/mcp-runtime-service.ts packages/desktop-core/src/mcp-runtime-service.test.ts packages/desktop-core/src/mcp-runtime-file.ts packages/desktop-core/src/mcp-runtime-file.test.ts packages/desktop-core/src/contracts.ts packages/desktop-core/src/preload-api.ts packages/desktop-core/src/index.ts apps/desktop-modern/src/main.ts apps/desktop-modern/src/preload.ts apps/desktop-legacy/src/main.ts apps/desktop-legacy/src/preload.ts
git commit -m "feat: expose authenticated canvas mcp runtime"
```

### Task 3: Bundled stdio MCP server

**Files:**
- Create: `packages/mcp-bridge/package.json`
- Create: `packages/mcp-bridge/tsconfig.json`
- Create: `packages/mcp-bridge/src/index.ts`
- Create: `packages/mcp-bridge/src/server.ts`
- Create: `packages/mcp-bridge/src/server.test.ts`
- Create: `packages/mcp-bridge/src/runtime-client.ts`
- Create: `packages/mcp-bridge/src/runtime-client.test.ts`
- Modify: `apps/desktop-modern/package.json`
- Modify: `apps/desktop-modern/electron-builder.yml`
- Modify: `apps/desktop-modern/scripts/copy-static.mjs`
- Modify: `apps/desktop-modern/src/runtime-entry-contract.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Entrypoint: packaged `resources/mcp/canvasforge-mcp.cjs` executed with the installed Electron binary in Node mode (`ELECTRON_RUN_AS_NODE=1`).
- SDK imports: `McpServer` from `@modelcontextprotocol/sdk/server/mcp.js`, `StdioServerTransport` from `@modelcontextprotocol/sdk/server/stdio.js`.
- `createCanvasForgeMcpServer(runtimeClient): McpServer` registers exactly the 14 tool definitions.

- [ ] **Step 1: Create the workspace package and install the pinned SDK**

Create `packages/mcp-bridge/package.json` with `name: "@agent-canvas/mcp-bridge"`, `type: "module"`, build/typecheck scripts, and workspace dependencies on `@agent-canvas/domain` plus `zod`. Then run:

Run: `npm.cmd install @modelcontextprotocol/sdk@1.30.0 -w @agent-canvas/mcp-bridge`

Expected: the bridge package manifest and root lockfile record exactly `1.30.0`.

- [ ] **Step 2: Write failing stdio protocol tests**

Use SDK client transport or in-memory transport to assert initialize, `tools/list`, each `tools/call`, structured error results, and shutdown. Assert stdout contains MCP JSON-RPC only; diagnostics go to stderr.

```ts
expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(
  CANVAS_MCP_TOOL_DEFINITIONS.map((tool) => tool.name),
);
```

- [ ] **Step 3: Write failing runtime client tests**

Cover missing descriptor (`waiting_for_canvas`), stale descriptor rediscovery, authentication failure, pipe reconnect, timeout, and exact request/response schema validation.

- [ ] **Step 4: Run and confirm failure**

Run: `npm.cmd test -- packages/mcp-bridge/src/server.test.ts packages/mcp-bridge/src/runtime-client.test.ts`

Expected: FAIL before the package exists.

- [ ] **Step 5: Implement the bridge**

```ts
const server = new McpServer(
  { name: 'canvasforge', version: SERVER_VERSION },
  { instructions: 'Describe and read the canvas before planning. Apply only confirmed plans. Paid jobs require a second confirmation.' },
);

for (const definition of CANVAS_MCP_TOOL_DEFINITIONS) {
  server.registerTool(definition.name, definition.sdkDefinition, async (input) =>
    toMcpToolResult(await runtimeClient.call({ tool: definition.name, ...input })));
}

await server.connect(new StdioServerTransport());
```

On `SIGINT`/`SIGTERM`, close the server and pipe client. Never log to stdout.

- [ ] **Step 6: Bundle and package**

Build the package to one CJS entry, copy it to packaged resources, and add a runtime contract test that launches it with a temporary missing runtime descriptor and receives a valid MCP tool error rather than a crash.

- [ ] **Step 7: Verify and commit**

Run: `npm.cmd test -- packages/mcp-bridge/src/server.test.ts packages/mcp-bridge/src/runtime-client.test.ts apps/desktop-modern/src/runtime-entry-contract.test.ts`

Run: `npm.cmd run typecheck`

Expected: PASS.

```bash
git add packages/mcp-bridge package.json package-lock.json apps/desktop-modern/package.json apps/desktop-modern/electron-builder.yml apps/desktop-modern/scripts/copy-static.mjs apps/desktop-modern/src/runtime-entry-contract.test.ts
git commit -m "feat: bundle canvasforge stdio mcp server"
```

### Task 4: Renderer workspace adapter, planning, and confirmation gates

**Files:**
- Create: `apps/renderer/src/app/mcp-workspace-adapter.ts`
- Create: `apps/renderer/src/app/mcp-workspace-adapter.test.ts`
- Create: `apps/renderer/src/app/mcp-confirmation-store.ts`
- Create: `apps/renderer/src/app/mcp-confirmation-store.test.ts`
- Modify: `apps/renderer/src/app/workspace-api.ts`
- Modify: `apps/renderer/src/app/workspace-api.test.ts`
- Modify: `apps/renderer/src/app/app-store.ts`
- Modify: `apps/renderer/src/app/app-store.test.ts`
- Modify: `apps/renderer/src/App.tsx`

**Interfaces:**
- Produces: `createMcpWorkspaceAdapter(store): { handle(request): Promise<CanvasMcpResponse> }`.
- One-time plan token TTL: 5 minutes, bound to `planId`, `projectId`, `expectedRevision`, and exact mutation hash.
- One-time paid-job token TTL: 2 minutes, bound to `nodeId`, `jobKind`, `modelRoute`, and estimated request hash.

- [ ] **Step 1: Write failing read-tool tests**

Assert `canvas_describe_nodes`, `canvas_read_workflow`, selection, and job status return current state without secrets/paths. Snapshot tests must include ports and current node definitions from the domain catalog.

- [ ] **Step 2: Write failing plan/confirmation tests**

```ts
const plan = await adapter.handle(planRequest);
expect(plan).toMatchObject({ ok: true, result: { confirmationRequired: true } });

await expect(adapter.handle(applyWithoutToken)).resolves.toMatchObject({
  ok: false,
  error: { code: 'CONFIRMATION_REQUIRED' },
});
```

Add cases for replayed token, expired token, different revision, modified mutations, incompatible ports, unknown modules, invalid cardinality, unconfirmed delete, and paid run without its second token.

- [ ] **Step 3: Run and confirm failure**

Run: `npm.cmd test -- apps/renderer/src/app/mcp-confirmation-store.test.ts apps/renderer/src/app/mcp-workspace-adapter.test.ts apps/renderer/src/app/workspace-api.test.ts`

Expected: FAIL before the adapter exists.

- [ ] **Step 4: Implement read and planning tools**

`canvas_plan_workflow` validates every proposed node/edge against `listCanvasModuleDefinitions()` and `module-graph` compatibility, returns a readable summary, exact mutations, limitations, paid-job list, and no write. Store the pending plan in renderer state for preview.

- [ ] **Step 5: Implement mutation tools through durable transactions**

Map create/update/connect/move/delete/apply operations to existing app-store transaction APIs. Require `expectedRevision`; reject with `PROJECT_REVISION_CONFLICT` if current revision changed. Add one undo entry per MCP tool call; `canvas_apply_workflow` is all-or-nothing.

- [ ] **Step 6: Implement execution/import gates**

`canvas_run_node` returns `PAID_CONFIRMATION_REQUIRED` with a bounded summary until a valid paid token is supplied. `canvas_import_media` returns `FILE_SELECTION_REQUIRED`; CanvasForge opens its own file picker and imports only user-selected files—MCP input never accepts a path.

- [ ] **Step 7: Register renderer request handling and verify**

Subscribe once in `App.tsx`, call the adapter, respond with the same request ID, and unsubscribe on unmount/session replacement.

Run: `npm.cmd test -- apps/renderer/src/app/mcp-confirmation-store.test.ts apps/renderer/src/app/mcp-workspace-adapter.test.ts apps/renderer/src/app/workspace-api.test.ts apps/renderer/src/app/app-store.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/renderer/src/app/mcp-workspace-adapter.ts apps/renderer/src/app/mcp-workspace-adapter.test.ts apps/renderer/src/app/mcp-confirmation-store.ts apps/renderer/src/app/mcp-confirmation-store.test.ts apps/renderer/src/app/workspace-api.ts apps/renderer/src/app/workspace-api.test.ts apps/renderer/src/app/app-store.ts apps/renderer/src/app/app-store.test.ts apps/renderer/src/App.tsx
git commit -m "feat: execute confirmed mcp canvas workflows"
```

### Task 5: Safe Codex and WorkBuddy configuration manager

**Files:**
- Create: `packages/desktop-core/src/mcp-client-config.ts`
- Create: `packages/desktop-core/src/mcp-client-config.test.ts`
- Modify: `packages/desktop-core/src/contracts.ts`
- Modify: `packages/desktop-core/src/preload-api.ts`
- Modify: `packages/desktop-core/src/index.ts`
- Modify: `apps/desktop-modern/src/main.ts`
- Modify: `apps/desktop-legacy/src/main.ts`

**Interfaces:**
- Produces methods: `getMcpIntegrationStatus`, `connectMcpClient`, `copyMcpClientConfig`, `testMcpClient`, `disconnectMcpClient`.
- Client ID: `'codex' | 'workbuddy'`.
- Backups: sibling files suffixed `.canvasforge-backup-YYYYMMDD-HHmmss`.

- [ ] **Step 1: Write failing WorkBuddy merge tests**

Load JSON containing connector proxy, Figma, and unrelated servers; update only `mcpServers.canvasforge`; verify all other objects/format-independent values survive. Test malformed JSON restores original and leaves a timestamped backup.

- [ ] **Step 2: Write failing Codex merge tests**

Use real TOML-shaped fixtures with comments and unrelated sections. Replace or append only the complete `[mcp_servers.canvasforge]` section and its `command`, `args`, and `env` keys. Detect duplicate canvasforge sections and refuse rather than corrupting the file. Preserve all bytes outside that section.

```toml
[mcp_servers.canvasforge]
command = "C:\\Program Files\\CanvasForge\\CanvasForge.exe"
args = ["resources\\mcp\\canvasforge-mcp.cjs"]
env = { ELECTRON_RUN_AS_NODE = "1" }
```

The actual command is derived from the running installed app path, never hardcoded to `D:\CanvasForge`.

- [ ] **Step 3: Run and confirm failure**

Run: `npm.cmd test -- packages/desktop-core/src/mcp-client-config.test.ts`

Expected: FAIL before the manager exists.

- [ ] **Step 4: Implement backup, merge, atomic replace, rollback**

For each client: resolve the known client config location, read current bytes, write timestamped backup, create merged temp file, parse/validate the merged entry, atomically replace, then run a health check. If validation/write/health check fails, restore backup and report the precise stage.

- [ ] **Step 5: Implement health check and disconnect**

Spawn the configured stdio command through SDK `StdioClientTransport`, call `tools/list` and `canvas_describe_nodes`, then close. Disconnect removes only the `canvasforge` entry/section after backup. Never remove other MCP servers.

- [ ] **Step 6: Verify and commit**

Run: `npm.cmd test -- packages/desktop-core/src/mcp-client-config.test.ts packages/mcp-bridge/src/server.test.ts`

Expected: PASS.

```bash
git add packages/desktop-core/src/mcp-client-config.ts packages/desktop-core/src/mcp-client-config.test.ts packages/desktop-core/src/contracts.ts packages/desktop-core/src/preload-api.ts packages/desktop-core/src/index.ts apps/desktop-modern/src/main.ts apps/desktop-legacy/src/main.ts
git commit -m "feat: configure codex and workbuddy mcp clients"
```

### Task 6: Real MCP settings status and workflow confirmation UI

**Files:**
- Modify: `apps/renderer/src/settings/SettingsDrawer.tsx`
- Modify: `apps/renderer/src/settings/SettingsDrawer.test.tsx`
- Create: `apps/renderer/src/agent/McpWorkflowPlanPreview.tsx`
- Create: `apps/renderer/src/agent/McpWorkflowPlanPreview.test.tsx`
- Modify: `apps/renderer/src/canvas/CanvasWorkspace.tsx`
- Modify: `apps/renderer/src/styles/figma-hybrid-canvas.css`
- Test: `tests/e2e/current-settings-ui.spec.ts`

**Interfaces:**
- Settings consumes real bridge status: server (`stopped | running | waiting_for_canvas | error`) and each client (`unconfigured | configured | connected | connection_failed`).
- Plan preview emits `confirmPlan(planId)`/`rejectPlan(planId)`; paid preview emits a separate `confirmPaidJob(requestId)`.

- [ ] **Step 1: Write failing Settings tests**

Assert real version/protocol/heartbeat/tool count, separate Codex/WorkBuddy rows, Connect/Copy/Test/Disconnect actions, busy states, actionable errors, and desktop-only browser state. Remove `createMcpConfig()` static workflow-description JSON.

- [ ] **Step 2: Write failing plan-preview tests**

Render node/edge/config summary, limitations, paid jobs, project revision, Confirm/Reject. Confirm creates a one-time token through the adapter; it does not mutate until the MCP client calls `canvas_apply_workflow` with that token.

- [ ] **Step 3: Run and confirm failure**

Run: `npm.cmd test -- apps/renderer/src/settings/SettingsDrawer.test.tsx apps/renderer/src/agent/McpWorkflowPlanPreview.test.tsx`

Expected: FAIL because current buttons/status are static and WorkBuddy connect has no handler.

- [ ] **Step 4: Implement live status/actions**

Poll/subscribe to bridge status while the MCP tab is visible. Connect previews exact server name/command and permission summary before writing. Copy uses the executable stdio config, not node-description JSON. Test connection reports initialization, tool count, and describe-node health.

- [ ] **Step 5: Implement plan and paid-job confirmation surfaces**

Show plan preview inside the current Agent/canvas visual language, not a new floating design. Reject clears the pending plan. Switching project invalidates all tokens. Paid confirmation lists provider/model/job kind but no credentials.

- [ ] **Step 6: Verify and commit**

Run: `npm.cmd test -- apps/renderer/src/settings/SettingsDrawer.test.tsx apps/renderer/src/agent/McpWorkflowPlanPreview.test.tsx apps/renderer/src/canvas/CanvasWorkspace.test.tsx`

Run: `npx.cmd playwright test tests/e2e/current-settings-ui.spec.ts --project=chromium`

Expected: PASS in light/dark themes.

```bash
git add apps/renderer/src/settings/SettingsDrawer.tsx apps/renderer/src/settings/SettingsDrawer.test.tsx apps/renderer/src/agent/McpWorkflowPlanPreview.tsx apps/renderer/src/agent/McpWorkflowPlanPreview.test.tsx apps/renderer/src/canvas/CanvasWorkspace.tsx apps/renderer/src/styles/figma-hybrid-canvas.css tests/e2e/current-settings-ui.spec.ts
git commit -m "feat: show live mcp integration and confirmations"
```

### Task 7: Protocol, security, transaction, and manual integration gate

**Files:**
- Create: `tests/integration/mcp-workflow-bridge.test.ts`
- Create: `tests/e2e/mcp-workflow-ui.spec.ts`
- Modify: `tests/e2e/helpers/secret-path-scan.mjs`
- Modify: `tests/integration/secret-path-scan.test.ts`
- Create: `docs/qa/canvasforge-mcp-acceptance.md`
- Create: `artifacts/2026-08-07-canvasforge-mcp-workflow-bridge/README.md`

**Interfaces:**
- Produces evidence bound to exact commit/build and both MCP clients.

- [ ] **Step 1: Add end-to-end protocol tests**

Start a temporary desktop runtime broker and stdio bridge; initialize; list tools; describe/read; plan; confirm; apply; undo; test conflict; request paid run; confirm paid run; cancel; disconnect. Assert all writes persist and every mutation is one undoable transaction.

- [ ] **Step 2: Add security tests**

Seed API keys, auth headers, absolute paths, base64 images, and knowledge private content in internal fixtures. Assert no MCP response, stdout/stderr log, runtime status, copied config, or screenshot contains them. Assert unknown tool, arbitrary path import, shell-shaped input, replayed tokens, and unconfirmed delete/run are rejected.

- [ ] **Step 3: Run automated gates**

Run: `npm.cmd run typecheck`

Run: `npm.cmd test -- packages/domain/src/mcp-workflow.test.ts packages/desktop-core/src/mcp-runtime-file.test.ts packages/desktop-core/src/mcp-runtime-service.test.ts packages/desktop-core/src/mcp-client-config.test.ts packages/mcp-bridge/src/server.test.ts packages/mcp-bridge/src/runtime-client.test.ts apps/renderer/src/app/mcp-workspace-adapter.test.ts apps/renderer/src/app/mcp-confirmation-store.test.ts tests/integration/mcp-workflow-bridge.test.ts`

Run: `npx.cmd playwright test tests/e2e/mcp-workflow-ui.spec.ts tests/e2e/current-settings-ui.spec.ts --project=chromium`

Run: `npm.cmd run scan:e2e`

Expected: new MCP tests PASS; if the repository's pre-existing secret-scan baseline still fails, record it separately and do not claim a green security gate.

- [ ] **Step 4: Build and perform manual Codex/WorkBuddy acceptance**

For each client:

1. Connect through Settings and inspect the timestamped backup.
2. Confirm unrelated MCP entries remain unchanged.
3. Send a workflow request from the client.
4. Observe `canvas_plan_workflow` preview in CanvasForge.
5. Confirm, apply, and verify correct nodes/ports/positions.
6. Request image/video/reverse execution and verify the separate paid confirmation.
7. Restart CanvasForge and verify runtime rediscovery without editing config.
8. Disconnect and verify only `canvasforge` is removed.

- [ ] **Step 5: Record evidence and commit**

Record exact commit/build, client versions, configuration before/after hashes, backup paths (redacted to basename), tool count, protocol transcript hashes, screenshots, test outputs, and remaining risks.

```bash
git add tests/integration/mcp-workflow-bridge.test.ts tests/e2e/mcp-workflow-ui.spec.ts tests/e2e/helpers/secret-path-scan.mjs tests/integration/secret-path-scan.test.ts docs/qa/canvasforge-mcp-acceptance.md artifacts/2026-08-07-canvasforge-mcp-workflow-bridge/README.md
git commit -m "test: gate canvasforge mcp workflow integration"
```