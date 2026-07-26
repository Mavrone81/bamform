import { useMemo } from 'react';
import { encodeQr, toSvgPath } from '../lib/qrcode';

/**
 * Renders an `otpauth://` URI as a scannable QR symbol.
 *
 * A11y (brief §5): a QR image is meaningless to a screen-reader or to anyone
 * whose camera cannot focus, so this is `role="img"` with a name that says
 * what it IS, and `aria-describedby` points at the manual-entry key rendered
 * beside it. The key is the text alternative — not decoration — because it is
 * the only other way to complete enrolment.
 *
 * The symbol is one inline `<path>` of pure geometry: no external image, no
 * data: URI, no canvas, nothing for the app's CSP to block and nothing that
 * can be fetched over the network. `currentColor` keeps it correct in both
 * themes and in forced-colours mode.
 *
 * ⚠️ `value` contains the TOTP shared secret. It is never logged, never
 * stored, and is not put in any attribute a devtools DOM dump would surface
 * beyond the geometry itself.
 */
export function QrCode({
  value,
  describedBy,
  size = 220,
}: {
  value: string;
  /** Id of the element carrying the manual-entry fallback. */
  describedBy?: string;
  /** Rendered edge length in CSS pixels. */
  size?: number;
}) {
  const svg = useMemo(() => {
    const matrix = encodeQr(value);
    return toSvgPath(matrix);
  }, [value]);

  return (
    <svg
      className="qr-code"
      role="img"
      aria-label="QR code for setting up your authenticator app"
      aria-describedby={describedBy}
      width={size}
      height={size}
      viewBox={`0 0 ${svg.viewBoxSize} ${svg.viewBoxSize}`}
      shapeRendering="crispEdges"
    >
      {/* The quiet zone must be light for the symbol to scan, so the
       * background is painted explicitly rather than inherited. */}
      <rect width={svg.viewBoxSize} height={svg.viewBoxSize} fill="#ffffff" />
      <path d={svg.path} fill="#000000" />
    </svg>
  );
}
