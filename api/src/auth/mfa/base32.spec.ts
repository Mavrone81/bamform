import { base32Decode, base32Encode } from './base32';

/**
 * U-MFA-01 — RFC 4648 §10 base32 test vectors. The TOTP shared secret is
 * exchanged with the authenticator app as base32 (`otpauth://` URI), so a
 * wrong alphabet or a wrong bit-packing order produces a secret the app
 * silently disagrees with — every code would then be "wrong" with no
 * diagnosable error. These are the published vectors, not our own.
 */
describe('U-MFA-01 base32 (RFC 4648, no padding)', () => {
  const VECTORS: ReadonlyArray<[string, string]> = [
    ['', ''],
    ['f', 'MY'],
    ['fo', 'MZXQ'],
    ['foo', 'MZXW6'],
    ['foob', 'MZXW6YQ'],
    ['fooba', 'MZXW6YTB'],
    ['foobar', 'MZXW6YTBOI'],
  ];

  it.each(VECTORS)('encodes %p as %p', (plain, encoded) => {
    expect(base32Encode(Buffer.from(plain, 'ascii'))).toBe(encoded);
  });

  it.each(VECTORS)('decodes the encoding of %p back to %p', (plain, encoded) => {
    expect(base32Decode(encoded).toString('ascii')).toBe(plain);
  });

  it('emits no padding characters (the otpauth URI form)', () => {
    expect(base32Encode(Buffer.from('foobar', 'ascii'))).not.toContain('=');
  });

  it('round-trips a 20-byte (160-bit) secret, the size TOTP enrolment issues', () => {
    const secret = Buffer.from('0123456789abcdefghij', 'ascii');
    expect(base32Decode(base32Encode(secret)).equals(secret)).toBe(true);
  });

  it('tolerates lowercase, padding and separators on decode (users retype secrets by hand)', () => {
    expect(base32Decode('mzxw6ytboi').toString('ascii')).toBe('foobar');
    expect(base32Decode('MZXW6YTBOI======').toString('ascii')).toBe('foobar');
    expect(base32Decode('MZXW 6YTB-OI').toString('ascii')).toBe('foobar');
  });

  it('rejects a character outside the RFC 4648 alphabet', () => {
    expect(() => base32Decode('MZXW6YTB01')).toThrow(/base32/i);
  });
});
