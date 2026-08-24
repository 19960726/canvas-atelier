import { open, rm } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';

import {
  containsProtectedHistoryValue,
  type GenerationHistoryParameterSummary,
  type GenerationHistoryRecord,
} from '@agent-canvas/domain';

import { AssetStore, type AssetMetadata } from './asset-store.js';
import { sha256Canonical } from './canonical-json.js';
import {
  GenerationHistoryStore,
  type GenerationHistoryProjectReferenceInput,
} from './generation-history-store.js';

const MAX_SERVICE_BATCH = 100;

export interface GenerationHistoryReusableSummary {
  readonly historyId: string;
  readonly parameters: GenerationHistoryParameterSummary;
  readonly promptSummary: string;
  readonly provider: GenerationHistoryRecord['provider'];
}

export interface GenerationHistoryComparisonDescriptor {
  readonly availability: GenerationHistoryRecord['output'] extends infer _T ? 'available' | 'missing' | 'corrupt' | 'none' : never;
  readonly createdAt: string;
  readonly favorite: boolean;
  readonly format: 'gif' | 'jpg' | 'png' | 'webp' | null;
  readonly height: number | null;
  readonly historyId: string;
  readonly project: GenerationHistoryRecord['project'];
  readonly provider: GenerationHistoryRecord['provider'];
  readonly status: GenerationHistoryRecord['status'];
  readonly tags: readonly string[];
  readonly width: number | null;
}

export interface GenerationHistoryProjectCopyResult {
  readonly copies: ReadonlyArray<{
    readonly historyId: string;
    readonly projectAssetId: string;
  }>;
}

export type GenerationHistoryExportResult =
  | {
    readonly status: 'cancelled' | 'completed';
    readonly exportedCount: number;
    readonly files: readonly GenerationHistoryExportFileSummary[];
  }
  | {
    readonly status: 'failed';
    readonly exportedCount: 0;
    readonly files: readonly GenerationHistoryExportFileSummary[];
    readonly failure: { readonly code: 'EXPORT_FAILED'; readonly message: 'History export failed' };
  };

export interface GenerationHistoryExportFileSummary {
  readonly byteSize: number;
  readonly fileName: string;
  readonly historyId: string;
}

export interface GenerationHistoryServiceOptions {
  readonly assetStore?: AssetStore;
  readonly store: GenerationHistoryStore;
}

export class GenerationHistoryService {
  private readonly assetStore: AssetStore;
  private readonly store: GenerationHistoryStore;

  constructor(options: GenerationHistoryServiceOptions) {
    this.assetStore = options.assetStore ?? new AssetStore();
    this.store = options.store;
  }

  async getReusableSummary(historyId: string): Promise<GenerationHistoryReusableSummary> {
    const record = (await this.store.getRecords([historyId]))[0]!;
    return Object.freeze({
      historyId: record.id,
      parameters: record.parameters,
      promptSummary: record.promptSummary,
      provider: record.provider,
    });
  }

  async compare(historyIds: readonly string[]): Promise<readonly GenerationHistoryComparisonDescriptor[]> {
    if (!Array.isArray(historyIds) || historyIds.length < 2 || historyIds.length > 20) {
      throw new Error('History comparison requires between two and twenty records');
    }
    const records = await this.store.getRecords(historyIds);
    if (records.some((record) => record.kind !== 'image')) {
      throw new Error('Image history comparison only accepts image records');
    }
    return Object.freeze(records.map((record) => Object.freeze({
      availability: record.output?.availability ?? 'none',
      createdAt: record.createdAt,
      favorite: record.favorite,
      format: record.output?.format === 'mp4' ? null : record.output?.format ?? null,
      height: record.output?.height ?? null,
      historyId: record.id,
      project: record.project,
      provider: record.provider,
      status: record.status,
      tags: record.tags,
      width: record.output?.width ?? null,
    })));
  }

  async copyToProject(input: {
    readonly commitProjectAsset?: (asset: AssetMetadata, record: GenerationHistoryRecord) => Promise<void>;
    readonly historyIds: readonly string[];
    readonly operationId: string;
    readonly projectDisplayLabel: string;
    readonly projectId: string;
    readonly projectRoot: string;
  }): Promise<GenerationHistoryProjectCopyResult> {
    const historyIds = parseServiceBatch(input.historyIds);
    assertSafeServiceIdentity(input.operationId, 'History copy operation id is invalid');
    assertSafeServiceIdentity(input.projectId, 'History copy project id is invalid');
    if (
      typeof input.projectDisplayLabel !== 'string'
      || input.projectDisplayLabel.trim().length < 1
      || input.projectDisplayLabel.length > 120
      || containsProtectedHistoryValue(input.projectDisplayLabel)
      || typeof input.projectRoot !== 'string'
      || !isAbsolute(input.projectRoot)
    ) {
      throw new Error('History copy project metadata is invalid');
    }
    await this.store.assertSeparatedLocation(input.projectRoot);

    const copies: Array<{ historyId: string; projectAssetId: string }> = [];
    for (const historyId of historyIds) {
      const copied = await this.store.withAvailableAsset(historyId, async ({ record, source }) => {
        if (record.output === null) throw new Error('History output is unavailable');
        const asset = await this.assetStore.stageAndCommit(input.projectRoot, source, {
          commitReference: input.commitProjectAsset === undefined
            ? undefined
            : (storedAsset) => input.commitProjectAsset!(storedAsset, record),
          expectedSha256: record.output.sha256,
          maxBytes: record.output.byteSize,
          mediaType: record.output.mediaType,
          originalName: `${record.id}.${record.output.format}`,
        });
        return { historyId, projectAssetId: asset.id };
      });
      const suffix = sha256Canonical({ operationId: input.operationId, historyId }).slice(0, 24);
      const reference: GenerationHistoryProjectReferenceInput = {
        referenceId: `reference_${suffix}`,
        projectId: input.projectId,
        projectDisplayLabel: input.projectDisplayLabel,
        independentProjectAssetId: copied.projectAssetId,
      };
      await this.store.addProjectReferences({
        historyId,
        operationId: `operation_copyref_${suffix}`,
        references: [reference],
      });
      copies.push(copied);
    }
    return Object.freeze({ copies: Object.freeze(copies) });
  }

  async exportSelected(input: {
    readonly chooseDestination: (files: readonly GenerationHistoryExportFileSummary[]) => Promise<string | null>;
    readonly historyIds: readonly string[];
  }): Promise<GenerationHistoryExportResult> {
    const createdPaths: string[] = [];
    try {
      const historyIds = parseServiceBatch(input.historyIds);
      if (typeof input.chooseDestination !== 'function') throw new Error('History export picker is invalid');
      const records = await this.store.getRecords(historyIds);
      const files = records.map((record): GenerationHistoryExportFileSummary => {
        if (record.output === null || record.output.availability !== 'available') {
          throw new Error('History original is unavailable');
        }
        return Object.freeze({
          historyId: record.id,
          fileName: `${record.id}.${record.output.format}`,
          byteSize: record.output.byteSize,
        });
      });
      const destination = await input.chooseDestination(Object.freeze(files));
      if (destination === null) {
        return Object.freeze({ status: 'cancelled', exportedCount: 0, files: Object.freeze([]) });
      }
      if (typeof destination !== 'string' || !isAbsolute(destination)) throw new Error('History export destination is invalid');
      await this.store.assertSeparatedLocation(destination);

      for (const file of files) {
        await this.store.withAvailableAsset(file.historyId, async ({ source }) => {
          const targetPath = join(destination, basename(file.fileName));
          const handle = await open(targetPath, 'wx');
          createdPaths.push(targetPath);
          let closed = false;
          try {
            for await (const chunk of source as AsyncIterable<Uint8Array>) {
              await handle.write(Buffer.from(chunk));
            }
            await handle.sync();
            await handle.close();
            closed = true;
          } finally {
            if (!closed) await handle.close().catch(() => undefined);
          }
        });
      }
      return Object.freeze({
        status: 'completed',
        exportedCount: files.length,
        files: Object.freeze(files),
      });
    } catch {
      await Promise.all(createdPaths.map((path) => rm(path, { force: true }).catch(() => undefined)));
      return Object.freeze({
        status: 'failed',
        exportedCount: 0,
        files: Object.freeze([]),
        failure: Object.freeze({ code: 'EXPORT_FAILED', message: 'History export failed' }),
      });
    }
  }
}

function parseServiceBatch(value: readonly string[]): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_SERVICE_BATCH) {
    throw new Error('History selection is invalid');
  }
  const ids = value.map((id) => {
    assertSafeServiceIdentity(id, 'History id is invalid');
    return id;
  });
  if (new Set(ids).size !== ids.length) throw new Error('History selection contains duplicates');
  return ids;
}

function assertSafeServiceIdentity(value: unknown, message: string): asserts value is string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_-]{7,95}$/u.test(value)) throw new Error(message);
}
