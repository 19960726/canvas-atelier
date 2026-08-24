# Codex Agent Conversation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a per-canvas multi-conversation Codex Agent panel with the reference layout, Canvas Atelier styling, complete model routing, and unobstructed media-slot reordering.

**Architecture:** Extract versioned conversation persistence into a pure module, keep request and canvas-action execution inside `SkillChatWorkbench`, and protect the final visual contract with scoped end-of-file CSS. Media-slot pointer behavior remains a separate CSS/test task so it cannot regress Agent logic.

**Tech Stack:** React 18, TypeScript, Vitest, Testing Library, CSS, browser `localStorage`/`sessionStorage`.

**Spec:** `docs/superpowers/specs/2026-08-24-codex-agent-conversation-design.md`

## Global Constraints

- Preserve every unrelated modified and untracked file in the current dirty worktree.
- Do not execute the reference EXE or copy its private interfaces, resources, branding, or endpoints.
- Conversations are isolated by encoded `projectId` and persist across app restarts.
- Canvas commands continue to use the existing confirmation boundary.
- Do not launch the visible desktop app during source verification.
- Do not build an installer until focused tests, related tests, typecheck, and production build pass freshly.

---

### Task 1: Versioned per-project conversation storage

**Files:**
- Create: `apps/renderer/src/agent/skill-chat-session-store.ts`
- Create: `apps/renderer/src/agent/skill-chat-session-store.test.ts`
- Modify: `apps/renderer/src/agent/SkillChatWorkbench.tsx`

**Interfaces:**
- Produces: `AgentConversationMode`, `AgentReasoningEffort`, `StoredAgentMessage`, `StoredAgentConversation`, `StoredAgentConversationCollection`, `readAgentConversationCollection`, `writeAgentConversationCollection`, `createAgentConversation`, and `deriveAgentConversationTitle`.
- Consumes: legacy v1 session shape currently parsed at the bottom of `SkillChatWorkbench.tsx`.

- [ ] **Step 1: Write the failing storage tests**

```ts
it('keeps conversations isolated by project and restores the active task', () => {
  const first = createAgentConversation(100);
  writeAgentConversationCollection('project-a', { version: 2, activeConversationId: first.id, conversations: [first] });
  expect(readAgentConversationCollection('project-b', 200).conversations).toHaveLength(1);
  expect(readAgentConversationCollection('project-a', 200).activeConversationId).toBe(first.id);
});

it('migrates the legacy per-project session without losing messages', () => {
  sessionStorage.setItem('agent-canvas:skill-chat:legacy', JSON.stringify({ version: 1, messages: [{ id: 'm1', role: 'user', content: '旧消息' }] }));
  expect(readAgentConversationCollection('legacy', 100).conversations[0]?.messages[0]?.content).toBe('旧消息');
});
```

- [ ] **Step 2: Run the storage tests and confirm RED**

Run: `npm.cmd exec vitest -- --config vitest.config.ts apps/renderer/src/agent/skill-chat-session-store.test.ts --run`

Expected: FAIL because `skill-chat-session-store.ts` does not exist.

- [ ] **Step 3: Implement the smallest versioned store**

```ts
export function createAgentConversation(now = Date.now()): StoredAgentConversation {
  return { id: `conversation-${now}`, title: '新任务', mode: 'codex', reasoningEffort: 'medium', knowledgeBaseIds: [], projectMemoryIds: [], messages: [], createdAt: now, updatedAt: now };
}

export function deriveAgentConversationTitle(content: string): string {
  return Array.from(content.trim().replace(/\s+/gu, ' ')).slice(0, 18).join('') || '新任务';
}
```

Use `localStorage` for v2, migrate the existing `sessionStorage` key once, validate all arrays/roles/IDs, and catch storage exceptions.

- [ ] **Step 4: Run the storage tests and confirm GREEN**

Run the Task 1 command and expect all tests PASS.

### Task 2: Real task creation and switching in the Agent panel

**Files:**
- Modify: `apps/renderer/src/agent/SkillChatWorkbench.tsx`
- Modify: `apps/renderer/src/agent/SkillChatWorkbench.test.tsx`

**Interfaces:**
- Consumes: Task 1 collection/store functions.
- Produces: task selector behavior that restores messages, mode, route, effort, knowledge, and memory for one active conversation.

- [ ] **Step 1: Add failing UI tests for three tasks and project isolation**

```tsx
it('creates and switches persistent tasks without clearing older messages', async () => {
  renderWorkbench();
  fireEvent.change(screen.getByTestId('agent-composer-input'), { target: { value: '第一个任务' } });
  fireEvent.submit(screen.getByTestId('agent-composer-input').closest('form')!);
  await screen.findByText('Use a clean studio-lighting hierarchy.');
  fireEvent.click(screen.getByTestId('agent-new-chat'));
  expect(screen.queryByText('第一个任务')).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Codex 任务'), { target: { value: screen.getAllByRole('option')[0]?.getAttribute('value') } });
  expect(screen.getByText('第一个任务')).toBeVisible();
});
```

- [ ] **Step 2: Run the focused component test and confirm RED**

Run: `npm.cmd exec vitest -- --config vitest.config.ts apps/renderer/src/agent/SkillChatWorkbench.test.tsx --run`

Expected: FAIL because the selector is static and the plus button clears the only message array.

- [ ] **Step 3: Wire collection state into the component**

Replace the static task options with `collection.conversations`, create a conversation with `createAgentConversation`, and use one `updateActiveConversation` helper to atomically write message/mode/route/effort/context updates. Derive the title from the first submitted user message.

- [ ] **Step 4: Verify the component test passes**

Run the Task 2 command and expect PASS with no React update-depth warnings.

### Task 3: Codex mode and reasoning-route selection

**Files:**
- Modify: `apps/renderer/src/agent/SkillChatWorkbench.tsx`
- Modify: `apps/renderer/src/agent/SkillChatWorkbench.test.tsx`
- Modify: `apps/renderer/src/app/provider-profiles.test.ts`

**Interfaces:**
- Consumes: complete profiles passed from `CanvasWorkspace` and unique Codex routes returned by `listAgentChatProfiles`.
- Produces: `selectCodexRouteForEffort(profiles, currentRoute, effort): string | undefined`.

- [ ] **Step 1: Add failing route-variant tests**

```ts
it('switches between all Codex effort variants without collapsing their routes', () => {
  renderWorkbench({ profiles: codexLowMediumHighProfiles });
  fireEvent.change(screen.getByLabelText('推理强度'), { target: { value: 'high' } });
  expect(screen.getByTestId('agent-model-trigger')).toHaveAttribute('data-selected-model', expect.stringContaining('Codex'));
  expect(screen.getByTestId('agent-model-trigger')).toHaveTextContent('high');
});
```

- [ ] **Step 2: Run the focused tests and confirm RED**

Run: `npm.cmd exec vitest -- --config vitest.config.ts apps/renderer/src/agent/SkillChatWorkbench.test.tsx apps/renderer/src/app/provider-profiles.test.ts --run`

Expected: FAIL because changing effort currently updates only transient UI state.

- [ ] **Step 3: Implement deterministic family/effort matching**

Normalize the current profile model identity, prefer a profile in the same Codex family whose route/model ID contains the requested `low`, `medium`, or `high` token, and retain the current route if no matching variant exists.

- [ ] **Step 4: Re-run focused tests and confirm GREEN**

Run the Task 3 command and expect PASS.

### Task 4: Structured referenced-image analysis protocol

**Files:**
- Create: `packages/desktop-core/src/skill-chat-visual-analysis.ts`
- Create: `packages/desktop-core/src/skill-chat-visual-analysis.test.ts`
- Modify: `packages/desktop-core/src/provider-contracts.ts`
- Modify: `packages/desktop-core/src/provider-contracts.test.ts`
- Modify: `packages/desktop-core/src/provider-skill-chat.ts`
- Modify: `packages/desktop-core/src/provider-skill-chat.test.ts`
- Modify: `apps/renderer/src/agent/SkillChatWorkbench.tsx`
- Modify: `apps/renderer/src/agent/SkillChatWorkbench.test.tsx`

**Interfaces:**
- Produces: `SkillChatReferenceMention`, `shouldEnableVisualAnalysis`, and `buildSkillChatSystemInstructions`.
- Extends: `ChatSkillBridgeRequest` with optional `agentMode`, `visualAnalysis`, and ordered `referenceMentions` metadata.
- Consumes: selected references already computed by `SkillChatWorkbench.send`.

- [ ] **Step 1: Add failing contract and instruction tests**

```ts
it('builds the complete seven-part visual analysis contract with ordered mentions', () => {
  const instructions = buildSkillChatSystemInstructions({
    visualAnalysis: true,
    referenceMentions: [
      { assetId: 'a'.repeat(64), token: '@图片1', label: '产品参考' },
      { assetId: 'b'.repeat(64), token: '@图片2', label: '环境参考' },
    ],
  });
  expect(instructions).toContain('真实可见');
  expect(instructions).toContain('前景、中景、背景');
  expect(instructions).toContain('视觉中心');
  expect(instructions).toContain('机位高度');
  expect(instructions).toContain('@图片1');
  expect(instructions).toContain('继承');
  expect(instructions).toContain('中文提示词');
});
```

- [ ] **Step 2: Run the new core tests and confirm RED**

Run: `npm.cmd exec vitest -- --config vitest.config.ts packages/desktop-core/src/skill-chat-visual-analysis.test.ts packages/desktop-core/src/provider-contracts.test.ts packages/desktop-core/src/provider-skill-chat.test.ts --run`

Expected: FAIL because the protocol builder and request metadata do not exist.

- [ ] **Step 3: Implement strict ordered metadata and system instructions**

Require each `referenceMentions[index].assetId` to equal `referenceAssetIds[index]`, limit tokens to `@图片1` through `@图片20`, and include the seven approved rules only when `visualAnalysis` is true. Keep the existing no-canvas-mutation instruction for ordinary provider chat.

- [ ] **Step 4: Wire mode-aware activation in the workbench**

Set `visualAnalysis` for referenced images in `original`, for visual/workflow intent in `codex`, and for explicit analysis intent in `chat`. Submit labels and `@图片N` tokens in the same order as `referenceAssetIds`.

- [ ] **Step 5: Run core and component tests and confirm GREEN**

Run: `npm.cmd exec vitest -- --config vitest.config.ts packages/desktop-core/src/skill-chat-visual-analysis.test.ts packages/desktop-core/src/provider-contracts.test.ts packages/desktop-core/src/provider-skill-chat.test.ts apps/renderer/src/agent/SkillChatWorkbench.test.tsx --run`

### Task 5: Final Codex Agent visual contract

Before styling, add the reverse-result workflow offer to `SkillChatWorkbench`: a successful structured reverse response renders `生成工作流 / 继续调整 / 暂不生成`; `生成工作流` calls a CanvasWorkspace adapter around `draftAgentPlan`, while actual node creation and execution remain behind the existing PlanPreview confirmation.

**Files:**
- Modify: `apps/renderer/src/styles/app.css`
- Modify: `apps/renderer/src/agent/SkillChatWorkbench.test.tsx`

**Interfaces:**
- Consumes: existing semantic class names and `agent-panel--skill-chat` panel scope.
- Produces: the reference information architecture using Canvas Atelier tokens, at the actual end of `app.css`.

- [ ] **Step 1: Add a failing cascade-order assertion**

```ts
it('places the scoped Codex Agent contract after every legacy Agent rule', () => {
  const css = readFileSync(new URL('../styles/app.css', import.meta.url), 'utf8');
  const marker = css.lastIndexOf('FINAL CODEX AGENT CONTRACT');
  expect(marker).toBeGreaterThan(css.lastIndexOf('.agent-panel .skill-chat-workbench__composer'));
  expect(css.slice(marker)).toMatch(/agent-panel--skill-chat[\s\S]*grid-template-rows:\s*76px minmax\(0, 1fr\) auto/u);
});
```

- [ ] **Step 2: Run the component stylesheet test and confirm RED**

Run the Task 2 command.

Expected: FAIL because the current Codex block appears before later legacy Agent rules.

- [ ] **Step 3: Append one scoped terminal CSS block**

Move/restate the approved layout under `/* FINAL CODEX AGENT CONTRACT */` at the true end of `app.css`. Scope every rule through `.workspace--ui-gate .agent-panel--skill-chat`, hide the old suggestion grid in the empty state, and keep sheets/popovers above the composer.

- [ ] **Step 4: Re-run the component stylesheet test**

Run the Task 2 command and expect PASS.

### Task 6: Unobstructed nine-slot media reordering

**Files:**
- Modify: `apps/renderer/src/styles/figma-hybrid-canvas.css`
- Modify: `apps/renderer/src/canvas/ConnectedAgentMediaSlots.test.tsx`

**Interfaces:**
- Consumes: existing `onMoveAsset`, drag source/target indices, and 40px item contract.
- Produces: hidden native scrollbars and hover-only reorder controls without changing data order logic.

- [ ] **Step 1: Extend the failing CSS contract**

```ts
expect(css).toMatch(/module-node__agent-media-slot-row::\-webkit-scrollbar\s*\{[^}]*display:\s*none/isu);
expect(css).toMatch(/connected-agent-media-slots__reorder\s*\{[^}]*pointer-events:\s*none/isu);
```

- [ ] **Step 2: Run the slot suite and confirm RED**

Run: `npm.cmd exec vitest -- --config vitest.config.ts apps/renderer/src/canvas/ConnectedAgentMediaSlots.test.tsx --run`

Expected: FAIL because the WebKit scrollbar rule is absent.

- [ ] **Step 3: Add the minimal terminal scrollbar rule**

```css
.workspace--ui-gate .module-node .module-node__unified-media-slots .module-node__agent-media-slot-row::-webkit-scrollbar {
  display: none !important;
  width: 0 !important;
  height: 0 !important;
}
```

Keep reorder overlays `pointer-events: none` until the item is hovered or focus-within.

- [ ] **Step 4: Run the slot suite and confirm GREEN**

Run the Task 5 command and expect PASS, including the existing slot-nine-to-slot-five drag test.

### Task 7: Regression, build, project memory, and installer gate

**Files:**
- Modify: `docs/project-memory.md`
- Modify only after all source gates pass: version fields covered by existing packaging-boundary tests.

**Interfaces:**
- Consumes: Tasks 1-5.
- Produces: fresh source/build/package evidence and a new installer that is never auto-launched.

- [ ] **Step 1: Run the focused suites**

Run: `npm.cmd exec vitest -- --config vitest.config.ts apps/renderer/src/agent/skill-chat-session-store.test.ts apps/renderer/src/agent/SkillChatWorkbench.test.tsx apps/renderer/src/app/provider-profiles.test.ts apps/renderer/src/canvas/ConnectedAgentMediaSlots.test.tsx --run`

- [ ] **Step 2: Run the related wider suites**

Run: `npm.cmd exec vitest -- --config vitest.config.ts apps/renderer/src/canvas/CanvasWorkspace.test.tsx apps/renderer/src/canvas/ModuleNodeCard.test.tsx apps/renderer/src/mentions/MediaMentionTextarea.test.tsx apps/renderer/src/app/app-store.test.ts --run`

- [ ] **Step 3: Run the user-reported interaction matrix**

Run: `npm.cmd exec vitest -- --config vitest.config.ts apps/renderer/src/app/App.test.tsx apps/renderer/src/app/desktop-persistence.test.ts apps/renderer/src/app/photoshop-import.test.ts apps/renderer/src/main.styles.test.ts apps/renderer/src/canvas/CanvasWorkspace.test.tsx apps/renderer/src/canvas/ModuleNodeCard.test.tsx apps/renderer/src/canvas/ConnectedAgentMediaSlots.test.tsx apps/renderer/src/mentions/MediaMentionTextarea.test.tsx packages/desktop-core/src/electron-clipboard-image.test.ts packages/desktop-core/src/photoshop-bridge.test.ts packages/desktop-core/src/photoshop-contract.test.ts packages/desktop-core/src/photoshop-script.test.ts --run`

Expected coverage: clipboard image ingestion, canvas paste/import, save success and `INVALID_REQUEST` recovery, Ctrl/Cmd+S, right-click generated-image actions, Photoshop import contracts, 38px control geometry, full image containment, repeated Backspace, and arbitrary media-slot reordering.

- [ ] **Step 4: Run typecheck and production build**

Run: `npm.cmd run typecheck`

Run: `npm.cmd run build`

- [ ] **Step 5: Update project memory with exact evidence**

Append the root causes, protected behavior, test files, commands, and observed pass counts to `docs/project-memory.md`. If any command is blocked by `spawn EPERM` or execution quota, record it as an environment blocker and stop before packaging.

- [ ] **Step 6: Package only after all previous steps pass**

Run the repository's existing desktop-modern NSIS packaging command, then report installer absolute path, byte size, SHA-256, Authenticode status, and installed/package version identity. Use silent install only; do not launch Canvas Atelier.
