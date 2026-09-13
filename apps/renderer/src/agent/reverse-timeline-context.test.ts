import { describe, expect, it } from 'vitest';
import { formatReverseTimelineContext, selectReverseTimelineContext } from './reverse-timeline-context';

const timeline = [
  { nodeId: 'reverse-old', title: '旧反推', positivePrompt: 'old prompt' },
  { nodeId: 'reverse-current', title: '当前反推', positivePrompt: 'current prompt' },
  { nodeId: 'reverse-newest', title: '最新反推', positivePrompt: 'newest prompt' },
];

describe('reverse timeline Agent context', () => {
  it('uses selected reverse nodes instead of sending every canvas reverse result', () => {
    expect(selectReverseTimelineContext(timeline, [
      { kind: 'reverse_agent', nodeId: 'reverse-current', selected: true },
      { kind: 'reverse_agent', nodeId: 'reverse-old', selected: false },
    ])).toEqual([timeline[1]]);
  });

  it('uses only the most recently completed reverse result when the canvas has no selection', () => {
    const completionOrderedDifferently = [
      { ...timeline[2]!, completedAt: '2026-09-12T10:30:00.000Z' },
      { ...timeline[0]!, completedAt: '2026-09-12T08:30:00.000Z' },
      { ...timeline[1]!, completedAt: '2026-09-12T09:30:00.000Z' },
    ];
    expect(selectReverseTimelineContext(completionOrderedDifferently, [
      { kind: 'reverse_agent', nodeId: 'reverse-current', selected: false },
    ])).toEqual([completionOrderedDifferently[0]]);
  });

  it('does not inject an unrelated reverse result when another node type is selected', () => {
    expect(selectReverseTimelineContext(timeline, [
      { kind: 'image_generation', nodeId: 'image-current', selected: true },
    ])).toEqual([]);
  });

  it('does not fall back to the latest reverse result when a non-action canvas node is selected', () => {
    expect(selectReverseTimelineContext(timeline, [], true)).toEqual([]);
  });

  it('formats the exact visible entries into a bounded provider context', () => {
    const context = formatReverseTimelineContext([timeline[1]!]);
    expect(context).toContain('当前反推');
    expect(context).toContain('current prompt');
    expect(context).not.toContain('old prompt');
    expect(context.length).toBeLessThanOrEqual(6_000);
  });

  it('fits reverse context into the remaining provider-message budget without returning a partial header', () => {
    const context = formatReverseTimelineContext([{ ...timeline[1]!, positivePrompt: 'detail '.repeat(2_000) }], 900);
    expect(context).toContain('【当前反推节点上下文】');
    expect(context.length).toBeLessThanOrEqual(900);
    expect(formatReverseTimelineContext([timeline[1]!], 20)).toBe('');
  });
});
