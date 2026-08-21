# Connected Media Mentions and Photoshop Menu Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace drifting overlay mentions with real inline media chips, restrict node mentions to connected assets, and make Photoshop import feedback solid and actionable before packaging a release newer than `1.6.40`.

**Architecture:** A focused mention model module owns canonical token parsing, connected-media reconciliation, and DOM serialization. `MediaMentionTextarea` becomes a single `contenteditable` surface whose chips and caret share one layout tree. Canvas nodes derive mention candidates from ordered connections, while the generated-image action menu uses an explicit Photoshop import state machine and opaque theme surface.

**Tech Stack:** React 18, TypeScript, Zustand, React Flow, Vitest, Testing Library, Playwright, Electron, CSS.

## Global Constraints

- The next packaged release must be newer than `1.6.40`.
- Visible mention chips use a small pin icon and labels such as `图片1`, `图片2`, and `视频1`; the `@` character is not visible.
- Canonical stored prompts continue using `@图片N` and `@视频N`.
- Node mention menus, previews, and execution references use only media connected to that node's relevant input port.
- Disconnecting media automatically removes its mention and safely renumbers remaining mentions.
- Do not automatically launch Photoshop, create a Photoshop document, or alter unrelated documents.
- Do not install over the user's formal application, close it, or mutate formal user data without separate permission.
- Preserve the existing dirty worktree and stage only files owned by each task.

---

## File Structure

- Create `apps/renderer/src/mentions/media-mention-model.ts`: canonical parsing, connected catalog creation, reconciliation, and DOM/value helpers.
- Create `apps/renderer/src/mentions/media-mention-model.test.ts`: pure model tests independent from React.
- Modify `apps/renderer/src/mentions/MediaMentionTextarea.tsx`: single-surface contenteditable editor and caret-safe DOM synchronization.
- Modify `apps/renderer/src/mentions/MediaMentionTextarea.test.tsx`: component input, IME, paste, deletion, navigation, and visible-chip tests.
- Modify `apps/renderer/src/canvas/ModuleNodeCard.tsx`: connected-only mention catalogs, cleanup effects, picker wiring, and Photoshop state UI.
- Modify `apps/renderer/src/canvas/ModuleNodeCard.test.tsx`: connected-only picker and Photoshop state regression coverage.
- Modify `apps/renderer/src/styles/app.css`: mention editor/chip/preview and Photoshop notice/retry styling.
- Modify `apps/renderer/src/styles/figma-hybrid-canvas.css`: final opaque context-menu surface and theme-specific chip dimensions.
- Modify `tests/e2e/media-mention-chip.spec.ts`: visible caret adjacency, connected filtering, disconnect cleanup, and light/dark screenshots.
- Modify `tests/e2e/photoshop-image-action.spec.ts`: success, runtime error, retry, and opaque-menu acceptance.
- Modify `apps/renderer/src/test-mode/e2e-harness.ts`: deterministic edge removal and queued Photoshop-result controls.
- Verify `apps/desktop-modern/package.json`: keep source metadata intact and use electron-builder `extraMetadata.version=1.6.41` for the new artifact, matching the existing `1.6.40` release process.

---

### Task 1: Canonical Mention Model and Connected-Media Reconciliation

**Files:**
- Create: `apps/renderer/src/mentions/media-mention-model.ts`
- Create: `apps/renderer/src/mentions/media-mention-model.test.ts`

**Interfaces:**
- Consumes: ordered `{ edgeId?: string; assetId: string; kind: 'image' | 'video' }[]`, project image/video summaries, and canonical prompt strings.
- Produces: `buildConnectedMentionCatalog(...)`, `parseCanonicalMentions(value)`, and `reconcileConnectedMentions(previousCatalog, nextCatalog, value)`.

- [ ] **Step 1: Write failing parsing and catalog tests**

```ts
import { describe, expect, it } from 'vitest';
import {
  buildConnectedMentionCatalog,
  parseCanonicalMentions,
  reconcileConnectedMentions,
} from './media-mention-model';

describe('media mention model', () => {
  it('parses canonical tokens while exposing labels without @', () => {
    expect(parseCanonicalMentions('参考 @图片1 和 @视频2')).toEqual([
      { kind: 'text', text: '参考 ', start: 0, end: 3 },
      { kind: 'image', text: '图片1', token: '@图片1', start: 3, end: 7 },
      { kind: 'text', text: ' 和 ', start: 7, end: 10 },
      { kind: 'video', text: '视频2', token: '@视频2', start: 10, end: 14 },
    ]);
  });

  it('numbers only connected images and videos in their own sequences', () => {
    const catalog = buildConnectedMentionCatalog(
      [
        { edgeId: 'e1', assetId: 'image-a', kind: 'image' },
        { edgeId: 'e2', assetId: 'video-a', kind: 'video' },
        { edgeId: 'e3', assetId: 'image-b', kind: 'image' },
      ],
      [
        { assetId: 'image-a', label: 'A', displayUrl: 'managed://a' },
        { assetId: 'image-b', label: 'B', displayUrl: 'managed://b' },
        { assetId: 'unconnected', label: 'History generated', displayUrl: 'managed://history' },
      ] as never,
      [{ assetId: 'video-a', label: 'V', displayUrl: 'managed://v' }] as never,
    );
    expect(catalog.map(({ token, assetId }) => ({ token, assetId }))).toEqual([
      { token: '@图片1', assetId: 'image-a' },
      { token: '@视频1', assetId: 'video-a' },
      { token: '@图片2', assetId: 'image-b' },
    ]);
    expect(catalog.some((item) => item.assetId === 'unconnected')).toBe(false);
  });

  it('removes disconnected references and rebinds remaining tokens by asset identity', () => {
    const previous = [
      { token: '@图片1', assetId: 'image-a', kind: 'image', label: 'A' },
      { token: '@图片2', assetId: 'image-b', kind: 'image', label: 'B' },
    ] as never;
    const next = [{ token: '@图片1', assetId: 'image-b', kind: 'image', label: 'B' }] as never;
    expect(reconcileConnectedMentions(previous, next, '保留 @图片2 删除 @图片1')).toBe('保留 @图片1 删除');
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm.cmd exec vitest -- --config vitest.config.ts apps/renderer/src/mentions/media-mention-model.test.ts --run`

Expected: FAIL because `media-mention-model.ts` and its exports do not exist.

- [ ] **Step 3: Implement the pure model**

```ts
export type MediaMentionKind = 'image' | 'video';

export interface ConnectedMentionItem {
  readonly token: string;
  readonly assetId: string;
  readonly kind: MediaMentionKind;
  readonly label: string;
  readonly displayUrl?: string;
}

export function tokenFor(kind: MediaMentionKind, index: number): string {
  return `@${kind === 'image' ? '图片' : '视频'}${index + 1}`;
}

export function reconcileConnectedMentions(
  previous: readonly ConnectedMentionItem[],
  next: readonly ConnectedMentionItem[],
  value: string,
): string {
  const nextByAsset = new Map(next.map((item) => [`${item.kind}:${item.assetId}`, item]));
  const previousByToken = new Map(previous.map((item) => [item.token, item]));
  return value.replace(/@(图片|视频)(\d{1,2})/gu, (token) => {
    const prior = previousByToken.get(token);
    if (prior === undefined) return '';
    return nextByAsset.get(`${prior.kind}:${prior.assetId}`)?.token ?? '';
  }).replace(/[ \t]{2,}/gu, ' ').trimEnd();
}
```

Implement `parseCanonicalMentions` with `/@(图片|视频)(\d{1,2})/gu`, emitting intervening text segments with canonical offsets. Implement `buildConnectedMentionCatalog` with `imageIndex` and `videoIndex` counters, resolve each ordered item from the matching project summary array, skip unresolved assets, assign `tokenFor(item.kind, matchingKindIndex)`, and increment only that media kind's counter.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `npm.cmd exec vitest -- --config vitest.config.ts apps/renderer/src/mentions/media-mention-model.test.ts --run`

Expected: PASS with all model tests.

- [ ] **Step 5: Commit only the model task**

```powershell
git add -- apps/renderer/src/mentions/media-mention-model.ts apps/renderer/src/mentions/media-mention-model.test.ts
git commit -m "feat: model connected media mentions"
```

---

### Task 2: Single-Surface Inline Mention Editor

**Files:**
- Modify: `apps/renderer/src/mentions/MediaMentionTextarea.tsx`
- Modify: `apps/renderer/src/mentions/MediaMentionTextarea.test.tsx`
- Modify: `apps/renderer/src/styles/app.css`

**Interfaces:**
- Consumes: canonical `value`, `mentions: ConnectedMentionItem[]`, standard `onChange`, `aria-*`, disabled, and placeholder props.
- Produces: a controlled `contenteditable` with `role="textbox"`, `aria-multiline="true"`, visible pin chips, and canonical change events compatible with current callers.

- [ ] **Step 1: Write failing component behavior tests**

Add tests that assert:

```tsx
render(<MediaMentionTextarea value="参考 @图片1 后继续" mentions={[imageMention]} onChange={onChange} aria-label="Analysis task" />);
const editor = screen.getByRole('textbox', { name: 'Analysis task' });
expect(editor).toHaveTextContent('参考 图片1 后继续');
expect(editor).not.toHaveTextContent('@图片1');
expect(editor.querySelector('[data-media-mention="image"]')).toHaveTextContent('图片1');
expect(editor.querySelector('[data-media-mention="image"] svg')).not.toBeNull();
```

Also add separate tests for plain-text paste, composition start/end, Backspace beside a chip, external value refresh, multiline serialization, and selection restoration after inserting three chips.

- [ ] **Step 2: Run the component tests and verify RED**

Run: `npm.cmd exec vitest -- --config vitest.config.ts apps/renderer/src/mentions/MediaMentionTextarea.test.tsx --run`

Expected: FAIL because the current component renders a textarea plus overlay and does not expose real inline chips.

- [ ] **Step 3: Implement a single contenteditable surface**

Replace the current overlay return tree with:

```tsx
<div className="media-mention-textarea">
  <div
    ref={editorRef}
    className={`media-mention-textarea__editor${className ? ` ${className}` : ''}`}
    contentEditable={!disabled}
    role="textbox"
    aria-multiline="true"
    data-placeholder={placeholder}
    onBeforeInput={handleBeforeInput}
    onInput={handleInput}
    onCompositionStart={() => { composingRef.current = true; }}
    onCompositionEnd={handleCompositionEnd}
    onPaste={handlePlainTextPaste}
    onKeyDown={handleChipDeletion}
  />
</div>
```

Render mentions as `span[contenteditable="false"]` with `data-token`, `data-asset-id`, an inline pin SVG, and label text. Serialize text nodes, `<br>`, and chip `data-token` values back to the canonical prompt. Restore the selection from canonical character offsets after controlled DOM updates; do not rewrite DOM during active IME composition.

- [ ] **Step 4: Replace overlay CSS with chip CSS**

```css
.media-mention-textarea__editor {
  box-sizing: border-box;
  width: 100%;
  min-height: inherit;
  padding: 10px 12px;
  overflow: auto;
  color: var(--text);
  font: inherit;
  font-size: 11px;
  line-height: 1.55;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  outline: 0;
}
.media-mention-textarea__chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin: 0 2px;
  padding: 1px 7px 2px;
  color: var(--text);
  background: var(--surface-elevated, var(--surface));
  border: 1px solid var(--border);
  border-radius: 999px;
  box-shadow: 0 1px 2px rgb(0 0 0 / .08);
  font-weight: 650;
  vertical-align: baseline;
  white-space: nowrap;
}
```

Delete the transparent textarea/presentation overlay rules so no second layout system remains.

- [ ] **Step 5: Run component and existing mention tests**

Run: `npm.cmd exec vitest -- --config vitest.config.ts apps/renderer/src/mentions/MediaMentionTextarea.test.tsx apps/renderer/src/agent/ImageMentionComposer.test.tsx --run`

Expected: PASS with canonical `@` tokens still delivered to callers.

- [ ] **Step 6: Commit only the editor task**

```powershell
git add -- apps/renderer/src/mentions/MediaMentionTextarea.tsx apps/renderer/src/mentions/MediaMentionTextarea.test.tsx apps/renderer/src/styles/app.css
git commit -m "fix: render caret-safe media mention chips"
```

---

### Task 3: Restrict Canvas Node Mentions to Connected Media

**Files:**
- Modify: `apps/renderer/src/canvas/ModuleNodeCard.tsx`
- Modify: `apps/renderer/src/canvas/ModuleNodeCard.test.tsx`

**Interfaces:**
- Consumes: `buildConnectedMentionCatalog`, ordered `connectedMedia`, project image/video summaries, and current canonical prompt.
- Produces: connected-only picker candidates, previews, canonical prompt cleanup, and execution `referenceAssetIds`.

- [ ] **Step 1: Write failing node regression tests**

Create a project containing connected `image-a`, unconnected `history-image`, and connected `video-a`. Assert that opening `@` in image generation, video generation, and reverse analysis shows only the connected labels. Add a disconnect rerender test:

```tsx
expect(screen.getByRole('menuitem', { name: 'Connected product' })).toBeVisible();
expect(screen.queryByRole('menuitem', { name: 'History generated' })).toBeNull();

rerender(<ModuleNodeCard id={node.id} data={nextDataWithoutImageA} selected={false} />);
expect(screen.getByLabelText('Analysis task')).not.toHaveTextContent('图片1');
```

Assert the run callback receives only asset IDs represented by the current connected catalog.

- [ ] **Step 2: Run focused node tests and verify RED**

Run: `npm.cmd exec vitest -- --config vitest.config.ts apps/renderer/src/canvas/ModuleNodeCard.test.tsx --run`

Expected: FAIL because current mention menus and previews use `projectImages`/`projectVideos` directly.

- [ ] **Step 3: Wire connected catalogs into all three node editors**

For each summary component:

```ts
const mentionCatalog = useMemo(
  () => buildConnectedMentionCatalog(connectedMedia, projectImages, projectVideos),
  [connectedMedia, projectImages, projectVideos],
);
const connectedImages = mentionCatalog.filter((item) => item.kind === 'image');
const mentionPreviews = mentionCatalog.map(({ token, label, displayUrl, kind }) => ({ token, label, displayUrl, kind }));
```

Change `PromptImageMentionMenu` to accept catalog items instead of all project images. Use each item's existing token and asset ID rather than deriving its position from the project array.

- [ ] **Step 4: Reconcile prompts when connections change**

Keep the previous catalog in a ref. In an effect, call `reconcileConnectedMentions(previousCatalog, mentionCatalog, prompt)`, update the controlled prompt only when the result differs, and then update the ref. Apply the same logic to image generation, video generation, and reverse analysis. Before each run, derive reference IDs from mentioned catalog items and current ordered connections only.

- [ ] **Step 5: Run node, store, and serialization tests**

Run: `npm.cmd exec vitest -- --config vitest.config.ts apps/renderer/src/canvas/ModuleNodeCard.test.tsx apps/renderer/src/app/app-store.test.ts apps/renderer/src/app/durable-project-serialization.integration.test.ts --run`

Expected: PASS; old canonical prompts load, stale mentions are removed, and unconnected assets never execute.

- [ ] **Step 6: Commit only connected-media wiring**

```powershell
git add -- apps/renderer/src/canvas/ModuleNodeCard.tsx apps/renderer/src/canvas/ModuleNodeCard.test.tsx
git commit -m "fix: scope node mentions to connected media"
```

---

### Task 4: Opaque Photoshop Menu with Progress, Error, and Retry

**Files:**
- Modify: `apps/renderer/src/canvas/ModuleNodeCard.tsx`
- Modify: `apps/renderer/src/canvas/ModuleNodeCard.test.tsx`
- Modify: `apps/renderer/src/styles/app.css`
- Modify: `apps/renderer/src/styles/figma-hybrid-canvas.css`
- Modify: `tests/e2e/photoshop-image-action.spec.ts`

**Interfaces:**
- Consumes: `getPhotoshopImportAvailability`, `importGeneratedImageToPhotoshop`, and `photoshopImportMessage`.
- Produces: `idle | busy | success | error` UI state with explicit retry using the same asset/session.

- [ ] **Step 1: Write failing Photoshop component tests**

Mock `window.novusDesktop.projectImages.importToPhotoshop` to return `photoshop_not_running`, then success on the second call. Assert:

```tsx
fireEvent.click(screen.getByRole('menuitem', { name: '导入 Photoshop（智能对象）' }));
expect(await screen.findByRole('alert')).toHaveTextContent('请先启动 Photoshop 并打开目标文档');
fireEvent.click(screen.getByRole('button', { name: '重试导入 Photoshop' }));
expect(await screen.findByRole('status')).toHaveTextContent('已导入当前 Photoshop 文档');
expect(importToPhotoshop).toHaveBeenCalledTimes(2);
```

Add a deferred-promise test that asserts `正在导入 Photoshop…` is visible and duplicate clicks do not create a second IPC call.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npm.cmd exec vitest -- --config vitest.config.ts apps/renderer/src/canvas/ModuleNodeCard.test.tsx apps/renderer/src/app/photoshop-import.test.ts --run`

Expected: FAIL because the current menu has no busy label or retry control.

- [ ] **Step 3: Implement the explicit import state**

Replace separate booleans with:

```ts
type PhotoshopUiState =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'success'; message: string }
  | { kind: 'error'; message: string };
```

Keep the menu open during import. Render busy text, success/error notice, and an error-only button with `aria-label="重试导入 Photoshop"` that calls the same import function. Disable the main Photoshop item only when busy or structurally unavailable; runtime failures remain clickable and retryable.

- [ ] **Step 4: Make the context menu visually opaque**

In the final CSS override, use concrete theme surfaces rather than transparency:

```css
.generated-image-action-menu {
  isolation: isolate;
  overflow: hidden;
  color: var(--gate-text);
  background-color: var(--gate-card);
  background-image: none;
  border: 1px solid var(--gate-border-strong);
  box-shadow: 0 18px 52px rgb(0 0 0 / .42), 0 0 0 1px rgb(255 255 255 / .03) inset;
  opacity: 1;
  backdrop-filter: none;
}
.generated-image-action-menu > button:hover:not(:disabled),
.generated-image-action-menu > button:focus-visible {
  color: var(--gate-text);
  background: var(--gate-control-surface);
}
```

Style the error notice and retry button as a distinct bordered action card.

- [ ] **Step 5: Extend Playwright Photoshop acceptance**

Add deterministic mocked outcomes for not-running then success. Assert the menu computed background alpha is `1`, the error remains readable, retry succeeds, and the IPC call count is two.

- [ ] **Step 6: Run focused component and E2E tests**

Run: `npm.cmd exec vitest -- --config vitest.config.ts apps/renderer/src/canvas/ModuleNodeCard.test.tsx apps/renderer/src/app/photoshop-import.test.ts --run`

Run: `$env:NOVUS_E2E_PORT='43129'; npm.cmd exec playwright test -- tests/e2e/photoshop-image-action.spec.ts --project=chromium`

Expected: both commands PASS.

- [ ] **Step 7: Commit only Photoshop menu changes**

```powershell
git add -- apps/renderer/src/canvas/ModuleNodeCard.tsx apps/renderer/src/canvas/ModuleNodeCard.test.tsx apps/renderer/src/styles/app.css apps/renderer/src/styles/figma-hybrid-canvas.css tests/e2e/photoshop-image-action.spec.ts
git commit -m "fix: clarify Photoshop image import actions"
```

---

### Task 5: Real Browser Mention and Connection Acceptance

**Files:**
- Modify: `tests/e2e/media-mention-chip.spec.ts`
- Modify: `apps/renderer/src/test-mode/e2e-harness.ts`

**Interfaces:**
- Consumes: the implemented mention editor and existing E2E graph helpers.
- Produces: visible proof that caret geometry, connection scoping, disconnect cleanup, and both themes work in Chromium.

- [ ] **Step 1: Add the failing multi-chip caret scenario before production work if not already covered**

Insert three connected media mentions, place the caret after the third chip, type `继续描述`, and evaluate bounding boxes for the third chip and first typed text range. Assert the horizontal gap is at most 8 CSS pixels on the same line. Repeat after browser zoom or device scale used by the existing desktop test profile.

- [ ] **Step 2: Add connected-only and disconnect scenarios**

Seed at least two project images but connect only one. Open `@`, assert the unconnected label is absent, select the connected image, remove its edge through the harness, and assert the chip disappears without changing surrounding text.

Add these explicit harness methods:

```ts
disconnectModules(
  sourceType: CanvasModuleType,
  sourcePortId: string,
  targetType: CanvasModuleType,
  targetPortId: string,
): Promise<boolean>;
queuePhotoshopImportResults(
  results: PhotoshopImportResult[],
): void;
getPhotoshopImportCallCount(): number;
```

`disconnectModules` finds the matching source/target nodes and deletes only edges whose four endpoint fields match. The Photoshop bridge shifts the next queued result for each call and defaults to the existing success response when the queue is empty.

- [ ] **Step 3: Add light/dark screenshot assertions**

Capture the mention editor with two pin chips in both themes and store snapshots under the existing Playwright snapshot convention. Confirm chips are light rounded capsules with visible pin icons and no `@` glyph.

- [ ] **Step 4: Run focused browser acceptance**

Run: `$env:NOVUS_E2E_PORT='43129'; npm.cmd exec playwright test -- tests/e2e/media-mention-chip.spec.ts tests/e2e/photoshop-image-action.spec.ts --project=chromium`

Expected: all scenarios PASS and screenshots contain no transparent-menu or caret-drift diff.

- [ ] **Step 5: Commit E2E coverage**

```powershell
git add -- tests/e2e/media-mention-chip.spec.ts apps/renderer/src/test-mode/e2e-harness.ts
git commit -m "test: cover connected mention interactions"
```

---

### Task 6: Full Verification and Windows Installer 1.6.41

**Files:**
- Verify: `apps/desktop-modern/package.json`
- Verify: `apps/desktop-modern/electron-builder.yml`
- Generated: `apps/desktop-modern/dist-builder/desktop-modern/CanvasAtelier-Win10-11-x64-1.6.41.exe`

**Interfaces:**
- Consumes: all prior task commits.
- Produces: verified renderer/build output and a versioned Windows installer with SHA-256 evidence.

- [ ] **Step 1: Run all renderer and package tests**

Run: `npm.cmd test`

Expected: all tests pass with only the repository's documented skips.

- [ ] **Step 2: Run type checking**

Run: `npm.cmd run typecheck`

Expected: exit code 0 with no TypeScript errors.

- [ ] **Step 3: Run the production build**

Run: `npm.cmd run build`

Expected: exit code 0 and updated renderer/desktop artifacts.

- [ ] **Step 4: Run focused desktop UI acceptance again against a fresh build**

Run: `$env:NOVUS_E2E_PORT='43129'; npm.cmd exec playwright test -- tests/e2e/media-mention-chip.spec.ts tests/e2e/photoshop-image-action.spec.ts --project=chromium`

Expected: PASS with fresh light/dark screenshots.

- [ ] **Step 5: Verify packaging metadata without changing the dirty source version**

Run the packaging-boundary and runtime-entry contract tests. Confirm `artifactName` remains `CanvasAtelier-Win10-11-x64-${version}.exe` and the build output remains `dist-builder/desktop-modern`. Do not change `apps/desktop-legacy/package.json`; the formal Windows 10/11 installer is produced by the modern shell.

- [ ] **Step 6: Build the Windows installer**

Run from `apps/desktop-modern`:

`npx.cmd electron-builder --config electron-builder.yml --win nsis --config.extraMetadata.version=1.6.41`

Do not install or launch it over the user's formal application.

Expected output: `apps/desktop-modern/dist-builder/desktop-modern/CanvasAtelier-Win10-11-x64-1.6.41.exe`.

- [ ] **Step 7: Hash and smoke-test the packaged artifact**

Run: `Get-FileHash 'apps/desktop-modern/dist-builder/desktop-modern/CanvasAtelier-Win10-11-x64-1.6.41.exe' -Algorithm SHA256`

Run the existing isolated packaged smoke harness with a new temporary user-data root. Verify startup, mention input, connected-only picker, Photoshop error feedback, and clean shutdown. Do not point the packaged app at formal user data.

- [ ] **Step 8: Confirm packaging did not mutate tracked source files**

Run: `git status --short -- apps/desktop-modern/package.json apps/desktop-legacy/package.json package-lock.json`

Expected: no new release-only version edits; pre-existing dirty changes remain exactly as they were before this task.

- [ ] **Step 9: Report evidence**

Report focused E2E counts, full test counts, typecheck/build status, installer absolute path, file size, SHA-256, and any acceptance item that could not be exercised against a real running Photoshop instance.
