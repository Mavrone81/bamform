import { decodeCursor, encodeCursor, normaliseLimit, paginate } from './pagination';

describe('pagination (PR-API-14/15)', () => {
  it('normaliseLimit defaults to 25 when absent or invalid', () => {
    expect(normaliseLimit(undefined)).toBe(25);
    expect(normaliseLimit('not-a-number')).toBe(25);
    expect(normaliseLimit('0')).toBe(25);
    expect(normaliseLimit('-5')).toBe(25);
  });

  it('normaliseLimit clamps to the maximum of 100', () => {
    expect(normaliseLimit('500')).toBe(100);
  });

  it('normaliseLimit passes through a valid value', () => {
    expect(normaliseLimit('10')).toBe(10);
  });

  it('cursor round-trips through encode/decode', () => {
    const id = '0192f3aa-1111-7000-8000-000000000001';
    expect(decodeCursor(encodeCursor(id))).toBe(id);
  });

  it('decodeCursor tolerates garbage input by returning undefined', () => {
    expect(decodeCursor(undefined)).toBeUndefined();
    expect(decodeCursor('')).toBeUndefined();
  });

  it('paginate reports hasMore and a nextCursor when the limit+1 fetch overflows', () => {
    const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const result = paginate(rows, 2);

    expect(result.data).toEqual([{ id: 'a' }, { id: 'b' }]);
    expect(result.page.hasMore).toBe(true);
    expect(result.page.nextCursor).toBe(encodeCursor('b'));
    expect(result.page.limit).toBe(2);
  });

  it('paginate reports no more pages when the fetch does not overflow the limit', () => {
    const rows = [{ id: 'a' }, { id: 'b' }];
    const result = paginate(rows, 5);

    expect(result.data).toEqual(rows);
    expect(result.page.hasMore).toBe(false);
    expect(result.page.nextCursor).toBeNull();
  });
});
