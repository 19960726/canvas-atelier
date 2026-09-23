# GPT-Assisted Layering and PSD Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Analyze one managed image, obtain an editable layer plan, require explicit GPT-generation confirmation, create independent canvas layers and composite, and export a verified multi-layer PSD.

**Architecture:** Reuse the existing vision `chatSkill` bridge for analysis, the formal image-edit provider bridge and model-job queue for one GPT edit per layer, and the existing `ag-psd` encoder. New pure plan/quality modules separate untrusted model text and returned pixels from durable graph writes. One composite `image_layering` node owns the group; new `image_layer` nodes own each generated asset and provider job. UI work assumes `2026-09-23-canvas-ui-unification.md` has been completed first.

**Tech Stack:** React/TypeScript, Zod, Zustand, project transactions, Dexie model jobs, Electron bridge, Vitest, Playwright, ag-psd.

**Spec:** `docs/superpowers/specs/2026-09-23-gpt-assisted-image-layering-design.md`

## Global Constraints

- Read `AGENTS.md` and all `docs/project-memory.md`; protect the dirty source, real projects, credentials, and installed app.
- Analysis may use a configured vision route; layer generation uses only exact GPT Image `image_edit` routes. No speculative Comfly decomposition endpoint or non-GPT fallback.
- One background plus one to eight transparent foreground layers; layer generation requests are one per included layer, transparent output PNG/WebP only.
- The original managed source asset remains untouched. A complete PSD is available only after every included layer is valid; generated text/Logo stay pixel layers and are not advertised as exact reconstruction.
- Analyze and generate are two separate user actions. A changed source/route/size/plan invalidates confirmation. No automatic paid retry or re-submit on restart.
- Tests use zero-cost fixtures; a real GPT/Comfly alpha call requires a fresh explicit approval naming route, size, request count and likely charges.
- Source, candidate, isolated install, real provider and Photoshop are separate evidence rows. Target new installer version is 1.6.156; before version edits, verify that this number is still unused. Do not overwrite daily installation or release to GitHub.

## Review Focus

1. Malformed analysis text, prompt injection, no background, duplicate IDs, or nine foregrounds: fail closed before GPT job creation (Task 1–2).
2. Source/model/size/plan changes after confirmation or an interrupted app restart: never submit a stale or duplicate paid job (Task 3–4).
3. Provider returns JPEG, full-opacity, full-transparent or wrong-size foreground: retain bytes for diagnosis, block complete PSD and identify the layer (Task 5).
4. Foreign project with the same node/job identifiers or deleted source while polling: do not attach results to the open project (Task 4).
5. PSD layer names/order/alpha/visibility differ after reorder or project reopen: readback must match the canvas composite and state (Task 5–6).

## File Map and Interfaces

- `apps/renderer/src/app/layering-plan.ts`: pure `parseLayeringAnalysis` and confirmation identity; no provider or DOM dependency.
- `apps/renderer/src/app/layering-route-evidence.ts`: exact GPT transparent-edit route eligibility; initially fail-closed until documented or explicitly approved live evidence exists.
- `apps/renderer/src/app/layering-analysis.ts`: one bridge call using managed source ID and configured vision profile; returns validated plan.
- `packages/domain/src/canvas-module.ts`: new `image_layer` formal node with an image output; preserve existing `image_layering` input and add a multi-layer input.
- `packages/domain/src/model-job.ts`, `apps/renderer/src/jobs/job-store.ts`, `apps/renderer/src/jobs/desktop-model-executor.ts`: optional stable `layeringGroupId`/`layerId` ownership carried through persisted jobs; image-edit transport stays unchanged.
- `apps/renderer/src/app/layering-graph.ts`: pure deterministic node/edge transaction builder and completion update, imported by `app-store.ts`.
- `apps/renderer/src/app/layering-quality.ts`: decode/dimension/alpha checks, returning a per-layer verdict before complete export.
- `apps/renderer/src/canvas/LayeringDialog.tsx`: analyze → edit plan → fixed-snapshot confirmation UI.
- `apps/renderer/src/canvas/ModuleNodeCard.tsx`, `CanvasWorkspace.tsx`, `ImageLayeringWorkbench.tsx`, `styles/image-layering.css`: two compact image toolbar icons, layer/composite rendering, status and PSD export.
- Matching unit/integration/E2E tests; `docs/project-memory.md` records any repaired defect and verification.

---

### Task 1: Pure layer-plan contract and confirmation identity

**Files:** Create `apps/renderer/src/app/layering-plan.ts`, `apps/renderer/src/app/layering-plan.test.ts`.

**Interfaces:** `LayeringPlan = { sourceAssetId: string; canvasWidth: number; canvasHeight: number; layers: readonly LayeringPlanLayer[] }`; `LayeringPlanLayer = { layerId: string; kind: 'background' | 'transparent'; name: string; description: string; included: boolean }`; `parseLayeringAnalysis(message, sourceAssetId, width, height): LayeringPlan`; `confirmLayeringPlan(plan, provider, modelRoute, resolution, confirmedAt): Promise<LayeringConfirmation>`; `matchesLayeringConfirmation(confirmation, plan, provider, modelRoute, resolution): Promise<boolean>`. `LayeringConfirmation` stores a SHA-256 digest of source, ordered included layers, exact route and size, plus confirmation time.

- [ ] **Step 1: Write RED tests.** Pass a JSON reply with one background and two foregrounds; assert order and names. Reject a second background, duplicate layer ID, empty name, missing foreground, nine foregrounds, non-JSON, extraneous executable fields and a source-asset mismatch. Change any confirmed field and assert `matchesLayeringConfirmation` returns false.

```ts
expect(() => parseLayeringAnalysis('{"layers":[]}', 'asset-1', 1024, 1024)).toThrow();
const confirmation = await confirmLayeringPlan(plan, 'comfly', 'gpt-image-2', '2K', new Date().toISOString());
expect(await matchesLayeringConfirmation(confirmation, { ...plan, sourceAssetId: 'asset-2' }, 'comfly', 'gpt-image-2', '2K')).toBe(false);
```

- [ ] **Step 2: Run RED.** `npm.cmd exec -- vitest run --config vitest.config.ts apps/renderer/src/app/layering-plan.test.ts`; expected missing module/functions.
- [ ] **Step 3: Implement strict parse/normalize and canonical digest.** Use Zod `.strict()` for the model's `layers` array; synthesize no text layer, forbid omitted/invalid kinds, reject >8 included foregrounds. Return a frozen, public-data-only confirmation snapshot:

```ts
export interface LayeringConfirmation {
  readonly sourceAssetId: string;
  readonly provider: ModelJobProvider;
  readonly modelRoute: string;
  readonly resolution: '1K' | '2K' | '4K';
  readonly layerIds: readonly string[];
  readonly digest: string;
  readonly confirmedAt: string;
}
```

Derive the digest from canonical JSON with `crypto.subtle.digest('SHA-256', bytes)`, not a secret or a temporary URL. Test editing a layer description invalidates it even when count is unchanged.
- [ ] **Step 4: Run GREEN.** Same focused command plus `npm.cmd exec -- tsc -p apps/renderer/tsconfig.json --noEmit`.
- [ ] **Step 5: Commit only the two new files.** `git add -- apps/renderer/src/app/layering-plan.ts apps/renderer/src/app/layering-plan.test.ts` then `git commit -m "feat: validate editable image layering plans"`.

### Task 2: One paid vision analysis, no generation side effect

**Files:** Create `apps/renderer/src/app/layering-analysis.ts`, `apps/renderer/src/app/layering-analysis.test.ts`; modify `apps/renderer/src/app/app-store.ts` only to expose `analyzeImageLayering`.

**Interfaces:** `analyzeImageLayering({ sourceAssetId, modelRoute, provider, sessionId, width, height }): Promise<LayeringPlan>` consumes Task 1 parser. It does not return model jobs or mutate graph.

- [ ] **Step 1: Write RED tests.** A mock `chatSkill` receives exactly one managed `referenceAssetId`, `visualAnalysis: true`, one matching `@图片1` mention and a strict JSON-only instruction. Valid reply yields a plan; unavailable vision capability, missing session, malformed reply or provider error yields an explicit analysis error. Assert `submitImageJob` and graph commit spies have zero calls in every analysis test.
- [ ] **Step 2: Run RED.** `npm.cmd exec -- vitest run --config vitest.config.ts apps/renderer/src/app/layering-analysis.test.ts`.
- [ ] **Step 3: Implement the bridge call with existing `ChatSkillBridgeRequest`.** Select only a configured profile carrying `vision`, resolve the current desktop session and managed source ID, then use:

```ts
await bridge.chatSkill({
  provider, modelRoute, sessionId,
  referenceAssetIds: [sourceAssetId],
  referenceMentions: [{ assetId: sourceAssetId, label: '原图', mention: '@图片1' }],
  agentMode: 'chat', visualAnalysis: true,
  messages: [{ role: 'user', content: analysisInstruction }],
  context: { knowledgeBaseIds: [], projectMemoryIds: [] },
});
```

Keep `analysisInstruction` below the bridge's 8,000-character limit and parse only `result.message`. Treat returned text as data, never tool instructions. Show the analysis-fee warning before this call in Task 6.
- [ ] **Step 4: Run GREEN.** Focused Vitest and renderer typecheck; add one test that a response with prose around JSON is rejected rather than guessed.
- [ ] **Step 5: Commit owned files/hunks.** Commit `feat: analyze managed image into editable layer plan`.

### Task 3: Durable layer-node graph and source preservation

**Files:** Modify `packages/domain/src/canvas-module.ts`, `packages/domain/src/canvas-module.test.ts`, `packages/domain/src/formal-module-catalog.test.ts`; create `apps/renderer/src/app/layering-graph.ts`, `apps/renderer/src/app/layering-graph.test.ts`; modify `apps/renderer/src/app/app-store.ts` to commit one graph transaction.

**Interfaces:** `buildLayeringGraphTransaction(project: CanvasProject, plan: LayeringPlan, confirmation: LayeringConfirmation, groupId: string): ProjectTransaction`. Creates one `image_layer` per included plan layer and one existing `image_layering` composite, with stable `groupId`/`layerId` config. Existing image source node/asset are untouched.

- [ ] **Step 1: Write RED tests.** One source asset plus background/two foregrounds yields three independent layer nodes, one composite, three ordered layer→composite edges, stable IDs and one project transaction. Reapplying same `groupId` is rejected; source node bytes/config remain identical; old manual `image_layering` project still parses.
- [ ] **Step 2: Run RED.** `npm.cmd exec -- vitest run --config vitest.config.ts packages/domain/src/canvas-module.test.ts packages/domain/src/formal-module-catalog.test.ts apps/renderer/src/app/layering-graph.test.ts`.
- [ ] **Step 3: Add formal ports and graph builder.** Keep `image_layering`'s existing `image` input, add `inputMany('layerImages', 'Layers', 'image_asset')`, and add an `image_layer` definition with `out('image', 'Image', 'image_asset')`. Build `create_node` operations followed by `create_edge` operations in one transaction:

```ts
const layerNode = createCanvasModuleNode(`layer-${groupId}-${layer.layerId}`, 'image_layer', position);
const edge = {
  id: `layer-edge-${groupId}-${layer.layerId}`,
  source: layerNode.id, sourcePortId: 'image',
  target: composite.id, targetPortId: 'layerImages', order: index,
};
```

Set initial node config to `planned` plus identity and snapshot, not a fake asset ID. Use `canConnectCanvasPorts` and `applyProjectTransaction` in tests; do not move any pre-existing node during placement.
- [ ] **Step 4: Run GREEN.** Focused command, `npm.cmd exec -- tsc -p packages/domain/tsconfig.json --noEmit`, renderer typecheck. Verify project serialization/reopen of pending nodes.
- [ ] **Step 5: Commit only graph/domain files and owned app-store hunk.** Commit `feat: create independent layering graph nodes`.

### Task 4: GPT-only job binding, one submission and restart-safe polling

**Files:** Create `apps/renderer/src/app/layering-route-evidence.ts` and `.test.ts`; modify `packages/domain/src/model-job.ts`, `packages/domain/src/model-job.test.ts`, `apps/renderer/src/jobs/job-store.ts`, `apps/renderer/src/jobs/job-store.test.ts`, `apps/renderer/src/app/app-store.ts`, `apps/renderer/src/app/app-store.test.ts`, `apps/renderer/src/jobs/desktop-model-executor.test.ts`.

**Interfaces:** Optional persisted `layeringGroupId` and `layerId` fields on `ModelJob`/`ModelJobRequest`; `startConfirmedLayering(groupId, confirmation): Promise<boolean>` in app store. `LayeringRouteEvidence = { provider: ModelJobProvider; modelRoute: string; modelId: string; source: 'provider_doc' | 'live_alpha_qa'; verifiedAt: string }`; `eligibleForLayeringRoute(profile: ProviderBridgeProfile, evidence: readonly LayeringRouteEvidence[]): boolean`. The existing executor still sends one `SubmitImageJobBridgeRequest` per layer with `outputCount: 1`.

- [ ] **Step 1: Write RED tests.** Reject non-GPT or missing `image_edit` profile, an exact route without verified transparent-edit evidence, JPEG transparent layer, source/route/size/plan digest mismatch, foreign project, deleted source and duplicate group. For an evidence-backed valid confirmation, assert exactly one held job per included layer; failed graph binding cancels held jobs with **zero** submit calls; restart polls existing provider task IDs without submitting again. Explicit failed-layer retry needs a new confirmation and preserves successful peers.
- [ ] **Step 2: Run RED.** `npm.cmd exec -- vitest run --config vitest.config.ts packages/domain/src/model-job.test.ts apps/renderer/src/jobs/job-store.test.ts apps/renderer/src/app/app-store.test.ts` with only the new cases selected during the first cycle.
- [ ] **Step 3: Extend the strict job schema and start boundary.** `layering-route-evidence.ts` accepts only an exact `(provider, modelRoute)` pair with recorded provider transparency evidence, `modelId` matching the audited GPT Image family, complete `image_edit` capability and PNG/WebP transport; its initial production set is empty, and tests inject a local evidence record without enabling the production route. Carry `layeringGroupId`/`layerId` in the persisted queue, and use the existing `holdGenerationJobDispatch` → `enqueueConfirmedJobs` → durable node binding → `releaseGenerationJobDispatch` ordering. Each request uses the same source `referenceAssetIds: [sourceAssetId]`, GPT edit route, `outputCount: 1`, background `opaque` and foreground `transparent` with `png`/`webp`. Do not modify `toImageSubmitRequest` unless a RED test proves loss of existing fields:

```ts
const request: ModelJobRequest = {
  id: createModelJobRunId(), kind: 'image', promptNodeId: layerNodeId,
  prompt: layerPrompt, provider, modelRoute, displayName, modelId,
  referenceAssetIds: [sourceAssetId], outputCount: 1,
  resolution, imageOutputFormat: 'png',
  imageBackground: layer.kind === 'background' ? 'opaque' : 'transparent',
  layeringGroupId: groupId, layerId: layer.layerId,
};
```

`image_layer` jobs must pass project/node/group ownership in queue repair and result materialization, not merely match `promptNodeId`. Provider polling is read-only; never call `retryJob` from hydration.
- [ ] **Step 4: Run GREEN.** Focused tests, domain/renderer typechecks, then `npm.cmd exec -- vitest run --config vitest.config.ts apps/renderer/src/jobs/project-model-jobs.test.ts apps/renderer/src/jobs/desktop-model-executor.test.ts`.
- [ ] **Step 5: Commit owned files/hunks.** Commit `feat: bind GPT image edits to durable layer jobs`.

### Task 5: Returned-pixel validation, composite and PSD completion gate

**Files:** Create `apps/renderer/src/app/layering-quality.ts`, `apps/renderer/src/app/layering-quality.test.ts`; modify `apps/renderer/src/app/layered-image-config.ts`, `apps/renderer/src/app/layered-image-config.test.ts`, `apps/renderer/src/app/layered-psd.test.ts`, `apps/renderer/src/canvas/ImageLayeringWorkbench.tsx`.

**Interfaces:** `validateLayerPixels(kind, bytes, expectedWidth, expectedHeight): Promise<LayerQualityVerdict>`; `LayerQualityVerdict = { ok: true; rgba: Uint8Array } | { ok: false; reason: 'decode' | 'media_type' | 'dimensions' | 'alpha_empty' | 'alpha_opaque' | 'background_holes' }`. Completed composite config remains compatible with `parseLayeredImageConfig`.

- [ ] **Step 1: Write RED tests.** Valid full-opaque background plus two mixed-alpha foregrounds pass. JPEG, wrong dimensions, all-zero/all-255 alpha foreground, transparent background holes and failed asset load mark the exact layer invalid. After reorder/hide/reopen, ag-psd readback verifies layer names, pixels, alpha, order, visibility and composite; incomplete group disables both PSD download and Photoshop open.
- [ ] **Step 2: Run RED.** `npm.cmd exec -- vitest run --config vitest.config.ts apps/renderer/src/app/layering-quality.test.ts apps/renderer/src/app/layered-image-config.test.ts apps/renderer/src/app/layered-psd.test.ts`.
- [ ] **Step 3: Validate bytes before declaring a layer complete.** Decode in a bounded worker/offscreen path where available; enforce canvas side/pixel limits already used by `layered-psd.ts`. Count alpha distribution rather than merely checking PNG MIME:

```ts
const alpha = rgba.filter((_, index) => index % 4 === 3);
const hasClear = alpha.some(value => value === 0);
const hasVisible = alpha.some(value => value > 0);
if (kind === 'transparent' && (!hasClear || !hasVisible)) {
  return { ok: false, reason: hasVisible ? 'alpha_opaque' : 'alpha_empty' };
}
```

Keep successful managed assets when another layer fails; PSD export uses the existing `encodeLayeredPsd` only after every included layer has `ok: true` and matches dimensions. Visual mismatch/occlusion quality remains a visible manual-review warning, not a false pixel-perfect pass.
- [ ] **Step 4: Run GREEN.** Focused tests plus `tests/e2e/image-layering.spec.ts`; test Photoshop bridge bytes equality with the existing offline fixture.
- [ ] **Step 5: Commit owned files.** Commit `feat: validate generated layers before PSD export`.

### Task 6: Compact toolbar, analysis modal, progress and recovery UI

**Files:** Create `apps/renderer/src/canvas/LayeringDialog.tsx`, `apps/renderer/src/canvas/LayeringDialog.test.tsx`; modify `apps/renderer/src/canvas/ModuleNodeCard.tsx`, `CanvasWorkspace.tsx`, `ImageLayeringWorkbench.tsx`, `apps/renderer/src/styles/image-layering.css`; test `ModuleNodeCard.test.tsx`, `CanvasWorkspace.test.tsx`, `tests/e2e/image-layering.spec.ts`.

**Interfaces:** Calls `analyzeImageLayering`, `confirmLayeringPlan`, `startConfirmedLayering`; reads group/layer states and managed assets from existing app store. Exposes accessible `AI 分层` icon next to Task-5 color icon, but no hidden auto-submission.

- [ ] **Step 1: Write RED tests.** Selected image result opens modal using **that result's** managed asset ID; empty/missing source disables entry with explanation. Analysis warns cost and has zero GPT jobs. Edit names/order/inclusion, then confirm shows exact model/size/layer count/request count; any edit invalidates confirmation. Generated canvas shows separate layer nodes, ordered lines, composite preview, progress, failed-layer reason and read-only reload. Escape/focus return works in light/dark.
- [ ] **Step 2: Run RED.** `npm.cmd exec -- vitest run --config vitest.config.ts apps/renderer/src/canvas/LayeringDialog.test.tsx apps/renderer/src/canvas/ModuleNodeCard.test.tsx apps/renderer/src/canvas/CanvasWorkspace.test.tsx`.
- [ ] **Step 3: Implement stateful modal and compact toolbar.** The primary actions must be distinct:

```tsx
<button type="button" onClick={analyze} disabled={!visionRoute}>分析图片</button>
<button type="button" onClick={confirmAndStart} disabled={!plan || !gptRoute || !planValid}>确认生成</button>
```

Render `aria-live="polite"` progress from job states but persist only terminal asset/status changes. Never make closing the modal call provider cancellation; show the existing job in the graph. Keep the original source node visible and preserve the user's existing canvas positions.
- [ ] **Step 4: Run GREEN and local E2E.** Focused Vitest plus `npm.cmd run e2e -- tests/e2e/image-layering.spec.ts`; verify tab order, two icons, per-layer PSD, failure, project reopen, no duplicate network submit and dark/light screenshots.
- [ ] **Step 5: Commit owned files/hunks.** Commit `feat: expose analyze confirm and layered canvas workflow`.

### Task 7: Full regression, candidate installer and isolated installation

**Files:** Modify `apps/desktop-modern/package.json` and matching version declarations only after checking 1.6.156 availability; update `docs/project-memory.md`; reuse/adapt `work/build-formal-1.6.155.mjs`, `work/verify-candidate-155.mjs` as copied **new** 1.6.156 scripts, leaving old candidate and protected `latest.yml` untouched. Add an exact QA report under `work/qa-layering-ui-1.6.156/`.

**Interfaces:** Produces a 1.6.156 NSIS candidate plus read-only identity report and isolated-installed acceptance report. No GitHub release or daily-directory replacement.

- [ ] **Step 1: Lock the acceptance matrix.** Make a report with rows for source, build, candidate payload, isolated install, UI light/dark, Agent, save/restart, graph, PSD readback, live Comfly alpha, real Photoshop open. Default external rows to `unverified`, never `passed` from fixtures:

```json
{"row":"live_comfly_alpha","status":"unverified","paidSubmissions":0}
```

- [ ] **Step 2: Run broad local gates.** `npm.cmd test`, `npm.cmd run typecheck`, `npm.cmd run build`, `npm.cmd run scan:e2e`, `npm.cmd run e2e -- tests/e2e/image-layering.spec.ts tests/e2e/agent-floating-window.spec.ts tests/e2e/project-save-manager.spec.ts`, `git diff --check`. Run the 300-node/500-edge stress fixture and record P95/max input, drag and save; do not loosen thresholds to manufacture PASS.
- [ ] **Step 3: Prepare new candidate.** Confirm `apps/desktop-modern/package.json` still says 1.6.155 and no 1.6.156 output/tag already exists; if occupied, stop and revise the version in the reviewed plan. Duplicate the existing formal build/verify scripts under 1.6.156 names and change only explicit version/output labels. Run the new build script, verify all renderer/desktop payload bytes and installer hashes, then scan for secrets/paths. Never reuse an older `dist` silently.
- [ ] **Step 4: Isolated install and QA.** Install to a checked, new QA directory under `D:\CanvasAtelier-QA-1.6.156-20260923`, with the NSIS `/D="..."` quoting contract; do not stop unknown processes or overwrite the daily app. Verify uninstall version, executable and `app.asar` hashes, then run Playwright/Electron with a fresh isolated project. Confirm source unchanged, no provider network requests in zero-cost runs, save/reopen, PSD readback, complete Agent/reverse/image/video controls, dark/light, clean exit.
- [ ] **Step 5: External boundary and handoff.** If the user gives a new exact paid-test approval, run only the approved GPT route/size/request count and record actual alpha, task IDs and charge risk; after a genuine pass, add only that exact provider/model pair to `layering-route-evidence.ts`, rebuild/repackage and rerun installed gates. Otherwise the production route stays disabled, live provider remains blocked/unverified, and the automatic supplier route cannot be called complete. Real Photoshop open uses an isolated QA PSD and never changes an existing document. Append root cause/verification to `docs/project-memory.md`; commit only owned source/test/docs, not build artifacts or user data. Deliver installer path/hash and the five evidence levels separately.

## Execution order and stop conditions

Complete the UI plan first, then Tasks 1–6 here, then Task 7. After each task, use RED/GREEN and a scoped review; no task may infer downstream success from an earlier source pass. A missing Comfly transparent-alpha proof is an external acceptance gap, not permission to invent an endpoint or auto-spend credits. If the approved model route cannot satisfy the spec, keep that route disabled and report the precise blocker before claiming the feature fully complete.
