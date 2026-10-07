import { describe, expect, it } from 'vitest';
import { createCanvasModuleNode, parseCanvasProject } from '@agent-canvas/domain';
import type { CanvasModuleNode, CanvasProject } from '@agent-canvas/domain';
import { createUntitledProject } from './project-factory';
import { reuseUnchangedProjectReferences } from './project-structural-sharing';

function createProject(): CanvasProject {
  return parseCanvasProject({ ...createUntitledProject(), nodes: [createCanvasModuleNode('source', 'image_input', { x: 10, y: 20 })] });
}

describe('validated project structural sharing', () => {
  it('keeps equal decoded DTO branches while publishing changed node coordinates', () => {
    const previous = createProject();
    const decoded = structuredClone(previous);
    decoded.nodes[0]!.position = { x: 30, y: 40 };
    const shared = reuseUnchangedProjectReferences(previous, decoded);
    expect(shared).toEqual(decoded);
    expect(shared).not.toBe(previous);
    expect(shared.nodes[0]).not.toBe(previous.nodes[0]);
    expect(shared.nodes[0]!.data).toBe(previous.nodes[0]!.data);
    expect(shared.edges).toBe(previous.edges);
    expect(shared.projectMemory).toBe(previous.projectMemory);
    expect(previous.nodes[0]!.position).toEqual({ x: 10, y: 20 });
  });

  it('retains additions, removals and false or empty config values', () => {
    const previous = createProject();
    (previous.nodes[0] as CanvasModuleNode).data.config = { assetId: 'a'.repeat(16), oldField: true, keep: 'same' };
    const next = structuredClone(previous);
    (next.nodes[0] as CanvasModuleNode).data.config = { keep: 'same', enabled: false, count: 0, label: '' };
    next.nodes.push(createCanvasModuleNode('added', 'text_prompt', { x: 400, y: 20 }));
    const shared = reuseUnchangedProjectReferences(previous, next);
    expect(shared).toEqual(next);
    expect((shared.nodes[0] as CanvasModuleNode).data.config).toEqual({ keep: 'same', enabled: false, count: 0, label: '' });
    expect(shared.nodes).toHaveLength(2);
    const removed = reuseUnchangedProjectReferences(shared, { ...next, nodes: [next.nodes[1]!] });
    expect(removed.nodes.map((node) => node.id)).toEqual(['added']);
    expect(removed.nodes[0]).toEqual(next.nodes[1]);
  });

  it('keeps explicit undefined fields distinct from absent fields', () => {
    const previous = createProject();
    const next = structuredClone(previous);
    next.nodes[0]!.locked = undefined;
    const added = reuseUnchangedProjectReferences(previous, next);
    expect(Object.prototype.hasOwnProperty.call(added.nodes[0]!, 'locked')).toBe(true);
    expect(added.nodes[0]).not.toBe(previous.nodes[0]);
    const deleted = structuredClone(next);
    delete deleted.nodes[0]!.locked;
    const shared = reuseUnchangedProjectReferences(added, deleted);
    expect(Object.prototype.hasOwnProperty.call(shared.nodes[0]!, 'locked')).toBe(false);
  });

  it('never reuses a prior project snapshot across project identities', () => {
    const previous = createProject();
    const next = { ...structuredClone(previous), id: 'different-project' };
    expect(reuseUnchangedProjectReferences(previous, next)).toBe(next);
    expect(next.nodes).not.toBe(previous.nodes);
  });
});

