# Design QA — Universal media thumbnails

- Source visual truth: `C:\Users\ADMINI~1\AppData\Local\Temp\codex-clipboard-db61c3f7-1463-47bc-bc2b-a1812bba2c51.png`
- Implementation screenshots:
  - `artifacts/2026-08-07-canvas-interaction-consolidation/light-generation-expanded.png`
  - `artifacts/2026-08-07-canvas-interaction-consolidation/dark-generation-expanded.png`
  - `artifacts/2026-08-06-agent-multimedia/reverse-multi-video-reordered-light.png`
  - `artifacts/2026-08-06-agent-multimedia/agent-chat-image-picker-light.png`
- Combined comparison: `artifacts/2026-08-08-universal-media-qa-comparison.png`
- Viewport: generation 1600×1000; Agent/reverse 1680×1050.
- State: expanded generation node with connected managed media; mixed image and multiple video reverse inputs; Agent `@` media picker; light and dark themes.

## Full-view comparison evidence

The source and implementation use the same vertical anatomy: generation preview, compact numbered media thumbnail row, prompt editor, then model/output controls. The implementation preserves media aspect ratio with `object-fit: contain`, uses a shared 20-item counter, and keeps the row within the node shell in both themes.

## Focused-region comparison evidence

- Generation media row: real managed image thumbnail is visible above the prompt, numbered, and followed by the add affordance.
- Reverse Agent: one image plus two MP4 video covers render in one ordered tray and can be reordered.
- Agent conversation: the empty state contains welcome copy and Skill actions; the `@` picker shows a real managed thumbnail instead of a blank tile.
- A separate focused crop was not required because the 32px media row and labels are readable in the full-size captures and are additionally verified by DOM/E2E assertions.

## Required fidelity surfaces

- Fonts and typography: existing Canvas Atelier typography and hierarchy are preserved; media labels and counters use the existing small-control scale.
- Spacing and layout rhythm: thumbnail row is positioned between preview and prompt; expanded image/video nodes share the same 830px geometry and 54px media rail.
- Colors and visual tokens: light/dark media surfaces use the existing gate tokens; no theme-specific hardcoded thumbnail colors were introduced.
- Image quality and asset fidelity: image and video media use real managed URLs, retain aspect ratio, and do not use blank placeholders when a valid asset is present.
- Copy and content: all mixed-media rails use the universal label `素材输入`; Agent conversation has a non-empty onboarding state.

## Findings

No actionable P0/P1/P2 mismatch remains for the requested universal thumbnail behavior.

## Comparison history

1. Earlier evidence showed browser `blob:` previews being rejected, video media excluded from image-generation trays, and the video tray placed after the prompt.
2. Fixes: allow same-origin blob previews, resolve mixed image/video edges into one ordered media list, move the expanded tray above the prompt, and reserve dedicated layout space.
3. Post-fix evidence: 175 focused unit/style tests passed; 7 browser interaction tests passed; 2 light/dark screenshot tests passed.

## Follow-up polish

- P3: replace synthetic E2E fixture artwork with production media when performing final release screenshots.

## Primary interactions tested

- Import managed image/video media.
- Connect media to generation and reverse nodes.
- Render real image thumbnails and video covers.
- Reorder mixed reverse media.
- Open Agent `@` picker with a real thumbnail.
- Exercise settings/model/storage/Agent controls.
- Console checked after removing the temporary Figma capture script; no application console error blocked the final browser run.

final result: pending external release verification

Automated gate status (2026-08-13): Vitest 2038 passed / 2 skipped, typecheck passed, production build passed, secret/path scan passed, persistence and knowledge performance gates passed, and Playwright interaction assertions passed (118/118; runner shutdown reported a teardown-process error after all tests completed). Final installer, overwrite-install persistence, real Provider requests, and Photoshop 2019+ verification remain release gates.
