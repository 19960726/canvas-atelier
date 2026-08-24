# Generation History Workbench Reliability Design

## Goal

Remove the discovered duplicate-action and stale-result risks from Generation History, eliminate the ReactFlow render-time warning, and restore the broken API/layout contract tests without changing user-facing scope.

## Scope

1. Reuse parameters must be single-flight per selected record. While its safe summary and canvas node creation are in progress, repeat activation must not create another node. A completed reuse may be started again only through a new explicit action.
2. A pending history pagination response must not append records after filters, sorting, or drawer bridge identity have changed.
3. Canvas selection synchronization must not call workspace React state setters during a ReactFlow render. Selection remains available to viewport culling.
4. The preload API contract includes `provider.checkConnection`; visual layout expects the current 264px workbench node width.

## Design

- Keep action state local to `GenerationHistoryDrawer`. Use a `reuseStatus` state (`idle` / `preparing` / `prepared`) and disable the Reuse Parameters button while `preparing`. Reset the status when another record becomes selected. The existing generated operation ID remains the durable idempotency boundary for one invocation.
- Maintain a monotonically increasing request generation ref in the History drawer. Each initial list effect increments it; `loadMore` captures it with its cursor. Append and pagination metadata update only when the generation still matches. This preserves the existing cancellation flag while covering user changes during pagination.
- Extract stable selection handling in `CanvasWorkspace`, compare ids before scheduling updates, and defer state synchronization out of ReactFlow's render callback. Preserve selected ids and edges for viewport culling; do not alter the durable project, undo stack, or viewport.
- Add focused renderer/app-store tests for duplicate reuse prevention and stale pagination rejection. Update only the two known contract expectations.

## Acceptance

- A delayed double activation of Reuse Parameters invokes the callback once and creates one configured image-generation node.
- A delayed page-two response after a filter change cannot add its old records to the new result set.
- The focused stress/selection test completes without the render-time setState warning.
- Preload contract and all three visual layout cases pass with intentional 264px width.
- Typecheck, relevant Vitest/E2E, scan, build, and diff checks are rerun before handoff.

## Non-goals

- No history feature expansion, visual redesign, protocol broadening, paid provider request, packaging, portable, or installer work.
- No change to persisted history schema or operation-id format.
