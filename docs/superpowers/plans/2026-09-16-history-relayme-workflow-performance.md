# History, RelayMe, Workflow, and Canvas Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver fast history previews, complete capability-driven RelayMe node routing, lean focused Agent workflows, model-specific clarity selection, and measured canvas performance improvements.

**Architecture:** Add a confined derived-preview protocol backed by an injected desktop thumbnail encoder, while keeping originals authoritative. Normalize provider capabilities and image parameters at shared boundaries, then make Agent workflow creation return focus metadata and avoid redundant nodes. Preserve local drafts and latest-only persistence paths so the React Flow surface does not update on every intermediate input.

**Tech Stack:** TypeScript, React 19, Zustand 5, React Flow 12, Electron 43 `nativeImage`, Vitest 3, Playwright 1.61.

## 2026-09-16 Implementation Checkpoint

- Implemented a startup-warmed desktop history index plus renderer first-page preload; the final installed R2 measured 0.8 ms for a 30-record warm list and 14.9 ms to render 30 cards on the first animation frame.
- Implemented derived JPEG previews, lazy card media, explicit failure states, exact capability routing, lean Agent workflows, model-adjacent clarity selection, Comfly parameter preservation, and provider-independent image color correction.
- Replaced per-component media reorder persistence with optimistic exact permutations through the shared autosave controller. Packaged QA performed 38 rapid moves across 20 slots, produced one autosave commit, and restored the exact final order after reopen.
- Added observable startup/loading, pending, saving, saved, read-only, conflict, and retry states while retaining explicit Save as a stable-point action.
- Changed managed image import to return after asset plus journal acknowledgement and run the consolidated snapshot in session maintenance; installed upload-to-preview measured 53 ms while close coordination still waits for snapshot completion.
- Installed canvas wheel-zoom sampled 90 frames at 16.8 ms P95 with no frame above 34 ms. The final 2x2 result view, mention dismissal, color correction, comparison, save/reopen, and direct MCP generation gates passed without external network access.
- Automated provider verification remains fixture/read-only. Live paid RelayMe, Comfly, and 4D generation is a separate authorization and acceptance gate.

## Completion Matrix

- [x] Derived history preview protocol and confinement.
- [x] Progressive 30-record history UI and first-page preload.
- [x] Capability-driven RelayMe/Comfly/4D routing fixtures and unsupported-state handling.
- [x] Lean Agent workflow, model-adjacent clarity, and workflow focus.
- [x] Canvas typing, zoom, media-slot reorder, and shared autosave performance.
- [x] Cross-provider parameter and sanitized-failure integrity.
- [x] Full source tests, production build, R2 packaging, independent installation, installed QA, and artifact fingerprinting.
- [ ] Live paid provider generation and Photoshop COM write remain explicit external acceptance gates and were not represented as completed by fixtures.

## Global Constraints

- Preserve the dirty worktree, including `apps/desktop-modern/dist-builder/desktop-modern/latest.yml` and every untracked `work/` artifact.
- Do not send a paid provider request during automated verification.
- Do not claim live RelayMe generation without a user-authorized live request and returned media.
- Keep history originals authoritative and confined beneath the application-owned history root.
- Follow TDD for each task and update `docs/project-memory.md` after fresh verification.

---

### Task 1: Derived History Preview Protocol

**Files:**
- Modify: `packages/desktop-core/src/generation-history-asset-url.ts`
- Modify: `packages/desktop-core/src/generation-history-store.ts`
- Modify: `packages/desktop-core/src/bridge-handlers.ts`
- Modify: `apps/desktop-modern/src/main.ts`
- Modify: `apps/desktop-legacy/src/main.ts`
- Test: `packages/desktop-core/src/generation-history-asset-url.test.ts`
- Test: `packages/desktop-core/src/generation-history-store.test.ts`
- Test: `packages/desktop-core/src/generation-history-bridge.test.ts`

**Interfaces:**
- Produces: `createGenerationHistoryPreviewUrl(historyAssetId): string`.
- Produces: `GenerationHistoryStore.resolveAvailablePreviewPath(historyAssetId): Promise<string | null>`.
- Consumes: an optional store `createImagePreview(sourcePath, temporaryDestinationPath)` dependency injected by Electron shells.

- [ ] **Step 1: Write failing URL, confinement, no-original-hash, deduplication, and concurrency tests.**

```ts
expect(createGenerationHistoryPreviewUrl('history_asset_0123456789abcdef'))
  .toBe('novus-history://preview/history_asset_0123456789abcdef');
await Promise.all([store.resolveAvailablePreviewPath(id), store.resolveAvailablePreviewPath(id)]);
expect(createImagePreview).toHaveBeenCalledOnce();
expect(hashFile).not.toHaveBeenCalled();
```

- [ ] **Step 2: Run the focused tests and confirm they fail for missing preview support.**

Run: `npm.cmd exec -- vitest run --config vitest.config.ts packages/desktop-core/src/generation-history-asset-url.test.ts packages/desktop-core/src/generation-history-store.test.ts packages/desktop-core/src/generation-history-bridge.test.ts`

Expected: preview URL/export and resolver assertions fail while existing original tests remain green.

- [ ] **Step 3: Implement confined, atomic, bounded preview creation.**

```ts
type CreateImagePreview = (sourcePath: string, temporaryDestinationPath: string) => Promise<void>;

async resolveAvailablePreviewPath(historyAssetId: string): Promise<string | null> {
  const source = await this.readPreviewSourceMetadata(historyAssetId);
  if (source === null) return null;
  return this.previewQueue.run(source.historyAssetId, () => this.ensurePreview(source));
}
```

- [ ] **Step 4: Inject `nativeImage` encoding in modern and legacy Electron shells and route `preview` separately from `asset`.**

```ts
const image = nativeImage.createFromPath(sourcePath);
if (image.isEmpty()) throw new Error('History preview source cannot be decoded');
const preview = image.resize({ width: 512, height: 512, quality: 'good' });
await writeFile(destinationPath, preview.toJPEG(78));
```

- [ ] **Step 5: Run focused tests and commit only after they pass.**

### Task 2: Progressive History UI

**Files:**
- Modify: `apps/renderer/src/history/GenerationHistoryDrawer.tsx`
- Modify: `apps/renderer/src/styles/app.css`
- Modify: `apps/renderer/src/styles/canvas-layout.css`
- Test: `apps/renderer/src/history/GenerationHistoryDrawer.test.tsx`
- Test: `apps/renderer/src/main.styles.test.ts`

**Interfaces:**
- Consumes: `createGenerationHistoryPreviewUrl` through the renderer-safe URL helper.
- Produces: preview cards with loading skeleton, lazy decoding, and explicit failure states.

- [ ] **Step 1: Add failing tests for preview URLs, `loading="lazy"`, `decoding="async"`, 30-record pages, skeletons, and original-only detail media.**
- [ ] **Step 2: Verify the focused renderer tests fail.**
- [ ] **Step 3: Split list preview media from detail original media and add stable loading/error states.**

```tsx
<img
  src={historyPreviewUrl(output.historyAssetId)}
  alt={alt}
  loading="lazy"
  decoding="async"
  onLoad={() => setLoaded(true)}
  onError={() => setFailed(true)}
/>
```

- [ ] **Step 4: Run drawer/style tests and verify existing filters, detail, export, and add-to-canvas remain green.**

### Task 3: RelayMe Capability Matrix for Provider-Backed Nodes

**Files:**
- Modify: `packages/provider-relayme/src/types.ts`
- Modify: `packages/provider-relayme/src/client.ts`
- Modify: `packages/desktop-core/src/provider-model-catalog.ts`
- Modify: `packages/desktop-core/src/relayme-provider-service.ts`
- Modify: `apps/renderer/src/app/provider-profiles.ts`
- Modify: `apps/renderer/src/canvas/ModuleNodeCard.tsx`
- Test: `packages/provider-relayme/src/client.test.ts`
- Test: `packages/desktop-core/src/provider-model-catalog.test.ts`
- Test: `packages/desktop-core/src/relayme-provider-service.test.ts`
- Test: `apps/renderer/src/app/provider-profiles.test.ts`
- Test: `apps/renderer/src/canvas/ModuleNodeCard.test.tsx`

**Interfaces:**
- Produces: exact RelayMe profiles whose capabilities and constraints reflect authenticated model/workflow evidence.
- Consumes: existing shared provider submit/poll/history contracts.

- [ ] **Step 1: Add a fixture matrix covering chat, image, reference image, video, task polling, result materialization, reverse image, and explicit unsupported video reverse.**
- [ ] **Step 2: Run the RelayMe-focused tests and record every missing route or dropped parameter.**
- [ ] **Step 3: Normalize RelayMe model/workflow offers into exact shared capabilities and constraints without name-only promotion.**
- [ ] **Step 4: Ensure image references are submitted only through a verified input contract and every terminal task is stored and recorded in history.**
- [ ] **Step 5: Run provider client/service/catalog and renderer route tests.**

### Task 4: Agent Clarity, Lean Workflow, and Focus

**Files:**
- Modify: `apps/renderer/src/agent/SkillChatWorkbench.tsx`
- Modify: `apps/renderer/src/app/app-store.ts`
- Modify: `apps/renderer/src/canvas/CanvasWorkspace.tsx`
- Modify: `apps/renderer/src/styles/agent-workbench.css`
- Test: `apps/renderer/src/agent/SkillChatWorkbench.test.tsx`
- Test: `apps/renderer/src/app/app-store.test.ts`
- Test: `apps/renderer/src/canvas/CanvasWorkspace.test.tsx`
- Test: `tests/e2e/agent-reference-workflow.spec.ts`

**Interfaces:**
- Changes: `executeCanvasAction` returns `{ started, generationNodeId, workflowNodeIds }` instead of a bare boolean.
- Changes: `ensureAgentGenerationNode` returns focus metadata and creates no prompt/result nodes.

- [ ] **Step 1: Add failing tests for model-adjacent clarity selection, default omission, exact tier persistence, lean workflow shape, and focus metadata.**
- [ ] **Step 2: Run the three focused suites and confirm the old three-node workflow assertions fail.**
- [ ] **Step 3: Implement shared clarity reconciliation and the two-control confirmation row.**
- [ ] **Step 4: Replace prompt/generation/result creation with reference/generation creation in one durable transaction.**
- [ ] **Step 5: Select and fit the returned workflow IDs only after the transaction succeeds; keep the Agent panel open.**
- [ ] **Step 6: Run focused unit tests and the Agent workflow Playwright case.**

### Task 5: Canvas Interaction Performance

**Files:**
- Modify only when profiling identifies a failing boundary in `apps/renderer/src/canvas/ModuleNodeCard.tsx`, `apps/renderer/src/canvas/CanvasWorkspace.tsx`, or `apps/renderer/src/app/app-store.ts`.
- Test: `apps/renderer/src/canvas/ModuleNodeCard.test.tsx`
- Test: `apps/renderer/src/canvas/latest-only-async-queue.test.ts`
- Test: `tests/integration/large-canvas.test.ts`
- Test: `packages/desktop-core/src/persistence-performance.test.ts`

**Interfaces:**
- Preserves current draft and persistence contracts.
- Produces measurements for typing, reorder bursts, one-transaction workflow creation, and persistence.

- [ ] **Step 1: Add deterministic render/commit-count tests around typing and reorder bursts.**
- [ ] **Step 2: Run them against the current code and identify the actual invalidation source.**
- [ ] **Step 3: Apply the smallest memoization or draft-boundary repair that makes the test pass.**
- [ ] **Step 4: Run `npm.cmd run perf:persistence` and the large-canvas suite explicitly.**

### Task 6: Cross-Provider Parameter and Failure Integrity

**Files:**
- Modify: `packages/desktop-core/src/comfly-image-submission.ts`
- Modify: shared provider/history error normalization files only where the red tests identify a gap.
- Test: `packages/desktop-core/src/comfly-capability-regression.test.ts`
- Test: `packages/desktop-core/src/provider-bridge.test.ts`
- Test: `apps/renderer/src/history/GenerationHistoryDrawer.test.tsx`

**Interfaces:**
- Produces exact endpoint selection for verified reference-image models.
- Produces omission of unverified generic clarity tiers and sanitized provider-specific failure categories.

- [ ] **Step 1: Add failing Flux reference-endpoint/default-clarity tests and history failure-category tests.**
- [ ] **Step 2: Route exact verified edit models to edits and omit unsupported resolution fields.**
- [ ] **Step 3: Preserve sanitized provider failure classification in history without tokens, task URLs, or raw bodies.**
- [ ] **Step 4: Run Comfly, shared bridge, and history tests.**

### Task 7: Full Verification, Memory, Packaging, and Installed QA

**Files:**
- Modify: `docs/project-memory.md`
- Modify: version/release metadata only after all source gates pass.
- Create: scoped QA reports beneath `work/`.

- [ ] **Step 1: Run focused suites for all changed files.**
- [ ] **Step 2: Run `npm.cmd test`, `npm.cmd run typecheck`, `npm.cmd run build`, and `git diff --check`.**
- [ ] **Step 3: Run targeted Playwright history, Agent workflow, image/video generation, provider catalog, save/restart, and large-canvas paths.**
- [ ] **Step 4: Update project memory with root causes, protected behavior, exact tests, and remaining live-provider limitations.**
- [ ] **Step 5: Bump the release version, build a fresh NSIS candidate, and fingerprint installer, unpacked executable, and `app.asar`.**
- [ ] **Step 6: Run installed-app QA in a new isolated installation/user-data root and report source, package, installed, and live-provider evidence separately.**
