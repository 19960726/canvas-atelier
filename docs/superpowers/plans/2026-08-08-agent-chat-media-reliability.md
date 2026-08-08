# Agent Chat and Media Upload Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Agent text chat and image/video attachment work in both browser acceptance and packaged desktop paths, with clear Chinese errors instead of silent no-ops.

**Architecture:** Keep `SkillChatWorkbench` as the UI state owner, but make send/import validation explicit and preserve the draft on failure. Verify the renderer persistence adapter, preload API, IPC handler, and provider service all satisfy the same chat/media contracts.

**Tech Stack:** React 19, TypeScript, Zustand, Electron IPC, Vitest, Playwright.

## Execution Prerequisite

Complete and user-approve docs/superpowers/plans/2026-08-08-comfly-relayme-multi-provider-integration.md before executing this plan.

## Global Constraints

- Preserve the approved Agent composer layout.
- Pure text chat must work with a chat-capable model without requiring vision.
- Image/video references require a vision-capable route only when references are attached.
- Support click import and clipboard paste, maximum 20 references.
- Never persist raw local file paths, API keys, object URLs, or Base64 payloads in project data.
- Do not claim real Comfly success without configured credentials and a successful request.

---

### Task 1: Eliminate silent send failures

**Files:**
- Modify: `apps/renderer/src/agent/SkillChatWorkbench.tsx`
- Modify: `apps/renderer/src/agent/SkillChatWorkbench.test.tsx`

**Interfaces:**
- Produces: explicit Chinese validation errors for missing model and unavailable bridge.
- Preserves: `chat(request): Promise<ChatSkillBridgeResult>` prop.

- [ ] **Step 1: Add failing tests for missing route and failed requests**

```tsx
fireEvent.change(screen.getByTestId('agent-composer-input'), { target: { value: '测试消息' } });
fireEvent.submit(screen.getByTestId('agent-composer-input').closest('form')!);
expect(await screen.findByRole('alert')).toHaveTextContent('请先选择可用的聊天模型');
```

For a rejected chat promise, assert the composer is restored to `测试消息`, the request card is marked error, and the alert says `Agent 对话暂时不可用，请重试。`.

- [ ] **Step 2: Verify RED**

Run: `npm.cmd test -- apps/renderer/src/agent/SkillChatWorkbench.test.tsx -t "missing chat model|restores the draft"`
Expected: FAIL because current send returns silently and clears the draft before a rejected request.

- [ ] **Step 3: Implement explicit validation and draft restoration**

At send start, handle empty route separately:

```ts
if (!modelRoute) {
  setError('请先选择可用的聊天模型。');
  return;
}
```

Capture `composer` before clearing it. On request failure, restore it only if the user has not typed a newer draft, keep the failed timeline item, and expose a retry action that resubmits the same request once.

- [ ] **Step 4: Verify GREEN and commit**

Run: `npm.cmd test -- apps/renderer/src/agent/SkillChatWorkbench.test.tsx`
Expected: all tests pass.

```powershell
git add -- apps/renderer/src/agent/SkillChatWorkbench.tsx apps/renderer/src/agent/SkillChatWorkbench.test.tsx
git commit -m "fix: make Agent send failures recoverable"
```

### Task 2: Browser click/paste import parity

**Files:**
- Modify: `apps/renderer/src/agent/SkillChatWorkbench.tsx`
- Modify: `apps/renderer/src/agent/SkillChatWorkbench.test.tsx`
- Modify: `apps/renderer/src/app/desktop-persistence.test.ts`

**Interfaces:**
- Consumes: `onImportReferenceImage(file?)` and `onImportReferenceVideo(file?)`.
- Produces: one managed attachment and one `@N` citation per successful import.

- [ ] **Step 1: Add failing tests for input reset and 20-item limit**

Select the same file twice and assert the importer is called twice after the input value is reset. Import 20 unique media items, assert 20 citations, then import item 21 and assert no blank/extra citation appears and a Chinese limit message is shown.

- [ ] **Step 2: Verify RED**

Run: `npm.cmd test -- apps/renderer/src/agent/SkillChatWorkbench.test.tsx apps/renderer/src/app/desktop-persistence.test.ts`
Expected: FAIL on same-file reselect or missing limit feedback.

- [ ] **Step 3: Normalize file input and attachment handling**

Clear `event.currentTarget.value` after reading the selected file. Validate MIME/name before selecting the importer. Attach only non-null managed results, deduplicate by `assetId`, and display `最多可引用 20 个图片或视频素材。` when full.

- [ ] **Step 4: Verify GREEN and commit**

Run the command from Step 2.
Expected: all tests pass.

```powershell
git add -- apps/renderer/src/agent/SkillChatWorkbench.tsx apps/renderer/src/agent/SkillChatWorkbench.test.tsx apps/renderer/src/app/desktop-persistence.test.ts
git commit -m "fix: make Agent media import repeatable"
```

### Task 3: Desktop bridge contract for Agent media

**Files:**
- Modify: `apps/renderer/src/app/desktop-persistence.ts`
- Modify: `apps/renderer/src/app/desktop-persistence.test.ts`
- Modify: `packages/desktop-core/src/preload-api.ts`
- Modify: `packages/desktop-core/src/project-image-bridge.test.ts`
- Modify: `packages/desktop-core/src/project-video-bridge.test.ts`
- Modify: `apps/desktop-modern/src/preload.ts`
- Modify: `apps/desktop-legacy/src/preload.ts`

**Interfaces:**
- Image import: `projectImages.importImage({ sessionId, target: { kind: 'agent_reference' } })`.
- Video import: `projectVideos.importVideo({ sessionId, target: { kind: 'agent_reference' } })`.
- Produces: managed asset summary plus updated durable project revision.

- [ ] **Step 1: Add failing adapter tests**

Mock desktop image/video bridges and assert `importAgentReferenceImage()` and `importAgentReferenceVideo()` use `kind: 'agent_reference'`, adopt the returned project/revision, and return the managed asset summary.

- [ ] **Step 2: Verify RED**

Run: `npm.cmd test -- apps/renderer/src/app/desktop-persistence.test.ts packages/desktop-core/src/project-image-bridge.test.ts packages/desktop-core/src/project-video-bridge.test.ts`
Expected: any missing or mismatched desktop path fails with the exact expected request shape.

- [ ] **Step 3: Implement the narrow bridge fixes**

Keep native picker calls fileless in desktop mode. Ensure modern and legacy preloads expose the same API and do not attempt to proxy a renderer `File` for native picker operations.

- [ ] **Step 4: Verify GREEN and commit**

Run the command from Step 2, then `npm.cmd run typecheck`.
Expected: exit 0.

```powershell
git add -- apps/renderer/src/app/desktop-persistence.ts apps/renderer/src/app/desktop-persistence.test.ts packages/desktop-core/src/preload-api.ts packages/desktop-core/src/project-image-bridge.test.ts packages/desktop-core/src/project-video-bridge.test.ts apps/desktop-modern/src/preload.ts apps/desktop-legacy/src/preload.ts
git commit -m "fix: align desktop Agent media bridges"
```

### Task 4: Chat bridge end-to-end contract

**Files:**
- Modify: `apps/renderer/src/app/desktop-persistence.test.ts`
- Modify: `packages/desktop-core/src/provider-skill-chat.test.ts`
- Modify: `packages/desktop-core/src/provider-ipc-handlers.ts`
- Modify: `packages/desktop-core/src/provider-ipc-registration.ts`
- Modify: `apps/desktop-modern/src/runtime-entry-contract.test.ts`
- Modify: `apps/desktop-legacy/src/runtime-entry-contract.test.ts`

**Interfaces:**
- Request: `ChatSkillBridgeRequest` with provider, modelRoute, sessionId, messages, context, and optional referenceAssetIds.
- Response: validated `ChatSkillBridgeResult`.

- [ ] **Step 1: Add failing contract tests**

Verify the renderer adapter forwards session ID and references, IPC registration includes `PROVIDER_BRIDGE_CHANNELS.chat`, and both desktop runtimes create a provider service with `chat` enabled.

- [ ] **Step 2: Verify RED**

Run:

```powershell
npm.cmd test -- apps/renderer/src/app/desktop-persistence.test.ts packages/desktop-core/src/provider-skill-chat.test.ts packages/desktop-core/src/provider-ipc-handlers.test.ts apps/desktop-modern/src/runtime-entry-contract.test.ts apps/desktop-legacy/src/runtime-entry-contract.test.ts
```

Expected: failures identify the first missing boundary, rather than a UI-only no-op.

- [ ] **Step 3: Repair only the failing boundary**

Register the chat handler, pass the configured provider service through runtime creation, and validate both request and response schemas. Do not introduce a mock reply in production.

- [ ] **Step 4: Verify GREEN and commit**

Run the command from Step 2 and `npm.cmd run typecheck`.
Expected: exit 0.

```powershell
git add -- apps/renderer/src/app/desktop-persistence.test.ts packages/desktop-core/src/provider-skill-chat.test.ts packages/desktop-core/src/provider-ipc-handlers.ts packages/desktop-core/src/provider-ipc-registration.ts apps/desktop-modern/src/runtime-entry-contract.test.ts apps/desktop-legacy/src/runtime-entry-contract.test.ts
git commit -m "fix: connect Agent chat across desktop runtime"
```

### Task 5: Real browser acceptance

**Files:**
- Modify: `tests/e2e/manual-acceptance-interactions.spec.ts`
- Modify: `tests/e2e/agent-chat-image-picker.spec.ts`
- Modify: `tests/e2e/agent-multi-video-media.spec.ts`

**Interfaces:**
- Consumes: working browser acceptance bridge and UI from Tasks 1–4.
- Produces: user-visible evidence for chat reply and real thumbnails.

- [ ] **Step 1: Strengthen acceptance tests**

After uploading an image, type `分析 @1`, click send, and assert both the user message and a non-empty Agent reply appear. Add a pasted video case and assert the managed thumbnail, `@2`, and outgoing `referenceAssetIds` are present.

- [ ] **Step 2: Run browser acceptance**

```powershell
$env:NOVUS_E2E_PORT='43173'; npm.cmd run e2e -- tests/e2e/manual-acceptance-interactions.spec.ts tests/e2e/agent-chat-image-picker.spec.ts tests/e2e/agent-multi-video-media.spec.ts
```

Expected: light and dark tests pass with no page errors.

- [ ] **Step 3: Run final regression gate**

```powershell
npm.cmd run typecheck
npm.cmd test -- apps/renderer/src/agent/SkillChatWorkbench.test.tsx apps/renderer/src/app/desktop-persistence.test.ts packages/desktop-core/src/provider-skill-chat.test.ts packages/desktop-core/src/project-image-bridge.test.ts packages/desktop-core/src/project-video-bridge.test.ts
```

Expected: exit 0.

- [ ] **Step 4: Commit acceptance coverage**

```powershell
git add -- tests/e2e/manual-acceptance-interactions.spec.ts tests/e2e/agent-chat-image-picker.spec.ts tests/e2e/agent-multi-video-media.spec.ts
git commit -m "test: verify Agent chat and media upload"
```