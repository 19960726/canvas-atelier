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
});
