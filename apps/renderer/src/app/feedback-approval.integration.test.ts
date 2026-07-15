/// <reference types="node" />

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ApprovedSnapshotOutbox,
  KnowledgeRefreshService,
  ManagedKnowledgeStore,
  ProjectRepository,
  SnapshotScheduler,
  createDesktopBridgeHandlers,
  type DesktopBridgeHandlers,
} from '@agent-canvas/desktop-core';
import { createAgentKnowledgeLease, type OrderedReference } from '@agent-canvas/domain';
import {
  createStarterProject,
  replaceProjectPersistenceClientForTests,
  resetAppStoreForTests,
  useAppStore,
} from './app-store';
import type { ProjectPersistenceClient } from './desktop-persistence';

describe('feedback approval integration', () => {
  let handlers: DesktopBridgeHandlers | null = null;
  let tempRoot: string | null = null;

  beforeEach(() => {
    delete window.novusDesktop;
    localStorage.clear();
    replaceProjectPersistenceClientForTests(createImmediatePersistence());
    resetAppStoreForTests();
  });

  afterEach(async () => {
    await handlers?.closeAllProjects();
    handlers = null;
    if (tempRoot !== null) await rm(tempRoot, { force: true, recursive: true });
    tempRoot = null;
  });

  it('saves reverse-prompt feedback as pending then approves and publishes it through the real bridge', async () => {
    const references: OrderedReference[] = [{
      assetId: 'scene',
      label: 'Scene',
      role: 'scene_composition',
      position: 0,
    }];
    const citations = [{ assetId: 'scene', label: 'Scene' }];
    const lease = createAgentKnowledgeLease({
      runId: 'run-feedback-approval',
      capability: 'reverse_prompt',
      snapshots: [],
      references,
      citations,
    }, {
      leaseId: 'lease-feedback-approval',
      createdAt: '2026-07-15T08:00:00.000Z',
    });

    const saved = await useAppStore.getState().recordUserFeedback({
      title: 'Quieter reverse prompt scene',
      userRequest: 'Keep the product centered',
      correction: 'Use calmer liquid arcs',
      knowledgeLease: lease,
      references,
      citations,
      observations: { composition: ['Centered product'], liquid: ['Calmer arcs'] },
      feedback: { keep: ['product'], change: ['liquid'], never: ['extra props'] },
    });
    expect(saved).toBe(true);

    const savedProject = useAppStore.getState().project;
    const pending = savedProject.skillPromotionCandidates[0]!;
    expect(pending).toMatchObject({
      reviewStatus: 'pending_review',
      targetKnowledgeBaseId: 'scene-skill',
      targetKnowledgeSection: 'reverse-prompt/feedback',
      affectedCapabilities: ['reverse_prompt'],
      counts: {
        supportingMemoryCount: 1,
        referenceCount: 1,
        citationCount: 1,
        observationCount: 2,
      },
    });
    expect(savedProject.skillPromotionCandidates.some((candidate) => candidate.reviewStatus === 'approved')).toBe(false);

    tempRoot = await mkdtemp(join(tmpdir(), 'feedback-approval-'));
    const appDataRoot = join(tempRoot, 'app-data');
    const sourceRoot = join(tempRoot, 'scene-skill-source');
    const projectRoot = join(tempRoot, 'Feedback Approval.novus-project');
    await writeKnowledgeFile(sourceRoot, 'memory/main.md', '# Scene Skill\n\nKeep product identity stable.');

    const knowledgeStore = new ManagedKnowledgeStore({ appDataRoot });
    await knowledgeStore.configure({
      knowledgeBaseId: 'scene-skill',
      displayName: 'Scene Skill',
      rootPath: sourceRoot,
    });
    const refresh = new KnowledgeRefreshService({
      sourceDeviceId: 'feedback-test-device',
      store: knowledgeStore,
      watchAdapter: { watch: () => ({ close: () => undefined }) },
    });
    await expect(refresh.refreshNow('scene-skill')).resolves.toMatchObject({ activeVersion: 1 });

    const repository = new ProjectRepository({
      createId: sequentialId('feedback-project'),
      deviceId: 'feedback-test-device',
    });
    const created = await repository.create(projectRoot, {
      project: savedProject,
      projectId: savedProject.id,
      projectName: savedProject.name,
    });
    await repository.close(created);

    const approvedSnapshotOutbox = new ApprovedSnapshotOutbox({
      appDataRoot,
      store: knowledgeStore,
    });
    handlers = createDesktopBridgeHandlers({
      appDataRoot,
      approvedSnapshotOutbox,
      createId: sequentialId('feedback-bridge'),
      dialogs: { chooseProjectRoot: async () => projectRoot },
      knowledgeRefreshService: refresh,
      knowledgeStore,
      repository: {
        close: (session) => repository.close(session),
        open: (root, options) => repository.open(root, options),
        openJournalWriter: (session) => repository.openJournalWriter(session),
        readCurrentProject: (session) => repository.readCurrentProject(session),
        readCurrentRevision: (session) => repository.readCurrentRevision(session),
      },
      snapshotScheduler: new SnapshotScheduler({
        worker: (input) => SnapshotScheduler.defaultWorker(input),
      }),
    });

    await handlers.openProject({}, { mode: 'write' });
    const approved = await handlers.reviewSkillCandidate({}, {
      candidateId: pending.id,
      decision: 'approved',
      projectId: savedProject.id,
    });

    expect(approved).toMatchObject({
      currentRevision: 1,
      candidate: {
        id: pending.id,
        reviewStatus: 'approved',
        publishedKnowledgeVersion: 2,
      },
      knowledgeState: {
        knowledgeBaseId: 'scene-skill',
        activeVersion: 2,
        status: 'active',
      },
    });
    await expect(knowledgeStore.readActive('scene-skill')).resolves.toMatchObject({ version: 2 });
    await expect(approvedSnapshotOutbox.readPublicState()).resolves.toEqual({
      schemaVersion: 1,
      jobs: [expect.objectContaining({
        approvedSnapshot: expect.objectContaining({
          knowledgeBaseId: 'scene-skill',
          version: 2,
        }),
        memoryRelativePaths: [],
        originalImagesIncluded: false,
      })],
    });
    const persistedOutbox = await readFile(
      join(appDataRoot, 'sync', 'approved-snapshot-outbox.json'),
      'utf8',
    );
    expect(persistedOutbox).not.toContain('Keep product identity stable.');
    expect(persistedOutbox).not.toContain('memory/main.md');
    expect(persistedOutbox).not.toContain(sourceRoot);
    expect(persistedOutbox).not.toMatch(/Authorization|Bearer|data:image|[A-Za-z]:\\/u);
  });
});

function createImmediatePersistence(): ProjectPersistenceClient {
  return {
    close: async () => undefined,
    commit: async (request) => ({ ok: true, project: request.nextProject, revision: 1 }),
    hydrate: async () => ({
      availableSnapshotIds: [],
      mode: 'browser',
      project: createStarterProject(),
      revision: 0,
      saveStatus: 'pending',
    }),
    restore: async () => ({
      availableSnapshotIds: [],
      project: createStarterProject(),
      revision: 0,
      saveStatus: 'saved',
    }),
    stablePoint: async () => ({
      availableSnapshotIds: [],
      project: createStarterProject(),
      revision: 0,
    }),
  };
}

async function writeKnowledgeFile(root: string, relativePath: string, content: string): Promise<void> {
  const target = join(root, ...relativePath.split('/'));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
}

function sequentialId(prefix: string): () => string {
  let value = 0;
  return () => `${prefix}-${++value}`;
}
