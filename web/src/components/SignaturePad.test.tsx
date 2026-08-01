/// <reference types="@testing-library/jest-dom/vitest" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { SignaturePad } from './SignaturePad';

/**
 * jsdom has no real rendering pipeline — `HTMLCanvasElement#getContext`
 * returns `null` and `getBoundingClientRect` reports a 0x0 rect by default.
 * This stubs just enough of the Canvas 2D API for the component's drawing
 * calls to run without throwing, and gives the canvas a non-zero laid-out
 * width so the component's resize logic behaves as it would in a real
 * browser. This is the standard way to unit test canvas-drawing code in
 * jsdom — it does not weaken what's being asserted below, which is the
 * component's OWN logic (blank-rejection, export-on-Done), not the pixels
 * a real browser would rasterize.
 */
function stubCanvas(): { toDataURL: ReturnType<typeof vi.fn> } {
  const ctx = {
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    clearRect: vi.fn(),
    scale: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    setTransform: vi.fn(),
    lineWidth: 0,
    lineCap: '',
    lineJoin: '',
    strokeStyle: '',
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
    ctx as unknown as CanvasRenderingContext2D,
  );
  const toDataURL = vi
    .fn()
    .mockReturnValue('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB');
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(toDataURL);
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 343,
    bottom: 180,
    width: 343,
    height: 180,
    toJSON: () => ({}),
  });
  return { toDataURL };
}

function pointerDown(canvas: Element, x: number, y: number, pointerType = 'mouse', pointerId = 1) {
  act(() => {
    fireEvent.pointerDown(canvas, { pointerId, pointerType, clientX: x, clientY: y });
  });
}

function pointerMove(canvas: Element, x: number, y: number, pointerType = 'mouse', pointerId = 1) {
  act(() => {
    fireEvent.pointerMove(canvas, { pointerId, pointerType, clientX: x, clientY: y });
  });
}

function pointerUp(canvas: Element, pointerType = 'mouse', pointerId = 1) {
  act(() => {
    fireEvent.pointerUp(canvas, { pointerId, pointerType });
  });
}

function click(element: Element) {
  act(() => {
    fireEvent.click(element);
  });
}

beforeEach(() => {
  stubCanvas();
  // jsdom canvases don't implement `setPointerCapture` at all.
  HTMLCanvasElement.prototype.setPointerCapture = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

describe('SignaturePad', () => {
  it('rejects Done with no stroke drawn (blank signature)', () => {
    const onDone = vi.fn();
    render(<SignaturePad onDone={onDone} />);

    click(screen.getByRole('button', { name: 'Done' }));

    expect(onDone).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/sign in the box/i);
  });

  it('exports a non-empty PNG data-URL once a stroke has been drawn, via pointer events', () => {
    const onDone = vi.fn();
    render(<SignaturePad onDone={onDone} />);
    const canvas = screen.getByRole('img', { name: /signature pad/i });

    pointerDown(canvas, 10, 10);
    pointerMove(canvas, 40, 40);
    pointerUp(canvas);

    click(screen.getByRole('button', { name: 'Done' }));

    expect(onDone).toHaveBeenCalledTimes(1);
    const [dataUrl] = onDone.mock.calls[0];
    expect(dataUrl).toMatch(/^data:image\/png;base64,/);
    expect(dataUrl.length).toBeGreaterThan('data:image/png;base64,'.length);
  });

  it('a single tap with no movement still counts as ink (a dot is a mark)', () => {
    const onDone = vi.fn();
    render(<SignaturePad onDone={onDone} />);
    const canvas = screen.getByRole('img', { name: /signature pad/i });

    pointerDown(canvas, 20, 20);
    pointerUp(canvas);

    click(screen.getByRole('button', { name: 'Done' }));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  /**
   * The owner could not sign with a FINGER on a real iPhone (2026-07-28),
   * while every existing test above drove the pad with a synthetic mouse-type
   * pointer — so touch was never exercised and this class of failure was
   * invisible to the whole suite. Two causes were fixed; both are pinned here.
   */
  describe('touch input (iOS)', () => {
    it('draws from touch-type pointers, not just mouse', () => {
      const onDone = vi.fn();
      render(<SignaturePad onDone={onDone} />);
      const canvas = screen.getByRole('img', { name: /signature pad/i });

      pointerDown(canvas, 12, 12, 'touch');
      pointerMove(canvas, 60, 50, 'touch');
      pointerUp(canvas, 'touch');

      click(screen.getByRole('button', { name: 'Done' }));
      expect(onDone).toHaveBeenCalledTimes(1);
    });

    it('still draws when setPointerCapture THROWS — WebKit does this for touch pointers', () => {
      // An uncaught throw aborted handlePointerDown before any ink was laid:
      // no dot, no stroke, and Done then rejected the signature as blank —
      // precisely the reported symptom. Capture is an optimisation, never a
      // precondition.
      const onDone = vi.fn();
      render(<SignaturePad onDone={onDone} />);
      const canvas = screen.getByRole('img', { name: /signature pad/i }) as HTMLCanvasElement;
      canvas.setPointerCapture = () => {
        throw new DOMException('InvalidPointerId', 'NotFoundError');
      };

      pointerDown(canvas, 15, 15, 'touch');
      pointerMove(canvas, 70, 60, 'touch');
      pointerUp(canvas, 'touch');

      click(screen.getByRole('button', { name: 'Done' }));
      expect(onDone).toHaveBeenCalledTimes(1);
    });

    it('preventDefaults raw touch events so iOS cannot steal the stroke as a scroll', () => {
      // touch-action:none is not sufficient on iOS: WebKit still runs its own
      // gesture recognition and, once it claims the drag, fires pointercancel
      // and stops sending pointermove. The listener must be NON-PASSIVE —
      // React's onTouchMove prop registers passively and preventDefault there
      // is silently ignored, which is why this is an explicit addEventListener.
      render(<SignaturePad onDone={vi.fn()} />);
      const canvas = screen.getByRole('img', { name: /signature pad/i });

      const move = new Event('touchmove', { bubbles: true, cancelable: true });
      canvas.dispatchEvent(move);
      expect(move.defaultPrevented).toBe(true);

      const start = new Event('touchstart', { bubbles: true, cancelable: true });
      canvas.dispatchEvent(start);
      expect(start.defaultPrevented).toBe(true);
    });
  });

  it('Clear erases the stroke — Done afterwards is rejected as blank again', () => {
    const onDone = vi.fn();
    render(<SignaturePad onDone={onDone} />);
    const canvas = screen.getByRole('img', { name: /signature pad/i });

    pointerDown(canvas, 10, 10);
    pointerMove(canvas, 30, 30);
    pointerUp(canvas);

    click(screen.getByRole('button', { name: 'Clear' }));
    click(screen.getByRole('button', { name: 'Done' }));

    expect(onDone).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('calls onCancel when the Cancel button is present and clicked', () => {
    const onDone = vi.fn();
    const onCancel = vi.fn();
    render(<SignaturePad onDone={onDone} onCancel={onCancel} />);

    click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('disables Clear/Done/Cancel while `disabled` is true', () => {
    render(<SignaturePad onDone={vi.fn()} onCancel={vi.fn()} disabled />);
    expect(screen.getByRole('button', { name: 'Clear' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Done' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  });
});
