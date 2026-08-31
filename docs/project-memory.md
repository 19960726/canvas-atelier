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

## 2026-08-25 continuation verification

- The current checkout still has exactly two unrelated user-owned source edits: the untitled-project stable-save boundary in `apps/renderer/src/app/app-store.ts` and the terminal generation/Agent layout cascade in `apps/renderer/src/styles/app.css`. No source edits were made during this continuation.
- Fresh focused verification passed: renderer styles, `SkillChatWorkbench`, `ModuleNodeCard`, and `CanvasWorkspace` passed `393/393`; app-store, autosave, desktop-persistence, and durable-canvas semantics passed `228/228`.
- Fresh workspace `npm.cmd run typecheck` passed with exit code 0. The first in-sandbox Vitest attempt was blocked at Vite/esbuild startup by `spawn EPERM`; the same command was rerun in the permitted environment and reached the tests successfully.
- No packaged runtime or installer was produced in this continuation. Existing generated QA roots remain ignored and no unrelated worktree changes were discarded.

## 2026-08-25 Agent reverse workflow continuation

- Reproduced the remaining reverse failure in the renderer: a request containing ordered media references was intercepted by the selected-node canvas action branch, so it never reached visual chat when no reverse node was selected. The guard now bypasses that branch only for `reverse_agent` requests that carry references; node-targeted reverse execution remains confirmation-gated.
- The desktop bridge already supplies the ordered `referenceMentions` and `visualAnalysis` contract to the provider. No project-memory IDs or private metadata were added to the provider prompt.
- Added a deterministic structured reverse contract and workflow proposal model. JSON and fenced-JSON assistant responses are parsed into the contract; legacy prose remains readable and is marked non-runnable until required visual/prompt sections are present.
- Added a compact Agent summary showing subject, composition, Chinese prompt, and missing required sections before workflow drafting. Existing durable plan confirmation remains the single canvas/model execution boundary.
- Fresh verification: `SkillChatWorkbench` plus reverse contract passed 59/59; renderer interaction suite (styles, media slots, module nodes, workspace, app-store) passed 569/569; desktop visual-analysis/provider tests and proposal test passed 8/8; renderer no-emit TypeScript check passed.

## 2026-08-25 browser runtime continuation

- Renderer production build completed successfully with Vite. The first browser run exposed two stale E2E assumptions in `agent-reference-workflow.spec.ts`: a hard-coded `Gemini Vision` route label and an input-value assertion against the contenteditable Agent composer. The test now selects the first configured route from the model list, reads the selected display label, and asserts the rendered `@图片1` text.
- Fresh browser verification passed: Agent managed-image reference flow and compact Agent layout both passed `2/2`. The flow confirmed no canvas commit, model job, or model submission was created by citation-only chat.

## 2026-08-26 settings button contract continuation

- Settings storage/update controls now use a terminal `release-layout-contract.css` button contract: cache directory actions, the primary cache cleanup action, and update check share 34px height, centered icon/text, radius, focus, hover, active, and disabled states. Per-cache cleanup actions use the same geometry at 30px for compact cards.
- Cache directory actions now report successful open, custom-path migration, and default-path restore in the storage card. Cleanup buttons visibly switch to `清理中…`; update checking includes a spinning refresh icon and Chinese loading label.
- Fresh focused `SettingsDrawer` verification passed `47/47`; workspace typecheck and production build passed. Real packaged renderer screenshot: `E:\\画布项目\\staging-canvas-build\\.tmp-settings-storage-buttons.png`. Electron DOM smoke confirmed one `.settings-update-action`; the update-card screenshot was blocked by Electron screenshot stability timeout, so it is not claimed as visual evidence.
## 2026-08-26 1.6.56 release-contract integrity verification

- Root cause: the desktop package version had already advanced to `1.6.56`, while two release-contract tests and one installer-path assertion still expected `1.6.55`.
- Minimal fix: updated only the stale expectations in `apps/desktop-modern/src/packaging-boundary.test.ts` and `apps/desktop-modern/src/runtime-entry-contract.test.ts`; no production code was changed.
- Protected behavior: packaging/runtime contract tests now track the current package version and the `CanvasAtelier-Win10-11-x64-1.6.56.exe` installer identity.
- Focused verification: both release-contract test files passed, 16/16 tests.
- Type verification: the full workspace `npm run typecheck` passed.
- Full verification: Vitest passed 198 test files and 2367 tests; 2 performance tests were skipped by design; 0 failures.
- Existing installer confirmed at `apps/desktop-modern/dist-builder/desktop-modern/CanvasAtelier-Win10-11-x64-1.6.56.exe` (103111963 bytes; last modified 2026-08-25 21:59:21). A fresh installer rebuild/runtime smoke was not performed in this verification pass.
- Workspace note: all unrelated pre-existing dirty changes were preserved.
## 2026-08-26 1.6.56 rebuilt release verification

- Fresh production build passed, including full workspace TypeScript checks, renderer build, desktop bridge/core builds, and the Electron main/preload bundles.
- Electron Builder 26.0.12 completed Windows x64 NSIS packaging for Electron 43.1.0 with exit code 0.
- Rebuilt installer: `apps/desktop-modern/dist-builder/desktop-modern/CanvasAtelier-Win10-11-x64-1.6.56.exe`; size `103112336` bytes; last write `2026-08-26 13:24:36`; SHA-256 `1A38BC87427DDA56C93A51864CF5B8D1C401EDD78F23FA90644440CA9DD3891D`; Authenticode status `NotSigned`.
- Fresh packaged runtime smoke used the rebuilt `win-unpacked/Canvas Atelier.exe` with an isolated temporary user-data directory. It returned `title=Canvas Atelier`, `canvasVisible=true`, `fatalAlertCount=0`, `pageErrors=[]`, and `dialogs=[]`, then closed normally and removed its temporary profile.
- The build reported the existing Vite large-chunk advisory and missing package `description`/`author` metadata; neither warning blocked packaging or runtime startup.
- The existing user installation was not overwritten in this pass.

## 2026-08-26 Agent media, reverse-port, and final 1.6.56 release verification

- The Codex Agent accepts pasted image/video attachments, Codex mode exposes only Codex routes, and ordinary chat no longer renders the workflow request/reverse-analysis cards. Current browser coverage also confirms managed media mentions, structured reverse analysis, image generation, and video generation behavior.
- Root cause of the reverse-card black edge and unreliable output drag was a 16px output column clipping a handle centered on its right boundary. The terminal layout contract keeps the port row clipped, places the full output handle inside the card, and gives handles their own pointer-active stacking layer; this preserves drag hit testing without adding horizontal overflow.
- Updated stale E2E expectations to the current 460px Agent panel, the current project-memory disclosure, and clipboard-file naming. Full Playwright passed `136/136`, including both themes, 1366/1440/1920 desktop layouts, reverse-result overflow, real port dragging, Agent chat, image paste, and image/video generation flows.
- Full workspace TypeScript passed. Full Vitest passed `198` files and `2374` tests; `2` performance tests were skipped by design. The first restricted Vitest run hit only expected `EPERM` errors while security tests created simulated secret files and desktop contract tests rewrote `dist`; the permitted rerun passed with zero failures. `git diff --check` reported no whitespace errors.
- Fresh production build and Electron Builder 26.0.12 Windows x64 NSIS packaging passed. Packaged hidden runtime returned `fatalAlertCount=0`, `nodeCount=2`, `pageErrors=[]`, and `failures=[]` after inserting image/video nodes, editing, and saving.
- Final installer: `apps/desktop-modern/dist-builder/desktop-modern/CanvasAtelier-Win10-11-x64-1.6.56.exe`; size `103112725` bytes; SHA-256 `25202A734D67E2228028F1E52AA9D222B6365F4222D30BC944A16C770A13E374`; Product/File version `1.6.56`; Authenticode status `NotSigned`. The existing user installation was not overwritten.

## 2026-08-27 Agent paste, reverse reliability, generated preview, and 1.6.58 release

- Agent clipboard image paste now imports directly into the current conversation reference list. Files with a usable path go through the managed dropped-media transaction; in-memory clipboard bitmaps fall back to the native clipboard bridge. Neither path opens the Windows image picker or creates an extra canvas node.
- Codex/Agent conversation messages no longer render the internal `知识库请求` card. Request metadata remains in task state for execution and diagnostics, while ordinary chat displays only the user and assistant conversation.
- Reverse Agent now reloads and reconciles one recoverable durable revision conflict inside the first click before starting the provider request. Provider timeouts were raised from 120 seconds to 300 seconds, with the renderer operation boundary at 315 seconds, so a slow provider is not reported as an exact two-minute failure.
- Generated-image preview buttons are exempt from the shared 38px form-control rule. The preview stage and image now fill the available gallery in both dimensions instead of collapsing into a thin strip.
- Fresh verification: focused unit coverage passed `415/415`, the final full Vitest run passed `2382/2382` with `2` performance tests skipped by design, TypeScript passed, and full Playwright passed `139/139`. The packaged hidden runtime returned `title=Canvas Atelier`, `canvasVisible=true`, `fatalAlertCount=0`, and `pageErrors=[]`.
- Release 1.6.58 production build and NSIS packaging passed. Installer: `apps/desktop-modern/dist-builder/desktop-modern/CanvasAtelier-Win10-11-x64-1.6.58.exe`; size `103113039` bytes; SHA-256 `188EB241C3EA42A83054C98358B1D405261AAC8DE4BE204469ED973889999995`; Authenticode `NotSigned`. Packaged `app.asar` reports version `1.6.58`. The existing user installation was not overwritten.
- Online update audit: the settings button currently uses `MockReleaseFeed`, performs no HTTP request, and restart installation returns `REAL_INSTALL_DISABLED`. Uploading only the EXE to GitHub will not notify or update users; a later release must add the real GitHub Releases feed, `latest.yml` publication, integrity/signing policy, download/restart installation, and startup or scheduled checks.
- Fixed release habit: every change batch ends with a written root-cause retrospective, an exact change list, fresh verification evidence, release artifact identity, and explicit remaining risks/next steps. Update this project memory before declaring the batch complete.

## 2026-08-27 result-only generation gallery follow-up

- User reference established the final completion contract: generated image/video nodes should return to a media-only canvas surface instead of leaving the prompt editor visible. A newly completed image or video now closes only its own open generation editor; opening an already completed node still intentionally reveals the full editor for a new run.
- Completed nodes hide prompt, parameter, and connected-reference surfaces until the user explicitly opens the editor. Single images adapt the result node to portrait, square, or landscape orientation; two results fill two equal columns; three results use one tall primary tile plus two secondary tiles; four results use a full 2x2 grid. Completed video posters use the same result-only gallery contract.
- The shared 38px button rule also applied to the collapsed preview opener and initially reproduced the thin-strip defect. The terminal gallery rule now clears that button's `max-height`, while each result tile and its image/video fill the assigned cell with `object-fit: cover`.
- Added reducer, component style-contract, one-result completion, and four-result E2E coverage. The E2E harness can seed 1-4 deterministic generated images for layout verification.
- Release version advanced to `1.6.59` because these changes were made after the 1.6.58 installer had already been built. Fresh full Vitest passed `199` files and `2383` tests with `2` files / `2` performance tests skipped by design. The first full Playwright pass exposed six stale video assertions that still expected connected input media in the result-only state; the assertions were updated to require it only after the editor is opened. The six focused video cases then passed, followed by a fresh full Playwright pass of `141/141`.
- Full workspace TypeScript and production builds passed. Electron Builder 26.0.12 completed Windows x64 NSIS packaging; packaged `app.asar` reports version `1.6.59`. The packaged hidden runtime returned `title=Canvas Atelier`, `canvasVisible=true`, `fatalAlertCount=0`, and `pageErrors=[]`.
- Final installer: `apps/desktop-modern/dist-builder/desktop-modern/CanvasAtelier-Win10-11-x64-1.6.59.exe`; size `103113376` bytes; SHA-256 `07E87E8B51BDE4A1A843F094F902F72CB7277575094BE83BF5AEECA64DB08DAD`; Authenticode `NotSigned`. `git diff --check` exited successfully; its only output was the repository's existing LF-to-CRLF conversion warnings. The existing user installation was not overwritten and no GitHub release was uploaded.
- Remaining release risk: deterministic and mocked provider paths are covered, but no paid live image/video/reverse provider request was issued during final packaging. Online update remains intentionally disabled until the user finishes manual acceptance and explicitly requests GitHub release/update work.

## 2026-08-27 Codex media, reverse normalization, Photoshop runner, portal menu, and 1.6.60 release candidate

- Root cause of the Codex attachment failure: the renderer allowed managed media for Codex `chat`/`responses` routes when discovery omitted `vision`, but `provider-skill-chat.ts` still rejected every referenced request without the flag. The desktop gate now applies the same narrow rule only when `agentMode` is `codex`; ordinary chat/original routes still require explicit `vision`. A provider-level regression proves the managed PNG reaches the Responses request as a data URL.
- Reverse-provider normalization now joins every Gemini text part, unwraps common `reversePromptResult`/`result`/`output`/`data` envelopes, removes unknown top-level fields, maps common aliases, and fills only missing current-run identity. Explicit mismatched provider identity remains intact so the domain schema rejects it rather than masking a cross-run response.
- The Photoshop Windows Script Host runner uses legacy-JScript-compatible `/i` regular expressions. Its contract test protects the real `GetObject('', 'Photoshop.Application')`, `DoJavaScript`, version/document checks, and the absence of unsupported `/iu` or `/gu` flags.
- The body-portaled generated-image action menu has independent opaque light/dark surfaces, high-contrast text, hover, focus, and disabled styling. The contract test reads the terminal release stylesheet through a workspace path that works under Vitest's browser environment.
- Startup remains restore-first: desktop hydration selects the first available entry from the recent-project store, whose list is ordered by `lastOpenedAt`; automatic blank creation was not introduced. A blank canvas is created only through the explicit New Project workflow.
- Fresh focused regressions passed after the Codex server gate fix. Fresh full Vitest passed `202` files and `2391` tests with `2` performance files/tests skipped by design and zero failures. Full Playwright passed `141/141`. Full workspace typecheck and production build passed; Vite emitted only the existing large-chunk advisory.
- Version advanced from `1.6.59` to `1.6.60`; package metadata, lockfile, packaging contract, and runtime-entry contract agree. Electron Builder 26.0.12 completed Windows x64 NSIS packaging from `apps/desktop-modern`.
- Release candidate installer: `apps/desktop-modern/dist-builder/desktop-modern/CanvasAtelier-Win10-11-x64-1.6.60.exe`; size `103113993` bytes; SHA-256 `72EE501E69B4F78DEE136968D13D05774AE3EDDFFAD99DF6FD9227BCC0017770`; Authenticode `NotSigned`. Packaged `app.asar` reports version `1.6.60`, size `4985964` bytes, SHA-256 `346DDB60B23E07B89F9EF116A3D1C1063F445CF1C456C6C769500743A31732C3`.
- Browser screenshot evidence for the image-generation toolbar is `artifacts/2026-08-10-complete-project-release/05-image-node-compact-dark.png`; model, ratio, resolution, quantity, and Generate controls remain aligned in one contained row.
- Remaining release gate: the final `win-unpacked` isolated-profile restart smoke and packaged screenshot are not yet claimed. The application reached the real New Project confirmation and durable `saved` state in earlier attempts, but the QA script initially assumed a production E2E global, then omitted the confirmation, then incorrectly required the intentionally hidden save-state element to be visible. After those harness corrections, the local command helper failed during setup and prevented collection of the final run. Do not overwrite the user's installed application or call this candidate fully accepted until that smoke is rerun and recorded.

## 2026-08-27 Agent chat complete clipboard regression

- Root cause: the earlier Agent composer paste path consumed only one clipboard file and lacked an Agent-local clipboard event boundary. Mixed clipboard payloads could therefore lose later attachments, while copy/cut/paste events from the Agent surface could bubble to the canvas clipboard owners.
- Protected behavior: clipboard parsing preserves readable text plus every supported image/video in `DataTransfer.items` order. Managed imports run sequentially, successful earlier references remain when a later import fails, and the canonical composer order is text followed by `@图片1 @视频1`. Reference updates and pending imports are scoped to the active conversation/model/mode generation so stale completions cannot mutate a replacement draft.
- Event boundary: the Agent workbench stops copy, cut, and paste propagation locally, while the terminal message/reverse/request/source style contract restores native `user-select: text`. This keeps visible Agent content selectable without routing Agent clipboard events into Canvas handlers.
- Regression locations: `apps/renderer/src/agent/agent-chat-clipboard.test.ts`, `apps/renderer/src/agent/agent-chat-paste-state.test.ts`, `apps/renderer/src/agent/SkillChatWorkbench.test.tsx`, `apps/renderer/src/main.styles.test.ts`, `apps/renderer/src/canvas/CanvasWorkspace.test.tsx`, and `tests/e2e/agent-chat-image-picker.spec.ts`.
- Fresh Task 4 browser evidence: `npm.cmd exec playwright test tests/e2e/agent-chat-image-picker.spec.ts --workers=1` passed `4/4` with one worker. The added real composer case dispatched one `DataTransfer` containing plain text, one PNG, and one MP4, then observed the canonical value `同时分析这两个素材 @图片1 @视频1` and both visible media chips. The first run passed the three existing cases and failed only because the new assertion omitted the expected spaces between canonical references; correcting that test expectation produced the fresh green run.
- Final fresh verification: the related Agent/Canvas/style/server suite passed `336/336`; full workspace typecheck passed; full Vitest passed `204` files and `2434` tests with `2` performance files/tests skipped by design; after the browser-level Minor closure, full Playwright passed `143/143` in `4.1m`; and the complete production build exited `0`. Playwright emitted only the existing `NO_COLOR`/`FORCE_COLOR` warning and intermittent non-blocking Vite `ResizeObserver loop` logs. Vite build emitted the existing large-chunk advisory.
- No packaging, installer, GitHub upload, installed-app overwrite, or packaged-runtime smoke was performed for this clipboard change. The existing `1.6.60` release-candidate artifact and its remaining isolated-profile restart smoke gate are unchanged.
- Browser-level Minor closure: `agent-chat-image-picker.spec.ts` now creates a real mock Agent reply, selects its visible text with a DOM `Range`, and dispatches copy/cut plus composer paste while monitoring the browser `window` bubbling boundary used by Canvas clipboard listeners. Selection was non-empty, copy/cut kept their browser defaults, and all three window counters remained zero. The focused Agent clipboard spec passed `5/5`, followed by full Playwright `143/143`. Two earlier runs correctly exposed test assumptions rather than production defects: selection was initially read after default cut cleared it, and controlled contenteditable paste intentionally prevents the browser default while remaining local.

## 2026-08-27 Reverse provider truncation and schema diagnostics

- Root cause: the Gemini client already preserved candidate `finishReason`, but reverse orchestration ignored it and wrapped JSON parsing, bridge-schema parsing, run-identity checks, and media-responsibility validation in one unconditional catch. A `MAX_TOKENS` response, malformed optional professional section, and explicit identity mismatch therefore all became the same non-actionable `PROVIDER_INVALID_RESPONSE` message.
- Gemini reverse requests now use JSON output with `maxOutputTokens: 16384`. A `MAX_TOKENS` finish is reported as a retryable truncation before JSON parsing. Missing text, invalid JSON, schema failure, run-identity mismatch, and incomplete media responsibilities retain separate sanitized categories without exposing provider output.
- Normalization tolerates malformed non-core professional sections such as camera or composition when the required reverse core is complete. It does not overwrite explicit provider identity and does not drop a provided malformed `mediaResponsibilities` section; that section still fails strict schema and per-media validation.
- Renderer errors now provide actionable Chinese guidance for truncation, invalid JSON, missing required fields, run-identity mismatch, and incomplete material responsibility instead of always displaying “反推结果格式无效”.
- TDD evidence: the first focused run failed 7 new regressions as expected; a later safety RED proved malformed media responsibilities were incorrectly being dropped, then passed after the boundary was tightened. Final focused safety verification passed `11/11`; reverse-related wide verification passed `488/488`; full Vitest passed `204` files and `2443` tests with `2` performance files/tests skipped by design. Full workspace typecheck and production build passed; Vite emitted only the existing large-chunk advisory.
- No installer was rebuilt, no installed application was overwritten, and no GitHub upload was performed in this repair pass. A paid live Gemini reverse call is still required to confirm the exact provider behavior for the user's nine-image workload.

## 2026-08-27 Cross-provider reverse truncation hardening and 1.6.61 release

- The reverse-response boundary now handles truncation consistently across Gemini native, Comfly OpenAI-compatible Chat Completions, and RelayMe Chat Completions. Gemini `finishReason` and Chat-compatible `finish_reason` values are preserved and normalized; `LENGTH`, `MAX_TOKENS`, and `MAX_OUTPUT_TOKENS` are reported as retryable output truncation before JSON/schema parsing.
- A shared staged parser distinguishes missing text, invalid JSON, bridge-schema failure, explicit run-identity mismatch, and incomplete media responsibilities. Explicit mismatched identity remains non-retryable and is never replaced with the current run identity. Malformed optional professional sections may be filtered only when the required reverse core remains valid; malformed supplied media responsibilities are never silently dropped.
- Gemini reverse requests explicitly ask for `application/json` and set `maxOutputTokens` to `16384`. Renderer messages now explain in Chinese whether the user should retry with fewer references, repair provider output, or start a fresh run instead of collapsing every case into “反推结果格式无效”.
- Cross-provider TDD coverage lives in `packages/desktop-core/src/provider-bridge.test.ts`, `packages/desktop-core/src/relayme-provider-service.test.ts`, `packages/desktop-core/src/reverse-provider-result.test.ts`, and `apps/renderer/src/canvas/ModuleNodeCard.test.tsx`. Fresh final verification passed full Vitest: `204` files and `2445` tests, with `2` performance files/tests skipped by design; full Playwright passed `143/143` in `4.2m`. Full workspace typecheck and production build passed before packaging.
- Version advanced to `1.6.61`; desktop package metadata, lockfile, packaging boundary, and runtime entry contract agree. Windows x64 NSIS packaging completed. Installer: `apps/desktop-modern/dist-builder/desktop-modern/CanvasAtelier-Win10-11-x64-1.6.61.exe`; size `103116905` bytes; SHA-256 `DF2C24E596D2EC3755E5C95BA0205559FB84A6795451784183EFFF8C635B8558`; Authenticode `NotSigned`. Packaged `app.asar` reports `1.6.61`, size `4987716` bytes, SHA-256 `0948D7D339AA6AC8E6A23FF3FAA8BA960BE6CDCE8C417C3C4B8EF530B2F1A919`.
- The final isolated `win-unpacked` restart smoke used a `canvasforge-qa-*` user-data root and returned `title=Canvas Atelier`, `firstVersion=1.6.61`, `secondVersion=1.6.61`, `canvasVisible=true`, `fatalAlertCount=0`, `pageErrors=[]`, and `restoredImageNodes=1`. It also found all five visible image-generation toolbar controls: model route, aspect ratio, resolution, quantity, and Generate. This protects the restore-most-recent-canvas startup rule without auto-creating a blank project.
- QA incident record: earlier smoke attempts used an invalid isolation prefix, so the packaged app rejected the QA root and may have created one blank/test project in the user's real application data. No installed files were overwritten and no automatic deletion was attempted because a test project could not be distinguished safely from user data. Later smoke runs used the accepted isolated prefix.
- Remaining risks: the installer is unsigned; no paid live nine-image Gemini/Comfly/RelayMe reverse request was submitted during release verification; hidden Electron pixel capture remained unstable, so the existing verified toolbar screenshot is retained as layout evidence while the 1.6.61 packaged DOM smoke supplies current control-presence evidence. No GitHub release was uploaded and the user's existing installation was not overwritten.

## 2026-08-28 RelayMe、反推兼容与 GitHub 更新引导版 1.6.62

- RelayMe 现支持账号密码登录事务：密码只存在于登录调用期间，JWT 仅进入桌面安全凭据库；登录后模型目录验证成功才激活 RelayMe，退出或认证失效会清凭据并失活。
- Comfly 与 RelayMe 使用持久化单一 `activeProvider`，Renderer 过滤目录并在执行前提示，主进程对 Agent、反推、图片和视频执行做权威 `PROVIDER_INACTIVE` 门禁，禁止跨供应商静默回退。
- 反推失败原因改为六种稳定分类：`TRUNCATED`、`NO_TEXT`、`INVALID_JSON`、`CORE_SCHEMA_INVALID`、`IDENTITY_MISMATCH`、`MEDIA_RESPONSIBILITIES_INVALID`。常见 wrapper、多文本 part、字符串/对象列表和中英文字段别名会被安全规范化；显式错误身份与缺损素材职责仍拒绝。
- 更新检查原先始终使用 `MockReleaseFeed`，重启固定返回 `REAL_INSTALL_DISABLED`，因此设置页不可能真实发现或安装 GitHub Release。现由 `electron-updater@6.8.9` 驱动 packaged 模式，`autoDownload=false`、`autoInstallOnAppQuit=false`；Renderer 通过窄 IPC 订阅状态，只有用户点击才下载或重启安装。
- 发布前修复了两类过期回归：preload 安全方法表遗漏四个受控 provider 通道；Playwright 仍选择已被单活动供应商正确隐藏的 RelayMe `Gemini Vision` 与旧反推路线。测试现改用带明确 `chat + vision + reverse_prompt` 能力的活动 Comfly 路由。
- 最新验证：`scan:e2e` 通过；全工作区 typecheck 通过；完整 Vitest 为 209 个文件、2498 个测试通过，2 个性能测试按设计跳过；完整 Playwright 144/144；最终生产 build 通过。
- 1.6.62 Windows x64 NSIS：`CanvasAtelier-Win10-11-x64-1.6.62.exe`，103182785 字节，SHA-256 `6E4FF3FB8BEA6B392AB08C358D4DFB41FA94C01FB469A2D6D7AAAA2F866E9E51`，Authenticode `NotSigned`。
- updater 资产：`.blockmap` 109428 字节，SHA-256 `E64E82F034EEA3039C774103AE3536D57CB73C1D4BD41BD4814B562BB3AC2AEC`；`latest.yml` 372 字节，SHA-256 `0DEA7E3FB7DBCDA96AFE3379021F9FBBCE45A400081CF6F5BC97401227241D56`。
- `win-unpacked/resources/app.asar`：版本 1.6.62，5592001 字节，SHA-256 `2C556A0C263B6C562B7C8AFC3BECEE3CD61492D4814CD9B8EDF4293B7C146C1A`。隔离 QA 数据根启动 8 秒保持存活，随后按精确 PID 终止且无遗留进程；未运行安装器、未覆盖现有安装。
- 剩余风险：Windows 产物未签名，SmartScreen 可能警告；真实 GitHub 1.6.62→1.6.63 下载/升级链路尚未完成远端发布验收，未获精确 QA 安装许可前不得点击“重启并安装”。

## 2026-08-28 GitHub 更新验证版 1.6.63

- GitHub Release：[v1.6.63](https://github.com/19960726/canvas-atelier/releases/tag/v1.6.63)，仅上传 EXE、blockmap、latest.yml 与 SHA-256 清单；未上传 dirty 源码、凭据或用户素材。
- `CanvasAtelier-Win10-11-x64-1.6.63.exe`：103182810 bytes，SHA-256 `9CA525C85B69E9E359500C7D1833B908EA1324BBCDAF421A109D75E00080A141`；blockmap 109446 bytes，SHA-256 `6E3DB4F920AD4AF5EE0529A19B763D3B6B30C3B4E369C7D03C16F601F3071DDF`；latest.yml 372 bytes，SHA-256 `BAB6822958934D10693DEA02C8838B8043465F96A730F71C9A7A4389E1054874`。
- `app.asar` 为 5592001 bytes，SHA-256 `A5766FA4A7DC4CE14C16B224007026F39A99BED24CED080670F8BEC4EE200199`，包内版本 1.6.63；EXE 与 unpacked 运行体均未签名。
- 验证：版本契约 17/17；scan:e2e、typecheck、Vitest 209/2498（2 skips）通过；Playwright 首次 143/144（单次 280ms 压力抖动），失败场景隔离重跑 6/6 通过；build、NSIS、隐藏隔离启动冒烟通过。远端 latest.yml 与 EXE 均 HTTP 200，EXE 长度 103182810。
- 更新验收实际停在远端元数据和安装包可下载性核验：本地 1.6.62 运行体在 1.6.63 重建时被覆盖，因此未声称完成旧版设置页 UI 下载；未执行重启/安装，也未触碰用户现有安装。
- 未解决风险：Windows 包未签名；需保留一份 1.6.62 运行体后再做一次真实设置页“检查更新→下载完成”验收。

## 2026-08-28 画布性能验收

- 当前实现已启用视口裁剪、选中/活动节点保留和交互期间低质量渲染；拖动、平移、缩放和连接预览均通过统一长任务观测器检查。
- 新鲜 Playwright 验证：`durable-canvas-stress.spec.ts` 在 1366x768、1440x900、1920x1080 的浅色/深色组合共 6/6 通过，300 节点、500 连线的所有操作最大 stall 为 200ms，低于 250ms 门槛；渲染节点数保持低于 50。
- `visual-layout.spec.ts` 15/15 通过，覆盖 100 节点压力图、布局无重叠和 pan/zoom frame marks；未发现水平溢出或交互回写异常。
- 本轮未修改性能实现；结论是性能项从“待验证”提升为“已验证”。仍未覆盖真实 Windows 7/10/11 多机 FPS，兼容性矩阵中的系统级项目继续保持 pending。

## 2026-08-28 持久化与恢复专项验收

- 凭据库、最近项目排序、关闭前保存、恢复扫描、Renderer 持久化和项目保存状态专项测试共 `85/85` 通过。
- `project-save-manager.spec.ts` 与设置更新流程 E2E 共 `2/2` 通过；项目管理列表、缺失项目状态、恢复版本和显式更新检查均正常。
- 本轮未运行安装器、未覆盖用户安装、未读取或写入真实用户凭据；跨版本真实覆盖安装仍需保留旧版运行体后单独验收。

## 2026-08-28 画布管理、模型目录、RelayMe 错误映射与 1.6.64 候选版

- 画布管理弹层透明的根因是 `.canvas-manager` 引用了未定义的 `--gate-panel-surface`。浅色和深色主题现分别提供不透明表面值，并由终端样式契约测试保护。
- Comfly 模型目录在生成 profile 前过滤空 key、空名称和重复精确 key，重复项保留第一条，避免无效或重复模型进入设置和执行路线。
- RelayMe 图片生成错误现区分认证失效、额度或频率限制、模型能力不支持以及网络超时，并保留可重试语义；用户可以据此重新登录、切换模型或稍后重试。
- 新鲜验证：完整 Vitest 209 个文件通过、2 个按设计跳过，共 2501 个测试通过、2 个跳过；完整 Playwright `144/144`；全工作区 typecheck 与 production build 均通过。压力验收为 `6/6`，300 节点和 500 连线下最大 stall 200ms；视觉布局 `15/15`；持久化专项 `85/85`。
- Windows x64 NSIS 候选包：`apps/desktop-modern/dist-builder/desktop-modern/CanvasAtelier-Win10-11-x64-1.6.64.exe`，103183411 字节，SHA-256 `2B6CE33DF36B6FAF49778AC24F19B1A950810125E4DD06EF8E8815DA92CCD93E`，Authenticode `NotSigned`。blockmap 为 109515 字节，SHA-256 `E83F956925F7679E90C22CDD94E8F0AF4B0F6C7E88B3D14EC2E95944C9B5A23C`。
- 最终隔离 `win-unpacked` 重启冒烟返回 `firstVersion=1.6.64`、`secondVersion=1.6.64`、`canvasVisible=true`、`fatalAlertCount=0`、`pageErrors=[]`、`restoredImageNodes=1`；图片生成的模型、比例、分辨率、数量和生成按钮均可见且高度为 30px。
- 未执行安装器、未覆盖现有安装、未提交或推送代码、未创建 GitHub Release。剩余风险是 Windows 包未签名、未做真实跨版本覆盖升级，也未发起付费的 Gemini/Comfly/RelayMe 在线请求。

## 2026-08-28 1.6.63 → 1.6.64 隔离更新发现与下载验收

- 从保留的 `CanvasAtelier-Win10-11-x64-1.6.63.exe` 直接提取真实 packaged 运行体，不执行 NSIS 安装器；其大小为 103182810 字节，SHA-256 为 `9CA525C85B69E9E359500C7D1833B908EA1324BBCDAF421A109D75E00080A141`。
- `work/release-1.6.63-to-1.6.64-update-smoke.mjs` 在脚本专属临时目录中启动 1.6.63，并通过随机本机 HTTP 端口提供当前 `latest.yml`、1.6.63/1.6.64 blockmap 和 1.6.64 EXE。设置页真实完成“检查更新 → 发现 1.6.64 → 下载更新 → 版本 1.6.64 已准备好”。
- 下载缓存 EXE 为 103183411 字节，SHA-256 `2B6CE33DF36B6FAF49778AC24F19B1A950810125E4DD06EF8E8815DA92CCD93E`，与 1.6.64 源安装包完全一致；HTTP 请求全部返回 200，页面错误为空，`restartInvoked=false`。
- QA 隔离事故：只设置应用 `userData` 不会改变 electron-updater 的 `baseCachePath`，第一次下载在真实 `%LOCALAPPDATA%` 测试专用缓存中因跨卷重命名 `EXDEV` 失败。验收脚本现同时把 `APPDATA` 和 `LOCALAPPDATA` 指向 E: 临时根，既修复跨卷改名，也保证下载缓存不会进入真实用户目录。
- 隐藏 Electron 的截图 API 在文件已经写入后仍返回超时；当前证据图已人工核对为“版本 1.6.64 已准备好”。最终脚本把已生成的非空截图视为成功证据，但下载完成的权威证据仍是 UI 状态、electron-updater 日志和缓存文件哈希。
- finally 清理后确认：无 `work/update-smoke-*` 临时目录、无 `%LOCALAPPDATA%/canvas-atelier-updater-smoke` 缓存、无隔离 Canvas Atelier 进程。没有点击“重启并安装”，没有覆盖用户现有安装。
- 本次是使用真实 packaged updater 与真实发布资产的本机 HTTP 验收，不等同于 GitHub 远端 1.6.64 Release 验收；1.6.64 尚未发布到 GitHub，远端发现/下载和真实覆盖升级仍保持未验证。

## 2026-08-29 RelayMe 生图、节点恢复、自动保存与设置目录修复

- RelayMe “连接成功但生图 0 秒失败”的请求契约根因已定位：画布把 `1K/2K/4K` 错误发送到 `imageQuality`，而 RelayMe 公共生图接口要求分辨率使用 `imageSampleSize`，画质使用 `low/medium/high`。现发送 `imageSampleSize` 与 `imageQuality: medium`，保留账号登录令牌认证，不引入独立 RelayMe API 密钥。
- 失败后无法重试有两条持久化根因：模型任务恢复无时间上限，旧 `running` 任务会继续占用节点；Reverse Agent 崩溃遗留的 `reverseAgentRunState: running` 会永久显示停止按钮。模型任务现在只允许恢复 30 分钟内的运行项，过期项转为本地取消；没有本地执行实例的持久化反推状态显示为“上次反推已中断”，可直接重新执行。
- 折叠图片/视频结果卡同时带有 `nodrag` 和阻断指针传播，导致必须展开提示词才能拖动。折叠结果壳与打开按钮现保留 `nopan`，移除 `nodrag` 和指针阻断，点击仍展开，拖动可直接移动节点。
- 打开节点缓慢的根因是完整供应商目录被传给每个节点并在节点内重复分类。`CanvasWorkspace` 现在只构建一次按能力去重的图片、视频、反推和分镜路线集合，再共享给节点。
- 新建画布不再显示“保存/不保存”确认框。存在未保存内容时先静默调用显式保存，成功后才新建；重复点击在同一个保存事务内合并，保存失败则保留当前画布。
- 模型目录改为单一能力工作区：顶部使用图标标签切换生图、视频、对话、反推、视觉和视频理解，正文一次只显示一个能力及其默认模型和启用列表。RelayMe 设置改称“账号连接”，空目录入口改为重新登录；连接检测与更新按钮使用同一 42px 画布主操作样式。
- TDD 红灯分别覆盖 RelayMe 请求字段、折叠节点拖动、过期任务恢复、画布路线精简、反推中断恢复、静默新建保存和能力标签目录。新鲜相关验证通过 9 个文件、499 个测试；全工作区 TypeScript 通过；生产 build 通过。构建仅生成本地 dist，尚未打包、安装或发布。
- 真实拖动后节点短暂移动却随即消失的根因不在点击手势，而是持久化位置回写时用未测量的 durable node 覆盖了 React Flow 节点，丢失 `width`/`height`/`measured` 等运行时测量，导致 React Flow 重新设为 `visibility:hidden`。`useCanvasDraft` 现在在持久化对齐时保留测量、选中和拖动态；折叠预览只在未发生位移的 pointer-up 时展开，卡片空白区可直接拖动。
- 最终相关联合回归为 10 个文件、511/511 通过；节点专项 181/181 通过；完整 TypeScript 检查和生产 build 通过。Playwright 真实浏览器回归 7/7 通过，覆盖 RelayMe/Comfly 独立目录、亮暗主题、生成启动失败后重试、折叠节点直接拖动、停止任务和结果重载。本轮仍未生成安装包、未安装、未提交、未推送、未发布。
- 按用户确认进入打包阶段：`npx.cmd electron-builder --projectDir apps/desktop-modern --config electron-builder.yml --win nsis --x64` 成功生成 `apps/desktop-modern/dist-builder/desktop-modern/CanvasAtelier-Win10-11-x64-1.6.67.exe`，文件大小 `103185794` 字节，SHA-256 `D1E0631CD8C3D28EFFED94E92BE8DFDB1A49E75B24CAAFC30C5014A3E6F18B54`，blockmap 大小 `109559` 字节，SHA-256 `F83D12BBDCAF5B84A73087AC6AF8935B9B7EFD011D1CFC0D2F9BCDCE3E1F4B68`，`latest.yml` 包内版本为 `1.6.67`。隔离 packaged 重启冒烟通过：`firstVersion=1.6.67`/`secondVersion=1.6.67`、`canvasVisible=true`、`fatalAlertCount=0`、`pageErrors=[]`、`restoredImageNodes=1`，五个生图控件均为 30px 且可见。包未签名（`NotSigned`），未安装、未覆盖旧版、未发布 GitHub。

## 2026-08-29 RelayMe 任务清单公开桥接契约回归

- 根因：RelayMe 账号任务清单新增窄 `provider.listTasks` preload 方法后，`bridge-contract.test.ts` 的公开 provider 方法白名单仍停留在旧集合，导致全量测试唯一失败。
- 保护行为：Renderer 只通过 `listTasks({ provider: 'relayme', page, size })` 接收任务 id、类型、状态、创建时间和错误摘要；桥接不得暴露令牌、远端内容、URL、base64 或原始工作流。
- 回归位置：`packages/desktop-core/src/bridge-contract.test.ts` 与 `packages/desktop-core/src/preload-api.test.ts`。Photoshop 脚本层另由 `packages/desktop-core/src/photoshop-script.test.ts` 固定 runner 的 CS6 major 13 门槛，防止 adapter 与 WSH runner 版本判断漂移。
- 验证命令：`npm.cmd exec vitest -- --config vitest.config.ts packages/desktop-core/src/bridge-contract.test.ts packages/desktop-core/src/preload-api.test.ts --run`，随后执行 `npm.cmd test` 和 `npm.cmd run build`。

## 2026-08-30 RelayMe Agent 对话真实响应适配

- 根因：RelayMe 当前 `/chat/completions` 成功响应是 `{ success, data: { content, model, promptTokens, completionTokens, totalTokens } }`，不是旧客户端唯一接受的 OpenAI 顶层 `{ id, model, choices }`。因此请求实际上已成功，但 `RelayMeClient` 在进入桌面 Agent 文本提取前就以响应格式无效拒绝。
- 保护行为：客户端同时接受 OpenAI-compatible 响应和 RelayMe 真实 data envelope，并把后者规范化为共享的 `choices[0].message.content` 与 `usage`；Comfly 与 RelayMe 的活动供应商和模型目录仍保持隔离，不做跨供应商回退。
- 回归位置：`packages/provider-relayme/src/client.test.ts` 固定真实 envelope 规范化；`packages/desktop-core/src/relayme-provider-service.test.ts` 固定字符串及结构化 content 的 Agent 文本提取。
- TDD 证据：新增客户端用例在修复前以缺少 `id` 明确失败；最小 schema union 适配后，客户端与桌面服务联合回归 43/43 通过。
- 在线证据：隔离 QA 桌面运行体使用已配置 RelayMe 账号调用 `gemini-3.1-flash-lite`，请求“只回复 OK”，桥接真实返回 `message: "OK"`。诊断只暴露响应键名和类型，临时脚本随后删除。
- 1.6.74 packaged QA：`win-unpacked/Canvas Atelier.exe` 在隔离数据根中报告版本 `1.6.74`；新建项目无确认框；创建节点后状态为 `pending`，点击真实保存按钮正常进入 `saved`，没有停留在 `saving`；节点从 `(730, 301.67)` 移至 `(843, 376.67)` 后 Ctrl+Z 回原位；Delete 删除后 Ctrl+Z 恢复；生图提示词文本 Ctrl+Z 清除；Codex Agent 选择 `gemini-3.1-flash-lite`，真实对话返回 `OK`；静默退出在 25 秒门限内完成，页面错误为 0。
- 正式构建证据：联合 RelayMe 回归 43/43、全工作区 typecheck、production build 和 Electron Builder Windows x64 NSIS 均通过；完整 Vitest 为 210 个文件、2566 个测试通过，2 个性能文件/测试按设计跳过。
- 1.6.74 Windows x64 NSIS：`CanvasAtelier-Win10-11-x64-1.6.74.exe`，103192040 字节，SHA-256 `925EF2FCD236007AA40CBE8C37720BCA7D3E724B8E4D74CE6CFD3B51DCE4AC58`；blockmap 109534 字节，SHA-256 `F7E4395471210E50C0D817EC64F7D01EFACA430182AE391B8A4851EE36865AAE`；`latest.yml` 372 字节，SHA-256 `6EE29C1AEE45DF08A8C75712B42F093AE06F6D937D0BD8F68EE94CCD140A6A49`。安装包未签名（`NotSigned`），Windows 可能显示 SmartScreen 警告。

## 2026-08-31 正式数据冲突、新建/退出恢复与 RelayMe 连接状态修复

- 正式版“新建项目无响应”的确认根因是当前项目处于 `REVISION_CONFLICT`：新建流程仍先调用不可能成功的保存，并在失败后直接返回。现在只在只读或持久化冲突阻止保存时明确询问是否放弃本次未保存更改；取消会保留原画布，确认后才新建。正常可保存状态仍先静默保存，不降低数据安全。
- 正式版“退出卡住”的确认根因是关闭协调器收到 Renderer 的 `failed`/`timeout`/`unavailable` 结果后已有恢复回调能力，但主进程没有接入。主进程现在显示原生安全选择，默认取消；只有用户明确选择“放弃未保存更改并退出”才关闭，已保存项目不受影响。
- RelayMe 当前正式凭据与 Electron 网络链路经只读模型目录调用验证为可连接；截图中“网络不可用”不能据此认定为真实断网。设置页此前 12 秒超时短于 provider 的 30 秒请求边界，会提前把慢响应误标为网络不可用。UI 检测边界现为 35 秒，并把超时单列为“连接检测超时”，认证、限流与真实网络错误仍保持独立状态。
- 回归位置：`apps/renderer/src/canvas/CanvasWorkspace.test.tsx`、`apps/desktop-modern/src/close-coordinator.test.ts`、`apps/renderer/src/settings/SettingsDrawer.test.tsx`。TDD 红灯分别复现冲突新建不执行、主进程未接恢复回调、前端超时误标网络不可用。
- 新鲜验证：相关联合回归 192/192，升版后的版本/关闭/新建/设置联合回归 201/201；全工作区 TypeScript 通过；完整 Vitest 210 个文件、2571 个测试通过，2 个性能文件/测试按设计跳过。生产 build 与 Electron Builder Windows x64 NSIS 均退出 0。
- 1.6.76 隔离 packaged 验收实际执行了“新建项目 → 创建图片生成节点 → 保存 → 正常关闭 → 重新打开恢复”：两次运行版本均为 1.6.76，`canvasVisible=true`、`fatalAlertCount=0`、`pageErrors=[]`、`restoredImageNodes=1`，五个图片生成控件均可见。该验收未读取正式用户项目，也未触发付费生成。
- 正式候选安装包：`apps/desktop-modern/dist-builder/desktop-modern/CanvasAtelier-Win10-11-x64-1.6.76.exe`，103192907 字节，SHA-256 `B84A48EF366F82338D2CBBC7A176B0C2F14F2A70701228F94F0600E3255C115B`；blockmap 109624 字节，SHA-256 `1D6EE8D386D741DCED9C8F9EB30D98710E1B6842B81F0865543B951048EF06D6`；`latest.yml` SHA-256 `69B1EB629B90A79F23AA87151B22B79E9C0CC6C61EA418AD64B9C87F1570B51B`。`app.asar` 包内版本独立读取为 1.6.76。安装包未签名（`NotSigned`），Windows 仍可能显示 SmartScreen 警告。

## 2026-08-31 正式旧项目 Del 冲突恢复修复

- 确认根因：已安装 1.6.76 对新建普通节点的 Delete 黑盒测试能够成功，问题不是按键监听全局失效。正式旧项目处于 `REVISION_CONFLICT` 时，Store 会在删除事务执行前返回 `false`，但 `deleteCanvasNodesWithDurableReload` 只在 `saveStatus === 'read_only'` 时重载重试；冲突状态是 `saveStatus: 'error'`，因此 Del 静默结束且节点仍存在。
- 保护行为：删除首次失败时，仅当桌面允许安全重载且当前状态为只读或明确的持久化冲突，才重载最新持久化项目并对相同节点 id 重试一次。普通保存错误不会被误当作冲突，也不会无限重试。
- 回归位置：`apps/renderer/src/canvas/CanvasWorkspace.test.tsx` 的 `reloads and retries when Delete is blocked by a durable revision conflict`。该用例修复前明确失败为节点数仍为 1、重载 0 次；最小实现后通过，并确认重载 1 次、删除调用 2 次。
- 当前新鲜验证：聚焦红转绿通过；`CanvasWorkspace` 与 `app-store` 联合回归 307/307 通过。验证命令：`npm.cmd exec vitest -- --config vitest.config.ts apps/renderer/src/canvas/CanvasWorkspace.test.tsx apps/renderer/src/app/app-store.test.ts --run`。全量测试、构建、打包及安装版验收仍待执行，不得据此提前声称正式安装包已完成。

## 2026-08-31 正式 Photoshop 与最近项目切换边界修复

- 正式 Photoshop 按钮无反馈存在两个确认根因：Electron Builder 未把 `dist/photoshop` 带入安装包的 `resources/photoshop`；Windows runner 又使用旧 JScript 不支持的对象尾逗号和不可用的 `JSON.stringify`，错误处理本身也会再次失败并返回空输出。
- 修复后打包清单明确复制 Photoshop 资源，脚本使用旧 WSH 兼容的平面对象 JSON 编码，并以测试禁止尾逗号和原生 `JSON.stringify`。目标机只读 `cscript` 实测返回 Photoshop major 27、`activeDocument: false`，证明连接与诊断输出已恢复；当没有活动 PSD/PSB 时 UI 应明确提示，而不是静默无反应。
- 画布管理把当前已经打开的同一项目再次显示为“打开”，点击只能形成表面无响应。现在同项目显示禁用的“当前项目”；真正打开其他最近项目或文件夹前，未保存内容必须先保存，只读或 `REVISION_CONFLICT` 则明确确认是否放弃本次更改。
- 新鲜验证：全量 Vitest 210 个文件、2575 个测试通过，2 个性能文件/测试按设计跳过；全工作区 TypeScript 通过。生产打包、安装版验收仍待执行，不得提前声称正式版完成。

## 2026-08-31 1.6.78 项目会话竞态、安装版验收与 RelayMe 真实状态

- “新建后 Del 又出现旧节点”的最终根因是旧项目关闭与同会话刷新重叠：刷新推进 `clientGeneration` 后，`close()` 因 generation 不同而放弃清理已经关闭的旧 session。新画布第一次保存因此仍写向旧项目并形成 revision conflict，删除冲突恢复又把旧节点载回。`close()` 现在以 session/project 身份判断是否仍是同一关闭目标；只有已经切换为其他 session/project 才放弃清理。新增竞态测试修复前明确得到 `lifecycle: durable, revision: 4`，修复后为 `untitled, revision: 0`。
- 完整 Vitest 为 210 个文件、2577 个测试通过，2 个性能文件/测试按设计跳过；项目持久化、Store 与 CanvasWorkspace 联合回归 365/365；全工作区 TypeScript 与 production build 通过。Electron Builder Windows x64 NSIS 成功。
- 打包版和安装版分别在独立 QA 数据根执行真实 Electron 验收，均得到：`createdCount=1`、Delete 后 `deletedCount=0`、Ctrl+Z 恢复 `restoredCount=1`、文本撤回为空、节点移动撤回成功、当前项目标记 1 个、关闭重开节点 1 个、`fatalAlertCount=0`、`pageErrors=[]`，两次运行版本均为 1.6.78。验收未读取正式项目、未触发付费生成。
- 安装包：`apps/desktop-modern/dist-builder/desktop-modern/CanvasAtelier-Win10-11-x64-1.6.78.exe`，103195247 字节，SHA-256 `C0E02AF7B636E77802A3CC09B499E8771F6E1DD4D1B5DA1DFD155E1D2CF1254F`；blockmap 109689 字节，SHA-256 `4F4C7897465D154322B2CF022E2F52737235D62601EDDA7482AD503A01214B7D`；`latest.yml` 372 字节，SHA-256 `40A3810DC652E83493F9BEEC70A2D7F48429792B5A9F4872FCB4C055A4CD73D8`。安装包未签名（`NotSigned`）。
- 已静默安装到 `D:\CanvasAtelier\Canvas Atelier`；安装后 `resources/app.asar` 与 packaged `app.asar` SHA-256 均为 `6D57F85E7FA7711D2529F6124780FD642B09BA8E6233B0F4C7123615D6795AB6`，包内版本均为 1.6.78；已安装 Photoshop runner/JSX 资源存在。
- RelayMe 本机网络实测：DNS 解析到 `47.57.181.124`，443/TLS 成功；无凭据访问模型和 workflow 接口均快速返回 401，说明链路可达且接口要求登录认证。已安装正式数据的脱敏检测为 `configured=true`、`locked=false`、`encryption=safeStorage`、`activeProvider=relayme`，但服务端返回 `authentication_failed`、模型 0 个；这是已保存账号会话被拒绝，不是真实断网。用户无需手工 API Key，但必须重新输入 RelayMe 账号密码取得新会话令牌。未读取或输出令牌与密码。
- RelayMe 图片数量控件为 1–4 张；一次点击会创建同一 confirmedAt 下的 1–4 个独立结果任务，provider queue 并发上限 4，现有回归固定 RelayMe 即使单任务约束为 1 也会一次排入 4 个任务。这样每个结果都有独立持久化资产和重试身份；不是要求用户逐张点击。未执行付费多图在线测试。
