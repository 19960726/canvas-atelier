import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseGenerationHistoryRecord, type GenerationHistoryRecord } from '@agent-canvas/domain';
import { afterEach, describe, expect, it } from 'vitest';

import * as desktopCore from './index';
import { GenerationHistoryStore } from './generation-history-store';

type ServiceConstructor = new (options: { readonly store: GenerationHistoryStore }) => {
  compare(historyIds: readonly string[]): Promise<readonly unknown[]>;
  copyToProject(input: {
    readonly historyIds: readonly string[];
    readonly operationId: string;
    readonly projectDisplayLabel: string;
    readonly projectId: string;
    readonly projectRoot: string;
  }): Promise<{ readonly copies: ReadonlyArray<{ readonly historyId: string; readonly projectAssetId: string }> }>;
  exportSelected(input: {
    readonly chooseDestination: (files: readonly unknown[]) => Promise<string | null>;
    readonly historyIds: readonly string[];
  }): Promise<Record<string, unknown>>;
  getReusableSummary(historyId: string): Promise<Record<string, unknown>>;
};

const roots: string[] = [];
const pngBytes = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x03,
  0x08, 0x06, 0x00, 0x00, 0x00,
]);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe('generation history safe service', () => {
  it('returns reusable and comparison descriptors with safe allowlisted metadata only', async () => {
    const Service = requireService();
    if (Service === null) return;
    const harness = await createHarness();
    const store = new GenerationHistoryStore(harness);
    const first = historyRecord('history_aaaaaaaaaaaaaaaa', pngBytes);
    const secondBytes = Buffer.concat([pngBytes, Buffer.from([0x01])]);
    const second = historyRecord('history_bbbbbbbbbbbbbbbb', secondBytes);
    await store.ingest({ operationId: 'operation_ingest_aaaaaaaa', record: first, source: chunks(pngBytes) });
    await store.ingest({ operationId: 'operation_ingest_bbbbbbbb', record: second, source: chunks(secondBytes) });
    const service = new Service({ store });

    const reusable = await service.getReusableSummary(first.id);
    expect(reusable).toEqual({
      historyId: first.id,
      parameters: first.parameters,
      promptSummary: first.promptSummary,
      provider: first.provider,
    });
    const comparison = await service.compare([first.id, second.id]);
    expect(comparison).toHaveLength(2);
    expect(JSON.stringify({ reusable, comparison })).not.toMatch(
      /path|token|authorization|base64|blob:|providerUrl|rawTask|https?:\/\//iu,
    );
  });

  it('rejects video records from the image comparison service', async () => {
    const Service = requireService();
    if (Service === null) return;
    const image = historyRecord('history_aaaaaaaaaaaaaaaa', pngBytes);
    const video = videoHistoryRecord('history_videoaaaaaaaaaaa');
    const store = {
      getRecords: async () => [image, video],
    } as unknown as GenerationHistoryStore;
    const service = new Service({ store });

    await expect(service.compare([image.id, video.id])).rejects.toThrow(/image history/i);
  });
  it('copies into the managed project asset library independently so later history deletion cannot break it', async () => {
    const Service = requireService();
    if (Service === null) return;
    const harness = await createHarness();
    const projectRoot = join(harness.root, 'Project.novus-project');
    await mkdir(projectRoot);
    const store = new GenerationHistoryStore(harness);
    const record = historyRecord('history_aaaaaaaaaaaaaaaa', pngBytes);
    await store.ingest({ operationId: 'operation_ingest_aaaaaaaa', record, source: chunks(pngBytes) });
    const service = new Service({ store });

    const copied = await service.copyToProject({
      operationId: 'operation_copy_aaaaaaaa',
      historyIds: [record.id],
      projectDisplayLabel: 'Summer campaign',
      projectId: 'project_0123456789abcdef',
      projectRoot,
    });
    expect(copied.copies).toEqual([{ historyId: record.id, projectAssetId: record.output!.sha256.slice(0, 16) }]);
    const projectAssetPath = join(projectRoot, 'assets', `${copied.copies[0]!.projectAssetId}.png`);
    expect(await readFile(projectAssetPath)).toEqual(pngBytes);

    await store.softDelete({
      operationId: 'operation_trash_aaaaaaaa',
      historyIds: [record.id],
    });
    await store.permanentlyDelete({
      operationId: 'operation_delete_aaaaaaaa',
      historyIds: [record.id],
    });
    expect((await store.list({ filters: { trashState: 'all' } })).records).toEqual([]);
    expect(await readFile(projectAssetPath)).toEqual(pngBytes);
  });

  it('exports only after a main-process destination choice and returns typed path-free cancel/failure/success summaries', async () => {
    const Service = requireService();
    if (Service === null) return;
    const harness = await createHarness();
    const exportRoot = join(harness.root, 'exports');
    await mkdir(exportRoot);
    const store = new GenerationHistoryStore(harness);
    const record = historyRecord('history_aaaaaaaaaaaaaaaa', pngBytes);
    await store.ingest({ operationId: 'operation_ingest_aaaaaaaa', record, source: chunks(pngBytes) });
    const service = new Service({ store });

    await expect(service.exportSelected({ historyIds: [record.id], chooseDestination: async () => null }))
      .resolves.toEqual({ status: 'cancelled', exportedCount: 0, files: [] });
    const completed = await service.exportSelected({ historyIds: [record.id], chooseDestination: async () => exportRoot });
    expect(completed).toEqual({
      status: 'completed',
      exportedCount: 1,
      files: [{ historyId: record.id, fileName: `${record.id}.png`, byteSize: pngBytes.byteLength }],
    });
    expect(JSON.stringify(completed)).not.toContain(exportRoot);
    const failed = await service.exportSelected({
      historyIds: [record.id],
      chooseDestination: async () => {
        throw new Error(['C:', String.fromCharCode(92), 'Private', String.fromCharCode(92), 'export'].join(''));
      },
    });
    expect(failed).toEqual({
      status: 'failed',
      exportedCount: 0,
      files: [],
      failure: { code: 'EXPORT_FAILED', message: 'History export failed' },
    });
    expect(JSON.stringify(failed)).not.toMatch(/[A-Za-z]:\\/u);
  });

  it('removes a partially written export target when the source fails mid-stream', async () => {
    const Service = requireService();
    if (Service === null) return;
    const harness = await createHarness();
    const exportRoot = join(harness.root, 'exports');
    await mkdir(exportRoot);
    const record = historyRecord('history_aaaaaaaaaaaaaaaa', pngBytes);
    const failingStore = {
      assertSeparatedLocation: async () => undefined,
      getRecords: async () => [record],
      withAvailableAsset: async (
        _historyId: string,
        operation: (asset: {
          readonly record: GenerationHistoryRecord;
          readonly source: AsyncIterable<Uint8Array>;
        }) => Promise<unknown>,
      ) => operation({ record, source: failingChunks(pngBytes) }),
    } as unknown as GenerationHistoryStore;
    const service = new Service({ store: failingStore });

    await expect(service.exportSelected({
      historyIds: [record.id],
      chooseDestination: async () => exportRoot,
    })).resolves.toMatchObject({ status: 'failed', exportedCount: 0 });
    await expect(readdir(exportRoot)).resolves.toEqual([]);
  });
});

function requireService(): ServiceConstructor | null {
  expect(desktopCore).toHaveProperty('GenerationHistoryService');
  const candidate = (desktopCore as Record<string, unknown>).GenerationHistoryService;
  return typeof candidate === 'function' ? candidate as ServiceConstructor : null;
}

async function createHarness(): Promise<{ historyRoot: string; ownedRoot: string; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'generation-history-service-'));
  roots.push(root);
  const ownedRoot = join(root, 'user-data');
  await mkdir(ownedRoot);
  return { root, ownedRoot, historyRoot: join(ownedRoot, 'generation-history') };
}

function historyRecord(id: string, bytes: Uint8Array): GenerationHistoryRecord {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return parseGenerationHistoryRecord({
    schemaVersion: 1,
    id,
    createdAt: '2026-07-18T12:00:00.000Z',
    updatedAt: '2026-07-18T12:00:02.000Z',
    completedAt: '2026-07-18T12:00:02.000Z',
    project: { projectId: 'project_0123456789abcdef', displayLabel: 'Summer campaign' },
    job: { jobId: `job_${id.slice(-16)}`, resultId: `result_${id.slice(-16)}` },
    status: 'succeeded',
    provider: { displayName: 'Comfly', modelDisplayName: 'Image Studio', capabilityRevision: 'image-v3' },
    promptSummary: 'Product on a quiet blue studio background',
    parameters: { aspectRatio: '1:1', quality: 'high', seed: 42, steps: 32 },
    output: {
      width: 2,
      height: 3,
      format: 'png',
      mediaType: 'image/png',
      byteSize: bytes.byteLength,
      availability: 'available',
      historyAssetId: `history_asset_${id.slice(-16)}`,
      sha256,
    },
    favorite: false,
    tags: ['studio'],
    projectReferenceCount: 0,
    projectReferences: [],
    trash: null,
    termination: null,
  });
}

function videoHistoryRecord(id: string): GenerationHistoryRecord {
  return parseGenerationHistoryRecord({
    schemaVersion: 2,
    kind: 'video',
    id,
    createdAt: '2026-07-18T12:00:00.000Z',
    updatedAt: '2026-07-18T12:00:02.000Z',
    completedAt: '2026-07-18T12:00:02.000Z',
    project: null,
    job: { jobId: 'job_videoaaaaaaaaaaaaaa', resultId: 'result_videoaaaaaaaaaaa' },
    status: 'succeeded',
    provider: { displayName: 'RelayMe', modelDisplayName: 'Seedance 2.0 Pro', capabilityRevision: 'video-v1' },
    promptSummary: 'Generated product reveal video',
    parameters: { aspectRatio: '16:9' },
    output: {
      width: 1920,
      height: 1080,
      durationSeconds: 8,
      format: 'mp4',
      mediaType: 'video/mp4',
      byteSize: 1024,
      availability: 'available',
      historyAssetId: 'history_asset_videoaaaaaaa',
      sha256: 'b'.repeat(64),
    },
    favorite: false,
    tags: [],
    projectReferenceCount: 0,
    projectReferences: [],
    trash: null,
    termination: null,
  });
}
async function* chunks(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield bytes;
}

async function* failingChunks(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield bytes.subarray(0, 12);
  throw new Error('source failed');
}
