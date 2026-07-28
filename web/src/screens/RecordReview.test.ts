import { describe, expect, it } from 'vitest';
import { currentVerificationStage } from './RecordReview';
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
