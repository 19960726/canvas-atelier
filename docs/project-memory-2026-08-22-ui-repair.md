# Project Memory: 2026-08-22 UI Repair

## Scope

Continue the existing `staging-canvas-build` work without reverting or cleaning any uncommitted changes.

## Confirmed Causes

- The packaged screenshots came from the legacy transparent textarea plus presentation-overlay implementation. The two layout trees drifted, producing an offset purple caret and duplicated prompt text.
- The current renderer uses one contenteditable surface. Media chips must remain in that surface so canonical offsets and the browser caret share geometry.
- Node mention catalogs previously used every project image/video. Mention candidates and previews must be derived from the node's ordered connected media only.

## Changes Made

- Media mention chips render a managed image or video thumbnail inside the chip while serializing to the unchanged canonical `@图片N` / `@视频N` token.
- Image generation, video generation, and reverse-agent mention previews and menus are filtered to `connectedMedia`.
- Existing project data and unrelated uncommitted work remain untouched.

## Reverse Prompt Logic

- Multi-reference reverse analysis treats explicit `@图片N` / `@视频N` assignments in the task as synthesis constraints and preserves source traceability.
- The request template now requires a source binding table, per-source adoption/conflict decisions, scene structure, foreground/midground/background depth, occlusion, perspective, camera compression, foreground/background distance, depth falloff, visual center, subject scale, whitespace, safe area, leading lines, crop, and aspect ratio.
- Final prompts are organized as product identity, scene structure and spatial depth, composition and camera, materials and props, people and actions, lighting and color, white-background product adaptation, then quality and constraints.
- Result validation accepts the source `mention` and optional `spatialDepth` fields so structured reverse results can retain these decisions.

## Verification Notes

- `MediaMentionTextarea.test.tsx`: 10 tests pass, including inline thumbnail rendering and single-surface behavior.
- `ModuleNodeCard.test.tsx`: the implementation passes existing connected-media behavior; two legacy tests still expect unconnected project assets to appear and must be updated to the connected-only contract.
- `professional-reverse-analysis.test.ts`: 5 tests pass, including explicit mention assignments and scene/composition traceability.
- `reverse-prompt-agent.test.ts`: 22 tests pass, including source mentions and spatial depth schema validation.
