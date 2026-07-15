import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAgentKnowledgeLease, createSkillPromotionCandidate, createUserFeedbackMemory, type CanvasProject } from '@agent-canvas/domain';
import { createDesktopBridgeHandlers } from './bridge-handlers';
import { createPersistenceError } from './journal-writer';
import { KnowledgeRefreshService } from './knowledge-refresh-service';
import { ManagedKnowledgeStore } from './managed-knowledge-store';
import type { OpenedProjectSession } from './project-repository';

describe('knowledge security integration', () => {
  it('keeps protected feedback and refresh values out of artifacts and public bridge payloads', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'knowledge-security-'));
    try {
      const appDataRoot = join(tempRoot, 'app-data');
      const sourceRoot = join(tempRoot, 'source');
      const projectRoot = join(tempRoot, 'project.novus-project');
      await writeKnowledgeFile(sourceRoot, 'memory/main.md', [
        'Authorization: Bearer SYNTHETIC_AUTH_MARKER_123456',
        'api_key=SYNTHETIC_API_KEY_MARKER_123456',
        'data:image/png;base64,iVBORw0KGgoSYNTHETIC_IMAGE_MARKER_1234567890',
        'C:\\Users\\Synthetic\\private\\render.png',
        '\\\\synthetic-host\\private\\render.png',
        '/var/lib/synthetic/private/render.png',
      ].join('\n'));
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
      const fallback = await refresh.refreshNow('scene-skill');
      const safeProject = createProjectWithSafeFeedback();
      const protectedProject = {
        ...safeProject,
        skillPromotionCandidates: [{
          ...safeProject.skillPromotionCandidates[0]!,
          rule: 'Never expose Authorization: Bearer SYNTHETIC_AUTH_MARKER_123456',
        }],
      };
      const commits: unknown[] = [];
      const handlers = createDesktopBridgeHandlers({
        dialogs: {
          chooseProjectRoot: async () => projectRoot,
        },
        knowledgeRefreshService: {
          refreshNow: async () => fallback,
          start: async () => undefined,
          stop: async () => undefined,
          subscribe: () => () => undefined,
        },
        knowledgeStore: store,
        repository: {
          close: async () => undefined,
          open: async () => createOpenedSession(projectRoot),
          openJournalWriter: async () => ({
            commit: async (request) => {
              commits.push(request);
              throw createPersistenceError('INVALID_REQUEST', false, 'commit should not run for protected payload');
            },
          }),
          readCurrentProject: async () => protectedProject,
          readCurrentRevision: async () => 1,
        },
      });

      await handlers.openProject({}, { mode: 'write' });
      await expect(handlers.reviewSkillCandidate({}, {
        candidateId: protectedProject.skillPromotionCandidates[0]!.id,
        decision: 'rejected',
        projectId: safeProject.id,
      })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });

      const publicState = await handlers.getKnowledgeState({}, undefined);
      const artifactText = [
        JSON.stringify(fallback),
        JSON.stringify(publicState),
        JSON.stringify(commits),
        await readAllText(appDataRoot),
      ].join('\n');

      expect(commits).toEqual([]);
      for (const forbidden of [
        'SYNTHETIC_AUTH_MARKER',
        'SYNTHETIC_API_KEY_MARKER',
        'SYNTHETIC_IMAGE_MARKER',
        'Authorization:',
        'data:image',
        'C:\\Users\\Synthetic',
        '\\\\synthetic-host\\private',
        '/var/lib/synthetic',
      ]) {
        expect(artifactText).not.toContain(forbidden);
      }
      expect(JSON.stringify(fallback.lastFailure)).toContain('protected content');
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });
});

async function writeKnowledgeFile(root: string, relativePath: string, content: string): Promise<void> {
  const target = join(root, ...relativePath.split('/'));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
}

async function readAllText(root: string): Promise<string> {
  let output = '';
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    output += entry.isDirectory() ? await readAllText(path) : await readFile(path, 'utf8');
  }
  return output;
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
    feedback: { keep: ['product'], change: ['liquid'], never: [] },
  }, {
    memoryId: 'memory-feedback',
    createdAt: '2026-07-15T08:00:00.000Z',
    snapshots: { beforeId: 'before-feedback', afterId: 'after-feedback' },
  });
  const candidate = createSkillPromotionCandidate(memory, {
    candidateId: 'candidate-feedback',
    createdAt: '2026-07-15T08:01:00.000Z',
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

function createOpenedSession(root: string): OpenedProjectSession {
  return {
    lock: {
      channel: 'modern',
      deviceId: 'device-1',
      heartbeatAt: '2026-07-15T08:00:00.000Z',
      openedAt: '2026-07-15T08:00:00.000Z',
      processId: 1,
      projectId: 'project-1',
      schemaVersion: 1,
      sessionId: 'lock-session',
    },
    manifest: {
      activeJournalSegment: 'journal/active.ndjson',
      assetInventory: { assetCount: 0, totalBytes: 0 },
      cleanClose: false,
      formatVersion: 1,
      minimumCompatibleWriterVersion: 1,
      nextSequence: 2,
      projectId: 'project-1',
      projectName: 'Security Project',
      stableSnapshotId: 'stable-1',
      stableSnapshotPath: 'snapshots/stable-1.json',
      stableSnapshotRevision: 1,
    },
    mode: 'write',
    root,
  };
}
