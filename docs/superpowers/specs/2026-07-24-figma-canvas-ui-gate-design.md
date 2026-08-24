# Canvas UI Gate Design

**Approved reference:** Figma file `Novus Atelier Canvas MVP UI Gate`, node `9:2`; primary desktop frame `9:5` (1440×900).

## Scope

This slice aligns the running desktop canvas shell to the approved dark UI Gate without changing canvas, persistence, model, Agent, settings, or history behavior. Settings and history remain available from the tool rail but are not visually rebuilt in this slice.

## Layout

- The workspace has a 56px top bar and a dark, uninterrupted canvas below it.
- The tool rail is a floating 48px-wide vertical control group inside the canvas at the upper-left, rather than a permanent grid column.
- Opening Agent shows a 376px-wide, rounded Skill Chat workbench inset from the right and top edges. Its existing Conversation, Plan, and Memory content remains keyboard-accessible.
- Canvas nodes, module library, and existing overlays retain their behavior. They sit below the floating controls and Agent workbench in the stacking order.

## Visual system

- Use a charcoal canvas, slightly lighter chrome and panels, restrained 1px borders, 12–16px rounding, and cyan as the primary interactive accent.
- Use violet only for Agent/connection emphasis. Preserve status semantics and accessible labels; do not use color as the only state indicator.
- Keep the Figma hierarchy: brand/project at left, compact canvas controls centered, theme/model/run actions at right.

## Responsive behavior

At compact widths the canvas remains usable: the Agent panel may overlay the canvas and the module library closes before Agent opens, as the current behavior already requires. No content is removed from the DOM merely for visual alignment.

## Verification

Add a CanvasWorkspace UI contract test for the Figma shell classes and accessible Agent workbench. Then run the focused test, typecheck, test suite, and desktop e2e after the styling change.
