# Canvas reliability, video results, models, and interaction performance

Date: 2026-08-08

## Goal

Restore a reliable manual-test canvas where opening history cannot blank the application, connected video references remain separate from generated results, model selectors reflect real Comfly account models, Agent capability errors appear only after an incompatible media action, settings use the approved compact visual system, and common canvas interactions remain responsive.

## Confirmed behavior

### Generation history

- Clicking the left-rail history button always opens a visible history surface.
- An unavailable or incomplete browser/desktop history bridge renders a controlled empty or unavailable state; it never throws during component mount.
- No records renders an explicit empty history panel rather than an empty page.
- Generated records display their real date, thumbnail, model, status, and available actions.

### Video reference slots and results

- Media connected to a video-generation node appears in the shared media-slot row above the expanded prompt.
- Connected reference media is input context and is never treated as a generated video result.
- The result gallery is derived only from completed video result records.
- One completed video renders one preview; two render two previews; three render three previews; four render a four-item grid.
- A single poster or reference frame must never be duplicated to simulate the requested output count.
- Before any completed result exists, no empty result window or placeholder grid is rendered.

### Models

- Comfly model identifiers come from the configured account response; the application does not invent model names.
- Models are classified into image generation, video generation, reverse/vision language, and Agent chat groups by supported capabilities.
- Settings allows users to enable account-visible models and choose a default for each supported group.
- Saved profiles update the selectors in image generation, video generation, reverse Agent, and Agent chat.
- Missing credentials, locked credentials, an unavailable endpoint, and an empty model response each have a distinct controlled status.

### Agent media capability feedback

- Opening an empty Agent conversation does not show an image/video capability error.
- Text-only conversation remains usable with a text model.
- The visual-model warning appears only when the user tries to add, paste, mention, or send media with a model that lacks the required capability.
- Switching to a compatible visual model clears the stale capability warning.

### Settings diagnostics

- The advanced diagnostics area uses the same compact typography, spacing, surfaces, input height, and centered button geometry as the rest of settings.
- Legacy large-card rules cannot override the current Figma UI Gate styling.
- Connection checking reports checking, connected, authentication failure, network failure, or service limitation without exposing secrets.

### Canvas performance

- Pan and zoom viewport publication is coalesced to at most one React state update per animation frame.
- Repeated pointer movement does not recreate expensive canvas-wide objects unnecessarily.
- Node position changes remain local draft state while dragging and persist only after drag completion.
- During active interaction, expensive shadows and media rendering work are reduced without hiding nodes or changing their geometry.
- Viewport culling keeps selected nodes, active connections, result nodes, and adjacent nodes available while excluding off-screen inactive content.

## Architecture

1. Add capability guards around optional history bridge methods and expose an explicit history availability state.
2. Represent video results as a list of completed result items independent from reference media and requested output count.
3. Keep provider model discovery, model classification, saved profiles, and node selectors as one end-to-end data flow.
4. Make Agent errors action-derived rather than inferred merely from the selected model.
5. Consolidate final settings rules under scoped UI Gate selectors.
6. Coalesce viewport updates with `requestAnimationFrame` and preserve stable memoized inputs across canvas interaction frames.

## Error handling

- Optional bridge functions are checked before invocation.
- Rejected history/model requests are caught and rendered as local status UI.
- Invalid or missing result media is omitted instead of rendering a broken preview.
- Secret values, filesystem paths, binary media, and base64 payloads are not written into model profiles or history requests.

## Verification

- Component regression test: incomplete history bridge opens a controlled panel without unmounting the workspace.
- Component regression tests: video preview count equals actual completed result count for zero through four results.
- Component regression test: connected video/image references appear only in input slots before generation.
- Component regression tests: model groups and defaults propagate to all four selectors.
- Component regression tests: Agent warning is absent initially and appears only after an incompatible media action.
- Settings screenshot tests cover compact diagnostics in light and dark themes.
- Interaction tests verify animation-frame viewport coalescing and stable node-drag commits.
- Browser acceptance test clicks history, switches models, connects media, generates one/four video results, and exercises pan, zoom, drag, and selection without page errors.
- Typecheck and focused Vitest/Playwright suites must pass before a new manual-test link is delivered.

## Non-goals

- The browser acceptance harness will not call paid generation APIs.
- No model identifier will be fabricated when the Comfly account cannot be queried.
- This change will not rewrite the entire React Flow canvas or package an installer.