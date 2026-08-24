# Professional Reverse Analysis, Inline Generation Result, and Save UI Design

## Scope

This design covers three independently testable repairs:

1. A completed image/video generation job must not be reported as successful until its result is durably attached to the originating generation node.
2. Reverse analysis must produce production-grade visual, effect, lighting, fluid, camera, and product-adaptation analysis for images, multiple references, and video.
3. Save-related UI must only open from explicit save-management, new-project, import, export, or diagnostic actions.

Existing user changes and dirty files must be preserved. Implementation is performed in `E:\画布项目\staging-canvas-build` on `feature/canvas-agent-mvp`; no reset, checkout, cleanup, or commit is authorized.

## 1. Inline generation result durability

The provider result, generation-history original, and project asset can already exist while the source `image_generation` node still has an empty `resultAssetIds`. The job must remain non-terminal until the source node contains the generated asset and the durable transaction has succeeded.

Rules:

- Image results are stored in `sourceNode.data.config.resultAssetIds`, deduplicated and limited to the latest four.
- Video results are stored in `sourceNode.data.config.videoResults`, deduplicated and limited to the latest four.
- `resultState` becomes `fresh`, `lastResultJobId` remains the owning job, and node execution becomes `completed` in the same canvas transaction.
- A project-level asset record is not evidence that the source node result is materialized.
- A job may transition to `completed` only after re-reading the current project and verifying that the originating node contains the result asset.
- Recovery of an already-completed job repairs the missing node binding even when the asset file is already present.

## 2. Professional reverse-analysis contract

The professional system persona is always present. User-entered role text is an additional preference and cannot replace the system persona; blank, numeric-only, or very short roles fall back to the default.

All results retain the legacy summary fields for display compatibility, and add structured production sections:

- `mediaResponsibilities`: per-source role, priority, inheritance, conflicts, and usable elements.
- `sceneDecomposition`: subject, model, food, prop, normalized placement/scale, occlusion, z-order, foreground/midground/background, and scene structure.
- `composition`: visual center, whitespace, guiding lines, balance, crop, and product-safe area.
- `camera`: estimated focal-length range, shot size, height, pitch/yaw, perspective, vanishing points, distortion, and confidence.
- `depthAndFocus`: focus subject, depth-of-field level, focus plane, foreground/background blur, and separation method.
- `materialsAndTextures`: object-level material, roughness, reflection, translucency, texture scale, and production method.
- `lightingAndColor`: key/fill/rim/environment light, sweep light, color temperature, contrast, highlight roll-off, reflection, volumetric light, and premium-look rationale.
- `effects`: effect type, visual responsibility, source/emitter, motion, parameters, masks, blend/composite order, render passes, and recreation steps.
- `fluids`: fluid type, purpose, viscosity, surface tension, direction, simulation/2D alternative, mesh/shader, interaction with the product, and safety constraints.
- `whiteBackgroundAdaptation`: product silhouette protection, contact shadow, reflection anchoring, color-contamination prevention, effect isolation, and elements that must not be copied.
- `subjectScaleAndPlacement`: model/product/food proportions and placement constraints.
- `videoTimeline`: time ranges, shot type, estimated focal length, camera movement, speed curve, stabilization, subject motion, sweep light, effects, transition, keyframes, and product adaptation.
- `positivePromptZh`, `positivePromptEn`, `negativeConstraints`, `executionChecklist`, and `uncertainties`.

Analysis modes:

- Single image: one deep structured request.
- Multiple images: stage one analyzes each source responsibility; stage two synthesizes conflicts and product adaptation.
- Video: stage one creates a shot/time timeline; stage two synthesizes reusable camera, lighting, effect, and white-background product instructions.

If a provider cannot perform a second request safely, it must still receive the full structured contract in one request. No paid live provider request is part of automated verification.

## 3. Save UI trigger boundaries

- Clicking the main save button saves without opening the project manager.
- Only the adjacent chevron toggles `ProjectManagerPopover`.
- Clicking New Project with unsaved content opens the in-app confirmation.
- Image generation, video generation, reverse analysis, job completion, canvas double-click, paste/drop import, and autosave never open save UI.
- Native `showSaveDialog` remains limited to explicitly requested diagnostic export, import destination, package export, or any explicitly supported Save As flow.
- Popovers close when an unrelated canvas action begins and must not reopen from save-state changes.

## Acceptance

- A regression reproducing asset storage before node materialization fails before the fix and passes afterward.
- Provider request tests assert every professional section and the fixed professional persona.
- Image, multi-image, and video tests assert their mode-specific instructions, including effects, fluids, sweep light, camera movement, and white-background adaptation.
- UI tests prove save manager and new-project confirmation trigger only from their explicit controls.
- Focused Vitest tests and TypeScript typecheck pass using `npm.cmd` on Windows.
