# Media Playback and Photoshop Diagnostics Design

## Goal

Make a saved-canvas MP4 player receive native playback input, expose the real
Photoshop automation-connection failure, and retain enough prompt provenance
to distinguish provider output from a verified semantic match.

## Scope

- The video generation result's decorative play glyph is presentation only and
  must never intercept pointer input intended for the native video element.
- The Windows Photoshop runner reports an unavailable COM automation instance
  distinctly from an active-document or placement failure. The renderer shows
  a concrete recovery message for that result.
- Generation history continues to preserve the submitted prompt and provider
  task identity. This work does not claim or implement semantic verification,
  provider retry, or paid result inspection.

## Constraints

- Do not modify saved project data or submit new provider requests.
- Keep the existing `novus-asset` MP4 stream protocol unchanged.
- Preserve Photoshop CS6-and-newer support and existing active-document checks.
- Add regression tests before implementation and run focused suites before any
  broader verification.

## Acceptance

1. A click at the visual play glyph reaches the native `<video controls>`.
2. COM `0x800401E3` is reported as an automation connection failure, not as
   "please open PSD" or generic placement failure.
3. The UI states that prompt submission is recorded but output relevance is
   not verified automatically.
