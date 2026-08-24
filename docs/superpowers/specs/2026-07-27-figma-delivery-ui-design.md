# Figma Delivery UI Design

## Goal

Replace the remaining legacy workspace surfaces with the supplied Figma Delivery references in both light and dark themes, while retaining the existing desktop bridge actions.

## Surfaces

- Knowledge selection: 396px right panel; searchable, filterable multi-select list and selected-context summary.
- Generation history: centered wide modal with chronological image grid and retained record actions.
- Settings: 396px right panel with API, storage, guide, and sync tabs; storage and sync match the supplied states.
- Generated-image context menu: anchored menu with Agent, canvas, Photoshop, copy, and download actions.

## Visual system

All workspace colors use semantic tokens. `data-theme=light` uses the supplied pale canvas and white cards; `data-theme=dark` uses the supplied charcoal canvas and slate cards. No component may hard-code a dark surface that survives light theme selection.

## Behaviour

Existing API configuration, cache cleanup, update checking, history export/reuse/trash, and agent/canvas delivery actions remain connected to their present handlers. The redesign changes presentation and navigation, not storage formats or network APIs.

## Acceptance

- Each supplied state has matching dark and light screenshots at 1440×900.
- Light mode changes canvas, panels, controls, and overlays—not only the theme selector.
- Existing component and E2E tests continue to pass; a release visual audit captures every surface.
