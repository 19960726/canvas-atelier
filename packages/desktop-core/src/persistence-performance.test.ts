import { performance } from 'node:perf_hooks';

import type { CanvasProject } from '@agent-canvas/domain';
import { describe, expect, it } from 'vitest';

import { JOURNAL_SCHEMA_VERSION, type JournalRecord } from './contracts';
import { replayJournal } from './journal-writer';

const starterProject: CanvasProject = {
  version: 1,
  id: 'performance-project',
  name: 'Persistence Performance',
  nodes: [],
  edges: [],
  projectMemory: [],
  skillPromotionCandidates: [],
};

describe.skipIf(process.env.NOVUS_RUN_PERSISTENCE_PERF !== '1')(
  'desktop persistence performance',
  () => {
    it('replays 10,000 lightweight transactions within the modern budget', () => {
      const started = performance.now();
      const result = replayJournal(starterProject, 0, createTransactions(10_000));
      const elapsedMs = performance.now() - started;

      expect(result.revision).toBe(10_000);
      expect(elapsedMs).toBeLessThan(1_000);
      console.info(`persistence replay: ${elapsedMs.toFixed(1)} ms for 10,000 transactions`);
    });
  },
);

function createTransactions(count: number): JournalRecord[] {
  return Array.from({ length: count }, (_, index) => {
    const revision = index + 1;
    return {
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      projectId: starterProject.id,
      sequence: revision,
      revision,
      transactionId: `perf-${revision}`,
      committedAt: '2026-07-15T00:00:00.000Z',
      kind: 'system',
      label: `performance transaction ${revision}`,
      operations: [{ kind: 'set_skill_candidates', candidates: [] }],
      payloadSha256: '0'.repeat(64),
    };
  });
}
