import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createPortal } from 'react-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleNodeWheelCapture } from './node-wheel-routing';

afterEach(cleanup);

describe('node wheel routing', () => {
  it('keeps editable controls and menus local without cancelling their native scrolling', () => {
    const canvasWheel = vi.fn();
    render(<div onWheel={canvasWheel}><article onWheelCapture={handleNodeWheelCapture}>
      <textarea aria-label="Prompt" />
      <input aria-label="Strength" type="range" />
      <select aria-label="Model"><option>Model</option></select>
      <div contentEditable suppressContentEditableWarning aria-label="Mention editor"><span>Editable text</span></div>
      <video controls aria-label="Video controls" />
      <div role="menu"><button>Menu item</button></div>
      <div role="dialog"><button>Dialog item</button></div>
    </article></div>);
    for (const target of [
      screen.getByLabelText('Prompt'), screen.getByLabelText('Strength'), screen.getByLabelText('Model'),
      screen.getByText('Editable text'), screen.getByLabelText('Video controls'), screen.getByText('Menu item'), screen.getByText('Dialog item'),
    ]) {
      expect(fireEvent.wheel(target, { deltaY: 120, cancelable: true })).toBe(true);
    }
    expect(canvasWheel).not.toHaveBeenCalled();
  });

  it('protects real overflow areas even at their scroll boundary and lets nonoverflowing previews zoom', () => {
    const canvasWheel = vi.fn();
    render(<div onWheel={canvasWheel}><article onWheelCapture={handleNodeWheelCapture}>
      <div data-testid="scroll" style={{ overflowY: 'auto' }}><span>Result detail</span></div>
      <button>Image preview</button>
      <video aria-label="Video preview" />
    </article></div>);
    const scroll = screen.getByTestId('scroll');
    Object.defineProperties(scroll, { clientHeight: { value: 100 }, scrollHeight: { configurable: true, value: 300 } });
    scroll.scrollTop = 200;
    fireEvent.wheel(screen.getByText('Result detail'), { deltaY: 120 });
    expect(canvasWheel).not.toHaveBeenCalled();
    Object.defineProperty(scroll, 'scrollHeight', { value: 100 });
    fireEvent.wheel(screen.getByText('Result detail'), { deltaY: 120 });
    fireEvent.wheel(screen.getByText('Image preview'), { deltaY: -120 });
    fireEvent.wheel(screen.getByLabelText('Video preview'), { deltaY: -120 });
    expect(canvasWheel).toHaveBeenCalledTimes(3);
  });

  it('leaves explicit nowheel boundaries and portal wheel handlers in control', () => {
    const trayWheel = vi.fn();
    const portalWheel = vi.fn();
    render(<article onWheelCapture={handleNodeWheelCapture}>
      <div className="nowheel" onWheel={trayWheel}><button>Tray item</button></div>
      {createPortal(<div role="dialog" onWheel={portalWheel}>Image detail viewer</div>, document.body)}
    </article>);
    fireEvent.wheel(screen.getByText('Tray item'), { deltaY: 120 });
    fireEvent.wheel(screen.getByText('Image detail viewer'), { deltaY: -120 });
    expect(trayWheel).toHaveBeenCalledOnce();
    expect(portalWheel).toHaveBeenCalledOnce();
  });
});
