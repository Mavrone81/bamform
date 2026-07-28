/**
 * Slice 13-TL — specification-string parser (TLP §4.2).
 *
 * Parses every printed specification form found in the twelve source
 * workbooks into structured limits. PR-TLP-05: anything it cannot resolve
 * into a valid (non-inverted) range is NOT guessed — it comes back as
 * `specType: 'TEXT'` with `unparsedReason` set, and the caller escalates it
 * into the AC-01 evidence pack. The verbatim printed text always survives
 * in `spec_display` regardless (DBD §6.12).
 */
import type { SpecType } from './model';

export interface ParsedSpec {
  specType: SpecType;
  lowerLimit: number | null;
  upperLimit: number | null;
  nominal: number | null;
  tolerance: number | null;
  unit: string | null;
  /** Leading label text, e.g. 'Hmin', 'Side to Side', 'XX ='. */
  label: string | null;
  /** Set iff specType === 'TEXT': why limits were not extracted. */
  unparsedReason?: string;
}

const EMPTY: Omit<ParsedSpec, 'specType'> = {
  lowerLimit: null,
  upperLimit: null,
  nominal: null,
  tolerance: null,
  unit: null,
  label: null,
};

function text(reason: string): ParsedSpec {
  return { specType: 'TEXT', ...EMPTY, unparsedReason: reason };
}

const NUMBER_RE = /[+-]?\d+(?:\.\d+)?/g;

export function parseSpec(raw: string): ParsedSpec {
  const s = raw.trim();

  if (/^pass\s*\/\s*fail$/i.test(s)) {
    return { specType: 'PASS_FAIL', ...EMPTY };
  }

  // Comma-decimal (e.g. '6.4 - 7,1 counts/gram') — European decimal typo in
  // the source; parsing '7,1' as anything would be a guess.
  if (/\d,\d/.test(s)) {
    return text('comma-decimal number in specification — client to confirm intended value');
  }

  // Tolerance: '150°C ± 5°C' | '± 30 um' | '122 ± 5KHz (High Freq)'
  const tol = /^(.*?)±\s*(\d+(?:\.\d+)?)\s*(.*)$/.exec(s);
  if (tol) {
    const left = tol[1].trim();
    const tolerance = Number(tol[2]);
    const rightUnit = tol[3].trim();
    if (left === '') {
      // Symmetric tolerance only → nominal 0 (TLP §4.2).
      return {
        specType: 'TOLERANCE',
        nominal: 0,
        tolerance,
        lowerLimit: -tolerance,
        upperLimit: tolerance,
        unit: rightUnit || null,
        label: null,
      };
    }
    const leftMatch = /^(.*?)([+-]?\d+(?:\.\d+)?)([^\d\s]*)$/.exec(left);
    if (leftMatch) {
      const nominal = Number(leftMatch[2]);
      const unit = leftMatch[3] || rightUnit || null;
      return {
        specType: 'TOLERANCE',
        nominal,
        tolerance,
        lowerLimit: nominal - tolerance,
        upperLimit: nominal + tolerance,
        unit,
        label: leftMatch[1].trim() || null,
      };
    }
    return text('tolerance form with no parseable nominal');
  }

  // Inequality: 'Hmin ≤ 20 um' | '>-600 mmHg' | 'Side to Side <30 ENC'
  const ineq = /^(.*?)(≤|≥|<|>)\s*([+-]?\d+(?:\.\d+)?)\s*(.*)$/.exec(s);
  if (ineq) {
    const label = ineq[1].trim() || null;
    const bound = Number(ineq[3]);
    const unit = ineq[4].trim() || null;
    const isUpper = ineq[2] === '≤' || ineq[2] === '<';
    return {
      specType: 'RANGE',
      lowerLimit: isUpper ? null : bound,
      upperLimit: isUpper ? bound : null,
      nominal: null,
      tolerance: null,
      unit,
      label,
    };
  }

  // Range: exactly two numbers separated by '~' | '–' | '—' | '-' | 'to';
  // optional leading label, optional trailing unit.
  const numbers = [...s.matchAll(NUMBER_RE)];
  if (numbers.length === 2) {
    const [first, second] = numbers;
    const between = s.slice(first.index! + first[0].length, second.index!);
    if (/^\s*(?:~|–|—|-|to)\s*\+?\s*$/.test(between)) {
      const lower = Number(first[0]);
      const upper = Number(second[0]);
      const label = s.slice(0, first.index!).trim().replace(/[+]$/, '').trim() || null;
      const unit = s.slice(second.index! + second[0].length).trim() || null;
      if (lower > upper) {
        // INV-04 territory (defect B-04's class): never load an inverted
        // range, never silently swap it.
        return text(
          `printed range is high-to-low (${first[0]} > ${second[0]}) — inverted per INV-04; client decision required`,
        );
      }
      return {
        specType: 'RANGE',
        lowerLimit: lower,
        upperLimit: upper,
        nominal: null,
        tolerance: null,
        unit,
        label,
      };
    }
  }

  return text(
    numbers.length === 0
      ? 'qualitative specification with no numeric content'
      : 'specification does not match any TLP §4.2 printed form',
  );
}
