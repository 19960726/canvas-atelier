import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCanvasModuleNode, parseCanvasProject } from '@agent-canvas/domain';
import type { CanvasModuleNode, CanvasProject } from '@agent-canvas/domain';
import { createBrowserPersistenceClient } from './desktop-persistence';
import type { ProjectCommitRequest, ProjectCommitResult } from './desktop-persistence';
import { createStarterProject, replaceProjectPersistenceClientForTests, resetAppStoreForTests, useAppStore } from './app-store';

function createPositionProject(): CanvasProject {
  const source = createCanvasModuleNode('position-source', 'image_input', { x: 10, y: 20 });
  const generation = createCanvasModuleNode('position-generation', 'image_generation', { x: 400, y: 20 });
  generation.data.config = { ...generation.data.config, prompt: 'Existing generation prompt' };
  return parseCanvasProject({
    ...createStarterProject(), nodes: [source, generation],
    edges: [{ id: 'position-reference', source: source.id, sourcePortId: 'image', target: generation.id, targetPortId: 'references', order: 0 }],
  });
}

beforeEach(() => {
  localStorage.clear();
  resetAppStoreForTests();
});

afterEach(() => {
  replaceProjectPersistenceClientForTests(createBrowserPersistenceClient());
  resetAppStoreForTests();
  localStorage.clear();
});

describe('project position commit render identity', () => {
  it('keeps unchanged graph references during a move and decoded durable acknowledgement', async () => {
    const project = createPositionProject();
    const source = project.nodes[0]!;
    const generation = project.nodes[1]!;
    let capturedRequest!: ProjectCommitRequest;
    let acknowledge!: (result: ProjectCommitResult) => void;
    const persisted = new Promise<ProjectCommitResult>((resolve) => { acknowledge = resolve; });
    replaceProjectPersistenceClientForTests({
      ...createBrowserPersistenceClient(),
      commit: (request) => { capturedRequest = request; return persisted; },
    });
    useAppStore.setState({ project, saveStatus: 'saved', undoStack: [] });

    const moved = useAppStore.getState().commitNodePositions([{ nodeId: source.id, position: { x: 35, y: 45 } }]);
    const optimistic = useAppStore.getState().project;
    acknowledge({ ok: true, project: parseCanvasProject(capturedRequest.nextProject), revision: capturedRequest.baseRevision + 1 });
    expect(await moved).toBe(true);

    expect(optimistic.nodes[0]!.position).toEqual({ x: 35, y: 45 });
    expect(optimistic.nodes[0]!.data).toBe(source.data);
    expect(optimistic.nodes[1]).toBe(generation);
    expect(optimistic.edges).toBe(project.edges);
    expect(optimistic.projectMemory).toBe(project.projectMemory);
    const acknowledged = useAppStore.getState();
    expect(acknowledged.project).toBe(optimistic);
    expect(acknowledged.saveStatus).toBe('saved');
    expect(acknowledged.undoStack).toHaveLength(1);
    expect(project.nodes[0]!.position).toEqual({ x: 10, y: 20 });
  });

  it('publishes changed node config while retaining unrelated validated graph data', async () => {
    const project = createPositionProject();
    const source = project.nodes[0]!;
    const generation = project.nodes[1] as CanvasModuleNode;
    replaceProjectPersistenceClientForTests({
      ...createBrowserPersistenceClient(),
      commit: async (request) => ({ ok: true, project: parseCanvasProject(request.nextProject), revision: request.baseRevision + 1 }),
    });
    useAppStore.setState({ project, saveStatus: 'saved', undoStack: [] });
    const changed = { ...generation, data: { ...generation.data, config: { ...generation.data.config, prompt: 'Changed generation prompt' } } };
    expect(await useAppStore.getState().commitProjectTransaction({
      id: 'change-generation-config', label: 'Change generation prompt',
      operations: [{ kind: 'canvas', operation: { kind: 'update_node', node: changed } }],
    })).toBe(true);
    const result = useAppStore.getState().project;
    expect(result.nodes[0]).toBe(source);
    expect(result.nodes[1]).not.toBe(generation);
    expect((result.nodes[1] as CanvasModuleNode).data.config.prompt).toBe('Changed generation prompt');
    expect(generation.data.config.prompt).toBe('Existing generation prompt');
    expect(result.edges).toBe(project.edges);
  });
});
