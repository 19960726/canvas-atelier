# Photoshop Smart Object Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the Windows desktop build import a generated project image into the currently active Photoshop PSD as a centered embedded smart object while preserving source pixel aspect and dimensions and never touching the clipboard.

**Architecture:** Add a strict renderer-to-preload IPC contract that sends only session and managed asset IDs. The desktop handler resolves and validates the managed source file, then delegates to a Windows-only Photoshop adapter. The adapter discovers a running Photoshop 2019+ COM server and executes a bundled, fixed ExtendScript file with a main-process-created job file; the script places an embedded smart object, corrects any automatic fit scaling back to source pixel dimensions, centers it, and does not save the PSD.

**Tech Stack:** TypeScript, Electron IPC/contextBridge, Node `child_process`, Windows Script Host/Photoshop COM automation, ExtendScript JSX, Vitest, React Testing Library.

## Global Constraints

- Windows only; minimum Photoshop 2019 / version 20.x.
- Import into the currently active PSD only; never create, save, close, or overwrite a PSD.
- Create an embedded smart object, not a linked smart object.
- Preserve original pixel dimensions/aspect ratio; center it; no fit-to-canvas, crop, stretch, or automatic save.
- Renderer submits no absolute file path, Photoshop executable path, or script content.
- Source must be a managed image belonging to the current project session.
- The flow must never read, write, clear, or replace the system clipboard.
- Browser mode remains unavailable with an explicit desktop-only explanation.
- Failure must not alter canvas nodes, generation history, source media, or clipboard content.

---

### Task 1: Photoshop bridge contract and preload surface

**Files:**
- Modify: `packages/desktop-core/src/contracts.ts`
- Modify: `packages/desktop-core/src/preload-api.ts`
- Modify: `packages/desktop-core/src/index.ts`
- Modify: `packages/desktop-core/src/bridge-contract.test.ts`
- Modify: `packages/desktop-core/src/public-api.test.ts`
- Modify: `apps/desktop-modern/src/preload.ts`
- Modify: `apps/desktop-legacy/src/preload.ts`

**Interfaces:**
- Produces: `ImportProjectImageToPhotoshopBridgeRequest`, `ImportProjectImageToPhotoshopBridgeResult`, `PhotoshopImportErrorCode`.
- Adds: `window.novusDesktop.projectImages.importToPhotoshop(request)`.
- IPC channel: `novus-desktop:import-project-image-to-photoshop`.

- [ ] **Step 1: Write failing contract tests**

```ts
expect(BRIDGE_CHANNELS.importProjectImageToPhotoshop)
  .toBe('novus-desktop:import-project-image-to-photoshop');

await api.projectImages.importToPhotoshop({ sessionId: 'session-1', assetId: 'asset-1' });
expect(invoke).toHaveBeenCalledWith(
  BRIDGE_CHANNELS.importProjectImageToPhotoshop,
  { sessionId: 'session-1', assetId: 'asset-1' },
);
```

- [ ] **Step 2: Run and confirm failure**

Run: `npm.cmd test -- packages/desktop-core/src/bridge-contract.test.ts packages/desktop-core/src/public-api.test.ts`

Expected: FAIL because the channel/types/API do not exist.

- [ ] **Step 3: Define exact request/result types**

```ts
export interface ImportProjectImageToPhotoshopBridgeRequest {
  readonly sessionId: string;
  readonly assetId: string;
}

export type PhotoshopImportErrorCode =
  | 'DESKTOP_ONLY'
  | 'INVALID_SESSION'
  | 'ASSET_NOT_FOUND'
  | 'ASSET_NOT_IMAGE'
  | 'ASSET_OUTSIDE_PROJECT'
  | 'PHOTOSHOP_NOT_RUNNING'
  | 'PHOTOSHOP_VERSION_UNSUPPORTED'
  | 'PHOTOSHOP_DOCUMENT_REQUIRED'
  | 'PHOTOSHOP_AUTOMATION_REJECTED'
  | 'PHOTOSHOP_IMPORT_FAILED';

export type ImportProjectImageToPhotoshopBridgeResult =
  | { readonly ok: true; readonly documentName: string; readonly layerName: string }
  | { readonly ok: false; readonly code: PhotoshopImportErrorCode; readonly message: string };
```

Add the channel, preload method, and exports. Do not add any path field.

- [ ] **Step 4: Verify and commit**

Run: `npm.cmd test -- packages/desktop-core/src/bridge-contract.test.ts packages/desktop-core/src/public-api.test.ts`

Run: `npm.cmd run typecheck`

Expected: PASS.

```bash
git add packages/desktop-core/src/contracts.ts packages/desktop-core/src/preload-api.ts packages/desktop-core/src/index.ts packages/desktop-core/src/bridge-contract.test.ts packages/desktop-core/src/public-api.test.ts apps/desktop-modern/src/preload.ts apps/desktop-legacy/src/preload.ts
git commit -m "feat: define photoshop image import bridge"
```

### Task 2: Managed asset validation service

**Files:**
- Create: `packages/desktop-core/src/photoshop-import-service.ts`
- Create: `packages/desktop-core/src/photoshop-import-service.test.ts`
- Modify: `packages/desktop-core/src/bridge-handlers.ts`
- Modify: `packages/desktop-core/src/index.ts`

**Interfaces:**
- Produces: `createPhotoshopImportService(dependencies): PhotoshopImportService`.
- `PhotoshopImportService.importManagedImage(request): Promise<ImportProjectImageToPhotoshopBridgeResult>`.
- Consumes: current desktop session, project repository, asset store, and `PhotoshopAutomationAdapter` from Task 3.

- [ ] **Step 1: Write failing validation tests**

```ts
it.each([
  ['changed session', { sessionId: 'stale', assetId: 'asset-1' }, 'INVALID_SESSION'],
  ['missing asset', { sessionId: 'session-1', assetId: 'missing' }, 'ASSET_NOT_FOUND'],
])('%s', async (_name, request, code) => {
  await expect(service.importManagedImage(request)).resolves.toMatchObject({ ok: false, code });
  expect(adapter.importEmbeddedSmartObject).not.toHaveBeenCalled();
});
```

Add cases for a non-image MIME, a path outside the current managed asset root, and a deleted source file.

- [ ] **Step 2: Run and confirm failure**

Run: `npm.cmd test -- packages/desktop-core/src/photoshop-import-service.test.ts`

Expected: FAIL before the service exists.

- [ ] **Step 3: Implement strict validation and delegation**

```ts
export interface PhotoshopAutomationAdapter {
  importEmbeddedSmartObject(input: {
    readonly sourcePath: string;
    readonly sourceWidth: number;
    readonly sourceHeight: number;
    readonly layerName: string;
  }): Promise<{ readonly documentName: string; readonly layerName: string }>;
}
```

Resolve `assetId` through the current project repository/asset store. Compare the canonical source path against the canonical current-project asset root before calling the adapter. Derive `layerName` from a sanitized asset label, never from renderer-supplied text.

- [ ] **Step 4: Register the handler**

Validate exact request keys `sessionId` and `assetId`, call the service, and register the new channel in `registerDesktopBridgeHandlers`. The handler returns structured failures instead of leaking thrown COM/path details.

- [ ] **Step 5: Verify and commit**

Run: `npm.cmd test -- packages/desktop-core/src/photoshop-import-service.test.ts packages/desktop-core/src/bridge-contract.test.ts packages/desktop-core/src/project-image-bridge.test.ts`

Expected: PASS.

```bash
git add packages/desktop-core/src/photoshop-import-service.ts packages/desktop-core/src/photoshop-import-service.test.ts packages/desktop-core/src/bridge-handlers.ts packages/desktop-core/src/index.ts
git commit -m "feat: validate managed photoshop imports"
```

### Task 3: Windows Photoshop 2019+ automation adapter

**Files:**
- Create: `packages/desktop-core/src/photoshop-automation.ts`
- Create: `packages/desktop-core/src/photoshop-automation.test.ts`
- Create: `apps/desktop-modern/assets/photoshop/import-embedded-smart-object.jsx`
- Create: `apps/desktop-modern/assets/photoshop/run-import.vbs`
- Modify: `apps/desktop-modern/scripts/copy-static.mjs`
- Modify: `apps/desktop-modern/electron-builder.yml`
- Modify: `apps/desktop-modern/src/runtime-entry-contract.test.ts`
- Modify: `apps/desktop-legacy/src/main.ts`
- Modify: `apps/desktop-modern/src/main.ts`

**Interfaces:**
- Produces: `createWindowsPhotoshopAutomationAdapter(options): PhotoshopAutomationAdapter`.
- Adapter dependencies: injected `spawnFile`, `writeJobFile`, `removeJobFile`, `scriptDirectory`, `platform` for unit testing.
- Fixed executable: `%SystemRoot%\System32\cscript.exe`; fixed bundled `run-import.vbs`; only the generated job-file path is an argument.

- [ ] **Step 1: Write failing adapter tests**

Test unsupported platform, Photoshop not running, version `<20`, no active document, successful import, timeout, rejected automation, malformed result, and temporary job cleanup. Assert the spawned command never contains clipboard tools, arbitrary shell switches, source path, or user text.

```ts
expect(spawnFile).toHaveBeenCalledWith(
  expect.stringMatching(/cscript\.exe$/i),
  ['//B', '//Nologo', expect.stringMatching(/run-import\.vbs$/i), jobPath],
  expect.objectContaining({ windowsHide: true, shell: false }),
);
```

- [ ] **Step 2: Run and confirm failure**

Run: `npm.cmd test -- packages/desktop-core/src/photoshop-automation.test.ts apps/desktop-modern/src/runtime-entry-contract.test.ts`

Expected: FAIL before adapter/assets exist.

- [ ] **Step 3: Implement the fixed job schema and runner**

The main process writes UTF-8 JSON with exact fields:

```ts
interface PhotoshopImportJob {
  readonly protocol: 'canvasforge.photoshop.import.v1';
  readonly sourcePath: string;
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  readonly layerName: string;
  readonly resultPath: string;
}
```

Store it in an app-owned temporary directory with owner-only access where Windows supports it. Delete job/result files in `finally`.

- [ ] **Step 4: Implement version/document discovery in the VBS runner**

`run-import.vbs` obtains an already-running `Photoshop.Application` COM object, reads `Version`, rejects major versions below 20, rejects `Documents.Count = 0`, and calls `DoJavaScriptFile` on the fixed bundled JSX. It writes only a bounded status/result JSON file. It must not launch Photoshop when none is running.

- [ ] **Step 5: Implement fixed ExtendScript placement**

The JSX:

1. Parses only the trusted job file.
2. Uses the Photoshop `placeEvent` ActionDescriptor with `linked = false` to create an embedded smart object.
3. Reads the placed layer bounds.
4. Resizes the placed layer to `sourceWidth × sourceHeight` pixels when Photoshop auto-fits it.
5. Translates the layer so its bounds center equals the active document center.
6. Renames the new layer with the trusted sanitized label.
7. Writes `{ ok, documentName, layerName }` and never calls `save`, `saveAs`, `close`, clipboard APIs, or arbitrary `eval`.

Use JSON parsing supplied in the script asset; do not construct JSX source by concatenating paths.

- [ ] **Step 6: Bundle and wire the adapter**

Copy both script assets into the packaged resources and assert their paths in `runtime-entry-contract.test.ts`. Inject the adapter into desktop bridge dependencies in modern and legacy main processes; on non-Windows use an adapter returning `DESKTOP_ONLY`.

- [ ] **Step 7: Verify and commit**

Run: `npm.cmd test -- packages/desktop-core/src/photoshop-automation.test.ts packages/desktop-core/src/photoshop-import-service.test.ts apps/desktop-modern/src/runtime-entry-contract.test.ts`

Run: `npm.cmd run typecheck`

Expected: PASS.

```bash
git add packages/desktop-core/src/photoshop-automation.ts packages/desktop-core/src/photoshop-automation.test.ts apps/desktop-modern/assets/photoshop/import-embedded-smart-object.jsx apps/desktop-modern/assets/photoshop/run-import.vbs apps/desktop-modern/scripts/copy-static.mjs apps/desktop-modern/electron-builder.yml apps/desktop-modern/src/runtime-entry-contract.test.ts apps/desktop-modern/src/main.ts apps/desktop-legacy/src/main.ts
git commit -m "feat: automate photoshop smart object placement"
```

### Task 4: Generated-image context menu and user feedback

**Files:**
- Modify: `apps/renderer/src/canvas/ModuleNodeCard.tsx`
- Modify: `apps/renderer/src/canvas/ModuleNodeCard.test.tsx`
- Modify: `apps/renderer/src/styles/figma-hybrid-canvas.css`

**Interfaces:**
- Produces renderer action: `importGeneratedImageToPhotoshop(assetId: string): Promise<void>`.
- Consumes: `window.novusDesktop.projectImages.importToPhotoshop`, active desktop session ID, and generated image asset ID.

- [ ] **Step 1: Write failing renderer tests**

Cover enabled desktop menu item, browser-disabled explanation, single-flight busy state, success toast, and every structured error message.

```ts
fireEvent.click(screen.getByRole('menuitem', { name: '导入 Photoshop' }));
expect(importToPhotoshop).toHaveBeenCalledWith({ sessionId: 'session-1', assetId: 'asset-1' });
expect(await screen.findByText('已导入当前 Photoshop 文档')).toBeVisible();
```

- [ ] **Step 2: Run and confirm failure**

Run: `npm.cmd test -- apps/renderer/src/canvas/ModuleNodeCard.test.tsx`

Expected: FAIL because the current Photoshop menu item is disabled/no-op.

- [ ] **Step 3: Implement menu behavior and error mapping**

Disable only while the same asset is importing. Browser mode displays `仅桌面版可导入 Photoshop`. Map codes to actionable Chinese copy: start Photoshop, open a PSD, upgrade from pre-2019, regenerate/reimport a missing asset, or retry after automation rejection.

- [ ] **Step 4: Prove no clipboard interaction**

In the renderer test, provide spies for image/video clipboard APIs and assert neither is called before, during, or after Photoshop import.

- [ ] **Step 5: Verify and commit**

Run: `npm.cmd test -- apps/renderer/src/canvas/ModuleNodeCard.test.tsx packages/desktop-core/src/project-image-bridge.test.ts packages/desktop-core/src/project-video-bridge.test.ts`

Expected: PASS.

```bash
git add apps/renderer/src/canvas/ModuleNodeCard.tsx apps/renderer/src/canvas/ModuleNodeCard.test.tsx apps/renderer/src/styles/figma-hybrid-canvas.css
git commit -m "feat: import generated images into photoshop"
```

### Task 5: Photoshop regression and Windows manual acceptance

**Files:**
- Create: `docs/qa/photoshop-smart-object-acceptance.md`
- Create: `artifacts/2026-08-07-photoshop-smart-object-bridge/README.md`
- Modify: `tests/e2e/helpers/secret-path-scan.mjs`
- Modify: `tests/integration/secret-path-scan.test.ts`

**Interfaces:**
- Produces a manual acceptance record bound to the exact packaged build and Photoshop versions.

- [ ] **Step 1: Extend security scanning**

Reject renderer bundles containing absolute project paths, Photoshop executable paths, JSX source, job-file contents, or managed asset roots. Permit only channel names, error codes, and user-facing copy.

- [ ] **Step 2: Run automated gates**

Run: `npm.cmd run typecheck`

Run: `npm.cmd test -- packages/desktop-core/src/photoshop-automation.test.ts packages/desktop-core/src/photoshop-import-service.test.ts packages/desktop-core/src/bridge-contract.test.ts packages/desktop-core/src/project-image-bridge.test.ts packages/desktop-core/src/project-video-bridge.test.ts apps/renderer/src/canvas/ModuleNodeCard.test.tsx apps/desktop-modern/src/runtime-entry-contract.test.ts`

Run: `npm.cmd run scan:e2e`

Expected: PASS, or document any pre-existing scanner baseline failure separately without claiming green.

- [ ] **Step 3: Build the desktop application**

Run: `npm.cmd run build`

Expected: PASS and packaged resources include the fixed VBS/JSX assets.

- [ ] **Step 4: Perform Windows manual acceptance**

On Photoshop 2019/20.x and one newer installed version:

1. Open an existing PSD.
2. Import horizontal, vertical, and square generated images.
3. Confirm each new layer is an embedded smart object.
4. Confirm layer pixel aspect/dimensions match the source and its center matches the document center.
5. Confirm the PSD remains unsaved and existing layers unchanged.
6. Repeat with no Photoshop, no active PSD, and unsupported-version stubs.
7. Put known image and MP4 payloads on the clipboard before each import and verify clipboard content is byte-for-byte unchanged afterward.

- [ ] **Step 5: Record evidence and commit**

The artifact README records build hash, Photoshop versions, source dimensions, resulting bounds, clipboard hashes, screenshots, and any unavailable environment. Do not mark the feature verified until real Windows/Photoshop evidence exists.

```bash
git add docs/qa/photoshop-smart-object-acceptance.md artifacts/2026-08-07-photoshop-smart-object-bridge/README.md tests/e2e/helpers/secret-path-scan.mjs tests/integration/secret-path-scan.test.ts
git commit -m "test: document photoshop bridge acceptance"
```