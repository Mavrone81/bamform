import { randomBytes } from 'node:crypto';
import { computeEmailBlindIndex } from './blind-index';

describe('computeEmailBlindIndex', () => {
  const key = randomBytes(32);

  it('is deterministic — same email, same key, same digest', () => {
    const a = computeEmailBlindIndex('Tech@Bevorasg.com', key);
    const b = computeEmailBlindIndex('Tech@Bevorasg.com', key);
    expect(a.equals(b)).toBe(true);
  });

  it('normalises case and surrounding whitespace before hashing (DBD §6.2 email_bidx)', () => {
    const a = computeEmailBlindIndex('  Tech@Bevorasg.com  ', key);
    const b = computeEmailBlindIndex('tech@bevorasg.com', key);
    expect(a.equals(b)).toBe(true);
  });

  it('produces a 32-byte HMAC-SHA-256 digest', () => {
    const digest = computeEmailBlindIndex('tech@bevorasg.com', key);
    expect(digest).toBeInstanceOf(Buffer);
    expect(digest.length).toBe(32);
  });

  it('different emails produce different digests', () => {
    const a = computeEmailBlindIndex('tech@bevorasg.com', key);
    const b = computeEmailBlindIndex('other@bevorasg.com', key);
    expect(a.equals(b)).toBe(false);
  });

  it('different keys produce different digests for the same email (SEC §6: BLIND_INDEX_KEY separate from DEK)', () => {
    const otherKey = randomBytes(32);
    const a = computeEmailBlindIndex('tech@bevorasg.com', key);
    const b = computeEmailBlindIndex('tech@bevorasg.com', otherKey);
    expect(a.equals(b)).toBe(false);
  });
});
