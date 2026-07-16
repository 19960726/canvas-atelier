import type { RecoveryPlanBridgeResult } from '@agent-canvas/desktop-core';
import { parseCanvasProject, type CanvasProject } from '@agent-canvas/domain';

export function validateRecoveredProject(candidate: unknown, fallback: CanvasProject): CanvasProject {
  try {
    parseCanvasProject(candidate);
    return candidate as CanvasProject;
  } catch {
    return fallback;
  }
}

export function selectDurableRecoverySnapshotIds(plan: RecoveryPlanBridgeResult): string[] {
  return plan.candidates
    .filter((candidate) => candidate.tailStatus === 'complete')
    .map((candidate) => candidate.snapshotId);
}

export function findDurableRecoveryCandidate(
  plan: RecoveryPlanBridgeResult,
  snapshotId: string,
) {
  return plan.candidates.find((candidate) => (
    candidate.snapshotId === snapshotId && candidate.tailStatus === 'complete'
  ));
}
