# Gemini Image Asset Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将 Gemini 原生内联生图结果安全写入当前画布项目资产库，并通过安全 `assetId` 返回给画布。

**Architecture:** 在 desktop bridge handlers 暴露 `storeGeneratedImage(sessionId, bytes, mediaType)`，复用 `AssetStore.stageAndCommit` 与 project transaction；provider bridge 对 Gemini image profile 使用同步本地结果映射，对 OpenAI-compatible 模型保持现有异步任务流程。

**Tech Stack:** TypeScript、Vitest、Zod、Electron main process、现有 AssetStore/Repository。

## Global Constraints

- Base64、文件路径、远端 URL 不穿过 IPC。
- 未打开会话、非法媒体类型、超限数据和事务失败必须拒绝并清理暂存文件。
- 不修改 Pixelle 协议；本计划只覆盖 Comfly Gemini 原生生图。

### Task 1: Desktop generated-image storage callback

**Files:**
- Modify: `packages/desktop-core/src/bridge-handlers.ts`
- Test: `packages/desktop-core/src/bridge-handlers.test.ts`（或现有资产桥接测试文件）

**Interfaces:**
- Produces `storeGeneratedImage(sessionId: string, bytes: Uint8Array, mediaType: string): Promise<{ assetId: string; width?: number; height?: number }>` on `DesktopBridgeHandlers`.

- [ ] Write a failing test for a valid PNG: stage bytes, update `project.assets`, and return only safe metadata.
- [ ] Run the focused bridge test and confirm the missing-handler failure.
- [ ] Implement the callback with `AssetStore.stageAndCommit`, `projectImageAssetSchema`, `upsertProjectImageAsset`, and a durable project transaction.
- [ ] Add failure tests for unknown session and commit failure, asserting no catalog update and no leaked temporary file.
- [ ] Run the focused bridge tests and confirm green.

### Task 2: Provider-side Gemini synchronous image path

**Files:**
- Modify: `packages/desktop-core/src/provider-bridge.ts`
- Modify: `packages/provider-comfly/src/client.ts`
- Test: `packages/desktop-core/src/provider-bridge.test.ts`

**Interfaces:**
- Consumes `storeGeneratedImage` from Task 1.
- Produces an opaque completed provider mapping whose public poll result contains `assetId` and dimensions.

- [ ] Write a failing test for a profile with `gemini_native` + `image_generation`; mock inlineData and assert the storage callback receives decoded bytes.
- [ ] Run the focused provider test and confirm the missing Gemini branch failure.
- [ ] Add `storeGeneratedImage` to `createComflyProviderService` options and wire Gemini `generateGeminiContent` with image response modalities.
- [ ] Decode with `decodeGeminiInlineImage`, store through the callback, and create a replayable local terminal mapping without exposing inline data.
- [ ] Add tests for malformed inline data and callback failure; assert sanitized provider errors.
- [ ] Run provider bridge tests and provider-comfly client tests.

### Task 3: Desktop app wiring and regression verification

**Files:**
- Modify: `apps/desktop-modern/src/main.ts`
- Modify: `apps/desktop-legacy/src/main.ts`
- Modify: `packages/desktop-core/src/provider-bridge.ts`

**Interfaces:**
- Wires `desktopHandlers.storeGeneratedImage` into both desktop shells after handler creation.

- [ ] Add the callback to both app service constructors.
- [ ] Run focused provider bridge tests, provider-comfly tests, and full typecheck.
- [ ] Run renderer-focused tests that consume completed image assets.
- [ ] Verify no IPC payload contains Base64, filesystem paths, or remote result URLs.
