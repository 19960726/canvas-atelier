import type { ExecutionReferenceSnapshot, OrderedReference } from '@agent-canvas/domain';

export function createExecutionReferenceSnapshot(
  input: readonly OrderedReference[],
  projectRevision: number,
): ExecutionReferenceSnapshot {
  if (!Number.isInteger(projectRevision) || projectRevision < 0) {
    throw new Error('Execution reference snapshot revision must be a non-negative integer');
  }
  const references = [...input]
    .sort((left, right) => left.position - right.position)
    .map((reference, position) => Object.freeze({ ...reference, position }));
  const frozenReferences = Object.freeze(references);
  return Object.freeze({
    schemaVersion: 1 as const,
    projectRevision,
    fingerprint: fingerprintReferences(frozenReferences),
    references: frozenReferences,
  });
}

function fingerprintReferences(references: readonly Readonly<OrderedReference>[]): string {
  const canonical = JSON.stringify(references.map((reference) => ({
    assetId: reference.assetId,
    label: reference.label,
    position: reference.position,
    role: reference.role,
    ...(reference.weight === undefined ? {} : { weight: reference.weight }),
  })));
  return `${fnv1a(canonical, 0x811c9dc5)}${fnv1a(canonical, 0x9e3779b9)}`;
}

function fnv1a(value: string, seed: number): string {
  let hash = seed >>> 0;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}
