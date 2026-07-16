import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  createAgentKnowledgeLease,
  createSkillPromotionCandidate,
  createSkillPromotionCandidateFingerprint,
  createUserFeedbackMemory,
  skillPromotionCandidateSchema,
  type CanvasProject,
} from '@agent-canvas/domain';
import { createApprovedSnapshotSyncEnvelope } from '@agent-canvas/skill-store';
import { ApprovedSnapshotOutbox } from './approved-snapshot-outbox';
import { createDesktopBridgeHandlers } from './bridge-handlers';
import { KnowledgeRefreshService } from './knowledge-refresh-service';
import { ManagedKnowledgeStore } from './managed-knowledge-store';
import { ProjectRepository } from './project-repository';
import { SnapshotScheduler } from './snapshot-scheduler';

const gunzipAsync = promisify(gunzip);

type ArtifactClass =
  | 'active-journal'
  | 'knowledge-config'
  | 'knowledge-current'
  | 'knowledge-snapshot'
  | 'project-journal'
  | 'project-manifest'
  | 'project-other'
  | 'public-error-payload'
  | 'public-knowledge-payload'
  | 'public-project-payload'
  | 'public-review-payload'
  | 'recovery-metadata'
  | 'stable-snapshot'
  | 'sync-metadata';

interface ScannedArtifact {
  readonly artifactClass: ArtifactClass;
  readonly label: string;
  readonly text: string;
}

describe('knowledge security integration', () => {
  it('commits a successful durable review and scans every protected artifact class', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'knowledge-security-'));
    const appDataRoot = join(tempRoot, 'app-data');
    const sourceRoot = join(tempRoot, 'source');
    const projectRoot = join(tempRoot, 'Security Project.novus-project');
    let handlers: ReturnType<typeof createDesktopBridgeHandlers> | null = null;

    try {
      await writeKnowledgeFile(sourceRoot, 'memory/main.md', '# Scene Skill\n\nKeep product identity stable.');
      const store = new ManagedKnowledgeStore({ appDataRoot });
      await store.configure({
        knowledgeBaseId: 'scene-skill',
        displayName: 'Scene Skill',
        rootPath: sourceRoot,
      });
      const refresh = new KnowledgeRefreshService({
        sourceDeviceId: 'security-device',
        store,
        watchAdapter: { watch: () => ({ close: () => undefined }) },
      });
      const initialState = await refresh.refreshNow('scene-skill');
      expect(initialState).toMatchObject({ status: 'active', activeVersion: 1, versionCount: 1 });

      const repository = new ProjectRepository({
        createId: createSequentialId('project-artifact'),
        deviceId: 'security-device',
        now: () => new Date('2026-07-15T12:00:00.000Z'),
      });
      const project = createProjectWithSafeFeedback();
      const created = await repository.create(projectRoot, {
        project,
        projectId: project.id,
        projectName: project.name,
      });
      await repository.close(created);

      const approvedSnapshotOutbox = new ApprovedSnapshotOutbox({
        appDataRoot,
        store,
      });
      handlers = createDesktopBridgeHandlers({
        appDataRoot,
        approvedSnapshotOutbox,
        createId: createSequentialId('bridge-artifact'),
        dialogs: {
          chooseKnowledgeRoot: async () => {
            throw new Error('Protected request reached the knowledge root picker');
          },
          chooseProjectRoot: async () => projectRoot,
        },
        knowledgeRefreshService: refresh,
        knowledgeStore: store,
        repository: {
          close: (session) => repository.close(session),
          open: (root, options) => repository.open(root, options),
          openJournalWriter: (session) => repository.openJournalWriter(session),
          readCurrentProject: (session) => repository.readCurrentProject(session),
          readCurrentRevision: (session) => repository.readCurrentRevision(session),
        },
        snapshotScheduler: new SnapshotScheduler({
          now: () => new Date('2026-07-15T12:05:00.000Z'),
          worker: (input) => SnapshotScheduler.defaultWorker(input),
        }),
      });

      const protectedAttempts = createProtectedAttempts();
      const publicErrors: unknown[] = [];
      for (const [index, attempt] of protectedAttempts.values.entries()) {
        let rejected: unknown;
        try {
          await handlers.configureKnowledgeBase({}, {
            knowledgeBaseId: `unsafe-${index}`,
            displayName: attempt,
          });
        } catch (error) {
          rejected = error;
        }
        expect(rejected).toMatchObject({ code: 'INVALID_REQUEST' });
        publicErrors.push(toPublicError(rejected));
      }

      const opened = await handlers.openProject({}, { mode: 'write' });
      if (opened === null) throw new Error('Expected the durable project to open');
      expect(opened.currentRevision).toBe(0);

      const pendingCandidate = project.skillPromotionCandidates[0]!;
      const prepared = await handlers.prepareSkillCandidateReview({}, {
        baseRevision: opened.currentRevision,
        candidateId: pendingCandidate.id,
        candidateFingerprint: createSkillPromotionCandidateFingerprint(pendingCandidate),
        projectId: project.id,
      });
      if (prepared.candidate.preparedManagedSnapshot === undefined) {
        throw new Error('Expected prepared Skill preview metadata');
      }
      expect(prepared).toMatchObject({
        currentRevision: 1,
        candidate: {
          reviewPreparationStatus: 'ready',
          sourceRule: expect.any(String),
          managedRule: expect.any(String),
          diffHunks: expect.any(Array),
        },
      });

      const review = await handlers.reviewSkillCandidate({}, {
        baseRevision: prepared.currentRevision,
        candidateId: prepared.candidate.id,
        candidateFingerprint: createSkillPromotionCandidateFingerprint(prepared.candidate),
        decision: 'approved',
        preparedManagedSnapshot: prepared.candidate.preparedManagedSnapshot,
        projectId: project.id,
      });
      expect(review).toMatchObject({
        currentRevision: 2,
        projectId: project.id,
        candidate: {
          reviewStatus: 'approved',
          publishedKnowledgeVersion: 2,
          sourceProjectMemoryId: project.projectMemory[0]!.id,
        },
        knowledgeState: {
          status: 'active',
          activeVersion: 2,
          versionCount: 2,
        },
      });

      const journalBeforeStablePoint = await readFile(join(projectRoot, 'journal', 'active.ndjson'), 'utf8');
      expect(journalBeforeStablePoint).toContain('Prepare skill candidate candidate-feedback');
      expect(journalBeforeStablePoint).toContain('Review skill candidate candidate-feedback');
      expect(journalBeforeStablePoint).toContain('"revision":1');
      expect(journalBeforeStablePoint).toContain('"revision":2');

      const stablePoint = await handlers.createStablePoint({}, { sessionId: opened.sessionId });
      expect(stablePoint).toMatchObject({ reason: 'stable_point', revision: 2 });

      const readOnlySession = await repository.open(projectRoot, { mode: 'read_only' });
      const durableProject = await repository.readCurrentProject(readOnlySession);
      expect(durableProject.projectMemory).toEqual([project.projectMemory[0]]);
      expect(durableProject.skillPromotionCandidates[0]).toMatchObject({
        id: 'candidate-feedback',
        reviewStatus: 'approved',
        publishedKnowledgeVersion: 2,
      });

      const publicKnowledgeState = await handlers.getKnowledgeState({}, undefined);
      const activeSnapshot = await store.readActive('scene-skill');
      if (activeSnapshot === null) throw new Error('Expected an approved active knowledge snapshot');
      const syncMetadata = createApprovedSnapshotSyncEnvelope(activeSnapshot, {
        createdAt: '2026-07-15T12:06:00.000Z',
        cursor: 'cursor-approved-2',
        envelopeId: 'approved-envelope-2',
        idempotencyKey: 'scene-skill-version-2',
      });
      const syncRoot = join(appDataRoot, 'sync');
      await mkdir(syncRoot, { recursive: true });
      await writeFile(join(syncRoot, 'approved-snapshot.json'), `${JSON.stringify(syncMetadata)}\n`, 'utf8');

      const artifacts = [
        ...await scanDurableTree(projectRoot, 'project'),
        ...await scanDurableTree(appDataRoot, 'app-data'),
        publicArtifact('public-project-payload', 'open-project', opened),
        publicArtifact('public-review-payload', 'review-result', review),
        publicArtifact('public-knowledge-payload', 'knowledge-state', publicKnowledgeState),
        publicArtifact('public-error-payload', 'sanitized-errors', publicErrors),
      ];
      const scannedClasses = new Set(artifacts.map((artifact) => artifact.artifactClass));
      for (const expectedClass of expectedArtifactClasses()) {
        expect(scannedClasses.has(expectedClass), `expected scan coverage for ${expectedClass}`).toBe(true);
      }

      expect(artifacts.filter((artifact) => artifact.artifactClass === 'knowledge-snapshot')).toHaveLength(2);
      expect(artifacts.some((artifact) => (
        artifact.artifactClass === 'project-journal' &&
        artifact.text.includes('Review skill candidate candidate-feedback')
      ))).toBe(true);
      expect(artifacts.some((artifact) => (
        artifact.artifactClass === 'stable-snapshot' &&
        artifact.text.includes('"reviewStatus":"approved"')
      ))).toBe(true);

      const artifactText = artifacts.map((artifact) => artifact.text).join('\n');
      for (const forbidden of [...protectedAttempts.values, ...protectedAttempts.markers]) {
        expectTextNotToContain(artifactText, forbidden);
      }

      const publicPayloadText = JSON.stringify({ opened, publicErrors, publicKnowledgeState, review, syncMetadata });
      expectTextNotToContain(publicPayloadText, tempRoot);
      expectTextNotToContain(publicPayloadText, projectRoot);
      expectTextNotToContain(publicPayloadText, sourceRoot);
      for (const forbidden of protectedAttempts.values) {
        expectTextNotToContain(publicPayloadText, forbidden);
      }
    } finally {
      await handlers?.closeAllProjects().catch(() => undefined);
      await rm(tempRoot, { force: true, recursive: true });
    }
  });
});

async function writeKnowledgeFile(root: string, relativePath: string, content: string): Promise<void> {
  const target = join(root, ...relativePath.split('/'));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
}

function createProjectWithSafeFeedback(): CanvasProject {
  const references = [{ assetId: 'scene', label: 'Scene', role: 'scene_composition' as const, position: 0 }];
  const citations = [{ assetId: 'scene', label: 'Scene' }];
  const lease = createAgentKnowledgeLease({
    runId: 'run-security',
    capability: 'reverse_prompt',
    snapshots: [],
    references,
    citations,
  }, {
    leaseId: 'lease-security',
    createdAt: '2026-07-15T08:00:00.000Z',
  });
  const memory = createUserFeedbackMemory({
    projectId: 'project-1',
    projectRevision: 1,
    title: 'Safe review feedback',
    userRequest: 'premium product visual',
    correction: 'Use calmer liquid arcs',
    knowledgeLease: lease,
    references,
    citations,
    observations: {
      composition: ['Keep the product centered'],
      liquid: ['Use slower liquid arcs'],
    },
    feedback: { keep: ['product'], change: ['liquid'], never: [] },
  }, {
    memoryId: 'memory-feedback',
    createdAt: '2026-07-15T08:00:00.000Z',
    snapshots: { beforeId: 'before-feedback', afterId: 'after-feedback' },
  });
  const candidate = skillPromotionCandidateSchema.parse({
    ...createSkillPromotionCandidate(memory, {
      candidateId: 'candidate-feedback',
      createdAt: '2026-07-15T08:01:00.000Z',
    }),
    beforeRule: 'Use energetic liquid arcs.',
    targetKnowledgeBaseId: 'scene-skill',
    targetKnowledgeSection: 'reverse-prompt/liquid',
    counts: {
      supportingMemoryCount: 1,
      referenceCount: 1,
      citationCount: 1,
      observationCount: 2,
    },
    confidence: 1,
    affectedCapabilities: ['reverse_prompt'],
  });
  return {
    version: 1,
    id: 'project-1',
    name: 'Security Project',
    nodes: [],
    edges: [],
    projectMemory: [memory],
    skillPromotionCandidates: [candidate],
  };
}

function createProtectedAttempts(): { readonly values: string[]; readonly markers: string[] } {
  const markers = [
    'SYNTHETIC_AUTH_MARKER_123456',
    'SYNTHETIC_API_KEY_MARKER_123456',
    'SYNTHETIC_IMAGE_MARKER_1234567890',
  ];
  return {
    markers,
    values: [
      ['Author', 'ization:', ' Bearer ', markers[0]].join(''),
      ['api', '_key=', markers[1]].join(''),
      ['data:', 'image/png;', 'base64,', 'iVBORw0KGgo', markers[2]].join(''),
      ['C:', '\\', 'Users', '\\', 'Synthetic', '\\', 'private', '\\', 'render.png'].join(''),
      ['\\\\', 'synthetic-host', '\\', 'private', '\\', 'render.png'].join(''),
      ['', 'var', 'lib', 'synthetic', 'private', 'render.png'].join('/'),
    ],
  };
}

function createSequentialId(prefix: string): () => string {
  let index = 0;
  return () => `${prefix}-${++index}`;
}

function toPublicError(error: unknown): { readonly code: string; readonly message: string } {
  const record = typeof error === 'object' && error !== null ? error as Record<string, unknown> : {};
  return {
    code: typeof record.code === 'string' ? record.code : 'UNKNOWN',
    message: error instanceof Error ? error.message : 'Request rejected',
  };
}

async function scanDurableTree(root: string, scope: 'project' | 'app-data'): Promise<ScannedArtifact[]> {
  const artifacts: ScannedArtifact[] = [];
  await scanDirectory(root, '', scope, artifacts);
  return artifacts;
}

async function scanDirectory(
  root: string,
  current: string,
  scope: 'project' | 'app-data',
  artifacts: ScannedArtifact[],
): Promise<void> {
  const directory = current.length === 0 ? root : join(root, ...current.split('/'));
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relativePath = current.length === 0 ? entry.name : `${current}/${entry.name}`;
    if (entry.isDirectory()) {
      await scanDirectory(root, relativePath, scope, artifacts);
    } else if (entry.isFile()) {
      artifacts.push({
        artifactClass: classifyArtifact(scope, relativePath),
        label: relativePath,
        text: await readArtifactText(join(root, ...relativePath.split('/'))),
      });
    }
  }
}

function classifyArtifact(scope: 'project' | 'app-data', relativePath: string): ArtifactClass {
  if (scope === 'project') {
    if (relativePath === 'project.novus.json') return 'project-manifest';
    if (relativePath === 'journal/active.ndjson' || relativePath.startsWith('journal/active.ndjson.')) return 'active-journal';
    if (relativePath.startsWith('journal/')) return 'project-journal';
    if (relativePath.startsWith('snapshots/')) return 'stable-snapshot';
    if (relativePath.startsWith('recovery/')) return 'recovery-metadata';
    return 'project-other';
  }
  if (relativePath === 'knowledge/config.json') return 'knowledge-config';
  if (/^knowledge\/[^/]+\/current\.json$/u.test(relativePath)) return 'knowledge-current';
  if (/^knowledge\/[^/]+\/snapshots\/.+\.json$/u.test(relativePath)) return 'knowledge-snapshot';
  if (relativePath.startsWith('sync/')) return 'sync-metadata';
  return 'project-other';
}

async function readArtifactText(path: string): Promise<string> {
  const bytes = await readFile(path);
  return path.endsWith('.gz')
    ? (await gunzipAsync(bytes)).toString('utf8')
    : bytes.toString('utf8');
}

function publicArtifact(artifactClass: ArtifactClass, label: string, value: unknown): ScannedArtifact {
  return { artifactClass, label, text: JSON.stringify(value) };
}

function expectedArtifactClasses(): ArtifactClass[] {
  return [
    'active-journal',
    'knowledge-config',
    'knowledge-current',
    'knowledge-snapshot',
    'project-journal',
    'project-manifest',
    'public-error-payload',
    'public-knowledge-payload',
    'public-project-payload',
    'public-review-payload',
    'recovery-metadata',
    'stable-snapshot',
    'sync-metadata',
  ];
}

function expectTextNotToContain(text: string, forbidden: string): void {
  expect(text).not.toContain(forbidden);
  expect(text).not.toContain(JSON.stringify(forbidden).slice(1, -1));
}
