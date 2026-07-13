import { describe, expect, it } from 'vitest';
import { toFlowEdges } from './node-types';

describe('toFlowEdges', () => {
  it('uses the agent-plan marker for animation without exposing it as UI copy', () => {
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
      animated: true,
    }]);
  });
});
