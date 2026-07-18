import { describe, expect, it } from 'vitest';
import type { OrderedReference } from '@agent-canvas/domain';

import { createExecutionReferenceSnapshot } from './execution-reference-snapshot';

const references: OrderedReference[] = [
  { assetId: 'product', label: '产品主图 / Product hero', role: 'product_identity', position: 0 },
  { assetId: 'scene', label: '场景构图 / Scene composition', role: 'scene_composition', position: 1 },
];

describe('execution reference snapshots', () => {
  it('freezes one ordered run snapshot with revision and fingerprint identity', () => {
    const snapshot = createExecutionReferenceSnapshot(references, 17);

    references.reverse();
    references[0]!.label = 'mutated live label';

    expect(snapshot).toMatchObject({
      schemaVersion: 1,
      projectRevision: 17,
      references: [
        { assetId: 'product', position: 0, role: 'product_identity' },
        { assetId: 'scene', position: 1, role: 'scene_composition' },
      ],
    });
    expect(snapshot.fingerprint).toMatch(/^[a-f0-9]{16}$/u);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.references)).toBe(true);
    expect(Object.isFrozen(snapshot.references[0])).toBe(true);
  });

  it('keeps the same input fingerprint across reruns while recording each project revision', () => {
    const first = createExecutionReferenceSnapshot([...references].reverse(), 18);
    const second = createExecutionReferenceSnapshot([...references].reverse(), 29);

    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.projectRevision).toBe(18);
    expect(second.projectRevision).toBe(29);
  });
});
