# RelayMe Provider-Local Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure every RelayMe image/video node and job uses a canonical RelayMe model route and recover existing unambiguous mixed-route nodes without issuing a paid request.

**Architecture:** Keep real model names as presentation only. Add a provider-scoped generation profile resolver, preserve provider identity during catalog deduplication, and use the resolver before persisting/enqueuing image or video runs.

**Tech Stack:** TypeScript, Zustand, Vitest, RelayMe direct generation/task API contracts.

## Global Constraints

- Workflow APIs discover real model IDs only; never execute a workflow.
- RelayMe generation remains direct `/api/ai-tools/v1/images/generations` or `/videos/generations` plus `/tasks/{taskId}` polling.
- Do not expose tokens, URLs, base64, raw workflow data, or raw remote payloads through IPC.
- Do not change Comfly or other provider request routing.
- Do not trigger a paid generation during diagnosis or verification.
- Do not commit, push, package, or publish without separate explicit authorization.

---

## File map

- `apps/renderer/src/app/provider-profiles.ts`: provider-scoped deduplication and generation profile resolution.
- `apps/renderer/src/app/provider-profiles.test.ts`: same-name cross-provider and mixed-route resolver tests.
- `apps/renderer/src/app/app-store.ts`: use provider-local resolution for image/video execution and canonical node/job persistence.
- `apps/renderer/src/app/app-store.test.ts`: existing mixed RelayMe node recovery and ambiguity rejection tests.
- `packages/desktop-core/src/relayme-provider-service.test.ts`: service rejects foreign routes and sends real model ID to direct APIs.
- `packages/provider-relayme/src/client.test.ts`: retain direct endpoint and official field contract coverage.

### Task 1: Preserve provider identity in route lists

**Files:**
- Modify: `apps/renderer/src/app/provider-profiles.test.ts`
- Modify: `apps/renderer/src/app/provider-profiles.ts`

**Interfaces:**
- Produces: `selectGenerationProviderProfile(profiles, request, capability): ProviderBridgeProfile | undefined`.
- Request shape:

```ts
interface GenerationProfileRequest {
  readonly provider?: ProviderBridgeProfile['provider'];
  readonly modelRoute?: string;
  readonly modelDisplayName?: string;
}
```

- [ ] **Step 1: Write cross-provider dedupe tests**

Build Comfly and RelayMe profiles with the same visible name and assert `buildCanvasProviderRouteSets` retains one per provider rather than one globally.

- [ ] **Step 2: Write provider-local resolver tests**

Assert:

```ts
expect(selectGenerationProviderProfile(profiles, {
  provider: 'relayme',
  modelRoute: 'comfly-nano-banana-pro-2k',
  modelDisplayName: 'Nano Banana Pro',
}, 'image_generation')).toMatchObject({
  provider: 'relayme',
  modelRoute: 'relayme-nano-banana-pro',
});
```

Add an ambiguous two-RelayMe-profile case and expect `undefined`. Add a foreign-route case without a provider/display match and expect `undefined`.

- [ ] **Step 3: Run provider profile tests and verify RED**

```powershell
npm.cmd test -- apps/renderer/src/app/provider-profiles.test.ts
```

Expected: cross-provider profiles collapse or no provider-local resolver exists.

- [ ] **Step 4: Implement provider-scoped keys and resolver**

- Prefix canvas catalog/deduplication keys with `profile.provider`.
- Filter candidates by requested provider before exact route/model-ID matching.
- If a route is foreign or missing, normalize `modelDisplayName` and accept only one same-provider, same-capability match.
- Never resolve an alias from one provider to another.

- [ ] **Step 5: Run the focused test and verify GREEN**

Require all provider-profile tests to pass, then inspect `git diff --check`. Do not commit.

### Task 2: Canonicalize image and video runs before enqueue

**Files:**
- Modify: `apps/renderer/src/app/app-store.test.ts`
- Modify: `apps/renderer/src/app/app-store.ts`

**Interfaces:**
- Consumes: `selectGenerationProviderProfile` from Task 1.
- Produces: every persisted node config and `ModelJobRequest` uses the same `profile.provider`, `profile.modelRoute`, and `profile.modelId`.

- [ ] **Step 1: Write the mixed RelayMe image-node RED test**

Create an image node with:

```ts
config: {
  providerDisplayName: 'relayme',
  modelRoute: 'comfly-nano-banana-pro-2k',
  modelDisplayName: 'Nano Banana Pro',
}
```

Return one RelayMe Nano Banana Pro profile from `listProfiles`, invoke `runImageGenerationNode`, and assert the enqueued request and saved node both use the RelayMe canonical route.

- [ ] **Step 2: Write video and ambiguity RED tests**

Repeat for video. Add an ambiguous RelayMe name case and assert the run fails before `enqueueConfirmedJobs` or any provider submit call.

- [ ] **Step 3: Run app-store tests and verify RED**

```powershell
npm.cmd test -- apps/renderer/src/app/app-store.test.ts
```

- [ ] **Step 4: Implement canonical resolution**

For image and video, resolve with node identity plus requested route:

```ts
const profile = selectGenerationProviderProfile(profiles, {
  provider: readGenerationProvider(node.data.config.providerDisplayName),
  modelRoute: input.modelRoute,
  modelDisplayName: readGenerationDisplayName(node.data.config),
}, capability);
```

Persist and enqueue only values from the returned profile. If no profile exists, throw the existing sanitized `MODEL_ROUTE_UNAVAILABLE` generation-start error with a model-reselection message.

- [ ] **Step 5: Run image/video job-store regressions and verify GREEN**

Run app-store, desktop model executor, and job-store focused tests. Confirm no paid network call is made by test doubles.

- [ ] **Step 6: Review checkpoint without commit**

Inspect only provider/profile and app-store files. Run `git diff --check`. Do not commit.

### Task 3: Enforce RelayMe direct-service route contracts

**Files:**
- Modify: `packages/desktop-core/src/relayme-provider-service.test.ts`
- Modify only if a test proves necessary: `packages/desktop-core/src/relayme-provider-service.ts`
- Verify: `packages/provider-relayme/src/client.test.ts`

- [ ] **Step 1: Add a foreign-route service test**

Call `submitImageJob` with provider `relayme` and a Comfly route. Assert a sanitized `MODEL_ROUTE_UNAVAILABLE`/provider error occurs before `generateImage` is called.

- [ ] **Step 2: Verify canonical model-ID forwarding tests**

Assert a canonical RelayMe route resolves to the real model ID and `generateImage`/`generateVideo` receive that ID. Retain assertions for `videoResolution` and `videoGenerateAudio`.

- [ ] **Step 3: Run RED, implement only if needed, then GREEN**

```powershell
npm.cmd test -- packages/desktop-core/src/relayme-provider-service.test.ts packages/provider-relayme/src/client.test.ts
```

If existing code already passes, do not change production service code; keep only tests that prove the invariant.

- [ ] **Step 4: Verify task-list and IPC privacy regressions**

```powershell
npm.cmd test -- packages/desktop-core/src/preload-api.test.ts packages/desktop-core/src/bridge-contract.test.ts apps/renderer/src/history/GenerationHistoryDrawer.test.tsx
```

Confirm public results contain only narrow task metadata and never token, URL, base64, or workflow payload fields.

- [ ] **Step 5: Review checkpoint without commit**

Run `git diff --check` and inspect RelayMe files. Do not commit.

### Task 4: RelayMe verification gate

- [ ] Run all focused provider suites:

```powershell
npm.cmd test -- apps/renderer/src/app/provider-profiles.test.ts apps/renderer/src/app/app-store.test.ts packages/desktop-core/src/provider-model-catalog.test.ts packages/desktop-core/src/relayme-provider-service.test.ts packages/provider-relayme/src/client.test.ts
```

- [ ] Run full workspace tests and build:

```powershell
npm.cmd test
npm.cmd run build
```

- [ ] Confirm no command invoked RelayMe image/video generation and no package/release was created.
- [ ] Confirm `git status --short` lists only intended source, test, spec, and plan files. Do not commit or push.
