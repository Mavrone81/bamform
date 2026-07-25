import { computeJudgement } from './judgement';

/**
 * PR-032/DBD §6.17 — `measurement_result.judgement` is SERVER-computed, not
 * client-supplied: `MeasurementResultInput` (openapi.yaml) has no `judgement`
 * field, only `readingNumeric`/`readingText`. This is the pure comparison
 * function `ResultsService` calls against the frozen `template_measurement`'s
 * specification.
 */
describe('computeJudgement (PR-032, AS-02 default not_evaluated)', () => {
  describe('spec_type = RANGE', () => {
    it('PASS when the reading is within [lowerLimit, upperLimit]', () => {
      expect(
        computeJudgement(
          { specType: 'RANGE', lowerLimit: 5, upperLimit: 24 },
          { readingNumeric: 10 },
        ),
      ).toBe('PASS');
    });

    it('FAIL when the reading is below lowerLimit', () => {
      expect(
        computeJudgement(
          { specType: 'RANGE', lowerLimit: 5, upperLimit: 24 },
          { readingNumeric: 4.9 },
        ),
      ).toBe('FAIL');
    });

    it('FAIL when the reading is above upperLimit', () => {
      expect(
        computeJudgement(
          { specType: 'RANGE', lowerLimit: 5, upperLimit: 24 },
          { readingNumeric: 24.1 },
        ),
      ).toBe('FAIL');
    });

    it('boundary values are PASS (inclusive)', () => {
      expect(
        computeJudgement(
          { specType: 'RANGE', lowerLimit: 5, upperLimit: 24 },
          { readingNumeric: 5 },
        ),
      ).toBe('PASS');
      expect(
        computeJudgement(
          { specType: 'RANGE', lowerLimit: 5, upperLimit: 24 },
          { readingNumeric: 24 },
        ),
      ).toBe('PASS');
    });

    it('NOT_EVALUATED when no numeric reading was recorded', () => {
      expect(
        computeJudgement(
          { specType: 'RANGE', lowerLimit: 5, upperLimit: 24 },
          { readingNumeric: null },
        ),
      ).toBe('NOT_EVALUATED');
    });

    it('an unbounded lower or upper limit is treated as no constraint on that side', () => {
      expect(
        computeJudgement(
          { specType: 'RANGE', lowerLimit: null, upperLimit: 24 },
          { readingNumeric: -100 },
        ),
      ).toBe('PASS');
      expect(
        computeJudgement(
          { specType: 'RANGE', lowerLimit: 5, upperLimit: null },
          { readingNumeric: 1000 },
        ),
      ).toBe('PASS');
    });
  });

  describe('spec_type = TOLERANCE', () => {
    it('PASS when |reading - nominal| <= tolerance', () => {
      expect(
        computeJudgement(
          { specType: 'TOLERANCE', nominal: 150, tolerance: 5 },
          { readingNumeric: 154 },
        ),
      ).toBe('PASS');
    });

    it('FAIL when the reading is outside the tolerance band', () => {
      expect(
        computeJudgement(
          { specType: 'TOLERANCE', nominal: 150, tolerance: 5 },
          { readingNumeric: 156 },
        ),
      ).toBe('FAIL');
    });

    it('NOT_EVALUATED when nominal or tolerance is missing from the spec', () => {
      expect(
        computeJudgement(
          { specType: 'TOLERANCE', nominal: null, tolerance: 5 },
          { readingNumeric: 150 },
        ),
      ).toBe('NOT_EVALUATED');
    });
  });

  describe('spec_type = PASS_FAIL', () => {
    it('reads PASS/FAIL from readingText, case-insensitively', () => {
      expect(computeJudgement({ specType: 'PASS_FAIL' }, { readingText: 'pass' })).toBe('PASS');
      expect(computeJudgement({ specType: 'PASS_FAIL' }, { readingText: 'FAIL' })).toBe('FAIL');
    });

    it('NOT_EVALUATED for anything else', () => {
      expect(computeJudgement({ specType: 'PASS_FAIL' }, { readingText: 'maybe' })).toBe(
        'NOT_EVALUATED',
      );
      expect(computeJudgement({ specType: 'PASS_FAIL' }, {})).toBe('NOT_EVALUATED');
    });
  });

  describe('spec_type = TEXT', () => {
    it('is always NOT_EVALUATED — free text has no pass/fail basis', () => {
      expect(computeJudgement({ specType: 'TEXT' }, { readingText: 'anything' })).toBe(
        'NOT_EVALUATED',
      );
    });
  });
});
