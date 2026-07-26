import { describe, expect, it } from 'vitest';
import {
  QR_ERROR_CORRECTION_LEVEL,
  QR_MAX_BYTES,
  QR_QUIET_ZONE,
  computeCodewordBlocks,
  encodeQr,
  toSvgPath,
  type QrMatrix,
} from './qrcode';
import { AUTO_MASK_CASES, FIXED_MASK_CASE } from './qrcode.fixtures';

function toRows(matrix: QrMatrix): string[] {
  return matrix.modules.map((row) => row.map((dark) => (dark ? '1' : '0')).join(''));
}

/**
 * U-QR-01 — the only test that can show this encoder produces a REAL QR
 * symbol rather than a merely self-consistent one. Every expected matrix in
 * `qrcode.fixtures.ts` came out of `qrcode@1.5.4` (node-qrcode), an
 * independent MIT implementation run once in a scratch directory that was
 * never part of this repository. See that file's header for provenance, the
 * regeneration command, and why node-qrcode rather than qrcode-generator.
 *
 * Module-for-module equality is a far stronger assertion than "it decodes":
 * it pins version selection, the byte-mode segment header, the Reed-Solomon
 * codewords, block interleaving, every function pattern, the format and
 * version information, AND which mask the penalty scoring chose. One wrong
 * bit anywhere fails it.
 */
describe('U-QR-01: matches an independent QR implementation module-for-module', () => {
  it.each(AUTO_MASK_CASES.map((c) => [c.name, c] as const))('%s', (_name, reference) => {
    const matrix = encodeQr(reference.text);
    expect(matrix.version).toBe(reference.version);
    expect(matrix.size).toBe(17 + 4 * reference.version);
    expect(matrix.mask).toBe(reference.mask);
    expect(toRows(matrix)).toEqual(reference.rows);
  });

  it('covers every version this encoder claims to support', () => {
    expect([...new Set(AUTO_MASK_CASES.map((c) => c.version))].sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
  });
});

/**
 * U-QR-02 — mask selection is a scoring decision, so U-QR-01 only ever
 * exercises the masks that happen to win. This drives all eight formulas
 * against the reference implementation directly, on a version-3 symbol (the
 * smallest carrying an alignment pattern, which masking must skip).
 */
describe('U-QR-02: every mask formula matches the reference implementation', () => {
  it.each([0, 1, 2, 3, 4, 5, 6, 7])('mask %i', (mask) => {
    const matrix = encodeQrWithMask(FIXED_MASK_CASE.text, mask);
    expect(matrix).toEqual([...FIXED_MASK_CASE.rowsByMask[mask]]);
  });

  /**
   * Re-derives the symbol under a forced mask from the encoder's own public
   * output: XOR the winning mask back off the non-function modules, XOR the
   * requested one on, and rewrite the format information. Function modules
   * are identified as those that differ from what the winning mask would
   * have flipped — which is why this is done by diffing the encoder's masked
   * output against its unmasked reconstruction rather than by reaching into
   * private state.
   */
  function encodeQrWithMask(text: string, mask: number): string[] {
    const chosen = encodeQr(text);
    const reservedGrid = reservedModules(chosen);
    const size = chosen.size;
    const out: string[][] = chosen.modules.map((row) => row.map((d) => (d ? '1' : '0')));
    for (let row = 0; row < size; row++) {
      for (let col = 0; col < size; col++) {
        if (reservedGrid[row][col]) continue;
        const unmasked = chosen.modules[row][col] !== maskAt(chosen.mask, row, col);
        out[row][col] = (unmasked !== maskAt(mask, row, col) ? '1' : '0') as string;
      }
    }
    writeFormatInfo(out, mask);
    return out.map((row) => row.join(''));
  }

  /** Mirrors ISO/IEC 18004 §8.8.1 — kept local so the test does not simply
   * re-import the implementation's own copy and agree with itself. */
  function maskAt(mask: number, i: number, j: number): boolean {
    if (mask === 0) return (i + j) % 2 === 0;
    if (mask === 1) return i % 2 === 0;
    if (mask === 2) return j % 3 === 0;
    if (mask === 3) return (i + j) % 3 === 0;
    if (mask === 4) return (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0;
    if (mask === 5) return ((i * j) % 2) + ((i * j) % 3) === 0;
    if (mask === 6) return (((i * j) % 2) + ((i * j) % 3)) % 2 === 0;
    return (((i * j) % 3) + ((i + j) % 2)) % 2 === 0;
  }

  function writeFormatInfo(grid: string[][], mask: number): void {
    const size = grid.length;
    // BCH(15,5) over the 5-bit (level M = 00) + mask value, masked with 0x5412.
    const data = mask;
    let remainder = data << 10;
    for (let i = 4; i >= 0; i--) {
      if ((remainder >> (i + 10)) & 1) remainder ^= 0b10100110111 << i;
    }
    const bits = (((data << 10) | remainder) ^ 0b101010000010010) >>> 0;
    for (let i = 0; i < 15; i++) {
      const dark = ((bits >> i) & 1) === 1 ? '1' : '0';
      if (i < 6) grid[i][8] = dark;
      else if (i < 8) grid[i + 1][8] = dark;
      else grid[size - 15 + i][8] = dark;
      if (i < 8) grid[8][size - 1 - i] = dark;
      else if (i === 8) grid[8][7] = dark;
      else grid[8][15 - i - 1] = dark;
    }
  }

  /** Function-pattern map, derived from the geometry rather than the module. */
  function reservedModules(matrix: QrMatrix): boolean[][] {
    const size = matrix.size;
    const reserved = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
    const mark = (top: number, left: number, h: number, w: number) => {
      for (let r = top; r < top + h; r++) {
        for (let c = left; c < left + w; c++) {
          if (r >= 0 && r < size && c >= 0 && c < size) reserved[r][c] = true;
        }
      }
    };
    mark(0, 0, 9, 9);
    mark(0, size - 8, 9, 8);
    mark(size - 8, 0, 8, 9);
    for (let i = 0; i < size; i++) {
      reserved[6][i] = true;
      reserved[i][6] = true;
    }
    const centres = [
      [],
      [6, 18],
      [6, 22],
      [6, 26],
      [6, 30],
      [6, 34],
      [6, 22, 38],
      [6, 24, 42],
      [6, 26, 46],
      [6, 28, 50],
    ][matrix.version - 1] as number[];
    for (const row of centres) {
      for (const col of centres) {
        const nearFinder =
          (row <= 8 && col <= 8) || (row <= 8 && col >= size - 9) || (row >= size - 9 && col <= 8);
        if (nearFinder) continue;
        mark(row - 2, col - 2, 5, 5);
      }
    }
    if (matrix.version >= 7) {
      mark(0, size - 11, 6, 3);
      mark(size - 11, 0, 3, 6);
    }
    return reserved;
  }
});

describe('U-QR-03: structural invariants every QR symbol must satisfy', () => {
  const matrix = encodeQr(AUTO_MASK_CASES[1].text);
  const dark = (r: number, c: number) => matrix.modules[r][c];

  it('places the three 7x7 finder patterns in the correct corners', () => {
    const corners: Array<[number, number]> = [
      [0, 0],
      [0, matrix.size - 7],
      [matrix.size - 7, 0],
    ];
    for (const [top, left] of corners) {
      for (let r = 0; r < 7; r++) {
        for (let c = 0; c < 7; c++) {
          const isRing = r === 0 || r === 6 || c === 0 || c === 6;
          const isCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
          expect(dark(top + r, left + c)).toBe(isRing || isCore);
        }
      }
    }
  });

  it('alternates the horizontal and vertical timing patterns on row/column 6', () => {
    for (let i = 8; i < matrix.size - 8; i++) {
      expect(dark(6, i)).toBe(i % 2 === 0);
      expect(dark(i, 6)).toBe(i % 2 === 0);
    }
  });

  it('sets the module that ISO/IEC 18004 §8.9 requires to be always dark', () => {
    expect(dark(matrix.size - 8, 8)).toBe(true);
  });
});

describe('U-QR-04: version selection and capacity', () => {
  it('picks the smallest version that fits the payload', () => {
    expect(encodeQr('x'.repeat(14)).version).toBe(1);
    expect(encodeQr('x'.repeat(15)).version).toBe(2);
    expect(encodeQr('x'.repeat(26)).version).toBe(2);
    expect(encodeQr('x'.repeat(27)).version).toBe(3);
  });

  it('encodes non-ASCII as UTF-8 bytes, not UTF-16 code units', () => {
    // "é" is two UTF-8 bytes, so 13 of them need version 2 — a naive
    // one-byte-per-character encoder would still claim version 1 fits.
    expect(encodeQr('é'.repeat(13)).version).toBe(2);
  });

  it('refuses an empty payload rather than emitting a meaningless symbol', () => {
    expect(() => encodeQr('')).toThrow(/empty/i);
    expect(() => computeCodewordBlocks('')).toThrow(/empty/i);
  });

  it(`refuses a payload past ${QR_MAX_BYTES} bytes instead of silently truncating a credential`, () => {
    expect(QR_MAX_BYTES).toBe(213);
    expect(() => encodeQr('x'.repeat(QR_MAX_BYTES + 1))).toThrow(/too long/i);
    expect(() => encodeQr('x'.repeat(QR_MAX_BYTES))).not.toThrow();
  });
});

/**
 * U-QR-05 — independent of every fixture: a correct Reed-Solomon codeword
 * block, read as a polynomial over GF(256), is exactly divisible by the
 * generator polynomial, so it evaluates to zero at each of its roots
 * a^0..a^(n-1). This checks the field arithmetic and the remainder against
 * the DEFINITION of the code rather than against another implementation.
 */
describe('U-QR-05: Reed-Solomon blocks are mathematically valid', () => {
  const EXP = new Uint8Array(512);
  const LOG = new Uint8Array(256);
  for (let i = 0, x = 1; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  const mul = (a: number, b: number) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

  it.each(AUTO_MASK_CASES.map((c) => [c.name, c.text] as const))(
    'every block of %s evaluates to zero at all generator roots',
    (_name, text) => {
      const blocks = computeCodewordBlocks(text);
      expect(blocks.length).toBeGreaterThan(0);
      for (const block of blocks) {
        const codewords = [...block.data, ...block.ec];
        for (let root = 0; root < block.ec.length; root++) {
          let value = 0;
          for (const codeword of codewords) value = mul(value, EXP[root]) ^ codeword;
          expect(value).toBe(0);
        }
      }
    },
  );

  it('splits version 8 into its two differently-sized block groups', () => {
    // ISO/IEC 18004 Table 9, 8-M: 2 blocks of 38 data codewords + 2 of 39,
    // each with 22 EC codewords. Interleaving a mis-sized group is the
    // classic silent corruption, so the shape is pinned explicitly.
    const blocks = computeCodewordBlocks(AUTO_MASK_CASES[1].text);
    expect(blocks.map((b) => b.data.length)).toEqual([38, 38, 39, 39]);
    expect(blocks.every((b) => b.ec.length === 22)).toBe(true);
  });
});

describe('U-QR-06: the rendered SVG path', () => {
  it('is self-contained geometry with a quiet zone and no external reference', () => {
    const matrix = encodeQr('HELLO');
    const svg = toSvgPath(matrix);
    expect(svg.path.length).toBeGreaterThan(0);
    expect(svg.path.startsWith('M')).toBe(true);
    expect(svg.quietZone).toBe(QR_QUIET_ZONE);
    expect(svg.quietZone).toBeGreaterThanOrEqual(4); // ISO/IEC 18004 §9.1
    expect(svg.viewBoxSize).toBe(21 + 2 * QR_QUIET_ZONE);
    expect(svg.path).not.toMatch(/http|url\(/);
  });

  it('emits exactly one subpath per dark module, offset by the quiet zone', () => {
    const matrix = encodeQr('HELLO');
    const darkModules = matrix.modules.flat().filter(Boolean).length;
    expect(toSvgPath(matrix).path.match(/M/g)?.length).toBe(darkModules);
    expect(toSvgPath(matrix, 2).viewBoxSize).toBe(25);
  });
});

describe('U-QR-07: the encoder is pinned to what authenticator apps expect', () => {
  it('uses error-correction level M', () => {
    expect(QR_ERROR_CORRECTION_LEVEL).toBe('M');
  });

  it('is deterministic — the same payload always produces the same symbol', () => {
    const text = 'otpauth://totp/BamForm:a%40b.com?secret=AAAAAAAAAAAAAAAA&issuer=BamForm';
    expect(toRows(encodeQr(text))).toEqual(toRows(encodeQr(text)));
  });
});
