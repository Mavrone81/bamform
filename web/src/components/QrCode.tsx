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
 * can be fetched over the network. Its two colours are hardcoded black on
 * white rather than inherited: a QR symbol needs that contrast and polarity
 * to scan at all, so it deliberately does NOT follow the theme (and will not
 * adapt in forced-colours mode either) — review finding m2.
 *
 * ⚠️ `value` contains the TOTP shared secret. It is never logged, never
 * stored, and is not put in any attribute a devtools DOM dump would surface
 * beyond the geometry itself. That is also why the encoder failure below is
 * swallowed rather than reported: its message would carry nothing sensitive
 * today, but nothing on this path may ever reach a console.
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
  // `encodeQr` throws on an empty payload and on anything past the 213-byte
  // capacity of a version-10 level-M symbol — reachable in production with a
  // long enough email local part (the `otpauth://` URI crosses 213 bytes at
  // 87 characters). A throw here is NOT a broken picture: React has no error
  // boundary between this component and the root, so it would unmount the
  // whole app, taking the manual setup key rendered beside it down too and
  // locking that account out of a mandatory enrolment (review finding I-1).
  // Contained here instead, so the QR is the only thing lost.
  const svg = useMemo(() => {
    try {
      return toSvgPath(encodeQr(value));
    } catch {
      return null;
    }
  }, [value]);

  if (!svg) {
    return (
      <p className="field-error" role="alert">
        This QR code could not be drawn. Add the account by hand with the setup key below — it works
        exactly the same way.
      </p>
    );
  }

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
