import { useLayoutEffect, useRef } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Position, ReactFlowProvider, useStore, useStoreApi, type EdgeProps } from '@xyflow/react';
import { CanvasBezierEdge, getCanvasBezierPath } from './CanvasBezierEdge';

const edgeCoordinates = { sourceX: 100, sourceY: 80, targetX: 420, targetY: 180 };
const edgeStyle = { stroke: '#123456', strokeWidth: 2 };

function EdgeFixture({ onCancel }: { onCancel?: () => void }) {
  const store = useStoreApi();
  const root = useRef<HTMLDivElement>(null);
  const selected = useStore(state => state.edgeLookup.get('edge')?.selected === true);
  useLayoutEffect(() => {
    store.setState({ domNode: root.current, hasDefaultEdges: true });
    store.getState().setEdges([{ id: 'edge', source: 'source', target: 'target' }]);
  }, [store]);
  const props: EdgeProps = {
    id: 'edge', source: 'source', target: 'target', ...edgeCoordinates,
    sourcePosition: Position.Right, targetPosition: Position.Left,
    markerEnd: 'url(#arrow)', style: edgeStyle,
    data: onCancel === undefined ? undefined : { onCancel },
  };
  return (
    <div ref={root}>
      <svg>
        <g data-testid="edge-wrapper" data-selected={selected ? 'true' : 'false'} onClick={() => store.getState().addSelectedEdges(['edge'])}>
          <CanvasBezierEdge {...props} />
        </g>
      </svg>
      <div className="react-flow__edgelabel-renderer" />
    </div>
  );
}

function renderEdge(onCancel?: () => void) {
  return render(<ReactFlowProvider><EdgeFixture onCancel={onCancel} /></ReactFlowProvider>);
}

afterEach(cleanup);

describe('CanvasBezierEdge hit surfaces', () => {
  it('mounts one visible curve and one 20px hit surface for a disconnectable edge', () => {
    const view = renderEdge(vi.fn());
    const paths = view.container.querySelectorAll('path');
    expect(paths).toHaveLength(2);
    expect(paths[0]).toHaveAttribute('d', getCanvasBezierPath(edgeCoordinates));
    expect(paths[0]).toHaveAttribute('marker-end', 'url(#arrow)');
    expect(paths[0]).toHaveStyle(edgeStyle);
    expect(paths[1]).toHaveAttribute('d', paths[0]!.getAttribute('d'));
    expect(paths[1]).toHaveAttribute('stroke-width', '20');
    expect(paths[1]).toHaveAttribute('pointer-events', 'stroke');
  });

  it('keeps native edge selection, hover handoff, and cancellation on the retained hit surface', () => {
    const cancel = vi.fn();
    const view = renderEdge(cancel);
    const hit = view.container.querySelector('path[pointer-events="stroke"]')!;
    expect(screen.queryByRole('button', { name: '断开连接' })).not.toBeInTheDocument();
    fireEvent.click(hit);
    expect(screen.getByTestId('edge-wrapper')).toHaveAttribute('data-selected', 'true');
    fireEvent.pointerEnter(hit);
    const button = screen.getByRole('button', { name: '断开连接' });
    fireEvent.pointerLeave(hit, { relatedTarget: button });
    expect(button).toBeInTheDocument();
    fireEvent.click(button);
    expect(cancel).toHaveBeenCalledTimes(1);
    fireEvent.pointerLeave(button);
    expect(screen.queryByRole('button', { name: '断开连接' })).not.toBeInTheDocument();
  });

  it('preserves the SDK hit surface and selection for an edge without cancellation', () => {
    const view = renderEdge();
    expect(view.container.querySelectorAll('path')).toHaveLength(2);
    const hit = view.container.querySelector('.react-flow__edge-interaction')!;
    expect(hit).toHaveAttribute('stroke-width', '20');
    fireEvent.click(hit);
    expect(screen.getByTestId('edge-wrapper')).toHaveAttribute('data-selected', 'true');
    fireEvent.pointerEnter(hit);
    expect(screen.queryByRole('button', { name: '断开连接' })).not.toBeInTheDocument();
  });
});