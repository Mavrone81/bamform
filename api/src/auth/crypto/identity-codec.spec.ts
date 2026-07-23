import { randomBytes } from 'node:crypto';
import { decodeIdentityField, encodeIdentityField } from './identity-codec';
import { FieldEncryptionService } from '../../crypto/field-encryption';

/**
 * Slice 3 replaces the TEMPORARY plaintext passthrough (slice 2) with real
 * AES-256-GCM field encryption (PR-106/107). These tests exercise this file as the
 * thin `app_user` adapter it now is — the crypto primitive itself is unit-tested in
 * `../../crypto/field-encryption.spec.ts` (U-ENC-01..04, U-ENC-08).
 */
describe('identity codec (app_user personal-column adapter over FieldEncryptionService)', () => {
  function makeFieldEncryption(): FieldEncryptionService {
    return new FieldEncryptionService(new Map([[1, randomBytes(32)]]), 1);
  }

  it('round-trips a UTF-8 string through encode/decode', () => {
    const fieldEncryption = makeFieldEncryption();
    const context = { column: 'full_name_ct' as const, rowId: 'row-1' };
    const { ciphertext, dekVersion } = encodeIdentityField('Jane Tan 陈', context, fieldEncryption);
    expect(ciphertext).toBeInstanceOf(Buffer);
    expect(decodeIdentityField(ciphertext, dekVersion, context, fieldEncryption)).toBe(
      'Jane Tan 陈',
    );
  });

  it('does not store plaintext bytes — ciphertext must not contain the plaintext', () => {
    const fieldEncryption = makeFieldEncryption();
    const context = { column: 'email_ct' as const, rowId: 'row-1' };
    const { ciphertext } = encodeIdentityField('tech@bevorasg.com', context, fieldEncryption);
    expect(ciphertext.toString('utf8')).not.toContain('tech@bevorasg.com');
  });

  it('binds to the row id — decoding under a different rowId fails (AAD binding, U-ENC-03)', () => {
    const fieldEncryption = makeFieldEncryption();
    const { ciphertext, dekVersion } = encodeIdentityField(
      'Jane Tan',
      {
        column: 'full_name_ct',
        rowId: 'row-1',
      },
      fieldEncryption,
    );
    expect(() =>
      decodeIdentityField(
        ciphertext,
        dekVersion,
        { column: 'full_name_ct', rowId: 'row-2' },
        fieldEncryption,
      ),
    ).toThrow();
  });

  it('binds to the column — decoding under a different column fails', () => {
    const fieldEncryption = makeFieldEncryption();
    const { ciphertext, dekVersion } = encodeIdentityField(
      'Jane Tan',
      {
        column: 'full_name_ct',
        rowId: 'row-1',
      },
      fieldEncryption,
    );
    expect(() =>
      decodeIdentityField(
        ciphertext,
        dekVersion,
        { column: 'employee_id_ct', rowId: 'row-1' },
        fieldEncryption,
      ),
    ).toThrow();
  });
});
