import { computeEmailBlindIndex } from '../../src/auth/crypto/blind-index';
import { decodeIdentityField } from '../../src/auth/crypto/identity-codec';
import {
  createLoginableUser,
  loadBlindIndexKey,
  loadFieldEncryptionService,
} from './helpers/auth-fixtures';
import { adminPool, closeAll, resetDatabase } from './helpers/db';

/**
 * PR-106/108, TEST_PLAN §5.5 U-ENC-03/05/06 run against REAL Postgres — the pure
 * unit-level equivalents in `src/crypto/field-encryption.spec.ts` and
 * `src/auth/crypto/blind-index.spec.ts` prove the primitives in isolation; these
 * prove the whole path (encrypt → real INSERT → real SELECT → decrypt / lookup)
 * behaves the same way against actual stored ciphertext, not just in-memory buffers.
 */
describe('field encryption against real Postgres (PR-106, PR-108)', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closeAll();
  });

  it('round-trips: encrypt at fixture time, read raw ciphertext back, decrypt to the original plaintext', async () => {
    const { userId } = await createLoginableUser({
      email: 'roundtrip@bevorasg.com',
      password: 'CorrectHorseBattery1!',
      fullName: 'Round Trip User',
    });

    const row = await adminPool.query(
      `SELECT "full_name_ct", "email_ct", "dek_version" FROM "app_user" WHERE "id" = $1`,
      [userId],
    );
    const fieldEncryption = loadFieldEncryptionService();
    const fullName = decodeIdentityField(
      row.rows[0].full_name_ct,
      row.rows[0].dek_version,
      { column: 'full_name_ct', rowId: userId },
      fieldEncryption,
    );
    const email = decodeIdentityField(
      row.rows[0].email_ct,
      row.rows[0].dek_version,
      { column: 'email_ct', rowId: userId },
      fieldEncryption,
    );
    expect(fullName).toBe('Round Trip User');
    expect(email).toBe('roundtrip@bevorasg.com');
  });

  it("U-ENC-03: a ciphertext moved to another real row's PK fails to decrypt (AAD binding)", async () => {
    const { userId: userA } = await createLoginableUser({
      email: 'rowa@bevorasg.com',
      password: 'CorrectHorseBattery1!',
      fullName: 'Row A',
    });
    await createLoginableUser({
      email: 'rowb@bevorasg.com',
      password: 'CorrectHorseBattery1!',
      fullName: 'Row B',
    });

    const rowA = await adminPool.query(
      `SELECT "full_name_ct", "dek_version" FROM "app_user" WHERE "id" = $1`,
      [userA],
    );
    const fieldEncryption = loadFieldEncryptionService();

    // Simulate an attacker (or a bug) copying row A's ciphertext onto row B and
    // trying to decrypt it as if it belonged there.
    expect(() =>
      decodeIdentityField(
        rowA.rows[0].full_name_ct,
        rowA.rows[0].dek_version,
        { column: 'full_name_ct', rowId: 'not-row-a-id' },
        fieldEncryption,
      ),
    ).toThrow();
  });

  it('U-ENC-05/06: blind index lookup finds the right row by email, real unique index', async () => {
    const { userId } = await createLoginableUser({
      email: 'lookup@bevorasg.com',
      password: 'CorrectHorseBattery1!',
      fullName: 'Lookup User',
    });
    await createLoginableUser({
      email: 'other@bevorasg.com',
      password: 'CorrectHorseBattery1!',
      fullName: 'Other User',
    });

    const bidx = computeEmailBlindIndex('lookup@bevorasg.com', loadBlindIndexKey());
    const found = await adminPool.query(`SELECT "id" FROM "app_user" WHERE "email_bidx" = $1`, [
      bidx,
    ]);
    expect(found.rowCount).toBe(1);
    expect(found.rows[0].id).toBe(userId);

    const otherBidx = computeEmailBlindIndex('other@bevorasg.com', loadBlindIndexKey());
    expect(otherBidx.equals(bidx)).toBe(false);
  });
});
