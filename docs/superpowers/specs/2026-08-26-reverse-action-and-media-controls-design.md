# Reverse Action And Media Controls Design

## Approved direction

- Keep the current reverse Agent node structure and Canvas Atelier visual language.
- Pin the bottom action area to the node with two equal columns: outlined `复制结果` and teal primary `开始反推`.
- Use 34px height, 9px radius, 10px gap, centered labels, and legible disabled states.
- Keep each media slot at 40px, but constrain its two reorder buttons to a 16px overlay inside that slot so adjacent slots cannot intercept clicks.
- Preserve drag reordering, keyboard focus, remove actions, execution logic, copy behavior, and paid-task confirmation behavior.

## Verification

- Source-level CSS contract tests must fail before the terminal rules are added.
- Component tests, renderer typecheck/build, focused Playwright reverse/media flows, and a real desktop screenshot must pass.
- No real paid reverse, image, or video provider request is submitted during QA.

