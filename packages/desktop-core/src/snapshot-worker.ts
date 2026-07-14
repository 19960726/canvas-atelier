import { parseCanvasProject, type CanvasProject } from '@agent-canvas/domain';

import { canonicalJson, sha256Canonical } from './canonical-json.js';
import { type JournalRecord, type SnapshotEnvelope } from './contracts.js';
import { createPersistenceError, replayJournal } from './journal-writer.js';

export interface SnapshotWorkerInput {
  readonly snapshot: SnapshotEnvelope;
  readonly records: readonly JournalRecord[];
  readonly targetRevision: number;
}

export interface SnapshotWorkerOutput {
  readonly projectJson: string;
  readonly projectSha256: string;
  readonly revision: number;
}

export async function buildSnapshotProject(
  input: SnapshotWorkerInput,
): Promise<SnapshotWorkerOutput> {
  let project: CanvasProject;
  try {
    project = parseCanvasProject(input.snapshot.project);
  } catch (error) {
    throw createPersistenceError(
      'CORRUPT_SNAPSHOT',
      false,
      'Snapshot worker requires a valid CanvasProject snapshot',
      error,
    );
  }

  const replayed = replayJournal(project, input.snapshot.revision, input.records);
  if (replayed.revision !== input.targetRevision) {
    throw createPersistenceError(
      'CORRUPT_JOURNAL',
      false,
      'Snapshot worker replay did not reach the target revision',
    );
  }

  const projectJson = canonicalJson(replayed.project);
  return {
    projectJson,
    projectSha256: sha256Canonical(replayed.project),
    revision: replayed.revision,
  };
}
