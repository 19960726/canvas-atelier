import { describe, expect, it } from 'vitest';
import { createKnowledgeSnapshotCandidate } from './knowledge-snapshot';
import { KnowledgeSnapshotRegistry, type KnowledgeBaseState } from './knowledge-registry';

const publishedAt = '2026-07-15T08:00:00.000Z';
const republishedAt = '2026-07-15T08:05:00.000Z';
const failedAt = '2026-07-15T08:10:00.000Z';
const rolledBackAt = '2026-07-15T08:15:00.000Z';

describe('KnowledgeSnapshotRegistry', () => {
  it('publishes and deduplicates the same content hash', () => {
    const registry = new KnowledgeSnapshotRegistry();
    const candidate = createCandidate('# memory');

    const first = registry.publish(candidate, { publishedAt, sourceDeviceId: 'device-a' });
    const duplicate = registry.publish(candidate, { publishedAt: republishedAt, sourceDeviceId: 'device-a' });

    expect(first.version).toBe(1);
    expect(duplicate).toEqual(first);
    expect(registry.listVersions('scene-skill')).toHaveLength(1);
    expect(registry.getActive('scene-skill')).toEqual(first);
  });

  it('keeps known-good state after failure and rolls back', () => {
    const registry = seededRegistry();

    registry.recordRefreshFailure('scene-skill', 'invalid schema', failedAt);

    expect(registry.getState('scene-skill')).toMatchObject({
      status: 'fallback',
      active: { version: 2 },
      lastFailure: { reason: 'invalid schema', failedAt },
    });

    expect(registry.rollback('scene-skill', 1, rolledBackAt)).toMatchObject({
      status: 'active',
      active: { version: 1 },
      lastRollbackAt: rolledBackAt,
    });
    expect(registry.listVersions('scene-skill').map((snapshot) => snapshot.version)).toEqual([1, 2]);
  });

  it('returns immutable clones from every read surface', () => {
    const registry = seededRegistry();
    const active = registry.getActive('scene-skill');
    const versions = registry.listVersions('scene-skill');
    const state = registry.getState('scene-skill');
    const summary = registry.getSummary('scene-skill');

    if (!active) throw new Error('expected active snapshot');

    active.documents[0]!.content = '# changed';
    versions[0]!.documents[0]!.relativePath = 'memory/mutated.md';
    state.versions[1]!.documents[0]!.sha256 = '0'.repeat(64);
    summary.versions[0]!.displayName = 'Mutated';

    expect(registry.getActive('scene-skill')?.documents[0]?.content).toBe('# updated');
    expect(registry.listVersions('scene-skill')[0]?.documents[0]?.relativePath).toBe('memory/main.md');
    expect(registry.getState('scene-skill').versions[1]?.documents[0]?.sha256).not.toBe('0'.repeat(64));
    expect(registry.getSummary('scene-skill')).toMatchObject({
      activeVersion: 2,
      versionCount: 2,
      versions: [
        { version: 1, displayName: 'Scene Skill' },
        { version: 2, displayName: 'Scene Skill' },
      ],
    });
    expect(JSON.stringify(registry.getSummary('scene-skill'))).not.toContain('memory/main.md');
    expect(JSON.stringify(registry.getSummary('scene-skill'))).not.toContain('# updated');
  });

  it('rejects duplicate knowledge-base ids and duplicate published versions when seeded', () => {
    const state = seededRegistry().getState('scene-skill');

    expect(() => new KnowledgeSnapshotRegistry([state, state])).toThrow(/knowledge base/i);
    expect(() => new KnowledgeSnapshotRegistry([{
      ...state,
      active: state.versions[0] ?? null,
      versions: [
        state.versions[0]!,
        { ...state.versions[0]! },
      ],
    }])).toThrow(/version/i);
  });
});

function createCandidate(content: string) {
  return createKnowledgeSnapshotCandidate({
    knowledgeBaseId: 'scene-skill',
    displayName: 'Scene Skill',
    documents: [{ relativePath: 'memory/main.md', content }],
  });
}

function seededRegistry(): KnowledgeSnapshotRegistry {
  const registry = new KnowledgeSnapshotRegistry();
  registry.publish(createCandidate('# memory'), { publishedAt, sourceDeviceId: 'device-a' });
  registry.publish(createCandidate('# updated'), { publishedAt: republishedAt, sourceDeviceId: 'device-a' });
  return registry;
}
