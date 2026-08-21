# Inline Media Mention Chips Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render managed image and video citations as highlighted `图片N` / `视频N` chips without a visible `@`, while preserving canonical tokens and managed asset bindings for providers.

**Architecture:** Add one reusable controlled textarea overlay that parses canonical `@图片N` and `@视频N` tokens into visual chips. The real textarea remains the input and persistence surface; a pointer-free synchronized presentation layer hides the raw glyphs, highlights semantic labels, and provides focus/hover preview metadata. Reuse it in Agent chat and all canvas prompt editors.

**Tech Stack:** React, TypeScript, CSS, Vitest, Testing Library, Playwright, Electron Builder.

## Global Constraints

- Visible selected references are exactly `图片1`…`图片20` and `视频1`… without `@`.
- Image and video numbering remain independent.
- Canonical provider text and managed asset IDs remain unchanged.
- Existing projects containing canonical tokens render as chips after reopening.
- No node is automatically created or executed.
- Existing dirty workspace changes remain untouched and unstaged.

---

### Task 1: Build the reusable mention presentation textarea

**Files:**
- Create: `apps/renderer/src/mentions/MediaMentionTextarea.tsx`
- Create: `apps/renderer/src/mentions/MediaMentionTextarea.test.tsx`
- Modify: `apps/renderer/src/styles/app.css`

**Interfaces:**
- Produces: `MediaMentionTextarea(props: MediaMentionTextareaProps)`.
- Consumes: controlled textarea props plus optional managed media preview records.

- [ ] **Step 1: Write failing parser and component tests**

Assert canonical text `使用@图片1并参考@视频1` renders visible chip labels `图片1` and `视频1`, that no presentation node contains `@图片1`, the textarea retains the canonical value, and `@图片20` renders `图片20`.

- [ ] **Step 2: Verify RED**

Run: `npm.cmd exec vitest -- --config vitest.config.ts apps/renderer/src/mentions/MediaMentionTextarea.test.tsx --run`

Expected: FAIL because the component does not exist.

- [ ] **Step 3: Implement the controlled overlay**

Parse with `/@(图片|视频)(\d{1,2})/gu`. Render ordinary text as text nodes and references as `<mark data-media-mention="image|video">图片N|视频N</mark>`. Keep the textarea value canonical, synchronize scroll offsets, set the textarea glyph fill transparent while retaining caret and selection, and expose a hover/focus preview card when matching media metadata exists.

- [ ] **Step 4: Verify GREEN**

Run the Step 2 command and expect all tests PASS.

### Task 2: Reuse chips in Agent and canvas prompt editors

**Files:**
- Modify: `apps/renderer/src/agent/SkillChatWorkbench.tsx`
- Modify: `apps/renderer/src/agent/SkillChatWorkbench.test.tsx`
- Modify: `apps/renderer/src/canvas/ModuleNodeCard.tsx`
- Modify: `apps/renderer/src/canvas/ModuleNodeCard.test.tsx`

**Interfaces:**
- Consumes: `MediaMentionTextarea`.
- Preserves: existing `onChange`, keyboard Escape, mention picker, citation removal, `referenceAssetIds`, and provider request text.

- [ ] **Step 1: Add failing integration assertions**

After selecting a managed image, assert the textbox retains canonical `@图片1`, the visible presentation contains highlighted `图片1`, no visible chip includes `@`, and the run request still contains the selected asset ID. Repeat for a video chip.

- [ ] **Step 2: Verify RED**

Run: `npm.cmd exec vitest -- --config vitest.config.ts apps/renderer/src/agent/SkillChatWorkbench.test.tsx apps/renderer/src/canvas/ModuleNodeCard.test.tsx --run -t "mention chip|highlighted media reference"`

Expected: FAIL because existing textareas expose raw canonical tokens.

- [ ] **Step 3: Replace the four mention-aware textareas**

Use `MediaMentionTextarea` for Agent chat, reverse task, image-generation prompt, and video-generation prompt. Pass project images/videos as preview metadata and preserve all existing callbacks and ARIA labels.

- [ ] **Step 4: Verify GREEN**

Run the Step 2 command and expect all selected tests PASS.

### Task 3: Browser acceptance and replacement installer

**Files:**
- Modify: `tests/e2e/agent-chat-image-picker.spec.ts`
- Modify: `tests/e2e/agent-multi-video-media.spec.ts`
- Create: `tests/e2e/media-mention-chip.spec.ts`
- Generate: `apps/desktop-modern/dist-builder/desktop-modern/CanvasAtelier-Win10-11-x64-1.6.40.exe`

**Interfaces:**
- Consumes: completed Tasks 1-2.
- Produces: verified Windows installer version `1.6.40`.

- [ ] **Step 1: Add E2E acceptance**

In light and dark themes, type `@`, select an image and video, assert the visible chip labels omit `@`, hover each chip, verify the managed thumbnail/filename preview, and assert the underlying textarea canonical value remains correct.

- [ ] **Step 2: Run E2E**

Run: `npm.cmd run e2e -- tests/e2e/media-mention-chip.spec.ts tests/e2e/agent-chat-image-picker.spec.ts tests/e2e/agent-multi-video-media.spec.ts`

Expected: all tests PASS.

- [ ] **Step 3: Run code verification**

Run: `npm.cmd test`, `npm.cmd run typecheck`, and `npm.cmd run build`.

Expected: exit code 0 for every command.

- [ ] **Step 4: Build the new installer**

Run from `apps/desktop-modern`:

`npx.cmd electron-builder --config electron-builder.yml --win nsis --config.extraMetadata.version=1.6.40`

Expected: `CanvasAtelier-Win10-11-x64-1.6.40.exe` exists and older installers remain untouched.

- [ ] **Step 5: Verify artifact identity**

Check file size, `FileVersion`, `ProductVersion`, SHA-256, and packaged renderer assets. Confirm packaged CSS contains the mention-chip selectors and packaged JavaScript contains `图片1`, `视频1`, and the preview component label.
