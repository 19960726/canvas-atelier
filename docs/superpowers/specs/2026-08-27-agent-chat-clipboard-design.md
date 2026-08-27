# Agent Chat Clipboard Design

## Goal

Make the complete Agent chat surface behave like a conventional desktop conversation: users can select and copy visible conversation content, paste text and supported media into the composer, and use clipboard shortcuts without triggering canvas commands.

## Current Cause

`SkillChatWorkbench` handles media paste only at the composer textarea and reads a single media file from `ClipboardEvent.clipboardData`. This leaves multi-file clipboard payloads incomplete. The conversation surface also has no explicit interaction contract protecting native text selection and clipboard events from the surrounding canvas shortcut layer.

## Considered Approaches

1. Rely entirely on browser defaults. This preserves plain-text clipboard behavior but does not solve ordered multi-media import or establish a durable canvas-boundary contract.
2. Add a global application clipboard manager. This could centralize behavior, but it would broaden the change to unrelated canvas and editor surfaces and create shortcut ownership conflicts.
3. Enhance clipboard behavior inside the Agent workbench only. Keep native text selection and text paste, add ordered media extraction at the composer, and stop clipboard events at the workbench boundary before they reach canvas handlers.

Approach 3 is selected because it provides complete Agent behavior while keeping ownership local and preserving every other application surface.

## Interaction Contract

- User and assistant message text, code, request details, source labels, and visible result text are selectable and copyable with native `Ctrl/Cmd+C` and the operating-system context menu.
- The composer accepts plain text, rich-text clipboard content reduced to readable plain text with line breaks, images, videos, and mixed text/media clipboard payloads.
- Every supported pasted image or video is imported in clipboard order. Successful imports add sequential `@图片N` or `@视频N` references at the current composer insertion point.
- Pasting media does not discard accompanying clipboard text. Text is inserted once at the caret and media mentions follow in deterministic order.
- Unsupported clipboard files are ignored when readable text is present. When a media-only paste contains unsupported or failed files, the workbench shows a concise error and keeps any earlier successful imports.
- Copy and paste events originating inside the Agent workbench do not invoke canvas copy, paste, delete, or selection shortcuts.
- Copied conversation content includes only rendered user-facing content. Provider credentials, internal metadata, and local managed-file paths are never synthesized into clipboard text.
- Existing provider capability checks remain authoritative when references are submitted. Clipboard import success does not imply that an incompatible route may send media.

## Architecture

### Clipboard parsing

Add a small pure helper near the Agent workbench that converts `DataTransfer` into an ordered clipboard payload:

- readable plain text, preferring `text/plain` and using normalized rich-text text only when plain text is absent;
- all supported image/video files from `files` and file-kind `items` without duplicating the same clipboard entry;
- stable clipboard order.

The helper is independently unit-tested so browser clipboard edge cases do not expand the component event handler.

### Composer import flow

The composer paste handler prevents the default action only when custom handling is needed. It inserts text using the textarea selection range, then imports supported media sequentially through the existing managed-file bridge. Sequential import preserves mention numbering and clipboard order. State updates use the latest composer value so asynchronous imports cannot overwrite user edits made while an earlier file is being managed.

### Event boundary and selection

The Agent workbench root owns clipboard events originating within it and stops propagation to the canvas. Message bodies and their visible detail regions explicitly allow text selection. Interactive controls keep their existing button behavior and are not turned into custom copy controls.

## Testing

Follow red-green TDD with focused regressions in `SkillChatWorkbench.test.tsx` and the relevant canvas shortcut suite:

- copies/selects visible user and assistant content without exposing internal request data;
- preserves native multiline text paste;
- imports multiple images/videos in clipboard order and produces ordered citations;
- handles mixed text plus media without losing either payload;
- uses file-kind clipboard items when `files` is empty without creating duplicates;
- preserves successful imports and reports a later import failure;
- prevents Agent clipboard events from reaching canvas shortcuts;
- preserves the existing provider media-capability gate.

After focused tests pass, run the Agent/canvas wider suites, renderer typecheck, full Vitest, and Playwright clipboard coverage. Packaged smoke remains a separate release gate and must not be inferred from browser tests.

## Non-Goals

- No clipboard history or custom clipboard UI.
- No automatic copying of hidden request payloads or managed-file paths.
- No bypass of model-route media capability checks.
- No changes to clipboard behavior outside the Agent workbench.
