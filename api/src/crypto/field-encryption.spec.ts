import { randomBytes } from 'node:crypto';
import { FieldEncryptionService, type FieldContext } from './field-encryption';

const userContext = (rowId: string): FieldContext => ({
  table: 'app_user',
  column: 'full_name_ct',
  rowId,
});

describe('FieldEncryptionService (PR-106, TEST_PLAN §5.5)', () => {
  function makeService(currentVersion = 1): FieldEncryptionService {
    const map = new Map<number, Buffer>([[currentVersion, randomBytes(32)]]);
    return new FieldEncryptionService(map, currentVersion);
  }

  it('U-ENC-01: round-trips a name — plaintext recovered', () => {
    const service = makeService();
    const rowId = 'row-1';
    const { ciphertext, dekVersion } = service.encrypt('Jane Tan', userContext(rowId));
    expect(service.decrypt(ciphertext, dekVersion, userContext(rowId))).toBe('Jane Tan');
  });

  it('U-ENC-02: same plaintext encrypted twice — different ciphertext (unique nonce)', () => {
    const service = makeService();
    const ctx = userContext('row-1');
    const a = service.encrypt('Jane Tan', ctx);
    const b = service.encrypt('Jane Tan', ctx);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
    // but both still decrypt to the same plaintext
    expect(service.decrypt(a.ciphertext, a.dekVersion, ctx)).toBe('Jane Tan');
    expect(service.decrypt(b.ciphertext, b.dekVersion, ctx)).toBe('Jane Tan');
  });

  it("U-ENC-03: ciphertext moved to another row's PK — decryption FAILS (AAD binding)", () => {
    const service = makeService();
    const { ciphertext, dekVersion } = service.encrypt('Jane Tan', userContext('row-1'));
    expect(() => service.decrypt(ciphertext, dekVersion, userContext('row-2'))).toThrow();
  });

  it('extends AAD binding to the column, not just the row: moving between columns of the SAME row also fails', () => {
    const service = makeService();
    const rowId = 'row-1';
    const { ciphertext, dekVersion } = service.encrypt('Jane Tan', {
      table: 'app_user',
      column: 'full_name_ct',
      rowId,
    });
    expect(() =>
      service.decrypt(ciphertext, dekVersion, { table: 'app_user', column: 'email_ct', rowId }),
    ).toThrow();
  });

  it('U-ENC-04: tampered ciphertext — GCM auth tag rejects', () => {
    const service = makeService();
    const ctx = userContext('row-1');
    const { ciphertext, dekVersion } = service.encrypt('Jane Tan', ctx);
    const tampered = Buffer.from(ciphertext);
    tampered[tampered.length - 1] ^= 0xff; // flip a bit inside the auth tag
    expect(() => service.decrypt(tampered, dekVersion, ctx)).toThrow();
  });

  it('U-ENC-08: a row encrypted at dek_version=1 still decrypts after rotation to version 2', () => {
    const v1Key = randomBytes(32);
    const v2Key = randomBytes(32);
    const before = new FieldEncryptionService(new Map([[1, v1Key]]), 1);
    const ctx = userContext('row-1');
    const { ciphertext, dekVersion } = before.encrypt('Jane Tan', ctx);
    expect(dekVersion).toBe(1);

    // "rotation" — the running service now knows about v2 as current, but retains v1
    // (PR-SEC-10: every DEK generation retained indefinitely).
    const afterRotation = new FieldEncryptionService(
      new Map([
        [1, v1Key],
        [2, v2Key],
      ]),
      2,
    );
    expect(afterRotation.decrypt(ciphertext, dekVersion, ctx)).toBe('Jane Tan');

    // new writes use the new version
    const { dekVersion: newVersion } = afterRotation.encrypt('New User', ctx);
    expect(newVersion).toBe(2);
  });

  it('key-absence handling: decrypting a row whose dek_version has no corresponding key throws a clear error', () => {
    const service = makeService(1);
    const ctx = userContext('row-1');
    expect(() => service.decrypt(randomBytes(40), 99, ctx)).toThrow(
      /No DEK available for version 99/,
    );
  });

  it('refuses to construct without a key for the configured current DEK version', () => {
    expect(() => new FieldEncryptionService(new Map([[1, randomBytes(32)]]), 2)).toThrow(
      /current version 2/,
    );
  });

  it('refuses a DEK that is not 32 bytes', () => {
    expect(() => new FieldEncryptionService(new Map([[1, randomBytes(16)]]), 1)).toThrow(
      /32 bytes/,
    );
  });

  it('rejects ciphertext too short to contain nonce+tag', () => {
    const service = makeService();
    expect(() => service.decrypt(Buffer.alloc(4), 1, userContext('row-1'))).toThrow();
  });
});
