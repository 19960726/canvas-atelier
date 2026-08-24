# Canvas browser acceptance interactions

Date: 2026-08-08

## Goal

Make the browser-delivered manual acceptance page exercise the same visible interaction contract as the desktop canvas without weakening desktop security or replacing native behavior. Fix the reported generation controls, storage settings, Agent composer, and connected-media slot presentation.

## Scope

### Browser acceptance bridge

- Activate only for the explicit manual acceptance URL/query mode.
- Supply non-secret sample provider profiles for chat, image, reverse, and video routes.
- Simulate cache directory open/choose/reset and cache cleanup state without writing outside the browser session.
- Keep Electron builds on the real `window.novusDesktop` preload bridge.
- Never persist or expose an API key in the browser acceptance bridge.

### Image and video generation controls

- Image resolution offers `1K`, `2K`, and `4K` and changes selection immediately.
- Image and video model controls expose configured route lists and allow changing the active route.
- Video generation retains its existing duration, aspect ratio, resolution, quantity, prompt, and generate controls.
- Control labels, symbols, and selected values remain centered in light and dark themes.

### Storage and backup

- Open, choose custom path, reset path, refresh, and cache cleanup actions respond in acceptance mode.
- Each action exposes busy/success/error feedback.
- Desktop mode continues to invoke the native storage bridge and real directory picker.

### Agent composer

- The plus button imports a managed reference image and immediately adds its thumbnail/reference token.
- Knowledge and model controls remain below the composer and open transient panels.
- The submit button is a single centered paper-plane icon with no extra counter or character.
- Disabled state explains missing prompt/model instead of appearing broken.

### Connected media slots

- Image slots display a small complete thumbnail using `object-fit: contain` and preserve the source ratio.
- Video slots display the managed poster/first-frame thumbnail when available, falling back to a video icon only when no poster can be resolved.
- Image generation, video generation, reverse Agent, and Agent chat use the same 32px thumbnail contract.
- Connected assets appear immediately and preserve drag-reorder behavior.

## Data flow

1. Acceptance mode installs a narrow browser bridge before application initialization.
2. Existing provider/settings stores read the bridge through the same contract used by Electron.
3. Generation nodes derive compatible routes from enabled provider profiles.
4. Connected edge data resolves managed image/video assets into ordered thumbnail items.
5. UI actions update the existing store or bridge state and render visible feedback.

## Error handling

- Cancelled file/folder selection keeps the previous value.
- Missing thumbnails show a neutral media icon rather than a broken image.
- Unsupported model capabilities are filtered from each selector.
- Acceptance-only bridge failures display inline errors and do not affect desktop behavior.

## Verification

- Unit tests reproduce each reported inactive control before implementation.
- Component tests verify model/resolution selection, Agent import/send layout, and slot thumbnails.
- Settings tests verify browser acceptance and native desktop paths separately.
- Playwright covers light/dark themes, connected image/video slots, and manual acceptance interactions.
- Full typecheck and focused regression suites must pass before the test link is handed back.

## Non-goals

- The browser acceptance bridge does not call paid generation APIs.
- It does not emulate filesystem persistence beyond the current browser session.
- It does not alter API-key storage or Electron preload security boundaries.