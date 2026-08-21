# Inline Media Mention Chip Design

## Goal

Replace visible raw mention text such as `@图片1` and `@视频1` with highlighted inline mention chips labelled `图片1` and `视频1`, matching the supplied reference interaction while preserving the managed asset binding used by reverse analysis and generation providers.

## Scope

- Agent chat composer.
- Reverse-analysis task editor.
- Image-generation prompt editor.
- Video-generation prompt editor.
- Up to 20 selected media references.

## Visual behaviour

- A selected image reference is visibly rendered as a highlighted rounded chip: `图片1`, `图片2`, and so on.
- A selected video reference is visibly rendered as `视频1`, `视频2`, and so on.
- The `@` trigger is never visible after selection.
- The surrounding prompt remains ordinary selectable text.
- Hovering or focusing a chip exposes the managed media thumbnail, display label, and semantic reference name.
- Image and video numbering are independent.

## Data behaviour

- The editor keeps a canonical mention token and managed asset ID internally so existing provider and persistence contracts remain compatible.
- Only presentation removes the `@`; provider requests continue receiving the canonical semantic reference token required to bind the correct asset.
- Removing or editing a chip removes its associated citation without affecting other references.
- Existing projects containing canonical `@图片N` or `@视频N` text render as chips when reopened.

## Implementation boundary

- Introduce one reusable mention presentation/editor component instead of maintaining separate implementations in every node.
- Do not auto-create or auto-run generation nodes.
- Do not change media import, provider credentials, project save semantics, or installed software.

## Verification

- Component tests cover hidden `@`, visible highlighted labels, independent image/video numbering, removal, and the twentieth image.
- Existing Agent and module execution tests continue to assert managed asset IDs are sent.
- Playwright verifies the visible chip and hover preview in light and dark themes.
- Run typecheck, production build, full tests, then generate a new uniquely versioned Windows installer with SHA-256 verification.
