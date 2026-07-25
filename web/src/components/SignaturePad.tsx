import { useEffect, useRef, useState } from 'react';

/**
 * The on-system drawn-signature pad — the feature the client explicitly
 * asked to SEE (slice-11b-brief.md). A self-contained `<canvas>` capturing
 * strokes via POINTER events (works for a stylus AND a mouse/finger with one
 * code path — `pointerdown`/`pointermove`/`pointerup`, `touch-action: none`
 * so the browser never intercepts a stylus stroke as a scroll gesture). No
 * CDN script, no external asset — the CSP here is `script-src 'self'` /
 * `connect-src 'self'` with no third-party exception, so a signature-pad
 * library pulled from a CDN was never an option; this is hand-rolled.
 *
 * A blank signature is rejected client-side (`hasInk` only flips true once a
 * real stroke has been drawn) as a first line of defence — the server
 * re-validates independently with a magic-byte check on the PNG
 * (verifyJobRequestSchema / 422 `attachment-rejected`), which is the
 * authoritative check; this one exists purely so a verifier gets immediate,
 * in-the-moment feedback instead of a round trip.
 */

const PAD_HEIGHT = 180;
/** Used only as a jsdom/unit-test fallback — real browsers always report a
 * real `getBoundingClientRect` width for a laid-out element. */
const FALLBACK_WIDTH = 320;

export interface SignaturePadProps {
  onDone: (pngDataUrl: string) => void;
  onCancel?: () => void;
  disabled?: boolean;
}

function resizeCanvasToDisplaySize(canvas: HTMLCanvasElement): void {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const cssWidth = rect.width > 0 ? rect.width : FALLBACK_WIDTH;
  // Setting `.width`/`.height` clears the canvas AND resets its transform
  // matrix to identity (HTML spec) — that is exactly what we want on every
  // resize (a stale signature drawn at the old size would be meaningless at
  // the new one), and it means `ctx.scale` below never compounds.
  canvas.width = Math.max(1, Math.round(cssWidth * dpr));
  canvas.height = Math.max(1, Math.round(PAD_HEIGHT * dpr));
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.scale(dpr, dpr);
  ctx.lineWidth = 2.25;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle =
    getComputedStyle(document.documentElement).getPropertyValue('--color-ink') || '#201c16';
}

export function SignaturePad({ onDone, onCancel, disabled }: SignaturePadProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawingRef = useRef(false);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);
  const [hasInk, setHasInk] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    resizeCanvasToDisplaySize(canvas);
    const onResize = () => resizeCanvasToDisplaySize(canvas);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  function pointFromEvent(e: React.PointerEvent<HTMLCanvasElement>): { x: number; y: number } {
    const canvas = canvasRef.current;
    const rect = canvas?.getBoundingClientRect();
    return { x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0) };
  }

  function handlePointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    if (disabled) return;
    const canvas = canvasRef.current;
    canvas?.setPointerCapture?.(e.pointerId);
    const point = pointFromEvent(e);
    drawingRef.current = true;
    lastPointRef.current = point;
    setError(null);
    const ctx = canvas?.getContext('2d');
    if (ctx) {
      // A tap with no movement still leaves a visible dot — draw a
      // vanishingly short segment rather than nothing at all.
      ctx.beginPath();
      ctx.moveTo(point.x, point.y);
      ctx.lineTo(point.x + 0.01, point.y + 0.01);
      ctx.stroke();
    }
    setHasInk(true);
  }

  function handlePointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawingRef.current) return;
    const point = pointFromEvent(e);
    const ctx = canvasRef.current?.getContext('2d');
    const last = lastPointRef.current;
    if (ctx && last) {
      ctx.beginPath();
      ctx.moveTo(last.x, last.y);
      ctx.lineTo(point.x, point.y);
      ctx.stroke();
    }
    lastPointRef.current = point;
  }

  function endStroke() {
    drawingRef.current = false;
    lastPointRef.current = null;
  }

  function handleClear() {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (ctx && canvas) {
      // Clear in device pixels, ignoring the ctx.scale() applied above.
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.restore();
    }
    setHasInk(false);
    setError(null);
  }

  function handleDone() {
    if (!hasInk) {
      setError('Please sign in the box before continuing.');
      return;
    }
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dataUrl = canvas.toDataURL('image/png');
    onDone(dataUrl);
  }

  return (
    <div className="signature-pad">
      <canvas
        ref={canvasRef}
        role="img"
        aria-label="Signature pad — draw your signature with a finger, stylus or mouse"
        className="signature-pad-canvas"
        style={{ touchAction: 'none', width: '100%', height: PAD_HEIGHT }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endStroke}
        onPointerLeave={endStroke}
        onPointerCancel={endStroke}
      />
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <div className="card-row" style={{ marginTop: 'var(--space-3)' }}>
        <button type="button" onClick={handleClear} disabled={disabled}>
          Clear
        </button>
        <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
          {onCancel && (
            <button type="button" onClick={onCancel} disabled={disabled}>
              Cancel
            </button>
          )}
          <button type="button" className="btn-primary" onClick={handleDone} disabled={disabled}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
