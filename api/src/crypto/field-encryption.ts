import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * PR-106: AES-256-GCM field-level encryption for `app_user` personal columns ONLY
 * (ADR-004 — never the maintenance readings/results, which must stay cleartext for
 * UR-070 trending). SEC §6/§8: "AES-256-GCM, 96-bit nonce, PK as AAD".
 *
 * The brief additionally asks that a ciphertext moved between COLUMNS of the same row
 * (not just between rows) fail to decrypt (U-ENC-03 tests the row case explicitly).
 * SEC only names the primary key as AAD; binding the table and column name as well is
 * a strict superset of that requirement — it cannot make a legitimate decrypt fail
 * (the values are fixed per call site) and it closes the column-swap gap SEC is silent
 * on. Documented choice: **AAD = `` `${table}:${column}:${rowId}` `` as UTF-8 bytes.**
 *
 * Storage layout (SEC does not specify a byte layout for the ciphertext column; this
 * is the documented choice, matching `key-wrapping.ts`'s DEK-wrap layout): a single
 * buffer of `nonce (12 bytes) || ciphertext (variable) || authTag (16 bytes)`, stored
 * directly in the `bytea` column (`app_user.full_name_ct` etc — DATABASE_DESIGN.md §6.2).
 *
 * Nonce uniqueness strategy (SEC requires this be stated): a fresh
 * `crypto.randomBytes(12)` (96-bit, full OS CSPRNG entropy) is drawn on every single
 * encrypt call — never derived from a counter or the row id. Nonce reuse under the
 * same key is what breaks AES-GCM; with a 96-bit random nonce, the birthday bound for
 * a meaningful collision probability is roughly 2^48 encryptions under one DEK
 * generation, several orders of magnitude beyond anything this system's `app_user`
 * table will ever hold before the annual DEK rotation (SEC §7.2) moves to a fresh key.
 *
 * Multiple DEK generations: `dek_version` is stored per row (PR-SEC-10 — every
 * generation is retained indefinitely so old backups/rows keep decrypting after
 * rotation, U-ENC-08). This service is constructed with a map of ALL currently
 * available DEK generations; `encrypt` always uses the CURRENT version, `decrypt`
 * looks up whichever version the row says it was encrypted under.
 */
export interface FieldContext {
  readonly table: string;
  readonly column: string;
  readonly rowId: string;
}

export interface EncryptedField {
  readonly ciphertext: Buffer;
  readonly dekVersion: number;
}

const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export class FieldEncryptionService {
  constructor(
    private readonly deksByVersion: ReadonlyMap<number, Buffer>,
    readonly currentDekVersion: number,
  ) {
    const currentDek = deksByVersion.get(currentDekVersion);
    if (!currentDek) {
      throw new Error(
        `No DEK available for the configured current version ${currentDekVersion} (DEK_VERSION)`,
      );
    }
    for (const [version, key] of deksByVersion) {
      if (key.length !== 32) {
        throw new Error(`DEK version ${version} must be 32 bytes (AES-256), got ${key.length}`);
      }
    }
  }

  encrypt(plaintext: string, context: FieldContext): EncryptedField {
    const key = this.deksByVersion.get(this.currentDekVersion)!;
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(buildAad(context));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return {
      ciphertext: Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]),
      dekVersion: this.currentDekVersion,
    };
  }

  decrypt(stored: Uint8Array, dekVersion: number, context: FieldContext): string {
    const key = this.deksByVersion.get(dekVersion);
    if (!key) {
      throw new Error(
        `No DEK available for version ${dekVersion} — every DEK generation must be retained ` +
          'indefinitely (PR-SEC-10); this indicates a key was destroyed rather than retired',
      );
    }
    const buf = Buffer.isBuffer(stored) ? stored : Buffer.from(stored);
    if (buf.length <= NONCE_BYTES + TAG_BYTES) {
      throw new Error('Stored ciphertext is too short to contain a nonce, ciphertext and auth tag');
    }
    const nonce = buf.subarray(0, NONCE_BYTES);
    const tag = buf.subarray(buf.length - TAG_BYTES);
    const ciphertext = buf.subarray(NONCE_BYTES, buf.length - TAG_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAAD(buildAad(context));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  }
}

function buildAad(context: FieldContext): Buffer {
  return Buffer.from(`${context.table}:${context.column}:${context.rowId}`, 'utf8');
}
