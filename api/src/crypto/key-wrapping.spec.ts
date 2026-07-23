import { randomBytes } from 'node:crypto';
import { wrapDek, unwrapDek } from './key-wrapping';

describe('wrapDek / unwrapDek (PR-107 envelope encryption)', () => {
  it('round-trips the DEK through wrap/unwrap under the KEK', () => {
    const kek = randomBytes(32);
    const dek = randomBytes(32);
    expect(unwrapDek(wrapDek(dek, kek), kek).equals(dek)).toBe(true);
  });

  it('produces a different wrapped value each call (random nonce)', () => {
    const kek = randomBytes(32);
    const dek = randomBytes(32);
    expect(wrapDek(dek, kek).equals(wrapDek(dek, kek))).toBe(false);
  });

  it('fails to unwrap under the wrong KEK', () => {
    const dek = randomBytes(32);
    const wrapped = wrapDek(dek, randomBytes(32));
    expect(() => unwrapDek(wrapped, randomBytes(32))).toThrow();
  });

  it('fails to unwrap a tampered wrapped value', () => {
    const kek = randomBytes(32);
    const wrapped = wrapDek(randomBytes(32), kek);
    wrapped[wrapped.length - 1] ^= 0xff;
    expect(() => unwrapDek(wrapped, kek)).toThrow();
  });
});
