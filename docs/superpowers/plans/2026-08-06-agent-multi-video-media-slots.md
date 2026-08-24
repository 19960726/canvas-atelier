# Agent Multi-Video Media Slots Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Agent chat and Agent reverse analysis accept, display, reorder, persist, and execute up to 20 ordered mixed image/MP4 assets, while providing the same thumbnail-based `@N` image citation menu in Agent chat, reverse prompts, image prompts, and video prompts.

**Architecture:** Replace the reverse run's split `references + videoInput` representation with one ordered media contract while retaining image-only knowledge references as a derived view. Canvas inbound edge `order` is the durable source of truth; a shared renderer component displays and reorders media, desktop-core verifies managed bytes in the same order, and the provider adapter sends the ordered multimodal sequence without dropping later videos. A shared citation utility owns stable `@N` tokens and request asset IDs across all four text composers.

**Tech Stack:** TypeScript, React, React Flow, Zustand, Zod, Electron IPC/preload, Vitest, Testing Library, Playwright, Comfly provider adapter.

## Global Constraints

- Agent chat and Agent reverse accept images and managed MP4 videos in one ordered list with a combined maximum of exactly 20 items.
- No local filesystem path, arbitrary URL, credential, or raw secret may enter renderer-persisted state or public provider requests.
- A provider that cannot process multiple videos must block execution explicitly; it must never silently keep only the first video.
- Canvas inbound edge `order` remains the durable ordering source for connected node media.
- `@` image citations use project-managed image assets and must send real image IDs, not only visible text.
- Light and dark themes use the existing Figma UI Gate design tokens and identical layout geometry.
- Automated verification must not call paid provider endpoints.
- Do not package an installer until the user reviews the runtime screenshots.

---

### Task 1: Ordered Agent media domain contract

**Files:**
- Modify: `packages/domain/src/reverse-prompt-agent.ts`
- Modify: `packages/domain/src/reverse-prompt-agent.test.ts`
- Modify: `packages/domain/src/index.ts`
- Modify: `packages/domain/src/project-schema.ts`
- Modify: `packages/domain/src/project-schema.test.ts`

**Interfaces:**
- Produces: `orderedAgentMediaItemSchema`, `OrderedAgentMediaItem`, and `ReversePromptRun['orderedMedia']`.
- Preserves: `run.references` and `run.referenceAssetIds` as derived image-only knowledge-lease inputs during migration.

- [ ] **Step 1: Write failing domain tests for 20 mixed ordered media items**

Add tests that construct ten image identities and ten MP4 snapshots with `order: 0..19`, then assert `createReversePromptRun()` preserves the interleaved order. Add rejection tests for 21 items, duplicate `assetId`, duplicate/non-contiguous `order`, non-MP4 videos, and per-video size overflow.

```ts
const orderedMedia = Array.from({ length: 20 }, (_, order) => order % 2 === 0
  ? { kind: 'image' as const, assetId: id(order), sha256: hash(order), byteSize: 128, mediaType: 'image/png' as const, order }
  : { kind: 'video' as const, ...managedVideo(order), order });
expect(createReversePromptRun({ ...baseInput, orderedMedia }).orderedMedia).toEqual(orderedMedia);
```

- [ ] **Step 2: Run the focused domain tests and verify RED**

Run:

```powershell
npm.cmd test -- packages/domain/src/reverse-prompt-agent.test.ts packages/domain/src/project-schema.test.ts
```

Expected: FAIL because `orderedMedia` is not part of `ReversePromptRun` and the old schema accepts only one `videoInput`.

- [ ] **Step 3: Implement the ordered media schema and migration**

Add a discriminated union keyed by `kind`, cap it with `MAX_GENERATION_REFERENCES`, and validate unique asset IDs plus continuous order. Update `createReversePromptRun()` to normalize order. During project parsing, migrate old `references + videoInput` to ordered media once, preserving old edge order where available and appending the old video otherwise.

```ts
export const orderedAgentMediaItemSchema = z.discriminatedUnion('kind', [
  managedAgentImageItemSchema,
  managedAgentVideoItemSchema,
]);

const orderedAgentMediaSchema = z.array(orderedAgentMediaItemSchema)
  .min(1)
  .max(MAX_GENERATION_REFERENCES)
  .superRefine(validateUniqueContinuousMediaOrder);
```

- [ ] **Step 4: Keep knowledge references derived from ordered images**

Build `references` and `referenceAssetIds` from image items only, preserving their relative mixed-list order. Update the lease consistency check to compare that derived list.

- [ ] **Step 5: Run focused tests until GREEN**

Run the Step 2 command. Expected: all focused domain tests pass with zero failures.

---

### Task 2: Resolve multiple connected videos in exact edge order

**Files:**
- Modify: `apps/renderer/src/canvas/reverse-agent-media.ts`
- Modify: `apps/renderer/src/canvas/reverse-agent-media.test.ts`
- Modify: `apps/renderer/src/app/app-store.ts`
- Modify: `apps/renderer/src/app/app-store.test.ts`

**Interfaces:**
- Produces: `resolveConnectedReverseMedia(...): { ok: true; references; media; orderedMedia } | { ok: false; reason }`.
- Consumes: `OrderedAgentMediaItem` from Task 1.

- [ ] **Step 1: Replace the old multiple-video rejection test with a failing ordered-mixed-media test**

Create two image input nodes and three video input nodes connected to one reverse Agent with interleaved edge orders. Assert all five appear in `media` and `orderedMedia` in edge order. Add a 21st edge rejection test and a duplicate asset rejection test.

```ts
expect(result.ok && result.orderedMedia.map((item) => `${item.kind}:${item.assetId}`)).toEqual([
  'video:video-a', 'image:image-a', 'video:video-b', 'image:image-b', 'video:video-c',
]);
```

- [ ] **Step 2: Run resolver and store tests to verify RED**

```powershell
npm.cmd test -- apps/renderer/src/canvas/reverse-agent-media.test.ts apps/renderer/src/app/app-store.test.ts -t "reverse|multiple videos|ordered media"
```

Expected: FAIL at the current `videos.length > 1` guard and single `videoInput` construction.

- [ ] **Step 3: Implement one-pass ordered edge resolution**

Sort only inbound `references`/media-compatible edges by `order`, reject more than 20, validate every managed image/video identity, reject duplicates, and push each item directly into `orderedMedia`. Remove `videos.length > 1` and `videoInput` output.

- [ ] **Step 4: Update `runReverseAgentNode` to build the new run**

Pass `orderedMedia: resolvedMedia.orderedMedia` to `createReversePromptRun()` and send the same ordered identities to `analyzeReversePrompt`. Do not reconstruct arrays in a different order.

- [ ] **Step 5: Run resolver and store tests until GREEN**

Run the Step 2 command without `-t` if filtering omits newly added cases. Expected: zero failures.

---

### Task 3: Atomic drag reordering for Agent inbound media

**Files:**
- Modify: `apps/renderer/src/app/app-store.ts`
- Modify: `apps/renderer/src/app/app-store.test.ts`
- Modify: `apps/renderer/src/canvas/CanvasWorkspace.tsx`
- Modify: `apps/renderer/src/canvas/CanvasWorkspace.test.tsx`
- Modify: `packages/domain/src/module-graph.ts`
- Modify: `packages/domain/src/module-graph.test.ts`

**Interfaces:**
- Produces: `reorderAgentMedia(nodeId: string, orderedEdgeIds: readonly string[]): Promise<boolean>` in the app store.
- Invariant: the target Agent's valid inbound media edge orders are exactly `0..N-1` after a successful transaction.

- [ ] **Step 1: Write failing store tests for arbitrary reorder**

Build four mixed inbound edges and call `reorderAgentMedia(agentId, [edge4, edge1, edge3, edge2])`. Assert one canvas transaction updates all four edge orders, unrelated edges remain unchanged, and persisted project order matches the request. Add tests for duplicate IDs, missing IDs, foreign edges, more than 20 edges, and commit failure rollback.

- [ ] **Step 2: Run focused store/workspace tests and verify RED**

```powershell
npm.cmd test -- apps/renderer/src/app/app-store.test.ts apps/renderer/src/canvas/CanvasWorkspace.test.tsx packages/domain/src/module-graph.test.ts -t "reorder Agent media|ordered inbound media"
```

Expected: FAIL because no reorder action exists.

- [ ] **Step 3: Implement atomic edge-order updates**

Validate the requested edge ID set exactly matches the Agent's current valid inbound media edges. Create one `ProjectTransaction` whose canvas operations update every edge order. Use the existing stable persistence queue so a failed commit leaves the prior project unchanged.

- [ ] **Step 4: Expose the action through module node data**

Pass `onReorderAgentMedia` from `CanvasWorkspace` into `ModuleNodeCard` without storing temporary order in component-local state after drop.

- [ ] **Step 5: Run focused tests until GREEN**

Run the Step 2 command. Expected: all reorder and graph validation tests pass.

---

### Task 4: Shared mixed-media slot component and Figma UI Gate styling

**Files:**
- Create: `apps/renderer/src/canvas/ConnectedAgentMediaSlots.tsx`
- Create: `apps/renderer/src/canvas/ConnectedAgentMediaSlots.test.tsx`
- Modify: `apps/renderer/src/canvas/ModuleNodeCard.tsx`
- Modify: `apps/renderer/src/agent/SkillChatWorkbench.tsx`
- Modify: `apps/renderer/src/agent/SkillChatWorkbench.test.tsx`
- Modify: `apps/renderer/src/styles/figma-hybrid-canvas.css`
- Modify: `apps/renderer/src/main.styles.test.ts`

**Interfaces:**
- Produces: `ConnectedAgentMediaSlots({ media, onReorder, onRemove, onPreview, readOnly })`.
- Consumes: ordered mixed media plus managed image/video summaries.

- [ ] **Step 1: Write failing component tests for mixed thumbnails and drag/drop**

Render two images and two videos. Assert four numbered slots, video poster/cover treatment, `4 / 20`, mouse drag from slot 4 to slot 1, keyboard “前移/后移”, remove behavior, and no accidental parent-node drag from preview/delete controls.

- [ ] **Step 2: Run component/style tests and verify RED**

```powershell
npm.cmd test -- apps/renderer/src/canvas/ConnectedAgentMediaSlots.test.tsx apps/renderer/src/agent/SkillChatWorkbench.test.tsx apps/renderer/src/main.styles.test.ts
```

Expected: FAIL because the shared component and required CSS contract do not exist.

- [ ] **Step 3: Implement the shared component**

Use native drag events with an insertion marker and a stable `draggedAssetId`. Call `onReorder` only on a valid drop. Include keyboard buttons with accessible names and keep all controls `nodrag nopan`.

```tsx
<ConnectedAgentMediaSlots
  media={orderedMedia}
  onReorder={(next) => onReorder(next.map((item) => item.edgeId))}
  onRemove={onRemove}
  onPreview={onPreview}
/>
```

- [ ] **Step 4: Replace duplicate Agent/reverse media trays**

Use the shared component in the reverse Agent node and Agent chat attachment area. Preserve independent React/Figma layer structure: container, header/count, scroll row, each media item, poster/thumbnail, order badge, preview action, remove action, and insertion indicator.

- [ ] **Step 5: Add light/dark token-driven styling**

Use existing `--gate-*` and settings/canvas border variables; do not hardcode a separate video-card palette. Keep the same width, height, gap, radius, and text alignment in both themes.

- [ ] **Step 6: Run component/style tests until GREEN**

Run the Step 2 command. Expected: zero failures.

---

### Task 5: Desktop bridge and provider multi-video delivery

**Files:**
- Modify: `packages/desktop-core/src/provider-contracts.ts`
- Modify: `packages/desktop-core/src/provider-bridge.ts`
- Modify: `packages/desktop-core/src/provider-bridge.test.ts`
- Modify: `packages/desktop-core/src/bridge-handlers.ts`
- Modify: `packages/desktop-core/src/bridge-contract.test.ts`
- Modify: `packages/provider-comfly/src/types.ts`
- Modify: `packages/provider-comfly/src/client.ts`
- Modify: `packages/provider-comfly/src/client.test.ts`

**Interfaces:**
- Consumes: `ReversePromptRun['orderedMedia']` and matching managed byte payloads in identical index order.
- Produces: provider request content that preserves image/video interleaving.

- [ ] **Step 1: Write failing bridge schema tests for multiple videos**

Validate a request containing at least two videos and two images. Reject mismatched media length/order/identity, missing bytes, and a route without both `reverse_prompt` and `video_understanding` when any video is present.

- [ ] **Step 2: Write failing provider adapter tests for interleaved contents**

Assert the provider input sequence remains video A, image A, video B, image B and contains all four payloads. Add an explicit test proving the second video is not omitted.

- [ ] **Step 3: Run focused bridge/provider tests and verify RED**

```powershell
npm.cmd test -- packages/desktop-core/src/provider-bridge.test.ts packages/desktop-core/src/bridge-contract.test.ts packages/provider-comfly/src/client.test.ts -t "multiple videos|ordered media|reverse"
```

Expected: FAIL because bridge validation pins only `run.videoInput` and provider mapping assumes one video.

- [ ] **Step 4: Update bridge validation and managed byte reads**

Compare every `run.orderedMedia[index]` to `request.media[index]`, read each managed asset in order, and preserve the same order in the byte array returned to the provider bridge.

- [ ] **Step 5: Update Comfly mapping and capability errors**

Map each ordered item to the provider's supported multimodal part. If the selected model route reports no multi-video support, return a stable capability error before network submission. Never truncate.

- [ ] **Step 6: Run bridge/provider tests until GREEN**

Run the Step 3 command without filtering. Expected: zero failures.

---

### Task 6: Shared thumbnail `@N` image citation behavior

**Files:**
- Modify: `packages/domain/src/knowledge-context.ts`
- Modify: `packages/domain/src/knowledge-context.test.ts`
- Modify: `apps/renderer/src/agent/ImageMentionComposer.tsx`
- Modify: `apps/renderer/src/agent/ImageMentionComposer.test.tsx`
- Modify: `apps/renderer/src/agent/SkillChatWorkbench.tsx`
- Modify: `apps/renderer/src/agent/SkillChatWorkbench.test.tsx`
- Modify: `apps/renderer/src/canvas/ModuleNodeCard.tsx`
- Modify: `apps/renderer/src/canvas/ModuleNodeCard.test.tsx`
- Modify: `apps/renderer/src/styles/figma-hybrid-canvas.css`

**Interfaces:**
- Produces: citation objects `{ token: '@1', assetId, label }` and helpers to insert, remove, reconcile, and merge citation assets with graph media.
- Applies to: Agent chat, reverse task, image-generation prompt, and video-generation prompt.

- [ ] **Step 1: Write failing citation utility tests**

Cover inserting `@1` at the cursor, adding `@2`, deleting a token, clicking a citation chip, duplicate selection, missing assets, and merging graph media with citations by asset ID while preserving graph order first.

- [ ] **Step 2: Write failing UI tests for all four composers**

For each input, type `@`, assert a compact menu containing thumbnail, image name, and `@1`; select it, assert the input token and thumbnail chip; execute and assert the actual asset ID is included in the request. Confirm no permanent `@` button appears.

- [ ] **Step 3: Run focused citation/component tests and verify RED**

```powershell
npm.cmd test -- apps/renderer/src/agent/ImageMentionComposer.test.tsx apps/renderer/src/agent/SkillChatWorkbench.test.tsx apps/renderer/src/canvas/ModuleNodeCard.test.tsx packages/domain/src/knowledge-context.test.ts
```

Expected: FAIL because canvas prompt menus currently render text-only items and use label tokens instead of one shared citation contract.

- [ ] **Step 4: Implement shared citation helpers and thumbnail menu**

Keep citation identity separate from visible text. Render a real managed thumbnail, display label, and short token. Internal scrolling must prevent the popup from expanding the Agent panel.

- [ ] **Step 5: Connect citations to real execution inputs**

Agent chat sends citation asset IDs through its bridge request. Reverse Agent merges citations into ordered media after graph-connected items. Image/video generation merges citations into reference asset IDs. Missing/unsupported assets block execution with a visible error.

- [ ] **Step 6: Run focused tests until GREEN**

Run the Step 3 command. Expected: zero failures.

---

### Task 7: Settings, MCP, model configuration, and cache-path regression gate

**Files:**
- Modify only if tests reveal a regression: `apps/renderer/src/settings/SettingsDrawer.tsx`
- Modify only if tests reveal a regression: `apps/renderer/src/settings/SettingsDrawer.test.tsx`
- Modify: `tests/e2e/current-settings-ui.spec.ts`
- Screenshot output: `artifacts/2026-08-06-agent-multimedia/`

**Interfaces:**
- Verifies: MCP config copy/permissions, hidden keys, provider/model lists and defaults, custom cache path/open/reset, and browser-mode disabled explanation.

- [ ] **Step 1: Run the full SettingsDrawer suite**

```powershell
npm.cmd test -- apps/renderer/src/settings/SettingsDrawer.test.tsx packages/desktop-core/src/cache-directory-service.test.ts packages/desktop-core/src/bridge-contract.test.ts
```

Expected: all tests pass. If any fail, add the smallest failing regression test before changing production code.

- [ ] **Step 2: Verify MCP and model actions explicitly**

Confirm copied MCP JSON contains the canvas workflow protocol, current permission flags, and node capabilities while excluding secrets. Confirm hidden-key save uses secure storage and default model save calls `updateProfiles` without resubmitting credentials.

- [ ] **Step 3: Run settings E2E in both themes**

Capture API/model, MCP, and storage pages in light and dark themes. Browser mode must say `仅桌面版可选择缓存路径`; desktop tests must prove choose/cancel/failure/reset behavior.

---

### Task 8: End-to-end workflow verification and screenshot handoff

**Files:**
- Create: `tests/e2e/agent-multi-video-media.spec.ts`
- Create: `tests/e2e/agent-multimedia-screenshots.spec.ts`
- Modify: `tests/e2e/helpers/app.ts`
- Output: `artifacts/2026-08-06-agent-multimedia/*.png`

**Interfaces:**
- Verifies the complete user-visible workflow without paid model calls.

- [ ] **Step 1: Add an E2E harness fixture with two images and two MP4 assets**

Create managed asset summaries and input nodes, connect them to Agent reverse in interleaved order, and expose the mock run request snapshot for assertion.

- [ ] **Step 2: Verify arbitrary drag reorder and persistence**

Drag slot 4 to slot 1, assert visible order changes, save/reload the project, and assert the same order remains. Execute through a mock provider and assert request order equals the slot order.

- [ ] **Step 3: Verify `@` citations on all four inputs**

Type `@`, select a thumbnail item, assert `@1` and citation chip, then assert the mock request includes the selected image ID.

- [ ] **Step 4: Capture and inspect current-run screenshots**

At 1600×1000, capture and inspect:

- `light-agent-chat-multi-media.png`
- `dark-agent-chat-multi-media.png`
- `light-reverse-multi-video-reordered.png`
- `dark-reverse-multi-video-reordered.png`
- `light-at-image-reference-menu.png`
- `dark-at-image-reference-menu.png`
- `light-settings-api-models.png`
- `dark-settings-api-models.png`
- `light-settings-mcp.png`
- `dark-settings-mcp.png`
- `light-settings-storage.png`
- `dark-settings-storage.png`

Reject and recapture any screenshot with overlap, clipping, blank thumbnails, wrong theme, loading state, or misplaced popups.

- [ ] **Step 5: Run final verification**

```powershell
npm.cmd test -- packages/domain/src/reverse-prompt-agent.test.ts packages/domain/src/project-schema.test.ts packages/domain/src/module-graph.test.ts packages/desktop-core/src/provider-bridge.test.ts packages/desktop-core/src/bridge-contract.test.ts packages/desktop-core/src/cache-directory-service.test.ts packages/provider-comfly/src/client.test.ts apps/renderer/src/canvas/reverse-agent-media.test.ts apps/renderer/src/canvas/ConnectedAgentMediaSlots.test.tsx apps/renderer/src/canvas/ModuleNodeCard.test.tsx apps/renderer/src/canvas/CanvasWorkspace.test.tsx apps/renderer/src/agent/ImageMentionComposer.test.tsx apps/renderer/src/agent/SkillChatWorkbench.test.tsx apps/renderer/src/settings/SettingsDrawer.test.tsx apps/renderer/src/app/app-store.test.ts apps/renderer/src/main.styles.test.ts
npm.cmd run typecheck
npm.cmd run scan:e2e
```

Expected: all selected tests pass, TypeScript exits 0, and E2E scan reports no forbidden secrets or paid calls.

- [ ] **Step 6: Run the two new Playwright specs**

Use the repository's reused local Vite server and aligned nonce. Expected: both themes pass, all required screenshots exist, and every captured file is visually inspected before handoff.