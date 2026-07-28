import { describe, expect, it } from 'vitest';
import { approvalStepCaption, currentVerificationStage } from './RecordReview';
import type { components } from '../api/generated/openapi-types';

type ApprovalStep = components['schemas']['ApprovalStep'];

const step = (action: ApprovalStep['action'], stageOrdinal: number): ApprovalStep => ({
  id: `${action}-${stageOrdinal}-${Math.random()}`,
  stageOrdinal,
  action,
  actedAt: '2026-07-28T00:00:00.000Z',
});

/**
 * Slice 18-WORKFLOW §1. The "Stage N of 2 — needs X" banner is what tells a
 * verifier whose signature is expected; getting it wrong tells the wrong
 * person to sign. The stage-0 performer step this slice adds must not move
 * it, and the pre-existing return bug must not survive.
 */
describe('currentVerificationStage', () => {
  it('a freshly submitted record awaits stage 1', () => {
    expect(currentVerificationStage([])).toBe(1);
    expect(currentVerificationStage(undefined)).toBe(1);
  });

  it("the PERFORMER's stage-0 signature is not a verification stage", () => {
    expect(currentVerificationStage([step('SUBMITTED', 0)])).toBe(1);
  });

  it('one completed verification advances to stage 2', () => {
    expect(currentVerificationStage([step('SUBMITTED', 0), step('VERIFIED', 1)])).toBe(2);
  });

  it('a RETURN supersedes the earlier verification — the reworked record needs stage 1 again', () => {
    expect(
      currentVerificationStage([
        step('SUBMITTED', 0),
        step('VERIFIED', 1),
        step('RETURNED', 1),
        step('SUBMITTED', 0),
      ]),
    ).toBe(1);
  });

  it('a RECALL does the same', () => {
    expect(
      currentVerificationStage([step('VERIFIED', 1), step('RECALLED', 1), step('SUBMITTED', 0)]),
    ).toBe(1);
  });

  it('verifications after the cycle break count again', () => {
    expect(
      currentVerificationStage([
        step('VERIFIED', 1),
        step('RETURNED', 1),
        step('SUBMITTED', 0),
        step('VERIFIED', 1),
      ]),
    ).toBe(2);
  });
});

/**
 * Slice 26-TWOSTAGE review fix M1. Three copies of the stage caption had
 * drifted: the configured `approval_stage.label` (live: "Verified By
 * (Supervisor / Engineer)", faithful to the paper form's "Verified By:
 * (Workshop Supervisor/Engr)"), this screen's STAGE_LABELS map, and the PDF
 * template's — the last two both reading "Verified By (Engineer)". Since the
 * verifier queue now renders the DB label, a verifier would read one caption
 * on the queue card and a different one on the record it opens, with a third
 * on the archived PDF. The step now carries the label snapshotted when it was
 * signed, and that snapshot is what every renderer shows.
 */
describe('approvalStepCaption (M1)', () => {
  it('prefers the label snapshotted on the step over the hard-coded map', () => {
    expect(
      approvalStepCaption({
        ...step('VERIFIED', 2),
        stageLabel: 'Verified By (Supervisor / Engineer)',
      }),
    ).toBe('Verified By (Supervisor / Engineer)');
  });

  it('falls back to the map when no label was snapshotted — historical rows still read correctly', () => {
    expect(approvalStepCaption(step('VERIFIED', 1))).toBe('Verified By (Workshop Team Leader)');
    expect(approvalStepCaption(step('SUBMITTED', 0))).toBe('Maintenance Performed By');
  });

  it('falls back to a bare stage when neither is available, rather than rendering nothing', () => {
    expect(approvalStepCaption(step('VERIFIED', 7))).toBe('Stage 7');
  });
});
