/// <reference types="@testing-library/jest-dom/vitest" />
import { afterEach, describe, expect, it } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { QrCode } from './QrCode';
import { encodeQr } from '../lib/qrcode';

/**
 * U-QR-08..10 — review finding I-1.
 *
 * `encodeQr` throws on an empty payload and on anything past the 213-byte
 * capacity of a version-10 level-M symbol. There is no error boundary between
 * this component and the React root, so a throw out of render unmounts the
 * WHOLE app — including the manual setup key that is supposed to be the
 * fallback, because it is a sibling in the same destroyed subtree. Enrolment
 * is mandatory, so the account is then locked out of an app that shows a blank
 * tab, and a reload reproduces it.
 *
 * These tests therefore assert the fallback is IN THE DOM, not merely that
 * nothing threw: "it did not crash" would pass on an empty render, which is
 * the failure being fixed.
 */

const SIBLING = 'the manual setup key';

/** The api's real builder (`api/src/auth/mfa/totp.ts#buildOtpauthUri`) with a
 * long distribution-style local part — 87 characters is where a real address
 * pushes the URI past the encoder's 213-byte ceiling. Not a synthetic string:
 * it is the production shape, at production's own breaking point. */
const OVER_LENGTH_URI = `otpauth://totp/BamForm:${encodeURIComponent(`${'a'.repeat(87)}@bevorasg.com`)}?secret=${'A'.repeat(32)}&issuer=BamForm&algorithm=SHA1&digits=6&period=30`;

function renderWithSibling(value: string) {
  return render(
    <div>
      <QrCode value={value} describedBy="mfa-manual-entry" />
      <p id="mfa-manual-entry">{SIBLING}</p>
    </div>,
  );
}

afterEach(cleanup);

describe('QrCode', () => {
  it('U-QR-08: the payload used here really is past the encoder ceiling', () => {
    // Guards the two tests below from silently becoming vacuous if the
    // capacity ever changes: they must be exercising the throwing path.
    expect(new TextEncoder().encode(OVER_LENGTH_URI).length).toBeGreaterThan(213);
    expect(() => encodeQr(OVER_LENGTH_URI)).toThrow(/exceeds the 213-byte capacity/);
  });

  it('U-QR-09: an over-length URI degrades to a message and leaves the setup key standing', () => {
    renderWithSibling(OVER_LENGTH_URI);

    // The QR is gone...
    expect(screen.queryByRole('img', { name: /QR code/i })).toBeNull();
    // ...replaced by something that tells the user what to do instead...
    expect(screen.getByRole('alert')).toHaveTextContent(/could not be drawn/i);
    expect(screen.getByRole('alert')).toHaveTextContent(/setup key below/i);
    // ...and the fallback the user actually needs is still rendered, which is
    // the whole point: before this fix the throw took it with it.
    expect(screen.getByText(SIBLING)).toBeInTheDocument();
  });

  it('U-QR-10: an empty payload degrades the same way rather than unmounting', () => {
    renderWithSibling('');

    expect(screen.queryByRole('img', { name: /QR code/i })).toBeNull();
    expect(screen.getByRole('alert')).toHaveTextContent(/could not be drawn/i);
    expect(screen.getByText(SIBLING)).toBeInTheDocument();
  });

  it('U-QR-11: a normal URI still renders the symbol — the guard swallows failures, not output', () => {
    renderWithSibling(
      'otpauth://totp/BamForm:admin%40bevorasg.com?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=BamForm&algorithm=SHA1&digits=6&period=30',
    );

    const symbol = screen.getByRole('img', { name: /QR code/i });
    expect(symbol).toHaveAttribute('aria-describedby', 'mfa-manual-entry');
    expect(symbol.querySelector('path')?.getAttribute('d')).toMatch(/^M/);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
