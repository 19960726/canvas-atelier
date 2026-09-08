# Video Node Control Alignment Design

## Goal

Align the video-generation control row with the image-generation row and remove the custom play and fullscreen overlays from completed video previews without changing other node types.

## Scope

- Video-generation selectors, settings trigger, and run button use a shared 34px control height and centered baseline within the existing video-only control bar.
- Completed video previews keep native playback controls and click-to-play behavior.
- The custom center play button and custom fullscreen button are removed from expanded and collapsed video result previews.
- Image-generation controls, provider calls, persistence, result delivery, and MCP behavior remain unchanged.

## Verification

- Component tests assert the video-only control bar keeps its selectors and run button while custom play/fullscreen controls are absent.
- Existing image and video generation UI tests continue to pass.
- A fresh UI screenshot confirms the video control row is aligned and the video preview has no custom overlay controls.
