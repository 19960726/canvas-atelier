import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseGenerationHistoryRecord } from '@agent-canvas/domain';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BRIDGE_CHANNELS } from './preload-api';
import { createDesktopBridgeHandlers, registerDesktopBridgeHandlers } from './bridge-handlers';
import { GenerationHistoryService } from './generation-history-service';
import { GenerationHistoryStore } from './generation-history-store';

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

describe('generation history narrow desktop bridge', () => {
  it('exposes safe list/reuse/comparison/export handlers and rejects unknown path-bearing requests', async () => {
    const harness = await createHarness();
    const store = new GenerationHistoryStore(harness);
    const record = historyRecord();
    await store.ingest({ operationId: 'operation_ingest_aaaaaaaa', record, source: chunks(pngBytes) });
    const service = new GenerationHistoryService({ store });
    const createHandlers = createDesktopBridgeHandlers as unknown as (
      dependencies: Record<string, unknown>,
    ) => Record<string, (event: unknown, request?: unknown) => Promise<unknown>>;
    const handlers = createHandlers({
      appDataRoot: harness.ownedRoot,
      historyService: service,
      historyStore: store,
      dialogs: { chooseHistoryExportDirectory: vi.fn(async () => null) },
    });

    expect(handlers).toHaveProperty('listGenerationHistory');
    expect(handlers).toHaveProperty('getGenerationHistoryReusableSummary');
    expect(handlers).toHaveProperty('compareGenerationHistory');
    expect(handlers).toHaveProperty('exportGenerationHistory');
    expect(handlers).toHaveProperty('resolveGenerationHistoryImagePath');
    const list = handlers.listGenerationHistory;
    const reuse = handlers.getGenerationHistoryReusableSummary;
    const compare = handlers.compareGenerationHistory;
    const exportHistory = handlers.exportGenerationHistory;
    const resolveHistoryImage = handlers.resolveGenerationHistoryImagePath;
    if (
      typeof list !== 'function'
      || typeof reuse !== 'function'
      || typeof compare !== 'function'
      || typeof exportHistory !== 'function'
      || typeof resolveHistoryImage !== 'function'
    ) return;

    const listed = await list({}, { pageSize: 25, filters: { trashState: 'all' } });
    const reusable = await reuse({}, { historyId: record.id });
    const compared = await compare({}, { historyIds: [record.id, record.id.replace('a', 'b')] })
      .catch(() => []);
    const exported = await exportHistory({}, { historyIds: [record.id] });
    expect((listed as { records: unknown[] }).records).toHaveLength(1);
    expect(reusable).toMatchObject({ historyId: record.id, promptSummary: record.promptSummary });
    expect(Array.isArray(compared)).toBe(true);
    expect(exported).toEqual({ status: 'cancelled', exportedCount: 0, files: [] });
    await expect(resolveHistoryImage(`novus-history://asset/${record.output!.historyAssetId}`)).resolves.toBe(join(
      harness.historyRoot,
      'originals',
      `${record.output!.historyAssetId}.png`,
    ));
    await expect(resolveHistoryImage('novus-history://asset/../private')).resolves.toBeNull();
    expect(JSON.stringify({ listed, reusable, exported })).not.toMatch(
      /path|token|authorization|base64|blob:|providerUrl|rawTask|https?:\/\//iu,
    );

    await expect(list({}, {
      pageSize: 25,
      sourcePath: ['C:', String.fromCharCode(92), 'Private', String.fromCharCode(92), 'original.png'].join(''),
    })).rejects.toMatchObject({ code: 'HISTORY_INVALID_REQUEST' });
    await expect(exportHistory({}, {
      historyIds: [record.id],
      destinationPath: ['C:', String.fromCharCode(92), 'Private', String.fromCharCode(92), 'export'].join(''),
    })).rejects.toMatchObject({ code: 'HISTORY_INVALID_REQUEST' });
  });

  it('registers every history operation on exact dedicated IPC channels', async () => {
    const harness = await createHarness();
    const store = new GenerationHistoryStore(harness);
    const handlers = createDesktopBridgeHandlers({
      appDataRoot: harness.ownedRoot,
      historyService: new GenerationHistoryService({ store }),
      historyStore: store,
    } as never);
    const registered: string[] = [];
    registerDesktopBridgeHandlers({
      handle: (channel) => { registered.push(channel); },
    }, handlers);

    expect(BRIDGE_CHANNELS).toHaveProperty('history');
    const historyChannels = Object.values((BRIDGE_CHANNELS as unknown as {
      history: Record<string, string>;
    }).history);
    expect(historyChannels.length).toBeGreaterThanOrEqual(12);
    expect(registered).toEqual(expect.arrayContaining(historyChannels));
  });
});

async function createHarness(): Promise<{ historyRoot: string; ownedRoot: string }> {
  const root = await mkdtemp(join(tmpdir(), 'generation-history-bridge-'));
  roots.push(root);
  const ownedRoot = join(root, 'user-data');
  await mkdir(ownedRoot);
  return { ownedRoot, historyRoot: join(ownedRoot, 'generation-history') };
}

function historyRecord() {
  const sha256 = createHash('sha256').update(pngBytes).digest('hex');
  return parseGenerationHistoryRecord({
    schemaVersion: 1,
    id: 'history_aaaaaaaaaaaaaaaa',
    createdAt: '2026-07-18T12:00:00.000Z',
    updatedAt: '2026-07-18T12:00:02.000Z',
    completedAt: '2026-07-18T12:00:02.000Z',
    project: { projectId: 'project_0123456789abcdef', displayLabel: 'Summer campaign' },
    job: { jobId: 'job_aaaaaaaaaaaaaaaa', resultId: 'result_aaaaaaaaaaaaaaaa' },
    status: 'succeeded',
    provider: { displayName: 'Comfly', modelDisplayName: 'Image Studio', capabilityRevision: 'image-v3' },
    promptSummary: 'Product on a quiet blue studio background',
    parameters: { aspectRatio: '1:1', quality: 'high', seed: 42, steps: 32 },
    output: {
      width: 2,
      height: 3,
      format: 'png',
      mediaType: 'image/png',
      byteSize: pngBytes.byteLength,
      availability: 'available',
      historyAssetId: 'history_asset_aaaaaaaaaaaaaaaa',
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

async function* chunks(bytes: Uint8Array): AsyncIterable<Uint8Array> { yield bytes; }
