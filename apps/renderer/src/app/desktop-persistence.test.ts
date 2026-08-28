import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applyProjectTransaction, createCanvasModuleNode, type ReversePromptRun } from '@agent-canvas/domain';
import { createStarterProject } from './app-store';
import {
  createBrowserPersistenceClient,
  createDesktopPersistenceClient,
  createProjectPersistenceClient,
  getActiveProjectSessionId,
  migrateLegacyProject,
  type LegacyProjectImportClient,
  type ProjectHydrationResult,
} from './desktop-persistence';
import { PROJECT_STORAGE_KEY } from './project-persistence';

describe('desktop persistence', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('exposes only the active factory client session identity', async () => {
    const originalBridge = window.novusDesktop;
    const project = createStarterProject();
    const bridge = {
      closeProject: vi.fn(async () => undefined), commit: vi.fn(), createStablePoint: vi.fn(),
      getRecoveryPlan: vi.fn(), openProject: vi.fn(async () => createDesktopSession(project, 'photoshop-session', 0)),
      projectImages: { importImage: vi.fn(), list: vi.fn(async () => []), pasteClipboardImage: vi.fn() },
      restore: vi.fn(),
    };
    window.novusDesktop = bridge as never;

    try {
      const client = createProjectPersistenceClient();
      expect(getActiveProjectSessionId()).toBeNull();
      await client.openProject?.();
      expect(getActiveProjectSessionId()).toBe('photoshop-session');
    } finally {
      window.novusDesktop = originalBridge;
    }
  });

  it('pastes a clipboard image through the narrow desktop bridge without image payloads', async () => {
    const project = createStarterProject();
    const pastedProject = {
      ...project,
      graphVersion: 2 as const,
      assets: [{
        assetId: '0123456789abcdef', byteSize: 42, extension: 'png' as const, height: 50,
        label: 'Clipboard image', mediaType: 'image/png' as const, origin: 'imported' as const,
        sha256: `0123456789abcdef${'0'.repeat(48)}`, width: 25,
      }],
      edges: [],
      nodes: [{
          ...createCanvasModuleNode('clipboard-node', 'image_input', { x: 25, y: 50 }),
          data: {
            ...createCanvasModuleNode('clipboard-node', 'image_input', { x: 25, y: 50 }).data,
            config: { assetId: '0123456789abcdef' },
          },
        }],
    };
    const pasteClipboardImage = vi.fn(async (request) => ({
      asset: {
        assetId: '0123456789abcdef', byteSize: 42, displayUrl: 'novus-asset://project/session/0123456789abcdef',
        extension: 'png' as const, height: 50, label: 'Clipboard image', mediaType: 'image/png' as const,
        origin: 'imported' as const, sha256: `0123456789abcdef${'0'.repeat(48)}`, usageCount: 1, width: 25,
      },
      currentRevision: 1,
      project: pastedProject,
    }));
    const bridge = {
      closeProject: vi.fn(async () => undefined), commit: vi.fn(), createStablePoint: vi.fn(),
      getRecoveryPlan: vi.fn(), openProject: vi.fn(async () => createDesktopSession(project, 'session', 0)), restore: vi.fn(),
      projectImages: { importImage: vi.fn(), list: vi.fn(async () => []), pasteClipboardImage },
    };
    const client = createDesktopPersistenceClient(bridge as never);
    await client.openProject?.();

    const result = await client.pasteClipboardImage({
      operationId: 'clipboard_paste_desktop',
      position: { x: 25, y: 50 },
    });

    expect(pasteClipboardImage).toHaveBeenCalledWith({
      sessionId: 'session',
      target: { kind: 'new_image_input', operationId: 'clipboard_paste_desktop', position: { x: 25, y: 50 } },
    });
    expect(JSON.stringify(pasteClipboardImage.mock.calls)).not.toMatch(/bytes|base64|path|data:image/iu);
    expect(result?.project.nodes.some((node) => node.id === 'clipboard-node')).toBe(true);
  });

  it('copies history into the active project without exposing the desktop session to callers', async () => {
    const project = createStarterProject();
    const copiedProject = {
      ...project,
      assets: [{
        assetId: '0123456789abcdef', byteSize: 42, extension: 'png' as const, height: 50,
        label: 'History image', mediaType: 'image/png' as const, origin: 'generated' as const,
        sha256: `0123456789abcdef${'0'.repeat(48)}`, width: 25,
      }],
    };
    const copyToProject = vi.fn(async () => ({
      copies: [{ historyId: 'history_0123456789abcdef', projectAssetId: '0123456789abcdef' }],
      currentRevision: 4,
      project: copiedProject,
    }));
    const bridge = {
      closeProject: vi.fn(async () => undefined), commit: vi.fn(), createStablePoint: vi.fn(),
      getRecoveryPlan: vi.fn(), openProject: vi.fn(async () => createDesktopSession(project, 'session', 0)), restore: vi.fn(),
      history: { copyToProject },
      projectImages: { importImage: vi.fn(), list: vi.fn(async () => []), pasteClipboardImage: vi.fn() },
    };
    const client = createDesktopPersistenceClient(bridge as never);
    await client.openProject?.();

    const result = await client.copyHistoryToProject?.({
      historyId: 'history_0123456789abcdef',
      operationId: 'operation_history_canvas_01234567',
    });

    expect(copyToProject).toHaveBeenCalledWith({
      historyIds: ['history_0123456789abcdef'],
      operationId: 'operation_history_canvas_01234567',
      sessionId: 'session',
    });
    expect(result).toMatchObject({ projectAssetId: '0123456789abcdef', revision: 4 });
    expect((await client.hydrate()).project.assets).toHaveLength(1);
  });

  it('binds reverse analysis to its current desktop session and strips caller session overrides', async () => {
    const project = createStarterProject();
    const analyzeReversePrompt = vi.fn(async () => ({
      sessionId: 'run-1', nonce: 'nonce-1', knowledgeSnapshotVersion: 'scene-skill@1:aaaaaaaaaaaa',
      analysis: 'Safe analysis', keywords: ['safe'], positivePrompt: 'Safe prompt',
      negativeConstraints: ['No changes'], executionChecklist: ['Review'],
    }));
    const bridge = {
      closeProject: vi.fn(async () => undefined), commit: vi.fn(), createStablePoint: vi.fn(),
      getRecoveryPlan: vi.fn(), openProject: vi.fn(async () => createDesktopSession(project, 'desktop-session', 0)), restore: vi.fn(),
      provider: { analyzeReversePrompt },
      projectImages: { importImage: vi.fn(), list: vi.fn(async () => []), pasteClipboardImage: vi.fn() },
    };
    const client = createDesktopPersistenceClient(bridge as never);
    await client.openProject?.();

    await client.analyzeReversePrompt?.({
      provider: 'comfly', run: {} as ReversePromptRun, media: [] as never, sessionId: 'attacker-session',
    } as never);

    expect(analyzeReversePrompt).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'desktop-session', provider: 'comfly', run: {}, media: [],
    }));
    expect(JSON.stringify(analyzeReversePrompt.mock.calls)).not.toMatch(/attacker-session|path|url|base64|bytes|credential/iu);
  });

  it('binds Skill chat image references to its current desktop session', async () => {
    const project = createStarterProject();
    const chat = vi.fn(async () => ({
      message: 'Use the centered product framing.', modelRoute: 'vision-skill', sources: [],
    }));
    const bridge = {
      closeProject: vi.fn(async () => undefined), commit: vi.fn(), createStablePoint: vi.fn(),
      getRecoveryPlan: vi.fn(), openProject: vi.fn(async () => createDesktopSession(project, 'desktop-session', 0)), restore: vi.fn(),
      provider: { chat },
      projectImages: { importImage: vi.fn(), list: vi.fn(async () => []), pasteClipboardImage: vi.fn() },
    };
    const client = createDesktopPersistenceClient(bridge as never);
    await client.openProject?.();

    await client.chatSkill?.({
      provider: 'comfly', modelRoute: 'vision-skill', referenceAssetIds: ['a'.repeat(16)],
      messages: [{ role: 'user', content: 'Assess the selected product image.' }],
      context: { knowledgeBaseIds: [], projectMemoryIds: [] },
    });

    expect(chat).toHaveBeenCalledWith({
      provider: 'comfly', modelRoute: 'vision-skill', sessionId: 'desktop-session', referenceAssetIds: ['a'.repeat(16)],
      messages: [{ role: 'user', content: 'Assess the selected product image.' }],
      context: { knowledgeBaseIds: [], projectMemoryIds: [] },
    });
    expect(JSON.stringify(chat.mock.calls)).not.toMatch(/path|url|base64|bytes|credential/iu);
  });

  it('creates a writable desktop session before the first Skill chat on an untitled canvas', async () => {
    const project = createStarterProject();
    const chat = vi.fn(async () => ({
      message: 'The untitled canvas can chat.', modelRoute: 'chat-default', sources: [],
    }));
    const createProject = vi.fn(async ({ project: createdProject }: { project: typeof project }) => (
      createDesktopSession(createdProject, 'created-chat-session', 0)
    ));
    const bridge = {
      closeProject: vi.fn(async () => undefined), commit: vi.fn(), createProject, createStablePoint: vi.fn(),
      getRecoveryPlan: vi.fn(), openProject: vi.fn(async () => null), restore: vi.fn(),
      provider: { chat },
      projectImages: { importImage: vi.fn(), list: vi.fn(async () => []), pasteClipboardImage: vi.fn() },
    };
    const client = createDesktopPersistenceClient(bridge as never);
    await client.hydrate();

    const result = await client.chatSkill?.({
      provider: 'comfly', modelRoute: 'chat-default',
      messages: [{ role: 'user', content: 'Start from the empty canvas.' }],
      context: { knowledgeBaseIds: [], projectMemoryIds: [] },
    });

    expect(createProject).toHaveBeenCalledWith({
      project: expect.objectContaining({ name: '未命名画布', nodes: [], edges: [] }),
    });
    expect(chat).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'comfly', modelRoute: 'chat-default', sessionId: 'created-chat-session',
    }));
    expect(result?.message).toBe('The untitled canvas can chat.');
  });

  it('creates a writable desktop session before reverse analysis on an untitled canvas', async () => {
    const project = createStarterProject();
    const analyzeReversePrompt = vi.fn(async () => ({
      sessionId: 'run-1', nonce: 'nonce-1', knowledgeSnapshotVersion: 'scene-skill@1:aaaaaaaaaaaa',
      analysis: 'Safe analysis', keywords: ['safe'], positivePrompt: 'Safe prompt',
      negativeConstraints: ['No changes'], executionChecklist: ['Review'],
    }));
    const createProject = vi.fn(async ({ project: createdProject }: { project: typeof project }) => (
      createDesktopSession(createdProject, 'created-reverse-session', 0)
    ));
    const bridge = {
      closeProject: vi.fn(async () => undefined), commit: vi.fn(), createProject, createStablePoint: vi.fn(),
      getRecoveryPlan: vi.fn(), openProject: vi.fn(async () => null), restore: vi.fn(),
      provider: { analyzeReversePrompt },
      projectImages: { importImage: vi.fn(), list: vi.fn(async () => []), pasteClipboardImage: vi.fn() },
    };
    const client = createDesktopPersistenceClient(bridge as never);
    await client.hydrate();

    await client.analyzeReversePrompt?.({
      provider: 'comfly', run: {} as ReversePromptRun, media: [] as never,
    });

    expect(createProject).toHaveBeenCalledWith({ project: expect.objectContaining({ name: '未命名画布' }) });
    expect(analyzeReversePrompt).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'comfly', sessionId: 'created-reverse-session',
    }));
  });

  it('receives a display-safe reverse provider error', async () => {
    const project = createStarterProject();
    const bridge = {
      closeProject: vi.fn(async () => undefined), commit: vi.fn(), createStablePoint: vi.fn(),
      getRecoveryPlan: vi.fn(), openProject: vi.fn(async () => createDesktopSession(project, 'desktop-session', 0)), restore: vi.fn(),
      provider: { analyzeReversePrompt: vi.fn(async () => Promise.reject({
        code: 'PROVIDER_ERROR', retryable: true, message: 'https://provider.example/C:/private data:image/png;base64,unsafe Authorization: Bearer secret',
      })) },
      projectImages: { importImage: vi.fn(), list: vi.fn(async () => []), pasteClipboardImage: vi.fn() },
    };
    const client = createDesktopPersistenceClient(bridge as never);
    await client.openProject?.();

    const error = await client.analyzeReversePrompt?.({ provider: 'comfly', run: {} as ReversePromptRun, media: [] as never })
      .catch((reason: unknown) => reason);

    expect(error).toMatchObject({ code: 'PROVIDER_ERROR', retryable: true });
    expect(String((error as Error).message)).not.toMatch(/https?:\/\/|[A-Za-z]:\\|base64|authorization|bearer|secret/iu);
  });

  it('retries one ambiguous clipboard paste with the exact same operation identity', async () => {
    const project = createStarterProject();
    const result = {
      asset: {
        assetId: '0123456789abcdef', byteSize: 42, displayUrl: 'novus-asset://project/session/0123456789abcdef',
        extension: 'png' as const, height: 50, label: 'Clipboard image', mediaType: 'image/png' as const,
        origin: 'imported' as const, sha256: `0123456789abcdef${'0'.repeat(48)}`, usageCount: 1, width: 25,
      },
      currentRevision: 1,
      project,
    };
    const pasteClipboardImage = vi.fn()
      .mockRejectedValueOnce(new Error('IPC response lost'))
      .mockResolvedValue(result);
    const bridge = {
      closeProject: vi.fn(async () => undefined), commit: vi.fn(), createStablePoint: vi.fn(),
      getRecoveryPlan: vi.fn(), openProject: vi.fn(async () => createDesktopSession(project, 'session', 0)), restore: vi.fn(),
      projectImages: { importImage: vi.fn(), list: vi.fn(async () => []), pasteClipboardImage },
    };
    const client = createDesktopPersistenceClient(bridge as never);
    await client.openProject?.();
    const input = { operationId: 'clipboard_paste_retry', position: { x: 10, y: 20 } };

    await expect(client.pasteClipboardImage(input)).resolves.toMatchObject({ revision: 1 });
    expect(pasteClipboardImage).toHaveBeenCalledTimes(2);
    expect(pasteClipboardImage.mock.calls[0]).toEqual(pasteClipboardImage.mock.calls[1]);
  });

  it('does not retry a structured non-transient clipboard paste failure', async () => {
    const project = createStarterProject();
    const error = Object.assign(new Error('disk full'), { code: 'DISK_FULL', retryable: true });
    const pasteClipboardImage = vi.fn(async () => { throw error; });
    const bridge = {
      closeProject: vi.fn(async () => undefined), commit: vi.fn(), createStablePoint: vi.fn(),
      getRecoveryPlan: vi.fn(), openProject: vi.fn(async () => createDesktopSession(project, 'session', 0)), restore: vi.fn(),
      projectImages: { importImage: vi.fn(), list: vi.fn(async () => []), pasteClipboardImage },
    };
    const client = createDesktopPersistenceClient(bridge as never);
    await client.openProject?.();

    await expect(client.pasteClipboardImage({
      operationId: 'clipboard_paste_diskfull',
      position: { x: 10, y: 20 },
    })).rejects.toBe(error);
    expect(pasteClipboardImage).toHaveBeenCalledOnce();
  });

  it('keeps normal browser launch empty even when prior canvas content exists locally', async () => {
    localStorage.setItem(PROJECT_STORAGE_KEY, JSON.stringify({
      current: { ...createStarterProject(), name: 'Browser recent project' },
      schemaVersion: 2,
      snapshots: [],
    }));

    const hydrated = await createBrowserPersistenceClient().hydrate();

    expect(hydrated.project).toMatchObject({ name: '未命名画布', nodes: [], edges: [] });
    expect(hydrated.lifecycle).toBe('untitled');
    expect(hydrated.saveStatus).toBe('pending');
  });

  it('prioritizes an orphan recovery preview over an accidental blank recent project', async () => {
    const recoveredProject = { ...createStarterProject(), name: 'Recovered orphan project' };
    const recentOpen = vi.fn(async () => createDesktopSession({
      ...createStarterProject(),
      id: 'accidental-blank-project',
      name: '未命名画布',
    }, 'blank-session', 0));
    const openLatestRecoveryPreview = vi.fn(async () => ({
      ...createDesktopSession(recoveredProject, 'orphan-recovery-session', 5),
      recoveryRequired: true as const,
      stableSnapshotId: 'snapshot-5',
      stableSnapshotRevision: 5,
    }));
    const bridge = {
      closeProject: vi.fn(async () => undefined),
      commit: vi.fn(),
      createProject: vi.fn(),
      createStablePoint: vi.fn(),
      getRecoveryPlan: vi.fn(async () => createRecoveryPlan(recoveredProject.id, 'snapshot-5', 'candidate-5', 5)),
      openLatestRecoveryPreview,
      openProject: vi.fn(),
      projectImages: { importImage: vi.fn(), list: vi.fn(async () => []), pasteClipboardImage: vi.fn() },
      recentProjects: {
        list: vi.fn(async () => [{
          availability: 'available' as const,
          recentProjectId: 'recent-blank',
        }]),
        open: recentOpen,
      },
      restore: vi.fn(),
    };
    const client = createDesktopPersistenceClient(bridge as never);

    const hydrated = await client.hydrate();

    expect(openLatestRecoveryPreview).toHaveBeenCalledOnce();
    expect(recentOpen).not.toHaveBeenCalled();
    expect(hydrated).toMatchObject({
      lifecycle: 'durable',
      project: { name: 'Recovered orphan project' },
      recoveryRequired: true,
      revision: 5,
      saveStatus: 'error',
    });
  });

  it('opens a meaningful recent project before a stale blank orphan recovery preview', async () => {
    const meaningfulProject = {
      ...createStarterProject(),
      id: 'meaningful-recent-project',
      name: 'Existing four-node canvas',
      nodes: [createCanvasModuleNode('existing-generation', 'image_generation', { x: 200, y: 100 })],
      edges: [],
    };
    const blankOrphan = { ...createStarterProject(), id: 'stale-blank-orphan', name: '未命名画布', nodes: [], edges: [] };
    const openLatestRecoveryPreview = vi.fn(async () => ({
      ...createDesktopSession(blankOrphan, 'blank-orphan-session', 0),
      recoveryRequired: true as const,
    }));
    const recentOpen = vi.fn(async () => createDesktopSession(meaningfulProject, 'meaningful-session', 51));
    const bridge = {
      closeProject: vi.fn(async () => undefined),
      commit: vi.fn(),
      createProject: vi.fn(),
      createStablePoint: vi.fn(),
      getRecoveryPlan: vi.fn(async () => createRecoveryPlan(meaningfulProject.id, 'stable-51', 'candidate-51', 51)),
      openLatestRecoveryPreview,
      openProject: vi.fn(),
      projectImages: { importImage: vi.fn(), list: vi.fn(async () => []), pasteClipboardImage: vi.fn() },
      recentProjects: {
        list: vi.fn(async () => [{
          availability: 'available' as const,
          imageCount: 1,
          nodeCount: 1,
          recentProjectId: 'recent-meaningful',
          videoCount: 0,
        }]),
        open: recentOpen,
      },
      restore: vi.fn(),
    };
    const client = createDesktopPersistenceClient(bridge as never);

    const hydrated = await client.hydrate();

    expect(recentOpen).toHaveBeenCalledWith({ recentProjectId: 'recent-meaningful', mode: 'write' });
    expect(openLatestRecoveryPreview).not.toHaveBeenCalled();
    expect(hydrated).toMatchObject({
      project: { id: meaningfulProject.id, nodes: [{ id: 'existing-generation' }] },
      recoveryRequired: false,
      revision: 51,
      saveStatus: 'saved',
    });
  });

  it('imports a browser image file into an existing image input node', async () => {
    const client = createBrowserPersistenceClient();
    const hydrated = await client.hydrate();
    const project = {
      ...hydrated.project,
      nodes: [createCanvasModuleNode('image-input', 'image_input', { x: 12, y: 24 })],
    };
    await client.commit({
      baseRevision: hydrated.revision,
      kind: 'canvas',
      nextProject: project,
      previousProject: hydrated.project,
      projectId: project.id,
      transaction: { id: 'seed-image-input', label: 'Seed image input', operations: [] },
    });

    const result = await client.importProjectImage(
      { kind: 'module', nodeId: 'image-input' },
      new File(['browser image'], 'reference.png', { type: 'image/png' }),
    );

    expect(result).not.toBeNull();
    expect(result?.asset.mediaType).toBe('image/png');
    expect(result?.asset.displayUrl).toMatch(/^(blob:|data:image\/png)/u);
    expect(result?.project.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'image-input',
        data: expect.objectContaining({ config: expect.objectContaining({ assetId: result?.asset.assetId }) }),
      }),
    ]));
  });

  it('restores an imported browser image preview after recreating the persistence client', async () => {
    const firstClient = createBrowserPersistenceClient(localStorage);
    const hydrated = await firstClient.hydrate();
    const project = {
      ...hydrated.project,
      nodes: [createCanvasModuleNode('durable-image-input', 'image_input', { x: 12, y: 24 })],
    };
    await firstClient.commit({
      baseRevision: hydrated.revision,
      kind: 'canvas',
      nextProject: project,
      previousProject: hydrated.project,
      projectId: project.id,
      transaction: { id: 'seed-durable-image-input', label: 'Seed durable image input', operations: [] },
    });
    const imported = await firstClient.importProjectImage(
      { kind: 'module', nodeId: 'durable-image-input' },
      new File(['durable browser image'], 'durable-reference.png', { type: 'image/png' }),
    );

    const refreshedClient = createBrowserPersistenceClient(localStorage);
    await refreshedClient.openProject?.();
    const restored = await refreshedClient.listProjectImages();

    expect(imported).not.toBeNull();
    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({ assetId: imported?.asset.assetId, mediaType: 'image/png', usageCount: 1 });
    expect(restored[0]?.displayUrl).toMatch(/^data:image\/png;base64,/u);
  });

  it('restores an imported browser video preview after recreating the persistence client', async () => {
    const firstClient = createBrowserPersistenceClient(localStorage);
    const hydrated = await firstClient.hydrate();
    const project = {
      ...hydrated.project,
      nodes: [createCanvasModuleNode('durable-video-input', 'video_input', { x: 12, y: 24 })],
    };
    await firstClient.commit({
      baseRevision: hydrated.revision,
      kind: 'canvas',
      nextProject: project,
      previousProject: hydrated.project,
      projectId: project.id,
      transaction: { id: 'seed-durable-video-input', label: 'Seed durable video input', operations: [] },
    });
    const imported = await firstClient.importProjectVideo?.(
      'durable-video-input',
      new File([new Uint8Array([0, 0, 0, 16, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0])], 'durable-reference.mp4', { type: 'video/mp4' }),
    );

    const refreshedClient = createBrowserPersistenceClient(localStorage);
    await refreshedClient.openProject?.();
    const restored = await refreshedClient.listProjectVideos?.();

    expect(imported).not.toBeNull();
    expect(restored).toHaveLength(1);
    expect(restored?.[0]).toMatchObject({ assetId: imported?.asset.assetId, mediaType: 'video/mp4', usageCount: 1 });
    expect(restored?.[0]?.displayUrl).toMatch(/^data:video\/mp4;base64,/u);
  });
  it('automatically restores the most recently opened available project during first hydration', async () => {
    const recentProject = { ...createStarterProject(), name: 'Recent desktop project' };
    const openProject = vi.fn();
    const openRecentProject = vi.fn(async () => ({
      currentRevision: 7,
      mode: 'write' as const,
      project: recentProject,
      projectId: recentProject.id,
      projectName: recentProject.name,
      sessionId: 'recent-session',
      stableSnapshotId: 'stable-7',
      stableSnapshotRevision: 7,
    }));
    const bridge = {
      closeProject: vi.fn(async () => {}),
      commit: vi.fn(),
      createStablePoint: vi.fn(),
      exportPack: vi.fn(),
      getRecoveryPlan: vi.fn(async () => createRecoveryPlan(
        recentProject.id,
        'stable-7',
        'candidate-7',
        7,
      )),
      importPack: vi.fn(),
      openProject,
      recentProjects: {
        list: vi.fn(async () => [{
          recentProjectId: 'recent_0123456789abcdef01234567',
          projectId: recentProject.id,
          displayName: recentProject.name,
          lastOpenedAt: '2026-08-12T00:00:00.000Z',
          lastSavedAt: '2026-08-12T00:00:00.000Z',
          availability: 'available' as const,
          nodeCount: recentProject.nodes.length,
          imageCount: 0,
          videoCount: 0,
          previewUrl: null,
        }]),
        open: openRecentProject,
      },
      restore: vi.fn(),
    };

    const client = createDesktopPersistenceClient(bridge as never);
    const hydrated = await client.hydrate();
    await client.hydrate();

    expect(openProject).not.toHaveBeenCalled();
    expect(bridge.recentProjects.list).toHaveBeenCalledOnce();
    expect(openRecentProject).toHaveBeenCalledOnce();
    expect(openRecentProject).toHaveBeenCalledWith({
      recentProjectId: 'recent_0123456789abcdef01234567',
      mode: 'write',
    });
    expect(hydrated.project).toMatchObject({ name: 'Recent desktop project' });
    expect(hydrated.availableSnapshotIds).toEqual(['stable-7']);
    expect(hydrated.lifecycle).toBe('durable');
    expect(hydrated.revision).toBe(7);
    expect(hydrated.saveStatus).toBe('saved');
    expect(hydrated.recoveryRequired).not.toBe(true);
  });

  it('propagates an explicit recovery-required preview instead of presenting it as saved', async () => {
    const previewProject = { ...createStarterProject(), name: 'Recovery preview' };
    const bridge = {
      closeProject: vi.fn(async () => undefined),
      commit: vi.fn(),
      createStablePoint: vi.fn(),
      getRecoveryPlan: vi.fn(async () => createRecoveryPlan(
        previewProject.id,
        'snapshot-recovery',
        'candidate-recovery',
        3,
      )),
      openProject: vi.fn(async () => ({
        ...createDesktopSession(previewProject, 'recovery-session', 3),
        recoveryRequired: true as const,
      })),
      projectImages: { importImage: vi.fn(), list: vi.fn(async () => []) },
      restore: vi.fn(),
    };
    const client = createDesktopPersistenceClient(bridge as never);

    const opened = await client.openProject?.();
    const hydrated = await client.hydrate();

    expect(opened).toMatchObject({
      project: previewProject,
      recoveryRequired: true,
      saveStatus: 'error',
    });
    expect(hydrated).toMatchObject({
      recoveryRequired: true,
      saveStatus: 'error',
    });
  });

  it('allows only restore or close-without-flush while a recovery preview is unresolved', async () => {
    const previewProject = { ...createStarterProject(), name: 'Recovery preview' };
    const restoredProject = { ...previewProject, name: 'Recovered durable project' };
    const commit = vi.fn(async () => ({
      committedAt: '2026-07-19T00:00:00.000Z',
      projectId: previewProject.id,
      revision: 4,
      sequence: 4,
      transactionId: 'tx-recovery-blocked',
    }));
    const createStablePoint = vi.fn(async () => ({
      path: 'redacted-path',
      reason: 'stable_point' as const,
      revision: 3,
      snapshotId: 'stable-3',
    }));
    const restore = vi.fn(async () => ({
      ...createDesktopSession(restoredProject, 'recovery-session', 3),
      restoredRevision: 3,
    }));
    const bridge = {
      closeProject: vi.fn(async () => undefined),
      commit,
      createStablePoint,
      getRecoveryPlan: vi.fn(async () => createRecoveryPlan(
        previewProject.id,
        'snapshot-recovery',
        'candidate-recovery',
        3,
      )),
      openProject: vi.fn(async () => ({
        ...createDesktopSession(previewProject, 'recovery-session', 3),
        recoveryRequired: true as const,
      })),
      projectImages: { importImage: vi.fn(), list: vi.fn(async () => []) },
      restore,
    };
    const client = createDesktopPersistenceClient(bridge as never);
    await client.openProject?.();

    const blocked = await client.commit({
      baseRevision: 3,
      kind: 'canvas',
      nextProject: { ...previewProject, name: 'Must not commit preview' },
      previousProject: previewProject,
      projectId: previewProject.id,
      transaction: { id: 'tx-recovery-blocked', label: 'Blocked recovery commit', operations: [] },
    });

    expect(blocked).toMatchObject({ code: 'RECOVERY_REQUIRED', ok: false, project: previewProject, revision: 3 });
    await expect(client.stablePoint()).rejects.toMatchObject({ code: 'RECOVERY_REQUIRED' });
    expect(commit).not.toHaveBeenCalled();
    expect(createStablePoint).not.toHaveBeenCalled();

    await expect(client.restore('snapshot-recovery')).resolves.toMatchObject({
      project: restoredProject,
      recoveryRequired: false,
      saveStatus: 'saved',
    });
    expect(restore).toHaveBeenCalledWith({ candidateId: 'candidate-recovery', sessionId: 'recovery-session' });
  });

  it('keeps startup image reads and initial untitled edits in memory without opening or committing a hidden desktop session', async () => {
    const openProject = vi.fn();
    const commit = vi.fn();
    const list = vi.fn();
    const importImage = vi.fn();
    const bridge = {
      closeProject: vi.fn(),
      commit,
      createStablePoint: vi.fn(),
      getRecoveryPlan: vi.fn(),
      openProject,
      projectImages: { importImage, list },
      restore: vi.fn(),
    };
    const client = createDesktopPersistenceClient(bridge as never);
    const hydrated = await client.hydrate();
    const edited = { ...hydrated.project, name: 'Renamed in-memory draft' };

    await expect(client.listProjectImages()).resolves.toEqual([]);
    const result = await client.commit({
      baseRevision: 0,
      kind: 'canvas',
      nextProject: edited,
      previousProject: hydrated.project,
      projectId: hydrated.project.id,
      transaction: { id: 'tx-untitled-memory', label: 'Edit untitled', operations: [] },
    });

    expect(result).toMatchObject({ ok: true, project: edited, revision: 0 });
    expect(openProject).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
    expect(importImage).not.toHaveBeenCalled();
  });

  it('uses the explicit open path every time and switches to the newly selected durable project', async () => {
    const firstProject = { ...createStarterProject(), name: 'First durable project' };
    const secondProject = { ...createStarterProject(), id: 'second-project', name: '未命名画布' };
    const openProject = vi.fn()
      .mockResolvedValueOnce(createDesktopSession(firstProject, 'first-session', 3))
      .mockResolvedValueOnce(createDesktopSession(secondProject, 'second-session', 7));
    const closeProject = vi.fn(async () => undefined);
    const bridge = {
      closeProject,
      commit: vi.fn(),
      createStablePoint: vi.fn(),
      getRecoveryPlan: vi.fn(async () => ({ action: 'auto_recover', candidates: [], issues: [], projectId: secondProject.id, recoveredRevision: null, stableSnapshotId: null, targetRevision: null })),
      openProject,
      projectImages: { importImage: vi.fn(), list: vi.fn(async () => []) },
      restore: vi.fn(),
    };
    const client = createDesktopPersistenceClient(bridge as never);

    const first = await client.openProject?.();
    const second = await client.openProject?.();

    expect(openProject).toHaveBeenCalledTimes(2);
    expect(closeProject).toHaveBeenCalledWith({ sessionId: 'first-session' });
    expect(first).toMatchObject({ lifecycle: 'durable', project: { name: 'First durable project' }, revision: 3 });
    expect(second).toMatchObject({ lifecycle: 'durable', project: { id: 'second-project', name: '未命名画布' }, revision: 7 });
  });

  it.each(['hydrate', 'open', 'restore', 'reload', 'close'] as const)(
    'does not let a prior session successful commit acknowledgement cross the %s boundary',
    async (boundary) => {
      const result = await runDesktopCommitBoundaryRace(boundary, 'success');

      expect(result.commitResult).toMatchObject({
        ok: true,
        project: { name: 'Late first project edit' },
        revision: 4,
      });
      expect(result.hydrated).toMatchObject({
        lifecycle: result.expectedLifecycle,
        project: result.expectedProject === null
          ? expect.not.objectContaining({ name: 'Late first project edit' })
          : { id: result.expectedProject.id, name: result.expectedProject.name },
        revision: result.expectedRevision,
      });
    },
  );

  it.each(['hydrate', 'open', 'restore', 'reload', 'close'] as const)(
    'does not let a prior session failed commit result cross the %s boundary',
    async (boundary) => {
      const result = await runDesktopCommitBoundaryRace(boundary, 'failure');

      expect(result.commitResult).toMatchObject({ code: 'DISK_FULL', ok: false });
      expect(result.hydrated).toMatchObject({
        lifecycle: result.expectedLifecycle,
        project: result.expectedProject === null
          ? expect.not.objectContaining({ name: 'Late first project edit' })
          : { id: result.expectedProject.id, name: result.expectedProject.name },
        revision: result.expectedRevision,
      });
    },
  );

  it('refreshes the current writable lease in place before the next commit', async () => {
    const project = { ...createStarterProject(), name: 'Reload writable project' };
    const openProject = vi.fn(async () => createDesktopSession(project, 'first-session', 3));
    const refreshProject = vi.fn(async () => createDesktopSession(project, 'first-session', 4));
    const closeProject = vi.fn(async () => undefined);
    const commit = vi.fn(async (request: { projectId: string; transaction: { id: string } }) => ({
      committedAt: '2026-07-19T00:00:00.000Z',
      projectId: request.projectId,
      revision: 5,
      sequence: 5,
      transactionId: request.transaction.id,
    }));
    const bridge = {
      closeProject,
      commit,
      createStablePoint: vi.fn(),
      getRecoveryPlan: vi.fn(async () => ({ action: 'auto_recover', candidates: [], issues: [], projectId: project.id, recoveredRevision: null, stableSnapshotId: null, targetRevision: null })),
      openProject,
      refreshProject,
      projectImages: { importImage: vi.fn(), list: vi.fn(async () => []) },
      restore: vi.fn(),
    };
    const client = createDesktopPersistenceClient(bridge as never) as ReturnType<typeof createDesktopPersistenceClient> & ReloadableDesktopClient;
    await client.openProject?.();
    expect.soft(client.reloadDurableProject).toBeTypeOf('function');
    if (client.reloadDurableProject === undefined) return;
    const reloaded = await client.reloadDurableProject();

    expect(refreshProject).toHaveBeenCalledWith({ sessionId: 'first-session' });
    expect(closeProject).not.toHaveBeenCalled();
    expect(openProject).toHaveBeenCalledOnce();
    expect(reloaded).toMatchObject({ lifecycle: 'durable', project: { name: 'Reload writable project' }, revision: 4, saveStatus: 'saved' });
    const edited = { ...project, name: 'Saved after reload' };
    await expect(client.commit({
      baseRevision: 4,
      kind: 'canvas',
      nextProject: edited,
      previousProject: project,
      projectId: project.id,
      transaction: { id: 'tx-after-reload', label: 'Save after reload', operations: [] },
    })).resolves.toMatchObject({ ok: true, revision: 5 });
    expect(commit).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'first-session' }));
  });

  it('can retry a silent refresh after one refresh rejection without closing the active session', async () => {
    const project = { ...createStarterProject(), name: 'Reload retry project' };
    const openProject = vi.fn(async () => createDesktopSession(project, 'first-session', 3));
    const refreshProject = vi.fn()
      .mockRejectedValueOnce(new Error('silent refresh rejected'))
      .mockResolvedValueOnce(createDesktopSession(project, 'first-session', 4));
    const closeProject = vi.fn(async () => undefined);
    const bridge = {
      closeProject,
      commit: vi.fn(),
      createStablePoint: vi.fn(),
      getRecoveryPlan: vi.fn(async () => ({ action: 'auto_recover', candidates: [], issues: [], projectId: project.id, recoveredRevision: null, stableSnapshotId: null, targetRevision: null })),
      openProject,
      refreshProject,
      projectImages: { importImage: vi.fn(), list: vi.fn(async () => []) },
      restore: vi.fn(),
    };
    const client = createDesktopPersistenceClient(bridge as never) as ReturnType<typeof createDesktopPersistenceClient> & ReloadableDesktopClient;
    await client.openProject?.();

    expect.soft(client.reloadDurableProject).toBeTypeOf('function');
    if (client.reloadDurableProject === undefined) return;
    await expect(client.reloadDurableProject()).rejects.toThrow('silent refresh rejected');
    await expect(client.reloadDurableProject()).resolves.toMatchObject({ revision: 4, saveStatus: 'saved' });
    expect(closeProject).not.toHaveBeenCalled();
    expect(openProject).toHaveBeenCalledOnce();
    expect(refreshProject).toHaveBeenCalledTimes(2);
  });

  it('keeps the current durable project adopted after a silent refresh failure', async () => {
    const project = { ...createStarterProject(), name: 'Refresh failure project' };
    const openProject = vi.fn(async () => createDesktopSession(project, 'first-session', 3));
    const refreshProject = vi.fn()
      .mockRejectedValueOnce(new Error('refresh failed before readback'))
      .mockResolvedValueOnce(createDesktopSession(project, 'first-session', 4));
    const closeProject = vi.fn(async () => undefined);
    const bridge = {
      closeProject,
      commit: vi.fn(),
      createStablePoint: vi.fn(),
      getRecoveryPlan: vi.fn(async () => ({ action: 'auto_recover', candidates: [], issues: [], projectId: project.id, recoveredRevision: null, stableSnapshotId: null, targetRevision: null })),
      openProject,
      refreshProject,
      projectImages: { importImage: vi.fn(), list: vi.fn(async () => []) },
      restore: vi.fn(),
    };
    const client = createDesktopPersistenceClient(bridge as never) as ReturnType<typeof createDesktopPersistenceClient> & ReloadableDesktopClient;
    await client.openProject?.();

    await expect(client.reloadDurableProject?.()).rejects.toThrow('refresh failed before readback');
    await expect(client.hydrate()).resolves.toMatchObject({
      project: { name: 'Refresh failure project' },
      revision: 3,
      saveStatus: 'saved',
    });
    await expect(client.reloadDurableProject?.()).resolves.toMatchObject({
      project: { name: 'Refresh failure project' },
      revision: 4,
      saveStatus: 'saved',
    });

    expect(closeProject).not.toHaveBeenCalled();
    expect(openProject).toHaveBeenCalledOnce();
  });

  it('does not accept a read-only result as a successful durable reload', async () => {
    const project = { ...createStarterProject(), name: 'Reload lease project' };
    const openProject = vi.fn(async () => createDesktopSession(project, 'first-session', 3));
    const refreshProject = vi.fn()
      .mockResolvedValueOnce({ ...createDesktopSession(project, 'first-session', 3), mode: 'read_only' as const })
      .mockResolvedValueOnce(createDesktopSession(project, 'first-session', 4));
    const closeProject = vi.fn(async () => undefined);
    const bridge = {
      closeProject,
      commit: vi.fn(),
      createStablePoint: vi.fn(),
      getRecoveryPlan: vi.fn(async () => ({ action: 'auto_recover', candidates: [], issues: [], projectId: project.id, recoveredRevision: null, stableSnapshotId: null, targetRevision: null })),
      openProject,
      refreshProject,
      projectImages: { importImage: vi.fn(), list: vi.fn(async () => []) },
      restore: vi.fn(),
    };
    const client = createDesktopPersistenceClient(bridge as never) as ReturnType<typeof createDesktopPersistenceClient> & ReloadableDesktopClient;
    await client.openProject?.();

    expect.soft(client.reloadDurableProject).toBeTypeOf('function');
    if (client.reloadDurableProject === undefined) return;
    await expect(client.reloadDurableProject()).resolves.toBeNull();
    await expect(client.reloadDurableProject()).resolves.toMatchObject({ revision: 4, saveStatus: 'saved' });
    expect(closeProject).not.toHaveBeenCalled();
    expect(openProject).toHaveBeenCalledOnce();
  });

  it('clears prior recovery candidates when the selected project recovery plan fails', async () => {
    const firstProject = { ...createStarterProject(), name: 'First recovery project' };
    const secondProject = { ...createStarterProject(), id: 'second-project', name: 'Second recovery project' };
    const firstPlan = createRecoveryPlan(firstProject.id, 'first-after', 'candidate-first', 4);
    const secondPlan = createRecoveryPlan(secondProject.id, 'second-after', 'candidate-second', 8);
    const getRecoveryPlan = vi.fn()
      .mockResolvedValueOnce(firstPlan)
      .mockRejectedValueOnce(new Error('second recovery plan unavailable'))
      .mockResolvedValue(secondPlan);
    const restore = vi.fn(async () => ({
      ...createDesktopSession(secondProject, 'second-session', 8),
      restoredRevision: 8,
      stableSnapshotId: 'second-after',
      stableSnapshotRevision: 8,
    }));
    const bridge = {
      closeProject: vi.fn(async () => undefined),
      commit: vi.fn(),
      createStablePoint: vi.fn(async () => ({
        path: 'redacted-path',
        reason: 'stable_point' as const,
        revision: 8,
        snapshotId: 'stable-8',
      })),
      getRecoveryPlan,
      openProject: vi.fn()
        .mockResolvedValueOnce(createDesktopSession(firstProject, 'first-session', 3))
        .mockResolvedValueOnce(createDesktopSession(secondProject, 'second-session', 7)),
      projectImages: { importImage: vi.fn(), list: vi.fn(async () => []) },
      restore,
    };
    const client = createDesktopPersistenceClient(bridge as never);

    const first = await client.openProject?.();
    const second = await client.openProject?.();

    expect(first?.availableSnapshotIds).toEqual(['first-after']);
    expect(second).toMatchObject({
      availableSnapshotIds: [],
      project: { id: secondProject.id, name: secondProject.name },
      revision: 7,
    });
    await expect(client.restore('first-after')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(restore).not.toHaveBeenCalled();

    await expect(client.stablePoint()).resolves.toMatchObject({
      availableSnapshotIds: ['second-after'],
      project: { id: secondProject.id },
      revision: 8,
    });
    await client.restore('second-after');
    expect(restore).toHaveBeenCalledWith({ candidateId: 'candidate-second', sessionId: 'second-session' });
  });

  it('replaces recovery candidates instead of mixing them after a successful project switch', async () => {
    const firstProject = { ...createStarterProject(), name: 'First recovery project' };
    const secondProject = { ...createStarterProject(), id: 'second-project', name: 'Second recovery project' };
    const getRecoveryPlan = vi.fn()
      .mockResolvedValueOnce(createRecoveryPlan(firstProject.id, 'first-after', 'candidate-first', 4))
      .mockResolvedValue(createRecoveryPlan(secondProject.id, 'second-after', 'candidate-second', 8));
    const restore = vi.fn(async () => ({
      ...createDesktopSession(secondProject, 'second-session', 8),
      restoredRevision: 8,
      stableSnapshotId: 'second-after',
      stableSnapshotRevision: 8,
    }));
    const bridge = {
      closeProject: vi.fn(async () => undefined),
      commit: vi.fn(),
      createStablePoint: vi.fn(),
      getRecoveryPlan,
      openProject: vi.fn()
        .mockResolvedValueOnce(createDesktopSession(firstProject, 'first-session', 3))
        .mockResolvedValueOnce(createDesktopSession(secondProject, 'second-session', 7)),
      projectImages: { importImage: vi.fn(), list: vi.fn(async () => []) },
      restore,
    };
    const client = createDesktopPersistenceClient(bridge as never);

    await client.openProject?.();
    const second = await client.openProject?.();

    expect(second?.availableSnapshotIds).toEqual(['second-after']);
    await expect(client.restore('first-after')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(restore).not.toHaveBeenCalled();
    await client.restore('second-after');
    expect(restore).toHaveBeenCalledWith({ candidateId: 'candidate-second', sessionId: 'second-session' });
  });

  it('ignores a prior session recovery plan that completes after the project switch', async () => {
    const firstProject = { ...createStarterProject(), name: 'First recovery project' };
    const secondProject = { ...createStarterProject(), id: 'second-project', name: 'Second recovery project' };
    let resolveFirstPlan!: (plan: ReturnType<typeof createRecoveryPlan>) => void;
    const firstPlanPromise = new Promise<ReturnType<typeof createRecoveryPlan>>((resolve) => {
      resolveFirstPlan = resolve;
    });
    const getRecoveryPlan = vi.fn(({ sessionId }: { sessionId: string }) => sessionId === 'first-session'
      ? firstPlanPromise
      : Promise.resolve(createRecoveryPlan(secondProject.id, 'second-after', 'candidate-second', 8)));
    const restore = vi.fn();
    const bridge = {
      closeProject: vi.fn(async () => undefined),
      commit: vi.fn(),
      createStablePoint: vi.fn(),
      getRecoveryPlan,
      openProject: vi.fn()
        .mockResolvedValueOnce(createDesktopSession(firstProject, 'first-session', 3))
        .mockResolvedValueOnce(createDesktopSession(secondProject, 'second-session', 7)),
      projectImages: { importImage: vi.fn(), list: vi.fn(async () => []) },
      restore,
    };
    const client = createDesktopPersistenceClient(bridge as never);

    const firstOpen = client.openProject!();
    await vi.waitFor(() => {
      expect(getRecoveryPlan).toHaveBeenCalledWith({ sessionId: 'first-session' });
    });
    const second = await client.openProject!();
    resolveFirstPlan(createRecoveryPlan(firstProject.id, 'first-after', 'candidate-first', 4));
    await firstOpen;

    expect(second?.availableSnapshotIds).toEqual(['second-after']);
    await expect(client.hydrate()).resolves.toMatchObject({
      availableSnapshotIds: ['second-after'],
      project: { id: secondProject.id },
    });
    await expect(client.restore('first-after')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(restore).not.toHaveBeenCalled();
  });

  it('removes a v2 localStorage bundle only after desktop import acknowledgement', async () => {
    const legacyBundleJson = JSON.stringify({
      current: createStarterProject(),
      schemaVersion: 2,
      snapshots: [],
    });
    const client: LegacyProjectImportClient = {
      createFromLegacyBundle: vi.fn(async () => {}),
    };

    localStorage.setItem(PROJECT_STORAGE_KEY, legacyBundleJson);

    await migrateLegacyProject(client);

    expect(client.createFromLegacyBundle).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(PROJECT_STORAGE_KEY)).toBeNull();
  });

  it('keeps the v2 localStorage bundle when desktop import fails', async () => {
    const legacyBundleJson = JSON.stringify({
      current: createStarterProject(),
      schemaVersion: 2,
      snapshots: [],
    });
    const client: LegacyProjectImportClient = {
      createFromLegacyBundle: vi.fn(async () => {
        throw new Error('desktop import failed');
      }),
    };

    localStorage.setItem(PROJECT_STORAGE_KEY, legacyBundleJson);

    await expect(migrateLegacyProject(client)).rejects.toThrow('desktop import failed');
    expect(localStorage.getItem(PROJECT_STORAGE_KEY)).toBe(legacyBundleJson);
  });

  it('returns the last durable desktop project on REVISION_CONFLICT', async () => {
    const durableProject = createStarterProject();
    const staleProject = { ...durableProject, name: 'stale-draft' };
    const bridge = {
      closeProject: vi.fn(async () => {}),
      commit: vi.fn(async () => {
        const error = new Error('Base revision is stale') as Error & { code: string };
        error.code = 'REVISION_CONFLICT';
        throw error;
      }),
      createStablePoint: vi.fn(async () => ({
        path: 'redacted-path',
        reason: 'stable_point' as const,
        revision: 3,
        snapshotId: 'stable-3',
      })),
      exportPack: vi.fn(),
      getRecoveryPlan: vi.fn(),
      importPack: vi.fn(),
      openProject: vi.fn(async () => ({
        currentRevision: 3,
        mode: 'write' as const,
        project: durableProject,
        projectId: durableProject.id,
        projectName: durableProject.name,
        sessionId: 'desktop-session',
        stableSnapshotId: null,
        stableSnapshotRevision: 3,
      })),
      restore: vi.fn(),
    };
    const client = createDesktopPersistenceClient(bridge);

    await client.openProject?.();

    const result = await client.commit({
      baseRevision: 2,
      kind: 'canvas',
      nextProject: { ...durableProject, name: 'stale-draft' },
      previousProject: durableProject,
      projectId: durableProject.id,
      transaction: {
        id: 'tx-conflict',
        label: 'Conflict draft',
        operations: [{
          kind: 'replace_canvas_state',
          nodes: durableProject.nodes,
          edges: durableProject.edges,
        }],
      },
    });

    expect(result).toMatchObject({
      code: 'REVISION_CONFLICT',
      ok: false,
      project: durableProject,
      revision: 3,
    });
  });

  it('refreshes and retries once when the active writable session revision advances', async () => {
    const durableProject = createStarterProject();
    const reverseNode = createCanvasModuleNode('reverse-draft-after-drift', 'reverse_agent', { x: 360, y: 0 });
    const editedProject = { ...durableProject, nodes: [...durableProject.nodes, reverseNode] };
    const refreshedProject = { ...durableProject, name: 'bridge metadata preserved during replay' };
    const transaction = {
      id: 'tx-rebased-draft',
      label: 'Persist current project draft',
      operations: [{ kind: 'replace_canvas_state' as const, nodes: editedProject.nodes, edges: editedProject.edges }],
    };
    const rebasedProject = applyProjectTransaction(refreshedProject, transaction);
    const commit = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('Base revision is stale'), { code: 'REVISION_CONFLICT' }))
      .mockResolvedValueOnce({
        committedAt: '2026-08-26T12:00:00.000Z',
        projectId: durableProject.id,
        revision: 5,
        sequence: 5,
        transactionId: 'tx-rebased-draft',
      });
    const refreshProject = vi.fn(async () => ({
      currentRevision: 4,
      mode: 'write' as const,
      project: refreshedProject,
      projectId: durableProject.id,
      projectName: durableProject.name,
      sessionId: 'desktop-session',
      stableSnapshotId: null,
      stableSnapshotRevision: 4,
    }));
    const bridge = {
      closeProject: vi.fn(async () => {}),
      commit,
      createStablePoint: vi.fn(),
      getRecoveryPlan: vi.fn(async () => ({ action: 'auto_recover', candidates: [], issues: [], projectId: durableProject.id, recoveredRevision: null, stableSnapshotId: null, targetRevision: null })),
      openProject: vi.fn(async () => ({
        currentRevision: 3,
        mode: 'write' as const,
        project: durableProject,
        projectId: durableProject.id,
        projectName: durableProject.name,
        sessionId: 'desktop-session',
        stableSnapshotId: null,
        stableSnapshotRevision: 3,
      })),
      refreshProject,
      projectImages: { importImage: vi.fn(), list: vi.fn(async () => []) },
      restore: vi.fn(),
    };
    const client = createDesktopPersistenceClient(bridge as never);
    await client.openProject?.();

    const result = await client.commit({
      baseRevision: 3,
      kind: 'system',
      nextProject: editedProject,
      previousProject: durableProject,
      projectId: durableProject.id,
      transaction,
    });

    expect(result).toMatchObject({ ok: true, project: rebasedProject, revision: 5 });
    expect(refreshProject).toHaveBeenCalledWith({ sessionId: 'desktop-session' });
    expect(commit).toHaveBeenNthCalledWith(2, expect.objectContaining({
      baseRevision: 4,
      projectId: durableProject.id,
      sessionId: 'desktop-session',
    }));
  });

  it('uses the bridge current revision instead of the stable snapshot revision after hydrate', async () => {
    const durableProject = createStarterProject();
    const bridge = {
      closeProject: vi.fn(async () => {}),
      commit: vi.fn(async () => ({
        committedAt: '2026-07-14T00:00:00.000Z',
        projectId: durableProject.id,
        revision: 5,
        sequence: 5,
        transactionId: 'tx-after-hydrate-head',
      })),
      createStablePoint: vi.fn(),
      exportPack: vi.fn(),
      getRecoveryPlan: vi.fn(async () => ({
        action: 'auto_recover' as const,
        candidates: [],
        issues: [],
        projectId: durableProject.id,
        recoveredRevision: null,
        stableSnapshotId: 'stable-3',
        targetRevision: null,
      })),
      importPack: vi.fn(),
      openProject: vi.fn(async () => ({
        currentRevision: 4,
        mode: 'write' as const,
        project: durableProject,
        projectId: durableProject.id,
        projectName: durableProject.name,
        sessionId: 'desktop-session',
        stableSnapshotId: 'stable-3',
        stableSnapshotRevision: 3,
      })),
      restore: vi.fn(),
    };
    const client = createDesktopPersistenceClient(bridge);

    const hydrated = await client.openProject?.();
    expect(hydrated).not.toBeNull();
    const result = await client.commit({
      baseRevision: hydrated!.revision,
      kind: 'canvas',
      nextProject: { ...durableProject, name: 'After current head' },
      previousProject: durableProject,
      projectId: durableProject.id,
      transaction: {
        id: 'tx-after-hydrate-head',
        label: 'After current head',
        operations: [{
          kind: 'replace_canvas_state',
          nodes: durableProject.nodes,
          edges: durableProject.edges,
        }],
      },
    });

    expect(hydrated!.revision).toBe(4);
    expect(bridge.commit).toHaveBeenCalledWith(expect.objectContaining({ baseRevision: 4 }));
    expect(result).toMatchObject({ ok: true, revision: 5 });
  });

  it('opens a recent project by opaque id and adopts the returned desktop session', async () => {
    const currentProject = { ...createStarterProject(), name: 'Current project' };
    const recentProject = { ...createStarterProject(), name: 'Recent project' };
    const openProject = vi.fn(async () => createDesktopSession(currentProject, 'current-session', 2));
    const openRecentProject = vi.fn(async () => createDesktopSession(recentProject, 'recent-session', 7));
    const bridge = {
      closeProject: vi.fn(async () => undefined),
      commit: vi.fn(),
      createStablePoint: vi.fn(),
      getRecoveryPlan: vi.fn(async () => ({
        action: 'auto_recover' as const,
        candidates: [],
        issues: [],
        projectId: recentProject.id,
        recoveredRevision: null,
        stableSnapshotId: null,
        targetRevision: null,
      })),
      openProject,
      recentProjects: { open: openRecentProject },
      restore: vi.fn(),
    };
    const client = createDesktopPersistenceClient(bridge as never);
    await client.openProject?.();

    const result = await client.openProject?.('recent_0123456789abcdef01234567');

    expect(openRecentProject).toHaveBeenCalledWith({
      recentProjectId: 'recent_0123456789abcdef01234567',
      mode: 'write',
    });
    expect(openProject).toHaveBeenCalledOnce();
    expect(bridge.closeProject).toHaveBeenCalledWith({ sessionId: 'current-session' });
    expect(result).toMatchObject({ project: { name: 'Recent project' }, revision: 7 });
    expect((await client.hydrate()).project.name).toBe('Recent project');
  });
  it('maps desktop snapshot ids to opaque recovery candidate ids before restore', async () => {
    const durableProject = createStarterProject();
    const restoredProject = { ...durableProject, name: 'Restored from bridge' };
    const bridge = {
      closeProject: vi.fn(async () => {}),
      commit: vi.fn(),
      createStablePoint: vi.fn(async () => ({
        path: 'redacted-path',
        reason: 'stable_point' as const,
        revision: 3,
        snapshotId: 'stable-3',
      })),
      exportPack: vi.fn(),
      getRecoveryPlan: vi.fn(async () => ({
        action: 'choose_recovery' as const,
        candidates: [{
          candidateId: 'candidate-opaque',
          revision: 4,
          snapshotId: 'desktop-after',
          tailStatus: 'complete' as const,
        }],
        issues: [],
        projectId: durableProject.id,
        recoveredRevision: null,
        stableSnapshotId: 'stable-3',
        targetRevision: 4,
      })),
      importPack: vi.fn(),
      openProject: vi.fn(async () => ({
        currentRevision: 3,
        mode: 'write' as const,
        project: durableProject,
        projectId: durableProject.id,
        projectName: durableProject.name,
        sessionId: 'desktop-session',
        stableSnapshotId: 'stable-3',
        stableSnapshotRevision: 3,
      })),
      restore: vi.fn(async () => ({
        currentRevision: 4,
        mode: 'write' as const,
        project: restoredProject,
        projectId: durableProject.id,
        projectName: durableProject.name,
        restoredRevision: 4,
        sessionId: 'desktop-session',
        stableSnapshotId: 'desktop-after',
        stableSnapshotRevision: 4,
      })),
    };
    const client = createDesktopPersistenceClient(bridge);

    await client.openProject?.();
    const result = await client.restore('desktop-after');

    expect(bridge.restore).toHaveBeenCalledWith({ candidateId: 'candidate-opaque', sessionId: 'desktop-session' });
    expect(result.project.name).toBe('Restored from bridge');
    expect(result.revision).toBe(4);
  });

  it('keeps bridge project state when read-only desktop opens with legacy browser storage', async () => {
    const bridgeProject = { ...createStarterProject(), name: 'Desktop read-only project' };
    localStorage.setItem(PROJECT_STORAGE_KEY, JSON.stringify({
      current: { ...createStarterProject(), name: 'Stale browser draft' },
      schemaVersion: 2,
      snapshots: [],
    }));
    const bridge = {
      closeProject: vi.fn(async () => {}),
      commit: vi.fn(),
      createStablePoint: vi.fn(),
      exportPack: vi.fn(),
      getRecoveryPlan: vi.fn(async () => ({
        action: 'read_only' as const,
        candidates: [],
        issues: [],
        projectId: bridgeProject.id,
        recoveredRevision: null,
        stableSnapshotId: null,
        targetRevision: null,
      })),
      importPack: vi.fn(),
      openProject: vi.fn(async () => ({
        currentRevision: 7,
        mode: 'read_only' as const,
        project: bridgeProject,
        projectId: bridgeProject.id,
        projectName: bridgeProject.name,
        sessionId: 'desktop-session',
        stableSnapshotId: 'stable-7',
        stableSnapshotRevision: 7,
      })),
      restore: vi.fn(),
    };
    const client = createDesktopPersistenceClient(bridge);

    const result = await client.openProject?.();

    expect(result?.project.name).toBe('Desktop read-only project');
    expect(result?.saveStatus).toBe('read_only');
    expect(localStorage.getItem(PROJECT_STORAGE_KEY)).not.toBeNull();
  });

  it('binds project image operations to the hidden desktop session and advances durable state only after ACK', async () => {
    const durableProject = createStarterProject();
    const importedProject = {
      ...durableProject,
      assets: [{
        assetId: '0123456789abcdef',
        byteSize: 42,
        extension: 'png' as const,
        height: 3,
        label: 'Product',
        mediaType: 'image/png' as const,
        origin: 'imported' as const,
        sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
        width: 2,
      }],
    };
    const asset = {
      ...importedProject.assets[0]!,
      displayUrl: 'novus-asset://project/desktop-session/0123456789abcdef',
      usageCount: 1,
    };
    const projectImages = {
      importImage: vi.fn(async () => ({ asset, currentRevision: 8, project: importedProject })),
      list: vi.fn(async () => [asset]),
    };
    const bridge = {
      closeProject: vi.fn(async () => {}),
      commit: vi.fn(),
      createStablePoint: vi.fn(),
      exportPack: vi.fn(),
      getRecoveryPlan: vi.fn(async () => ({
        action: 'auto_recover' as const,
        candidates: [],
        issues: [],
        projectId: durableProject.id,
        recoveredRevision: null,
        stableSnapshotId: null,
        targetRevision: 7,
      })),
      importPack: vi.fn(),
      openProject: vi.fn(async () => ({
        currentRevision: 7,
        mode: 'write' as const,
        project: durableProject,
        projectId: durableProject.id,
        projectName: durableProject.name,
        sessionId: 'desktop-session',
        stableSnapshotId: null,
        stableSnapshotRevision: 7,
      })),
      projectImages,
      restore: vi.fn(),
    };
    const client = createDesktopPersistenceClient(bridge);
    await client.openProject?.();

    await expect(client.listProjectImages()).resolves.toEqual([asset]);
    await expect(client.importProjectImage({ kind: 'module', nodeId: 'image-input' })).resolves.toEqual({
      asset,
      project: importedProject,
      revision: 8,
    });
    expect(projectImages.list).toHaveBeenCalledWith({ sessionId: 'desktop-session' });
    expect(projectImages.importImage).toHaveBeenCalledWith({
      sessionId: 'desktop-session',
      target: { kind: 'module', nodeId: 'image-input' },
    });
  });

  it('imports a pasted desktop image file directly into the selected module without opening the native picker', async () => {
    const durableProject = createStarterProject();
    const importedProject = { ...durableProject, assets: [] };
    const asset = {
      assetId: 'fedcba9876543210',
      byteSize: 42,
      displayUrl: 'novus-asset://project/desktop-session/fedcba9876543210',
      extension: 'png' as const,
      height: 3,
      label: 'Pasted image',
      mediaType: 'image/png' as const,
      origin: 'imported' as const,
      sha256: 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
      usageCount: 1,
      width: 2,
    };
    const importDroppedMedia = vi.fn(async () => ({ asset, currentRevision: 8, project: importedProject }));
    const importImage = vi.fn();
    const bridge = {
      closeProject: vi.fn(async () => {}),
      commit: vi.fn(),
      createStablePoint: vi.fn(),
      getRecoveryPlan: vi.fn(async () => createRecoveryPlan(durableProject.id, 'stable-7', 'candidate-7', 7)),
      openProject: vi.fn(async () => createDesktopSession(durableProject, 'desktop-session', 7)),
      projectImages: { importDroppedMedia, importImage, list: vi.fn(async () => []) },
      restore: vi.fn(),
    };
    const client = createDesktopPersistenceClient(bridge as never);
    await client.openProject?.();
    const file = new File(['pasted image'], 'pasted.png', { type: 'image/png' });

    await expect(client.importProjectImage({ kind: 'module', nodeId: 'image-input' }, file)).resolves.toEqual({
      asset,
      project: importedProject,
      revision: 8,
    });
    expect(importImage).not.toHaveBeenCalled();
    expect(importDroppedMedia).toHaveBeenCalledWith({
      sessionId: 'desktop-session',
      target: expect.objectContaining({ kind: 'module', nodeId: 'image-input' }),
    }, file);
  });

  it('imports a pasted desktop Agent image directly without opening the native picker', async () => {
    const durableProject = createStarterProject();
    const importedProject = { ...durableProject, assets: [] };
    const asset = {
      assetId: 'abcdef9876543210',
      byteSize: 42,
      displayUrl: 'novus-asset://project/desktop-session/abcdef9876543210',
      extension: 'png' as const,
      height: 3,
      label: 'Pasted Agent image',
      mediaType: 'image/png' as const,
      origin: 'imported' as const,
      sha256: 'abcdef9876543210abcdef9876543210abcdef9876543210abcdef9876543210',
      usageCount: 0,
      width: 2,
    };
    const importDroppedMedia = vi.fn(async () => ({ asset, currentRevision: 8, project: importedProject }));
    const importImage = vi.fn();
    const bridge = {
      closeProject: vi.fn(async () => {}),
      commit: vi.fn(),
      createStablePoint: vi.fn(),
      getRecoveryPlan: vi.fn(async () => createRecoveryPlan(durableProject.id, 'stable-7', 'candidate-7', 7)),
      openProject: vi.fn(async () => createDesktopSession(durableProject, 'desktop-session', 7)),
      projectImages: { importDroppedMedia, importImage, list: vi.fn(async () => []) },
      restore: vi.fn(),
    };
    const client = createDesktopPersistenceClient(bridge as never);
    await client.openProject?.();
    const file = new File(['pasted image'], 'clipboard.png', { type: 'image/png' });

    await expect(client.importProjectImage({ kind: 'agent_reference' } as never, file)).resolves.toEqual({
      asset,
      project: importedProject,
      revision: 8,
    });
    expect(importImage).not.toHaveBeenCalled();
    expect(importDroppedMedia).toHaveBeenCalledWith({
      sessionId: 'desktop-session',
      target: expect.objectContaining({ kind: 'agent_reference' }),
    }, file);
  });

  it('falls back to the native bitmap clipboard for an in-memory Agent image without opening the picker', async () => {
    const durableProject = createStarterProject();
    const importedProject = { ...durableProject, assets: [] };
    const asset = {
      assetId: '1234567890abcdef', byteSize: 42, displayUrl: 'novus-asset://project/desktop-session/1234567890abcdef',
      extension: 'png' as const, height: 3, label: 'Clipboard image', mediaType: 'image/png' as const,
      origin: 'clipboard' as const, sha256: '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef', usageCount: 0, width: 2,
    };
    const importDroppedMedia = vi.fn(async () => null);
    const importImage = vi.fn();
    const pasteClipboardImage = vi.fn(async () => ({ asset, currentRevision: 8, project: importedProject }));
    const bridge = {
      closeProject: vi.fn(async () => {}), commit: vi.fn(), createStablePoint: vi.fn(),
      getRecoveryPlan: vi.fn(async () => createRecoveryPlan(durableProject.id, 'stable-7', 'candidate-7', 7)),
      openProject: vi.fn(async () => createDesktopSession(durableProject, 'desktop-session', 7)),
      projectImages: { importDroppedMedia, importImage, list: vi.fn(async () => []), pasteClipboardImage },
      restore: vi.fn(),
    };
    const client = createDesktopPersistenceClient(bridge as never);
    await client.openProject?.();
    const file = new File(['clipboard bitmap'], 'image.png', { type: 'image/png' });

    await expect(client.importProjectImage({ kind: 'agent_reference' } as never, file)).resolves.toEqual({ asset, project: importedProject, revision: 8 });
    expect(importImage).not.toHaveBeenCalled();
    expect(pasteClipboardImage).toHaveBeenCalledWith({
      sessionId: 'desktop-session', target: expect.objectContaining({ kind: 'agent_reference' }),
    });
  });
  it('creates a durable desktop project the first time an untitled canvas is saved', async () => {
    const project = { ...createStarterProject(), name: '首次保存画布' };
    const createProject = vi.fn(async (request: { project: typeof project }) => createDesktopSession(request.project, 'created-session', 0));
    const bridge = {
      closeProject: vi.fn(async () => undefined),
      commit: vi.fn(),
      createProject,
      createStablePoint: vi.fn(async () => ({ path: 'snapshot-0', reason: 'stable_point' as const, revision: 0, snapshotId: 'stable-0' })),
      getRecoveryPlan: vi.fn(async () => createRecoveryPlan(project.id, 'stable-0', 'candidate-0', 0)),
      openProject: vi.fn(),
      projectImages: { importImage: vi.fn(), list: vi.fn(async () => []) },
      restore: vi.fn(),
    };
    const client = createDesktopPersistenceClient(bridge as never);
    await client.commit({
      baseRevision: 0,
      kind: 'system',
      nextProject: project,
      previousProject: project,
      projectId: project.id,
      transaction: { id: 'save-untitled', label: 'Save untitled', operations: [] },
    });

    const saved = await client.stablePoint();

    expect(createProject).toHaveBeenCalledWith({ project });
    expect(saved).toMatchObject({ lifecycle: 'durable', revision: 0, availableSnapshotIds: ['stable-0'] });
    expect((await client.hydrate()).saveStatus).toBe('saved');
  });

  it('creates only one desktop project when first-save boundaries overlap', async () => {
    const project = { ...createStarterProject(), name: 'Concurrent first save' };
    let releaseCreate: (() => void) | undefined;
    const createGate = new Promise<void>((resolve) => { releaseCreate = resolve; });
    const createProject = vi.fn(async (request: { project: typeof project }) => {
      await createGate;
      return createDesktopSession(request.project, 'created-session', 0);
    });
    const bridge = {
      closeProject: vi.fn(async () => undefined),
      commit: vi.fn(),
      createProject,
      createStablePoint: vi.fn(async () => ({ path: 'snapshot-0', reason: 'stable_point' as const, revision: 0, snapshotId: 'stable-0' })),
      getRecoveryPlan: vi.fn(async () => createRecoveryPlan(project.id, 'stable-0', 'candidate-0', 0)),
      openProject: vi.fn(),
      projectImages: { importImage: vi.fn(), list: vi.fn(async () => []) },
      restore: vi.fn(),
    };
    const client = createDesktopPersistenceClient(bridge as never);
    const firstCommit = client.commit({
      baseRevision: 0,
      kind: 'system',
      nextProject: project,
      previousProject: project,
      projectId: project.id,
      transaction: { id: 'prepare-overlap', label: 'Prepare overlap', operations: [] },
    });

    const boundaries = Promise.all([
      client.stablePoint(),
      client.ensureModelExecutionSession?.(),
      client.stablePoint(),
    ]);
    await vi.waitFor(() => expect(createProject).toHaveBeenCalled());
    releaseCreate?.();
    await firstCommit;
    await boundaries;

    expect(createProject).toHaveBeenCalledTimes(1);
  });

  it('creates an internal desktop project before importing media into an untitled canvas', async () => {
    const asset = {
      assetId: 'abcdef0123456789', byteSize: 8, displayUrl: 'novus-asset://project/created-session/abcdef0123456789',
      extension: 'png' as const, height: 1, label: 'Dropped image', mediaType: 'image/png' as const,
      origin: 'imported' as const, sha256: `abcdef0123456789${'0'.repeat(48)}`, usageCount: 1, width: 1,
    };
    let createdProject = createStarterProject();
    const createProject = vi.fn(async (request: { project: typeof createdProject }) => {
      createdProject = request.project;
      return createDesktopSession(request.project, 'created-session', 0);
    });
    const importDroppedMedia = vi.fn(async () => ({
      asset,
      currentRevision: 1,
      project: {
        ...createdProject,
        assets: [{
          assetId: asset.assetId, byteSize: asset.byteSize, extension: asset.extension, height: asset.height,
          label: asset.label, mediaType: asset.mediaType, origin: asset.origin, sha256: asset.sha256, width: asset.width,
        }],
      },
    }));
    const bridge = {
      closeProject: vi.fn(async () => undefined),
      commit: vi.fn(),
      createProject,
      createStablePoint: vi.fn(),
      getRecoveryPlan: vi.fn(async () => createRecoveryPlan(createdProject.id, 'stable-0', 'candidate-0', 0)),
      openProject: vi.fn(),
      projectImages: { importDroppedMedia, importImage: vi.fn(), list: vi.fn(async () => []) },
      restore: vi.fn(),
    };
    const client = createDesktopPersistenceClient(bridge as never);
    const project = (await client.hydrate()).project;
    const file = new File([Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], 'drop.png', { type: 'image/png' });

    const result = await client.importDroppedMedia?.({
      file,
      operationId: 'drop-untitled-image',
      position: { x: 100, y: 120 },
    });

    expect(createProject).toHaveBeenCalledWith({ project });
    expect(importDroppedMedia).toHaveBeenCalledWith({
      sessionId: 'created-session',
      target: { kind: 'new_media_input', operationId: 'drop-untitled-image', position: { x: 100, y: 120 } },
    }, file);
    expect(result).toMatchObject({ asset, revision: 1 });
    expect(result?.project.assets).toEqual([expect.objectContaining({ assetId: asset.assetId })]);
  });

  it('reloads the active durable project without closing the session or opening a native project picker', async () => {
    const initialProject = { ...createStarterProject(), name: 'Before provider asset commit' };
    const refreshedProject = { ...initialProject, name: 'After provider asset commit' };
    const openProject = vi.fn(async () => createDesktopSession(initialProject, 'active-session', 50));
    const refreshProject = vi.fn(async () => createDesktopSession(refreshedProject, 'active-session', 51));
    const closeProject = vi.fn(async () => undefined);
    const bridge = {
      closeProject,
      commit: vi.fn(),
      createStablePoint: vi.fn(),
      getRecoveryPlan: vi.fn(async () => createRecoveryPlan(initialProject.id, 'stable-50', 'candidate-50', 50)),
      openProject,
      refreshProject,
      projectImages: { importImage: vi.fn(), list: vi.fn(async () => []) },
      restore: vi.fn(),
    };
    const client = createDesktopPersistenceClient(bridge as never);
    await client.openProject?.();

    const result = await client.reloadDurableProject?.();

    expect(refreshProject).toHaveBeenCalledWith({ sessionId: 'active-session' });
    expect(openProject).toHaveBeenCalledOnce();
    expect(closeProject).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      project: { name: 'After provider asset commit' },
      revision: 51,
      saveStatus: 'saved',
    });
  });
});

interface ReloadableDesktopClient {
  reloadDurableProject?: () => Promise<ProjectHydrationResult | null>;
}

type DesktopCommitBoundary = 'close' | 'hydrate' | 'open' | 'reload' | 'restore';
type DesktopCommitOutcome = 'failure' | 'success';

async function runDesktopCommitBoundaryRace(
  boundary: DesktopCommitBoundary,
  outcome: DesktopCommitOutcome,
) {
  const firstProject = { ...createStarterProject(), name: 'First durable project' };
  const editedFirstProject = { ...firstProject, name: 'Late first project edit' };
  const replacementProject = boundary === 'open'
    ? { ...createStarterProject(), id: 'second-project', name: 'Opened replacement project' }
    : { ...firstProject, name: boundary === 'reload' ? 'Reloaded durable project' : 'Restored durable project' };
  type CommitAck = {
    committedAt: string;
    projectId: string;
    revision: number;
    sequence: number;
    transactionId: string;
  };
  let resolveCommit!: (ack: CommitAck) => void;
  let rejectCommit!: (error: Error & { code: string }) => void;
  const commitPromise = new Promise<CommitAck>((resolve, reject) => {
    resolveCommit = resolve;
    rejectCommit = reject;
  });
  const commit = vi.fn(() => commitPromise);
  const openProject = vi.fn()
    .mockResolvedValueOnce(createDesktopSession(firstProject, 'first-session', 3));
  if (boundary === 'open') {
    openProject.mockResolvedValueOnce(createDesktopSession(replacementProject, 'second-session', 7));
  }
  const refreshProject = vi.fn(async () => createDesktopSession(replacementProject, 'first-session', 7));
  const bridge = {
    closeProject: vi.fn(async () => undefined),
    commit,
    createStablePoint: vi.fn(),
    getRecoveryPlan: vi.fn(async ({ sessionId }: { sessionId: string }) => {
      if (boundary === 'restore' && sessionId === 'first-session') {
        return createRecoveryPlan(firstProject.id, 'snapshot-after', 'candidate-after', 7);
      }
      return {
        action: 'auto_recover' as const,
        candidates: [],
        issues: [],
        projectId: sessionId === 'second-session' ? replacementProject.id : firstProject.id,
        recoveredRevision: null,
        stableSnapshotId: null,
        targetRevision: null,
      };
    }),
    openProject,
    refreshProject,
    projectImages: { importImage: vi.fn(), list: vi.fn(async () => []) },
    restore: vi.fn(async () => ({
      ...createDesktopSession(replacementProject, 'first-session', 7),
      restoredRevision: 7,
    })),
  };
  const client = createDesktopPersistenceClient(bridge as never) as ReturnType<typeof createDesktopPersistenceClient> & ReloadableDesktopClient;
  await client.openProject?.();
  const pendingCommitResult = client.commit({
    baseRevision: 3,
    kind: 'canvas',
    nextProject: editedFirstProject,
    previousProject: firstProject,
    projectId: firstProject.id,
    transaction: { id: 'tx-late-first-ack', label: 'Late first acknowledgement', operations: [] },
  });
  await vi.waitFor(() => {
    expect(commit).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'first-session' }));
  });

  switch (boundary) {
    case 'hydrate':
      await client.hydrate();
      break;
    case 'open':
      await client.openProject?.();
      break;
    case 'restore':
      await client.restore('snapshot-after');
      break;
    case 'reload':
      await client.reloadDurableProject?.();
      break;
    case 'close':
      await client.close();
      break;
  }

  if (outcome === 'success') {
    resolveCommit({
      committedAt: '2026-07-19T00:00:00.000Z',
      projectId: firstProject.id,
      revision: 4,
      sequence: 4,
      transactionId: 'tx-late-first-ack',
    });
  } else {
    const error = new Error('Durable write failed') as Error & { code: string };
    error.code = 'DISK_FULL';
    rejectCommit(error);
  }

  const commitResult = await pendingCommitResult;
  const hydrated = await client.hydrate();
  const expectedProject = boundary === 'hydrate'
    ? firstProject
    : boundary === 'close' ? null : replacementProject;
  return {
    commitResult,
    expectedLifecycle: boundary === 'close' ? 'untitled' as const : 'durable' as const,
    expectedProject,
    expectedRevision: boundary === 'hydrate' ? 3 : boundary === 'close' ? 0 : 7,
    hydrated,
  };
}

function createDesktopSession(project: ReturnType<typeof createStarterProject>, sessionId: string, revision: number) {
  return {
    currentRevision: revision,
    mode: 'write' as const,
    project,
    projectId: project.id,
    projectName: project.name,
    sessionId,
    stableSnapshotId: null,
    stableSnapshotRevision: revision,
  };
}

function createRecoveryPlan(
  projectId: string,
  snapshotId: string,
  candidateId: string,
  revision: number,
) {
  return {
    action: 'choose_recovery' as const,
    candidates: [{ candidateId, revision, snapshotId, tailStatus: 'complete' as const }],
    issues: [],
    projectId,
    recoveredRevision: null,
    stableSnapshotId: null,
    targetRevision: revision,
  };
}

  it('imports a browser Agent reference into the asset library without changing canvas nodes', async () => {
    const client = createBrowserPersistenceClient();
    const hydrated = await client.hydrate();
    const initialNodes = hydrated.project.nodes;

    const result = await client.importProjectImage(
      { kind: 'agent_reference' } as never,
      new File(['browser image'], 'agent-reference.png', { type: 'image/png' }),
    );

    expect(result).not.toBeNull();
    expect(result?.project.nodes).toEqual(initialNodes);
    expect(result?.project.assets).toEqual([expect.objectContaining({ assetId: result?.asset.assetId })]);
    expect(result?.asset.usageCount).toBe(0);
  });

  it('imports a browser Agent video reference into the asset library without changing canvas nodes', async () => {
    const client = createBrowserPersistenceClient();
    const hydrated = await client.hydrate();
    const initialNodes = hydrated.project.nodes;

    const result = await client.importAgentReferenceVideo?.(
      new File([new Uint8Array([0, 0, 0, 16, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0])], 'agent-reference.mp4', { type: 'video/mp4' }),
    );

    expect(result).not.toBeNull();
    expect(result?.project.nodes).toEqual(initialNodes);
    expect(result?.project.assets).toEqual([expect.objectContaining({ assetId: result?.asset.assetId, mediaType: 'video/mp4' })]);
    expect(result?.asset.usageCount).toBe(0);
  });
