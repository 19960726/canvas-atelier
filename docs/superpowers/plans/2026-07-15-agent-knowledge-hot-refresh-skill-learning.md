# Agent Knowledge Hot Refresh and Skill Learning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add validated hot-refreshing knowledge snapshots, immutable per-run Agent leases, ordered image references with `@image`, and review-gated feedback-driven reverse-prompt Skill growth across devices.

**Architecture:** Domain contracts define ordered references, knowledge leases, feedback memory, and candidate lifecycle. `@agent-canvas/skill-store` validates and versions immutable snapshots, reuses the existing memory-sync and guarded-writeback paths, and builds review candidates. Desktop-core watches configured trusted roots, stores snapshots atomically, and exposes a narrow event-capable bridge; Renderer subscribes to summaries, pins leases at run start, persists reorder only at drop, and presents review controls.

**Tech Stack:** TypeScript ES2019, Zod 3, Vitest 3, React 19, Zustand 5, Electron 22.3.27 Legacy, Electron 43.1.0 Modern, Node `fs.watch`, existing snapshot journal, guarded writeback, and offline outbox.

## Global Constraints

- Work only in `E:\画布项目\.worktrees\canvas-agent-mvp` on `feature/canvas-agent-mvp`; never modify the main checkout.
- Windows 7 remains on Electron 22.3.27 Legacy; Windows 10/11 remain on the Modern shell.
- Direct managed-knowledge edits activate only after validation; feedback-derived changes remain `pending_review` until approval.
- Every Agent run pins immutable knowledge versions; active runs never change mid-run, and the next run uses the newest approved versions.
- Failed refresh keeps the previous known-good snapshot and preserves task progress.
- Reuse existing memory sync, one-use writeback approval, atomic writeback, and offline outbox; do not create a second sync system.
- `pointermove` performs zero persistence and zero knowledge-sync calls; reference order persists once at drop.
- Renderer receives no arbitrary filesystem primitive. Trusted roots use native desktop selection and opaque ids.
- Protected artifacts contain no API keys, Authorization values, raw Base64 images, or private absolute paths.
- Do not copy CanvasForge proprietary source, UI, keys, wording, branding, or visual identity.
- Do not upgrade plan-pinned `yauzl@3.2.0` without separate approval.
- Every task follows RED -> GREEN -> review -> commit.

## File Map

- `packages/domain/src/knowledge-context.ts`: ordered references, image citations, snapshot pins, and Agent leases.
- `packages/domain/src/project-memory.ts`: structured feedback and Skill candidate lifecycle.
- `packages/skill-store/src/knowledge-snapshot.ts`: sanitized immutable knowledge documents.
- `packages/skill-store/src/knowledge-registry.ts`: publish, fallback, list, and rollback.
- `packages/skill-store/src/candidate-builder.ts`: aggregate feedback into review candidates.
- `packages/desktop-core/src/managed-knowledge-store.ts`: atomic snapshots and trusted-root configuration.
- `packages/desktop-core/src/knowledge-refresh-service.ts`: debounced watcher and refresh coordinator.
- `packages/desktop-core/src/preload-api.ts`: narrow knowledge bridge and subscriptions.
- `apps/renderer/src/app/knowledge-client.ts`: browser/desktop state adapter.
- `apps/renderer/src/references/ReferenceOrderList.tsx`: accessible reorder UI.
- `apps/renderer/src/agent/ImageMentionComposer.tsx`: structured `@image` citations.
- `apps/renderer/src/agent/KnowledgeStatus.tsx`: active and pinned versions.
- `apps/renderer/src/history/SkillCandidateReview.tsx`: review and rollback UI.

---

### Task 1: Ordered References and Immutable Agent Knowledge Leases

**Files:**
- Create: `packages/domain/src/knowledge-context.ts`
- Create: `packages/domain/src/knowledge-context.test.ts`
- Modify: `packages/domain/src/reverse-prompt-agent.ts`
- Modify: `packages/domain/src/reverse-prompt-agent.test.ts`
- Modify: `packages/domain/src/generation-request.ts`
- Modify: `packages/domain/src/generation-request.test.ts`
- Modify: `packages/domain/src/index.ts`

**Interfaces:**
- Produces `AgentKnowledgeCapability`, `OrderedReference`, `ImageCitation`, `KnowledgeSnapshotPin`, `AgentKnowledgeLease`, `createAgentKnowledgeLease`, and `reorderReferences`.
- `createReversePromptRun` consumes `knowledgeLease`; result validation uses `knowledgeLease.versionKey`.

- [ ] **Step 1: Write failing lease and reorder tests**

```ts
it('pins snapshots and preserves reference order', () => {
  const lease = createAgentKnowledgeLease({
    runId: 'run-1', capability: 'reverse_prompt',
    snapshots: [
      { knowledgeBaseId: 'scene-skill', version: 3, contentHash: 'b'.repeat(64) },
      { knowledgeBaseId: 'ecommerce-detail', version: 2, contentHash: 'a'.repeat(64) },
    ],
    references: [
      { assetId: 'product', label: 'Product', role: 'product_identity', position: 0 },
      { assetId: 'scene', label: 'Scene', role: 'scene_composition', position: 1 },
    ],
    citations: [{ assetId: 'scene', label: 'Scene' }],
  }, { leaseId: 'lease-1', createdAt: '2026-07-15T10:00:00.000Z' });
  expect(lease.snapshots.map((item) => item.knowledgeBaseId)).toEqual(['ecommerce-detail', 'scene-skill']);
  expect(lease.references.map((item) => item.assetId)).toEqual(['product', 'scene']);
  expect(lease.versionKey).toMatch(/^ecommerce-detail@2:/);
});

it('reorders without mutating input', () => {
  const next = reorderReferences(references, 'scene', 'product');
  expect(next.map((item) => item.assetId)).toEqual(['scene', 'product']);
  expect(references.map((item) => item.assetId)).toEqual(['product', 'scene']);
});
```

- [ ] **Step 2: Verify RED**

Run: `npm test -- packages/domain/src/knowledge-context.test.ts packages/domain/src/reverse-prompt-agent.test.ts packages/domain/src/generation-request.test.ts`
Expected: FAIL because lease-aware contracts do not exist.

- [ ] **Step 3: Implement schemas and helpers**

```ts
export const agentKnowledgeCapabilitySchema = z.enum([
  'reverse_prompt', 'image_generation', 'ecommerce_detail',
  'video_analysis', 'line_art', 'skill_conversation',
]);
export const orderedReferenceSchema = z.object({
  assetId: z.string().min(1), label: z.string().min(1), role: referenceRoleSchema,
  position: z.number().int().nonnegative(), weight: z.number().min(0).max(1).optional(),
}).strict();
export const knowledgeSnapshotPinSchema = z.object({
  knowledgeBaseId: z.string().min(1), version: z.number().int().positive(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export function createAgentKnowledgeLease(input: LeaseInput, metadata: LeaseMetadata): AgentKnowledgeLease {
  const snapshots = [...input.snapshots].sort((a, b) => a.knowledgeBaseId.localeCompare(b.knowledgeBaseId));
  return agentKnowledgeLeaseSchema.parse({
    schemaVersion: 1, leaseId: metadata.leaseId, runId: input.runId,
    createdAt: metadata.createdAt, capability: input.capability, snapshots,
    references: normalizeReferencePositions(input.references), citations: input.citations,
    versionKey: snapshots.map((item) => `${item.knowledgeBaseId}@${item.version}:${item.contentHash.slice(0, 12)}`).join('|'),
  });
}
```

Update generation and reverse-prompt requests to carry ordered references and one immutable lease. Retain `approvedMemorySnapshot` only as project-memory context.

- [ ] **Step 4: Verify GREEN**

Run: `npm test -- packages/domain/src/knowledge-context.test.ts packages/domain/src/reverse-prompt-agent.test.ts packages/domain/src/generation-request.test.ts && npm run typecheck`
Expected: focused tests and typecheck pass.

- [ ] **Step 5: Review and commit**

```bash
git add packages/domain/src/knowledge-context.ts packages/domain/src/knowledge-context.test.ts packages/domain/src/reverse-prompt-agent.ts packages/domain/src/reverse-prompt-agent.test.ts packages/domain/src/generation-request.ts packages/domain/src/generation-request.test.ts packages/domain/src/index.ts
git commit -m "feat: add agent knowledge leases"
```

---

### Task 2: Structured Feedback Memory and Candidate Lifecycle

**Files:**
- Modify: `packages/domain/src/project-memory.ts`
- Modify: `packages/domain/src/project-memory.test.ts`
- Modify: `packages/domain/src/project-schema.ts`
- Modify: `packages/domain/src/project-schema.test.ts`
- Modify: `packages/domain/src/project-transaction.test.ts`
- Modify: `packages/domain/src/index.ts`

**Interfaces:**
- Produces `FeedbackObservations`, `SkillCandidateReviewStatus`, `createUserFeedbackMemory`, `reviewSkillPromotionCandidate`, and `rollbackSkillPromotionCandidate`.

- [ ] **Step 1: Write failing feedback and lifecycle tests**

```ts
it('records feedback with lease and visual observations', () => {
  const memory = createUserFeedbackMemory({
    projectId: 'project-1', projectRevision: 4, title: 'Make liquid heavier',
    userRequest: 'Use thicker transparent liquid', correction: 'Reduce droplets',
    knowledgeLease: lease, references, citations: [{ assetId: 'scene', label: 'Scene' }],
    observations: { liquid: ['high viscosity'], vfx: ['small rim particles'] },
    feedback: { keep: ['camera'], change: ['liquid'], never: ['fast splash'] },
  }, { memoryId: 'feedback-1', createdAt: '2026-07-15T10:01:00.000Z' });
  expect(memory.kind).toBe('user_feedback');
  expect(memory.context.knowledgeLease?.leaseId).toBe('lease-1');
});

it('approves and rolls back without losing provenance', () => {
  const approved = reviewSkillPromotionCandidate(candidate, {
    decision: 'approved', reviewedAt: now, publishedKnowledgeVersion: 5,
  });
  expect(approved.reviewStatus).toBe('approved');
  expect(rollbackSkillPromotionCandidate(approved, later).reviewStatus).toBe('rolled_back');
});
```

- [ ] **Step 2: Verify RED**

Run: `npm test -- packages/domain/src/project-memory.test.ts packages/domain/src/project-schema.test.ts packages/domain/src/project-transaction.test.ts`
Expected: FAIL because feedback observations and review transitions do not exist.

- [ ] **Step 3: Extend backward-compatible schemas**

```ts
export const skillCandidateReviewStatusSchema = z.enum([
  'pending_review', 'approved', 'rejected', 'superseded', 'rolled_back',
]);
const feedbackObservationsSchema = z.object({
  sceneStructure: stringListSchema.optional(), composition: stringListSchema.optional(),
  material: stringListSchema.optional(), texture: stringListSchema.optional(),
  floor: stringListSchema.optional(), wall: stringListSchema.optional(),
  color: stringListSchema.optional(), lighting: stringListSchema.optional(),
  liquid: stringListSchema.optional(), vfx: stringListSchema.optional(),
  video: stringListSchema.optional(), cameraMotion: stringListSchema.optional(),
}).strict();
```

Extend candidates with optional source ids, target knowledge base/section, before-rule, counts, confidence, affected capabilities, review time, and published version. Allow active `user_feedback` memories as candidate sources. Keep old project fixtures valid.

- [ ] **Step 4: Verify GREEN**

Run: `npm test -- packages/domain/src/project-memory.test.ts packages/domain/src/project-schema.test.ts packages/domain/src/project-transaction.test.ts && npm run typecheck`
Expected: old fixtures and new lifecycle tests pass.

- [ ] **Step 5: Review and commit**

```bash
git add packages/domain/src/project-memory.ts packages/domain/src/project-memory.test.ts packages/domain/src/project-schema.ts packages/domain/src/project-schema.test.ts packages/domain/src/project-transaction.test.ts packages/domain/src/index.ts
git commit -m "feat: add feedback memory lifecycle"
```

---

### Task 3: Sanitized Immutable Knowledge Snapshots

**Files:**
- Create: `packages/skill-store/src/knowledge-snapshot.ts`
- Create: `packages/skill-store/src/knowledge-snapshot.test.ts`
- Create: `packages/skill-store/src/knowledge-registry.ts`
- Create: `packages/skill-store/src/knowledge-registry.test.ts`
- Modify: `packages/skill-store/src/index.ts`

**Interfaces:**
- Produces `KnowledgeDocument`, `KnowledgeSnapshotCandidate`, `KnowledgeSnapshot`, `KnowledgeBaseState`, `KnowledgeBaseStateSummary`, `createKnowledgeSnapshotCandidate`, and `KnowledgeSnapshotRegistry`.

- [ ] **Step 1: Write failing validation, publish, fallback, and rollback tests**

```ts
it('publishes and deduplicates the same content hash', () => {
  const registry = new KnowledgeSnapshotRegistry();
  const first = registry.publish(candidate, { publishedAt: now, sourceDeviceId: 'device-a' });
  const duplicate = registry.publish(candidate, { publishedAt: now, sourceDeviceId: 'device-a' });
  expect(first.version).toBe(1);
  expect(duplicate).toEqual(first);
  expect(registry.listVersions('scene-skill')).toHaveLength(1);
});

it.each([
  'Authorization: Bearer secret-token',
  'data:image/png;base64,AAAAAAAAAAAAAAAA',
  'C:\\Users\\Private\\skill.md',
])('rejects protected content: %s', (content) => {
  expect(() => createKnowledgeSnapshotCandidate({
    knowledgeBaseId: 'scene-skill', displayName: 'Scene Skill',
    documents: [{ relativePath: 'memory/main.md', content }],
  })).toThrow(/protected content/);
});

it('keeps known-good state after failure and rolls back', () => {
  const registry = seededRegistry();
  registry.recordRefreshFailure('scene-skill', 'invalid schema', now);
  expect(registry.getState('scene-skill').status).toBe('fallback');
  expect(registry.rollback('scene-skill', 1, later).active.version).toBe(1);
});
```

- [ ] **Step 2: Verify RED**

Run: `npm test -- packages/skill-store/src/knowledge-snapshot.test.ts packages/skill-store/src/knowledge-registry.test.ts`
Expected: FAIL because snapshot and registry modules do not exist.

- [ ] **Step 3: Implement canonical candidates and registry**

```ts
export function createKnowledgeSnapshotCandidate(input: CandidateInput): KnowledgeSnapshotCandidate {
  const documents = input.documents
    .map((document) => knowledgeDocumentInputSchema.parse(document))
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath))
    .map((document) => ({ ...document, sha256: sha256(document.content) }));
  scanProtectedContent(documents);
  return knowledgeSnapshotCandidateSchema.parse({
    schemaVersion: 1, knowledgeBaseId: input.knowledgeBaseId,
    displayName: input.displayName, contentHash: sha256(canonicalJson(documents)), documents,
  });
}
export class KnowledgeSnapshotRegistry {
  publish(candidate: KnowledgeSnapshotCandidate, metadata: PublishMetadata): KnowledgeSnapshot;
  getActive(knowledgeBaseId: string): KnowledgeSnapshot | null;
  getState(knowledgeBaseId: string): KnowledgeBaseState;
  getSummary(knowledgeBaseId: string): KnowledgeBaseStateSummary;
  listVersions(knowledgeBaseId: string): KnowledgeSnapshot[];
  recordRefreshFailure(knowledgeBaseId: string, reason: string, failedAt: string): void;
  rollback(knowledgeBaseId: string, version: number, rolledBackAt: string): KnowledgeBaseState;
}
```

Use canonical document ordering, relative managed paths, SHA-256, and immutable clones on all reads.

- [ ] **Step 4: Verify GREEN**

Run: `npm test -- packages/skill-store/src/knowledge-snapshot.test.ts packages/skill-store/src/knowledge-registry.test.ts && npm run typecheck`
Expected: validation, deduplication, fallback, rollback, and typecheck pass.

- [ ] **Step 5: Review and commit**

```bash
git add packages/skill-store/src/knowledge-snapshot.ts packages/skill-store/src/knowledge-snapshot.test.ts packages/skill-store/src/knowledge-registry.ts packages/skill-store/src/knowledge-registry.test.ts packages/skill-store/src/index.ts
git commit -m "feat: add managed knowledge snapshots"
```

---

### Task 4: Feedback Aggregation and Approved Snapshot Sync

**Files:**
- Create: `packages/skill-store/src/candidate-builder.ts`
- Create: `packages/skill-store/src/candidate-builder.test.ts`
- Modify: `packages/skill-store/src/memory-sync.ts`
- Modify: `packages/skill-store/src/memory-sync.test.ts`
- Modify: `packages/skill-store/src/memory-sync-client.ts`
- Modify: `packages/skill-store/src/memory-sync-client.test.ts`
- Modify: `packages/skill-store/src/writeback-flow.ts`
- Modify: `packages/skill-store/src/writeback-token.test.ts`
- Modify: `packages/skill-store/src/offline-outbox.ts`
- Modify: `packages/skill-store/src/offline-outbox.test.ts`
- Modify: `packages/skill-store/src/index.ts`
- Modify: `packages/skill-store/package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Produces `buildSkillPromotionCandidate`, `KnowledgeSnapshotSyncEnvelope`, `MemorySyncClient.uploadApprovedSnapshot`, and `MemorySyncClient.pullApprovedSnapshot`.

- [ ] **Step 1: Write failing aggregation and sync tests**

```ts
it('aggregates evidence without auto-approval', () => {
  const candidate = buildSkillPromotionCandidate([supportA, supportB, contradiction], {
    candidateId: 'candidate-1', targetKnowledgeBaseId: 'scene-skill',
    targetSection: 'reverse-prompt/liquid', createdAt: now,
  });
  expect(candidate).toMatchObject({
    reviewStatus: 'pending_review', supportingEvidenceCount: 2,
    contradictingEvidenceCount: 1, targetKnowledgeBaseId: 'scene-skill',
  });
  expect(candidate.sourceProjectMemoryIds).toEqual(['feedback-a', 'feedback-b', 'feedback-c']);
});

it('pulls an approved snapshot by cursor', async () => {
  fetch.mockResolvedValue(okJson({ snapshot, cursor: 'cursor-2' }));
  await expect(client.pullApprovedSnapshot('scene-skill', 'cursor-1'))
    .resolves.toEqual({ snapshot, cursor: 'cursor-2' });
  expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/approved-snapshot?cursor=cursor-1'), expect.anything());
});
```

- [ ] **Step 2: Verify RED**

Run: `npm test -- packages/skill-store/src/candidate-builder.test.ts packages/skill-store/src/memory-sync.test.ts packages/skill-store/src/memory-sync-client.test.ts packages/skill-store/src/offline-outbox.test.ts`
Expected: FAIL because candidate aggregation and approved-snapshot endpoints do not exist.

- [ ] **Step 3: Implement aggregation and extend existing sync**

```ts
export function buildSkillPromotionCandidate(
  entries: ProjectMemoryEntry[], metadata: CandidateMetadata,
): SkillPromotionCandidate {
  const parsed = entries.map(parseProjectMemoryEntry);
  const supporting = parsed.filter((entry) => entry.feedback.change.length > 0);
  const contradicting = parsed.filter((entry) => entry.feedback.never.some((item) =>
    supporting.some((source) => source.nextStep.includes(item))));
  return skillPromotionCandidateSchema.parse({
    schemaVersion: 1, id: metadata.candidateId,
    sourceProjectId: parsed[0]!.projectId, sourceProjectMemoryId: parsed[0]!.id,
    sourceProjectMemoryIds: parsed.map((entry) => entry.id),
    targetKnowledgeBaseId: metadata.targetKnowledgeBaseId,
    targetSection: metadata.targetSection, createdAt: metadata.createdAt,
    title: parsed[0]!.title, rationale: parsed.map((entry) => entry.rationale).join('\n'),
    rule: selectCandidateRule(parsed), evidence: mergeFeedback(parsed),
    supportingEvidenceCount: supporting.length,
    contradictingEvidenceCount: contradicting.length,
    confidence: supporting.length / Math.max(1, supporting.length + contradicting.length),
    affectedCapabilities: metadata.affectedCapabilities, reviewStatus: 'pending_review',
  });
}
```

Add approved snapshot endpoints at `/v1/knowledge-bases/:id/approved-snapshot`. Authorization exists only in request headers. Outbox transfer serialization includes snapshot id/hash metadata only, never document content or tokens.

- [ ] **Step 4: Verify GREEN**

Run: `npm test -- packages/skill-store/src/candidate-builder.test.ts packages/skill-store/src/memory-sync.test.ts packages/skill-store/src/memory-sync-client.test.ts packages/skill-store/src/writeback-token.test.ts packages/skill-store/src/offline-outbox.test.ts && npm run typecheck`
Expected: aggregation, pending review, sync, token redaction, and offline tests pass.

- [ ] **Step 5: Review and commit**

```bash
git add package-lock.json packages/skill-store
git commit -m "feat: sync approved knowledge growth"
```

---

### Task 5: Atomic Managed Knowledge Storage

**Files:**
- Create: `packages/desktop-core/src/managed-knowledge-store.ts`
- Create: `packages/desktop-core/src/managed-knowledge-store.test.ts`
- Modify: `packages/desktop-core/src/index.ts`
- Modify: `packages/desktop-core/package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Produces `ManagedKnowledgeStore.configure/readConfiguration/publish/readActive/listStates/rollback`.
- Public configuration returns an opaque `knowledgeRootId`; raw roots remain app-private.

- [ ] **Step 1: Write failing atomic and redaction tests**

```ts
it('stores roots privately and returns opaque ids', async () => {
  const configured = await store.configure({
    knowledgeBaseId: 'scene-skill', displayName: 'Scene Skill', rootPath: sourceRoot,
  });
  expect(configured).toEqual(expect.objectContaining({ knowledgeRootId: expect.any(String) }));
  expect(JSON.stringify(configured)).not.toContain(sourceRoot);
});

it('writes snapshot bytes before current metadata', async () => {
  await store.publish(snapshot);
  expect(await store.readActive('scene-skill')).toEqual(snapshot);
  expect(JSON.stringify(await store.listStates())).not.toContain(appDataRoot);
});
```

- [ ] **Step 2: Verify RED**

Run: `npm test -- packages/desktop-core/src/managed-knowledge-store.test.ts`
Expected: FAIL because managed storage does not exist.

- [ ] **Step 3: Implement app-managed storage**

```ts
// <appData>/knowledge/config.json
// <appData>/knowledge/<id>/snapshots/v-<version>-<hash12>.json
// <appData>/knowledge/<id>/current.json
export class ManagedKnowledgeStore {
  async configure(input: ConfigureKnowledgeRoot): Promise<ConfiguredKnowledgeBase>;
  async readConfiguration(id: string): Promise<InternalKnowledgeConfiguration | null>;
  async publish(snapshot: KnowledgeSnapshot): Promise<void>;
  async readActive(id: string): Promise<KnowledgeSnapshot | null>;
  async listStates(): Promise<KnowledgeBaseStateSummary[]>;
  async rollback(id: string, version: number): Promise<KnowledgeBaseStateSummary>;
}
```

Use `writeAtomic`; every managed path must resolve under app data. Never return `rootPath` through public summaries.

- [ ] **Step 4: Verify GREEN**

Run: `npm test -- packages/desktop-core/src/managed-knowledge-store.test.ts && npm run typecheck && npm run build -w @agent-canvas/desktop-core`
Expected: atomic publish, rollback, opaque configuration, typecheck, and build pass.

- [ ] **Step 5: Review and commit**

```bash
git add package-lock.json packages/desktop-core/package.json packages/desktop-core/src/managed-knowledge-store.ts packages/desktop-core/src/managed-knowledge-store.test.ts packages/desktop-core/src/index.ts
git commit -m "feat: persist managed knowledge snapshots"
```

---

### Task 6: Debounced Trusted-Root Refresh Service

**Files:**
- Create: `packages/desktop-core/src/knowledge-refresh-service.ts`
- Create: `packages/desktop-core/src/knowledge-refresh-service.test.ts`
- Modify: `packages/desktop-core/src/index.ts`

**Interfaces:**
- Produces `KnowledgeRefreshService.start/stop/refreshNow/subscribe` and `KnowledgeWatchAdapter`.
- Production uses Node `fs.watch`; tests inject deterministic watcher and clock adapters.

- [ ] **Step 1: Write failing debounce and fallback tests**

```ts
it('coalesces repeated file events into one refresh', async () => {
  await service.start(['scene-skill']);
  watcher.emit('scene-skill'); watcher.emit('scene-skill'); watcher.emit('scene-skill');
  await clock.advanceBy(300);
  expect(reader.readDocuments).toHaveBeenCalledTimes(1);
  expect(store.publish).toHaveBeenCalledTimes(1);
});

it('keeps the previous snapshot after invalid content', async () => {
  reader.readDocuments.mockResolvedValue([
    { relativePath: 'memory/main.md', content: 'Authorization: Bearer secret' },
  ]);
  await service.refreshNow('scene-skill');
  expect(await store.readActive('scene-skill')).toEqual(previousSnapshot);
  expect(events.at(-1)).toMatchObject({ knowledgeBaseId: 'scene-skill', status: 'fallback' });
});
```

- [ ] **Step 2: Verify RED**

Run: `npm test -- packages/desktop-core/src/knowledge-refresh-service.test.ts`
Expected: FAIL because watcher coordination does not exist.

- [ ] **Step 3: Implement watcher lifecycle**

```ts
export class KnowledgeRefreshService {
  async start(knowledgeBaseIds: string[]): Promise<void>;
  async stop(): Promise<void>;
  async refreshNow(knowledgeBaseId: string): Promise<KnowledgeBaseStateSummary>;
  subscribe(listener: (state: KnowledgeBaseStateSummary) => void): () => void;
}
```

Ignore editor temp files, debounce for 250 ms, re-stat twice across the stability window, recursively read only regular files inside configured roots, and publish only after validation. Events expose ids, version, time, and sanitized reason only.

- [ ] **Step 4: Verify GREEN**

Run: `npm test -- packages/desktop-core/src/knowledge-refresh-service.test.ts packages/desktop-core/src/managed-knowledge-store.test.ts && npm run typecheck`
Expected: debounce, duplicate hash, fallback, stop cleanup, and typecheck pass.

- [ ] **Step 5: Review and commit**

```bash
git add packages/desktop-core/src/knowledge-refresh-service.ts packages/desktop-core/src/knowledge-refresh-service.test.ts packages/desktop-core/src/index.ts
git commit -m "feat: watch managed knowledge roots"
```

---

### Task 7: Narrow Knowledge Bridge and Dual-Shell Events

**Files:**
- Modify: `packages/desktop-core/src/contracts.ts`
- Modify: `packages/desktop-core/src/preload-api.ts`
- Modify: `packages/desktop-core/src/bridge-handlers.ts`
- Modify: `packages/desktop-core/src/bridge-contract.test.ts`
- Modify: `packages/desktop-core/src/index.ts`
- Modify: `apps/desktop-legacy/src/main.ts`
- Modify: `apps/desktop-legacy/src/preload.ts`
- Modify: `apps/desktop-modern/src/main.ts`
- Modify: `apps/desktop-modern/src/preload.ts`

**Interfaces:**
- Adds `configureKnowledgeBase`, `getKnowledgeState`, `reviewSkillCandidate`, and `subscribeKnowledgeState`.
- No bridge request accepts a filesystem path.

- [ ] **Step 1: Write failing allow-list and review tests**

```ts
it('exposes knowledge methods without filesystem primitives', () => {
  const api = createPreloadApi(invoke, subscribe);
  expect(Object.keys(api).sort()).toEqual([
    'closeProject', 'commit', 'configureKnowledgeBase', 'createStablePoint',
    'exportPack', 'getKnowledgeState', 'getRecoveryPlan', 'importPack',
    'openProject', 'restore', 'reviewSkillCandidate', 'subscribeKnowledgeState',
  ]);
  expect(api).not.toHaveProperty('readFile');
  expect(api).not.toHaveProperty('watchPath');
});

it('rejects review for a missing active-project candidate', async () => {
  await expect(handlers.reviewSkillCandidate({}, {
    sessionId: 'session-1', candidateId: 'missing', decision: 'approved',
  })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
});
```

- [ ] **Step 2: Verify RED**

Run: `npm test -- packages/desktop-core/src/bridge-contract.test.ts`
Expected: FAIL because knowledge channels and subscriptions do not exist.

- [ ] **Step 3: Implement typed channels and shell wiring**

```ts
export interface DesktopBridgeApi {
  // existing methods remain
  configureKnowledgeBase(request: ConfigureKnowledgeBaseBridgeRequest): Promise<KnowledgeBaseStateSummary | null>;
  getKnowledgeState(): Promise<KnowledgeStateBridgeResult>;
  reviewSkillCandidate(request: ReviewSkillCandidateBridgeRequest): Promise<ReviewSkillCandidateBridgeResult>;
  subscribeKnowledgeState(listener: (state: KnowledgeBaseStateSummary) => void): () => void;
}
```

Configuration opens a native directory picker in main. Review resolves the candidate from the active session, issues and consumes scoped one-use approval internally, publishes the approved snapshot, and returns updated candidate plus state. Legacy and Modern start/stop one refresh service and forward state with `webContents.send`.

- [ ] **Step 4: Verify GREEN and builds**

Run: `npm test -- packages/desktop-core/src/bridge-contract.test.ts && npm run typecheck && npm run build`
Expected: bridge tests pass and both Electron shells compile.

- [ ] **Step 5: Review and commit**

```bash
git add packages/desktop-core/src/contracts.ts packages/desktop-core/src/preload-api.ts packages/desktop-core/src/bridge-handlers.ts packages/desktop-core/src/bridge-contract.test.ts packages/desktop-core/src/index.ts apps/desktop-legacy/src/main.ts apps/desktop-legacy/src/preload.ts apps/desktop-modern/src/main.ts apps/desktop-modern/src/preload.ts
git commit -m "feat: expose managed knowledge bridge"
```

---

### Task 8: Renderer Knowledge Client, Status, and Run Pinning

**Files:**
- Create: `apps/renderer/src/app/knowledge-client.ts`
- Create: `apps/renderer/src/app/knowledge-client.test.ts`
- Create: `apps/renderer/src/agent/KnowledgeStatus.tsx`
- Create: `apps/renderer/src/agent/KnowledgeStatus.test.tsx`
- Modify: `apps/renderer/src/app/app-store.ts`
- Modify: `apps/renderer/src/app/app-store.test.ts`
- Modify: `apps/renderer/src/agent/ReversePromptAgent.tsx`
- Modify: `apps/renderer/src/agent/ReversePromptAgent.test.tsx`
- Modify: `apps/renderer/src/types/novus-desktop.d.ts`

**Interfaces:**
- Produces `KnowledgeClient.start/stop/configure/review/getLease`.
- App state adds `knowledgeBases`, `initializeKnowledge`, `configureKnowledgeBase`, and `reviewSkillCandidate`.

- [ ] **Step 1: Write failing subscription and pinning tests**

```ts
it('keeps the active lease while the next run gets the refresh', async () => {
  const first = client.getLease('run-1', 'reverse_prompt', references, citations);
  bridge.emitKnowledgeState({ ...sceneV2, version: 3, contentHash: hash3 });
  const second = client.getLease('run-2', 'reverse_prompt', references, citations);
  expect(first.snapshots.find((item) => item.knowledgeBaseId === 'scene-skill')?.version).toBe(2);
  expect(second.snapshots.find((item) => item.knowledgeBaseId === 'scene-skill')?.version).toBe(3);
});

it('shows fallback without clearing history', async () => {
  renderAgentWithKnowledge();
  await runOnce();
  act(() => emitState({ knowledgeBaseId: 'scene-skill', version: 2, status: 'fallback' }));
  expect(screen.getByText(/using v2/i)).toBeVisible();
  expect(screen.getByLabelText('reverse prompt history')).toBeVisible();
});
```

- [ ] **Step 2: Verify RED**

Run: `npm test -- apps/renderer/src/app/knowledge-client.test.ts apps/renderer/src/agent/KnowledgeStatus.test.tsx apps/renderer/src/agent/ReversePromptAgent.test.tsx apps/renderer/src/app/app-store.test.ts`
Expected: FAIL because Renderer knowledge state and lease creation do not exist.

- [ ] **Step 3: Implement client and status view**

```ts
export interface KnowledgeClient {
  start(listener: (states: KnowledgeBaseStateSummary[]) => void): Promise<void>;
  stop(): void;
  configure(knowledgeBaseId: string, displayName: string): Promise<void>;
  review(request: ReviewSkillCandidateBridgeRequest): Promise<ReviewSkillCandidateBridgeResult>;
  getLease(runId: string, capability: AgentKnowledgeCapability,
    references: OrderedReference[], citations: ImageCitation[]): AgentKnowledgeLease;
}
```

`ReversePromptAgent` obtains its lease exactly once in `startAnalysis`. `KnowledgeStatus` displays active version, update time, `syncing`, `updated`, `pending_review`, `fallback`, `offline`, `conflict`, and the run's pinned version.

- [ ] **Step 4: Verify GREEN**

Run: `npm test -- apps/renderer/src/app/knowledge-client.test.ts apps/renderer/src/agent/KnowledgeStatus.test.tsx apps/renderer/src/agent/ReversePromptAgent.test.tsx apps/renderer/src/app/app-store.test.ts && npm run typecheck`
Expected: subscription, fallback, history preservation, and run pinning pass.

- [ ] **Step 5: Review and commit**

```bash
git add apps/renderer/src/app/knowledge-client.ts apps/renderer/src/app/knowledge-client.test.ts apps/renderer/src/app/app-store.ts apps/renderer/src/app/app-store.test.ts apps/renderer/src/agent/KnowledgeStatus.tsx apps/renderer/src/agent/KnowledgeStatus.test.tsx apps/renderer/src/agent/ReversePromptAgent.tsx apps/renderer/src/agent/ReversePromptAgent.test.tsx apps/renderer/src/types/novus-desktop.d.ts
git commit -m "feat: pin renderer knowledge leases"
```

---

### Task 9: Shared Reference Reordering and `@image` Composer

**Files:**
- Create: `apps/renderer/src/references/ReferenceOrderList.tsx`
- Create: `apps/renderer/src/references/ReferenceOrderList.test.tsx`
- Create: `apps/renderer/src/agent/ImageMentionComposer.tsx`
- Create: `apps/renderer/src/agent/ImageMentionComposer.test.tsx`
- Modify: `apps/renderer/src/canvas/CanvasWorkspace.tsx`
- Modify: `apps/renderer/src/canvas/CanvasWorkspace.test.tsx`
- Modify: `apps/renderer/src/app/app-store.ts`
- Modify: `apps/renderer/src/app/app-store.test.ts`
- Modify: `apps/renderer/src/styles/app.css`

**Interfaces:**
- `ReferenceOrderList` calls `onPreviewOrder` during drag and `onCommitOrder` once at drop.
- `ImageMentionComposer` emits `{ text, citations: ImageCitation[] }`.
- App state adds `commitReferenceOrder(assetIds)` and `recordUserFeedback(input)`.

- [ ] **Step 1: Write failing drag-boundary and citation tests**

```ts
it('previews during drag but commits once at drop', () => {
  const onPreviewOrder = vi.fn();
  const onCommitOrder = vi.fn();
  render(<ReferenceOrderList references={references}
    onPreviewOrder={onPreviewOrder} onCommitOrder={onCommitOrder} />);
  fireEvent.dragStart(screen.getByText('Scene'));
  fireEvent.dragOver(screen.getByText('Product'));
  expect(onCommitOrder).not.toHaveBeenCalled();
  fireEvent.drop(screen.getByText('Product'));
  expect(onCommitOrder).toHaveBeenCalledTimes(1);
  expect(onCommitOrder).toHaveBeenCalledWith(['scene', 'product']);
});

it('adds a structured citation and disambiguates duplicate labels', () => {
  render(<ImageMentionComposer references={duplicateLabels}
    value={{ text: '', citations: [] }} onChange={onChange} />);
  fireEvent.click(screen.getByRole('button', { name: 'Mention image' }));
  expect(screen.getByText('Hero image (product)')).toBeVisible();
  expect(screen.getByText('Hero image (scene)')).toBeVisible();
  fireEvent.click(screen.getByText('Hero image (scene)'));
  expect(onChange).toHaveBeenCalledWith(expect.objectContaining({
    text: '@Hero image', citations: [{ assetId: 'scene', label: 'Hero image' }],
  }));
});
```

- [ ] **Step 2: Verify RED**

Run: `npm test -- apps/renderer/src/references/ReferenceOrderList.test.tsx apps/renderer/src/agent/ImageMentionComposer.test.tsx apps/renderer/src/canvas/CanvasWorkspace.test.tsx apps/renderer/src/app/app-store.test.ts`
Expected: FAIL because shared controls and order transactions do not exist.

- [ ] **Step 3: Implement stable-boundary persistence**

```ts
const commitReferenceOrder = async (assetIds: string[]) => {
  const placement = requirePlacementNode(get().project);
  const byId = new Map(placement.data.objects.map((object) => [object.assetId, object]));
  const reordered = assetIds.map((assetId) => byId.get(assetId)!).filter(Boolean);
  const unchanged = placement.data.objects.filter((object) => !assetIds.includes(object.assetId));
  const nextNode = { ...placement, data: { ...placement.data, objects: [...reordered, ...unchanged] } };
  return get().commitProjectTransaction({
    id: createId('reference-order'), label: 'Reorder Agent references',
    operations: [{ kind: 'canvas', operation: { kind: 'update_node', node: nextNode } }],
  }, { kind: 'canvas' });
};
```

Use HTML drag/drop plus keyboard move-up/move-down icon buttons with tooltips. Never persist from drag-over or pointer movement. Pass the same ordered values and citations to reverse prompt and generation consumers.

- [ ] **Step 4: Verify GREEN and pointer boundary**

Run: `npm test -- apps/renderer/src/references/ReferenceOrderList.test.tsx apps/renderer/src/agent/ImageMentionComposer.test.tsx apps/renderer/src/canvas/CanvasWorkspace.test.tsx apps/renderer/src/app/app-store.test.ts && npm run typecheck`
Expected: reorder, keyboard controls, citation resolution, recovery order, one drop commit, and zero pointermove persistence pass.

- [ ] **Step 5: Review and commit**

```bash
git add apps/renderer/src/references apps/renderer/src/agent/ImageMentionComposer.tsx apps/renderer/src/agent/ImageMentionComposer.test.tsx apps/renderer/src/canvas/CanvasWorkspace.tsx apps/renderer/src/canvas/CanvasWorkspace.test.tsx apps/renderer/src/app/app-store.ts apps/renderer/src/app/app-store.test.ts apps/renderer/src/styles/app.css
git commit -m "feat: order and mention agent references"
```

---

### Task 10: Feedback Review, Performance, Security, and Completion

**Files:**
- Create: `apps/renderer/src/history/SkillCandidateReview.tsx`
- Create: `apps/renderer/src/history/SkillCandidateReview.test.tsx`
- Modify: `apps/renderer/src/history/ProjectMemoryTimeline.tsx`
- Modify: `apps/renderer/src/history/ProjectMemoryTimeline.test.tsx`
- Modify: `apps/renderer/src/agent/ReversePromptAgent.tsx`
- Modify: `apps/renderer/src/agent/ReversePromptAgent.test.tsx`
- Modify: `apps/renderer/src/canvas/CanvasWorkspace.tsx`
- Modify: `apps/renderer/src/canvas/CanvasWorkspace.test.tsx`
- Modify: `apps/renderer/src/styles/app.css`
- Create: `packages/desktop-core/src/knowledge-refresh-performance.test.ts`
- Create: `packages/desktop-core/src/knowledge-security.integration.test.ts`
- Create: `docs/testing/agent-knowledge-hot-refresh-matrix.md`
- Modify: `package.json`

**Interfaces:**
- Completes feedback capture, candidate review, version display, rollback, cross-device fallback, and final verification.

- [ ] **Step 1: Write failing integration and security tests**

```ts
it('records feedback now but changes Skill only after approval', async () => {
  renderWorkspace();
  await runReversePrompt();
  fireEvent.change(screen.getByLabelText('Feedback'), {
    target: { value: 'Use slower, thicker liquid' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save feedback' }));
  expect(useAppStore.getState().project.projectMemory.at(-1)?.kind).toBe('user_feedback');
  expect(screen.getByText('Pending review')).toBeVisible();
  expect(bridge.reviewSkillCandidate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Approve candidate' }));
  await waitFor(() => expect(bridge.reviewSkillCandidate).toHaveBeenCalledTimes(1));
});

it('finds no protected payload in knowledge artifacts', async () => {
  await runKnowledgeScenario({
    feedback: 'Authorization: Bearer secret', image: 'data:image/png;base64,AAAA',
  });
  const artifacts = await readScenarioArtifacts();
  expect(artifacts).not.toMatch(/Bearer secret|data:image|[A-Z]:\\Users\\/i);
});
```

- [ ] **Step 2: Verify RED**

Run: `npm test -- apps/renderer/src/history/SkillCandidateReview.test.tsx apps/renderer/src/agent/ReversePromptAgent.test.tsx apps/renderer/src/canvas/CanvasWorkspace.test.tsx packages/desktop-core/src/knowledge-security.integration.test.ts`
Expected: FAIL until feedback capture, review actions, and artifact scanning are wired.

- [ ] **Step 3: Implement review UI and performance harness**

```tsx
<SkillCandidateReview
  candidate={candidate}
  onApprove={() => onReview(candidate.id, 'approved')}
  onReject={() => onReview(candidate.id, 'rejected')}
  onRollback={candidate.reviewStatus === 'approved'
    ? () => onReview(candidate.id, 'rolled_back')
    : undefined}
/>
```

Show before/after rule, source feedback ids, evidence counts, confidence, affected Agents, active version, and publication result. Keep feedback memory durable after rejection. Add `npm run perf:knowledge`: 1,000 duplicate watcher events must produce one parsed publication for one stable hash within a documented reference-machine budget.

- [ ] **Step 4: Run focused GREEN checks**

Run: `npm test -- apps/renderer/src/history/SkillCandidateReview.test.tsx apps/renderer/src/history/ProjectMemoryTimeline.test.tsx apps/renderer/src/agent/ReversePromptAgent.test.tsx apps/renderer/src/canvas/CanvasWorkspace.test.tsx packages/desktop-core/src/knowledge-refresh-performance.test.ts packages/desktop-core/src/knowledge-security.integration.test.ts`
Expected: feedback, review, rollback, progress preservation, security, and performance tests pass.

- [ ] **Step 5: Run complete verification**

```bash
npm test
npm run perf:persistence
npm run perf:knowledge
npm run typecheck
npm run build
git diff --check
```

Expected: all automated tests pass; Legacy and Modern bundles compile; pointermove persists nothing; refresh is hash-deduplicated; protected-artifact scan is clean.

Document Windows 7, Windows 10, and Windows 11 rows for local edit, no-restart refresh, active-run pinning, next-run update, offline fallback, cross-device update, reorder persistence, `@image`, approval, rollback, and task-progress preservation. Mark unavailable physical or VM rows `not-run`.

- [ ] **Step 6: Final review and commit**

```bash
git add package.json apps/renderer/src packages/desktop-core/src/knowledge-refresh-performance.test.ts packages/desktop-core/src/knowledge-security.integration.test.ts docs/testing/agent-knowledge-hot-refresh-matrix.md
git commit -m "test: verify agent knowledge hot refresh"
```

---

## Completion Checklist

- [ ] Direct edits to `电商详情页知识库` and `场景skill` validate and activate without restart.
- [ ] Existing runs stay pinned; next runs use newest approved versions.
- [ ] Every meaningful correction creates durable growth memory.
- [ ] Feedback-derived reverse-prompt changes remain reviewable and reversible.
- [ ] Approved versions sync through existing client/outbox contracts.
- [ ] All Agent consumers share ordered references and structured `@image` citations.
- [ ] Reference dragging commits once at drop and never during `pointermove`.
- [ ] Refresh failures preserve known-good snapshots and UI progress.
- [ ] Desktop bridge exposes no path or arbitrary filesystem method.
- [ ] Protected artifacts contain no credentials, Authorization, Base64 images, or private paths.
- [ ] Full test, persistence perf, knowledge perf, typecheck, both builds, and diff check pass.
