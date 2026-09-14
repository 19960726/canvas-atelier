import { describe, expect, it } from 'vitest';
import { arrangeCanvasNodePositions, type AutoLayoutNode } from './auto-layout';

function node(id: string, moduleType: AutoLayoutNode['moduleType'], x: number, y: number): AutoLayoutNode {
  return { id, moduleType, position: { x, y } };
}

describe('arrangeCanvasNodePositions', () => {
  it('places a directed workflow in increasing dependency layers without duplicate positions', () => {
    const nodes = [
      node('result', 'reverse_result', 12, 700),
      node('source', 'image_input', 900, 20),
      node('agent', 'reverse_agent', 40, 80),
      node('other', 'image_generation', 80, 900),
    ];
    const positions = arrangeCanvasNodePositions(nodes, [
      { source: 'source', target: 'agent' },
      { source: 'agent', target: 'result' },
    ]);
    const byId = new Map(positions.map((entry) => [entry.nodeId, entry.position]));
    expect(byId.get('source')!.x).toBeLessThan(byId.get('agent')!.x);
    expect(byId.get('agent')!.x).toBeLessThan(byId.get('result')!.x);
    expect(new Set(positions.map((entry) => `${entry.position.x}:${entry.position.y}`)).size).toBe(nodes.length);
  });

  it('keeps cyclic and disconnected nodes finite and deterministic across repeated arrangements', () => {
    const nodes = [
      node('cycle-a', 'image_input', 400, 80),
      node('cycle-b', 'reverse_agent', 40, 20),
      node('free', 'video_generation', 900, 600),
    ];
    const edges = [{ source: 'cycle-a', target: 'cycle-b' }, { source: 'cycle-b', target: 'cycle-a' }];
    const first = arrangeCanvasNodePositions(nodes, edges);
    const second = arrangeCanvasNodePositions(nodes, edges);
    expect(second).toEqual(first);
    expect(first).toHaveLength(nodes.length);
    expect(first.every((entry) => Number.isFinite(entry.position.x) && Number.isFinite(entry.position.y))).toBe(true);
  });

  it('keeps independent material-generation-result workflows together instead of interleaving dependency layers', () => {
    const positions = arrangeCanvasNodePositions([
      node('source-a', 'image_input', 20, 20),
      node('generation-a', 'image_generation', 600, 20),
      node('result-a', 'result_output', 1_400, 20),
      node('source-b', 'image_input', 20, 900),
      node('generation-b', 'image_generation', 600, 900),
      node('result-b', 'result_output', 1_400, 900),
    ], [
      { source: 'source-a', target: 'generation-a' },
      { source: 'generation-a', target: 'result-a' },
      { source: 'source-b', target: 'generation-b' },
      { source: 'generation-b', target: 'result-b' },
    ]);
    const byId = new Map(positions.map((entry) => [entry.nodeId, entry.position]));
    const workflowA = ['source-a', 'generation-a', 'result-a'].map((id) => byId.get(id)!);
    const workflowB = ['source-b', 'generation-b', 'result-b'].map((id) => byId.get(id)!);

    expect(Math.max(...workflowA.map((position) => position.x))).toBeLessThan(
      Math.min(...workflowB.map((position) => position.x)),
    );
    expect(byId.get('source-a')!.x).toBeLessThan(byId.get('generation-a')!.x);
    expect(byId.get('generation-a')!.x).toBeLessThan(byId.get('result-a')!.x);
    expect(byId.get('source-b')!.x).toBeLessThan(byId.get('generation-b')!.x);
    expect(byId.get('generation-b')!.x).toBeLessThan(byId.get('result-b')!.x);
  });

  it('centers a consumer beside the material column in one connected workflow', () => {
    const sources = Array.from({ length: 5 }, (_, index) => (
      node(`source-${index + 1}`, 'image_input', 20, index * 400)
    ));
    const generation = node('generation', 'image_generation', 1_200, 120);
    const positions = arrangeCanvasNodePositions(
      [...sources, generation],
      sources.map((source) => ({ source: source.id, target: generation.id })),
    );
    const byId = new Map(positions.map((entry) => [entry.nodeId, entry.position]));
    const sourcePositions = sources.map((source) => byId.get(source.id)!);

    expect(new Set(sourcePositions.map((position) => position.x))).toHaveLength(1);
    expect(byId.get('generation')!.y).toBeGreaterThan(sourcePositions[0]!.y);
    expect(byId.get('generation')!.y).toBeLessThan(sourcePositions[sourcePositions.length - 1]!.y);
  });
});
