# Generation, Agent, and Photoshop Smart Object Implementation Plan

**Goal:** Ship the next single formal Canvas Atelier build with reliable result materialization, text-only Agent model menus, and proportional Photoshop Smart Object placement.

## Constraints

- Preserve unrelated existing changes and user data.
- Observe a failing regression before each production fix.
- Do not send paid provider requests.
- Install only over `D:\CanvasAtelier\Canvas Atelier` after source and package gates pass.

### Task 1: Agent model capability boundary

- [ ] Add catalog and cross-layer tests for `gemini-3-pro-image*` and `gemini-3.1-*-image*` mislabeled as chat-only.
- [ ] Add a main-process chat guard so stale cached routes cannot bypass the UI.
- [ ] Record RED, implement the smallest fail-closed classifier/filter, and record GREEN.
- [ ] Verify both “对话” and “创作 Agent” menus keep valid text models and omit image-output models.

### Task 2: Generated media durability and node materialization

- [ ] Add a bridge regression where asset commit succeeds and scheduled snapshot maintenance fails; the durable generation result must still be acknowledged.
- [ ] Add a Renderer regression where asset storage advances revision before result-node attachment; refresh/rebuild must clear the transient error and commit the result.
- [ ] Record RED, separate acknowledgement from automatic maintenance, and make refresh/rebuild robust without weakening close/stable-point durability.
- [ ] Run image and video job, app-store, desktop-persistence, bridge and save/close suites.

### Task 3: Photoshop Smart Object fallback

- [ ] Add a source contract regression requiring the Windows fallback to convert the copied layer to a Smart Object, preserve aspect ratio, fit inside the canvas, and center it.
- [ ] Record RED before editing the runner.
- [ ] Implement legacy-compatible JScript/Photoshop actions and make conversion failure return `placement_failed`.
- [ ] Run Photoshop contract, adapter, bridge and script suites; if Photoshop is available, validate in a temporary document and close without saving.

### Task 4: Codex and provider acceptance

- [ ] Verify only local Codex cache profiles appear in the Codex tab and preserve current error classification tests.
- [ ] Run zero-cost fixtures for both suppliers across image, video, image reverse and conversation reverse routes.
- [ ] Mark live provider generation separately as external/unverified unless existing authorization allows a real call.

### Task 5: Formal release and replacement

- [ ] Run full Vitest, typecheck, build, Playwright/installed smoke gates, secret scan and `git diff --check`.
- [ ] Advance to the next version only after source gates pass; build one NSIS artifact and verify hashes/version identity.
- [ ] Replace the current formal install, rerun installed save/reopen, Agent model, media, provider and Photoshop gates.
- [ ] Remove only superseded Canvas Atelier release/test artifacts proven outside the active installation and keep one formal version.
