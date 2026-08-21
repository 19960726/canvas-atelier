# Connected Media Mentions and Photoshop Menu Design

Date: 2026-08-21

## Goal

Repair three related canvas interaction defects without changing existing project data semantics:

1. Media mention chips must not cause cumulative caret drift.
2. Node mention pickers must expose only media connected to that node's input ports.
3. The generated-image Photoshop action must use an opaque, legible menu and provide explicit progress, error, and retry feedback.

The next packaged release must be newer than `1.6.40`.

## Scope

This design applies to media-aware prompt editors in canvas nodes, especially image generation, video generation, and reverse analysis. It does not change the global agent chat's project-wide media picker unless that chat is hosted inside one of these node editors.

The Photoshop change applies only to generated-image action menus. It will not automatically launch Photoshop, create a Photoshop document, or alter unrelated documents.

## Mention Editor Architecture

Replace the transparent textarea plus presentation overlay with a single inline editing surface. The editor renders normal text and non-editable media mention elements inside the same layout tree, so the browser caret and visible content share one geometry.

Each mention is displayed as a light rounded capsule matching the supplied reference:

- a small pin icon on the left;
- visible labels such as `图片1`, `图片2`, or `视频1`;
- no visible `@` character;
- clear focus, hover, and selected states in both light and dark themes.

The canonical value remains plain text containing tokens such as `@图片1` and `@视频1`. The editor must serialize its DOM back to that canonical value on input and reconstruct its DOM from the value when external state changes. This preserves existing model prompts and saved project compatibility.

The editor must preserve:

- Chinese IME composition;
- paste as plain prompt text;
- new lines;
- Backspace/Delete behavior around chips;
- arrow-key navigation before and after chips;
- focus and selection restoration after controlled updates;
- hover preview for valid connected media.

## Connected-Media Source of Truth

Node mention choices and previews must be derived from that node's ordered connected-media list, not from all project assets.

For each node:

1. Read the graph edges connected to the relevant input port.
2. Preserve the current edge order.
3. Resolve each connected asset against managed project image or video metadata.
4. Build separate image and video sequences.
5. Assign canonical tokens by media kind: `@图片1...@图片20` and `@视频1...@视频20`.

Project assets that are not connected to the current node must not appear in the picker, mention preview map, or submitted `referenceAssetIds` for that editor.

When a connection is removed, any mention that referred to the disconnected asset is automatically removed. Remaining mentions are rebound to the new ordered connection list and renumbered consistently. This cleanup must occur before persistence or model execution so a visible label cannot silently refer to the wrong asset.

## Photoshop Action Menu

The generated-image context menu becomes a solid elevated panel with an opaque theme surface, readable border, shadow, item hover states, and sufficient contrast. It must not visually blend into the canvas as a transparent strip.

The Photoshop action state machine is:

- idle: action is available for a generated image when the desktop bridge and active project session exist;
- busy: action remains visible and displays `正在导入 Photoshop…` with a spinner or equivalent progress cue;
- success: display `已导入当前 Photoshop 文档`;
- error: display the mapped actionable reason;
- retry: an explicit `重试` control repeats the same import for the same asset.

Photoshop not running and no active document are runtime errors, not silent disabled states. The user must be able to click the action and receive the existing specific messages:

- `请先启动 Photoshop 并打开目标文档`;
- `请先在 Photoshop 中打开 PSD 或 PSB 文档`.

Only structurally unsupported cases remain disabled, such as a missing desktop bridge, missing project session, or a non-generated image.

## Data Compatibility

Existing stored prompts remain valid because canonical tokens do not change. On opening an older project, the new editor parses existing `@图片N` and `@视频N` tokens into visible chips.

If an old prompt contains a token that cannot resolve to current connected media, the token is removed during reconciliation rather than being rebound to an unrelated project asset.

No project schema migration is required unless implementation proves that connected asset identity cannot be preserved during renumbering. If identity metadata is needed, it must remain backward compatible and be covered by serialization tests.

## Error Handling

- Invalid or stale mention tokens never enter model execution.
- Missing connected asset metadata produces no picker entry and no preview.
- IME composition is not serialized until composition completes.
- Photoshop bridge exceptions map to the existing safe `placement_failed` message.
- Photoshop errors remain visible until the user retries, closes the menu, or selects another action.

## Test Strategy

Tests are written before production changes.

### Unit and component tests

- parse and serialize mixed text, image chips, video chips, whitespace, and new lines;
- preserve canonical values while hiding `@` in visible chips;
- reconcile mentions against ordered connected media;
- remove disconnected references and renumber remaining media safely;
- ensure node pickers and preview maps contain only connected assets;
- verify Photoshop busy, success, error, and retry states;
- verify only structurally unsupported Photoshop actions are disabled.

### Browser and desktop acceptance

- insert several chips and type after each; the visible text and caret remain adjacent with no cumulative drift;
- exercise Chinese IME, paste, Backspace, Delete, arrow navigation, and multiline input;
- connect one asset while other project assets exist; only the connected asset appears;
- disconnect an asset; its chip disappears and execution no longer includes it;
- capture light- and dark-theme screenshots of the reference chips and Photoshop menu;
- verify Photoshop mocked success, not-running, no-document, and retry flows;
- run the focused suites, full Vitest suite, typecheck, build, and packaged desktop smoke test.

## Release Boundary

After all verification passes, build a new Windows installer with a version greater than `1.6.40`. Do not install it over the user's formal application, close the user's running application, or modify formal user data without separate explicit authorization.
