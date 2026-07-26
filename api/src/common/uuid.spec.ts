import { isUuid } from './uuid';

describe('isUuid (review finding I-1)', () => {
  it('accepts the uuidv7 values this schema actually stores, in either case', () => {
    expect(isUuid('019f9e3b-e4b3-7789-808a-53dc8bf33d6b')).toBe(true);
    expect(isUuid('019F9E3B-E4B3-7789-808A-53DC8BF33D6B')).toBe(true);
    // uuidv4 and the nil uuid are still uuids as far as Postgres is concerned.
    expect(isUuid('f81d4fae-7dec-11d0-a765-00a0c91e6bf6')).toBe(true);
    expect(isUuid('00000000-0000-0000-0000-000000000000')).toBe(true);
  });

  it('rejects the path segments that made Prisma raise P2023 and Nest answer 500', () => {
    for (const value of [
      'not-a-uuid',
      '',
      '019f9e3b-e4b3-7789-808a-53dc8bf33d6', // one char short
      '019f9e3b-e4b3-7789-808a-53dc8bf33d6bb', // one char long
      '019f9e3b-e4b3-7789-808a-53dc8bf33d6z', // non-hex
      '019f9e3be4b37789808a53dc8bf33d6b', // unhyphenated
      '019f9e3b-e4b3-7789-808a-53dc8bf33d6b\n', // trailing newline
      "'; DROP TABLE app_user; --",
    ]) {
      expect(isUuid(value)).toBe(false);
    }
  });
});
