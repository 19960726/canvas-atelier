import { describe, expect, it } from 'vitest';
import { toFlowEdges } from './node-types';

describe('toFlowEdges', () => {
  it('hides the internal agent-plan marker without animating persisted edges', () => {
    expect(toFlowEdges([{
      id: 'edge-1',
      source: 'source-1',
      target: 'target-1',
      label: 'agent-plan',
    }])).toEqual([{
      id: 'edge-1',
      source: 'source-1',
      target: 'target-1',
      label: undefined,
      animated: false,
    }]);
  });

  it('does not animate ordinary persisted Agent edges', () => {
    expect(toFlowEdges([{ id: 'applied', source: 'a', target: 'b' }])[0]?.animated).toBe(false);
  });
});
