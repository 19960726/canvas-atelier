# Canvas Atelier settings and generation node design QA

final result: passed

## Compared states

- User references: the earlier plain stacked model catalog, basic connection/update buttons, RelayMe key-oriented copy, and collapsed image-generation node shown in the supplied screenshots.
- Current captures: `artifacts/2026-08-08-multi-provider/model-catalog-light.png`, `settings-light.png`, `model-catalog-dark.png`, `settings-dark.png`, and `artifacts/2026-08-28-generation-retry/generation-retry-light.png`.
- Interaction gate: a collapsed image-generation node was dragged 120 px horizontally and 70 px vertically from its preview surface. Its persisted coordinates changed within the expected range, its React Flow measurements survived the durable commit, and its editor remained collapsed after pointer release.

## Findings

- P0: none.
- P1: none.
- P2: none.
- P3: the full settings drawer remains intentionally scrollable when all provider controls and the model catalog are shown together.

## Acceptance notes

- The model catalog now uses capability tabs, real icons, visible per-capability counts, a focused active workspace, two-column model cards, and a clearly separated default-model selector.
- RelayMe is presented as account login/token routing and does not expose an independent hidden API-key control.
- Connection and update actions use the same teal primary-action language as the canvas.
- Failed generation presents a visible enabled retry action.
- Light and dark catalog states render without clipping, overlap, or browser-console application errors.
