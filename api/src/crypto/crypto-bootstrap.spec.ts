import { randomBytes } from 'node:crypto';
import { buildFieldEncryptionService } from './crypto-bootstrap';
import { wrapDek } from './key-wrapping';

describe('buildFieldEncryptionService startup wiring (PR-SEC-08, U-ENC-07)', () => {
  it('builds a working FieldEncryptionService when the DEK and blind index key differ', () => {
    const kek = randomBytes(32);
    const dek = randomBytes(32);
    const service = buildFieldEncryptionService({
      kek,
      wrappedDek: wrapDek(dek, kek),
      currentDekVersion: 1,
      blindIndexKey: randomBytes(32),
    });
    const { ciphertext, dekVersion } = service.encrypt('Jane Tan', {
      table: 'app_user',
      column: 'full_name_ct',
      rowId: 'row-1',
    });
    expect(
      service.decrypt(ciphertext, dekVersion, {
        table: 'app_user',
        column: 'full_name_ct',
        rowId: 'row-1',
      }),
    ).toBe('Jane Tan');
  });

  it('U-ENC-07: refuses to start when the blind index key equals the DEK', () => {
    const kek = randomBytes(32);
    const sharedKey = randomBytes(32);
    expect(() =>
      buildFieldEncryptionService({
        kek,
        wrappedDek: wrapDek(sharedKey, kek),
        currentDekVersion: 1,
        blindIndexKey: sharedKey,
      }),
    ).toThrow(/distinct from the DEK/);
  });
});
