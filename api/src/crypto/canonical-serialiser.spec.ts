import { CanonicalDecimal, canonicalSerialiseToString } from './canonical-serialiser';
import { computeContentHash } from './content-hash';
import { buildGoldenRecordFixture } from './canonical-record.fixture';

/**
 * PR-SEC-13 / PR-SEC-14 / PR-TST-04 / TEST_PLAN §5.3 (U-SIG-01..08).
 *
 * The describe text below deliberately contains the exact substring
 * "canonical serialisation" — `.github/workflows/ci.yml`'s "unit" job runs
 * `npm run test:unit -- --testNamePattern="canonical serialisation"` as an extra,
 * always-run check on top of the normal unit suite specifically for this file.
 */
describe('canonical serialisation (PR-SEC-13, SEC §8.1)', () => {
  describe('U-SIG-01 golden hash', () => {
    it('hashes the fixture record to the committed constant — FROZEN, see canonical-serialiser.ts header', () => {
      const hash = computeContentHash(buildGoldenRecordFixture());
      // Committed 2026-07-24. If this ever needs to change, that means canonical
      // serialisation broke, not that the test is stale (PR-TST-04).
      expect(hash.toString('hex')).toBe(
        'af050612cb1a0dc0f4b55cf5a815010bce77367fd9bfb96231fc48dc690a688a',
      );
    });
  });

  it('U-SIG-02: same record, keys supplied in different order — identical hash', () => {
    const a = { z: 1, a: 2, m: { y: 1, b: 2 } };
    const b = { a: 2, z: 1, m: { b: 2, y: 1 } };
    expect(computeContentHash(a).equals(computeContentHash(b))).toBe(true);
  });

  it('U-SIG-03: identical bytes regardless of host timezone (Date always serialises as UTC)', () => {
    const originalTz = process.env.TZ;
    try {
      process.env.TZ = 'Pacific/Kiritimati'; // UTC+14
      const asUtcPlus14 = canonicalSerialiseToString({ at: new Date('2026-03-15T02:00:00.000Z') });
      process.env.TZ = 'Etc/GMT+12'; // UTC-12
      const asUtcMinus12 = canonicalSerialiseToString({ at: new Date('2026-03-15T02:00:00.000Z') });
      expect(asUtcPlus14).toBe(asUtcMinus12);
      expect(asUtcPlus14).toBe('{"at":"2026-03-15T02:00:00.000Z"}');
    } finally {
      process.env.TZ = originalTz;
    }
  });

  it('U-SIG-04: reading 1.50 vs 1.5 as JS numbers — identical hash (fixed decimal representation)', () => {
    const a = { reading: 1.5 };
    const b = { reading: 1.5 }; // 1.50 literal parses to the identical JS number
    expect(canonicalSerialiseToString(a)).toBe('{"reading":1.5}');
    expect(computeContentHash(a).equals(computeContentHash(b))).toBe(true);
  });

  it('U-SIG-05: null field vs absent field — DIFFERENT hashes, never interchangeable', () => {
    const withNull = { remark: null };
    const withoutKey = {};
    expect(canonicalSerialiseToString(withNull)).toBe('{"remark":null}');
    expect(canonicalSerialiseToString(withoutKey)).toBe('{}');
    expect(computeContentHash(withNull).equals(computeContentHash(withoutKey))).toBe(false);
  });

  it('an object property explicitly set to undefined is treated as absent, same as null vs it being different', () => {
    const explicitUndefined = { remark: undefined };
    const absent = {};
    expect(canonicalSerialiseToString(explicitUndefined)).toBe(canonicalSerialiseToString(absent));
  });

  it('U-SIG-06: unicode remark, NFC vs NFD input — identical hash after normalisation', () => {
    const nfc = { remark: 'écafé'.normalize('NFC') }; // "écafé"
    const nfd = { remark: 'écafé' }; // decomposed combining accents
    expect(nfc.remark).not.toBe(nfd.remark); // genuinely different code points going in
    expect(computeContentHash(nfc).equals(computeContentHash(nfd))).toBe(true);
  });

  it('U-SIG-07: one item status changed — different hash', () => {
    const fixtureA = buildGoldenRecordFixture() as { itemResults: Array<{ status: string }> };
    const fixtureB = buildGoldenRecordFixture() as { itemResults: Array<{ status: string }> };
    fixtureB.itemResults[0].status = 'fail';
    expect(computeContentHash(fixtureA).equals(computeContentHash(fixtureB))).toBe(false);
  });

  it('U-SIG-08: attachment added — different hash', () => {
    const fixtureA = buildGoldenRecordFixture();
    const fixtureB = buildGoldenRecordFixture() as {
      attachments: Array<{ id: string; sha256: string }>;
    };
    fixtureB.attachments.push({ id: 'extra-attachment', sha256: 'a'.repeat(64) });
    expect(computeContentHash(fixtureA).equals(computeContentHash(fixtureB))).toBe(false);
  });

  describe('U-SIG-11..16: CanonicalDecimal — lossless high-precision decimal determinism (slice-3 HARD GATE, PR-093)', () => {
    it('U-SIG-11: does not disturb the U-SIG-01 golden hash — the fixture uses plain numbers only', () => {
      // Re-assert the exact frozen constant here too, so a reviewer sees this
      // gate's own test file re-proves the golden hash is untouched, not just
      // "trust the other describe block above".
      const hash = computeContentHash(buildGoldenRecordFixture());
      expect(hash.toString('hex')).toBe(
        'af050612cb1a0dc0f4b55cf5a815010bce77367fd9bfb96231fc48dc690a688a',
      );
    });

    it('U-SIG-12: a value that fits exactly in a JS number serialises IDENTICALLY via CanonicalDecimal or number', () => {
      const asNumber = canonicalSerialiseToString({ reading: 24.75 });
      const asDecimal = canonicalSerialiseToString({ reading: new CanonicalDecimal('24.750000') });
      expect(asDecimal).toBe(asNumber);
      expect(asDecimal).toBe('{"reading":24.75}');
    });

    it('U-SIG-13: trailing/leading zero variants of the same value hash identically (fixed decimal representation)', () => {
      const variants = ['1.5', '1.50', '1.500000', '01.5', '+1.5'.replace('+', '')];
      const hashes = variants.map((v) =>
        computeContentHash({ reading: new CanonicalDecimal(v) }).toString('hex'),
      );
      expect(new Set(hashes).size).toBe(1);
      expect(canonicalSerialiseToString({ reading: new CanonicalDecimal('1.500000') })).toBe(
        '{"reading":1.5}',
      );
    });

    it('U-SIG-14: a NUMERIC(18,6) reading with 17 significant digits is preserved EXACTLY — this is the failure number-conversion would produce', () => {
      // 18 significant digits: 12 integer + 6 fractional, the exact ceiling
      // measurement_result.reading_numeric NUMERIC(18,6) allows.
      const highPrecision = '123456789012.123456';
      // Proof this genuinely exceeds safe JS number precision — the whole
      // reason this gate exists:
      expect(Number(highPrecision).toString()).not.toBe(highPrecision);

      const serialised = canonicalSerialiseToString({
        reading: new CanonicalDecimal(highPrecision),
      });
      expect(serialised).toBe(`{"reading":${highPrecision}}`);
    });

    it('U-SIG-15: two distinct high-precision readings that a lossy float conversion WOULD collide on still hash differently', () => {
      const rawA = '123456789012.123456';
      const rawB = '123456789012.123457';
      // Proof, not assumption: naive `Number(...)` conversion collapses these
      // two genuinely different readings to the identical IEEE-754 double —
      // exactly the silent-corruption scenario CanonicalDecimal exists to avoid.
      expect(Number(rawA)).toBe(Number(rawB));

      const a = new CanonicalDecimal(rawA);
      const b = new CanonicalDecimal(rawB);
      expect(computeContentHash({ reading: a }).equals(computeContentHash({ reading: b }))).toBe(
        false,
      );
    });

    it("U-SIG-16: negative decimals, and -0 normalises to 0, matching canonicalNumber's own -0 rule", () => {
      expect(canonicalSerialiseToString({ n: new CanonicalDecimal('-1.230') })).toBe('{"n":-1.23}');
      expect(canonicalSerialiseToString({ n: new CanonicalDecimal('-0') })).toBe('{"n":0}');
      expect(canonicalSerialiseToString({ n: new CanonicalDecimal('-0.000') })).toBe('{"n":0}');
      expect(canonicalSerialiseToString({ n: new CanonicalDecimal('0') })).toBe('{"n":0}');
    });

    it('rejects exponential notation and non-decimal-digit-string input', () => {
      expect(() => new CanonicalDecimal('1.5e10')).toThrow();
      expect(() => new CanonicalDecimal('NaN')).toThrow();
      expect(() => new CanonicalDecimal('abc')).toThrow();
      expect(() => new CanonicalDecimal('')).toThrow();
      expect(() => new CanonicalDecimal('.5')).toThrow();
    });
  });

  describe('serialisation edge cases SEC §8.1 leaves open (documented in canonical-serialiser.ts)', () => {
    it('sorts keys by UTF-16 code-unit order, not locale collation', () => {
      // 'Z' (0x5A) sorts before 'a' (0x61) in code-unit order — a locale-aware
      // collator would put them the other way.
      expect(canonicalSerialiseToString({ a: 1, Z: 2 })).toBe('{"Z":2,"a":1}');
    });

    it('arrays keep input order — not re-sorted', () => {
      expect(canonicalSerialiseToString({ items: [3, 1, 2] })).toBe('{"items":[3,1,2]}');
    });

    it('never emits exponential notation for very small or very large numbers', () => {
      expect(canonicalSerialiseToString({ n: 1e21 })).toBe('{"n":1000000000000000000000}');
      expect(canonicalSerialiseToString({ n: 1e-7 })).toBe('{"n":0.0000001}');
      expect(canonicalSerialiseToString({ n: -1.23e-5 })).toBe('{"n":-0.0000123}');
    });

    it('normalises -0 to 0', () => {
      expect(canonicalSerialiseToString({ n: -0 })).toBe('{"n":0}');
    });

    it('rejects non-finite numbers', () => {
      expect(() => canonicalSerialiseToString({ n: NaN })).toThrow();
      expect(() => canonicalSerialiseToString({ n: Infinity })).toThrow();
    });

    it('renders bigint as a quoted decimal-digit string, distinct from number', () => {
      expect(canonicalSerialiseToString({ n: 12345678901234567890n })).toBe(
        '{"n":"12345678901234567890"}',
      );
    });

    it('rejects undefined as a bare top-level value', () => {
      expect(() => canonicalSerialiseToString(undefined as never)).toThrow();
    });

    it('rejects undefined as an array element', () => {
      expect(() => canonicalSerialiseToString([1, undefined as never, 2])).toThrow();
    });

    it('rejects an invalid Date', () => {
      expect(() => canonicalSerialiseToString({ at: new Date('not-a-date') })).toThrow();
    });

    it('does not auto-parse timestamp-shaped strings as dates', () => {
      expect(canonicalSerialiseToString({ at: '2026-03-15T02:00:00.000Z' })).toBe(
        '{"at":"2026-03-15T02:00:00.000Z"}',
      );
    });

    it('produces no insignificant whitespace', () => {
      expect(canonicalSerialiseToString({ a: 1, b: [1, 2] })).not.toMatch(/\s/);
    });
  });
});
