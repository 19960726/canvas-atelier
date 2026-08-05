# Settings, Agent, Generation, and Rail Polish Design

Date: 2026-08-05

## Goal

Bring the current canvas settings, Agent composer, image/video cards, and left tool rail into the approved Figma-aligned interaction model while preserving existing desktop safety boundaries.

## Scope

### Settings navigation

- Keep four settings tabs only: `API 与模型`, `存储与备份`, `MCP 联动`, and `同步`.
- Remove the `使用说明` tab and its content.
- Keep light and dark themes on the same component geometry and token system.

### Storage and cache path

- Add a cache-directory card to `存储与备份` using the supplied reference layout.
- Show the effective cache directory in a read-only field.
- Provide `打开缓存目录`, `自定义目录`, and `恢复默认目录` actions.
- Persist the selected directory through the desktop bridge, not renderer-only storage.
- When changing directories, migrate existing regenerable cache first. Switch the configured path only after migration succeeds.
- If selection is cancelled or migration fails, retain the previous directory and cache contents.
- Reject non-directory targets, paths that cannot be created, and unsafe roots.
- Cache cleanup must remain limited to regenerable cache and must not delete project originals or exported works.
- Browser-only and E2E modes expose a controlled unavailable state instead of pretending a directory was changed.

### Advanced diagnostics

- Keep diagnostics inside the settings experience but replace the loose stacked layout with two compact status cards.
- `连接与恢复` contains secure-storage status, the local protection-password field when relevant, connection status, and check/unlock actions.
- `应用更新` contains current update status, check action, available-version details, and error feedback.
- Inputs and actions use fixed dimensions and centered icon/text alignment in both themes.

### Agent knowledge selection

- Always allow selecting `场景 Skill` and `电商详情页知识库` in the footer picker.
- Sync state is informational only and must not disable selection.
- Selected IDs remain part of the chat request context.
- The picker continues to show only the two approved knowledge choices plus project memories.

### Agent image upload

- Enable the composer `＋` action.
- The action opens the existing confined desktop project-image importer.
- A successful import refreshes managed project images and adds the new image as a selected Agent citation when the active model supports vision.
- If the active model lacks vision, the image remains safely imported but the composer shows a clear model-capability message and does not attach it.
- Cancellation leaves the conversation unchanged; import failures show a controlled error.
- Uploaded images appear in the existing `@` mention menu and are sent as managed asset IDs.

### Image resolution

- Replace the static `清晰度` control with one visible selector containing `1K`, `2K`, and `4K`.
- Store a stable resolution tier in the image-generation request and map it to provider-specific dimensions at the execution boundary.
- Preserve compatibility with existing persisted dimension values by normalizing them to the nearest tier when hydrating old nodes.
- The selected tier must be included in the submitted generation request.

### Image and video collapsed cards

- Remove the permanent `待配置` status chip and `生成数量 · n / 4` footer from both image and video collapsed previews.
- Keep quantity selection only in the expanded parameter controls.
- Preserve running/cancel behavior in the expanded workbench.

### Connected media slots

- An image connected to image generation must immediately render as a managed thumbnail slot inside the generation card.
- An image or video connected to video generation must immediately render as a thumbnail or poster slot inside the video card.
- Slots remain visible in both collapsed and expanded states and use the same ordered media list as the generation request.
- Image slots preserve source aspect ratio inside a fixed thumbnail frame; video slots use the managed poster when available and a video fallback icon only when no poster can be resolved.
- Connecting, reconnecting, reordering, or disconnecting an edge updates visible slots without a page reload.
- A disconnected asset is removed from the slot row and from the next generation request.
- Empty placeholders appear only for explicit first-frame/end-frame video positions, not as a replacement for connected media.
- Slot rows must not be hidden by legacy connected-media CSS rules.

### Left tool rail

- Match the supplied reference: 44px square controls with 58px clear vertical gaps, yielding a 102px start-to-start rhythm.
- Keep every glyph centered and keep disabled controls in the same layout slot.
- Use one shared geometry for dark and light themes.
- Preserve all existing callbacks and the seven visible actions.

## Architecture

- Extend the typed desktop preload API with a cache-directory capability rather than calling Electron APIs from React.
- Implement native directory selection, path validation, migration, persistence, open-directory, and reset behavior in the desktop main process/core boundary.
- Keep `SettingsDrawer` as a view/controller over the bridge result.
- Add a narrow Agent import callback from `CanvasWorkspace` to `SkillChatWorkbench`, reusing the existing project-image persistence client and store refresh path.
- Keep image resolution normalization in domain/job code so UI labels do not leak into provider adapters.

## Error handling

- Directory selection cancellation is not an error.
- Migration is copy/verify/switch/cleanup; failure before switch leaves the old cache authoritative.
- UI actions expose busy states and prevent duplicate operations.
- All filesystem errors are converted to stable bridge errors without exposing private paths in logs or chat content.

## Verification

- Unit tests cover cache path selection, cancellation, migration success, rollback, reset, and preload channel mapping.
- Settings tests cover the four-tab navigation, cache controls, diagnostics layout, and disabled browser fallback.
- Agent tests cover selecting unsynced knowledge, successful/cancelled image import, vision capability handling, and request citation IDs.
- Generation tests cover `1K / 2K / 4K` selection and submitted request values.
- Node tests assert collapsed image/video cards omit status and quantity labels.
- Media-slot tests cover image-to-image, image-to-video, video-to-video, reconnect, disconnect, collapsed, and expanded rendering states.
