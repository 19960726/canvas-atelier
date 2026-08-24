import type { CanvasProject, ProjectTransaction } from '@agent-canvas/domain';
import type {
  BuildResultMaterialization,
  ResultMaterializationCommit,
} from '../jobs/job-store';

export interface CommitGeneratedResultInput {
  readonly build: BuildResultMaterialization;
  readonly canContinue: () => Promise<boolean>;
  readonly commit: (transaction: ProjectTransaction) => Promise<boolean>;
  readonly getLocalProject: () => CanvasProject;
  readonly reloadDurableProject: () => Promise<{ project: CanvasProject; revision: number } | null>;
  readonly adoptRefreshedProject: (project: CanvasProject, revision: number) => void;
}

export function mergeGeneratedAssetRevision(
  local: CanvasProject,
  durable: CanvasProject,
): CanvasProject {
  if (local.id !== durable.id) throw new Error('Generated result project changed');
  const assets = new Map((local.assets ?? []).map((asset) => [asset.assetId, asset]));
  for (const asset of durable.assets ?? []) assets.set(asset.assetId, asset);
  return { ...local, assets: [...assets.values()] };
}

export async function commitGeneratedResultWithRefresh(
  input: CommitGeneratedResultInput,
): Promise<ResultMaterializationCommit> {
  let lastResultNodeId = '';
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) {
      if (!await input.canContinue()) return { committed: false, resultNodeId: lastResultNodeId };
      const refreshed = await input.reloadDurableProject();
      if (refreshed === null) return { committed: false, resultNodeId: lastResultNodeId };
      if (!await input.canContinue()) return { committed: false, resultNodeId: lastResultNodeId };
      input.adoptRefreshedProject(
        mergeGeneratedAssetRevision(input.getLocalProject(), refreshed.project),
        refreshed.revision,
      );
    }
    const materialized = input.build(input.getLocalProject());
    lastResultNodeId = materialized.resultNodeId;
    if (!await input.canContinue()) return { committed: false, resultNodeId: lastResultNodeId };
    if (await input.commit(materialized.transaction)) {
      if (!await input.canContinue()) return { committed: false, resultNodeId: lastResultNodeId };
      return { committed: true, resultNodeId: lastResultNodeId };
    }
  }
  return { committed: false, resultNodeId: lastResultNodeId };
}
