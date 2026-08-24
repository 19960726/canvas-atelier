# Canvas UI Gate Figma Implementation Plan

> **For agentic workers:** Use the Figma plugin workflow incrementally; inspect and screenshot each created frame before moving to the next one.

**Goal:** Create an editable Figma review file that defines a compact dark desktop workbench for Canvas, executable media nodes, and Skill chat.

**Architecture:** The Figma file contains one review page with a shared desktop shell, reusable visual primitives, and separate frames for each workbench state. The layout uses the user's supplied references only for interaction hierarchy and density; all branding, icons, copy, spacing values, and visual treatment remain original.

**Tech Stack:** Figma Design, Plugin API, local Playwright screenshots as current-product evidence.

## Global Constraints

- Do not reproduce third-party brands, logos, icons, images, proprietary text, or pixel-level layouts.
- Preserve existing Canvas functionality: drag/drop and paste media, canvas nodes, image generation, reverse prompt, mock video preview, storyboard, Skill chat, Settings, and History.
- Design only controls backed by an existing capability; mark mock video and mock update behavior clearly.
- Start at desktop 1440×900 and retain a defined compact behavior for 1366×768.
- Do not change source code, publish, package, or commit as part of this Figma-only task.

---

### Task 1: Create the desktop shell and review legend

**Figma frames:** `00 · UI Gate`, `Canvas shell · 1440`, `Canvas shell · 1366`.

- [ ] Create an original dark desktop shell with topbar, slim tool rail, canvas field, optional module library, right-side Agent region, and status strip.
- [ ] Add a legend distinguishing `implemented`, `mock-only`, and `release blocker` states.
- [ ] Screenshot both shell widths and verify the right panel never covers an active node; at 1366 collapse the module library before opening Agent.

### Task 2: Define executable node workbenches

**Figma frames:** `Image generation node`, `Reverse Agent node`, `Video preview node`, `Storyboard node`.

- [ ] Image generation: result field, reference slots, prompt editor, one compact footer trigger that opens grouped ratio/resolution/quantity choices.
- [ ] Reverse Agent: model/media strip, role field, task field, collapsed knowledge summary, read-only result, paired apply/run footer.
- [ ] Video preview: managed first/last-frame slots, prompt, duration/ratio/quality controls, and an explicit simulated-preview result state.
- [ ] Storyboard: long script input, route and shot count, shot grid, selected-shot editor, and handoff to an existing image node.
- [ ] Screenshot each frame and verify all controls fit without text clipping at 1366×768.

### Task 3: Define the Skill Agent workbench

**Figma frames:** `Skill chat · empty`, `Skill chat · @ image menu`, `Skill chat · request/result`.

- [ ] Create a full-height conversation timeline with compact top model/context controls, user request, Skill request card, answer/source blocks, and readonly node-result item.
- [ ] Create the `@` image menu anchored to the composer, showing only project-managed image thumbnails, names, and a safe source label.
- [ ] Use a compact fixed composer with attach/context/model/send controls. Show stop only as a capability-gated state.
- [ ] Screenshot each state and verify keyboard focus order remains visible.

### Task 4: Settings, history, and release readiness states

**Figma frames:** `Settings`, `Generation history`, `Update dialog · mock-only`.

- [ ] Settings: model routes, provider-safe status, theme, and a controlled update-check entry.
- [ ] History: filterable generation records with result state and safe error state.
- [ ] Update dialog: available/download/error/restart states marked mock-only until a signed Release client exists.
- [ ] Screenshot all states and ensure no mock-only behavior is presented as a production capability.

### Task 5: Final review and implementation handoff

- [ ] Place the current light and dark Playwright evidence next to the target frames with concise issue annotations.
- [ ] Run Figma visual review: no overlaps, clipped controls, unreadable contrast, or unlabelled mock states.
- [ ] Return the Figma link and a code implementation priority list: shell geometry first, Agent composer second, image/reverse nodes third, video/storyboard/settings/history fourth.
