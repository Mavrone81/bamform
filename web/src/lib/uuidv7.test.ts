import { describe, expect, it, beforeEach } from 'vitest';
import { uuidv7, isUuidv7, extractTimestampMs, _resetForTests } from './uuidv7';

describe('uuidv7', () => {
  beforeEach(() => {
    _resetForTests();
  });

  it('produces a well-formed RFC 9562 v7 UUID', () => {
    const id = uuidv7();
    expect(isUuidv7(id)).toBe(true);
    // version nibble
    expect(id[14]).toBe('7');
    // variant nibble is 8, 9, a or b
    expect(['8', '9', 'a', 'b']).toContain(id[19]);
  });

  it('is unique across many rapid calls', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 5000; i++) ids.add(uuidv7());
    expect(ids.size).toBe(5000);
  });

  it('is monotonically non-decreasing as a string, even called back-to-back', () => {
    let prev = uuidv7();
    for (let i = 0; i < 2000; i++) {
      const next = uuidv7();
      expect(next >= prev).toBe(true);
      prev = next;
    }
  });

  it('embeds a timestamp close to Date.now() at generation time', () => {
    const before = Date.now();
    const id = uuidv7();
    const after = Date.now();
    const ts = extractTimestampMs(id);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after + 5);
  });

  it('rejects malformed ids', () => {
    expect(isUuidv7('not-a-uuid')).toBe(false);
    expect(isUuidv7('00000000-0000-4000-8000-000000000000')).toBe(false); // v4, not v7
  });
});
