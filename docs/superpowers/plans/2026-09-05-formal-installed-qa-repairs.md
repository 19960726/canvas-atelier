# Formal Installed QA Repairs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the false close-recovery prompt from isolated QA teardown, restore the Reverse Agent media/model order in the installed build, and let users copy an image shown in Agent sent media.

**Architecture:** Keep production close coordination unchanged because a normal installed save/close/reopen already succeeds; isolated scripts must destroy their test windows when the renderer has been replaced. Apply the two UI fixes at their existing renderer boundaries and reuse the desktop clipboard image bridge. Build and install one exact candidate, then rerun installed-app gates against that fingerprint.

**Tech Stack:** Electron 43, React, TypeScript, Vitest, Playwright, electron-builder/NSIS.

## Global Constraints

- Preserve every unrelated dirty-worktree change and all real project/provider data.
- Do not submit paid provider jobs during deterministic QA.
- A source test or packaged-directory result cannot be reported as installed-app evidence.
- Record failing regression evidence before each production fix.

---

### Task 1: Isolated QA Close Cleanup

**Files:**
- Modify: `work/qa-installed-agent-image-flow.mjs`
- Modify: `work/qa-diagnose-installed-reverse-layout.mjs`
- Modify: `work/qa-installed-ui-and-nodes.mjs`

**Interfaces:**
- Consumes: Playwright Electron application's `evaluate()` and `close()` methods.
- Produces: teardown that destroys isolated windows and calls `electronApp.exit(0)` before wrapper cleanup.

- [x] **Step 1: Reproduce the unavailable-renderer close path**

Run the Agent renderer-navigation probe and confirm its `page.goto()` replacement times out while the old `finally { app.close() }` path opens the native recovery dialog.

- [x] **Step 2: Implement isolated teardown**

```js
await app?.evaluate(({ app: electronApp, BrowserWindow }) => {
  for (const window of BrowserWindow.getAllWindows()) window.destroy();
  electronApp.exit(0);
}).catch(() => undefined);
await app?.close().catch(() => undefined);
```

- [ ] **Step 3: Verify teardown and normal close separately**

Run the failing navigation probe to its expected test timeout and verify no visible Canvas Atelier window remains. Then run `work/qa-installed-stale-project-save.mjs` to prove the production save/close/reopen path reaches clean close.

### Task 2: Agent Sent-Image Copy

**Files:**
- Modify: `apps/renderer/src/agent/SkillChatWorkbench.test.tsx`
- Modify: `apps/renderer/src/agent/SkillChatWorkbench.tsx`

**Interfaces:**
- Consumes: a sent image `displayUrl` and `window.novusDesktop.projectImages.writeClipboardImage`.
- Produces: a visible `复制图片` command for image sent media, with browser clipboard fallback and an accessible failure message.

- [ ] **Step 1: Add a failing sent-image copy test**

Render a visual message with a sent image, click `复制图片`, and assert that the native clipboard bridge receives the fetched image bytes. Verify the old component fails because no command exists.

- [ ] **Step 2: Add minimal copy behavior**

Fetch the managed image URL, prefer the native desktop bridge, fall back to `ClipboardItem`, and surface failure without altering the chat request protocol. Do not render the image command for sent video references.

- [ ] **Step 3: Verify focused behavior**

Run the `SkillChatWorkbench` suite and renderer TypeScript check.

### Task 3: Reverse Agent Media Order

**Files:**
- Modify: `apps/renderer/src/styles/app.css`
- Test: `apps/renderer/src/main.styles.test.ts`
- Test: `apps/renderer/src/canvas/ModuleNodeCard.test.tsx`

**Interfaces:**
- Consumes: the actual outer class `module-node--reverse` and `data-module-type='reverse_agent'`.
- Produces: connected-media tray before the model route, with the existing horizontal slot rail intact.

- [ ] **Step 1: Add a failing selector/order regression**

Assert that the terminal CSS contract targets the actual Reverse Agent class and assigns media before the route. Verify it fails against the current `.module-node--workbench` selector.

- [ ] **Step 2: Fix the terminal selector/order**

Target `.module-node--reverse[data-module-type='reverse_agent']`, set the media region to the first flex order and the route region to the second, and retain the 25-item overflow rules.

- [ ] **Step 3: Verify focused layout contracts**

Run the style and Reverse Agent component suites plus renderer TypeScript check.

### Task 4: Build, Install, and Formal Gates

**Files:**
- Update: `docs/project-memory.md`
- Produce: installer and QA reports under `apps/desktop-modern/dist-builder/desktop-modern/` and `work/`.

**Interfaces:**
- Consumes: the verified source tree and exact installer fingerprint.
- Produces: one installed candidate with source, package, installed executable, and installed `app.asar` evidence.

- [ ] **Step 1: Run source verification**

Run focused Vitest, full Vitest, Playwright, typecheck, build, secret scan, and `git diff --check` once the two fixes are green.

- [ ] **Step 2: Build and install the exact candidate**

Run the repository's existing release build and NSIS installer flow. Record version, size, and SHA-256 for installer, installed executable, and installed `app.asar`.

- [ ] **Step 3: Rerun installed gates**

Run normal save/close/reopen, light/dark module layout, 6/7/20/21/25 media slots, native 25-file paste, Agent image paste/send/copy, RelayMe login persistence, and MCP 14-tool plus video/reverse zero-cost chains.

- [ ] **Step 4: Record truthful acceptance**

Update `docs/project-memory.md` with causes, protected behavior, exact commands, and remaining external boundaries. Report paid generation, absent RelayMe visual chat profiles, WorkBuddy trust, Photoshop, signing, or OS-matrix rows separately from deterministic installed-app results.
