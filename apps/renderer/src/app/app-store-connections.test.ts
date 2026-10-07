import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCanvasModuleNode, parseCanvasProject } from '@agent-canvas/domain';
import { JournalWriter, readValidJournal, replayJournal, resetJournalWriterRegistryForTests } from '../../../../packages/desktop-core/src/journal-writer';
import { replaceProjectPersistenceClientForTests, resetAppStoreForTests, useAppStore } from './app-store';
import { createBrowserPersistenceClient, type ProjectCommitRequest, type ProjectCommitResult } from './desktop-persistence';

beforeEach(() => {
  delete window.novusDesktop;
  localStorage.clear();
  sessionStorage.clear();
  resetJournalWriterRegistryForTests();
  replaceProjectPersistenceClientForTests(createBrowserPersistenceClient());
  resetAppStoreForTests({ project: 'empty' });
});

afterEach(() => {
  resetAppStoreForTests({ project: 'empty' });
  resetJournalWriterRegistryForTests();
  vi.restoreAllMocks();
  delete window.novusDesktop;
});

const targets = [
  ['image_generation', 'references'],
  ['video_generation', 'media'],
  ['reverse_agent', 'references'],
] as const;

describe('durable image port reconnection', () => {
  it.each(targets)('reconnects the same image to %s after deletion and journal reopen', async (moduleType, targetHandle) => {
    const fixture = await journalFixture(moduleType);
    const connection = { source: 'source-image', sourceHandle: 'image', target: 'target', targetHandle };
    expect(await useAppStore.getState().connectModulePorts(connection)).toBe(true);
    const firstEdge = useAppStore.getState().project.edges[0]!;
    expect(await useAppStore.getState().connectModulePorts(connection)).toBe(false);
    expect(fixture.commit).toHaveBeenCalledTimes(1);
    expect(await useAppStore.getState().deleteCanvasEdge(firstEdge.id)).toBe(true);
    expect((await fixture.replay()).project.edges).toEqual([]);
    await fixture.reopen();

    const reconnected = await useAppStore.getState().connectModulePorts(connection);
    expect(fixture.failures).toEqual([]);
    expect(reconnected).toBe(true);
    expect(useAppStore.getState().project.edges).toEqual([firstEdge]);
    expect(useAppStore.getState().saveStatus).toBe('saved');
    expect(useAppStore.getState().desktopRevision).toBe(3);
    const records = (await readValidJournal(fixture.journalPath)).records;
    expect(records).toHaveLength(3);
    expect(new Set(records.map(record => record.transactionId)).size).toBe(3);
    expect((await fixture.replay()).project.edges).toEqual([firstEdge]);
    expect(useAppStore.getState().project.nodes).toEqual(fixture.project.nodes);
  });

  it('reconnects repeated disconnects within one clock tick and preserves another target', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1791288000000);
    const fixture = await journalFixture('image_generation');
    const connection = { source: 'source-image', sourceHandle: 'image', target: 'target', targetHandle: 'references' };
    const other = { ...connection, target: 'other-target' };
    expect(await useAppStore.getState().connectModulePorts(other)).toBe(true);
    const otherEdge = useAppStore.getState().project.edges[0]!;
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(await useAppStore.getState().connectModulePorts(connection)).toBe(true);
      const edge = useAppStore.getState().project.edges.find(candidate => candidate.target === 'target')!;
      expect(edge.order).toBe(0);
      expect(useAppStore.getState().project.edges).toContainEqual(otherEdge);
      expect(await useAppStore.getState().deleteCanvasEdge(edge.id)).toBe(true);
    }
    expect(fixture.failures).toEqual([]);
    expect(useAppStore.getState().project.edges).toEqual([otherEdge]);
    expect((await fixture.replay()).project.edges).toEqual([otherEdge]);
    const records = (await readValidJournal(fixture.journalPath)).records;
    expect(records).toHaveLength(7);
    expect(new Set(records.map(record => record.transactionId)).size).toBe(7);
  });

  it('retries an unacknowledged connection using its original request without another journal append', async () => {
    const fixture = await journalFixture('reverse_agent');
    const committed = fixture.commit.getMockImplementation()!;
    fixture.commit.mockImplementationOnce(async request => {
      const result = await committed(request);
      expect(result.ok).toBe(true);
      return { ok: false, code: 'DURABLE_WRITE_FAILED', retryable: true,
        project: request.previousProject, revision: request.baseRevision };
    });
    const connection = { source: 'source-image', sourceHandle: 'image', target: 'target', targetHandle: 'references' };
    expect(await useAppStore.getState().connectModulePorts(connection)).toBe(false);
    const original = fixture.commit.mock.calls[0]![0];
    expect((await readValidJournal(fixture.journalPath)).records).toHaveLength(1);
    expect(await useAppStore.getState().retryFailedProjectCommit()).toBe(true);
    expect(fixture.commit.mock.calls[1]![0]).toEqual(original);
    expect((await readValidJournal(fixture.journalPath)).records).toHaveLength(1);
    expect(useAppStore.getState().project.edges).toHaveLength(1);
    expect(useAppStore.getState().undoStack).toHaveLength(1);
    expect(fixture.failures).toEqual([]);
  });
});

async function journalFixture(moduleType: typeof targets[number][0]) {
  const source = createCanvasModuleNode('source-image', 'image_input', { x: 100, y: 100 });
  source.data.config.assetId = 'aaaaaaaaaaaaaaaa';
  const project = parseCanvasProject({
    version: 1, graphVersion: 2, id: 'reconnect-project', name: 'Connection regression',
    nodes: [source, createCanvasModuleNode('target', moduleType, { x: 700, y: 100 }),
      createCanvasModuleNode('other-target', 'image_generation', { x: 700, y: 700 })],
    edges: [], projectMemory: [], skillPromotionCandidates: [],
    assets: [{ assetId: 'aaaaaaaaaaaaaaaa', byteSize: 42, extension: 'png', height: 100,
      label: 'Connection reference', mediaType: 'image/png', origin: 'imported', sha256: 'a'.repeat(64), width: 100 }],
  });
  const root = await mkdtemp(join(process.cwd(), 'work', 'repair-185', 'connection-reconnect-'));
  const journalPath = join(root, 'active.ndjson');
  await writeFile(journalPath, '', 'utf8');
  const openWriter = () => JournalWriter.open({ activeJournalPath: journalPath, baseRevision: 0, nextSequence: 1, projectId: project.id });
  let writer = await openWriter();
  const failures: Array<{ code: string; message: string; transactionId: string }> = [];
  const commit = vi.fn(async (request: ProjectCommitRequest): Promise<ProjectCommitResult> => {
    try {
      const acknowledgement = await writer.commit(request);
      return { ok: true, project: request.nextProject, revision: acknowledgement.revision };
    } catch (error) {
      const failure = error as { code: 'INVALID_REQUEST'; message: string; retryable: boolean };
      failures.push({ code: failure.code, message: failure.message, transactionId: request.transaction.id });
      return { ok: false, code: failure.code, retryable: failure.retryable, project: request.previousProject, revision: request.baseRevision };
    }
  });
  replaceProjectPersistenceClientForTests({ ...createBrowserPersistenceClient(), commit });
  useAppStore.setState({ project, projectLifecycle: 'durable', saveStatus: 'saved', desktopRevision: 0 });
  return { project, journalPath, commit, failures,
    replay: async () => replayJournal(project, 0, (await readValidJournal(journalPath)).records),
    reopen: async () => { resetJournalWriterRegistryForTests(); writer = await openWriter(); },
  };
}
