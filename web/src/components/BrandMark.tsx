/**
 * The BamForm mark (slice 14-DESIGN): a hex nut — the universal glyph of
 * maintenance — struck through with a verification check. Drawn inline so
 * the shell and sign-in screen need no asset fetch; `public/icon.svg` is the
 * same geometry exported for the manifest/home-screen icon set.
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" className={className} aria-hidden="true" focusable="false">
      <rect width="48" height="48" rx="8" fill="#16191d" />
      <path
        d="M24 6.5 L39 15 V33 L24 41.5 L9 33 V15 Z"
        fill="none"
        stroke="#f5b82e"
        strokeWidth="3"
        strokeLinejoin="round"
      />
      <path
        d="M16.5 24.5 L22 30 L32 18.5"
        fill="none"
        stroke="#ffffff"
        strokeWidth="4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
