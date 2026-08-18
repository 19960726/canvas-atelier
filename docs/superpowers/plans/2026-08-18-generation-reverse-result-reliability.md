# Generation and Reverse Result Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make ordered image references reach supported generation models, persist generated media and reverse text in their source workflow, remove duplicate model labels, and eliminate reverse-node layout overlap without changing the 1.6.38 UI baseline.

**Architecture:** Reuse the desktop main-process managed-image reader to resolve generation references, then pass ordered data URLs or Gemini inline parts through the provider client. Replace static result transactions with a materialization factory that rebuilds against the latest project revision after generated assets advance the desktop journal. Give reverse analysis its own provider timeout and strict fenced-JSON parser, then finish with presentation-only model deduplication and a final reverse-node CSS layout contract.

**Tech Stack:** TypeScript, React, Zustand, Electron IPC, Zod, Vitest, Testing Library, Playwright, npm workspaces, Electron Builder.

## Global Constraints

- Keep Canvas Atelier UI and packaging based on version `1.6.38`; do not restore or ship a retired UI entry.
- Preserve all unrelated dirty-worktree changes; stage and commit only files changed by the current task.
- Use `npm.cmd`, not `npm`, in PowerShell.
- Do not read, print, log, or expose stored API keys.
- Do not run billed image, video, or reverse-provider calls automatically.
- `@1` is the authoritative scene image; `@2` is the authoritative replacement product.
- Preserve `@1` composition, camera, light, and background; replace only its primary subject with `@2`.
- New image results remain in source-node `data.config.resultAssetIds`, maximum 4; legacy `image_result` remains read-compatible only.
- Reverse results persist in source-node `data.config.reverseAgentResult` and use the existing adjacent `reverse_result` display flow.
- A provider task cannot be marked completed until its source-node result transaction commits successfully.

---

## File Structure

- `packages/desktop-core/src/provider-bridge.ts`: provider capability gate, managed reference resolution, ordered image transport, reverse timeout, and reverse result parsing.
- `packages/desktop-core/src/provider-bridge.test.ts`: provider bridge request-body, unsupported-route, reverse-timeout, and fenced-JSON tests.
- `packages/provider-comfly/src/client.ts`: configurable chat timeout and Gemini image inline reference parts.
- `packages/provider-comfly/src/client.test.ts`: low-level request body and timeout tests.
- `apps/desktop-modern/src/main.ts`: wire the existing managed project-image reader into the modern provider service.
- `apps/desktop-legacy/src/main.ts`: keep the compatibility desktop entry behaviorally aligned without changing its UI.
- `apps/renderer/src/jobs/job-store.ts`: result materialization factory and completion state gate.
- `apps/renderer/src/jobs/job-store.test.ts`: source-node materialization and failed-commit state tests.
- `apps/renderer/src/app/model-result-commit.ts`: merge the generated asset journal update with current renderer state and rebuild result transactions against the newest revision.
- `apps/renderer/src/app/model-result-commit.test.ts`: asset-only rebase, retry, and conflict-abort tests.
- `apps/renderer/src/app/app-store.ts`: integrate the result commit coordinator and set the reverse outer timeout to 135 seconds.
- `apps/renderer/src/app/app-store.test.ts`: desktop revision advancement and reverse persistence integration tests.
- `apps/renderer/src/app/provider-profiles.ts`: final normalized display-name deduplication.
- `apps/renderer/src/app/provider-profiles.test.ts`: duplicate label and saved-route mapping tests.
- `apps/renderer/src/canvas/ModuleNodeCard.tsx`: add stable reverse layout hooks and keep complete result/error text visible.
- `apps/renderer/src/canvas/ModuleNodeCard.test.tsx`: reverse result, error, and route label rendering tests.
- `apps/renderer/src/styles/figma-hybrid-canvas.css`: final 1.6.38 reverse-node grid/flex layout contract.
- `apps/renderer/src/main.styles.test.ts`: CSS contract tests preventing fixed `top` regressions.
- `tests/e2e/result-delivery.spec.ts`: image/video/reverse result delivery and reopen persistence.
- `tests/e2e/visual-layout.spec.ts`: reverse field bounding-box and overflow assertions.

---

### Task 1: Send Ordered Managed References to Supported Image Models

**Files:**
- Modify: `packages/desktop-core/src/provider-bridge.ts:95-113,252-355`
- Modify: `packages/provider-comfly/src/client.ts:292-368`
- Test: `packages/desktop-core/src/provider-bridge.test.ts`
- Test: `packages/provider-comfly/src/client.test.ts`
- Modify: `apps/desktop-modern/src/main.ts:289-305`
- Modify: `apps/desktop-legacy/src/main.ts:279-295`

**Interfaces:**
- Consumes: existing `SubmitImageJobBridgeRequest.referenceAssetIds`, `ManagedSkillChatImageContent`, and profile capabilities `image_edit` / `gemini_native`.
- Produces: `readManagedGenerationImages(sessionId, referenceAssetIds)` provider option and `ComflyClient.generateGeminiImage({ model, prompt, images })`.

- [ ] **Step 1: Write failing provider bridge tests for ordered references**

Add tests that capture the outgoing JSON body and verify exact ordering:

```ts
it('sends managed generation images in @1 then @2 order', async () => {
  const fetch = vi.fn(async (_url, init) => {
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: 'nano-banana-2',
      image: [
        'data:image/png;base64,iVBORw==',
        'data:image/jpeg;base64,/9j/2Q==',
      ],
    });
    return jsonResponse({ taskId: 'provider-raw-task', status: 'pending' });
  });
  const readManagedGenerationImages = vi.fn(async () => [
    { bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]), mediaType: 'image/png' as const },
    { bytes: Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]), mediaType: 'image/jpeg' as const },
  ]);
  const appDataRoot = await makeTempRoot();
  const credentialStore = createSecureProviderCredentialStore({
    appDataRoot,
    safeStorage: createFakeSafeStorage(),
  });
  await credentialStore.configure({ token: 'provider-token' });
  const service = createComflyProviderService({
    appDataRoot,
    credentialStore,
    fetch,
    readManagedGenerationImages,
    profiles: [{
      provider: 'comfly',
      modelRoute: 'nano-banana-2',
      modelId: 'nano-banana-2',
      displayName: 'Nano Banana 2',
      capabilities: ['image_generation', 'image_edit', 'async_tasks'],
    }],
  });

  await service.submitImageJob({
    jobId: 'model-job-v2-11111111111111111111111111111111',
    provider: 'comfly',
    modelRoute: 'nano-banana-2',
    prompt: 'Replace the product only.',
    conversationId: 'conversation-reference-order',
    sessionId: 'desktop-session-1',
    referenceAssetIds: ['1'.repeat(16), '2'.repeat(16)],
  });

  expect(readManagedGenerationImages).toHaveBeenCalledWith(
    'desktop-session-1',
    ['1'.repeat(16), '2'.repeat(16)],
  );
  await cleanupTempRoot(appDataRoot);
});
```

Add a second test asserting a route with only `image_generation` rejects before `fetch` runs:

```ts
const appDataRoot = await makeTempRoot();
const fetch = vi.fn();
const credentialStore = createSecureProviderCredentialStore({
  appDataRoot,
  safeStorage: createFakeSafeStorage(),
});
await credentialStore.configure({ token: 'provider-token' });
const service = createComflyProviderService({
  appDataRoot,
  credentialStore,
  fetch,
  readManagedGenerationImages: vi.fn(async () => [{
    bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]),
    mediaType: 'image/png' as const,
  }]),
  profiles: [{
    provider: 'comfly',
    modelRoute: 'text-only-image',
    modelId: 'text-only-image',
    displayName: 'Text Only Image',
    capabilities: ['image_generation'],
  }],
});
await expect(service.submitImageJob({
  jobId: 'model-job-v2-22222222222222222222222222222222',
  provider: 'comfly',
  modelRoute: 'text-only-image',
  prompt: 'Use the selected reference.',
  conversationId: 'conversation-unsupported-reference',
  sessionId: 'desktop-session-1',
  referenceAssetIds: ['1'.repeat(16)],
}))
  .rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' });
expect(fetch).not.toHaveBeenCalled();
await cleanupTempRoot(appDataRoot);
```

- [ ] **Step 2: Run the provider bridge tests and verify failure**

Run:

```powershell
npm.cmd exec vitest -- --config vitest.config.ts packages/desktop-core/src/provider-bridge.test.ts --run
```

Expected: FAIL because `readManagedGenerationImages` is not accepted and the request body has no `image` array.

- [ ] **Step 3: Write failing Comfly client tests for Gemini inline images**

```ts
it('adds ordered inlineData parts after the reference contract', async () => {
  const fetch = vi.fn(async (_url, init) => {
    const body = JSON.parse(String(init.body));
    expect(body.contents[0].parts).toEqual([
      { text: expect.stringContaining('@1 is the authoritative scene') },
      { inlineData: { mimeType: 'image/png', data: 'iVBORw==' } },
      { inlineData: { mimeType: 'image/jpeg', data: '/9j/2Q==' } },
    ]);
    return jsonResponse({ candidates: [{ content: { parts: [{
      inlineData: { mimeType: 'image/png', data: 'iVBORw0KGgo=' },
    }] } }] });
  });
  const client = new ComflyClient({
    baseUrl: 'https://ai.comfly.org',
    tokenSupplier: async () => 'provider-token',
    fetch,
  });

  await client.generateGeminiImage({
    model: 'gemini-image',
    prompt: 'Replace the product only.',
    images: [
      { mediaType: 'image/png', bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]) },
      { mediaType: 'image/jpeg', bytes: Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]) },
    ],
  });
});
```

- [ ] **Step 4: Implement the minimal ordered reference transport**

Add the provider option:

```ts
readonly readManagedGenerationImages?: (
  sessionId: string,
  referenceAssetIds: readonly string[],
) => Promise<readonly {
  readonly bytes: Uint8Array;
  readonly mediaType: 'image/gif' | 'image/jpeg' | 'image/png' | 'image/webp';
}[]>;
```

Use one reference contract builder:

```ts
function buildGenerationReferencePrompt(prompt: string, count: number): string {
  if (count === 0) return prompt;
  const contract = [
    '@1 is the authoritative scene: preserve its composition, camera, lighting, and background.',
  ];
  if (count >= 2) {
    contract.push(
      '@2 is the authoritative replacement product: preserve its identity, proportions, material, color, and logo.',
      'Replace only the primary subject in @1 with @2. Do not blend, duplicate, or redesign the scene.',
    );
  }
  if (count > 2) contract.push('@3 and later images are supplemental references only.');
  return [...contract, prompt].join('\n');
}
```

Resolve references before transport and block silent fallback:

```ts
const references = validated.referenceAssetIds.length === 0
  ? []
  : await requireManagedGenerationImages(validated, profile, options.readManagedGenerationImages);
const prompt = buildGenerationReferencePrompt(validated.prompt, references.length);

if (references.length > 0 && !profile.capabilities.includes('image_edit')
  && !profile.capabilities.includes('gemini_native')) {
  throw createProviderBridgeError(
    'CAPABILITY_UNSUPPORTED',
    'Selected image model does not support reference images',
  );
}
```

`requireManagedGenerationImages` must reject references without an opaque desktop `sessionId` before invoking the reader:

```ts
if (request.referenceAssetIds.length > 0 && request.sessionId === undefined) {
  throw createProviderBridgeError(
    'INVALID_REQUEST',
    'Reference image generation requires an open desktop project',
  );
}
```

For OpenAI-compatible image generation:

```ts
image: references.map((item) =>
  `data:${item.mediaType};base64,${Buffer.from(item.bytes).toString('base64')}`),
```

For Gemini:

```ts
async generateGeminiImage(input: {
  readonly model: string;
  readonly prompt: string;
  readonly images?: readonly { readonly mediaType: string; readonly bytes: Uint8Array }[];
}) {
  const parts = [
    { text: input.prompt },
    ...(input.images ?? []).map((image) => ({
      inlineData: {
        mimeType: image.mediaType,
        data: Buffer.from(image.bytes).toString('base64'),
      },
    })),
  ];
  // Keep the existing response parsing and generation timeout.
}
```

Wire both desktop entries without adding a second file reader:

```ts
readManagedGenerationImages: desktopHandlers.readManagedSkillChatImages,
```

- [ ] **Step 5: Run focused tests**

Run:

```powershell
npm.cmd exec vitest -- --config vitest.config.ts packages/provider-comfly/src/client.test.ts packages/desktop-core/src/provider-bridge.test.ts --run
```

Expected: PASS; no live provider request is made.

- [ ] **Step 6: Commit Task 1**

```powershell
git add packages/desktop-core/src/provider-bridge.ts packages/desktop-core/src/provider-bridge.test.ts packages/provider-comfly/src/client.ts packages/provider-comfly/src/client.test.ts apps/desktop-modern/src/main.ts apps/desktop-legacy/src/main.ts
git commit -m "fix: send ordered generation references"
```

---

### Task 2: Rebuild Result Transactions Against the Latest Desktop Revision

**Files:**
- Create: `apps/renderer/src/app/model-result-commit.ts`
- Create: `apps/renderer/src/app/model-result-commit.test.ts`
- Modify: `apps/renderer/src/jobs/job-store.ts:54-80,470-570`
- Test: `apps/renderer/src/jobs/job-store.test.ts`
- Modify: `apps/renderer/src/app/app-store.ts:3092-3109`
- Test: `apps/renderer/src/app/app-store.test.ts`

**Interfaces:**
- Consumes: `ProjectPersistenceClient.reloadDurableProject()`, `CanvasProject`, `ProjectTransaction`, `ModelJob`, and `ModelJobResult`.
- Produces: `BuildResultMaterialization`, `ResultMaterializationCommit`, and `commitGeneratedResultWithRefresh(...)`.

- [ ] **Step 1: Write failing job-store tests for commit gating**

Change the callback test double to receive a factory and assert completion only after a successful commit:

```ts
it('does not mark a provider result completed when source-node persistence fails', async () => {
  const imageNode = createCanvasModuleNode('image-node', 'image_generation', { x: 0, y: 0 });
  const project = { ...createStarterProject(), nodes: [imageNode], edges: [] };
  const runningJob = {
    ...request({ id: 'job-result-write-failed', promptNodeId: imageNode.id }),
    conversationId: 'conversation-result-write',
    confirmedAt,
    createdAt: confirmedAt,
    updatedAt: confirmedAt,
    status: 'running' as const,
    retryCount: 0,
    providerTaskId: 'provider-job-result-write-failed',
  } as ModelJob;
  const storage = createInMemoryModelJobStorage([runningJob]);
  const store = createModelJobStore({
    storage,
    executor: createExecutor({
      poll: vi.fn(async () => ({ status: 'completed' as const, result: { assetId: 'a'.repeat(16) } })),
    }),
    getProject: () => project,
    commitProjectTransaction: vi.fn(async () => ({ committed: false, resultNodeId: 'image-node' })),
    now: fixedNow,
    pollIntervalMs: 0,
  });

  await store.pollActiveJobs();

  expect(await storage.get('job-result-write-failed')).toMatchObject({
    status: 'running',
    resultAssetId: undefined,
  });
});
```

Add a test that invokes the materialization factory with a project whose source node prompt changed after submission and verifies that changed prompt remains intact while `resultAssetIds` is appended.

- [ ] **Step 2: Run job-store tests and verify failure**

```powershell
npm.cmd exec vitest -- --config vitest.config.ts apps/renderer/src/jobs/job-store.test.ts --run
```

Expected: FAIL because `commitProjectTransaction` currently receives a static transaction and returns only `boolean`.

- [ ] **Step 3: Introduce the result materialization factory**

Use these exact interfaces:

```ts
export interface ResultMaterialization {
  readonly resultNodeId: string;
  readonly transaction: ProjectTransaction;
}

export type BuildResultMaterialization = (
  project: CanvasProject | undefined,
) => ResultMaterialization;

export interface ResultMaterializationCommit {
  readonly committed: boolean;
  readonly resultNodeId: string;
}
```

Change `ModelJobStoreOptions`:

```ts
commitProjectTransaction: (
  build: BuildResultMaterialization,
  ownerJob: ModelJob,
) => Promise<ResultMaterializationCommit>;
```

In result processing:

```ts
const build: BuildResultMaterialization = (project) =>
  createResultMaterialization(latest, result, project);
const commit = await options.commitProjectTransaction(build, latest);
const afterCommit = await storage.get(job.id);
if (!isSameRunningJob(afterCommit, latest) || !commit.committed) return;

await putTerminalJob(storage, putJob, options.executor, afterCommit, 'completed', {
  completedAt: now(),
  progress: 1,
  resultAssetId: result.assetId,
  resultNodeId: commit.resultNodeId,
  updatedAt: now(),
}, now);
```

- [ ] **Step 4: Write failing asset-rebase tests**

Create `model-result-commit.test.ts`:

```ts
it('keeps local node edits while adopting generated assets and the latest revision', async () => {
  const localNode = createCanvasModuleNode('image-node', 'image_generation', { x: 0, y: 0 });
  localNode.data.config = { ...localNode.data.config, prompt: 'new local prompt' };
  const durableNode = createCanvasModuleNode('image-node', 'image_generation', { x: 0, y: 0 });
  durableNode.data.config = { ...durableNode.data.config, prompt: 'old durable prompt' };
  const generated = {
    assetId: 'a'.repeat(16),
    sha256: 'a'.repeat(64),
    byteSize: 128,
    extension: 'png' as const,
    height: 1024,
    label: 'Generated image',
    mediaType: 'image/png' as const,
    origin: 'generated' as const,
    width: 1024,
  };
  const local = { ...createStarterProject(), nodes: [localNode], edges: [], assets: [] };
  const durable = { ...local, nodes: [durableNode], assets: [generated] };
  const merged = mergeGeneratedAssetRevision(local, durable);

  expect(merged.nodes[0]?.type === 'module' ? merged.nodes[0].data.config.prompt : undefined)
    .toBe('new local prompt');
  expect(merged.assets?.map((asset) => asset.assetId)).toContain('a'.repeat(16));
});

it('reloads and rebuilds at most twice after revision conflicts', async () => {
  const imageNode = createCanvasModuleNode('image-node', 'image_generation', { x: 0, y: 0 });
  const localProject = { ...createStarterProject(), nodes: [imageNode], edges: [], assets: [] };
  const durableProject = {
    ...localProject,
    assets: [{
      assetId: 'a'.repeat(16), sha256: 'a'.repeat(64), byteSize: 128,
      extension: 'png' as const, height: 1024, label: 'Generated image',
      mediaType: 'image/png' as const, origin: 'generated' as const, width: 1024,
    }],
  };
  const commit = vi.fn()
    .mockResolvedValueOnce(false)
    .mockResolvedValueOnce(false)
    .mockResolvedValueOnce(true);
  const result = await commitGeneratedResultWithRefresh({
    build: (project) => ({
      resultNodeId: 'image-node',
      transaction: {
        id: `result-${project?.id ?? 'missing'}`,
        label: 'Store generated result',
        operations: [],
      },
    }),
    commit,
    getLocalProject: () => localProject,
    reloadDurableProject: vi.fn(async () => ({ project: durableProject, revision: 2 })),
    adoptRefreshedProject: vi.fn(),
  });
  expect(result.committed).toBe(true);
  expect(commit).toHaveBeenCalledTimes(3);
});
```

- [ ] **Step 5: Implement generated-asset revision coordination**

Create the focused helper:

```ts
export function mergeGeneratedAssetRevision(
  local: CanvasProject,
  durable: CanvasProject,
): CanvasProject {
  if (local.id !== durable.id) throw new Error('Generated result project changed');
  const assets = new Map((local.assets ?? []).map((asset) => [asset.assetId, asset]));
  for (const asset of durable.assets ?? []) assets.set(asset.assetId, asset);
  return { ...local, assets: [...assets.values()] };
}
```

Implement three total attempts, rebuilding every time:

```ts
export async function commitGeneratedResultWithRefresh(input: CommitGeneratedResultInput) {
  let lastResultNodeId = '';
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) {
      const refreshed = await input.reloadDurableProject();
      if (refreshed === null) return { committed: false, resultNodeId: lastResultNodeId };
      input.adoptRefreshedProject(
        mergeGeneratedAssetRevision(input.getLocalProject(), refreshed.project),
        refreshed.revision,
      );
    }
    const materialized = input.build(input.getLocalProject());
    lastResultNodeId = materialized.resultNodeId;
    if (await input.commit(materialized.transaction)) {
      return { committed: true, resultNodeId: lastResultNodeId };
    }
  }
  return { committed: false, resultNodeId: lastResultNodeId };
}
```

In `app-store.ts`, use the helper only for model result transactions. Keep normal user commits on the existing path. `adoptRefreshedProject` must update `project` and `desktopRevision`, clear `projectCommitConflictCode`, clear `pendingFailedProjectCommit`, and restore `saveStatus: 'saved'` before rebuilding. After either image or video success call the existing `refreshProjectImages()`, which refreshes both project image and video asset summaries.

- [ ] **Step 6: Run focused result persistence tests**

```powershell
npm.cmd exec vitest -- --config vitest.config.ts apps/renderer/src/app/model-result-commit.test.ts apps/renderer/src/jobs/job-store.test.ts apps/renderer/src/app/app-store.test.ts --run
```

Expected: PASS, including the revision-advance reproduction.

- [ ] **Step 7: Commit Task 2**

```powershell
git add apps/renderer/src/app/model-result-commit.ts apps/renderer/src/app/model-result-commit.test.ts apps/renderer/src/jobs/job-store.ts apps/renderer/src/jobs/job-store.test.ts apps/renderer/src/app/app-store.ts apps/renderer/src/app/app-store.test.ts
git commit -m "fix: persist generated results after asset commits"
```

---

### Task 3: Give Reverse Analysis a Dedicated Timeout and Strict JSON Extraction

**Files:**
- Create: `packages/desktop-core/src/provider-json-document.ts`
- Create: `packages/desktop-core/src/provider-json-document.test.ts`
- Modify: `packages/provider-comfly/src/client.ts:292-299`
- Test: `packages/provider-comfly/src/client.test.ts`
- Modify: `packages/desktop-core/src/provider-bridge.ts:392-453`
- Test: `packages/desktop-core/src/provider-bridge.test.ts`
- Modify: `apps/renderer/src/app/app-store.ts:93,781-785`
- Test: `apps/renderer/src/app/app-store.test.ts`
- Modify: `apps/renderer/src/canvas/ModuleNodeCard.tsx:1891-1894`
- Test: `apps/renderer/src/canvas/ModuleNodeCard.test.tsx`

**Interfaces:**
- Consumes: `ComflyClient.chat`, `ComflyClient.generateGeminiContent`, `parseProviderBridgeResponse`, and `parseReversePromptResult`.
- Produces: `parseProviderJsonDocument(text: string): unknown`, `REVERSE_PROVIDER_TIMEOUT_MS = 120_000`, and `REVERSE_AGENT_OPERATION_TIMEOUT_MS = 135_000`.

- [ ] **Step 1: Write failing parser tests**

```ts
describe('parseProviderJsonDocument', () => {
  it.each([
    ['{"analysis":"ok"}', { analysis: 'ok' }],
    ['```json\n{"analysis":"ok"}\n```', { analysis: 'ok' }],
    ['```\n{"analysis":"ok"}\n```', { analysis: 'ok' }],
  ])('parses one controlled JSON document', (text, expected) => {
    expect(parseProviderJsonDocument(text)).toEqual(expected);
  });

  it.each([
    'prefix {"analysis":"ok"}',
    '```json\n{"analysis":"ok"}\n``` trailing',
    '```json\n{"analysis":"ok"}\n```\n```json\n{}\n```',
  ])('rejects mixed or multiple documents', (text) => {
    expect(() => parseProviderJsonDocument(text)).toThrow(/single JSON document/i);
  });
});
```

- [ ] **Step 2: Run parser tests and verify failure**

```powershell
npm.cmd exec vitest -- --config vitest.config.ts packages/desktop-core/src/provider-json-document.test.ts --run
```

Expected: FAIL because the parser does not exist.

- [ ] **Step 3: Implement strict native-or-fenced JSON parsing**

```ts
const FENCED_JSON = /^```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```$/iu;

export function parseProviderJsonDocument(text: string): unknown {
  const trimmed = text.trim();
  const match = FENCED_JSON.exec(trimmed);
  const json = match?.[1] ?? trimmed;
  if (trimmed.startsWith('```') && match === null) {
    throw new Error('Provider must return a single JSON document');
  }
  try {
    return JSON.parse(json);
  } catch {
    throw new Error('Provider must return a single JSON document');
  }
}
```

- [ ] **Step 4: Write failing timeout tests**

Use fake timers to prove reverse does not inherit 30 seconds:

```ts
it('keeps reverse chat alive after the normal 30 second timeout', async () => {
  vi.useFakeTimers();
  let capturedSignal: AbortSignal | undefined;
  let resolveFetch!: (value: ReturnType<typeof jsonResponse>) => void;
  const fetch = vi.fn(async (_url, init) => {
    capturedSignal = init.signal;
    return new Promise<ReturnType<typeof jsonResponse>>((resolve) => { resolveFetch = resolve; });
  });
  const appDataRoot = await makeTempRoot();
  const knowledgeStore = new ManagedKnowledgeStore({ appDataRoot });
  const request = await createReversePromptRequestWithManagedKnowledge(appDataRoot, knowledgeStore);
  const imageOnlyRequest = {
    ...request,
    run: {
      ...request.run,
      agentConfig: { ...request.run.agentConfig!, modelRoute: 'comfly-vision-chat' },
      orderedMedia: [request.run.orderedMedia[0]!],
      videoInput: undefined,
    },
    media: [request.media[0]!],
  };
  const service = createComflyProviderService({
    appDataRoot,
    credentialStore: createSecureProviderCredentialStore({
      appDataRoot,
      safeStorage: createFakeSafeStorage(),
    }),
    fetch,
    profiles: [{
      provider: 'comfly',
      modelRoute: 'comfly-vision-chat',
      modelId: 'vision-chat-model',
      displayName: 'Vision Chat',
      capabilities: ['chat', 'vision', 'reverse_prompt'],
    }],
    readManagedReverseMedia: async () => [{
      bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]),
      mediaType: 'image/png',
    }],
  });
  await service.configure({ token: 'provider-token' });
  const expected = reversePromptResultFor(imageOnlyRequest.run);
  const pending = service.analyzeReversePrompt(imageOnlyRequest);
  await vi.advanceTimersByTimeAsync(30_001);
  expect(capturedSignal?.aborted).toBe(false);
  resolveFetch(jsonResponse({
    id: 'reverse-response',
    model: 'vision-chat-model',
    choices: [{ message: {
      role: 'assistant',
      content: JSON.stringify(expected),
    } }],
  }));
  await expect(pending).resolves.toEqual(expected);
  await cleanupTempRoot(appDataRoot);
  vi.useRealTimers();
});
```

This test intentionally uses the existing `createReversePromptRequestWithManagedKnowledge` and `reversePromptResultFor` helpers already defined in `provider-bridge.test.ts`; do not add a second reverse fixture system.

Also assert `chat(input, 120_000)` forwards `timeoutMs: 120_000` to the Comfly fetch adapter.

- [ ] **Step 5: Implement timeout separation and parser usage**

Extend chat without changing existing callers:

```ts
async chat(input: ComflyChatRequest, timeoutMs = this.timeoutMs) {
  return this.request('/v1/chat/completions', {
    method: 'POST', body: input, model: input.model, schema: chatResponseSchema, timeoutMs,
  });
}
```

In `provider-bridge.ts`:

```ts
const REVERSE_PROVIDER_TIMEOUT_MS = 120_000;

const response = await createClient(snapshot, 'language').generateGeminiContent(request, REVERSE_PROVIDER_TIMEOUT_MS);
// or
const response = await createClient(snapshot, 'language').chat(request, REVERSE_PROVIDER_TIMEOUT_MS);

const parsed = parseProviderBridgeResponse(
  PROVIDER_BRIDGE_CHANNELS.analyzeReversePrompt,
  parseProviderJsonDocument(responseText),
);
```

In `app-store.ts`:

```ts
const REVERSE_AGENT_OPERATION_TIMEOUT_MS = 135_000;
```

Keep sanitized provider timeout, authentication, unavailable-model, media-read, and invalid-response messages distinct. Do not include response bodies, base64, tokens, or paths in the UI error.

Use explicit renderer-facing mapping in `formatReverseRunError`:

```ts
function formatReverseRunError(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error
    && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : '';
  if (code === 'CREDENTIALS_LOCKED') return 'API 密钥已锁定，请重新解锁后再反推。';
  if (code === 'PROVIDER_UNAVAILABLE') return '所选反推模型当前不可用，请重新选择模型。';
  if (code === 'PROVIDER_INVALID_RESPONSE') return '模型已返回内容，但反推结果格式无效。';
  const message = sanitizeModelJobError(error);
  if (/timed out|timeout|超时/iu.test(message)) return '反推等待超时，请重试或更换响应更快的模型。';
  if (/managed.*media|MISSING_ASSET|素材/iu.test(message)) return '反推素材读取失败，请重新连接素材。';
  return message || '反推失败，请重试。';
}
```

Add `sanitizeModelJobError` to the existing `@agent-canvas/domain` import in `ModuleNodeCard.tsx`; do not duplicate its redaction rules locally.

- [ ] **Step 6: Run reverse tests**

```powershell
npm.cmd exec vitest -- --config vitest.config.ts packages/provider-comfly/src/client.test.ts packages/desktop-core/src/provider-json-document.test.ts packages/desktop-core/src/provider-bridge.test.ts apps/renderer/src/app/app-store.test.ts apps/renderer/src/canvas/ModuleNodeCard.test.tsx --run
```

Expected: PASS; fake-timer tests prove no 30-second early abort.

- [ ] **Step 7: Commit Task 3**

```powershell
git add packages/desktop-core/src/provider-json-document.ts packages/desktop-core/src/provider-json-document.test.ts packages/desktop-core/src/provider-bridge.ts packages/desktop-core/src/provider-bridge.test.ts packages/provider-comfly/src/client.ts packages/provider-comfly/src/client.test.ts apps/renderer/src/app/app-store.ts apps/renderer/src/app/app-store.test.ts apps/renderer/src/canvas/ModuleNodeCard.tsx apps/renderer/src/canvas/ModuleNodeCard.test.tsx
git commit -m "fix: stabilize reverse analysis responses"
```

---

### Task 4: Deduplicate Visible Model Names Without Losing Saved Routes

**Files:**
- Modify: `apps/renderer/src/app/provider-profiles.ts:8-182`
- Test: `apps/renderer/src/app/provider-profiles.test.ts`

**Interfaces:**
- Consumes: `ProviderBridgeProfile`, configured-provider status, existing family normalization, and `selectProviderProfile`.
- Produces: `providerCapabilityGroups(profile)` and `normalizedProviderDisplayName(profile)` used by the final presentation key.

- [ ] **Step 1: Write failing duplicate-label tests**

```ts
it('shows one route for equal normalized names in the same provider and capability group', async () => {
  const listProfiles = vi.fn(async ({ provider }: { provider?: 'comfly' | 'relayme' } = {}) =>
    provider === 'relayme' ? [] : [{
      provider: 'comfly' as const,
      modelRoute: 'comfly-nano-banana-2',
      modelId: 'nano-banana-2',
      displayName: 'Nano Banana 2',
      capabilities: ['image_generation' as const, 'image_edit' as const],
      capabilityStatus: 'complete' as const,
    }, {
      provider: 'comfly' as const,
      modelRoute: 'comfly-nano-banana-2-preview',
      modelId: 'nano-banana-2-preview',
      displayName: ' nano  banana  2 ',
      capabilities: ['image_generation' as const, 'image_edit' as const],
      capabilityStatus: 'incomplete' as const,
    }]);

  const profiles = await listAllProviderProfiles({ listProfiles });

  expect(profiles.filter((item) => item.displayName === 'Nano Banana 2')).toHaveLength(1);
  expect(profiles[0]?.modelRoute).toBe('comfly-nano-banana-2');
});
```

Add a second test proving the same display name may remain once for Comfly and once for RelayMe, and `selectProviderProfile` still resolves an old saved preview route through its model ID/family fallback.

- [ ] **Step 2: Run tests and verify failure**

```powershell
npm.cmd exec vitest -- --config vitest.config.ts apps/renderer/src/app/provider-profiles.test.ts --run
```

Expected: FAIL because the current key uses model identity rather than normalized display name and capability group.

- [ ] **Step 3: Implement the final presentation key and preference order**

```ts
function normalizedProviderDisplayName(profile: ProviderBridgeProfile): string {
  return normalizeProviderProfilePresentation(profile).displayName
    .trim()
    .toLocaleLowerCase()
    .replace(/^(?:comfly|relayme)[\s:/_-]+/u, '')
    .replace(/[\s_-]+/gu, ' ');
}

function providerCapabilityGroups(profile: ProviderBridgeProfile): string[] {
  return [
    profile.capabilities.includes('image_generation') ? 'image' : null,
    profile.capabilities.includes('video_generation') ? 'video' : null,
    profile.capabilities.includes('reverse_prompt') ? 'reverse' : null,
    profile.capabilities.includes('chat') || profile.capabilities.includes('responses') ? 'chat' : null,
  ].filter((value): value is string => value !== null).sort();
}

function providerProfileDisplayKey(profile: ProviderBridgeProfile): string {
  return [
    profile.provider,
    providerCapabilityGroups(profile).join(','),
    normalizedProviderDisplayName(profile),
  ].join('::');
}
```

Keep discarded-route compatibility in a module-level alias map rebuilt on every `listAllProviderProfiles` call:

```ts
const providerProfileRouteAliases = new Map<string, string>();

function recordProfileAlias(discarded: ProviderBridgeProfile, selected: ProviderBridgeProfile): void {
  providerProfileRouteAliases.set(`${discarded.provider}::${discarded.modelRoute}`, selected.modelRoute);
  if (discarded.modelId) {
    providerProfileRouteAliases.set(`${discarded.provider}::${discarded.modelId}`, selected.modelRoute);
  }
}
```

When a preferred profile replaces or rejects another profile under the same presentation key, call `recordProfileAlias`. Extend `selectProviderProfile` after exact route/model ID lookup:

```ts
const providers = [...new Set(capable.map((profile) => profile.provider))];
for (const provider of providers) {
  const alias = providerProfileRouteAliases.get(`${provider}::${requestedRoute}`);
  const selected = capable.find((profile) => profile.provider === provider && profile.modelRoute === alias);
  if (selected) return selected;
}
return undefined;
```

Keep preference order: configured provider, complete capability metadata, non-preview/non-minimal route, stable lexical tie-break.

- [ ] **Step 4: Run model profile and settings tests**

```powershell
npm.cmd exec vitest -- --config vitest.config.ts apps/renderer/src/app/provider-profiles.test.ts apps/renderer/src/settings/ProviderModelCatalog.test.tsx apps/renderer/src/canvas/ModuleNodeCard.test.tsx --run
```

Expected: PASS with one visible option per normalized label in each provider/capability group.

- [ ] **Step 5: Commit Task 4**

```powershell
git add apps/renderer/src/app/provider-profiles.ts apps/renderer/src/app/provider-profiles.test.ts
git commit -m "fix: deduplicate visible model names"
```

---

### Task 5: Stabilize Reverse Result Rendering and 1.6.38 Layout

**Files:**
- Modify: `apps/renderer/src/canvas/ModuleNodeCard.tsx:1640-1855`
- Test: `apps/renderer/src/canvas/ModuleNodeCard.test.tsx`
- Modify: `apps/renderer/src/styles/figma-hybrid-canvas.css`
- Test: `apps/renderer/src/main.styles.test.ts`
- Modify: `tests/e2e/visual-layout.spec.ts`

**Interfaces:**
- Consumes: persisted `reverseAgentResult`, `reverseAgentError`, existing `ExecutableNodeWorkbench`, and `TaskTimingBadge`.
- Produces: stable layout hooks `module-node__agent-form-flow`, `module-node__agent-result-scroll`, and bounding-box assertions.

- [ ] **Step 1: Write failing component tests for complete reverse output**

```tsx
it('renders persisted reverse analysis, prompt, constraints, and checklist', () => {
  const baseNode = createCanvasModuleNode('reverse-complete-result', 'reverse_agent', { x: 0, y: 0 });
  const node = {
    ...baseNode,
    data: {
      ...baseNode.data,
      config: {
        ...baseNode.data.config,
        modelRoute: 'reverse-route',
        role: '视觉分析师',
        task: '分析构图',
        reverseAgentRunState: 'completed',
        reverseAgentResult: {
          analysis: 'Keep the centered camera and rim light.',
          keywords: ['centered', 'rim light'],
          positivePrompt: 'Verified product prompt',
          negativeConstraints: ['Do not change the logo'],
          executionChecklist: ['Check product identity'],
        },
      },
      reverseAgentRoutes: [{
        provider: 'comfly',
        modelRoute: 'reverse-route',
        displayName: 'Reverse',
        modelId: 'reverse-route',
        capabilities: ['reverse_prompt', 'gemini_native'],
      }],
    },
  };
  render(<ReactFlowProvider>
    <ModuleNodeCard id={node.id} data={node.data as never} selected={false} />
  </ReactFlowProvider>);

  expect(screen.getByText('Verified product prompt')).toBeVisible();
  expect(screen.getByText('Keep the centered camera and rim light.')).toBeVisible();
  expect(screen.getByText('Do not change the logo')).toBeVisible();
  expect(screen.getByText('Check product identity')).toBeVisible();
});
```

Add an error test that confirms a timeout or invalid-response message is visible inside the reverse result panel and the timing badge shows failed seconds.

- [ ] **Step 2: Run component tests and verify failure**

```powershell
npm.cmd exec vitest -- --config vitest.config.ts apps/renderer/src/canvas/ModuleNodeCard.test.tsx --run
```

Expected: FAIL because the panel currently renders only `positivePrompt`.

- [ ] **Step 3: Render the complete persisted result with stable hooks**

Wrap configuration and result content:

```tsx
<div className="module-node__agent-form-flow">
  {/* existing model, task, and knowledge sections */}
</div>
```

Render all structured sections without duplicating storage:

```tsx
<div className="module-node__agent-result-scroll">
  {result.analysis && <section><strong>分析</strong><p>{result.analysis}</p></section>}
  <section><strong>反推提示词</strong><p>{result.positivePrompt}</p></section>
  {(result.negativeConstraints?.length ?? 0) > 0 && (
    <section><strong>负向约束</strong><ul>{result.negativeConstraints!.map((item) => <li key={item}>{item}</li>)}</ul></section>
  )}
  {(result.executionChecklist?.length ?? 0) > 0 && (
    <section><strong>执行检查</strong><ul>{result.executionChecklist!.map((item) => <li key={item}>{item}</li>)}</ul></section>
  )}
</div>
```

- [ ] **Step 4: Replace reverse absolute positioning with one final grid contract**

Append one terminal rule block at the end of `figma-hybrid-canvas.css`; remove or neutralize earlier reverse-only fixed `top`/`height` rules that it supersedes:

```css
.workspace--ui-gate .module-node--reverse-figma .module-node__agent-form-flow {
  position: static !important;
  display: grid !important;
  grid-template-columns: minmax(0, 1fr) !important;
  gap: 12px !important;
  min-width: 0 !important;
}

.workspace--ui-gate .module-node--reverse-figma :is(
  .module-node__agent-control-strip--figma,
  .module-node__agent-task,
  .module-node__agent-knowledge,
  .module-node__workbench-result,
  .module-node__workbench-actions
) {
  position: static !important;
  inset: auto !important;
  width: auto !important;
  height: auto !important;
  min-width: 0 !important;
  transform: none !important;
}

.workspace--ui-gate .module-node--reverse-figma .module-node__agent-task {
  display: grid !important;
  grid-template-columns: minmax(0, 1fr) !important;
  gap: 10px !important;
}

.workspace--ui-gate .module-node--reverse-figma .module-node__agent-task :is(input, textarea) {
  box-sizing: border-box !important;
  width: 100% !important;
  min-width: 0 !important;
  overflow-wrap: anywhere !important;
}

.workspace--ui-gate .module-node--reverse-figma .module-node__agent-result-scroll {
  display: grid;
  gap: 10px;
  max-height: 260px;
  overflow: auto;
  overflow-wrap: anywhere;
}
```

Update `main.styles.test.ts` to reject reverse form rules containing fixed `top: 87px`, `top: 139px`, or fixed task input heights.

- [ ] **Step 5: Add Playwright overlap and overflow assertions**

```ts
const reverse = page.locator('[data-module-type="reverse_agent"]').last();
const regions = ['route', 'task', 'knowledge', 'result', 'actions'];
const boxes = await Promise.all(regions.map(async (region) => ({
  region,
  box: await reverse.locator(`[data-agent-region="${region}"]`).boundingBox(),
})));

for (let index = 1; index < boxes.length; index += 1) {
  expect(boxes[index]!.box!.y).toBeGreaterThanOrEqual(
    boxes[index - 1]!.box!.y + boxes[index - 1]!.box!.height,
  );
}
expect(await reverse.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
```

Run this for 1366×768, 1440×900, and 1920×1080 in dark and light themes.

- [ ] **Step 6: Run component, style, and layout tests**

```powershell
npm.cmd exec vitest -- --config vitest.config.ts apps/renderer/src/canvas/ModuleNodeCard.test.tsx apps/renderer/src/main.styles.test.ts --run
$env:NOVUS_E2E_PORT='43128'; npm.cmd exec playwright test -- tests/e2e/visual-layout.spec.ts --project=chromium
```

Expected: all tests PASS; screenshots show no overlap or button overflow.

- [ ] **Step 7: Commit Task 5**

```powershell
git add apps/renderer/src/canvas/ModuleNodeCard.tsx apps/renderer/src/canvas/ModuleNodeCard.test.tsx apps/renderer/src/styles/figma-hybrid-canvas.css apps/renderer/src/main.styles.test.ts tests/e2e/visual-layout.spec.ts
git commit -m "fix: stabilize reverse result layout"
```

---

### Task 6: Verify Result Delivery, Reopen Persistence, and Packaging Boundary

**Files:**
- Modify: `tests/e2e/result-delivery.spec.ts`
- Modify: `tests/e2e/image-generation-execution.spec.ts`
- Modify: `tests/e2e/video-generation-ui.spec.ts`
- Modify: `apps/desktop-modern/src/runtime-entry-contract.test.ts`
- Modify: `apps/desktop-modern/src/packaging-boundary.test.ts`

**Interfaces:**
- Consumes: the completed provider, result commit, reverse, model, and layout behavior from Tasks 1-5.
- Produces: fresh automated acceptance evidence and a correctly identified installer artifact.

- [ ] **Step 1: Add non-billed E2E delivery fixtures**

Use the existing E2E provider harness to simulate completed provider tasks. Assert:

```ts
await expect(imageNode.locator('img[data-result-asset-id="aaaaaaaaaaaaaaaa"]')).toBeVisible();
await expect(videoNode.locator('video[data-result-asset-id="bbbbbbbbbbbbbbbb"]')).toBeVisible();
await expect(reverseNode.getByText('Verified persisted reverse prompt')).toBeVisible();
```

Reload the browser test project and repeat the same assertions. Also assert no new external `image_result` node was created for the formal image-generation node.

- [ ] **Step 2: Run the targeted reliability suite**

```powershell
npm.cmd exec vitest -- --config vitest.config.ts packages/provider-comfly/src/client.test.ts packages/desktop-core/src/provider-json-document.test.ts packages/desktop-core/src/provider-bridge.test.ts apps/renderer/src/jobs/job-store.test.ts apps/renderer/src/app/model-result-commit.test.ts apps/renderer/src/app/app-store.test.ts apps/renderer/src/app/provider-profiles.test.ts apps/renderer/src/canvas/ModuleNodeCard.test.tsx apps/renderer/src/main.styles.test.ts --run
```

Expected: PASS with explicit test counts recorded in the final report.

- [ ] **Step 3: Run targeted E2E tests**

```powershell
$env:NOVUS_E2E_PORT='43128'; npm.cmd exec playwright test -- tests/e2e/result-delivery.spec.ts tests/e2e/image-generation-execution.spec.ts tests/e2e/video-generation-ui.spec.ts tests/e2e/visual-layout.spec.ts --project=chromium
```

Expected: PASS; inspect screenshots for nonblank results, correct framing, and no overlap.

- [ ] **Step 4: Run full verification**

```powershell
npm.cmd test
npm.cmd run typecheck
npm.cmd run build
```

Expected: all commands exit 0. Do not treat targeted tests as a substitute for these commands.

- [ ] **Step 5: Build and verify the modern installer**

```powershell
npm.cmd --workspace apps/desktop-modern run build
npm.cmd --workspace apps/desktop-modern run dist
```

Verify the produced installer belongs to `apps/desktop-modern`, uses the 1.6.38 renderer entry, and is not copied from a legacy `dist-builder` directory. Record its absolute path, size, SHA-256, and build time.

- [ ] **Step 6: Launch the packaged app for a non-billed smoke test**

With existing Canvas Atelier processes stopped, launch the new packaged app and verify:

- renderer is nonblank;
- saved provider status loads without exposing the key;
- image, video, and reverse nodes render;
- duplicate model labels are absent;
- reverse fields do not overlap;
- the app closes cleanly.

Do not submit a real generation task during this smoke test.

- [ ] **Step 7: Commit Task 6 acceptance changes**

```powershell
git add tests/e2e/result-delivery.spec.ts tests/e2e/image-generation-execution.spec.ts tests/e2e/video-generation-ui.spec.ts apps/desktop-modern/src/runtime-entry-contract.test.ts apps/desktop-modern/src/packaging-boundary.test.ts
git commit -m "test: cover generation and reverse result delivery"
```

- [ ] **Step 8: Hand off the billed acceptance boundary to the user**

Ask the user to perform exactly these actions in the new installer:

1. Connect `@1` scene and `@2` product to Nano Banana 2, then generate once.
2. Confirm only the product changed and the scene composition, camera, lighting, and background remained fixed.
3. Run one image or video reverse analysis and confirm the full text appears beside the source node.
4. Close and reopen the project and confirm image, video, and reverse results remain visible.

Only after this user-driven test may the final report state that the live billed provider path is accepted.
