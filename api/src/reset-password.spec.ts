import { parseSelection } from './reset-password';

/**
 * `parseSelection` is the only pure logic in the recovery CLI, and it is the
 * part that decides WHICH account gets its password overwritten. A silent
 * off-by-one here resets the wrong user on a production system, so it is
 * pinned at both ends of the range.
 */
describe('reset-password — parseSelection', () => {
  it('maps a 1-based choice to a 0-based index', () => {
    expect(parseSelection('1', 5)).toBe(0);
    expect(parseSelection('5', 5)).toBe(4);
  });

  it('tolerates surrounding whitespace', () => {
    expect(parseSelection('  3  ', 5)).toBe(2);
  });

  it('rejects out-of-range numbers rather than clamping them', () => {
    expect(parseSelection('0', 5)).toBeNull();
    expect(parseSelection('6', 5)).toBeNull();
    expect(parseSelection('-1', 5)).toBeNull();
  });

  it('rejects anything that is not a plain integer', () => {
    // A raw uuid must NOT be accepted: parseInt-style parsing would turn
    // '019f96ce-...' into 19 and reset a completely unrelated account.
    expect(parseSelection('019f96ce-ac1c-77ca-bca2-32150fdb260b', 5)).toBeNull();
    expect(parseSelection('2x', 5)).toBeNull();
    expect(parseSelection('1.5', 5)).toBeNull();
    expect(parseSelection('', 5)).toBeNull();
    expect(parseSelection('  ', 5)).toBeNull();
  });

  it('rejects every choice when the list is empty', () => {
    expect(parseSelection('1', 0)).toBeNull();
  });
});
