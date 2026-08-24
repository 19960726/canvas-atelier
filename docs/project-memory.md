# Canvas Atelier project memory

This is the durable regression memory for `staging-canvas-build`. Read it before every modification and update it after every verified fix.

## Current continuation checkpoint

- Current objective: completed on 2026-08-23. Preserve the verified layout, wheel, clipboard, mention, Reverse Agent, draft, startup hydration, autosave, and reopen behavior in every later change.
- Completed: root causes traced; durable working rules added; regression tests added for final CSS anchoring, node `nowheel` boundary, image/video draft dispatch, and generation draft autosave.
- Current evidence: focused persistence/UI suites pass 396/396. Full workspace TypeScript/build passes. Full workspace Vitest passes 193 files and 2283 tests, with 2 performance suites/tests skipped by design and 0 failures.
- Completed implementation: final image/video rail is absolutely anchored 18px inside the node bottom; every module node is a React Flow `nowheel` boundary; image/video prompt and control drafts immediately enter the active project and schedule autosave.
- Durable-state audit: the most recent installed-app snapshot (`s-47-18423096`, revision 47) contains all nine image nodes and the image prompt `生成一条鱼`, but its Reverse Agent `role` and `task` are empty. This proves the reported reverse failure was a missing saved task, not successful model execution.
- Verified: full workspace suite passed on 2026-08-23: 193 test files passed, 2 performance suites skipped by design, 2283 tests passed and 0 failed. This includes Reverse Agent, ordered media, mention input/wheel, clipboard media, Photoshop, autosave/recovery, image/video generation, and desktop persistence suites.
- Verified: full workspace TypeScript typecheck and production build exited successfully. Vite emitted only its existing large-chunk advisory.
- Verified packaged runtime: the current `win-unpacked/Canvas Atelier.exe` opened against an isolated QA data root, displayed the canvas, reported no fatal alert, and closed normally.
- Current installer: `apps/desktop-modern/dist-builder/desktop-modern/CanvasAtelier-Win10-11-x64-1.6.38.exe`; last write `2026-08-23 15:30:00`; size `103100925` bytes; SHA-256 `6328649E97872031DE98A4171732B774092E771420C7F3393238535BBE1707EA`. Any earlier same-name binary is obsolete; compare SHA-256, not filename alone.
- Next continuation: if the user reports a packaged-runtime symptom, reproduce it against this exact hash and append the result here before changing code. Do not compare against an older `1.6.38` binary by filename alone.

## Non-negotiable product behavior

- Preserve all unrelated uncommitted work. Never reset or replace the dirty worktree.
- Image-generation and video-generation parameter rails stay inside the bottom of their expanded node. They must never participate in normal document flow, jump to the top, or overflow the node boundary.
- All controls in a generation rail use one aligned height and remain usable at supported zoom levels.
- Text and parameter edits are drafts of the current node immediately. Collapsing, selecting another node, autosaving, closing, and reopening must not revert them to stale config.
- Autosave overwrites the active saved project identity. It must not silently create a blank replacement project, and it must restore text/config as well as media.
- Reverse Agent uses every connected media item in deterministic input order. A successful provider connection is not sufficient by itself: role/task/route drafts must remain present and the UI must explain any real validation failure.
- Typing `@` at any valid caret position opens the reference picker. Existing mention chips must not prevent later mentions. The picker and every long editor/list must accept mouse-wheel scrolling without React Flow consuming the event.
- Pasting an image or video into a selected compatible node replaces that node's material directly. Pasting on blank canvas creates the appropriate input node. It must not open a file chooser unless the user explicitly clicks import/upload.
- Keep the minimap usable for returning to off-screen nodes.

## Active regression audit (2026-08-23)

### Generation rail placement

- Observed cause: the last `Final terminal generation geometry` CSS block overrides the earlier bottom-anchor rule with `position: static !important`, so image/video controls render at the top and can escape the card.
- Protected fix: final cascade must use absolute bottom anchoring with explicit insets and reserved editor space.
- Regression test: `apps/renderer/src/main.styles.test.ts` must assert the final rule, not an obsolete intermediate rule.
- 2026-08-23 follow-up root cause: the compact video rail assigned both `Video preview quantity` and `.module-node__run-generation` to grid column 5. CSS Grid therefore created an implicit second row, making the action drop below the other controls and enlarging/overflowing the white rail. The old regression test incorrectly required this collision.
- Protected fix: after hidden video mode/duration/audio controls are removed, the five visible cells are model column 1, ratio column 2, resolution column 3, quantity column 4, and action column 5. The rail has one explicit 38px row; every visible control and the action remain 38px high.
- Verification: `npm.cmd exec vitest -- --config vitest.config.ts apps/renderer/src/main.styles.test.ts apps/renderer/src/canvas/ModuleNodeCard.test.tsx --run` passed 193/193 after first failing exactly on the erroneous quantity-column contract.
- Packaged follow-up exposed a second cascade defect: the old expanded-video selector had greater specificity than the first shared terminal child selector, so model and quantity remained 28px while the popovers/action were 38px. The legacy rail also retained a 64px minimum and full-parent width, extending past the node despite final left/right insets.
- Protected terminal geometry: the rail width is `calc(100% - 36px)`, height/min/max-height are 60px, and its direct image/video selects plus the action are explicitly 38px at the same expanded-state specificity. Do not weaken this to a low-specificity shared `:is(...)` rule.
- Packaged coordinate acceptance after rebuilding: video model, ratio, resolution, quantity, and action all measured `y=1190` and `height=38`; rail measured `height=60`; `oneRow=true`, `oneHeight=true`, and `railInsideNode=true`.
- Release verification after the follow-up: full workspace Vitest passed 193 files and 2269 tests with 2 performance suites/tests skipped by design; `npm.cmd run build` completed typecheck plus all production builds with exit code 0; Electron Builder completed NSIS packaging with exit code 0; packaged smoke reported `canvasVisible: true` and `fatalAlertCount: 0`.

### Draft text disappearing

- Observed cause: image/video editors keep prompt and parameters only in component-local state. Unmount/reopen initializes from stale node config, so typed text disappears and autosave cannot serialize it.
- Protected fix: every edit updates the active node config and schedules autosave, matching the Reverse Agent draft path.
- Regression tests: component draft-dispatch tests plus store save/restore tests.
- 2026-08-23 reopen root cause: image, video, and Reverse Agent editors initialized local text state from `config` only once. When desktop hydration or opening a saved canvas supplied newer config to an already mounted node with the same id, the editors kept their earlier blank local state and their draft effects could write those blanks back over the restored values.
- Protected hydration fix: whenever persisted `config.prompt`, Reverse `config.role`/`config.task`, model controls, knowledge ids, or reference ids change, synchronize the mounted editor state before its draft effect persists again. This applies to image generation, video generation, and Reverse Agent; do not rely on `useState(config...)` initialization alone.
- Regression proof: three new component cases first failed for restored Reverse, image, and video text, then passed after config-to-local synchronization. The combined style/component/store/App close-flush run passed 4 files and 367 tests.
- 2026-08-23 packaged-runtime root cause: startup `hydratePersistence()` could finish after the user had already created nodes and typed. It unconditionally cancelled the pending autosave and replaced the active canvas with the earlier startup snapshot, producing the visible symptom where text suddenly vanished and only old media survived reopening.
- Protected startup rule: capture the project object and persistence generation before hydration. Apply the hydration result only if both remain unchanged after every hydration read; a delayed startup result must never cancel or overwrite edits made while the app is opening.
- 2026-08-23 commit race root cause: generation and Reverse draft actions waited for the active stable commit before placing text in store state. Closing during that wait saw no pending draft. A successful older ACK was also treated as failure whenever a newer draft changed the project object.
- Protected draft/ACK rule: draft actions synchronously update the active project and schedule autosave. When an older commit succeeds in the same project and generation, accept only its revision while preserving the newer project object, then commit the queued latest draft.
- Additional persistence protections: Reverse field writes are serialized and merged; first writable desktop session creation is single-flight; autosave commits preserve newer drafts scheduled during an in-flight commit; same-project layout synchronization does not rotate the persistence boundary.
- Packaged acceptance: two independent runs each created Reverse, image, and video nodes, typed unique text, clicked the real close button, reopened the app, and restored every field exactly. All six reopen scenarios passed.

### Wheel scrolling

- Observed risk: React Flow consumes wheel events unless interactive node regions use its `nowheel` boundary; isolated textarea handlers do not protect every nested menu/list/editor.
- Protected fix: node/editor scroll regions must be inside a `nowheel` boundary and preserve native overflow scrolling.
- Regression tests: node boundary contract and mention-editor wheel propagation tests.

### Reverse execution

- Observed failure mode: provider health can show connected while Start remains unavailable or execution fails because role/task drafts reverted to blank or were not serialized. Provider health and request validity are separate states.
- Protected fix: persist Reverse Agent fields immediately, validate with a visible reason, and submit all connected ordered media.
- Regression tests: draft persistence, enabled-state validation, ordered multi-image request, and provider error rendering.

## Release gate

Before producing an installer, verify at minimum:

1. Focused Vitest suites for styles, `ModuleNodeCard`, mention input, app store persistence, and reverse execution.
2. Renderer typecheck/build.
3. Desktop build and NSIS packaging.
4. Fresh installer timestamp, size, and SHA-256.
5. No project-owned process is left running and no unrelated working-tree changes were discarded.

## 2026-08-23 continuation checkpoint

- Delete key regression was traced to React Flow built-in removal racing the durable workspace deletion. `deleteKeyCode={null}`, remove-change filtering, and the node-removal editor reducer now keep one deletion owner and prevent React error #185.
- `Ctrl/Cmd+S` now calls the explicit project save boundary. Image, video, and Reverse Agent execution also establish a writable stable save point before contacting a model, so an untitled or newly edited canvas cannot reach a provider with an unsaved configuration.
- Settings model refreshes are request/provider guarded. Connection messaging counts only routes that satisfy the same runnable Reverse Agent capability contract as the node (`reverse_prompt` plus `gemini_native`, or `chat` plus `vision`). RelayMe tokens normalize pasted `Bearer` prefixes and the workspace link is `https://www.ml.relayme.uk/workflow`.
- Video controls use one five-part bottom rail: model, aspect ratio, clarity, duration, and action. Mode/audio/quantity no longer create a hidden second row; fallback duration options are 4/8/12 seconds and provider-declared options still take precedence. Duration labels use `4秒` style text.
- Marquee selection plus quick insert already plans deterministic top-to-bottom/left-to-right ordered connections for compatible image/video/reverse inputs, with skips reported instead of silently dropping materials. Minimap and native wheel boundaries remain covered by regression tests.
- Verification: full workspace Vitest `193` files, `2288` passed, `2` performance tests skipped by design; focused post-review node/settings run `210` passed; `npm.cmd run typecheck` passed; `npm.cmd run build` passed; NSIS packaging passed.
- Final release artifact after Terra-reviewed fixes: `apps/desktop-modern/dist-builder/desktop-modern/CanvasAtelier-Win10-11-x64-1.6.38.exe`, 103,101,259 bytes, SHA-256 `317F3CA0EEE583A99F65ADA4D3ADC365C4B6354B4FEC52B368F6CD22C28E2096`.

## 2026-08-23 release checkpoint (latest)

- Reverse execution root cause fixed: the renderer could keep a historical model-route alias after provider catalog refresh. The provider bridge then rejected that stale route even though connection health was green. Reverse execution now resolves the current runnable profile and submits its canonical route; the validated node config is kept complete before the request.
- Video rail root cause fixed: a higher-specificity legacy selector hid duration and could leave the compact rail with an implicit second row. The terminal CSS now keeps duration visible and fixes the five visible controls to one aligned row inside the node.
- User-data identity fixed: new desktop data is stored under `%APPDATA%\\Canvas Atelier`; `CanvasForge` and the old agent-canvas roots are migration-only sources, so existing projects/provider data remain recoverable without continuing to write under the prototype name.
- Verification: fresh full Vitest passed `193` files, `2289` tests, with `2` performance tests skipped by design. `npm.cmd run typecheck` passed. `npm.cmd run build` passed. NSIS packaging passed. Packaged smoke against the new unpacked executable reported `canvasVisible: true`, `fatalAlertCount: 0`, and exited cleanly; the reported React #185 startup failure was not reproduced.
- Current installer: `apps/desktop-modern/dist-builder/desktop-modern/CanvasAtelier-Win10-11-x64-1.6.38.exe`; size `103101348` bytes; SHA-256 `7EC890D2D861C70CDA8E15257F5E73BC91C8CACDD141B9383B305CE4739EAB91`; verify this hash before installing because the filename/version is unchanged.
- Next continuation: if a packaged symptom is reported, reproduce against this exact hash and record runtime evidence before changing code. Preserve the existing dirty worktree and do not treat provider health alone as proof that a Reverse request is valid.

## 2026-08-23 model rail follow-up

- New symptom root cause: when the provider model catalog refresh rejected or timed out, `SettingsDrawer` cleared `providerProfiles`, immediately turning image/video controls into `未配置模型` even though the last inventory was still usable. Refresh failure now preserves the last successful inventory; only an explicit invalid-credential result clears it.
- Button-height protection: the terminal UI-Gate rail now constrains native selects, parameter popovers, and the primary action to the same 38px track. The regression contract is in `apps/renderer/src/main.styles.test.ts`.
- Deliberately not persisted: automatically writing discovered catalog entries into the user-selected provider profile file caused stale models to survive API-key rotation. Keep user selection and discovery cache semantics separate; do not reintroduce that shortcut.
- Verification: provider bridge, settings, and stylesheet focused suites passed 195/195. Rebuild and installer verification are required before release.
- Release verification: fresh full Vitest passed `193` files, `2289` tests, with `2` performance tests skipped; typecheck, production build, NSIS packaging, and packaged smoke passed. The new unpacked app reported `canvasVisible: true`, `fatalAlertCount: 0`, and exited normally. Installer SHA-256 is `7EC890D2D861C70CDA8E15257F5E73BC91C8CACDD141B9383B305CE4739EAB91` (`103101348` bytes).

## 2026-08-23 button geometry follow-up

- Root cause: the video composer kept a higher-specificity legacy `.module-node__video-figma-composer .module-node__video-control-bar` rule that restored a 44px row after hydration. A lower-specificity shared child rule could not prevent the outer rail from stretching, so video controls appeared taller and more widely spaced than image controls.
- Protected fix: the terminal UI-Gate cascade now overrides the composer-specific selector, fixes both rails to a 60px bar with one 38px grid row, fixes every visible select/popover/action to 38px, and independently hides legacy video mode/audio/quantity controls while keeping duration in column four. A regression test protects the nested legacy selector from returning.
- Verification: focused styles and module tests passed `205/205`; full Vitest passed `193` files and `2289` tests with `2` performance tests skipped; typecheck and production build passed; NSIS packaging passed; packaged smoke reported `canvasVisible: true`, `fatalAlertCount: 0`.
- Current installer: `apps/desktop-modern/dist-builder/desktop-modern/CanvasAtelier-Win10-11-x64-1.6.38.exe`, `103101526` bytes, SHA-256 `37B1E0E5B14D1203F7569AEF2CD9CCD45F6CD0E449F4D452C1597966B6EF55AC`.
- Next continuation: if a packaged screenshot still differs, reproduce against this exact hash and inspect computed styles for the affected node before adding another override; do not add another broad selector without a regression assertion.

## 2026-08-23 Delete shortcut follow-up

- Root cause: the canvas Delete listener ran in the window bubble phase, so React Flow or an inner node control could stop propagation before the durable deletion transaction started. Holding the key could also enqueue duplicate deletion attempts.
- Protected fix: the canvas shortcut now listens in capture phase, still ignores editable targets and active surfaces, prevents default browser behavior, and ignores auto-repeat. React Flow's built-in deletion remains disabled so durable deletion has one owner and cannot race into React error #185.
- Regression proof: CanvasWorkspace and app-store focused tests passed `277/277`; full Vitest passed `193` files and `2290` tests with `2` performance tests skipped; typecheck/build/NSIS/packaged smoke passed.
- Current installer: `apps/desktop-modern/dist-builder/desktop-modern/CanvasAtelier-Win10-11-x64-1.6.38.exe`, `103101481` bytes, SHA-256 `BB6BA7BB7892530143CE7F43EAE263277D6EC58D32E7705CB3E910D7132EC006`.

## 2026-08-23 continuation verification

- Rechecked the three reported symptoms against the current dirty worktree. Quick Insert treats only an explicit `false` return as creation failure, so synchronous or fire-and-forget node creation closes the menu; `useCanvasDraft` ignores React Flow `remove` changes because durable deletion has one owner; Reverse Agent resolves the current runnable provider profile and rewrites stale route aliases before bridge submission.
- Focused verification passed: 6 files, 312 tests (`QuickInsert`, `use-canvas-draft`, `CanvasWorkspace`, `App`, `app-store`, and `ReversePromptAgent`). The suite includes double-click background/menu interaction, failed-then-retried creation, startup hydration guards, durable deletion, stale reverse route resolution, and visible reverse failure persistence.
- Environment note: Vitest must be run outside the sandbox because Vite/esbuild startup otherwise fails with `spawn EPERM`; that restriction is not a product test failure.
- Next continuation: if the packaged app still shows React #185 or reverse failure, capture the exact installer SHA-256 and the persisted `reverseAgentError`/renderer console error before modifying source. Do not treat a green provider-health badge as proof that the selected profile supports `reverse_prompt` plus a usable vision capability.

## 2026-08-23 React Flow edge-loop follow-up

- Root cause: controlled React Flow edges were rebuilt as fresh empty arrays during node creation. The conversion and viewport-culling layers copied `[]` on every render, so React Flow repeatedly called its internal `setEdges` and hit React error #185.
- Protected fix: `toFlowEdges` and `selectViewportCulledElements` now reuse stable empty edge arrays; the canvas delete-edge callback is also memoized. Startup hydration additionally compares a serialized project fingerprint so in-place bridge edits cannot be overwritten by delayed restore.
- Regression proof: focused canvas/app suites passed (`CanvasWorkspace`, `use-canvas-draft`, `node-types`, `use-viewport-culling`, `app-store`), including delayed startup creation; production typecheck/build and NSIS packaging passed. Packaged startup smoke reports `canvasVisible: true` and `fatalAlertCount: 0`.
- Current installer: `apps/desktop-modern/dist-builder/desktop-modern/CanvasAtelier-Win10-11-x64-1.6.38.exe`, `103101610` bytes, SHA-256 `F380A8B151BBFC46C031D3564D3FEB8D0DC3D0E10F05DDA5DC257931AFAA0F27`.
- Acceptance note: the older text-persistence harness now progresses past the former React #185 crash; its prompt locator assumes the image editor is expanded and timed out before the persistence assertion. Treat that harness result as incomplete, not as a persistence pass.

## 2026-08-24 Backspace old-project release verification

- The reported old canvas is not corrupt. A read-only copy of project `60fa8022-171c-4f04-ab60-a9ae545d0195` was opened with its provider configuration in isolated QA roots. It contains 12 nodes, 9 reverse-reference edges, and a legacy Reverse Agent task with multiple `@图片` mentions.
- The React #185 protection remains owned by `useCanvasDraft`: durable text/config replacement preserves React Flow `width`, `height`, and `measured`, while identical `dimensions` changes return the existing draft list. Dropping measurement metadata or publishing the same measurement repeatedly recreates the controlled-node update loop during text deletion.
- The exact legacy Reverse Agent text path is protected in `apps/renderer/src/canvas/ModuleNodeCard.test.tsx`: deleting ordinary text beside a legacy mention updates the real app-store draft without an update loop. Mention-chip deletion remains protected in `apps/renderer/src/mentions/MediaMentionTextarea.test.tsx`.
- Hidden QA execution is dual-gated by `CANVASFORGE_QA_MODE=1` plus `CANVASFORGE_QA_HIDDEN=1`; normal application windows still show. This permits packaged old-canvas verification without repeatedly interrupting the user.
- Release identity advanced from ambiguous repeated `1.6.38` artifacts to `1.6.47`. Packaging and runtime-entry tests assert the new version and installer filename.
- Focused release regression passed 219/219 before the final legacy text test; the final `ModuleNodeCard` run passed 167/167. Full workspace Vitest passed 194 files and 2304 tests with 2 performance tests skipped by design and 0 failures. Full TypeScript and production build passed.
- Packaged `1.6.47` smoke reported `canvasVisible: true` and `fatalAlertCount: 0`. A fresh packaged old-project run shortened the role from 198 to 197 characters and the Reverse task from 218 to 217 characters with `FAILURE=none`.
- Installer: `apps/desktop-modern/dist-builder/desktop-modern/CanvasAtelier-Win10-11-x64-1.6.47.exe`; size `103101848` bytes; SHA-256 `7D003C010C5A5B6C8ADBA961DFBDE9108E4D7035F696C6A7015CC94C4DFB75F3`; Authenticode status `NotSigned`.
- Silent install completed with exit code 0. Registry and installed `app.asar` report `1.6.47`; installed and packaged renderer hashes both equal `53052CA8780990F5EF7C37848F22757BD589EAF61F20C5FED5325C5590DC0C8C`. The application was not auto-launched.

## 2026-08-24 repeated Backspace hardening

- Hidden QA replayed the old 12-node canvas with ten consecutive real `Backspace` key events beside a legacy `@图片` chip and ten ordinary task deletions; the current packaged renderer completed all events without a fatal alert or console React #185.
- Hardened every generation/reverse external-reference hydration effect so a newly allocated but content-identical string-array config keeps the existing React state reference. This prevents old projects with serialized empty/reference arrays from scheduling redundant controlled-node updates while text deletion is publishing drafts.
- Added an eight-cycle rerender/delete regression around the legacy reverse mention path; focused ModuleNodeCard passed 167/167 and the CanvasWorkspace/use-canvas-draft/node-types/mention suite passed 154/154.
- Release 1.6.48 verification: renderer and desktop builds passed, TypeScript passed, NSIS packaging passed. Hidden packaged old-project replay completed ten real task Backspaces with `FAILED_AT=none`, `FAILURE=none`; installer is `apps/desktop-modern/dist-builder/desktop-modern/CanvasAtelier-Win10-11-x64-1.6.48.exe`, 103101914 bytes, SHA-256 `9203BA20BCA2AE3447A263DA5FFFE3367520CB8753ABE1B26854414CD74AD993`, Authenticode `NotSigned`. Silent install exited 0 and left no app process running.

## 2026-08-24 reference-chip and full-preview follow-up

- The remaining deletion path was the mention component's parent callback: every input, including a deletion that did not change the surviving reference set, returned a newly allocated array. That created an unnecessary second React/React Flow draft publication for each chip removal. `retainMentionedAssetIds` now returns the existing array when its contents are unchanged across image, video, and reverse editors.
- Added a three-chip reverse-agent regression that deletes `@图片1`, `@图片2`, and `@图片3` through the real contenteditable Backspace handler; it passes without an update-depth error. The terminal UI contract now also explicitly forces the collapsed generated-image preview to intrinsic `width/height: auto`, bounded by `max-width/max-height`, and `object-fit: contain`, so generated images are not cropped by a late legacy selector.
- Focused style and node tests pass 211/211; full TypeScript passes. Release 1.6.49 renderer/desktop builds and NSIS packaging pass. Installer: `apps/desktop-modern/dist-builder/desktop-modern/CanvasAtelier-Win10-11-x64-1.6.49.exe`, 103101926 bytes, SHA-256 `EDA325E0307C2EF6DAA07AAC0F8789BE4F4F9B954BDEB4E10ED336DD534FE762`, Authenticode `NotSigned`. A silent install retry was cancelled by Windows before launch, so installation of this specific artifact remains an environment blocker; the package itself is complete and ready to run.

## 2026-08-24 full-canvas Backspace root-cause correction

- The isolated mention and node tests were insufficient. A new full `CanvasWorkspace` regression deleted three Reverse Agent reference chips through the controlled canvas and reproduced the reported React #185 exactly at `ModuleNodeCard.tsx` model-route hydration.
- Root cause: changing `config.referenceAssetIds` reran a combined hydration effect that also reset local `modelRoute` from persisted config; the capability-compatibility effect then changed it back. Under the real app-store and React Flow subscriptions, repeated reference deletion made those two updates ping-pong until React reached maximum update depth. Model-route hydration now depends only on `config.modelRoute`, reference-array hydration is separate, and reverse text edits persist only after the local draft is coherent.
- Save feedback was already generated by the hidden JobStrip. A visible `aria-live` save-state pill now lives beside the top-bar save control and reports pending, saving, success, and failure states. The shared terminal control contract now covers image/video/reverse parameter rows, storyboard controls, reference-add, and settings-agent controls with the same 38px height, 10px radius, zero vertical padding, and 8px row gap.
- Fresh regression evidence: `App`, `ModuleNodeCard`, `CanvasWorkspace`, and stylesheet suites passed 346/346; packaging-boundary and runtime-entry suites passed 15/15; full typecheck and production build passed; NSIS packaging passed.
- Release 1.6.50 installer: `apps/desktop-modern/dist-builder/desktop-modern/CanvasAtelier-Win10-11-x64-1.6.50.exe`, 103101940 bytes, SHA-256 `CB2A8673F784C68068F881534CC47C635856763BD8538920641836FC4F06A128`. Silent installation to `D:\CanvasAtelier\Canvas Atelier` exited 0; installed `app.asar` reports 1.6.50 and matches the packaged SHA-256 `A06073B83C792EE61A25E8A8AAAC6FA7FE8F5687AFEE1F7C231C4E57DF70EBFE`. No application process was launched. The mistaken duplicate `D:\CanvasAtelier\Canvas` created by an earlier unquoted NSIS `/D` argument was verified and removed.

## 2026-08-24 batch-selection entry-point follow-up

- The previous batch-selection work had the deterministic connection planner and module-library callback, but no visible action surface matching the reference workflow. The canvas now shows a floating `批量连接选中素材` toolbar only when at least two selected nodes are compatible media nodes; its image, video, and Agent reverse actions reuse the existing durable creation-and-connection transaction.
- Existing blank-canvas insertion, single-node module creation, deletion, save, and editor shortcuts are unchanged. The toolbar uses the safe viewport placement path and does not create a node when the current viewport cannot fit it.
- Fresh CanvasWorkspace and stylesheet regression passed 164/164; full TypeScript passed after the new toolbar was type-guarded.
- Release 1.6.51 build and NSIS packaging passed. Installer: `apps/desktop-modern/dist-builder/desktop-modern/CanvasAtelier-Win10-11-x64-1.6.51.exe`, 103102222 bytes, SHA-256 `853E81FCD5BE5919AB46BAB8927CE003A8A68AFFF309CA8F37C7140EBDE1565A`. Silent installation exited 0; installed version is 1.6.51, installed and packaged `app.asar` SHA-256 both equal `40E88D87A2F3B04681B88DBF08D68DC261FEEAB5317D1E915E0125BECF49EAA2`, and no application process was launched.

## 2026-08-24 Codex Agent conversation and structured reverse workflow

- Replaced the one-shot Agent surface with project-scoped persistent tasks, task switching, new-task creation, Chat/Original/Codex modes, reasoning effort, and independently switchable model routes. The layout follows the requested Codex Agent anatomy while retaining Canvas Atelier styling.
- Structured visual reverse requests now preserve ordered `@图片N` references and explicitly request visible subject/environment/material/light/camera/depth, foreground/midground/background structure, composition, perspective, per-reference duties, inherit/replace/do-not-copy rules, Chinese and English prompts, negative constraints, and an execution checklist. After a structured reverse result, the Agent asks whether to draft a workflow; drafting still requires the existing canvas confirmation before mutation or execution.
- Fresh focused evidence: CanvasWorkspace `121/121`; image actions, node geometry, slots, persistence, clipboard and Photoshop group `352/352`; Agent/profile/provider bridge group `179/179`; post-type-fix Agent group `56/56`; desktop release contracts `23/23`; full workspace TypeScript and production build passed. Hidden packaged smoke returned `canvasVisible: true` and `fatalAlertCount: 0`.
- Release 1.6.54 installer: `apps/desktop-modern/dist-builder/desktop-modern/CanvasAtelier-Win10-11-x64-1.6.54.exe`, 103105875 bytes, SHA-256 `DAEA6A9DA6E490D4D376438D0C96683FFB0AE42914F39191C89DEB78CA16F42A`, Authenticode `NotSigned`. Silent installation to `D:\CanvasAtelier\Canvas Atelier` exited 0. Installed manifest reports 1.6.54; packaged and installed `app.asar` SHA-256 both equal `2B91D38B6E3CF83696DA9CCA0D9BA0E386AA26729872389B5BC3D2B4B129CCFC`; no Canvas Atelier process was launched.

## 2026-08-24 React #185 video hydration correction and release verification

- Root cause: generation editors hydrated local video/image controls directly from every external config snapshot while their own draft effect was asynchronously persisting defaults and user edits. A stale snapshot could reset the local model route/duration/audio, then the compatibility effect changed it back; repeated Backspace/reference edits amplified the ping-pong into React error #185. Video route arrays were also recomputed on every render, so compatibility effects had no semantic boundary.
- Protected fix: image/video route lists are memoized by their route input; model route, aspect ratio, duration, resolution, output count, keyframe, and audio controls use the existing externally-hydrated draft-state guard, so local edits are not overwritten by older snapshots. Added a regression that fails on the old rollback and passes after the fix.
- Fresh source evidence: `ModuleNodeCard` passed 169/169; core suites passed 543/543 plus Agent/style/domain/desktop-core follow-up 149/149 (692 total). Typecheck and production build passed.
- Fresh packaged hidden runtime: Backspace after text edit, image insertion, video insertion, and save completed with `fatalAlertCount=0`, `pageErrors=[]`, `nodeCount=2`, and `saveState=本地稳定点已保存`. Reverse/image/video restart persistence each returned `preserved=true`. Release E2E passed 7/8; the only failure is a pre-existing test configuration mismatch that hard-codes a missing `Gemini Vision` route, not a renderer error.
- Release 1.6.55 installer: `apps/desktop-modern/dist-builder/desktop-modern/CanvasAtelier-Win10-11-x64-1.6.55.exe`, 103108084 bytes, SHA-256 `58EFE0869446737F1FA7BC79AD0112530A3CED92668AFB670F0460FF70184FDD`. Silent installation to `D:\CanvasAtelier\Canvas Atelier` exited 0; installed and packaged `app.asar` SHA-256 both equal `A1FE300059DDEE4A5656162BE0AF3ECAC61916A38432844D2BAC2D88FA99A7EE`; no application process was launched.

## 2026-08-24 final slot and compact-agent UI correction

- Root cause of the remaining reference-slot complaint was interaction CSS, not the reorder transaction: the row scrollbar was explicitly hidden, reorder buttons were pointer-disabled until hover, and legacy UI-gate selectors could hide the row children. The row now supports vertical-wheel-to-horizontal scrolling, keeps all reorder controls visible, and exposes a thin scrollbar; the existing reorder callback already passed arbitrary slot 4, 9, and 20 moves.
- Removed the decorative `AGENT WORKSPACE · OUTPUT` surface label that leaked into the left edge of the canvas. Agent composer model labels are ellipsized inside a wrapping footer so mode, model, effort, knowledge, and send controls remain usable at narrow panel widths. Image/video generation rails retain the Canvas-style 38px unified control contract.
- Fresh focused evidence: ConnectedAgentMediaSlots `11/11`, main styles `48/48`, SkillChatWorkbench `54/54` (113/113). Full typecheck and production build passed. Hidden Electron smoke returned `fatalAlertCount=0`, `nodeCount=2`, `pageErrors=[]`, `saveState=本地稳定点已保存`.
- Rebuilt release 1.6.55 installer: `apps/desktop-modern/dist-builder/desktop-modern/CanvasAtelier-Win10-11-x64-1.6.55.exe`, 103108271 bytes, SHA-256 `8C4D764C755CB62D977B12F444082A450149715D941FC18E176F5740526273C3`. Silent installation to `D:\CanvasAtelier\Canvas Atelier` exited 0; installed renderer asset `index-D0lDniMP.css` matches the packaged renderer hash `F751037F7EAEA11148F54494770388CA6CF0E7643E7D990D234261D6166C0618`; no application process was launched.

## 2026-08-24 slot swap and Agent composer position correction

- The prior slot CSS fix was inserted before later legacy selectors, so the later cascade hid scrollbars and disabled reorder hit targets again. The final override is now genuinely at EOF. Slot buttons stop propagation before canvas handling, all 20 cells render (including empty drop targets), and dropping an item on an empty cell resolves to the last occupied position before the durable edge-order transaction.
- The Agent composer footer now keeps the send control at the far right, hides the redundant in-composer new-task button, and prevents the model pill from overlapping the knowledge/send controls.
- Fresh focused evidence: ConnectedAgentMediaSlots `11/11`, SkillChatWorkbench `54/54`; production typecheck/build passed. Release 1.6.55 installer rebuilt at `apps/desktop-modern/dist-builder/desktop-modern/CanvasAtelier-Win10-11-x64-1.6.55.exe`, 103108521 bytes, SHA-256 `88629ADBA94826973B1AC0DBBB083C9D5D33D8B258B6A62DC816D10DCF89F441`. Silent install to `D:\CanvasAtelier\Canvas Atelier` exited 0; installed renderer hash `AC37F25646DABE2D4D8BDAC879374F5CC7BEE0735215A0E8C950115AB295F44D` matches the packaged renderer; no application process was launched.

## 2026-08-24 slot swap durable-conflict and Electron pointer correction

- The remaining no-op had two independent causes. A `REVISION_CONFLICT` makes `reorderModuleInput` return `false`, which the slot UI previously ignored; the node now reloads the durable project and retries the exact requested edge order once. The pointer fallback also captured the pointer on the source cell, preventing Electron from delivering enter/release to the destination cell; pointer capture was removed while native HTML drag and pointer drag remain available.
- Empty visual slot placeholders were removed again: image, video, and Reverse Agent trays render only actual connected media, with a `N / 20` capacity counter. All real cells keep durable edge identity, and real images/videos disable nested native dragging so the slot owns the gesture.
- The Agent composer groups knowledge and send actions so older direct-child `last-child` rules cannot stretch the send button over adjacent controls. The compact top project actions use 36px controls and hide the saved-state pill while retaining compact error feedback.
- Fresh focused regression passed `285/285`: ConnectedAgentMediaSlots `13/13`, ModuleNodeCard `170/170`, SkillChatWorkbench `54/54`, and main styles `48/48`. Coverage includes slot 20 to slot 1, positions after slot 4, Electron pointer fallback, conflict reload-and-retry, connected-only rendering, and Agent layout. Full TypeScript/production build passed.
- Hidden packaged runtime passed with `fatalAlertCount=0`, `nodeCount=2`, `pageErrors=[]`, and no failures after repeated Backspace and both save paths. Rebuilt 1.6.55 installer is `apps/desktop-modern/dist-builder/desktop-modern/CanvasAtelier-Win10-11-x64-1.6.55.exe`, 103108708 bytes, SHA-256 `2749134C11A1B2A6E03324B74078B8ECD4FE3D1D22C144A2F00A0F8FCC37F10C`. Silent installation to `D:\CanvasAtelier\Canvas Atelier` completed; packaged and installed `app.asar` SHA-256 both equal `A1FE300059DDEE4A5656162BE0AF3ECAC61916A38432844D2BAC2D88FA99A7EE`. No application window was shown.

## 2026-08-25 worktree pollution boundary and local checkpoint

- Root cause: the repository ignored generic `dist/` but not root `.tmp-*` QA roots, `artifacts/`, either Electron Builder output location, the root runtime index, or the copied root desktop entry. This exposed 21,404 generated files as untracked changes alongside the real source work.
- Protected boundary: `.gitignore` now excludes only those proven generated/runtime paths while retaining all source, tests, installer configuration, and project documentation. One accidental 16 KB `tatus --short` file containing only redirected Git line-ending warnings was removed after its exact workspace path and content were verified.
- After the ignore correction, untracked paths fell from 21,404 to 237; the remaining paths were real source/tests/docs. They and 140 tracked changes were preserved in one local checkpoint instead of using reset/clean. Pre-checkpoint verification remained the fresh full Vitest result of 196 files and 2,344 passing tests (2 performance tests skipped by design), plus a successful no-emit workspace typecheck. No application runtime was launched for this cleanup audit.
