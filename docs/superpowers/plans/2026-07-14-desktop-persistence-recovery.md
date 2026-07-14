# Novus Atelier Desktop Persistence and Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace renderer-only persistence with a Windows desktop repository that journals committed operations, creates verified snapshots, recovers after crashes, and safely imports and exports `.novuspack` files.

**Architecture:** Add atomic project transactions to the domain, a pure TypeScript `@agent-canvas/desktop-core` package, and two thin Electron shells. Renderer mutations pass through a typed preload bridge and receive a durable revision acknowledgement before the UI shows saved.

**Tech Stack:** TypeScript ES2019, Zod 3, Node filesystem/crypto/zlib/worker_threads, Vitest, Electron 22.3.27 Legacy, Electron 43.1.0 Modern, Archiver 7.0.1, Yauzl 3.2.0, React 19, Zustand 5.

## Global Constraints

- Windows 7 uses Electron 22.3.27 Legacy; Windows 10/11 use Electron 43.1.0 Modern.
- Shared persistence compiles to ES2019 and uses Electron 22-compatible APIs unless isolated behind a runtime adapter.
- Projects live in user-selected `.novus-project` directories; AppData holds drafts, recovery mirrors, cache, settings, and redacted diagnostics only.
- `pointermove` performs exactly zero persistence calls. Stable transactions start at `pointerup`, Agent confirmation, asset commit, explicit save, idle, or close.
- Renderer receives no unrestricted filesystem API. IPC is context-isolated and schema validated.
- Saved status appears only after a durable desktop acknowledgement.
- No API keys, Authorization values, raw image Base64, or unintended absolute paths enter project artifacts or diagnostics.
- Do not use SQLite or native Node addons. Legacy and Modern share project, journal, snapshot, and package fixtures.
- Follow TDD for every behavior: verify RED, implement the minimum, verify GREEN, then commit.

## File Map

- `packages/domain/src/project-transaction.ts`: atomic canvas, memory, candidate, and restore operations.
- `packages/desktop-core/src/contracts.ts`: manifests, journals, snapshots, locks, bridge, recovery, and errors.
- `packages/desktop-core/src/canonical-json.ts`: stable JSON and SHA-256.
- `packages/desktop-core/src/file-system.ts`: injectable filesystem and same-volume atomic writes.
- `packages/desktop-core/src/project-repository.ts`: create, open, close, read-only, save-as, and manifests.
- `packages/desktop-core/src/journal-writer.ts`: queue, idempotency, append, sync, and replay.
- `packages/desktop-core/src/snapshot-scheduler.ts`: rotation, worker replay, gzip snapshot, and compaction.
- `packages/desktop-core/src/recovery-scanner.ts`: corruption scanning, recovery candidates, and quarantine.
- `packages/desktop-core/src/asset-store.ts`: streamed staging, hashing, and atomic asset commit.
- `packages/desktop-core/src/novus-pack.ts`: ZIP64 export and isolated validated import.
- `apps/desktop-legacy/` and `apps/desktop-modern/`: thin Electron main/preload/safe-mode shells.
- `apps/renderer/src/app/desktop-persistence.ts`: desktop client and browser fallback.

---

### Task 1: Atomic Project Transactions

**Files:**
- Create: `packages/domain/src/project-transaction.ts`
- Create: `packages/domain/src/project-transaction.test.ts`
- Modify: `packages/domain/src/canvas-transaction.ts`
- Modify: `packages/domain/src/index.ts`

**Interfaces:**
- Consumes: `CanvasOperation`, `CanvasProject`, `ProjectMemoryEntry`, and `SkillPromotionCandidate`.
- Produces: `ProjectOperation`, `ProjectTransaction`, `projectTransactionSchema`, and `applyProjectTransaction(project, transaction)`.

- [ ] **Step 1: Write the failing atomic transaction tests**

```ts
it('applies canvas, memory, and candidate changes atomically', () => {
  const transaction: ProjectTransaction = {
    id: 'tx-1',
    label: 'confirm agent plan',
    operations: [
      { kind: 'canvas', operation: { kind: 'update_node', node: updatedPrompt } },
      { kind: 'append_project_memory', entry: optimizationMemory },
      { kind: 'set_skill_candidates', candidates: [] },
    ],
  };
  const result = applyProjectTransaction(project, transaction);
  expect(result.nodes.find((node) => node.id === updatedPrompt.id)).toEqual(updatedPrompt);
  expect(result.projectMemory[result.projectMemory.length - 1]).toEqual(optimizationMemory);
});

it('rejects the whole transaction when one operation is invalid', () => {
  expect(() => applyProjectTransaction(project, {
    id: 'tx-invalid',
    label: 'invalid mixed change',
    operations: [
      { kind: 'append_project_memory', entry: optimizationMemory },
      { kind: 'canvas', operation: { kind: 'delete_node', nodeId: 'missing' } },
    ],
  })).toThrow(/does not exist/);
  expect(project.projectMemory).toEqual([]);
});
```

- [ ] **Step 2: Verify RED**

Run: `npm test -- packages/domain/src/project-transaction.test.ts`  
Expected: FAIL because the module and exports do not exist.

- [ ] **Step 3: Implement the schemas and reducer**

```ts
export const projectOperationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('canvas'), operation: canvasOperationSchema }).strict(),
  z.object({ kind: z.literal('append_project_memory'), entry: projectMemoryEntrySchema }).strict(),
  z.object({ kind: z.literal('set_skill_candidates'), candidates: z.array(skillPromotionCandidateSchema) }).strict(),
  z.object({
    kind: z.literal('replace_canvas_state'),
    nodes: z.array(canvasNodeSchema),
    edges: z.array(canvasEdgeSchema),
  }).strict(),
]);

export const projectTransactionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  operations: z.array(projectOperationSchema).min(1),
}).strict();

export function applyProjectTransaction(project: CanvasProject, input: ProjectTransaction): CanvasProject {
  const transaction = projectTransactionSchema.parse(input);
  let draft = parseCanvasProject(project);
  for (const operation of transaction.operations) {
    if (operation.kind === 'canvas') {
      draft = applyTransaction(draft, { id: transaction.id, label: transaction.label, operations: [operation.operation] }).project;
    } else if (operation.kind === 'append_project_memory') {
      draft = { ...draft, projectMemory: appendProjectMemoryEntry(draft.projectMemory, operation.entry) };
    } else if (operation.kind === 'set_skill_candidates') {
      draft = parseCanvasProject({ ...draft, skillPromotionCandidates: operation.candidates });
    } else {
      draft = parseCanvasProject({ ...draft, nodes: operation.nodes, edges: operation.edges });
    }
  }
  return parseCanvasProject(draft);
}
```

Export `canvasOperationSchema` from `canvas-transaction.ts`; IPC cannot validate TypeScript-only types.

- [ ] **Step 4: Verify GREEN**

Run: `npm test -- packages/domain/src/project-transaction.test.ts packages/domain/src/canvas-transaction.test.ts packages/domain/src/project-schema.test.ts`  
Expected: all focused domain tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/domain/src/project-transaction.ts packages/domain/src/project-transaction.test.ts packages/domain/src/canvas-transaction.ts packages/domain/src/index.ts
git commit -m "feat: add atomic project transactions"
```

---

### Task 2: Desktop-Core Contracts and Canonical Checksums

**Files:**
- Create: `packages/desktop-core/package.json`
- Create: `packages/desktop-core/tsconfig.json`
- Create: `packages/desktop-core/tsconfig.build.json`
- Create: `packages/desktop-core/src/contracts.ts`
- Create: `packages/desktop-core/src/canonical-json.ts`
- Create: `packages/desktop-core/src/canonical-json.test.ts`
- Create: `packages/desktop-core/src/index.ts`
- Modify: `vitest.workspace.ts`
- Modify: `package.json`

**Interfaces:**
- Produces `ProjectManifest`, `JournalRecord`, `SnapshotEnvelope`, `ProjectLock`, `CommitRequest`, `CommitAck`, `RecoveryPlan`, `PersistenceError`, `canonicalJson`, and `sha256Canonical`.

- [ ] **Step 1: Create the package and failing checksum tests**

```ts
it('canonicalizes object insertion order', () => {
  expect(canonicalJson({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
  expect(sha256Canonical({ b: 2, a: 1 })).toBe(sha256Canonical({ a: 1, b: 2 }));
});

it('rejects non-JSON values', () => {
  expect(() => canonicalJson({ value: undefined })).toThrow(/JSON-safe/);
});
```

Register `packages/desktop-core/src/**/*.test.ts` as a Node Vitest project.

- [ ] **Step 2: Verify RED**

Run: `npm test -- packages/desktop-core/src/canonical-json.test.ts`  
Expected: FAIL because desktop-core does not exist.

- [ ] **Step 3: Implement exact constants and canonical encoding**

```ts
export const PROJECT_FORMAT_VERSION = 1;
export const JOURNAL_SCHEMA_VERSION = 1;
export const SNAPSHOT_SCHEMA_VERSION = 1;
export const LOCK_HEARTBEAT_MS = 5_000;
export const STALE_LOCK_MS = 15_000;
export const SNAPSHOT_TRANSACTION_LIMIT = 200;
export const SNAPSHOT_BYTE_LIMIT = 4 * 1024 * 1024;
```

`canonicalJson` recursively sorts plain-object keys, preserves array order, accepts only JSON-safe finite values, and stringifies the normalized result. `sha256Canonical` hashes UTF-8 with `createHash('sha256')`. Use `tsconfig.json` with `noEmit: true` and `tsconfig.build.json` with `module: NodeNext`, `moduleResolution: NodeNext`, declaration output, and `outDir: dist`. Package exports point to `dist/index.js` and `dist/index.d.ts`. Root `typecheck` checks desktop-core and root `build` builds it before the desktop shells.

- [ ] **Step 4: Verify GREEN**

Run: `npm test -- packages/desktop-core/src/canonical-json.test.ts && npm run typecheck`  
Expected: tests and all TypeScript projects pass.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json vitest.workspace.ts packages/desktop-core
git commit -m "feat: define desktop persistence contracts"
```

---

### Task 3: Project Directory and Locks

**Files:**
- Create: `packages/desktop-core/src/file-system.ts`
- Create: `packages/desktop-core/src/project-repository.ts`
- Create: `packages/desktop-core/src/project-repository.test.ts`

**Interfaces:**
- Produces `NodeFileSystem`, `writeAtomic`, `ProjectRepository.create/open/close/saveAs`, and `OpenedProjectSession`.

- [ ] **Step 1: Write failing real-filesystem tests**

```ts
it('creates the live directory without absolute paths in the manifest', async () => {
  const session = await repository.create(join(tempRoot, 'Demo.novus-project'), starterProject);
  expect(await readdir(session.root)).toEqual(expect.arrayContaining([
    'assets', 'indexes', 'journal', 'project.novus.json', 'recovery', 'snapshots',
  ]));
  expect(JSON.stringify(session.manifest)).not.toContain(tempRoot);
});

it('opens a second writer as read-only while the first lock is live', async () => {
  const first = await repository.open(projectRoot, { mode: 'write' });
  const second = await repository.open(projectRoot, { mode: 'write' });
  expect(first.mode).toBe('write');
  expect(second.mode).toBe('read_only');
});
```

- [ ] **Step 2: Verify RED**

Run: `npm test -- packages/desktop-core/src/project-repository.test.ts`  
Expected: FAIL because repository modules do not exist.

- [ ] **Step 3: Implement atomic files and lock ownership**

`writeAtomic` writes `<target>.tmp-<random>`, calls `FileHandle.sync()`, closes, then renames on the same volume. Creation writes revision-0 snapshot, empty `journal/active.ndjson`, `recovery/clean-close.json`, and manifest.

Open the lock with `open(lockPath, 'wx')` and validate:

```ts
{
  schemaVersion: 1,
  projectId,
  deviceId,
  processId: process.pid,
  channel: 'legacy' | 'modern',
  sessionId,
  openedAt,
  heartbeatAt,
}
```

A live lock returns read-only. Reclaim a local stale lock only after 15 seconds and injected process-liveness verification. Reject unsafe Win7 root-path lengths before writing.

- [ ] **Step 4: Verify GREEN**

Run: `npm test -- packages/desktop-core/src/project-repository.test.ts`  
Expected: create, reopen, read-only lock, stale lock, path-length, and close-cleanup tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/desktop-core/src/file-system.ts packages/desktop-core/src/project-repository.ts packages/desktop-core/src/project-repository.test.ts
git commit -m "feat: add desktop project repository"
```
---

### Task 4: Durable Journal Queue and Replay

**Files:**
- Create: `packages/desktop-core/src/journal-writer.ts`
- Create: `packages/desktop-core/src/journal-writer.test.ts`
- Modify: `packages/desktop-core/src/project-repository.ts`
- Modify: `packages/desktop-core/src/index.ts`

**Interfaces:**
- Consumes `CommitRequest`, `JournalRecord`, `ProjectTransaction`, and `applyProjectTransaction`.
- Produces `JournalWriter.commit`, `readValidJournal`, and `replayJournal`.

- [ ] **Step 1: Write failing durability, idempotency, and conflict tests**

```ts
it('acknowledges only after append and sync complete', async () => {
  const gate = createSyncGate();
  const pending = writer.commit(request, { syncGate: gate });
  await expect(Promise.race([pending, Promise.resolve('not-acked')])).resolves.toBe('not-acked');
  gate.release();
  await expect(pending).resolves.toMatchObject({ transactionId: request.transaction.id, revision: 1 });
});

it('returns the original acknowledgement for a duplicate transaction id', async () => {
  const first = await writer.commit(request);
  const second = await writer.commit(request);
  expect(second).toEqual(first);
  expect((await readValidJournal(activeJournal)).records).toHaveLength(1);
});

it('rejects a stale base revision without appending', async () => {
  await expect(writer.commit({ ...request, baseRevision: 9 }))
    .rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
});
```

- [ ] **Step 2: Verify RED**

Run: `npm test -- packages/desktop-core/src/journal-writer.test.ts`  
Expected: FAIL because journal APIs do not exist.

- [ ] **Step 3: Implement the per-project queue**

Each record is one canonical JSON line plus `\n`. Hash the canonical payload before adding `payloadSha256`. Append through one promise queue per project root and call `FileHandle.sync()` before resolving.

```ts
export interface JournalReadResult {
  records: JournalRecord[];
  validBytes: number;
  tailStatus: 'complete' | 'partial_final_line';
}
```

At open, replay committed transaction IDs for idempotency. Require `baseRevision === currentRevision`. Tolerate only a partial final line; checksum or sequence failure before the tail throws `CORRUPT_JOURNAL`.

- [ ] **Step 4: Verify GREEN**

Run: `npm test -- packages/desktop-core/src/journal-writer.test.ts`  
Expected: durability, duplicate, conflict, partial-tail, corruption, and replay tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/desktop-core/src/journal-writer.ts packages/desktop-core/src/journal-writer.test.ts packages/desktop-core/src/project-repository.ts packages/desktop-core/src/index.ts
git commit -m "feat: add durable project journal"
```

---

### Task 5: Snapshot Rotation, Compaction, and Recovery

**Files:**
- Create: `packages/desktop-core/src/snapshot-worker.ts`
- Create: `packages/desktop-core/src/snapshot-worker-entry.ts`
- Create: `packages/desktop-core/src/snapshot-scheduler.ts`
- Create: `packages/desktop-core/src/snapshot-scheduler.test.ts`
- Create: `packages/desktop-core/src/recovery-scanner.ts`
- Create: `packages/desktop-core/src/recovery-scanner.test.ts`
- Modify: `packages/desktop-core/src/project-repository.ts`

**Interfaces:**
- Produces `SnapshotScheduler.consider/flush` and `RecoveryScanner.scan`.
- `RecoveryPlan.action` is `auto_recover | choose_recovery | read_only | unsupported_version`.

- [ ] **Step 1: Write failing rotation and recovery tests**

```ts
it('rotates before snapshotting and keeps later writes active', async () => {
  const snapshotPromise = scheduler.flush(session, { reason: 'transaction_limit' });
  await writer.commit(nextRequest);
  const snapshot = await snapshotPromise;
  expect(snapshot.revision).toBe(200);
  const activeRecords = (await readValidJournal(session.activeJournal)).records;
  expect(activeRecords[activeRecords.length - 1]?.revision).toBe(201);
});

it('auto-recovers one valid chain with a partial final line', async () => {
  await appendFile(activeJournal, '{"partial":');
  expect(await scanner.scan(projectRoot)).toMatchObject({ action: 'auto_recover', recoveredRevision: 12 });
});

it('requires a choice for corruption before the tail', async () => {
  await corruptMiddleRecord(activeJournal);
  expect(await scanner.scan(projectRoot)).toMatchObject({ action: 'choose_recovery' });
});
```

- [ ] **Step 2: Verify RED**

Run: `npm test -- packages/desktop-core/src/snapshot-scheduler.test.ts packages/desktop-core/src/recovery-scanner.test.ts`  
Expected: FAIL because scheduler and scanner do not exist.

- [ ] **Step 3: Implement immutable snapshots and recovery mirrors**

Rotate `active.ndjson` with same-volume rename and immediately create a new active journal. Worker input is `{ snapshot, records, targetRevision }`; output is canonical project JSON and checksum. Gzip to `snapshots/s-<revision>-<hash8>.json.gz`, decompress and verify, then update the manifest atomically.

Schedule at 200 transactions, 4 MiB, `agent_transaction`, `stable_point`, five idle seconds with pending changes, or normal close. Allow one worker per project.

Recovery validates snapshots newest-to-oldest, replays continuous records, writes candidates to `appData/recovery/<projectId>/<sessionId>/`, and never mutates damaged originals before candidate verification.

- [ ] **Step 4: Verify GREEN**

Run: `npm test -- packages/desktop-core/src/snapshot-scheduler.test.ts packages/desktop-core/src/recovery-scanner.test.ts`  
Expected: rotation, compression, manifest ordering, partial tail, corrupt middle, damaged snapshot, multiple candidate, and one-worker tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/desktop-core/src/snapshot-worker.ts packages/desktop-core/src/snapshot-worker-entry.ts packages/desktop-core/src/snapshot-scheduler.ts packages/desktop-core/src/snapshot-scheduler.test.ts packages/desktop-core/src/recovery-scanner.ts packages/desktop-core/src/recovery-scanner.test.ts packages/desktop-core/src/project-repository.ts
git commit -m "feat: add snapshot and crash recovery"
```

---

### Task 6: Asset Store and Secure NovusPack

**Files:**
- Create: `packages/desktop-core/src/asset-store.ts`
- Create: `packages/desktop-core/src/asset-store.test.ts`
- Create: `packages/desktop-core/src/novus-pack.ts`
- Create: `packages/desktop-core/src/novus-pack.test.ts`
- Modify: `packages/desktop-core/package.json`
- Modify: `packages/desktop-core/src/index.ts`
- Modify: `package-lock.json`

**Interfaces:**
- Produces `AssetStore.stageAndCommit`, `NovusPackExporter.exportRevision`, and `NovusPackImporter.importTo`.
- Default import limits: 50,000 entries, 8 GiB per entry, 100 GiB expanded total, compression ratio at most 200:1.

- [ ] **Step 1: Write failing asset and hostile-package tests**

```ts
it('commits bytes before returning asset metadata', async () => {
  const asset = await store.stageAndCommit(projectRoot, readableFrom(pngBytes));
  expect(asset.relativePath).toMatch(/^assets\/[a-f0-9]{16}\.png$/);
  expect(await readFile(join(projectRoot, asset.relativePath))).toEqual(pngBytes);
});

it.each(['../escape.txt', 'C:/escape.txt', '/escape.txt'])('rejects unsafe path %s', async (entryName) => {
  const pack = await createTestZip([{ name: entryName, bytes: Buffer.from('x') }]);
  await expect(importer.importTo(pack, destination))
    .rejects.toMatchObject({ code: 'PACKAGE_VALIDATION_FAILED' });
});
```

- [ ] **Step 2: Verify RED**

Run: `npm test -- packages/desktop-core/src/asset-store.test.ts packages/desktop-core/src/novus-pack.test.ts`  
Expected: FAIL because asset and package services do not exist.

- [ ] **Step 3: Install ZIP libraries and implement streaming flows**

```bash
npm install -w @agent-canvas/desktop-core archiver@7.0.1 yauzl@3.2.0
npm install -D -w @agent-canvas/desktop-core @types/archiver@6.0.3 @types/yauzl@2.10.3
```

Asset names use the first 16 lowercase SHA-256 hex characters and an allow-listed extension. Export enables ZIP64, writes `novus-package.json`, and pins one verified snapshot revision. Import uses lazy entries and rejects encryption, traversal, absolute paths, symlinks, executable extensions, limits, checksum failures, invalid schemas, and missing references before extraction is promoted.

- [ ] **Step 4: Verify GREEN and redaction**

Run: `npm test -- packages/desktop-core/src/asset-store.test.ts packages/desktop-core/src/novus-pack.test.ts`  
Expected: streaming commit, quarantine, export pinning, inventory, zip-slip, limit, version, and secret-redaction tests pass.

- [ ] **Step 5: Commit**

```bash
git add package-lock.json packages/desktop-core
git commit -m "feat: add assets and novuspack"
```
---

### Task 7: Dual Electron Shells and Typed Bridge

**Files:**
- Create: `apps/desktop-legacy/package.json`
- Create: `apps/desktop-legacy/tsconfig.json`
- Create: `apps/desktop-legacy/src/main.ts`
- Create: `apps/desktop-legacy/src/preload.ts`
- Create: `apps/desktop-legacy/src/safe-mode.html`
- Create: `apps/desktop-legacy/src/safe-mode.ts`
- Create: `apps/desktop-legacy/scripts/copy-static.mjs`
- Create: `apps/desktop-modern/package.json`
- Create: `apps/desktop-modern/tsconfig.json`
- Create: `apps/desktop-modern/src/main.ts`
- Create: `apps/desktop-modern/src/preload.ts`
- Create: `apps/desktop-modern/src/safe-mode.html`
- Create: `apps/desktop-modern/src/safe-mode.ts`
- Create: `apps/desktop-modern/scripts/copy-static.mjs`
- Create: `packages/desktop-core/src/preload-api.ts`
- Create: `packages/desktop-core/src/bridge-handlers.ts`
- Create: `packages/desktop-core/src/bridge-contract.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Exposes only `openProject`, `commit`, `createStablePoint`, `restore`, `exportPack`, `importPack`, `closeProject`, and `getRecoveryPlan`.
- User paths enter through native dialogs and are represented to Renderer by opaque session IDs.

- [ ] **Step 1: Write failing bridge allow-list tests**

```ts
it('does not expose arbitrary filesystem methods', () => {
  expect(Object.keys(createPreloadApi(mockInvoke)).sort()).toEqual([
    'closeProject', 'commit', 'createStablePoint', 'exportPack',
    'getRecoveryPlan', 'importPack', 'openProject', 'restore',
  ]);
});

it('rejects commits outside the active session', async () => {
  await expect(handlers.commit(event, { ...request, sessionId: 'unknown' }))
    .rejects.toMatchObject({ code: 'INVALID_SESSION' });
});
```

- [ ] **Step 2: Verify RED**

Run: `npm test -- packages/desktop-core/src/bridge-contract.test.ts`  
Expected: FAIL because preload and handlers do not exist.

- [ ] **Step 3: Pin both runtimes and create thin shells**

```bash
npm install -D esbuild@0.25.6
npm install -D -w @agent-canvas/desktop-legacy electron@22.3.27
npm install -D -w @agent-canvas/desktop-modern electron@43.1.0
```

Both apps bundle `main.ts` and `preload.ts` with esbuild using `--platform=node --target=node16 --external:electron`; this keeps the sandboxed preload self-contained and compatible with Electron 22. Each `copy-static.mjs` copies `safe-mode.html` into `dist`. Both mains call the same desktop-core handler factory. BrowserWindow uses `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, and the bundled preload. Load renderer `dist/index.html` normally; startup or hydration failure loads local safe-mode HTML.

Safe mode exposes only opening another project, read-only open, stable recovery, disposable-cache clearing, redacted diagnostics export, and folder reveal. It imports no React canvas bundle.

Update root `typecheck` and `build` to include desktop-core and both shells.

- [ ] **Step 4: Verify GREEN and compilation**

Run: `npm test -- packages/desktop-core/src/bridge-contract.test.ts && npm run typecheck && npm run build`  
Expected: bridge tests pass and renderer plus both shells compile.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json apps/desktop-legacy apps/desktop-modern packages/desktop-core/src/preload-api.ts packages/desktop-core/src/bridge-handlers.ts packages/desktop-core/src/bridge-contract.test.ts
git commit -m "feat: add dual desktop runtime shells"
```

---

### Task 8: Renderer Adapter and LocalStorage Migration

**Files:**
- Create: `apps/renderer/src/app/desktop-persistence.ts`
- Create: `apps/renderer/src/app/desktop-persistence.test.ts`
- Create: `apps/renderer/src/types/novus-desktop.d.ts`
- Modify: `apps/renderer/src/app/app-store.ts`
- Modify: `apps/renderer/src/app/app-store.test.ts`
- Modify: `apps/renderer/src/app/project-persistence.ts`
- Modify: `apps/renderer/src/canvas/CanvasWorkspace.tsx`
- Modify: `apps/renderer/src/canvas/CanvasWorkspace.test.tsx`

**Interfaces:**
- Produces `ProjectPersistenceClient.hydrate/commit/stablePoint/restore/close`.
- Desktop mode uses `window.novusDesktop`; browser development uses the current localStorage bundle only as fallback and migration input.

- [ ] **Step 1: Write failing ACK, pointer, conflict, and migration tests**

```ts
it('shows saved only after desktop acknowledgement', async () => {
  const ack = deferred<CommitAck>();
  persistence.commit.mockReturnValue(ack.promise);
  const pending = useAppStore.getState().commitProjectTransaction(transaction);
  expect(useAppStore.getState().saveStatus).toBe('saving');
  ack.resolve({ transactionId: transaction.id, revision: 4, sequence: 4 });
  await pending;
  expect(useAppStore.getState().saveStatus).toBe('saved');
});

it('does not persist on pointermove and commits once on pointerup', () => {
  fireEvent.pointerMove(canvas, { clientX: 100, clientY: 100 });
  expect(persistence.commit).not.toHaveBeenCalled();
  fireEvent.pointerUp(canvas, { clientX: 100, clientY: 100 });
  expect(persistence.commit).toHaveBeenCalledTimes(1);
});

it('removes a v2 localStorage bundle only after desktop import acknowledgement', async () => {
  localStorage.setItem(PROJECT_STORAGE_KEY, legacyBundleJson);
  await migrateLegacyProject(client);
  expect(client.createFromLegacyBundle).toHaveBeenCalledTimes(1);
  expect(localStorage.getItem(PROJECT_STORAGE_KEY)).toBeNull();
});
```

- [ ] **Step 2: Verify RED**

Run: `npm test -- apps/renderer/src/app/desktop-persistence.test.ts apps/renderer/src/app/app-store.test.ts apps/renderer/src/canvas/CanvasWorkspace.test.tsx`  
Expected: FAIL because async desktop persistence and `saving` state do not exist.

- [ ] **Step 3: Route mutations through project transactions**

Change `saveStatus` to `pending | saving | saved | error | read_only`. Add `desktopRevision` and async `commitProjectTransaction`. Agent confirmation commits canvas operations, memory append, and candidate cleanup in one transaction. Undo commits inverse canvas operations plus undo memory. Placement editing emits one final `update_node` transaction at the stable boundary.

Keep `project-persistence.ts` only for browser fallback and one-time migration. Desktop mode never writes localStorage. On `REVISION_CONFLICT`, hydrate the desktop-owned state and show a conflict notice instead of overwriting.

- [ ] **Step 4: Verify GREEN**

Run: `npm test -- apps/renderer/src/app/desktop-persistence.test.ts apps/renderer/src/app/app-store.test.ts apps/renderer/src/canvas/CanvasWorkspace.test.tsx && npm run typecheck`  
Expected: ACK gating, pointer boundary, conflict, migration, Agent transaction, undo, restore, and existing renderer tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/renderer/src/app apps/renderer/src/canvas apps/renderer/src/types
git commit -m "feat: connect renderer to desktop persistence"
```

---

### Task 9: Fault Injection, Performance, and Completion

**Files:**
- Create: `packages/desktop-core/src/test/fault-file-system.ts`
- Create: `packages/desktop-core/src/test/crash-child.ts`
- Create: `packages/desktop-core/src/crash-recovery.integration.test.ts`
- Create: `packages/desktop-core/src/persistence-performance.test.ts`
- Create: `docs/testing/desktop-persistence-matrix.md`
- Modify: `package.json`
- Modify: `docs/superpowers/plans/2026-07-13-agent-memory-reverse-prompt-persistence.md`

**Interfaces:**
- Fault points: `before_append`, `during_append`, `after_append_before_sync`, `after_snapshot_temp`, `before_manifest_replace`, `after_manifest_replace`, `during_compaction`, and `during_export`.

- [ ] **Step 1: Write failing crash and performance assertions**

```ts
it.each(CRASH_POINTS)('recovers only acknowledged transactions after %s', async (point) => {
  const result = await runCrashScenario(point);
  expect(result.recoveredRevision).toBe(result.lastAcknowledgedRevision);
  expect(result.partialTransactionApplied).toBe(false);
});

it('replays 10,000 lightweight transactions within the modern budget', async () => {
  const started = performance.now();
  const result = replayJournal(starterProject, createTransactions(10_000));
  expect(result.revision).toBe(10_000);
  expect(performance.now() - started).toBeLessThan(1_000);
});
```

Keep performance outside default tests under `npm run perf:persistence` so ordinary CI does not hide hardware variance.

- [ ] **Step 2: Verify RED**

Run: `npm test -- packages/desktop-core/src/crash-recovery.integration.test.ts`  
Expected: FAIL until the child process and fault points are wired.

- [ ] **Step 3: Implement the crash harness and manual matrix**

Parent creates a temporary project, spawns `crash-child`, waits for a structured acknowledgement file, kills at the selected point, reopens through `RecoveryScanner`, and compares recovered revision with the last acknowledgement.

Document Windows 7, Windows 10, and Windows 11 rows for create, save, force-kill, automatic recovery, choice recovery, read-only, export, import, Chinese paths, removable storage, 1366x768, and 1440x900. Mark unavailable physical or VM rows `not-run`; never imply they passed.

- [ ] **Step 4: Run complete verification**

```bash
npm test
npm run perf:persistence
npm run typecheck
npm run build
git diff --check
```

Expected: all automated tests pass, the reference-machine replay budget is recorded, both shells compile, and no whitespace errors exist.

Run both desktop shells on the current supported machine. Verify normal canvas load and forced renderer failure safe mode. Capture 1366x768 and 1440x900 screenshots. Do not claim Windows 7 runtime verification without Windows 7 or an approved VM.

- [ ] **Step 5: Update roadmap and commit**

Mark snapshot-plus-journal persistence complete only after automated and available runtime checks pass.

```bash
git add package.json package-lock.json packages/desktop-core/src/test packages/desktop-core/src/crash-recovery.integration.test.ts packages/desktop-core/src/persistence-performance.test.ts docs/testing/desktop-persistence-matrix.md docs/superpowers/plans/2026-07-13-agent-memory-reverse-prompt-persistence.md
git commit -m "test: verify desktop persistence recovery"
```

---

## Plan Completion Checklist

- [ ] Every production behavior starts with a failing test.
- [ ] Normal canvas interaction journals incremental transactions, not full project serialization.
- [ ] Durable acknowledgement gates saved state.
- [ ] Recovery verifies candidates before mutating damaged originals.
- [ ] Renderer receives no arbitrary filesystem primitive.
- [ ] Legacy and Modern compile against identical desktop-core contracts.
- [ ] `.novuspack` validates paths, limits, checksums, schemas, and references before promotion.
- [ ] Tests and diagnostics contain no credentials, raw Base64 images, or private machine paths.
- [ ] Physical and VM runtime results accurately include `not-run` rows.