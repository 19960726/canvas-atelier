# Novus Atelier Professional Workbench UI and Node Design

Date: 2026-07-17
Status: User-approved visual direction 1

## Goal

Refine the existing Novus Atelier canvas into a professional, restrained desktop creative workstation without changing its workflows, state contracts, persistence semantics, or Agent behavior. The result must improve hierarchy, node readability, visual confidence, and repeated-use ergonomics while preserving smooth canvas performance on the Legacy and Modern runtime profiles.

## Scope

This pass covers:

- top bar and left tool rail visual hierarchy
- infinite-canvas background, controls, selection, and context display
- all visible canvas node families and ghost-plan nodes
- Agent panel header, tabs, status sections, composer, and model routing controls
- placement workbench header, board stage, inspector, and object selection treatment
- job strip status hierarchy
- consistent focus, hover, selected, disabled, loading, warning, and error states

This pass does not change:

- project schema, Agent memory, model routing logic, provider behavior, or Skill approval rules
- node creation, deletion, transaction, undo, autosave, recovery, or durable ACK behavior
- layout dimensions required by the accepted desktop shell
- packaging, portable delivery, Windows 7/11 manual evidence, or the pending Figma editable gate

## Design Direction

Use a light, high-density professional editor shell. Neutral surfaces carry structure; semantic colors carry meaning. Teal remains the primary action color but no longer dominates every state.

The visual character is:

- precise rather than decorative
- compact rather than marketing-oriented
- layered through borders, spacing, and typography rather than gradients or large shadows
- calm during repeated use
- visibly tailored to image generation, reference analysis, placement, and Agent planning

Do not copy CanvasForge source, UI, assets, secrets, branding, or proprietary interaction patterns.

## Stable Shell Geometry

Preserve the accepted layout geometry:

- top bar: 44 px
- left rail: 48 px
- Agent panel: 360 px desktop, existing responsive reduction below 900 px
- job strip: 36 px
- placement workbench: existing full canvas inset and 46 px internal header

Controls must not resize or shift when labels, loading states, selection, or job status changes.

## Visual Tokens

Base palette:

- app canvas: `#edf1f3`
- primary surface: `#ffffff`
- secondary surface: `#f6f8f9`
- elevated surface: `#fbfcfd`
- primary text: `#17212b`
- secondary text: `#53616c`
- muted text: `#7a8791`
- default border: `#d5dde3`
- strong border: `#aeb9c2`
- primary accent: `#0f766e`
- accent soft: `#e1f3f0`
- plan blue: `#2563eb`
- reference amber: `#b45309`
- destructive/error: `#b42318`
- success: `#16865f`

Use Segoe UI with Microsoft YaHei UI fallback. Keep letter spacing at zero. Avoid gradients, blur-heavy effects, decorative orbs, oversized radii, and one-color teal treatment.

Radii remain restrained:

- compact controls: 4-5 px
- panels and node bodies: 6-7 px
- no pill controls except true status tokens

## Top Bar and Tool Rail

Top bar:

- strengthen the separation between product identity, project navigation, history controls, provider status, and run action
- keep the product mark compact and first-viewport visible
- use icon buttons for undo, redo, fit, panel controls, and other familiar actions
- improve disabled and keyboard-focus visibility without adding instructional text
- keep provider state readable but visually secondary to Run Plan

Tool rail:

- retain 36 px icon buttons inside the 48 px rail
- add a stable active-state indicator and clearer selected surface
- use Lucide icons already present in the application
- preserve tooltips through title and accessible labels
- keep all hit areas stable and avoid animation that changes layout

## Canvas Surface

The canvas remains visually quiet so nodes and connections dominate.

- use a lower-contrast dot grid with consistent zoom behavior
- restyle controls and minimap as compact editor utilities, not floating cards
- improve the bottom canvas context readout for mode and zoom scanning
- selected edges and Agent ghost edges must remain clearly distinguishable
- interaction-low-quality mode removes expensive shadows exactly as it does today

No additional persistence or store updates may occur on pointermove.

## Node System

### Shared Node Frame

Each node uses a stable width and content layout so dynamic labels do not resize the graph unexpectedly.

Shared anatomy:

1. 3 px semantic type rail or equivalent fixed accent edge
2. 28 px type icon area
3. title and compact type label
4. content preview or summary
5. metadata/status footer
6. fixed connection-handle positions

Recommended default size:

- width: 232-240 px
- minimum height: 92 px
- internal padding: 12 px
- title: 12 px semibold
- metadata: 9-10 px

### Node Families

- Prompt node: prompt excerpt, reference count, active model route, and readiness status.
- Placement preview node: compact 4:5 board thumbnail, object count, and selected layout state.
- Image result node: real result thumbnail when available, model route, completion state, and durable asset label.
- Agent plan/ghost node: blue dashed edge treatment, reduced opacity, clear Pending Plan status, and no false committed appearance.
- Utility/text nodes: concise type icon, title, and metadata without empty decorative regions.

### Node States

- default: strong readable border with minimal shadow
- hover: border emphasis only; no size movement
- selected: accent border plus a restrained 2 px outer focus ring
- keyboard focus: visible focus ring independent from mouse selection
- disabled/unavailable: reduced contrast while preserving readable text
- error: semantic red edge/status, never a full red card
- running: fixed status indicator; avoid continuous expensive animation
- ghost: dashed plan-blue border and soft blue surface

Handles remain physically stable. They may increase visual prominence on hover/selection but cannot change graph geometry.

## Agent Panel

The Agent panel remains one conversation across GPT Image and Nano Banana 2 routes.

Refinement goals:

- clearer header hierarchy for Agent name, loaded Skill count, and collapse action
- tabs read as a compact desktop segmented navigation line, not separate cards
- reference order, reverse analysis, conversation, plan, and memory sections have consistent section headers and dividers
- replace concatenated or visually broken sync text with a structured status row
- keep model route controls adjacent to the composer and clearly show the active route
- make confirmation requirements visible through state and button treatment, without adding tutorial copy
- keep composer controls fixed when route labels or errors change

The memory and Skill review views may remain dark if their contrast and section hierarchy are made consistent with the light shell; they must not feel like an unrelated application.

## Placement Workbench

- make the workbench header read as an editor sub-workspace with title, aspect ratio, upload error, and close command
- improve separation between board stage and inspector without nesting cards
- keep the 4:5 board centered and stable at all tested viewports
- clarify safe-area and rule-of-thirds guides
- selected objects receive stronger handles, rotation affordance, role color, and readable name label
- upload role slots use semantic color and icons while retaining exact file input behavior
- inspector groups name, role, transform, visibility, lock, and layer actions through spacing and dividers
- preserve commit-on-stable-interaction behavior and never persist every pointermove

## Job Strip

- keep the 36 px fixed height
- strengthen label, running count, job model, and action hierarchy
- show save state only after durable ACK
- keep error and retry states readable without expanding the strip
- ensure long model/error labels truncate without moving controls

## Motion and Performance

- use transitions only for color, border, and opacity, normally 100-160 ms
- no layout animation, animated blur, large shadow animation, or continuous decorative motion
- preserve viewport culling and interaction quality downgrade
- preserve stable node dimensions and toolbar dimensions
- avoid new React state during pan, zoom, pointermove, or node hover when CSS can express the state

## Accessibility

- maintain WCAG-oriented contrast for text and controls
- visible `:focus-visible` treatment on every interactive element
- icon-only controls retain accessible labels and titles
- minimum practical desktop target remains 30 px, with primary rail controls at 36 px
- color is never the only indication of selected, error, running, or disabled state
- tab keyboard behavior and existing ARIA roles remain intact

## Implementation Boundaries

Prefer CSS token and component-class changes over state or domain changes. Keep edits focused to renderer styles and node presentation components. Add a small presentation helper only when it removes real duplication across node types.

Do not refactor the large CanvasWorkspace state flow as part of this visual pass.

## Verification

Required automated evidence:

- focused renderer component tests for node anatomy and required status labels
- existing canvas workspace interaction tests remain green
- existing Agent, reference order, placement, and job tests remain green
- Playwright visual-layout tests at 1440x900, 1920x1080, and 1366x768
- no overlap among top bar, tool rail, canvas/workbench, Agent panel, and job strip
- no blank canvas or white-screen state
- pan/zoom performance marks remain within the accepted conservative threshold
- screenshots captured after implementation and visually inspected for text clipping, node overlap, inconsistent states, and unreadable controls

Root typecheck and renderer build must pass. Full repository verification remains required before release packaging.

## External Gate

A Figma file exists at key `OX4ARPlzEa0gYuEX8xN4Md`, but editable-frame creation remains pending because the connected Starter plan has exhausted its Figma MCP quota. Runtime screenshots are not a substitute for that editable delivery gate.