# Complete Project, Unified History, Photoshop, and Generation UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the screenshot-confirmed generation controls and clean model UI, complete independent project saving and recent-project reopening, unified Comfly/RelayMe image-video history, and Photoshop 2019+ embedded Smart Object import.

**Architecture:** Keep renderer UI dependent on sanitized bridge contracts only. The trusted desktop process owns project roots, recent-project paths, provider result downloads, history media, and Photoshop automation. Extend existing `ProjectRepository`, generation-history store, provider registry, and canvas workbench instead of introducing a second persistence system.

**Tech Stack:** TypeScript, React, Zustand, Electron IPC/preload, Zod, Node filesystem, Vitest, Testing Library, Playwright, Adobe ExtendScript/JSX for Photoshop 2019+.

## Global Constraints

- Preserve the current Figma-derived canvas visual language in light and dark themes.
- Image clarity exposes exactly `2K` and `4K`; legacy `1K` migrates to `2K`.
- Image and video ratio controls use the same icon popover and include `AUTO`.
- Model rows display only checkbox plus model display name.
- Project files never contain credentials, unsafe URLs, raw authorization data, arbitrary scripts, or unrestricted source paths.
- Recent-project paths stay in the trusted desktop process; renderer receives opaque identities and sanitized summaries.
- Comfly and RelayMe image/video outputs use the same durable history pipeline.
- Photoshop target is Windows Photoshop 2019+ and uses embedded Smart Objects only.
- Never submit paid API generation jobs during automated UI acceptance.
- Preserve unrelated user modifications in the dirty worktree.

---

### Task 1: Lock Generation Controls And Clean Model Lists

**Files:**
- Modify: `apps/renderer/src/canvas/ModuleNodeCard.tsx`
- Modify: `apps/renderer/src/canvas/GenerationParameterPopover.tsx`
- Modify: `apps/renderer/src/settings/ProviderModelCatalog.tsx`
- Modify: `apps/renderer/src/styles/figma-hybrid-canvas.css`
- Test: `apps/renderer/src/canvas/ModuleNodeCard.test.tsx`
- Test: `apps/renderer/src/canvas/GenerationParameterPopover.test.tsx`
- Test: `apps/renderer/src/settings/ProviderModelCatalog.test.tsx`
- Test: `apps/renderer/src/settings/SettingsDrawer.test.tsx`
- Test: `tests/e2e/generation-parameter-adaptation.spec.ts`
- Test: `tests/e2e/current-settings-ui.spec.ts`

**Interfaces:**
- Consumes: `ProviderBridgeProfile.constraints`, connected managed image/video dimensions.
- Produces: stable image/video parameter values sent to `runImageGenerationNode` and video generation; model rows with a single checkbox and display name.

- [ ] **Step 1: Add or tighten failing renderer tests for the screenshot contract**

```ts
expect(readGenerationParameterOptions('Image generation resolution')).toEqual(['2K', '4K']);
expect(readGenerationParameterOptions('Image generation aspect ratio')).toContain('AUTO');
expect(readGenerationParameterOptions('Video preview aspect ratio')).toContain('AUTO');
expect(screen.queryByText('模型')).not.toBeInTheDocument();
expect(screen.queryByText(/2K \/ 4K|1\/2\/3\/4 张|秒/u)).not.toBeInTheDocument();
```

- [ ] **Step 2: Run focused tests and confirm any remaining mismatch fails**

Run:

```powershell
npx.cmd vitest run --config vitest.config.ts apps/renderer/src/canvas/ModuleNodeCard.test.tsx apps/renderer/src/canvas/GenerationParameterPopover.test.tsx apps/renderer/src/settings/ProviderModelCatalog.test.tsx apps/renderer/src/settings/SettingsDrawer.test.tsx
```

Expected: existing compliant assertions pass; any stale model-row or 1K behavior fails before production edits.

- [ ] **Step 3: Keep one canonical parameter implementation**

```ts
const IMAGE_RESOLUTION_OPTIONS = ['2K', '4K'] as const;

function normalizeImageResolutionSelection(value: unknown): '2K' | '4K' {
  return value === '4K' ? '4K' : '2K';
}
```

Use `AspectRatioPopover` for both image and video. Keep `AUTO` represented by the current internal compatibility value only at the adapter boundary.

- [ ] **Step 4: Enforce the simple model-row DOM and final spacing**

```tsx
<article role="listitem" className={isEnabled ? 'is-enabled' : undefined}>
  <label className="settings-model-enabled">
    <input type="checkbox" checked={isEnabled} onChange={() => onToggleProfile?.(profile)} />
  </label>
  <span className="settings-model-identity"><strong>{profile.displayName}</strong></span>
</article>
```

Final CSS grid:

```css
.settings-model-list > article {
  display: grid;
  grid-template-columns: 20px minmax(0, 1fr);
  align-items: center;
}
```

- [ ] **Step 5: Run renderer and browser acceptance**

```powershell
npx.cmd vitest run --config vitest.config.ts apps/renderer/src/canvas/ModuleNodeCard.test.tsx apps/renderer/src/canvas/GenerationParameterPopover.test.tsx apps/renderer/src/settings/ProviderModelCatalog.test.tsx apps/renderer/src/settings/SettingsDrawer.test.tsx
npx.cmd playwright test tests/e2e/generation-parameter-adaptation.spec.ts tests/e2e/current-settings-ui.spec.ts
```

Expected: all pass without paid submissions.

- [ ] **Step 6: Commit the parameter and model-list gate**

```powershell
git add apps/renderer/src/canvas/ModuleNodeCard.tsx apps/renderer/src/canvas/GenerationParameterPopover.tsx apps/renderer/src/settings/ProviderModelCatalog.tsx apps/renderer/src/styles/figma-hybrid-canvas.css apps/renderer/src/canvas/ModuleNodeCard.test.tsx apps/renderer/src/canvas/GenerationParameterPopover.test.tsx apps/renderer/src/settings/ProviderModelCatalog.test.tsx apps/renderer/src/settings/SettingsDrawer.test.tsx tests/e2e/generation-parameter-adaptation.spec.ts tests/e2e/current-settings-ui.spec.ts
git commit -m "fix: lock generation parameters and model list layout"
```

---

### Task 2: Add Trusted Recent-Project Catalog Contracts

**Files:**
- Create: `packages/desktop-core/src/recent-project-store.ts`
- Create: `packages/desktop-core/src/recent-project-store.test.ts`
- Modify: `packages/desktop-core/src/contracts.ts`
- Modify: `packages/desktop-core/src/preload-api.ts`
- Modify: `packages/desktop-core/src/index.ts`
- Modify: `packages/desktop-core/src/bridge-handlers.ts`
- Modify: `packages/desktop-core/src/bridge-contract.test.ts`
- Modify: `apps/renderer/src/types/novus-desktop.d.ts`

**Interfaces:**
- Consumes: trusted project roots returned by native create/open dialogs.
- Produces:

```ts
interface RecentProjectSummary {
  recentProjectId: string;
  projectId: string;
  displayName: string;
  lastOpenedAt: string;
  lastSavedAt: string;
  availability: 'available' | 'missing';
  nodeCount: number;
  imageCount: number;
  videoCount: number;
  previewUrl: string | null;
}

interface RecentProjectApi {
  list(): Promise<readonly RecentProjectSummary[]>;
  open(request: { recentProjectId: string; mode: 'write' | 'read_only' }): Promise<OpenProjectBridgeResult | null>;
  remove(request: { recentProjectId: string }): Promise<readonly RecentProjectSummary[]>;
  relocate(request: { recentProjectId: string }): Promise<RecentProjectSummary | null>;
}
```

- [ ] **Step 1: Write failing store tests for safe persistence and missing roots**

```ts
it('stores roots privately and exposes opaque summaries', async () => {
  await store.record({ root: 'D:\\Projects\\Campaign', project });
  const [summary] = await store.list();
  expect(summary).not.toHaveProperty('root');
  expect(JSON.stringify(summary)).not.toContain('D:\\Projects');
});
```

Include newest-first ordering, deduplication by canonical root, remove-without-delete, and missing-root status.

- [ ] **Step 2: Run the new test and verify RED**

```powershell
npx.cmd vitest run --config vitest.config.ts packages/desktop-core/src/recent-project-store.test.ts
```

Expected: FAIL because `recent-project-store.ts` does not exist.

- [ ] **Step 3: Implement the confined store**

Persist a versioned index under app data using atomic JSON writes. Hash canonical roots into opaque `recentProjectId` values. Never return roots through public summaries.

- [ ] **Step 4: Add bridge contracts and preload methods**

Add `recentProjects` to `DesktopBridgeApi` and validate every request with strict schemas. Bridge handlers resolve opaque IDs inside the trusted store before opening or relocating a project.

- [ ] **Step 5: Run contract and security tests**

```powershell
npx.cmd vitest run --config vitest.config.ts packages/desktop-core/src/recent-project-store.test.ts packages/desktop-core/src/bridge-contract.test.ts packages/desktop-core/src/preload-api.test.ts
```

Expected: all pass; serialized renderer results contain no absolute paths.

- [ ] **Step 6: Commit the recent-project contract**

```powershell
git add packages/desktop-core/src/recent-project-store.ts packages/desktop-core/src/recent-project-store.test.ts packages/desktop-core/src/contracts.ts packages/desktop-core/src/preload-api.ts packages/desktop-core/src/index.ts packages/desktop-core/src/bridge-handlers.ts packages/desktop-core/src/bridge-contract.test.ts apps/renderer/src/types/novus-desktop.d.ts
git commit -m "feat: add trusted recent project catalog"
```

---

### Task 3: Persist Complete Project Contents And Preview

**Files:**
- Modify: `packages/desktop-core/src/project-repository.ts`
- Modify: `packages/desktop-core/src/project-repository.test.ts`
- Modify: `packages/desktop-core/src/bridge-handlers.ts`
- Modify: `packages/desktop-core/src/project-image-bridge.test.ts`
- Modify: `packages/desktop-core/src/project-video-bridge.test.ts`
- Modify: `apps/renderer/src/app/desktop-persistence.ts`
- Modify: `apps/renderer/src/app/desktop-persistence.test.ts`
- Modify: `apps/renderer/src/app/app-store.ts`
- Modify: `apps/renderer/src/app/app-store.test.ts`

**Interfaces:**
- Consumes: `CanvasProject.assets`, managed project image/video files, completed result asset IDs, reverse-result node configuration.
- Produces: durable project root with canonical snapshots/journal, complete managed assets, and `preview.png` summary.

- [ ] **Step 1: Add failing restart tests for complete project reopen**

Construct a project containing one uploaded image, one uploaded video, one generated image, one generated video, one reverse result, prompts, generation parameters, positions, and edges. Close and reopen through a fresh repository instance.

```ts
expect(reopened.project).toMatchObject({ nodes: expectedNodes, edges: expectedEdges });
expect(await reopenedAssets()).toEqual(expect.arrayContaining([
  expect.objectContaining({ origin: 'imported' }),
  expect.objectContaining({ origin: 'generated' }),
]));
```

- [ ] **Step 2: Run restart tests and verify RED**

```powershell
npx.cmd vitest run --config vitest.config.ts packages/desktop-core/src/project-repository.test.ts packages/desktop-core/src/project-image-bridge.test.ts packages/desktop-core/src/project-video-bridge.test.ts
```

Expected: new complete-bundle/preview assertions fail.

- [ ] **Step 3: Extend project directory creation without replacing the repository format**

Add managed subdirectories under the existing project root:

```ts
const PROJECT_DIRECTORIES = [
  'assets', 'assets/images', 'assets/videos',
  'generated', 'generated/images', 'generated/videos',
  'reverse/results', 'indexes', 'history',
  'journal', 'journal/archive', 'recovery', 'recovery/quarantine', 'snapshots',
];
```

Keep `project.novus.json`, canonical snapshots, and journal as the source of truth. Generate `preview.png` from a trusted canvas summary rather than embedding renderer screenshots in `project.json`.

- [ ] **Step 4: Make explicit save update recent metadata only after a stable point**

`saveProjectExplicitly()` must create the first project through the native chooser, or create a stable point for an existing session. Record the project in Recent Projects only after the durable operation succeeds.

- [ ] **Step 5: Verify restart, missing media, failure rollback, and secret scanning**

```powershell
npx.cmd vitest run --config vitest.config.ts packages/desktop-core/src/project-repository.test.ts packages/desktop-core/src/project-image-bridge.test.ts packages/desktop-core/src/project-video-bridge.test.ts apps/renderer/src/app/desktop-persistence.test.ts apps/renderer/src/app/app-store.test.ts tests/integration/secret-path-scan.test.ts
```

Expected: all pass; failures retain the previous valid project.

- [ ] **Step 6: Commit complete project persistence**

```powershell
git add packages/desktop-core/src/project-repository.ts packages/desktop-core/src/project-repository.test.ts packages/desktop-core/src/bridge-handlers.ts packages/desktop-core/src/project-image-bridge.test.ts packages/desktop-core/src/project-video-bridge.test.ts apps/renderer/src/app/desktop-persistence.ts apps/renderer/src/app/desktop-persistence.test.ts apps/renderer/src/app/app-store.ts apps/renderer/src/app/app-store.test.ts
git commit -m "feat: persist complete canvas projects"
```

---

### Task 4: Replace Snapshot-Only Popover With Project Manager UI

**Files:**
- Create: `apps/renderer/src/canvas/ProjectManagerPopover.tsx`
- Create: `apps/renderer/src/canvas/ProjectManagerPopover.test.tsx`
- Modify: `apps/renderer/src/canvas/CanvasWorkspace.tsx`
- Modify: `apps/renderer/src/canvas/CanvasWorkspace.test.tsx`
- Modify: `apps/renderer/src/styles/figma-hybrid-canvas.css`
- Test: `tests/e2e/project-save-manager.spec.ts`

**Interfaces:**
- Consumes: `window.novusDesktop.recentProjects`, current project summary, `availableSnapshotIds`.
- Produces: independent Recent Projects list and separate collapsed Recovery Versions section.

- [ ] **Step 1: Write failing component tests for the approved hierarchy**

```tsx
expect(screen.getByRole('region', { name: '最近项目' })).toBeVisible();
expect(screen.getByRole('button', { name: '打开 Campaign A' })).toBeVisible();
expect(screen.getByText('项目不存在')).toBeVisible();
expect(screen.getByRole('button', { name: '展开恢复版本' })).toHaveAttribute('aria-expanded', 'false');
```

- [ ] **Step 2: Verify RED**

```powershell
npx.cmd vitest run --config vitest.config.ts apps/renderer/src/canvas/ProjectManagerPopover.test.tsx apps/renderer/src/canvas/CanvasWorkspace.test.tsx -t "recent projects|project manager|save project"
```

Expected: FAIL because the new popover does not exist.

- [ ] **Step 3: Implement the focused popover component**

Render project thumbnail, name, updated time, counts, and missing state. Keep recovery versions in a closed `<details>` section by default. Use the existing canvas surface tokens, spacing, border, and theme variables.

- [ ] **Step 4: Wire save, reopen, remove, and relocate actions**

Opening a recent project closes settings, history, Agent, quick insert, and module library. A missing project cannot invoke open. Removing a recent entry does not delete files.

- [ ] **Step 5: Add browser acceptance with mocked recent projects**

The E2E test creates and saves two independent projects through the manual acceptance bridge, opens the chevron, verifies both entries, reopens the first, and confirms its nodes and media summaries return.

- [ ] **Step 6: Run UI tests in light and dark themes**

```powershell
npx.cmd vitest run --config vitest.config.ts apps/renderer/src/canvas/ProjectManagerPopover.test.tsx apps/renderer/src/canvas/CanvasWorkspace.test.tsx
npx.cmd playwright test tests/e2e/project-save-manager.spec.ts
```

Expected: all pass with screenshots for both themes.

- [ ] **Step 7: Commit project manager UI**

```powershell
git add apps/renderer/src/canvas/ProjectManagerPopover.tsx apps/renderer/src/canvas/ProjectManagerPopover.test.tsx apps/renderer/src/canvas/CanvasWorkspace.tsx apps/renderer/src/canvas/CanvasWorkspace.test.tsx apps/renderer/src/styles/figma-hybrid-canvas.css tests/e2e/project-save-manager.spec.ts
git commit -m "feat: add recent project manager"
```

---

### Task 5: Unify Comfly And RelayMe Image/Video History

**Files:**
- Modify: `packages/domain/src/generation-history.ts`
- Modify: `packages/domain/src/generation-history.test.ts`
- Modify: `packages/desktop-core/src/generation-history-provider-sink.ts`
- Modify: `packages/desktop-core/src/generation-history-provider.integration.test.ts`
- Modify: `packages/desktop-core/src/generation-history-store.ts`
- Modify: `packages/desktop-core/src/generation-history-store.test.ts`
- Modify: `packages/desktop-core/src/relayme-provider-service.ts`
- Modify: `packages/desktop-core/src/relayme-provider-service.test.ts`
- Modify: `apps/desktop-modern/src/main.ts`
- Modify: `apps/desktop-legacy/src/main.ts`
- Modify: `apps/renderer/src/history/GenerationHistoryDrawer.tsx`
- Modify: `apps/renderer/src/history/GenerationHistoryDrawer.test.tsx`
- Test: `tests/e2e/generation-history-provider-results.spec.ts`

**Interfaces:**
- Consumes: completed Comfly/RelayMe image and video provider outputs.
- Produces a schema-versioned history record with `kind: 'image' | 'video'` and a matching managed output descriptor.

```ts
type GenerationHistoryOutput =
  | { kind: 'image'; width: number; height: number; format: 'gif' | 'jpg' | 'png' | 'webp'; mediaType: string; historyAssetId: string; byteSize: number; sha256: string; availability: HistoryAvailability }
  | { kind: 'video'; width: number; height: number; durationMs: number; format: 'mp4'; mediaType: 'video/mp4'; historyAssetId: string; posterHistoryAssetId: string | null; byteSize: number; sha256: string; availability: HistoryAvailability };
```

- [ ] **Step 1: Write failing domain migration tests**

Add schema migration from image-only version 1 records to version 2 image records. Reject video outputs without MP4 media type or positive duration.

- [ ] **Step 2: Run domain tests and verify RED**

```powershell
npx.cmd vitest run --config vitest.config.ts packages/domain/src/generation-history.test.ts
```

Expected: FAIL because `kind` and video outputs are unsupported.

- [ ] **Step 3: Extend the sink and store for video bytes and posters**

Keep existing image decoding. For MP4 results, store the original MP4, read confined metadata, and optionally create a trusted poster. Do not decode video in the renderer.

- [ ] **Step 4: Inject the same history sink into RelayMe**

Add a `historySink` option to `createRelayMeProviderService`. Reserve, transition, and terminalize history with the same durable job ID rules used by Comfly. Both desktop entry points pass the shared `GenerationHistoryProviderSink` instance to both providers.

- [ ] **Step 5: Update history UI to real image/video filtering**

Replace hard-coded counts with derived totals. Render `<img>` for images and a poster/play affordance for videos. Disable image-only compare for video records.

- [ ] **Step 6: Run provider, store, UI, and restart tests**

```powershell
npx.cmd vitest run --config vitest.config.ts packages/domain/src/generation-history.test.ts packages/desktop-core/src/generation-history-provider.integration.test.ts packages/desktop-core/src/generation-history-store.test.ts packages/desktop-core/src/relayme-provider-service.test.ts apps/renderer/src/history/GenerationHistoryDrawer.test.tsx
```

Expected: all pass; Comfly and RelayMe image/video fixtures appear in history without paid calls.

- [ ] **Step 7: Run E2E history acceptance**

```powershell
npx.cmd playwright test tests/e2e/generation-history-provider-results.spec.ts
```

Expected: real managed thumbnails/posters, dates, model names, and project names are visible.

- [ ] **Step 8: Commit unified history**

```powershell
git add packages/domain/src/generation-history.ts packages/domain/src/generation-history.test.ts packages/desktop-core/src/generation-history-provider-sink.ts packages/desktop-core/src/generation-history-provider.integration.test.ts packages/desktop-core/src/generation-history-store.ts packages/desktop-core/src/generation-history-store.test.ts packages/desktop-core/src/relayme-provider-service.ts packages/desktop-core/src/relayme-provider-service.test.ts apps/desktop-modern/src/main.ts apps/desktop-legacy/src/main.ts apps/renderer/src/history/GenerationHistoryDrawer.tsx apps/renderer/src/history/GenerationHistoryDrawer.test.tsx tests/e2e/generation-history-provider-results.spec.ts
git commit -m "feat: unify provider image and video history"
```

---

### Task 6: Add Photoshop 2019+ Embedded Smart Object Bridge

**Files:**
- Create: `packages/desktop-core/src/photoshop-smart-object.ts`
- Create: `packages/desktop-core/src/photoshop-smart-object.test.ts`
- Modify: `packages/desktop-core/src/contracts.ts`
- Modify: `packages/desktop-core/src/preload-api.ts`
- Modify: `packages/desktop-core/src/bridge-handlers.ts`
- Modify: `packages/desktop-core/src/index.ts`
- Modify: `apps/desktop-modern/src/main.ts`
- Modify: `apps/desktop-legacy/src/main.ts`
- Modify: `apps/renderer/src/types/novus-desktop.d.ts`
- Modify: `apps/renderer/src/canvas/ModuleNodeCard.tsx`
- Modify: `apps/renderer/src/canvas/ModuleNodeCard.test.tsx`
- Test: `tests/e2e/photoshop-context-menu.spec.ts`

**Interfaces:**
- Consumes: active project/session ID and managed generated-image asset ID.
- Produces:

```ts
interface PhotoshopStatus {
  installed: boolean;
  running: boolean;
  supported: boolean;
  version: string | null;
  activeDocument: boolean;
}

interface PhotoshopSmartObjectApi {
  getStatus(): Promise<PhotoshopStatus>;
  placeEmbedded(request: { sessionId: string; assetId: string }): Promise<{
    placed: true;
    documentName: string;
    layerName: string;
  }>;
}
```

- [ ] **Step 1: Write failing adapter tests with a fake Photoshop runner**

Cover version parsing, missing installation, no active document, asset confinement, safe JSX escaping, original-size placement, proportional fit, centering, and sanitized errors.

- [ ] **Step 2: Verify RED**

```powershell
npx.cmd vitest run --config vitest.config.ts packages/desktop-core/src/photoshop-smart-object.test.ts
```

Expected: FAIL because the adapter does not exist.

- [ ] **Step 3: Implement confined Photoshop discovery and JSX generation**

The adapter resolves supported Photoshop executables from allowlisted Windows installation locations or a verified running process. It generates an internal JSX script that performs Place Embedded, reads document bounds, scales down only when oversized, preserves aspect ratio, centers the layer, and renames it safely.

Renderer input never supplies an executable path, image path, or script.

- [ ] **Step 4: Add strict IPC and preload contracts**

Validate `sessionId` and `assetId`, resolve the original managed image inside desktop core, and return only sanitized status/result values.

- [ ] **Step 5: Enable the generated-image context-menu action**

Replace the disabled placeholder with a capability-driven action. Show actionable Chinese errors for missing Photoshop, unsupported version, no document, missing asset, and placement failure.

- [ ] **Step 6: Run adapter, bridge, and renderer tests**

```powershell
npx.cmd vitest run --config vitest.config.ts packages/desktop-core/src/photoshop-smart-object.test.ts packages/desktop-core/src/bridge-contract.test.ts apps/renderer/src/canvas/ModuleNodeCard.test.tsx -t "Photoshop|context menu|generated image"
```

Expected: all pass without launching the real Photoshop application.

- [ ] **Step 7: Run manual Photoshop 2019+ acceptance**

Open a PSD, right-click a generated image, select **导入 Photoshop（智能对象）**, and confirm:

- one embedded Smart Object layer appears;
- aspect ratio is preserved;
- small image keeps original pixels;
- oversized image fits proportionally;
- layer is centered;
- moving the Canvas Atelier project does not break the layer.

- [ ] **Step 8: Commit Photoshop integration**

```powershell
git add packages/desktop-core/src/photoshop-smart-object.ts packages/desktop-core/src/photoshop-smart-object.test.ts packages/desktop-core/src/contracts.ts packages/desktop-core/src/preload-api.ts packages/desktop-core/src/bridge-handlers.ts packages/desktop-core/src/index.ts apps/desktop-modern/src/main.ts apps/desktop-legacy/src/main.ts apps/renderer/src/types/novus-desktop.d.ts apps/renderer/src/canvas/ModuleNodeCard.tsx apps/renderer/src/canvas/ModuleNodeCard.test.tsx tests/e2e/photoshop-context-menu.spec.ts
git commit -m "feat: import generated images as Photoshop smart objects"
```

---

### Task 7: Full Regression, Visual Inspection, And Release Gate

**Files:**
- Modify only if failures require scoped fixes: files touched in Tasks 1-6.
- Create: `artifacts/2026-08-10-complete-project-release/` screenshots and evidence.
- Create: `docs/qa/2026-08-10-complete-project-release-gate.md`
- Test: `tests/e2e/release-ui-audit.spec.ts`
- Test: `tests/e2e/project-save-manager.spec.ts`
- Test: `tests/e2e/generation-history-provider-results.spec.ts`
- Test: `tests/e2e/photoshop-context-menu.spec.ts`

**Interfaces:**
- Consumes: all completed features.
- Produces: verified build and user-reviewable light/dark screenshots before packaging.

- [ ] **Step 1: Run all focused unit and integration suites**

```powershell
npx.cmd vitest run --config vitest.config.ts apps/renderer/src/canvas/ModuleNodeCard.test.tsx apps/renderer/src/settings/SettingsDrawer.test.tsx apps/renderer/src/settings/ProviderModelCatalog.test.tsx apps/renderer/src/history/GenerationHistoryDrawer.test.tsx apps/renderer/src/canvas/ProjectManagerPopover.test.tsx packages/domain/src/generation-history.test.ts packages/desktop-core/src/project-repository.test.ts packages/desktop-core/src/recent-project-store.test.ts packages/desktop-core/src/generation-history-provider.integration.test.ts packages/desktop-core/src/photoshop-smart-object.test.ts
```

Expected: zero failures.

- [ ] **Step 2: Run typecheck and production build**

```powershell
npm.cmd run typecheck
npm.cmd run build
```

Expected: exit code 0. Record existing non-blocking bundle warnings separately.

- [ ] **Step 3: Run browser interaction acceptance without paid jobs**

```powershell
npx.cmd playwright test tests/e2e/generation-parameter-adaptation.spec.ts tests/e2e/current-settings-ui.spec.ts tests/e2e/project-save-manager.spec.ts tests/e2e/generation-history-provider-results.spec.ts tests/e2e/photoshop-context-menu.spec.ts
```

Expected: zero failures.

- [ ] **Step 4: Capture and inspect light/dark screenshots**

Capture:

1. image ratio menu;
2. image 2K/4K clarity menu;
3. video ratio menu;
4. clean settings model lists;
5. recent-project manager with two projects;
6. recovery versions separated;
7. image history with Comfly and RelayMe results;
8. video history with posters;
9. generated-image right-click menu with Photoshop action.

Reject screenshots with clipping, overlapping text, wrong spacing, missing thumbnails, or inconsistent theme colors.

- [ ] **Step 5: Run desktop manual acceptance**

Verify native first-save chooser, repeated save, restart/reopen, missing-project relocation, original managed media, and Photoshop Smart Object placement.

- [ ] **Step 6: Present the local test build and screenshots to the user**

Do not package the installer until the user approves the checked interface and manual desktop results.

- [ ] **Step 7: Record and commit the release-gate evidence**

Write `docs/qa/2026-08-10-complete-project-release-gate.md` with the exact commands, pass/fail counts, desktop manual checks, screenshot filenames, and any remaining non-blocking warnings. Scoped production fixes discovered during this task must be committed in the owning Task 1-6 commit before this evidence commit.

```powershell
git add docs/qa/2026-08-10-complete-project-release-gate.md
git commit -m "test: record complete project release gate"
```

Expected: only the QA evidence document is staged for this commit; no unrelated dirty-worktree files are included.