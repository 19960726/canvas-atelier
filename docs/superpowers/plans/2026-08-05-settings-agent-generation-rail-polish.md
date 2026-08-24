# Settings, Agent, Generation, and Rail Polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the desktop canvas match the approved settings, Agent composer, generation-card, connected-media-slot, and left-rail behavior in both light and dark themes without packaging an installer yet.

**Architecture:** Add cache-directory ownership to the typed desktop bridge and main-process services, keep React as a view/controller, and reuse the existing managed project-media importer for Agent references. Store image clarity as `1K | 2K | 4K`, map it at the provider boundary, and derive visible media slots from the same connected asset IDs used by requests.

**Tech Stack:** TypeScript 5.8, React, Zustand, Zod, Electron IPC/preload, Vitest, Testing Library, Playwright, CSS.

## Global Constraints

- Keep only `API 与模型`, `存储与备份`, `MCP 联动`, and `同步`; remove `使用说明`.
- Cache changes use copy/verify/switch/cleanup. Cancellation or failure keeps the old path authoritative.
- Never move/delete project originals, history originals, exports, or source media during cache migration/cleanup.
- Browser/E2E mode shows native directory actions as unavailable.
- Knowledge choices are exactly `场景 Skill` and `电商详情页知识库`; sync state never disables selection.
- Agent uploads use managed asset IDs; no raw paths or base64 enter chat context.
- Image clarity choices are exactly `1K`, `2K`, `4K`.
- Collapsed image/video cards show neither `待配置` nor `生成数量 · n / 4`.
- Connected slots show actual image thumbnails/video posters collapsed and expanded.
- Left rail uses 44px controls, 58px clear gaps, 102px rhythm, and seven actions in both themes.
- Do not package an installer; finish with UI/function tests and screenshots.
- Preserve unrelated dirty-worktree changes; commits stage only task files.

---

### Task 1: Safe cache-directory service and typed desktop bridge

**Files:**
- Create: `packages/desktop-core/src/cache-directory-service.ts`
- Create: `packages/desktop-core/src/cache-directory-service.test.ts`
- Modify: `packages/desktop-core/src/preload-api.ts`
- Modify: `packages/desktop-core/src/bridge-contract.test.ts`
- Modify: `packages/desktop-core/src/index.ts`
- Modify: `apps/desktop-modern/src/main.ts`
- Modify: `apps/desktop-modern/src/preload.ts`
- Modify: `apps/desktop-legacy/src/main.ts`
- Modify: `apps/desktop-legacy/src/preload.ts`
- Modify: `apps/desktop-modern/src/runtime-entry-contract.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface CacheDirectoryState {
    readonly path: string;
    readonly isDefault: boolean;
    readonly available: boolean;
    readonly busy: boolean;
    readonly error: string | null;
  }
  export interface DesktopStorageBridgeApi {
    getCacheDirectory(): Promise<CacheDirectoryState>;
    chooseCacheDirectory(): Promise<CacheDirectoryState | null>;
    resetCacheDirectory(): Promise<CacheDirectoryState>;
    openCacheDirectory(): Promise<{ opened: boolean }>;
  }
  ```
- Consumes: Electron directory dialog/shell, app-data path, and a dedicated regenerable cache root; never `GenerationHistoryStore.historyRoot`.

- [ ] **Step 1: Write failing service tests**

  ```ts
  it('copies and verifies before switching', async () => {
    const service = createCacheDirectoryService(testAdapters({ selectedPath: customRoot }));
    await seedFile(defaultRoot, 'thumbs/a.webp', 'image');
    expect((await service.chooseCacheDirectory())?.path).toBe(customRoot);
    expect(await readFile(join(customRoot, 'thumbs/a.webp'), 'utf8')).toBe('image');
  });
  it('rolls back when verification fails', async () => {
    const service = createCacheDirectoryService(testAdapters({ selectedPath: customRoot, failVerification: true }));
    await expect(service.chooseCacheDirectory()).rejects.toThrow('CACHE_MIGRATION_FAILED');
    expect((await service.getCacheDirectory()).path).toBe(defaultRoot);
  });
  it('returns null when selection is cancelled', async () => {
    await expect(createCacheDirectoryService(testAdapters({ selectedPath: null })).chooseCacheDirectory()).resolves.toBeNull();
  });
  ```

- [ ] **Step 2: Run RED test**

  Run: `npm.cmd test -- packages/desktop-core/src/cache-directory-service.test.ts`

  Expected: FAIL because the service does not exist.

- [ ] **Step 3: Implement injected, atomic cache migration**

  ```ts
  export interface CacheDirectoryServiceAdapters {
    readonly defaultCacheRoot: string;
    readonly stateFilePath: string;
    chooseDirectory(): Promise<string | null>;
    openDirectory(path: string): Promise<boolean>;
    copyDirectory(source: string, target: string): Promise<void>;
    verifyDirectoryCopy(source: string, target: string): Promise<void>;
    removeDirectory(path: string): Promise<void>;
    ensureDirectory(path: string): Promise<void>;
    readConfiguredPath(): Promise<string | null>;
    writeConfiguredPathAtomically(path: string | null): Promise<void>;
  }
  ```

  Validate non-root directories, copy to a temporary sibling, verify inventory/sizes, switch atomically, persist atomically, then remove only the old dedicated cache. On failure remove only the temporary copy.

- [ ] **Step 4: Add typed channels and preload API**

  ```ts
  storage: {
    getCacheDirectory: 'novus-desktop:storage:get-cache-directory',
    chooseCacheDirectory: 'novus-desktop:storage:choose-cache-directory',
    resetCacheDirectory: 'novus-desktop:storage:reset-cache-directory',
    openCacheDirectory: 'novus-desktop:storage:open-cache-directory',
  },
  ```

  Test exact channel invocation and cloned results.

- [ ] **Step 5: Register identical handlers in both desktop entries**

  Use `app.getPath('userData')`, `dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })`, and `shell.openPath`. Return stable errors without logging private paths.

- [ ] **Step 6: Verify**

  ```powershell
  npm.cmd test -- packages/desktop-core/src/cache-directory-service.test.ts packages/desktop-core/src/bridge-contract.test.ts apps/desktop-modern/src/runtime-entry-contract.test.ts
  npm.cmd run typecheck
  ```

  Expected: PASS and exit 0.

- [ ] **Step 7: Commit**

  ```powershell
  git add packages/desktop-core/src/cache-directory-service.ts packages/desktop-core/src/cache-directory-service.test.ts packages/desktop-core/src/preload-api.ts packages/desktop-core/src/bridge-contract.test.ts packages/desktop-core/src/index.ts apps/desktop-modern/src/main.ts apps/desktop-modern/src/preload.ts apps/desktop-legacy/src/main.ts apps/desktop-legacy/src/preload.ts apps/desktop-modern/src/runtime-entry-contract.test.ts
  git commit -m "feat: add safe cache directory selection"
  ```

---

### Task 2: Four-tab settings UI and diagnostics

**Files:**
- Modify: `apps/renderer/src/settings/SettingsDrawer.tsx`
- Modify: `apps/renderer/src/settings/SettingsDrawer.test.tsx`
- Modify: `apps/renderer/src/styles/figma-hybrid-canvas.css`
- Modify: `tests/e2e/current-settings-ui.spec.ts`

**Interfaces:**
- Consumes: `window.novusDesktop?.storage` from Task 1.
- Produces: four tabs, cache-path actions, and compact diagnostics cards.

- [ ] **Step 1: Write failing component tests**

  ```tsx
  expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
    'API 与模型', '存储与备份', 'MCP 联动', '同步',
  ]);
  expect(screen.queryByRole('tab', { name: '使用说明' })).not.toBeInTheDocument();
  await user.click(screen.getByRole('tab', { name: '存储与备份' }));
  expect(screen.getByLabelText('当前缓存目录')).toHaveValue('D:\\NovusCache');
  await user.click(screen.getByRole('button', { name: '自定义目录' }));
  expect(storage.chooseCacheDirectory).toHaveBeenCalledOnce();
  expect(screen.getByRole('region', { name: '连接与恢复' })).toBeInTheDocument();
  expect(screen.getByRole('region', { name: '应用更新' })).toBeInTheDocument();
  ```

  Add a browser-mode test: value `桌面版可用`, native buttons disabled.

- [ ] **Step 2: Run RED test**

  Run: `npm.cmd test -- apps/renderer/src/settings/SettingsDrawer.test.tsx`

  Expected: FAIL because five tabs/static storage/old diagnostics remain.

- [ ] **Step 3: Implement settings controller**

  ```ts
  type SettingsTab = 'api' | 'storage' | 'mcp' | 'sync';
  type CacheAction = 'choose' | 'open' | 'reset' | null;
  ```

  Load cache state on open; allow one busy action; cancellation leaves state unchanged; errors stay inside the storage card. Wire `打开缓存目录`, `自定义目录`, `恢复默认目录`. Delete guide branches/imports. Preserve the existing cache capacity and purge controls.

- [ ] **Step 4: Render compact diagnostics**

  ```tsx
  <section className="settings-diagnostics-grid" aria-label="高级诊断">
    <article className="settings-status-card" role="region" aria-label="连接与恢复">...</article>
    <article className="settings-status-card" role="region" aria-label="应用更新">...</article>
  </section>
  ```

  Preserve current unlock/check/update callbacks and feedback.

- [ ] **Step 5: Add shared light/dark geometry**

  ```css
  .settings-diagnostics-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; }
  .settings-status-card { min-height:168px; padding:16px; border:1px solid var(--settings-border); border-radius:14px; }
  .settings-status-card button { min-height:36px; display:inline-flex; align-items:center; justify-content:center; }
  ```

- [ ] **Step 6: Verify and commit**

  ```powershell
  npm.cmd test -- apps/renderer/src/settings/SettingsDrawer.test.tsx
  npm.cmd run e2e -- tests/e2e/current-settings-ui.spec.ts --project=chromium
  git add apps/renderer/src/settings/SettingsDrawer.tsx apps/renderer/src/settings/SettingsDrawer.test.tsx apps/renderer/src/styles/figma-hybrid-canvas.css tests/e2e/current-settings-ui.spec.ts
  git commit -m "feat: polish storage and diagnostics settings"
  ```

---

### Task 3: Agent knowledge selection and managed image upload

**Files:**
- Modify: `packages/desktop-core/src/contracts.ts`
- Modify: `packages/desktop-core/src/bridge-handlers.ts`
- Modify: `packages/desktop-core/src/project-image-bridge.test.ts`
- Modify: `apps/renderer/src/app/desktop-persistence.ts`
- Modify: `apps/renderer/src/app/desktop-persistence.test.ts`
- Modify: `apps/renderer/src/app/app-store.ts`
- Modify: `apps/renderer/src/app/app-store.test.ts`
- Modify: `apps/renderer/src/canvas/CanvasWorkspace.tsx`
- Modify: `apps/renderer/src/agent/SkillChatWorkbench.tsx`
- Modify: `apps/renderer/src/agent/SkillChatWorkbench.test.tsx`
- Modify: `tests/e2e/current-agent-knowledge-ui.spec.ts`

**Interfaces:**
- Produces:
  ```ts
  export type ProjectImageImportTarget =
    | { readonly kind: 'module'; readonly nodeId: string }
    | { readonly kind: 'reverse_agent'; readonly nodeId: string }
    | { readonly kind: 'agent_reference' };
  importAgentReferenceImage(file?: File): Promise<ProjectImageAssetSummary | null>;
  interface SkillChatWorkbenchProps {
    readonly onImportReferenceImage?: () => Promise<SkillChatReferenceImage | null>;
  }
  ```
- Consumes: confined image picker, managed project images, profile capabilities, and chat request knowledge/media IDs.

- [ ] **Step 1: Write failing knowledge-selection test**

  ```tsx
  await user.click(screen.getByRole('button', { name: '选择知识库' }));
  await user.click(screen.getByRole('button', { name: /场景 Skill/ }));
  await user.click(screen.getByRole('button', { name: /电商详情页知识库/ }));
  await user.type(screen.getByRole('textbox', { name: 'Agent 消息' }), '分析这张图');
  await user.click(screen.getByRole('button', { name: '发送' }));
  expect(chat).toHaveBeenCalledWith(expect.objectContaining({
    context: expect.objectContaining({ knowledgeBaseIds: ['scene-skill', 'ecommerce-detail-knowledge'] }),
  }));
  ```

  Run with `knowledgeBases={[]}` to prove unsynced choices remain selectable.

- [ ] **Step 2: Write failing upload tests**

  ```tsx
  const onImportReferenceImage = vi.fn().mockResolvedValue({
    assetId: 'image-1', label: 'reference.png', displayUrl: 'novus-asset://image-1',
  });
  await user.click(screen.getByRole('button', { name: '添加素材' }));
  expect(onImportReferenceImage).toHaveBeenCalledOnce();
  expect(screen.getByText('reference.png')).toBeInTheDocument();
  ```

  Cover cancellation, import error, vision attachment, and text-only message `当前模型不支持图片，请切换视觉模型后再引用`.

- [ ] **Step 3: Run RED tests**

  ```powershell
  npm.cmd test -- packages/desktop-core/src/project-image-bridge.test.ts apps/renderer/src/app/desktop-persistence.test.ts apps/renderer/src/app/app-store.test.ts apps/renderer/src/agent/SkillChatWorkbench.test.tsx
  ```

  Expected: FAIL because `agent_reference`/callback do not exist and `添加素材` is disabled.

- [ ] **Step 4: Add library-only import target**

  Validate `agent_reference`, register the managed asset, perform no node patch, and return the existing result. Keep module/reverse-agent behavior unchanged.

- [ ] **Step 5: Add store/workspace callback**

  ```ts
  importAgentReferenceImage: async (file) => {
    const result = await persistence.importProjectImage({ kind: 'agent_reference' }, file);
    if (result === null) return null;
    await get().refreshProjectImages();
    return get().projectImages.find((asset) => asset.assetId === result.asset.assetId) ?? result.asset;
  },
  ```

  Pass it from `CanvasWorkspace` to `SkillChatWorkbench`.

- [ ] **Step 6: Enable knowledge/upload controls**

  Remove disabled attributes from approved knowledge choices; show sync as secondary copy. Enable `添加素材`; attach imports only for vision profiles, preserve imported text-only assets, and display controlled errors.

- [ ] **Step 7: Verify and commit**

  ```powershell
  npm.cmd test -- packages/desktop-core/src/project-image-bridge.test.ts apps/renderer/src/app/desktop-persistence.test.ts apps/renderer/src/app/app-store.test.ts apps/renderer/src/agent/SkillChatWorkbench.test.tsx
  npm.cmd run e2e -- tests/e2e/current-agent-knowledge-ui.spec.ts --project=chromium
  git add packages/desktop-core/src/contracts.ts packages/desktop-core/src/bridge-handlers.ts packages/desktop-core/src/project-image-bridge.test.ts apps/renderer/src/app/desktop-persistence.ts apps/renderer/src/app/desktop-persistence.test.ts apps/renderer/src/app/app-store.ts apps/renderer/src/app/app-store.test.ts apps/renderer/src/canvas/CanvasWorkspace.tsx apps/renderer/src/agent/SkillChatWorkbench.tsx apps/renderer/src/agent/SkillChatWorkbench.test.tsx tests/e2e/current-agent-knowledge-ui.spec.ts
  git commit -m "feat: enable agent knowledge and image references"
  ```

---

### Task 4: Stable 1K/2K/4K image-resolution tiers

**Files:**
- Modify: `packages/domain/src/model-job.ts`
- Modify: `packages/domain/src/model-job.test.ts`
- Modify: `packages/domain/src/canvas-module.ts`
- Modify: `packages/domain/src/canvas-module.test.ts`
- Modify: `packages/desktop-core/src/provider-contracts.ts`
- Modify: `packages/desktop-core/src/provider-bridge.test.ts`
- Modify: `packages/provider-comfly/src/client.ts`
- Modify: `packages/provider-comfly/src/client.test.ts`
- Modify: `apps/renderer/src/canvas/ModuleNodeCard.tsx`
- Modify: `apps/renderer/src/canvas/ModuleNodeCard.test.tsx`
- Modify: `apps/renderer/src/jobs/desktop-model-executor.ts`

**Interfaces:**
- Produces:
  ```ts
  export const imageResolutionTierSchema = z.enum(['1K', '2K', '4K']);
  export type ImageResolutionTier = z.infer<typeof imageResolutionTierSchema>;
  export function normalizeImageResolutionTier(value: unknown): ImageResolutionTier;
  export function mapImageResolutionTier(tier: ImageResolutionTier, aspectRatio: ImageAspectRatio): { width: number; height: number };
  ```
- Consumes: legacy `1024x1024`, `1536x1024`, `1024x1536` values and provider-specific dimensions.

- [ ] **Step 1: Write failing normalization/mapping tests**

  ```ts
  it.each([
    ['1K', '1K'], ['2K', '2K'], ['4K', '4K'],
    ['1024x1024', '1K'], ['1536x1024', '2K'], ['1024x1536', '2K'],
    [undefined, '1K'],
  ])('normalizes %s to %s', (input, expected) => {
    expect(normalizeImageResolutionTier(input)).toBe(expected);
  });
  expect(mapImageResolutionTier('4K', '16:9')).toEqual({ width: 3840, height: 2160 });
  expect(mapImageResolutionTier('2K', '9:16')).toEqual({ width: 1152, height: 2048 });
  ```

- [ ] **Step 2: Write failing UI/provider tests**

  Assert selector options are exactly `1K`, `2K`, `4K`; selecting `4K` updates node config and the bridge request carries `resolution: '4K'` before provider mapping.

- [ ] **Step 3: Run RED tests**

  ```powershell
  npm.cmd test -- packages/domain/src/model-job.test.ts packages/domain/src/canvas-module.test.ts packages/desktop-core/src/provider-bridge.test.ts packages/provider-comfly/src/client.test.ts apps/renderer/src/canvas/ModuleNodeCard.test.tsx
  ```

  Expected: FAIL because schemas still use raw dimensions and UI includes `自动尺寸`.

- [ ] **Step 4: Implement tier storage and legacy hydration**

  Store tiers for new requests. Normalize supported legacy dimensions during hydration so old projects continue loading.

- [ ] **Step 5: Map tiers at the provider boundary**

  Convert tier plus aspect ratio into provider-supported size/quality. If a route cannot deliver native 4K, return the existing capability error rather than mislabelling lower output.

- [ ] **Step 6: Render one clarity selector**

  ```ts
  const IMAGE_RESOLUTION_OPTIONS = ['1K', '2K', '4K'] as const;
  ```

  Delete duplicated raw-dimension/segmented controls; keep one centered expanded-state control labelled `清晰度`.

- [ ] **Step 7: Verify and commit**

  ```powershell
  npm.cmd test -- packages/domain/src/model-job.test.ts packages/domain/src/canvas-module.test.ts packages/desktop-core/src/provider-bridge.test.ts packages/provider-comfly/src/client.test.ts apps/renderer/src/canvas/ModuleNodeCard.test.tsx
  npm.cmd run typecheck
  git add packages/domain/src/model-job.ts packages/domain/src/model-job.test.ts packages/domain/src/canvas-module.ts packages/domain/src/canvas-module.test.ts packages/desktop-core/src/provider-contracts.ts packages/desktop-core/src/provider-bridge.test.ts packages/provider-comfly/src/client.ts packages/provider-comfly/src/client.test.ts apps/renderer/src/canvas/ModuleNodeCard.tsx apps/renderer/src/canvas/ModuleNodeCard.test.tsx apps/renderer/src/jobs/desktop-model-executor.ts
  git commit -m "feat: add image resolution tiers"
  ```

---

### Task 5: Clean collapsed cards and reliable connected media slots

**Files:**
- Modify: `apps/renderer/src/canvas/ModuleNodeCard.tsx`
- Modify: `apps/renderer/src/canvas/ModuleNodeCard.test.tsx`
- Modify: `apps/renderer/src/canvas/reverse-agent-media.ts`
- Modify: `apps/renderer/src/styles/figma-hybrid-canvas.css`
- Modify: `tests/e2e/video-generation-ui.spec.ts`
- Modify: `tests/e2e/formal-module-workbench.spec.ts`

**Interfaces:**
- Consumes: connected image/video asset IDs, managed display URLs, and video poster URLs.
- Produces:
  ```ts
  interface ConnectedMediaSlot {
    readonly assetId: string;
    readonly kind: 'image' | 'video';
    readonly displayUrl: string | null;
    readonly posterUrl: string | null;
    readonly label: string;
  }
  ```

- [ ] **Step 1: Write failing collapsed-card tests**

  ```tsx
  expect(screen.queryByText('待配置')).not.toBeInTheDocument();
  expect(screen.queryByText(/生成数量/)).not.toBeInTheDocument();
  ```

  Run for image/video collapsed cards and assert quantity remains in expanded controls.

- [ ] **Step 2: Write failing media-slot tests**

  Cover image→image, image→video, video→video poster, collapsed/expanded, reorder, reconnect, disconnect, and request ID parity.

  ```tsx
  const slot = screen.getByTestId('connected-media-slot:image-asset-1');
  expect(within(slot).getByRole('img')).toHaveAttribute('src', 'novus-asset://image-asset-1');
  expect(buildImageRequest()).toMatchObject({ referenceAssetIds: ['image-asset-1'] });
  ```

- [ ] **Step 3: Run RED tests**

  Run: `npm.cmd test -- apps/renderer/src/canvas/ModuleNodeCard.test.tsx apps/renderer/src/canvas/reverse-agent-media.test.ts`

  Expected: FAIL on stale collapsed labels or hidden/missing thumbnails.

- [ ] **Step 4: Remove collapsed metadata from JSX**

  Delete `.module-node__generation-collapsed-status` and `.module-node__generation-collapsed-count` elements, not merely CSS-hide them. Keep active generation/cancel state expanded.

- [ ] **Step 5: Unify slot data and request IDs**

  Resolve ordered `ConnectedMediaSlot[]` once from graph edges. Use that order for rendering and request construction. Render image thumbnails; render video poster images when available and a video glyph only without a poster.

- [ ] **Step 6: Remove legacy slot-hiding CSS**

  ```css
  .module-node__unified-media-slots { display:flex; gap:8px; min-height:54px; overflow-x:auto; }
  .module-node__connected-media-slot { width:54px; height:54px; flex:0 0 54px; overflow:hidden; border-radius:9px; }
  .module-node__connected-media-slot img { width:100%; height:100%; object-fit:contain; }
  ```

  Explicit empty placeholders remain only for first/end-frame video positions.

- [ ] **Step 7: Verify and commit**

  ```powershell
  npm.cmd test -- apps/renderer/src/canvas/ModuleNodeCard.test.tsx apps/renderer/src/canvas/reverse-agent-media.test.ts
  npm.cmd run e2e -- tests/e2e/video-generation-ui.spec.ts tests/e2e/formal-module-workbench.spec.ts --project=chromium
  git add apps/renderer/src/canvas/ModuleNodeCard.tsx apps/renderer/src/canvas/ModuleNodeCard.test.tsx apps/renderer/src/canvas/reverse-agent-media.ts apps/renderer/src/styles/figma-hybrid-canvas.css tests/e2e/video-generation-ui.spec.ts tests/e2e/formal-module-workbench.spec.ts
  git commit -m "fix: show connected media in generation cards"
  ```

---

### Task 6: Consolidate left-rail spacing and interaction geometry

**Files:**
- Modify: `apps/renderer/src/canvas/CanvasWorkspace.tsx`
- Modify: `apps/renderer/src/canvas/CanvasWorkspace.test.tsx`
- Modify: `apps/renderer/src/styles/app.css`
- Modify: `apps/renderer/src/styles/figma-hybrid-canvas.css`
- Modify: `apps/renderer/src/main.styles.test.ts`
- Modify: `tests/e2e/left-rail-figma.spec.ts`

**Interfaces:**
- Consumes: existing seven rail callbacks/theme state.
- Produces: seven fixed-size slots with stable bounding boxes and no spacer drift.

- [ ] **Step 1: Write failing runtime geometry tests**

  ```ts
  const buttons = page.locator('.canvas-tool-rail button');
  await expect(buttons).toHaveCount(7);
  const boxes = await buttons.evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().toJSON()));
  expect(boxes.every((box) => box.width === 44 && box.height === 44)).toBe(true);
  expect(boxes.slice(1).map((box, index) => box.y - boxes[index]!.y)).toEqual([102, 102, 102, 102, 102, 102]);
  ```

  Repeat after theme switching.

- [ ] **Step 2: Run RED tests**

  ```powershell
  npm.cmd test -- apps/renderer/src/canvas/CanvasWorkspace.test.tsx apps/renderer/src/main.styles.test.ts
  npm.cmd run e2e -- tests/e2e/left-rail-figma.spec.ts --project=chromium
  ```

  Expected: runtime E2E fails if old selectors/spacers still win.

- [ ] **Step 3: Consolidate DOM/CSS**

  Use one list without flex spacers; disabled actions keep normal slots.

  ```css
  .canvas-tool-rail { width:66px; padding:18px 10px; }
  .canvas-tool-rail__actions { display:grid; grid-auto-rows:44px; row-gap:58px; }
  .canvas-tool-rail button { width:44px; height:44px; display:grid; place-items:center; margin:0; }
  ```

  Remove competing 32px/48px rules. Preserve callback/order.

- [ ] **Step 4: Verify and commit**

  ```powershell
  npm.cmd test -- apps/renderer/src/canvas/CanvasWorkspace.test.tsx apps/renderer/src/main.styles.test.ts
  npm.cmd run e2e -- tests/e2e/left-rail-figma.spec.ts --project=chromium
  git add apps/renderer/src/canvas/CanvasWorkspace.tsx apps/renderer/src/canvas/CanvasWorkspace.test.tsx apps/renderer/src/styles/app.css apps/renderer/src/styles/figma-hybrid-canvas.css apps/renderer/src/main.styles.test.ts tests/e2e/left-rail-figma.spec.ts
  git commit -m "fix: align canvas tool rail geometry"
  ```

---

### Task 7: Full verification, screenshots, and user-testing handoff

**Files:**
- Modify if required: `tests/e2e/current-settings-ui.spec.ts`
- Modify if required: `tests/e2e/current-agent-knowledge-ui.spec.ts`
- Modify if required: `tests/e2e/left-rail-figma.spec.ts`
- Modify if required: `tests/e2e/video-generation-ui.spec.ts`
- Generate: `artifacts/2026-08-05-ui-polish/`

**Interfaces:**
- Consumes: Tasks 1–6.
- Produces: test evidence and runtime screenshots; no installer.

- [ ] **Step 1: Start the known working renderer command**

  ```powershell
  npm.cmd run dev -w @agent-canvas/renderer -- --host 127.0.0.1 --port 43150 --configLoader runner
  ```

  Expected URL: `http://127.0.0.1:43150/?novusHarness=novus-e2e-codex-ui-gate`.

- [ ] **Step 2: Run focused regression suites**

  ```powershell
  npm.cmd test -- packages/desktop-core/src/cache-directory-service.test.ts packages/desktop-core/src/bridge-contract.test.ts packages/desktop-core/src/project-image-bridge.test.ts packages/domain/src/model-job.test.ts packages/domain/src/canvas-module.test.ts packages/provider-comfly/src/client.test.ts apps/renderer/src/settings/SettingsDrawer.test.tsx apps/renderer/src/agent/SkillChatWorkbench.test.tsx apps/renderer/src/app/app-store.test.ts apps/renderer/src/canvas/ModuleNodeCard.test.tsx apps/renderer/src/canvas/CanvasWorkspace.test.tsx apps/renderer/src/main.styles.test.ts
  ```

  Expected: all selected tests PASS with zero unhandled errors.

- [ ] **Step 3: Run typecheck and security scan**

  ```powershell
  npm.cmd run typecheck
  npm.cmd run scan:e2e
  ```

  Expected: exit 0; no secret, private source path, or base64 image payload leak.

- [ ] **Step 4: Run UI gate E2E**

  ```powershell
  npm.cmd run e2e -- tests/e2e/current-settings-ui.spec.ts tests/e2e/current-agent-knowledge-ui.spec.ts tests/e2e/left-rail-figma.spec.ts tests/e2e/video-generation-ui.spec.ts tests/e2e/formal-module-workbench.spec.ts --project=chromium
  ```

  Expected: PASS for settings, Agent, rail, upload, generation, connect/disconnect, collapse/expand, and theme switching.

- [ ] **Step 5: Capture runtime screenshots**

  ```text
  artifacts/2026-08-05-ui-polish/light-canvas-collapsed.png
  artifacts/2026-08-05-ui-polish/light-generation-expanded.png
  artifacts/2026-08-05-ui-polish/dark-canvas-collapsed.png
  artifacts/2026-08-05-ui-polish/dark-generation-expanded.png
  artifacts/2026-08-05-ui-polish/settings-storage.png
  artifacts/2026-08-05-ui-polish/settings-diagnostics.png
  artifacts/2026-08-05-ui-polish/agent-knowledge-upload.png
  artifacts/2026-08-05-ui-polish/image-connected-slot.png
  artifacts/2026-08-05-ui-polish/video-connected-slot.png
  ```

  Screenshots must be the actual runtime page, not Figma-only mocks.

- [ ] **Step 6: Inspect against the approved checklist**

  Confirm four settings tabs/no guide; real cache actions; compact diagnostics; Agent selectors below input; unsynced knowledge selectable; upload citation visible; one `1K/2K/4K` selector; no collapsed pending/count; real connected thumbnails/posters; and 44px/58px rail geometry in both themes.

- [ ] **Step 7: Commit only final test corrections**

  ```powershell
  git add tests/e2e/current-settings-ui.spec.ts tests/e2e/current-agent-knowledge-ui.spec.ts tests/e2e/left-rail-figma.spec.ts tests/e2e/video-generation-ui.spec.ts tests/e2e/formal-module-workbench.spec.ts
  git commit -m "test: verify settings and generation ui polish"
  ```

  If no files changed, do not create an empty commit.

- [ ] **Step 8: Report without packaging**

  Report exact test counts, typecheck result, screenshot paths, and known limitations. Packaging remains deferred until the user finishes UI/function inspection.
