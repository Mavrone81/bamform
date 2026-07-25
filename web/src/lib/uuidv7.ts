/**
 * UUIDv7 (RFC 9562) — client-generated ids for outbox mutations.
 *
 * ADR-008: this id doubles as the mutation's `Idempotency-Key`. It must be
 * generatable entirely offline (no server round trip), globally unique, and
 * time-ordered so a batch sent in id order is also sent in recording order.
 *
 * Layout: 48-bit big-endian ms timestamp | 4-bit version (0111) | 12-bit
 * random | 2-bit variant (10) | 62-bit random.
 */

const HEX = '0123456789abcdef';

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += HEX[b >> 4] + HEX[b & 0x0f];
  return out;
}

// Guards monotonicity when called faster than the clock's ms resolution
// (a technician can tap through several checklist items within one
// millisecond of wall-clock time on a fast device).
let lastMs = 0;

export function uuidv7(): string {
  const bytes = new Uint8Array(16);
  const rand = new Uint8Array(10);
  crypto.getRandomValues(rand);

  let ms = Date.now();
  if (ms <= lastMs) {
    ms = lastMs + 1;
  }
  lastMs = ms;

  bytes[0] = Math.floor(ms / 2 ** 40) & 0xff;
  bytes[1] = Math.floor(ms / 2 ** 32) & 0xff;
  bytes[2] = Math.floor(ms / 2 ** 24) & 0xff;
  bytes[3] = Math.floor(ms / 2 ** 16) & 0xff;
  bytes[4] = Math.floor(ms / 2 ** 8) & 0xff;
  bytes[5] = ms & 0xff;

  bytes[6] = 0x70 | (rand[0] & 0x0f); // version 7
  bytes[7] = rand[1];
  bytes[8] = 0x80 | (rand[2] & 0x3f); // variant 10
  bytes[9] = rand[3];
  bytes[10] = rand[4];
  bytes[11] = rand[5];
  bytes[12] = rand[6];
  bytes[13] = rand[7];
  bytes[14] = rand[8];
  bytes[15] = rand[9];

  const hex = toHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const UUIDV7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuidv7(id: string): boolean {
  return UUIDV7_RE.test(id);
}

/** Recovers the embedded millisecond timestamp — used by tests and by
 * diagnostics that show how long a mutation sat in the outbox. */
export function extractTimestampMs(id: string): number {
  const hex = id.replace(/-/g, '');
  const high = parseInt(hex.slice(0, 8), 16);
  const low = parseInt(hex.slice(8, 12), 16);
  return high * 2 ** 16 + low;
}

/** Resets the monotonic counter. Test-only. */
export function _resetForTests(): void {
  lastMs = 0;
}
