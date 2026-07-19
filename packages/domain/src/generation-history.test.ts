import { describe, expect, it } from 'vitest';

import * as historyContract from './generation-history';

import {
  GENERATION_HISTORY_SCHEMA_VERSION,
  parseGenerationHistoryRecord,
  type GenerationHistoryRecord,
} from './generation-history';

const completedAt = '2026-07-18T12:00:02.000Z';

describe('generation history record contract', () => {
  it.each([
    ['succeeded', succeededRecord()],
    ['failed', failedRecord()],
    ['cancelled', cancelledRecord()],
  ] as const)('accepts a strict immutable %s record', (_status, input) => {
    const record = parseGenerationHistoryRecord(input);

    expect(record.schemaVersion).toBe(GENERATION_HISTORY_SCHEMA_VERSION);
    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record.provider)).toBe(true);
    expect(Object.isFrozen(record.parameters)).toBe(true);
    expect(Object.isFrozen(record.projectReferences)).toBe(true);
    expect(() => {
      (record.projectReferences as Array<unknown>).push({});
    }).toThrow();
  });

  it.each([
    ['failed', failedRecord()],
    ['cancelled', cancelledRecord()],
  ] as const)('rejects output metadata on a %s record', (_status, input) => {
    expect(() => parseGenerationHistoryRecord({
      ...input,
      output: succeededRecord().output,
    })).toThrow();
  });

  it.each([
    ['unknown top-level field', (record: Record<string, unknown>) => ({ ...record, rawPayload: { private: true } })],
    ['raw provider task field', (record: Record<string, unknown>) => ({
      ...record,
      job: { ...(record.job as Record<string, unknown>), rawTaskId: 'provider-private-task' },
    })],
    ['provider endpoint field', (record: Record<string, unknown>) => ({
      ...record,
      provider: { ...(record.provider as Record<string, unknown>), endpoint: ['https:', '//provider.invalid'].join('') },
    })],
    ['Authorization value', (record: Record<string, unknown>) => ({
      ...record,
      promptSummary: ['Author', 'ization: Bearer protected-value'].join(''),
    })],
    ['Base64 original', (record: Record<string, unknown>) => ({
      ...record,
      promptSummary: ['data:image/png;', 'base64,', 'A'.repeat(32)].join(''),
    })],
    ['object URL', (record: Record<string, unknown>) => ({
      ...record,
      promptSummary: ['bl', 'ob:https://renderer.invalid/asset'].join(''),
    })],
    ['private absolute path', (record: Record<string, unknown>) => ({
      ...record,
      promptSummary: ['C:', String.fromCharCode(92), 'Users', String.fromCharCode(92), 'Private', String.fromCharCode(92), 'original.png'].join(''),
    })],
    ['provider URL value', (record: Record<string, unknown>) => ({
      ...record,
      provider: {
        ...(record.provider as Record<string, unknown>),
        displayName: ['https:', '//provider.invalid'].join(''),
      },
    })],
  ] as const)('rejects %s recursively', (_label, mutate) => {
    expect(() => parseGenerationHistoryRecord(mutate(succeededRecord()))).toThrow();
  });

  it('bounds reusable parameters, tags, references, and public strings', () => {
    expect(() => parseGenerationHistoryRecord({
      ...succeededRecord(),
      tags: Array.from({ length: 21 }, (_, index) => `tag-${index}`),
    })).toThrow();
    expect(() => parseGenerationHistoryRecord({
      ...succeededRecord(),
      promptSummary: 'x'.repeat(501),
    })).toThrow();
    expect(() => parseGenerationHistoryRecord({
      ...succeededRecord(),
      parameters: {
        ...(succeededRecord().parameters as Record<string, unknown>),
        steps: 201,
      },
    })).toThrow();
    expect(() => parseGenerationHistoryRecord({
      ...succeededRecord(),
      projectReferenceCount: 1,
      projectReferences: [],
    })).toThrow();
  });
});

describe('generation history query contract', () => {
  it('parses strict bounded list requests and rejects invalid cursors or ranges', () => {
    expect(historyContract).toHaveProperty('parseGenerationHistoryListRequest');
    const parseList = (historyContract as Record<string, unknown>).parseGenerationHistoryListRequest;
    if (typeof parseList !== 'function') return;

    expect(parseList({
      pageSize: 100,
      sort: 'oldest',
      filters: {
        createdFrom: '2026-07-01T00:00:00.000Z',
        createdTo: '2026-07-31T23:59:59.999Z',
        favorite: true,
        modelDisplayName: 'Image Studio',
        projectId: 'project_0123456789abcdef',
        providerDisplayName: 'Comfly',
        statuses: ['succeeded'],
        text: 'studio',
        trashState: 'active',
      },
    })).toMatchObject({ pageSize: 100, sort: 'oldest' });

    expect(() => parseList({ pageSize: 101 })).toThrow();
    expect(() => parseList({ cursor: 'not a cursor' })).toThrow();
    expect(() => parseList({ unknown: true })).toThrow();
    expect(() => parseList({ filters: {
      createdFrom: '2026-08-01T00:00:00.000Z',
      createdTo: '2026-07-01T00:00:00.000Z',
    } })).toThrow();
  });

  it('filters and stably sorts records with deterministic id tie breakers', () => {
    expect(historyContract).toHaveProperty('filterAndSortGenerationHistory');
    const filterAndSort = (historyContract as Record<string, unknown>).filterAndSortGenerationHistory;
    if (typeof filterAndSort !== 'function') return;

    const first = parseGenerationHistoryRecord({
      ...succeededRecord(),
      id: 'history_aaaaaaaaaaaaaaaa',
      favorite: true,
    });
    const second = parseGenerationHistoryRecord({
      ...succeededRecord(),
      id: 'history_bbbbbbbbbbbbbbbb',
      favorite: true,
    });
    const failed = parseGenerationHistoryRecord({
      ...failedRecord(),
      id: 'history_cccccccccccccccc',
      createdAt: '2026-07-19T12:00:00.000Z',
      updatedAt: '2026-07-19T12:00:02.000Z',
      completedAt: '2026-07-19T12:00:02.000Z',
    });

    expect(filterAndSort([second, failed, first], {
      pageSize: 25,
      sort: 'newest',
      filters: { favorite: true, statuses: ['succeeded'], text: 'quiet blue' },
    }).map((record: GenerationHistoryRecord) => record.id)).toEqual([
      'history_aaaaaaaaaaaaaaaa',
      'history_bbbbbbbbbbbbbbbb',
    ]);
    expect(filterAndSort([second, failed, first], {
      pageSize: 25,
      sort: 'oldest',
      filters: { trashState: 'all' },
    }).map((record: GenerationHistoryRecord) => record.id)).toEqual([
      'history_aaaaaaaaaaaaaaaa',
      'history_bbbbbbbbbbbbbbbb',
      'history_cccccccccccccccc',
    ]);
  });
});

function succeededRecord(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: 'history_0123456789abcdef',
    createdAt: '2026-07-18T12:00:00.000Z',
    updatedAt: completedAt,
    completedAt,
    project: {
      projectId: 'project_0123456789abcdef',
      displayLabel: 'Summer campaign',
    },
    job: {
      jobId: 'job_0123456789abcdef',
      resultId: 'result_0123456789abcdef',
    },
    status: 'succeeded',
    provider: {
      displayName: 'Comfly',
      modelDisplayName: 'Image Studio',
      capabilityRevision: 'image-v3',
    },
    promptSummary: 'Product on a quiet blue studio background',
    parameters: {
      aspectRatio: '1:1',
      background: 'opaque',
      guidanceScale: 7.5,
      outputCount: 1,
      quality: 'high',
      seed: 42,
      steps: 32,
      stylePreset: 'studio',
    },
    output: {
      width: 1024,
      height: 1024,
      format: 'png',
      mediaType: 'image/png',
      byteSize: 68,
      availability: 'available',
      historyAssetId: 'history_asset_0123456789abcdef',
      sha256: '0123456789abcdef'.repeat(4),
    },
    favorite: false,
    tags: ['campaign', 'studio'],
    projectReferenceCount: 0,
    projectReferences: [],
    trash: null,
    termination: null,
  } satisfies GenerationHistoryRecord;
}

function failedRecord(): Record<string, unknown> {
  return {
    ...succeededRecord(),
    id: 'history_1111111111111111',
    job: { jobId: 'job_1111111111111111' },
    status: 'failed',
    output: null,
    termination: {
      code: 'provider_failed',
      message: 'Generation failed',
    },
  };
}

function cancelledRecord(): Record<string, unknown> {
  return {
    ...succeededRecord(),
    id: 'history_2222222222222222',
    job: { jobId: 'job_2222222222222222' },
    status: 'cancelled',
    output: null,
    termination: {
      code: 'cancelled_by_user',
      message: 'Generation cancelled',
    },
  };
}
