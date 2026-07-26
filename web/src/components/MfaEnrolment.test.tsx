/// <reference types="@testing-library/jest-dom/vitest" />
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MfaEnrolment } from './MfaEnrolment';
import { beginMfaEnrolment, confirmMfaEnrolment } from '../auth';

vi.mock('../auth', () => ({
  beginMfaEnrolment: vi.fn(),
  confirmMfaEnrolment: vi.fn(),
}));

/**
 * U-ENROL-01/02 — review finding I-1, at the layer the finding is about.
 *
 * `QrCode.test.tsx` proves the component contains its own encoder failure.
 * This proves the consequence that actually matters: with a QR that cannot be
 * drawn, the screen a locked-out user is stuck on is still a screen they can
 * finish enrolment from — the setup key, the code field and the confirm button
 * are all present and working. Mandatory enrolment plus a white screen was the
 * lock-out; mandatory enrolment plus a typed-in key is an inconvenience.
 */

const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';

/** Production's own URI shape (`api/src/auth/mfa/totp.ts#buildOtpauthUri`)
 * for an 87-character local part, which is where it crosses the encoder's
 * 213-byte ceiling. */
const OVER_LENGTH_URI = `otpauth://totp/BamForm:${encodeURIComponent(`${'a'.repeat(87)}@bevorasg.com`)}?secret=${SECRET}&issuer=BamForm&algorithm=SHA1&digits=6&period=30`;

const SHORT_URI = `otpauth://totp/BamForm:admin%40bevorasg.com?secret=${SECRET}&issuer=BamForm&algorithm=SHA1&digits=6&period=30`;

function mockEnrolment(otpauthUri: string) {
  vi.mocked(beginMfaEnrolment).mockResolvedValue({
    ok: true,
    status: 200,
    value: { secret: SECRET, otpauthUri },
  });
  vi.mocked(confirmMfaEnrolment).mockResolvedValue({
    ok: true,
    status: 200,
    value: { recoveryCodes: [], auth: null },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(cleanup);

describe('MfaEnrolment', () => {
  it('U-ENROL-01: an undrawable QR still leaves a completable enrolment screen', async () => {
    mockEnrolment(OVER_LENGTH_URI);

    render(<MfaEnrolment onBlocked={vi.fn()} />);

    // The screen came up at all — before the fix this render threw and took
    // the React root with it.
    expect(await screen.findByRole('heading', { name: 'Set up your authenticator' })).toBeVisible();
    expect(screen.queryByRole('img', { name: /QR code/i })).toBeNull();
    expect(screen.getByRole('alert')).toHaveTextContent(/could not be drawn/i);

    // Everything enrolment needs without a camera is still here.
    expect(screen.getByText(SECRET)).toBeInTheDocument();
    const field = screen.getByLabelText(/6-digit code/i);
    fireEvent.change(field, { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: /Confirm and finish signing in/i }));

    expect(vi.mocked(confirmMfaEnrolment)).toHaveBeenCalledWith('123456');
  });

  it('U-ENROL-02: the ordinary case is unchanged — the QR and the key are both there', async () => {
    mockEnrolment(SHORT_URI);

    render(<MfaEnrolment onBlocked={vi.fn()} />);

    expect(await screen.findByRole('img', { name: /QR code/i })).toBeVisible();
    expect(screen.getByText(SECRET)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
