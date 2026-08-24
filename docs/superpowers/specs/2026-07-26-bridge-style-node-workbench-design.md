# Bridge-style Canvas Node Workbench

## Goal

Unify every canvas node with the approved bridge-style image-generation reference while preserving the Figma Canvas UI Gate shell and all existing node behavior.

## Visual rules

- Keep the dark dotted canvas, 56px top bar, floating tool rail, and Agent drawer from Figma UI Gate.
- Use the same 530px workbench card geometry for image generation and reverse-agent nodes.
- Use shared spacing, border radius, muted borders, teal active states, and dark inset fields.
- Image generation order: header, result preview, prompt, reference slots (0–20), aspect-ratio controls, model/quality/count controls, generate action, result status, advanced parameters.
- Reverse-agent order: header, media slots (0–20), language model, role, task, knowledge base, action buttons, independent result panel.
- Keep all connected ports, drag/drop, uploads, model routing, persistence, and execution states unchanged.

## Acceptance

- Both node types render with the shared visual language at desktop and narrow widths.
- Reference slots remain square and show linked images; empty slots remain usable.
- Existing renderer tests, typecheck, build, and focused E2E layout tests continue to pass.
