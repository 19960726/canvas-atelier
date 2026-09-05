# Installed MCP video and reverse zero-cost gate design

Date: 2026-09-05

## Objective

Add an independent installed-application acceptance gate for the two `canvas_run_node` branches not covered by the existing image-focused 14-tool gate: `video_generation` and `reverse_agent`. The qualification target is installed Canvas Atelier 1.6.99; the root release task will rerun the same gate against 1.6.100.

## Isolation boundary

The runner launches the installed executable with fresh redirected `APPDATA`, `LOCALAPPDATA`, and `CANVASFORGE_QA_USER_DATA_ROOT`. It grants MCP permissions only inside that profile, injects a zero-cost provider executor only at the isolated Electron main-process IPC boundary, replaces `fetch` with a counter that rejects every request, and never copies real projects, provider state, credentials, or MCP client configuration.

The runner uses only the public bundled MCP tools and real renderer/store paths for canvas creation, UI confirmation, execution, job observation, and result persistence. The QA executor may emulate provider replies, but it may not mutate renderer state or call renderer internals directly.

## Video branch

The executor advertises one Comfly profile with `video_generation` and `async_tasks`, complete constraints for `16:9`, `720p`, five seconds, one output, and audio disabled. It registers the real provider bridge channels for submit, poll, cancel, and terminal acknowledgement. Submit accepts exactly one known video request; poll returns a completed managed video asset; ACK accepts only the exact provider task and `completed` terminal.

MCP creates a configured `video_generation` node. `canvas_run_node` must follow the exact three-call confirmation protocol: initial blocked call, installed UI confirmation, identical retry returning an approval code, and final call with that code. The returned job ID is then read through `canvas_get_job_status` until `completed`; a workflow read must show the managed video result persisted on the same node. The executor ledger must show the expected provider, route, parameters, poll, ACK, and zero cancel requests for this completed branch.

## Reverse branch

The runner imports a 2x2 PNG through the installed trusted `filechooser` bridge into the isolated project, then creates a `reverse_agent` node whose `referenceAssetIds` cite the resulting managed asset. The executor advertises a separate Comfly profile with explicit `reverse_prompt` and `vision` capability and handles `novus-desktop:provider:analyze-reverse-prompt`.

The reverse handler validates that the request contains one managed PNG identity, an agent config bound to the exact QA route, and matching run/media identities. It returns a complete schema-valid result whose `sessionId`, `nonce`, `knowledgeSnapshotVersion`, and media responsibility match the incoming run.

MCP uses the same three-call confirmation protocol. Because reverse execution is not a model-job queue entry, the runner validates the returned `reverseAgentRunId` through `canvas_get_job_status`, requires terminal `completed`, and reads the node again to prove `reverseAgentRunState=completed` and the structured result persisted.

## Failure and cleanup behavior

Any contract mismatch, network attempt, missing confirmation phase, job identity drift, missing persisted result, or cleanup error makes the report `failed` and exits nonzero. Cleanup closes the MCP client, stops its bridge, destroys hidden BrowserWindows, calls `app.exit(0)`, stops only captured QA process IDs, and removes only the validated isolated root. It never calls `app.close()` and therefore never opens a native save/exit dialog.

## Deliverables and verification

- `work/qa-installed-mcp-video-reverse-zero-cost-lib.mjs`: bounded evidence assertions.
- `work/qa-installed-mcp-video-reverse-zero-cost.test.mjs`: unit and static safety contracts.
- `work/qa-installed-mcp-video-reverse-zero-cost.mjs`: installed runner.
- `work/qa-installed-mcp-video-reverse-zero-cost.md`: exact qualification report.

Qualification requires unit tests, syntax checks, related source tests, one installed 1.6.99 run, exact process/root cleanup evidence, and `networkAttemptCount=0`.

## Scope exclusions

No live RelayMe or Comfly request, no paid credits, no packaging or installation, no real Codex client configuration, no user-data migration, and no edits to the existing 14-tool/restart gate.
