import type { Judgement, SpecType } from '@bamform/shared';

/**
 * PR-032/DBD §6.17 — `measurement_result.judgement` is computed server-side
 * from the frozen `template_measurement`'s specification, never supplied by
 * the client (`MeasurementResultInput` has no `judgement` field — only a
 * reading). Defaults to `NOT_EVALUATED` under AS-02 whenever the spec or the
 * reading doesn't give this function a basis for a verdict.
 */
export interface JudgementSpec {
  specType: SpecType;
  lowerLimit?: number | null;
  upperLimit?: number | null;
  nominal?: number | null;
  tolerance?: number | null;
}

export interface JudgementReading {
  readingNumeric?: number | null;
  readingText?: string | null;
}

export function computeJudgement(spec: JudgementSpec, reading: JudgementReading): Judgement {
  switch (spec.specType) {
    case 'RANGE':
      return judgeRange(spec, reading.readingNumeric);
    case 'TOLERANCE':
      return judgeTolerance(spec, reading.readingNumeric);
    case 'PASS_FAIL':
      return judgePassFail(reading.readingText);
    case 'TEXT':
      // Free text has no comparison basis (spec_display is the record, not a
      // machine-checkable limit) — always NOT_EVALUATED by design.
      return 'NOT_EVALUATED';
  }
}

function judgeRange(spec: JudgementSpec, reading: number | null | undefined): Judgement {
  if (reading == null) return 'NOT_EVALUATED';
  if (spec.lowerLimit != null && reading < spec.lowerLimit) return 'FAIL';
  if (spec.upperLimit != null && reading > spec.upperLimit) return 'FAIL';
  return 'PASS';
}

function judgeTolerance(spec: JudgementSpec, reading: number | null | undefined): Judgement {
  if (reading == null || spec.nominal == null || spec.tolerance == null) {
    return 'NOT_EVALUATED';
  }
  return Math.abs(reading - spec.nominal) <= spec.tolerance ? 'PASS' : 'FAIL';
}

function judgePassFail(readingText: string | null | undefined): Judgement {
  const normalised = readingText?.trim().toUpperCase();
  if (normalised === 'PASS') return 'PASS';
  if (normalised === 'FAIL') return 'FAIL';
  return 'NOT_EVALUATED';
}
