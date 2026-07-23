/**
 * Canonical, byte-deterministic serialisation (PR-SEC-13, SECURITY_ARCHITECTURE.md §8.1).
 *
 * This is the single most sensitive file in the codebase: `content-hash.ts` feeds its
 * output to SHA-256 to produce `approval_step.content_hash` (PR-093), which is then
 * Ed25519-signed (PR-094). Every historical signature's validity depends on this
 * function producing IDENTICAL bytes for the same logical record, forever — on any
 * host, any Node version, any timezone, any key-insertion order. If this file's
 * behaviour ever changes for an input that previously hashed successfully, every
 * previously-signed record silently starts failing `GET /records/{id}/integrity`
 * (PR-095) with no way to tell a real tamper event from a serialisation regression.
 *
 * Deliberately dependency-free (no npm imports — only ECMAScript built-ins) so a
 * transitive dependency bump can never silently change its output (PR-SEC-14).
 *
 * ---
 * SEC §8.1 rules implemented, verbatim:
 *   - Keys sorted lexicographically at every level
 *   - No insignificant whitespace
 *   - Numbers in a fixed decimal representation, not floating-point notation
 *   - Timestamps as RFC 3339 UTC with fixed precision
 *   - Nulls explicit, absent keys omitted — never interchangeable
 *   - Character encoding UTF-8, normalised NFC
 *
 * SEC left the following cases unspecified. These choices are now PERMANENT — the
 * golden hash (U-SIG-01) is committed against them and must not be revisited casually
 * (see `content-hash.spec.ts`):
 *
 *   1. Key comparison is plain UTF-16 code-unit order (the default `Array.sort()`
 *      comparator on strings), NOT locale-aware collation. Locale collation depends on
 *      the host's ICU data, which varies across Node builds/OSes — using it would
 *      directly violate "identical bytes on any host, any Node version".
 *   2. Object keys are themselves NFC-normalised before sorting/emitting, for the same
 *      reason string values are (defence in depth; record shapes are expected to use
 *      ASCII keys in practice).
 *   3. Arrays are NOT reordered. Array position is significant application data (e.g.
 *      item/measurement/approval-step ordering) — only *object* keys are unordered by
 *      nature and therefore need sorting to become deterministic.
 *   4. `null` is only accepted as an explicit value. `undefined` — either as an object
 *      property value or a bare top-level/array value — is rejected with a thrown
 *      error, EXCEPT that an object property whose value is `undefined` is treated
 *      identically to the property being absent (both are omitted from the output).
 *      This mirrors `JSON.stringify`'s own behaviour and gives callers an ergonomic
 *      way to conditionally omit a key (`{ remark: hasRemark ? text : undefined }`)
 *      without it ever being confused with an explicit `null`.
 *   5. Numbers: only finite `number` values are accepted (`NaN`/`±Infinity` throw).
 *      `-0` is normalised to `0`. The canonical text is produced from the number's own
 *      value — NOT from whatever string/decimal representation the caller happened to
 *      have — so `1.5` and `1.50` are indistinguishable at the point they become JS
 *      `number`s and always serialise identically (U-SIG-04). Any caller holding a
 *      value as a decimal string (e.g. a Postgres NUMERIC column read through a driver
 *      that returns strings) MUST convert it to a `number` before calling this
 *      function — this function does not parse strings as numbers, since a string
 *      value in the input is, by design, always just a string.
 *      Exponential notation is never emitted: values large/small enough that
 *      `Number.prototype.toString()` would use it (outside roughly 1e-6..1e21) are
 *      manually expanded to plain decimal digits.
 *   6. `bigint` values are supported (for future bignum/bigserial fields) and are
 *      rendered as a JSON STRING of their exact decimal digits (quoted) — JSON has no
 *      native integer type wide enough to hold an arbitrary bigint without precision
 *      loss, so representing it unquoted would be both invalid JSON and ambiguous
 *      with `number`. Quoting keeps it exact and keeps `number` vs `bigint` visibly
 *      distinct in the output.
 *   7. Only native `Date` instances are treated as timestamps, converted with
 *      `Date.prototype.toISOString()` (always UTC, always exactly 3 fractional
 *      digits, e.g. `2026-07-24T03:16:00.000Z` — RFC 3339 with fixed precision by
 *      construction). A `Date` whose value is invalid (`NaN` time) throws. Plain
 *      strings are NEVER auto-detected/parsed as timestamps, no matter their shape —
 *      that would be implicit, host/locale-sensitive, and exactly the kind of
 *      "magic" this function must not do. Callers must pass a `Date` object for any
 *      field that is a timestamp.
 *   8. The overall output is valid, whitespace-free JSON text (object-key order
 *      aside from re-sorting, and the bigint-as-string / Date-as-string encodings
 *      above) — chosen because it is auditable (a human or a third-party verifier
 *      can read `GET /records/{id}/integrity`'s echoed serialisation) and requires
 *      no bespoke parser.
 */

export type CanonicalValue =
  | string
  | number
  | bigint
  | boolean
  | null
  | undefined
  | Date
  | CanonicalValue[]
  | { [key: string]: CanonicalValue };

/** Serialises `value` to its canonical UTF-8 byte form. */
export function canonicalSerialise(value: CanonicalValue): Buffer {
  return Buffer.from(canonicalise(value), 'utf8');
}

/** Same as {@link canonicalSerialise} but returns the string, for tests/inspection. */
export function canonicalSerialiseToString(value: CanonicalValue): string {
  return canonicalise(value);
}

function canonicalise(value: CanonicalValue): string {
  if (value === undefined) {
    throw new Error(
      'undefined is not a valid canonical value here (only object property values may be ' +
        'undefined, meaning "omit this key")',
    );
  }
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'string') {
    return canonicalString(value);
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (typeof value === 'number') {
    return canonicalNumber(value);
  }
  if (typeof value === 'bigint') {
    return canonicalString(value.toString());
  }
  if (value instanceof Date) {
    return canonicalString(canonicalTimestamp(value));
  }
  if (Array.isArray(value)) {
    return canonicalArray(value);
  }
  if (typeof value === 'object') {
    return canonicalObject(value as { [key: string]: CanonicalValue });
  }
  throw new Error(`Unsupported type in canonical serialisation: ${typeof value}`);
}

function canonicalString(s: string): string {
  return JSON.stringify(s.normalize('NFC'));
}

function canonicalNumber(n: number): string {
  if (!Number.isFinite(n)) {
    throw new Error(`Non-finite number cannot be canonically serialised: ${n}`);
  }
  if (Object.is(n, -0)) {
    return '0';
  }
  const str = n.toString();
  return /e/i.test(str) ? expandExponential(str) : str;
}

/** Expands JS's exponential number notation (e.g. `1.23e+21`) to plain decimal digits. */
function expandExponential(str: string): string {
  const match = /^(-)?(\d+)(?:\.(\d+))?e([+-]\d+)$/i.exec(str);
  if (!match) {
    throw new Error(`Cannot parse exponential number representation: ${str}`);
  }
  const [, sign, intPart, fracPart = '', expStr] = match;
  const exp = Number(expStr);
  const digits = intPart + fracPart;
  const pointPos = intPart.length + exp;

  let result: string;
  if (pointPos <= 0) {
    result = `0.${'0'.repeat(-pointPos)}${digits}`;
  } else if (pointPos >= digits.length) {
    result = digits + '0'.repeat(pointPos - digits.length);
  } else {
    result = `${digits.slice(0, pointPos)}.${digits.slice(pointPos)}`;
  }

  if (result.includes('.')) {
    result = result.replace(/0+$/, '').replace(/\.$/, '');
  }
  return (sign ?? '') + result;
}

function canonicalTimestamp(date: Date): string {
  if (Number.isNaN(date.getTime())) {
    throw new Error('Invalid Date cannot be canonically serialised');
  }
  return date.toISOString();
}

function canonicalArray(values: CanonicalValue[]): string {
  const parts = values.map((v) => {
    if (v === undefined) {
      throw new Error('undefined is not a valid array element in canonical serialisation');
    }
    return canonicalise(v);
  });
  return `[${parts.join(',')}]`;
}

function canonicalObject(obj: { [key: string]: CanonicalValue }): string {
  const entries: Array<[normalisedKey: string, originalKey: string]> = Object.keys(obj)
    .filter((key) => obj[key] !== undefined) // undefined value => treated as absent key
    .map((key) => [key.normalize('NFC'), key]);
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  const parts = entries.map(
    ([normalisedKey, originalKey]) =>
      `${canonicalString(normalisedKey)}:${canonicalise(obj[originalKey])}`,
  );
  return `{${parts.join(',')}}`;
}
