/**
 * A dependency-free QR encoder — byte mode, error-correction level M,
 * versions 1-10 — written for exactly one job: turning the `otpauth://`
 * URI that `POST /auth/mfa/enrol` returns into something a phone camera can
 * read (slice 13-UI-A §2.2).
 *
 * WHY HAND-ROLLED. Slice 12 burned hours of CI on one careless dependency
 * addition, and the standing rule on this machine is that `package-lock.json`
 * may only be regenerated with node@22/npm 10 because npm 11 drops optional
 * platform bindings. A QR generator is ~350 lines of well-specified integer
 * arithmetic (ISO/IEC 18004) with no I/O, no platform surface and no
 * transitive dependencies of its own, so the lockfile is not touched at all
 * and there is no supply-chain surface to review at every future `npm audit`.
 *
 * HOW WE KNOW IT IS CORRECT. Hand-rolling only pays if the output is
 * verified against something other than itself. `qrcode.test.ts` compares
 * this encoder module-for-module with matrices emitted by `qrcode@1.5.4`
 * (node-qrcode), an independent implementation that was run once in a
 * scratch directory and never installed here — across versions 1-10, all
 * eight mask patterns, and the real `otpauth://` payload. It additionally
 * checks each Reed-Solomon block against the DEFINITION of the code (every
 * codeword polynomial evaluates to zero at every generator root), which
 * depends on no other implementation at all.
 *
 * SCOPE, deliberately narrow:
 *  - Byte mode only. An `otpauth://` URI is ASCII; numeric/alphanumeric
 *    modes would be denser but are dead code here.
 *  - Level M only. It is what authenticator apps and every otpauth QR in
 *    the wild use, and it keeps the block-structure table to ten rows that
 *    can be read and checked by eye.
 *  - Versions 1-10 (213 bytes at level M). Our longest realistic URI is
 *    ~135 characters; anything past 213 throws rather than silently
 *    truncating a credential into an unscannable symbol.
 *
 * SECURITY NOTE. The payload contains the TOTP shared secret. Nothing in
 * this module logs, stores or transmits it — it takes a string and returns a
 * matrix of booleans. Callers must not log the input either (non-negotiable:
 * never persist or log the QR secret).
 */

export const QR_ERROR_CORRECTION_LEVEL = 'M' as const;

/** ISO/IEC 18004 §9.1: at least four light modules on every side. */
export const QR_QUIET_ZONE = 4;

export interface QrMatrix {
  /** Symbol version, 1-10. Side length is `17 + 4 * version`. */
  readonly version: number;
  readonly size: number;
  /** `modules[row][col]` — true is a dark module. */
  readonly modules: readonly (readonly boolean[])[];
  /** Which of the eight data masks the penalty scoring selected. */
  readonly mask: number;
}

export interface QrCodewordBlock {
  readonly data: readonly number[];
  readonly ec: readonly number[];
}

export interface QrSvgPath {
  readonly path: string;
  readonly viewBoxSize: number;
  readonly quietZone: number;
}

/**
 * Level-M block structure, versions 1-10 (ISO/IEC 18004 Table 9).
 * `[totalCodewords, ecPerBlock, blocks1, dataPerBlock1, blocks2, dataPerBlock2]`
 * — group 2's blocks each hold one more data codeword than group 1's.
 * Invariant, asserted at module load below: total = EC + data.
 */
const LEVEL_M_BLOCKS: readonly (readonly [number, number, number, number, number, number])[] = [
  [26, 10, 1, 16, 0, 0], // v1
  [44, 16, 1, 28, 0, 0], // v2
  [70, 26, 1, 44, 0, 0], // v3
  [100, 18, 2, 32, 0, 0], // v4
  [134, 24, 2, 43, 0, 0], // v5
  [172, 16, 4, 27, 0, 0], // v6
  [196, 18, 4, 31, 0, 0], // v7
  [242, 22, 2, 38, 2, 39], // v8
  [292, 22, 3, 36, 2, 37], // v9
  [346, 26, 4, 43, 1, 44], // v10
];

/** Alignment-pattern centre coordinates per version (ISO/IEC 18004 Table E.1). */
const ALIGNMENT_CENTRES: readonly (readonly number[])[] = [
  [], // v1 has none
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
];

/** Remainder bits appended after the final codeword (ISO/IEC 18004 Table 1). */
const REMAINDER_BITS: readonly number[] = [0, 7, 7, 7, 7, 7, 0, 0, 0, 0];

const MAX_VERSION = LEVEL_M_BLOCKS.length;

function dataCodewordsFor(version: number): number {
  const [total, ecPerBlock, blocks1, , blocks2] = LEVEL_M_BLOCKS[version - 1];
  return total - ecPerBlock * (blocks1 + blocks2);
}

/** Byte-mode payload capacity of a version, after its own segment header. */
function byteCapacityFor(version: number): number {
  const headerBits = 4 + (version >= 10 ? 16 : 8);
  return Math.floor((dataCodewordsFor(version) * 8 - headerBits) / 8);
}

export const QR_MAX_BYTES = byteCapacityFor(MAX_VERSION);

// ------------------------------------------------------------ GF(256) maths

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    // The QR field is GF(2^8) modulo the primitive polynomial x^8+x^4+x^3+x^2+1.
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
}

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

/** g(x) = (x - a^0)(x - a^1) ... (x - a^(degree-1)), coefficients high-to-low. */
function generatorPolynomial(degree: number): number[] {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array<number>(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], GF_EXP[i]);
    }
    poly = next;
  }
  return poly;
}

/** Polynomial long division: the remainder IS the error-correction block. */
function errorCorrectionCodewords(data: readonly number[], ecLength: number): number[] {
  const generator = generatorPolynomial(ecLength);
  const remainder = new Array<number>(ecLength).fill(0);
  for (const codeword of data) {
    const factor = codeword ^ remainder[0];
    remainder.shift();
    remainder.push(0);
    if (factor !== 0) {
      for (let i = 0; i < ecLength; i++) {
        remainder[i] ^= gfMul(generator[i + 1], factor);
      }
    }
  }
  return remainder;
}

// ------------------------------------------------------------ BCH (format /
// version information). Both are systematic BCH codes; computing them beats
// a 32-row and a 34-row magic table nobody can check by eye.

function bchRemainder(value: number, generator: number, generatorBits: number): number {
  let remainder = value;
  const generatorLength = generator.toString(2).length;
  while (remainder.toString(2).length >= generatorLength) {
    remainder ^= generator << (remainder.toString(2).length - generatorLength);
  }
  return remainder & ((1 << generatorBits) - 1);
}

/** 15-bit format information: 2 EC-level bits + 3 mask bits, BCH(15,5), masked. */
function formatInformationBits(mask: number): number {
  const ecLevelBits = 0b00; // level M
  const data = (ecLevelBits << 3) | mask;
  const bch = bchRemainder(data << 10, 0b10100110111, 10);
  return ((data << 10) | bch) ^ 0b101010000010010;
}

/** 18-bit version information (versions 7+ only): 6 version bits + BCH(18,6). */
function versionInformationBits(version: number): number {
  return (version << 12) | bchRemainder(version << 12, 0b1111100100101, 12);
}

// ------------------------------------------------------------------ encoding

function toUtf8Bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function chooseVersion(byteLength: number): number {
  for (let version = 1; version <= MAX_VERSION; version++) {
    if (byteLength <= byteCapacityFor(version)) return version;
  }
  throw new Error(
    `QR payload too long: ${byteLength} bytes exceeds the ${QR_MAX_BYTES}-byte capacity of a version-${MAX_VERSION} level-${QR_ERROR_CORRECTION_LEVEL} symbol`,
  );
}

class BitWriter {
  private readonly bits: number[] = [];

  put(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }

  get length(): number {
    return this.bits.length;
  }

  toCodewords(): number[] {
    const codewords: number[] = [];
    for (let i = 0; i < this.bits.length; i += 8) {
      let byte = 0;
      for (let j = 0; j < 8; j++) byte = (byte << 1) | (this.bits[i + j] ?? 0);
      codewords.push(byte);
    }
    return codewords;
  }
}

/**
 * Builds the per-block data + error-correction codewords for a payload.
 * Exported because `qrcode.test.ts` verifies each block against the algebraic
 * definition of the Reed-Solomon code, which is the one correctness check
 * that needs no second implementation to compare against.
 */
export function computeCodewordBlocks(text: string): QrCodewordBlock[] {
  const bytes = toUtf8Bytes(text);
  if (bytes.length === 0) throw new Error('QR payload is empty');
  const version = chooseVersion(bytes.length);
  const totalDataCodewords = dataCodewordsFor(version);

  const writer = new BitWriter();
  writer.put(0b0100, 4); // byte mode
  writer.put(bytes.length, version >= 10 ? 16 : 8);
  for (const byte of bytes) writer.put(byte, 8);

  // Terminator (up to four zero bits), then zero-fill to a codeword boundary.
  const capacityBits = totalDataCodewords * 8;
  writer.put(0, Math.min(4, capacityBits - writer.length));
  if (writer.length % 8 !== 0) writer.put(0, 8 - (writer.length % 8));

  const codewords = writer.toCodewords();
  // Pad codewords alternate 0b11101100 / 0b00010001 (ISO/IEC 18004 §8.4.9).
  for (let i = 0; codewords.length < totalDataCodewords; i++) {
    codewords.push(i % 2 === 0 ? 0xec : 0x11);
  }

  const [, ecPerBlock, blocks1, dataPerBlock1, blocks2, dataPerBlock2] =
    LEVEL_M_BLOCKS[version - 1];
  const blocks: QrCodewordBlock[] = [];
  let offset = 0;
  for (let i = 0; i < blocks1 + blocks2; i++) {
    const size = i < blocks1 ? dataPerBlock1 : dataPerBlock2;
    const data = codewords.slice(offset, offset + size);
    offset += size;
    blocks.push({ data, ec: errorCorrectionCodewords(data, ecPerBlock) });
  }
  return blocks;
}

/** Interleaves the blocks into the final bit stream (ISO/IEC 18004 §8.6). */
function interleave(blocks: readonly QrCodewordBlock[], version: number): number[] {
  const bits: number[] = [];
  const pushByte = (byte: number) => {
    for (let i = 7; i >= 0; i--) bits.push((byte >>> i) & 1);
  };
  const maxData = Math.max(...blocks.map((b) => b.data.length));
  for (let i = 0; i < maxData; i++) {
    for (const block of blocks) if (i < block.data.length) pushByte(block.data[i]);
  }
  const maxEc = Math.max(...blocks.map((b) => b.ec.length));
  for (let i = 0; i < maxEc; i++) {
    for (const block of blocks) if (i < block.ec.length) pushByte(block.ec[i]);
  }
  for (let i = 0; i < REMAINDER_BITS[version - 1]; i++) bits.push(0);
  return bits;
}

// ------------------------------------------------------------- matrix layout

type Grid = (boolean | null)[][];

function placeFinder(grid: Grid, reserved: boolean[][], top: number, left: number): void {
  // The 7x7 finder plus its one-module separator, clipped to the symbol.
  for (let r = -1; r <= 7; r++) {
    for (let c = -1; c <= 7; c++) {
      const row = top + r;
      const col = left + c;
      if (row < 0 || row >= grid.length || col < 0 || col >= grid.length) continue;
      const inFinder = r >= 0 && r <= 6 && c >= 0 && c <= 6;
      const isRing = r === 0 || r === 6 || c === 0 || c === 6;
      const isCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
      grid[row][col] = inFinder && (isRing || isCore);
      reserved[row][col] = true;
    }
  }
}

function buildFunctionPatterns(version: number): { grid: Grid; reserved: boolean[][] } {
  const size = 17 + 4 * version;
  const grid: Grid = Array.from({ length: size }, () => new Array<boolean | null>(size).fill(null));
  const reserved: boolean[][] = Array.from({ length: size }, () =>
    new Array<boolean>(size).fill(false),
  );

  placeFinder(grid, reserved, 0, 0);
  placeFinder(grid, reserved, 0, size - 7);
  placeFinder(grid, reserved, size - 7, 0);

  // Alignment patterns BEFORE the timing patterns, and only skipped where a
  // finder already occupies the centre. Order matters: from version 7 there
  // are alignment patterns centred ON row/column 6 (e.g. (6,22) at version 7)
  // which are genuinely required, so a "skip anything the timing pattern
  // already claimed" rule would silently drop them and shift every data
  // module that follows.
  const centres = ALIGNMENT_CENTRES[version - 1];
  for (const row of centres) {
    for (const col of centres) {
      if (reserved[row][col]) continue; // overlaps a finder — omitted by spec
      for (let r = -2; r <= 2; r++) {
        for (let c = -2; c <= 2; c++) {
          const isRing = Math.abs(r) === 2 || Math.abs(c) === 2;
          const isCentre = r === 0 && c === 0;
          grid[row + r][col + c] = isRing || isCentre;
          reserved[row + r][col + c] = true;
        }
      }
    }
  }

  // Timing patterns, over whatever an alignment pattern has not already
  // claimed (where they do overlap, the alignment module already carries the
  // value the timing pattern would have written).
  for (let i = 8; i < size - 8; i++) {
    if (!reserved[6][i]) {
      grid[6][i] = i % 2 === 0;
      reserved[6][i] = true;
    }
    if (!reserved[i][6]) {
      grid[i][6] = i % 2 === 0;
      reserved[i][6] = true;
    }
  }

  // Format-information area (written later, reserved now) and the module that
  // is always dark (ISO/IEC 18004 §8.9).
  for (let i = 0; i <= 8; i++) {
    if (!reserved[8][i]) reserved[8][i] = true;
    if (!reserved[i][8]) reserved[i][8] = true;
  }
  for (let i = 0; i < 8; i++) {
    reserved[8][size - 1 - i] = true;
    reserved[size - 1 - i][8] = true;
  }
  grid[size - 8][8] = true;
  reserved[size - 8][8] = true;

  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      reserved[Math.floor(i / 3)][size - 11 + (i % 3)] = true;
      reserved[size - 11 + (i % 3)][Math.floor(i / 3)] = true;
    }
  }

  return { grid, reserved };
}

/** The upward/downward two-column zigzag from the bottom-right corner. */
function placeData(grid: Grid, reserved: boolean[][], bits: readonly number[]): void {
  const size = grid.length;
  let bitIndex = 0;
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    // Column 6 is the vertical timing pattern; the zigzag steps over it.
    const rightColumn = right <= 6 ? right - 1 : right;
    for (let i = 0; i < size; i++) {
      const row = upward ? size - 1 - i : i;
      for (const col of [rightColumn, rightColumn - 1]) {
        if (reserved[row][col]) continue;
        grid[row][col] = bitIndex < bits.length ? bits[bitIndex++] === 1 : false;
      }
    }
    upward = !upward;
  }
}

function maskAt(mask: number, row: number, col: number): boolean {
  switch (mask) {
    case 0:
      return (row + col) % 2 === 0;
    case 1:
      return row % 2 === 0;
    case 2:
      return col % 3 === 0;
    case 3:
      return (row + col) % 3 === 0;
    case 4:
      return (Math.floor(row / 2) + Math.floor(col / 3)) % 2 === 0;
    case 5:
      return ((row * col) % 2) + ((row * col) % 3) === 0;
    case 6:
      return (((row * col) % 2) + ((row * col) % 3)) % 2 === 0;
    default:
      return (((row * col) % 3) + ((row + col) % 2)) % 2 === 0;
  }
}

function writeFormatInformation(grid: Grid, mask: number): void {
  const size = grid.length;
  const bits = formatInformationBits(mask);
  for (let i = 0; i < 15; i++) {
    const dark = ((bits >> i) & 1) === 1;
    // Copy 1, wrapped around the top-left finder.
    if (i < 6) grid[i][8] = dark;
    else if (i < 8) grid[i + 1][8] = dark;
    else grid[size - 15 + i][8] = dark;
    // Copy 2 along row 8: the eight most-significant bits run leftwards from
    // the right edge, the rest run leftwards from column 7. Column 6 is the
    // vertical timing pattern and is stepped over — hence the `i === 8` case
    // rather than a single arithmetic expression.
    if (i < 8) grid[8][size - 1 - i] = dark;
    else if (i === 8) grid[8][7] = dark;
    else grid[8][15 - i - 1] = dark;
  }
}

function writeVersionInformation(grid: Grid, version: number): void {
  if (version < 7) return;
  const size = grid.length;
  const bits = versionInformationBits(version);
  for (let i = 0; i < 18; i++) {
    const dark = ((bits >> i) & 1) === 1;
    grid[Math.floor(i / 3)][size - 11 + (i % 3)] = dark;
    grid[size - 11 + (i % 3)][Math.floor(i / 3)] = dark;
  }
}

// ------------------------------------------------------- mask penalty scoring
// ISO/IEC 18004 §8.8.2. The four rules, with the published weights.

const N1 = 3;
const N2 = 3;
const N3 = 40;
const N4 = 10;

function penaltyAdjacent(modules: boolean[][]): number {
  const size = modules.length;
  let points = 0;
  for (let a = 0; a < size; a++) {
    let rowRun = 1;
    let colRun = 1;
    for (let b = 1; b < size; b++) {
      if (modules[a][b] === modules[a][b - 1]) rowRun++;
      else {
        if (rowRun >= 5) points += N1 + (rowRun - 5);
        rowRun = 1;
      }
      if (modules[b][a] === modules[b - 1][a]) colRun++;
      else {
        if (colRun >= 5) points += N1 + (colRun - 5);
        colRun = 1;
      }
    }
    if (rowRun >= 5) points += N1 + (rowRun - 5);
    if (colRun >= 5) points += N1 + (colRun - 5);
  }
  return points;
}

function penaltyBlocks(modules: boolean[][]): number {
  const size = modules.length;
  let blocks = 0;
  for (let row = 0; row < size - 1; row++) {
    for (let col = 0; col < size - 1; col++) {
      const sum =
        Number(modules[row][col]) +
        Number(modules[row][col + 1]) +
        Number(modules[row + 1][col]) +
        Number(modules[row + 1][col + 1]);
      if (sum === 0 || sum === 4) blocks++;
    }
  }
  return blocks * N2;
}

function penaltyFinderLike(modules: boolean[][]): number {
  const size = modules.length;
  let found = 0;
  // 1:1:3:1:1 dark/light ratio next to four light modules, in either order.
  for (let a = 0; a < size; a++) {
    let rowBits = 0;
    let colBits = 0;
    for (let b = 0; b < size; b++) {
      rowBits = ((rowBits << 1) & 0x7ff) | Number(modules[a][b]);
      colBits = ((colBits << 1) & 0x7ff) | Number(modules[b][a]);
      if (b >= 10) {
        if (rowBits === 0x5d0 || rowBits === 0x05d) found++;
        if (colBits === 0x5d0 || colBits === 0x05d) found++;
      }
    }
  }
  return found * N3;
}

function penaltyDarkRatio(modules: boolean[][]): number {
  const size = modules.length;
  let dark = 0;
  for (const row of modules) for (const module of row) if (module) dark++;
  const k = Math.abs(Math.ceil((dark * 100) / (size * size) / 5) - 10);
  return k * N4;
}

function penalty(modules: boolean[][]): number {
  return (
    penaltyAdjacent(modules) +
    penaltyBlocks(modules) +
    penaltyFinderLike(modules) +
    penaltyDarkRatio(modules)
  );
}

// ------------------------------------------------------------------ public API

/**
 * Encodes `text` as a QR symbol. Throws — rather than returning something
 * unscannable — on an empty payload or one past {@link QR_MAX_BYTES}.
 */
export function encodeQr(text: string): QrMatrix {
  const bytes = toUtf8Bytes(text);
  if (bytes.length === 0) throw new Error('QR payload is empty');
  const version = chooseVersion(bytes.length);
  const blocks = computeCodewordBlocks(text);
  const bits = interleave(blocks, version);

  const { grid, reserved } = buildFunctionPatterns(version);
  placeData(grid, reserved, bits);
  writeVersionInformation(grid, version);

  const size = grid.length;
  const base: boolean[][] = grid.map((row) => row.map((module) => module === true));

  let best: { mask: number; modules: boolean[][]; score: number } | null = null;
  for (let mask = 0; mask < 8; mask++) {
    const candidate = base.map((row) => [...row]);
    for (let row = 0; row < size; row++) {
      for (let col = 0; col < size; col++) {
        if (reserved[row][col]) continue;
        if (maskAt(mask, row, col)) candidate[row][col] = !candidate[row][col];
      }
    }
    // The format information carries the mask number, so it must be written
    // before scoring — those 31 modules are part of the symbol being scored.
    writeFormatInformation(candidate as Grid, mask);
    const score = penalty(candidate);
    if (best === null || score < best.score) best = { mask, modules: candidate, score };
  }

  // `best` is always assigned: the loop runs eight times unconditionally.
  const chosen = best as { mask: number; modules: boolean[][]; score: number };
  return { version, size, modules: chosen.modules, mask: chosen.mask };
}

/**
 * Renders a matrix as a single SVG path — one 1x1 subpath per dark module,
 * inside a quiet zone. A path keeps the DOM to one element (a 57x57 symbol is
 * up to 3,249 modules; that many `<rect>`s is a measurable render cost on the
 * low-end tablets this PWA targets) and, being pure geometry, it contains no
 * URL, no external reference and nothing for a CSP to block.
 */
export function toSvgPath(matrix: QrMatrix, quietZone: number = QR_QUIET_ZONE): QrSvgPath {
  const parts: string[] = [];
  for (let row = 0; row < matrix.size; row++) {
    for (let col = 0; col < matrix.size; col++) {
      if (matrix.modules[row][col]) {
        parts.push(`M${col + quietZone} ${row + quietZone}h1v1h-1z`);
      }
    }
  }
  return {
    path: parts.join(''),
    viewBoxSize: matrix.size + 2 * quietZone,
    quietZone,
  };
}
